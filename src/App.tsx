import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight, BookOpen, Check, Ear, Heart, Mail, MessageCircleHeart, Pause, PenLine, Play, RotateCcw, Search, Share2, SkipForward, Users, VolumeX, X,
} from 'lucide-react'
import {
  ENTITY_LABELS, SHOW_XIAOYUZHOU, dayLabel, entityPath, episodeLabel, indexPath, loadAtlas, momentSource, parseRoute, shortTitle, timeLabel,
  topicMoments, type Atlas, type Entity, type EntityKind, type Episode, type Moment, type Topic,
} from './domain'
import { EntityPage } from './EntityPage'
import { EpisodeRail } from './EpisodeRail'
import { Overlay } from './Overlay'
import { ShareDialog } from './ShareDialog'
import { IndexPage } from './IndexPage'
import { LetterDialog } from './LetterDialog'
import { useGiven, type LetterAbout } from './letters'
import { SearchSpace } from './SearchSpace'
import { useAmbient } from './ambient'
import { pageview, track } from './analytics'
import { failBoot } from './boot'
import { SHEET_QUERY, useMediaQuery } from './dialog'
import { StarMap, type GalaxyStar } from './StarMap'
import { segmentsOf, usePlayer, type Cue } from './player'
import { ApplePodcastsIcon, XiaoyuzhouIcon } from './platforms'
import type { ShareSubject } from './shareCard'
import type { Thread, Travel } from './scene/GalaxyScene'

type Panel = 'search' | 'letter' | null
type Partner = { id: string; shared: number }
/** What a thread stands for: one episode, and where in it each of the two sub-topics comes up. */
type ThreadInfo = { id: string; from: string; to: string; episodeId: string; fromMoment: string | null; toMoment: string | null }

function readUrl() {
  const params = new URLSearchParams(window.location.search)
  return { topic: params.get('topic') ?? '', star: params.get('star') ?? '', moment: params.get('moment') ?? '', episode: params.get('episode') ?? '' }
}

const episodePath = (id: string) => `/?${new URLSearchParams({ episode: id })}`

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function byRecency(episodes: Map<string, Episode>) {
  return (a: Moment, b: Moment) => {
    const left = episodes.get(a.episodeId)!
    const right = episodes.get(b.episodeId)!
    return right.publishedAt.localeCompare(left.publishedAt) || a.startSec - b.startSec
  }
}

/**
 * Sub-topic stars are concepts with a parent topic. Each star keeps its three strongest partners
 * (sub-topics the same episodes mention, preferring ones in other nebulae), and every episode they
 * share becomes its own thread, so a line is always one specific episode.
 */
function buildGalaxy(atlas: Atlas | null) {
  const concepts = (atlas?.entities ?? []).filter(item => item.kind === 'concept' && item.topic)
  const order = new Map((atlas?.episodes ?? []).map((episode, index) => [episode.id, index]))
  const episodesOf = new Map(concepts.map(item => [item.id, new Set(item.mentions.map(point => point.episodeId))]))
  const byId = new Map(concepts.map(item => [item.id, item]))
  const partners = new Map<string, Partner[]>(concepts.map(item => [item.id, []]))
  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const b = episodesOf.get(concepts[j].id)!
      const shared = [...episodesOf.get(concepts[i].id)!].filter(id => b.has(id)).length
      if (!shared) continue
      partners.get(concepts[i].id)!.push({ id: concepts[j].id, shared })
      partners.get(concepts[j].id)!.push({ id: concepts[i].id, shared })
    }
  }
  for (const [id, list] of partners) {
    const home = byId.get(id)!.topic
    list.sort((x, y) => y.shared - x.shared || Number(byId.get(y.id)!.topic !== home) - Number(byId.get(x.id)!.topic !== home))
  }
  // A star's size follows how connected it is: how many other sub-topics share episodes with it.
  const most = Math.max(1, ...[...partners.values()].map(list => list.length))
  const stars: GalaxyStar[] = concepts.map(item => ({
    id: item.id, name: item.name, nebula: item.topic!, weight: Math.log2(1 + partners.get(item.id)!.length) / Math.log2(1 + most),
  }))
  const pairs = new Set<string>()
  for (const [id, list] of partners) for (const partner of list.slice(0, 3)) pairs.add([id, partner.id].sort().join('|'))
  const threads: Thread[] = []
  const info = new Map<string, ThreadInfo>()
  for (const pair of pairs) {
    const [from, to] = pair.split('|')
    const a = byId.get(from)!
    const b = byId.get(to)!
    const sharedEpisodes = [...episodesOf.get(from)!].filter(id => episodesOf.get(to)!.has(id))
      .sort((x, y) => (order.get(y) ?? 0) - (order.get(x) ?? 0)).slice(0, 3)
    sharedEpisodes.forEach((episodeId, index) => {
      const id = `${pair}|${episodeId}`
      threads.push({ id, from, to, bend: index === 0 ? 0.4 : (index % 2 ? -1 : 1) * (0.8 + index * 0.4), primary: index === 0 })
      info.set(id, {
        id, from, to, episodeId,
        fromMoment: a.mentions.find(point => point.episodeId === episodeId && point.momentId)?.momentId ?? null,
        toMoment: b.mentions.find(point => point.episodeId === episodeId && point.momentId)?.momentId ?? null,
      })
    })
  }
  // Each episode's sub-topics in the order it comes to them (the title's first), and a path through them that
  // shows while that episode is highlighted: the episode drawn as its own constellation.
  const firstAt = new Map<string, Map<string, number>>()
  for (const item of concepts) {
    for (const point of item.mentions) {
      const seen = firstAt.get(point.episodeId) ?? new Map<string, number>()
      seen.set(item.id, Math.min(seen.get(item.id) ?? Infinity, point.startSec ?? -1))
      firstAt.set(point.episodeId, seen)
    }
  }
  const episodeStars = new Map<string, string[]>()
  for (const [episodeId, seen] of firstAt) {
    const path = [...seen].sort((a, b) => a[1] - b[1]).map(([id]) => id)
    episodeStars.set(episodeId, path)
    path.slice(1).forEach((to, index) => {
      const from = path[index]
      const id = `path|${episodeId}|${index}`
      threads.push({ id, from, to, bend: index % 2 ? -0.5 : 0.5, primary: false, episode: episodeId })
      info.set(id, {
        id, from, to, episodeId,
        fromMoment: byId.get(from)!.mentions.find(point => point.episodeId === episodeId && point.momentId)?.momentId ?? null,
        toMoment: byId.get(to)!.mentions.find(point => point.episodeId === episodeId && point.momentId)?.momentId ?? null,
      })
    })
  }
  return { stars, threads, info, partners, episodeStars }
}

export function App() {
  const [atlas, setAtlas] = useState<Atlas | null>(null)
  const [failure, setFailure] = useState('')
  const [travel, setTravel] = useState<Travel>(() => ({ seq: 0, nebula: readUrl().topic || null, star: readUrl().star || null }))
  const [viewNebula, setViewNebula] = useState<string | null>(null)
  const [starId, setStarId] = useState(() => readUrl().star)
  const [threadId, setThreadId] = useState('')
  const [shared, setShared] = useState<{ subject: ShareSubject; path: string } | null>(null)
  const [momentId, setMomentId] = useState(() => readUrl().moment)
  // The episode whose card is open, and the one under the pointer on the rail; either lights its sub-topics.
  const [episodeId, setEpisodeId] = useState(() => readUrl().episode)
  const [previewEpisode, setPreviewEpisode] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [letter, setLetter] = useState<{ from: string; about: LetterAbout | null }>({ from: 'corner', about: null })
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname))
  const reducedMotion = useReducedMotion()
  const segments = useMemo(() => segmentsOf(atlas?.moments ?? []), [atlas])
  const player = usePlayer(segments.next)
  // Site music sits low under an episode, and goes silent under episodes with their own music bed.
  const music = useAmbient(player.playing ? (player.cue?.episode.musicBed ? 'mute' : 'low') : 'none')

  // Overlay pages record in history.state how many pages deep they are, and whether the chain began at a
  // deep link (`base`: no map underneath). ✕ then returns to the map in one step, whatever the depth.
  type Entry = { depth?: number; base?: boolean } | null
  const entry = () => window.history.state as Entry
  const depth = () => entry()?.depth ?? 0
  const closing = useRef(false)

  useEffect(() => {
    if (parseRoute(window.location.pathname) && !depth()) window.history.replaceState({ depth: 1, base: true }, '', window.location.href)
    const onPop = () => {
      if (closing.current && entry()?.base) {
        closing.current = false
        window.history.replaceState({ depth: 0 }, '', '/')
      }
      const nextRoute = parseRoute(window.location.pathname)
      setRoute(nextRoute)
      if (!nextRoute) setEpisodeId(readUrl().episode)
      setPanel(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback((path: string) => {
    const next = parseRoute(new URL(path, window.location.origin).pathname)
    window.history.pushState(next ? { depth: depth() + 1, base: Boolean(entry()?.base) } : { depth: 0 }, '', path)
    setRoute(next)
  }, [])

  const closeOverlay = useCallback(() => {
    const steps = depth()
    if (entry()?.base) {
      if (steps > 1) {
        // Walk back to the deep-linked first page, then swap it for the map.
        closing.current = true
        window.history.go(-(steps - 1))
        return
      }
    } else if (steps > 0) {
      window.history.go(-steps)
      return
    }
    window.history.replaceState({ depth: 0 }, '', '/')
    setRoute(null)
  }, [])

  const overlayBack = useCallback(() => {
    const state = window.history.state as { depth?: number; base?: boolean } | null
    if ((state?.depth ?? 0) > 1) window.history.back()
    else closeOverlay()
  }, [closeOverlay])

  useEffect(() => {
    const controller = new AbortController()
    loadAtlas(controller.signal).then(setAtlas).catch(error => {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : '星图暂时打不开'
      setFailure(message)
      failBoot(message)
    })
    return () => controller.abort()
  }, [])

  const episodes = useMemo(() => new Map((atlas?.episodes ?? []).map(episode => [episode.id, episode])), [atlas])
  const moments = useMemo(() => new Map((atlas?.moments ?? []).map(moment => [moment.id, moment])), [atlas])
  const entities = useMemo(() => new Map((atlas?.entities ?? []).map(item => [item.id, item])), [atlas])
  const topics = atlas?.topics ?? []
  const galaxy = useMemo(() => buildGalaxy(atlas), [atlas])
  const closeShare = useCallback(() => setShared(null), [])
  const closePanel = useCallback(() => setPanel(null), [])
  // Newest first, so the latest episode sits at the top of the rail.
  const timeline = useMemo(() => [...(atlas?.episodes ?? [])].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)), [atlas])
  const highlight = previewEpisode || episodeId
  const litEpisode = useMemo(
    () => (highlight ? { id: highlight, stars: new Set(galaxy.episodeStars.get(highlight) ?? []) } : null), [highlight, galaxy],
  )

  // Drop deep-link values that no longer exist once the data arrives.
  useEffect(() => {
    if (!atlas) return
    if (starId && !entities.get(starId)?.topic) setStarId('')
    if (momentId && !moments.get(momentId)) setMomentId('')
    if (episodeId && !episodes.has(episodeId)) setEpisodeId('')
    // Only runs when the atlas loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas])

  // The address follows where the person is in the sky, so any view can be shared.
  useEffect(() => {
    if (route) return
    const params = new URLSearchParams()
    if (viewNebula) params.set('topic', viewNebula)
    if (starId) params.set('star', starId)
    if (momentId) params.set('moment', momentId)
    if (episodeId) params.set('episode', episodeId)
    // Campaign tags on the link someone arrived by stay, so statistics can credit where the visit came from.
    for (const [key, value] of new URLSearchParams(window.location.search)) if (key.startsWith('utm_')) params.set(key, value)
    window.history.replaceState(null, '', params.size ? `/?${params}` : '/')
  }, [viewNebula, starId, momentId, route, episodeId])

  // Statistics (README · 统计): one page view per page (the map, or an entity or index page over it), and what is
  // opened on the map, including from a shared link.
  const page = route ? ('id' in route ? `${route.kind}/${route.id}` : route.index) : ''
  useEffect(() => { pageview() }, [page])
  useEffect(() => {
    const episode = episodes.get(episodeId)
    if (episode) track('episode_opened', { episode: episodeLabel(episode), title: shortTitle(episode) })
  }, [episodeId, episodes])
  useEffect(() => {
    const star = entities.get(starId)
    if (star) track('star_opened', { star: star.name, topic: topics.find(item => item.id === star.topic)?.title })
  }, [starId, entities, topics])
  useEffect(() => {
    const moment = moments.get(momentId)
    const episode = moment && episodes.get(moment.episodeId)
    if (moment && episode) track('moment_opened', { moment: moment.title, episode: episodeLabel(episode) })
  }, [momentId, moments, episodes])
  useEffect(() => {
    if (shared) track('share_opened', { kind: shared.subject.kind, path: shared.path })
  }, [shared])

  const fly = useCallback((trip: Omit<Travel, 'seq'>) => setTravel(previous => ({ seq: previous.seq + 1, ...trip })), [])

  // On an upright phone an episode's card opens as a short sheet and the map fits the episode's sub-topics into the
  // sky above it; closing the card goes back to the whole sky.
  const sheet = useMediaQuery(SHEET_QUERY)
  const episodeCard = !!episodeId && !starId && !momentId && !threadId
  const framed = useRef(false)
  useEffect(() => {
    if (!sheet) return
    const lit = episodeCard ? galaxy.episodeStars.get(episodeId) ?? [] : []
    if (lit.length) {
      framed.current = true
      fly({ stars: lit })
    } else if (framed.current) {
      framed.current = false
      if (!episodeId && !starId && !momentId && !threadId) fly({})
    }
  }, [sheet, episodeCard, episodeId, starId, momentId, threadId, galaxy, fly])

  const leavePage = useCallback(() => { if (parseRoute(window.location.pathname)) closeOverlay() }, [closeOverlay])

  const focusNebula = useCallback((id: string) => {
    track('topic_opened', { topic: topics.find(item => item.id === id)?.title ?? id })
    setStarId('')
    setThreadId('')
    setMomentId('')
    setEpisodeId('')
    setPanel(null)
    fly({ nebula: id })
    leavePage()
  }, [fly, leavePage, topics])

  const selectStar = useCallback((id: string) => {
    if (!entities.get(id)?.topic) return
    setStarId(id)
    setThreadId('')
    setMomentId('')
    setEpisodeId('')
    setPanel(null)
    fly({ star: id })
    leavePage()
  }, [entities, fly, leavePage])

  const selectThread = useCallback((id: string) => {
    setThreadId(id)
    setStarId('')
    setMomentId('')
    setEpisodeId('')
  }, [])

  const overview = useCallback(() => {
    setStarId('')
    setThreadId('')
    setMomentId('')
    setEpisodeId('')
    fly({})
  }, [fly])

  // Clicking empty sky steps back one level: card → nebula → whole sky.
  const stepBack = useCallback(() => {
    if (momentId || threadId || starId || episodeId) {
      setMomentId('')
      setThreadId('')
      setStarId('')
      setEpisodeId('')
    } else if (viewNebula) overview()
  }, [momentId, threadId, starId, episodeId, viewNebula, overview])

  /** Open an episode from the rail: its card, and its sub-topics lit across the whole sky. */
  const selectEpisode = useCallback((id: string) => {
    setEpisodeId(id)
    setStarId('')
    setThreadId('')
    setMomentId('')
    setPanel(null)
    if (viewNebula) fly({})
    leavePage()
  }, [viewNebula, fly, leavePage])

  const selectMoment = useCallback((moment: Moment) => {
    setMomentId(moment.id)
    setStarId('')
    setThreadId('')
    setEpisodeId('')
    setPanel(null)
    leavePage()
  }, [leavePage])

  const openEntity = useCallback((entity: Entity) => {
    setPanel(null)
    go(entityPath(entity))
  }, [go])

  const openIndex = useCallback((kind: EntityKind) => {
    setPanel(null)
    go(indexPath(kind))
  }, [go])

  const cueFor = segments.cue
  const writeLetter = (from: string, about: LetterAbout | null = null) => {
    track('letter_opened', { from })
    setLetter({ from, about })
    setPanel('letter')
  }
  const writeAbout = (cue: Cue) => writeLetter('player', {
    label: `${episodeLabel(cue.episode)} · ${cue.title}`,
    page: `/?${new URLSearchParams(cue.momentId ? { moment: cue.momentId } : { episode: cue.episode.id })}`,
  })
  const listen = (cue: Cue) => {
    track('episode_played', {
      episode: episodeLabel(cue.episode), title: shortTitle(cue.episode), from: cue.title, start_sec: Math.round(cue.startSec),
    })
    player.play(cue)
  }
  const shareEntity = (entity: Entity, trigger: HTMLButtonElement) => {
    trigger.focus({ preventScroll: true })
    const maker = entity.kind === 'concept' ? undefined : entities.get(entity.author ?? entity.people?.[0] ?? '')?.name
    const tint = topics.find(item => item.id === (entity.topic ?? entity.topicIds[0]))?.color ?? '#9fb0ff'
    setShared({ subject: { kind: 'entity', entity, tint, maker }, path: entityPath(entity) })
  }
  const shareSite = (trigger: HTMLButtonElement) => {
    trigger.focus({ preventScroll: true })
    if (!atlas) return
    setShared({
      subject: { kind: 'site', topics, stars: galaxy.stars, threads: galaxy.threads.filter(item => !item.episode), episodeCount: atlas.episodes.length, momentCount: atlas.moments.length },
      path: '/',
    })
  }
  // An episode's card is the map with that episode lit, so it carries the sky and the episode's own path.
  const shareEpisode = (episode: Episode, trigger: HTMLButtonElement) => {
    trigger.focus({ preventScroll: true })
    const lit = galaxy.episodeStars.get(episode.id) ?? []
    const tint = topics.find(item => item.id === entities.get(lit[0] ?? '')?.topic)?.color ?? '#9fb0ff'
    setShared({
      subject: {
        kind: 'episode', episode, tint, topics, stars: galaxy.stars, lit,
        threads: galaxy.threads.filter(item => item.episode === episode.id),
      },
      path: episodePath(episode.id),
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shared || event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPanel('search'); return }
      if (event.key === 'Escape' && !panel && !parseRoute(window.location.pathname)) stepBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, stepBack, shared])

  const related = useMemo(() => {
    if (!starId) return new Set<string>()
    return new Set(galaxy.threads.filter(thread => thread.from === starId || thread.to === starId).map(thread => (thread.from === starId ? thread.to : thread.from)))
  }, [galaxy, starId])

  // The opening screen in index.html (see boot.ts) shows the sky and the progress, and any failure, until the map draws.
  if (!atlas) {
    return (
      <main className="space">
        {failure && !document.getElementById('boot') && <p className="space-status" role="status">{failure}</p>}
        <Brand />
        <MusicPlayer music={music} />
      </main>
    )
  }

  const focusedTopic = topics.find(item => item.id === viewNebula) ?? null
  const thread = threadId ? galaxy.info.get(threadId) : undefined
  const threadLabel = (id: string) => {
    const item = galaxy.info.get(id)
    const episode = item && episodes.get(item.episodeId)
    if (!item || !episode) return ''
    const moment = moments.get(item.fromMoment ?? item.toMoment ?? '')
    return `${episodeLabel(episode)} · ${moment ? moment.title : shortTitle(episode)}`
  }
  const moment = momentId ? moments.get(momentId) : undefined
  const star = starId ? entities.get(starId) : undefined
  const entity = route && 'id' in route ? atlas.entities?.find(item => item.kind === route.kind && item.id === route.id) : undefined
  const index = route && 'index' in route ? route.index : null
  const playing = player.cue?.momentId ? moments.get(player.cue.momentId) : undefined
  const playerBar = player.cue && <PlayerBar player={player} onOpen={playing && (() => selectMoment(playing))} onWrite={writeAbout} />

  let card: ReactNode = null
  if (moment) {
    card = <MomentCard moment={moment} episode={episodes.get(moment.episodeId)!} onClose={() => setMomentId('')} onShare={shareEpisode}
      onPlay={() => listen(cueFor(episodes.get(moment.episodeId)!, moment.startSec, moment.title))} />
  } else if (thread) {
    card = <ThreadCard thread={thread} topics={topics} entities={entities} episodes={episodes} moments={moments}
      onStar={selectStar} onClose={() => setThreadId('')} onShare={shareEpisode} onPlay={(episode, startSec, title) => listen(cueFor(episode, startSec, title))} />
  } else if (star) {
    card = <StarCard star={star} topics={topics} entities={entities} episodes={episodes} moments={moments}
      partners={galaxy.partners.get(star.id) ?? []} onStar={selectStar} onOpen={() => openEntity(star)} onClose={() => setStarId('')}
      onShare={trigger => shareEntity(star, trigger)}
      onPlay={(episode, startSec, title) => listen(cueFor(episode, startSec, title))} />
  } else if (episodeId && episodes.has(episodeId)) {
    const episode = episodes.get(episodeId)!
    card = <EpisodeCard episode={episode} stars={galaxy.episodeStars.get(episodeId) ?? []} topics={topics} entities={entities}
      chapters={atlas.moments.filter(item => item.episodeId === episodeId).sort((a, b) => a.startSec - b.startSec)}
      onStar={selectStar} onEntity={openEntity} onClose={() => setEpisodeId('')} onShare={shareEpisode}
      onPlay={(startSec, title) => listen(cueFor(episode, startSec, title))}
      onPlayAll={() => listen(cueFor(episode, 0, shortTitle(episode), true))} />
  }

  // The rail marks the episodes behind whatever is open: every episode that mentions the chosen star, in its
  // nebula's colour; the open episode, moment or thread is the active tick.
  const marks = new Map<string, string>()
  if (star) {
    const color = topics.find(item => item.id === star.topic)?.color ?? '#9fb0ff'
    for (const point of star.mentions) marks.set(point.episodeId, color)
  }
  const railActive = episodeId || (moment?.episodeId ?? thread?.episodeId ?? '')

  return (
    <main className={`space${entity || index ? ' space--page' : ''}`}>
      <StarMap
        topics={topics}
        stars={galaxy.stars}
        threads={galaxy.threads}
        selected={star?.id ?? null}
        related={related}
        episode={litEpisode}
        current={viewNebula}
        travel={travel}
        reducedMotion={reducedMotion}
        threadLabel={threadLabel}
        onView={setViewNebula}
        onNebula={focusNebula}
        onStar={selectStar}
        onThread={selectThread}
        onBack={stepBack}
        onOverview={overview}
        card={card}
        cardKey={momentId || threadId || starId || episodeId}
        peek={sheet && episodeCard}
      />
      <EpisodeRail episodes={timeline} active={railActive} marks={marks} playing={player.cue?.episode.id ?? ''}
        starCount={id => galaxy.episodeStars.get(id)?.length ?? 0} onPreview={setPreviewEpisode} onSelect={selectEpisode} />
      {(entity || index) && (
        <Overlay
          label={entity ? `${ENTITY_LABELS[entity.kind]} · ${entity.name}` : ENTITY_LABELS[index!]}
          page={entity ? `${entity.kind}/${entity.id}` : `index/${index}`}
          canBack={depth() > 1}
          onBack={overlayBack}
          onClose={closeOverlay}
          footer={playerBar}
        >
          {entity
            ? <EntityPage atlas={atlas} entity={entity} episodes={episodes} onEntity={openEntity} onTopic={focusNebula} onMoment={selectMoment}
                onPlay={(episode, startSec, title) => listen(cueFor(episode, startSec, title))} onShare={trigger => shareEntity(entity, trigger)} />
            : <IndexPage atlas={atlas} kind={index!} onEntity={openEntity} />}
        </Overlay>
      )}
      <nav className="corner-library" aria-label="索引">
        <button type="button" className={index === 'person' ? 'is-active' : ''} onClick={event => {
          event.currentTarget.focus({ preventScroll: true })
          openIndex('person')
        }} aria-label="人物" title="人物">
          <Users size={18} strokeWidth={1.5} aria-hidden="true" /> <span>人物</span>
        </button>
        <button type="button" className={index === 'book' ? 'is-active' : ''} onClick={event => {
          event.currentTarget.focus({ preventScroll: true })
          openIndex('book')
        }} aria-label="书" title="书">
          <BookOpen size={18} strokeWidth={1.5} aria-hidden="true" /> <span>书</span>
        </button>
      </nav>
      <nav className="corner-actions" aria-label="工具">
        <button type="button" onClick={event => {
          event.currentTarget.focus({ preventScroll: true })
          setPanel('search')
        }} aria-expanded={panel === 'search'}>
          <Search size={18} strokeWidth={1.5} aria-hidden="true" /> 搜索
        </button>
        <button type="button" onClick={event => {
          event.currentTarget.focus({ preventScroll: true })
          writeLetter('corner')
        }} aria-haspopup="dialog" aria-expanded={panel === 'letter'} aria-label="给贝儿留言" title="给贝儿留言">
          <Mail size={18} strokeWidth={1.5} aria-hidden="true" /> 留言
        </button>
        <button className="corner-share" type="button" onClick={event => shareSite(event.currentTarget)} aria-haspopup="dialog"
          aria-label="分享整张星图" title="分享整张星图">
          <Share2 size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </nav>
      {panel === 'search' && (
        <SearchSpace atlas={atlas} episodes={episodes} onTopic={focusNebula} onStar={selectStar} onEntity={openEntity} onIndex={openIndex}
          onMoment={selectMoment} onEpisode={selectEpisode} onClose={closePanel} />
      )}
      {panel === 'letter' && (
        <LetterDialog {...letter} xiaoyuzhouUrl={atlas.show?.xiaoyuzhouUrl ?? SHOW_XIAOYUZHOU} appleUrl={atlas.show?.appleUrl} onClose={closePanel} />
      )}
      {shared && <ShareDialog {...shared} episodes={episodes} moments={moments} onClose={closeShare} />}
      <Brand />
      <MusicPlayer music={music} />
      {!entity && !index && playerBar}
    </main>
  )
}

/** Bottom-right music switch; the credit shows while a recorded track plays. */
function MusicPlayer({ music }: { music: ReturnType<typeof useAmbient> }) {
  return (
    <div className={`music-switch${music.playing ? ' is-on' : ''}`}>
      {music.credit && music.enabled && <span className="music-credit">音乐 · {music.credit}</span>}
      <button type="button" onClick={() => { track('music_toggled', { on: !music.enabled }); music.toggle() }} aria-pressed={music.enabled} aria-label={music.enabled ? '关闭背景音乐' : '打开背景音乐'} title={music.enabled ? '关闭背景音乐' : '打开背景音乐'}>
        {music.enabled
          ? <span className="music-bars" aria-hidden="true"><i /><i /><i /></span>
          : <VolumeX size={16} strokeWidth={1.6} aria-hidden="true" />}
      </button>
    </div>
  )
}

function Brand() {
  return (
    <div className="brand">
      <a className="brand-name" href="/" aria-label="贝儿说 · 回到星图">贝儿说</a>
      <span className="brand-rule" aria-hidden="true" />
      <a className="brand-show" href={SHOW_XIAOYUZHOU} target="_blank" rel="noreferrer" aria-label="在小宇宙收听《次要人生》">
        <img src="/brand/show-cover.png" alt="" width="30" height="30" />
        <span>次要人生</span>
      </a>
    </div>
  )
}

function SourceLinks({ episode }: { episode: Episode }) {
  return (
    <div className="card-links">
      <a href={episode.xiaoyuzhouUrl} target="_blank" rel="noreferrer"><XiaoyuzhouIcon />小宇宙 <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" /></a>
      <a href={episode.appleUrl} target="_blank" rel="noreferrer"><ApplePodcastsIcon />Apple Podcasts <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" /></a>
    </div>
  )
}

function MomentCard({ moment, episode, onPlay, onClose, onShare }: {
  moment: Moment; episode: Episode; onPlay: () => void; onClose: () => void; onShare: (episode: Episode, trigger: HTMLButtonElement) => void
}) {
  return (
    <article className="card">
      <button className="icon-button card-close" type="button" aria-label="关闭" onClick={onClose}><X size={15} aria-hidden="true" /></button>
      <div className="card-body">
        <p className="card-meta">{episodeLabel(episode)} · {timeLabel(moment.startSec)}</p>
        <h2 className="card-title">{moment.title}</h2>
        {moment.summary && <p className="card-summary">{moment.summary}</p>}
      </div>
      <div className="card-foot">
        <button className="card-play" type="button" onClick={onPlay}><Play size={13} aria-hidden="true" /> 听这一段</button>
        <button className="star-card-share" type="button" onClick={event => onShare(episode, event.currentTarget)}><Share2 size={13} aria-hidden="true" /> 分享单集</button>
        <SourceLinks episode={episode} />
      </div>
      <p className="card-source">{momentSource(moment)} · {episode.title}</p>
    </article>
  )
}

/**
 * One episode, opened from the rail: the sub-topics it lights on the map (in the order it comes to them), the people
 * and books it mentions, and its chapters, each ready to play.
 */
function EpisodeCard({ episode, stars, chapters, topics, entities, onStar, onEntity, onPlay, onPlayAll, onClose, onShare }: {
  episode: Episode; stars: string[]; chapters: Moment[]; topics: Topic[]; entities: Map<string, Entity>
  onStar: (id: string) => void; onEntity: (entity: Entity) => void; onPlay: (startSec: number, title: string) => void
  onPlayAll: () => void; onClose: () => void; onShare: (episode: Episode, trigger: HTMLButtonElement) => void
}) {
  const colorOf = (id: string | undefined) => topics.find(item => item.id === id)?.color
  const tint = colorOf(entities.get(stars[0])?.topic) ?? '#9fb0ff'
  const order: Record<string, number> = { person: 0, book: 1, film: 2 }
  const named = [...entities.values()]
    .filter(item => item.kind !== 'concept' && item.mentions.some(point => point.episodeId === episode.id))
    .sort((a, b) => order[a.kind] - order[b.kind])
  return (
    <article className="card card--star card--episode">
      <button className="icon-button card-close" type="button" aria-label="关闭" onClick={onClose}><X size={15} aria-hidden="true" /></button>
      <p className="star-card-topic">
        <span style={{ background: tint, color: tint }} aria-hidden="true" />
        {episodeLabel(episode)} · {dayLabel(episode.publishedAt)} · {Math.round(episode.durationSec / 60)} 分钟
      </p>
      <h2 className="star-card-name">{shortTitle(episode)}</h2>
      <div className="episode-card-actions">
        <button className="card-play" type="button" onClick={onPlayAll}><Play size={13} aria-hidden="true" /> 从头听</button>
        <button className="star-card-share" type="button" onClick={event => onShare(episode, event.currentTarget)}>
          <Share2 size={13} aria-hidden="true" /> 分享单集
        </button>
      </div>
      {stars.length > 0 && (
        <>
          <p className="star-card-section">谈到 {stars.length} 个小主题</p>
          <div className="star-card-partners">
            {stars.map(id => {
              const concept = entities.get(id)
              return concept && (
                <button key={id} type="button" onClick={() => onStar(id)} style={{ '--tint': colorOf(concept.topic) } as React.CSSProperties}>
                  <span aria-hidden="true" />{concept.name}
                </button>
              )
            })}
          </div>
        </>
      )}
      {named.length > 0 && (
        <>
          <p className="star-card-section">提到的人和书</p>
          <div className="star-card-partners episode-card-names">
            {named.map(item => (
              <button key={item.id} type="button" onClick={() => onEntity(item)}>
                {item.kind === 'person' ? <Users size={12} aria-hidden="true" /> : <BookOpen size={12} aria-hidden="true" />}
                {item.name}
              </button>
            ))}
          </div>
        </>
      )}
      {chapters.length > 0 && (
        <>
          <p className="star-card-section">{chapters.length} 个章节</p>
          <div className="star-card-rows">
            {chapters.map(item => (
              <button className="star-card-row" type="button" key={item.id} onClick={() => onPlay(item.startSec, item.title)}>
                <Play size={11} aria-hidden="true" />
                <span className="star-card-when">{timeLabel(item.startSec)}</span>
                <span className="star-card-title">{item.title}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="star-card-foot"><SourceLinks episode={episode} /></div>
    </article>
  )
}

/** A thread: the one episode that connects two sub-topics, with each side's moment ready to play. */
function ThreadCard({ thread, topics, entities, episodes, moments, onStar, onClose, onPlay, onShare }: {
  thread: ThreadInfo; topics: Topic[]; entities: Map<string, Entity>; episodes: Map<string, Episode>; moments: Map<string, Moment>
  onStar: (id: string) => void; onClose: () => void; onPlay: (episode: Episode, startSec: number, title: string) => void
  onShare: (episode: Episode, trigger: HTMLButtonElement) => void
}) {
  const episode = episodes.get(thread.episodeId)!
  const sides = [[thread.from, thread.fromMoment], [thread.to, thread.toMoment]] as const
  const sameMoment = thread.fromMoment && thread.fromMoment === thread.toMoment
  return (
    <article className="card card--star">
      <button className="icon-button card-close" type="button" aria-label="关闭" onClick={onClose}><X size={15} aria-hidden="true" /></button>
      <p className="star-card-topic">连接两颗星的一期节目</p>
      <h2 className="star-card-name">{episodeLabel(episode)} · {shortTitle(episode)}</h2>
      <div className="thread-ends">
        {sides.map(([conceptId, momentId], index) => {
          const concept = entities.get(conceptId)
          const topic = topics.find(item => item.id === concept?.topic)
          const moment = momentId ? moments.get(momentId) : undefined
          if (sameMoment && index === 1) return null
          return (
            <section className="thread-end" key={conceptId}>
              <div className="star-card-partners">
                <button type="button" onClick={() => onStar(conceptId)} style={{ '--tint': topic?.color } as React.CSSProperties}><span aria-hidden="true" />{concept?.name}</button>
                {sameMoment && (() => {
                  const other = entities.get(thread.to)
                  const color = topics.find(item => item.id === other?.topic)?.color
                  return <button type="button" onClick={() => onStar(thread.to)} style={{ '--tint': color } as React.CSSProperties}><span aria-hidden="true" />{other?.name}</button>
                })()}
              </div>
              <button className="star-card-row" type="button" onClick={() => onPlay(episode, moment?.startSec ?? 0, moment?.title ?? shortTitle(episode))}>
                <Play size={11} aria-hidden="true" />
                <span className="star-card-when">{moment ? timeLabel(moment.startSec) : '整期'}</span>
                <span className="star-card-title">{moment?.title ?? '在节目简介里提到'}</span>
              </button>
            </section>
          )
        })}
      </div>
      <div className="thread-foot">
        <SourceLinks episode={episode} />
        <button className="star-card-share" type="button" onClick={event => onShare(episode, event.currentTarget)}><Share2 size={13} aria-hidden="true" /> 分享单集</button>
      </div>
    </article>
  )
}

/** A sub-topic star: where the show talks about it, and which sub-topics come up alongside it. */
function StarCard({ star, topics, entities, episodes, moments, partners, onStar, onOpen, onClose, onPlay, onShare }: {
  star: Entity; topics: Topic[]; entities: Map<string, Entity>; episodes: Map<string, Episode>; moments: Map<string, Moment>
  partners: Partner[]; onStar: (id: string) => void; onOpen: () => void; onClose: () => void
  onPlay: (episode: Episode, startSec: number, title: string) => void
  onShare: (trigger: HTMLButtonElement) => void
}) {
  const topic = topics.find(item => item.id === star.topic)
  const rows = [...star.mentions]
    .sort((a, b) => episodes.get(b.episodeId)!.publishedAt.localeCompare(episodes.get(a.episodeId)!.publishedAt))
  const count = new Set(rows.map(point => point.episodeId)).size
  const [given, give] = useGiven()
  const asked = given.has(`more:${star.id}`)
  const askMore = () => {
    give(`more:${star.id}`)
    track('topic_more', { star: star.name, topic: topic?.title })
  }
  return (
    <article className="card card--star">
      <button className="icon-button card-close" type="button" aria-label="关闭" onClick={onClose}><X size={15} aria-hidden="true" /></button>
      <p className="star-card-topic"><span style={{ background: topic?.color }} aria-hidden="true" />{topic?.title}</p>
      <h2 className="star-card-name">{star.name}</h2>
      {star.note && <p className="star-card-note">{star.note}</p>}
      <p className="star-card-section">在 {count} 集里谈到</p>
      <div className="star-card-rows">
        {rows.slice(0, 4).map(point => {
          const episode = episodes.get(point.episodeId)!
          const moment = point.momentId ? moments.get(point.momentId) : undefined
          const start = moment?.startSec ?? 0
          return (
            <button className="star-card-row" type="button" key={`${point.episodeId}-${point.startSec}`}
              onClick={() => onPlay(episode, start, moment?.title ?? episode.title)}>
              <Play size={11} aria-hidden="true" />
              <span className="star-card-when">{episodeLabel(episode)}{moment ? ` · ${timeLabel(start)}` : ''}</span>
              <span className="star-card-title">{moment?.title ?? shortTitle(episode)}</span>
            </button>
          )
        })}
      </div>
      {rows.length > 4 && <button className="star-card-more" type="button" onClick={onOpen}>全部 {rows.length} 处 →</button>}
      {partners.length > 0 && (
        <>
          <p className="star-card-section">常一起出现</p>
          <div className="star-card-partners">
            {partners.slice(0, 6).map(partner => {
              const other = entities.get(partner.id)
              const color = topics.find(item => item.id === other?.topic)?.color
              return other && (
                <button key={partner.id} type="button" onClick={() => onStar(partner.id)} style={{ '--tint': color } as React.CSSProperties}>
                  <span aria-hidden="true" />{other.name}
                </button>
              )
            })}
          </div>
        </>
      )}
      <div className="star-card-foot">
        <button className="star-card-page" type="button" onClick={onOpen}>打开「{star.name}」页面</button>
        <span className="star-card-actions">
          <button className="star-card-share star-card-ask" type="button" onClick={askMore} disabled={asked} aria-pressed={asked}
            title={asked ? '已经告诉贝儿，你想听她多说说这个' : '告诉贝儿，你想听她多说说这个'}>
            {asked ? <Check size={13} aria-hidden="true" /> : <Ear size={13} aria-hidden="true" />}{asked ? '已告诉贝儿' : '多说说这个'}
          </button>
          <button className="star-card-share" type="button" onClick={event => onShare(event.currentTarget)}><Share2 size={13} aria-hidden="true" /> 分享</button>
        </span>
      </div>
    </article>
  )
}

/**
 * The mini player. It knows the segment it plays: a line along the bottom fills as the segment goes, the time counts
 * within the segment, and at its end the player stops and offers the next one. The title leads back to the segment's
 * card on the map.
 */
function PlayerBar({ player, onOpen, onWrite }: { player: ReturnType<typeof usePlayer>; onOpen?: () => void; onWrite?: (cue: Cue) => void }) {
  const { cue, playing, loading, finished, position, error, next } = player
  if (!cue) return null
  const bounded = cue.endSec !== null
  const length = bounded ? Math.max(1, cue.endSec! - cue.startSec) : cue.episode.durationSec
  const elapsed = bounded ? Math.min(length, Math.max(0, position - cue.startSec)) : position
  const status = error || (finished ? '这段听完了' : loading ? '正在载入…' : `${timeLabel(elapsed)} / ${timeLabel(length)}`)
  return (
    <div className={`player${finished ? ' is-finished' : ''}`} role="region" aria-label="正在播放"
      style={{ '--progress': Math.min(1, elapsed / Math.max(1, length)) } as React.CSSProperties}>
      <button className={`player-toggle${loading && !finished ? ' is-loading' : ''}`} type="button" onClick={player.toggle}
        aria-label={finished ? '重听这一段' : playing ? '暂停' : '播放'}>
        {finished ? <RotateCcw size={16} aria-hidden="true" /> : playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <div className="player-text">
        <span className="player-meta">{episodeLabel(cue.episode)} · <span aria-live="polite">{status}</span></span>
        {onOpen
          ? <button className="player-title" type="button" onClick={onOpen} title="在星图上找到这一段">{cue.title}</button>
          : <span className="player-title">{cue.title}</span>}
      </div>
      {bounded && <Reactions cue={cue} onWrite={onWrite} />}
      {finished && next
        ? <button className="player-next" type="button" onClick={() => player.play(next)} aria-label={`下一段：${next.title}`}>
            下一段<SkipForward size={13} aria-hidden="true" />
          </button>
        : <button className="icon-button player-back" type="button" aria-label="后退 15 秒" onClick={player.back} disabled={finished}>
            <RotateCcw size={20} strokeWidth={1.6} aria-hidden="true" /><span aria-hidden="true">15</span>
          </button>}
      <button className="icon-button" type="button" aria-label="停止播放" onClick={player.close}><X size={16} aria-hidden="true" /></button>
      <span className="player-progress" aria-hidden="true" />
    </div>
  )
}

const REACTIONS = [
  { kind: 'resonates', label: '说中我了', Icon: Heart },
  { kind: 'more', label: '想多听这个', Icon: Ear },
] as const

/**
 * Feedback on the segment playing, folded into one small button in the player so it never gets in the way. Opened, a
 * row of reactions floats above the player: each tap is counted for 贝儿 (README · 统计) and remembered on this
 * device, and 我有话说 opens a letter about the segment.
 */
function Reactions({ cue, onWrite }: { cue: Cue; onWrite?: (cue: Cue) => void }) {
  const [given, give] = useGiven()
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState('')
  const segment = `${cue.episode.id}@${Math.round(cue.startSec)}`
  const reacted = REACTIONS.some(({ kind }) => given.has(`${kind}:${segment}`))

  useEffect(() => setOpen(false), [segment])
  // After a reaction: a moment to read 已告诉贝儿, then the row folds away.
  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => {
      setFlash('')
      setOpen(false)
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [flash])
  // A press anywhere outside the player, or Escape, folds it too.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.player'))) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button className={`icon-button player-react${reacted ? ' is-given' : ''}`} type="button" onClick={() => setOpen(!open)}
        aria-expanded={open} aria-label="告诉贝儿你对这一段的感受" title="告诉贝儿">
        <MessageCircleHeart size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {open && (
        <div className="player-reactions" role="group" aria-label="告诉贝儿">
          {REACTIONS.map(({ kind, label, Icon }) => {
            const id = `${kind}:${segment}`
            const done = given.has(id)
            return (
              <button key={kind} type="button" disabled={done} aria-pressed={done} onClick={() => {
                give(id)
                setFlash(id)
                track('segment_feedback', {
                  kind, episode: episodeLabel(cue.episode), title: shortTitle(cue.episode), segment: cue.title, start_sec: Math.round(cue.startSec),
                })
              }}>
                {done ? <Check size={14} aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}
                {flash === id ? '已告诉贝儿' : label}
              </button>
            )
          })}
          {onWrite && (
            <button type="button" onClick={() => {
              setOpen(false)
              onWrite(cue)
            }}>
              <PenLine size={14} aria-hidden="true" />我有话说
            </button>
          )}
        </div>
      )}
    </>
  )
}
