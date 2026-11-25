import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, BookOpen, ChevronRight, List, Pause, Play, RotateCcw, Search, Share2, SkipForward, Users, VolumeX, X } from 'lucide-react'
import {
  ENTITY_LABELS, SHOW_XIAOYUZHOU, entityPath, episodeLabel, indexPath, loadAtlas, momentSource, parseRoute, timeLabel, topicMoments,
  type Atlas, type Entity, type EntityKind, type Episode, type Moment, type Topic,
} from './domain'
import { EntityPage } from './EntityPage'
import { Overlay } from './Overlay'
import { ShareDialog } from './ShareDialog'
import { IndexPage } from './IndexPage'
import { SearchSpace } from './SearchSpace'
import { useAmbient } from './ambient'
import { StarMap, type GalaxyStar } from './StarMap'
import { segmentsOf, usePlayer } from './player'
import { ApplePodcastsIcon, XiaoyuzhouIcon } from './platforms'
import { useDialog, useDialogExit, useKeyboardViewport, usePhoneLayout } from './dialog'
import { useSheetDrag } from './sheet'
import type { ShareSubject } from './shareCard'
import type { Thread, Travel } from './scene/GalaxyScene'

type Panel = 'search' | 'list' | null
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
  return { stars, threads, info, partners }
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
  const [listedEpisode, setListedEpisode] = useState(() => readUrl().episode)
  const [panel, setPanel] = useState<Panel>(() => readUrl().episode ? 'list' : null)
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname))
  const phone = usePhoneLayout()
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
      const episode = nextRoute ? '' : readUrl().episode
      setRoute(nextRoute)
      setListedEpisode(episode)
      setPanel(episode ? 'list' : null)
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
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '星图暂时打不开')
    })
    return () => controller.abort()
  }, [])

  const episodes = useMemo(() => new Map((atlas?.episodes ?? []).map(episode => [episode.id, episode])), [atlas])
  const moments = useMemo(() => new Map((atlas?.moments ?? []).map(moment => [moment.id, moment])), [atlas])
  const entities = useMemo(() => new Map((atlas?.entities ?? []).map(item => [item.id, item])), [atlas])
  const topics = atlas?.topics ?? []
  const galaxy = useMemo(() => buildGalaxy(atlas), [atlas])
  const closeShare = useCallback(() => setShared(null), [])
  const closePanel = useCallback(() => {
    setPanel(null)
    setListedEpisode('')
  }, [])

  // Drop deep-link values that no longer exist once the data arrives.
  useEffect(() => {
    if (!atlas) return
    if (starId && !entities.get(starId)?.topic) setStarId('')
    if (momentId && !moments.get(momentId)) setMomentId('')
    if (listedEpisode && !episodes.has(listedEpisode)) setListedEpisode('')
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
    if (panel === 'list' && listedEpisode) params.set('episode', listedEpisode)
    window.history.replaceState(null, '', params.size ? `/?${params}` : '/')
  }, [viewNebula, starId, momentId, route, panel, listedEpisode])

  const fly = useCallback((trip: Omit<Travel, 'seq'>) => setTravel(previous => ({ seq: previous.seq + 1, ...trip })), [])

  const leavePage = useCallback(() => { if (parseRoute(window.location.pathname)) closeOverlay() }, [closeOverlay])

  const focusNebula = useCallback((id: string) => {
    setStarId('')
    setThreadId('')
    setMomentId('')
    setPanel(null)
    fly({ nebula: id })
    leavePage()
  }, [fly, leavePage])

  const selectStar = useCallback((id: string) => {
    if (!entities.get(id)?.topic) return
    setStarId(id)
    setThreadId('')
    setMomentId('')
    setPanel(null)
    fly({ star: id })
    leavePage()
  }, [entities, fly, leavePage])

  const selectThread = useCallback((id: string) => {
    setThreadId(id)
    setStarId('')
    setMomentId('')
  }, [])

  const overview = useCallback(() => {
    setStarId('')
    setThreadId('')
    setMomentId('')
    fly({})
  }, [fly])

  // Clicking empty sky steps back one level: card → nebula → whole sky.
  const stepBack = useCallback(() => {
    if (momentId || threadId || starId) {
      setMomentId('')
      setThreadId('')
      setStarId('')
    } else if (viewNebula) overview()
  }, [momentId, threadId, starId, viewNebula, overview])

  const selectMoment = useCallback((moment: Moment) => {
    setMomentId(moment.id)
    setStarId('')
    setThreadId('')
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
  const shareEntity = (entity: Entity, trigger: HTMLButtonElement) => {
    trigger.focus({ preventScroll: true })
    const maker = entity.kind === 'concept' ? undefined : entities.get(entity.author ?? entity.people?.[0] ?? '')?.name
    const tint = topics.find(item => item.id === (entity.topic ?? entity.topicIds[0]))?.color ?? '#9fb0ff'
    setShared({ subject: { kind: 'entity', entity, tint, maker }, path: entityPath(entity) })
  }
  const shareEpisode = (episode: Episode, trigger: HTMLButtonElement) => {
    trigger.focus({ preventScroll: true })
    const tint = topics.find(item => item.id === episode.topicIds?.[0])?.color ?? '#9fb0ff'
    setShared({ subject: { kind: 'episode', episode, tint }, path: episodePath(episode.id) })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shared || event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPanel('search'); return }
      if (event.key !== 'Escape') return
      if (panel === 'list' && !phone) closePanel()
      else if (!panel && !parseRoute(window.location.pathname)) stepBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, stepBack, shared, phone, closePanel])

  const related = useMemo(() => {
    if (!starId) return new Set<string>()
    return new Set(galaxy.threads.filter(thread => thread.from === starId || thread.to === starId).map(thread => (thread.from === starId ? thread.to : thread.from)))
  }, [galaxy, starId])

  if (!atlas) {
    return (
      <main className="space">
        <div className="space-fallback" aria-hidden="true" />
        <p className="space-status" role="status">{failure || '正在展开星图'}</p>
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
  const playerBar = player.cue && <PlayerBar player={player} onOpen={playing && (() => selectMoment(playing))} />

  let card: ReactNode = null
  if (moment) {
    card = <MomentCard moment={moment} episode={episodes.get(moment.episodeId)!} onClose={() => setMomentId('')} onShare={shareEpisode}
      onPlay={() => player.play(cueFor(episodes.get(moment.episodeId)!, moment.startSec, moment.title))} />
  } else if (thread) {
    card = <ThreadCard thread={thread} topics={topics} entities={entities} episodes={episodes} moments={moments}
      onStar={selectStar} onClose={() => setThreadId('')} onShare={shareEpisode} onPlay={(episode, startSec, title) => player.play(cueFor(episode, startSec, title))} />
  } else if (star) {
    card = <StarCard star={star} topics={topics} entities={entities} episodes={episodes} moments={moments}
      partners={galaxy.partners.get(star.id) ?? []} onStar={selectStar} onOpen={() => openEntity(star)} onClose={() => setStarId('')}
      onShare={trigger => shareEntity(star, trigger)}
      onPlay={(episode, startSec, title) => player.play(cueFor(episode, startSec, title))} />
  }

  return (
    <main className={`space${entity || index ? ' space--page' : ''}`}>
      <StarMap
        topics={topics}
        stars={galaxy.stars}
        threads={galaxy.threads}
        selected={star?.id ?? null}
        related={related}
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
        cardKey={momentId || threadId || starId}
      />
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
                onPlay={(episode, startSec, title) => player.play(cueFor(episode, startSec, title))} onShare={trigger => shareEntity(entity, trigger)} />
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
          if (panel === 'list') closePanel()
          else setPanel('list')
        }} aria-expanded={panel === 'list'}>
          <List size={18} strokeWidth={1.5} aria-hidden="true" /> 列表
        </button>
      </nav>
      {panel === 'search' && (
        <SearchSpace atlas={atlas} episodes={episodes} onTopic={focusNebula} onStar={selectStar} onEntity={openEntity} onIndex={openIndex}
          onMoment={selectMoment} onClose={closePanel} />
      )}
      {panel === 'list' && (
        <ListPanel atlas={atlas} episodes={episodes} activeMoment={momentId} activeEpisode={listedEpisode} phone={phone}
          player={phone ? playerBar : null} onMoment={selectMoment} onShare={shareEpisode}
          onPlay={item => player.play(cueFor(episodes.get(item.episodeId)!, item.startSec, item.title))}
          onPlayEpisode={episode => player.play(cueFor(episode, 0, shortTitle(episode), true))} onClose={closePanel} />
      )}
      {shared && <ShareDialog {...shared} episodes={episodes} moments={moments} onClose={closeShare} />}
      <Brand />
      <MusicPlayer music={music} />
      {!entity && !index && !(panel === 'list' && phone) && playerBar}
    </main>
  )
}

/** Bottom-right music switch; the credit shows while a recorded track plays. */
function MusicPlayer({ music }: { music: ReturnType<typeof useAmbient> }) {
  return (
    <div className={`music-switch${music.playing ? ' is-on' : ''}`}>
      {music.credit && music.enabled && <span className="music-credit">音乐 · {music.credit}</span>}
      <button type="button" onClick={music.toggle} aria-pressed={music.enabled} aria-label={music.enabled ? '关闭背景音乐' : '打开背景音乐'} title={music.enabled ? '关闭背景音乐' : '打开背景音乐'}>
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

const shortTitle = (episode: Episode) => episode.title.replace(/^EP\s*\d+\s*[.．:：|｜]?\s*/i, '')

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
        <button className="star-card-share" type="button" onClick={event => onShare(event.currentTarget)}><Share2 size={13} aria-hidden="true" /> 分享</button>
      </div>
    </article>
  )
}

/** Every episode, newest first; each folds open to its chapters. */
function ListPanel({ atlas, episodes, activeMoment, activeEpisode, phone, player, onMoment, onPlay, onPlayEpisode, onShare, onClose }: {
  atlas: Atlas; episodes: Map<string, Episode>; activeMoment: string; activeEpisode: string; phone: boolean; player: ReactNode
  onMoment: (moment: Moment) => void; onPlay: (moment: Moment) => void; onPlayEpisode: (episode: Episode) => void; onClose: () => void
  onShare: (episode: Episode, trigger: HTMLButtonElement) => void
}) {
  const [open, setOpen] = useState(() => new Set(activeEpisode ? [activeEpisode] : []))
  const [filter, setFilter] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const linked = useRef<HTMLElement>(null)
  const { leaving, close } = useDialogExit(onClose)
  useDialog(dialog, phone)
  useKeyboardViewport(dialog)
  useSheetDrag({ sheet, handle, scroller, onDismiss: onClose })

  useEffect(() => {
    const target = linked.current
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    target.querySelector('button')?.focus({ preventScroll: true })
  }, [activeEpisode])

  const chapters = useMemo(() => {
    const result = new Map<string, Moment[]>()
    for (const moment of atlas.moments) result.set(moment.episodeId, [...(result.get(moment.episodeId) ?? []), moment])
    return result
  }, [atlas])
  const needle = filter.trim().toLowerCase()
  const list = [...episodes.values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter(episode => !needle || [episode.title, episode.officialTopic ?? '', episodeLabel(episode),
      ...(chapters.get(episode.id) ?? []).map(moment => moment.title)].some(text => text.toLowerCase().includes(needle)))
  const toggle = (id: string) => setOpen(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <dialog ref={dialog} className={`app-dialog episode-list${leaving ? ' is-leaving' : ''}`} aria-label="全部单集"
      onCancel={event => { event.preventDefault(); close() }}>
      {phone && <button className="panel-scrim" type="button" aria-label="关闭" tabIndex={-1} onClick={close} />}
      <div className="panel panel--list" ref={sheet}>
        <div className="panel-head" ref={handle}>
          <span className="sheet-grip" aria-hidden="true" />
          <p className="panel-title">全部单集 <span className="panel-count">{list.length}</span></p>
          <button className="icon-button" type="button" aria-label="关闭" onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
        <label className="panel-filter">
          <Search size={14} strokeWidth={1.6} aria-hidden="true" />
          <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="按标题或章节筛选" aria-label="筛选单集" />
        </label>
        <div className="panel-scroll" ref={scroller}>
          {list.map(episode => {
            const items = chapters.get(episode.id) ?? []
            const expanded = open.has(episode.id) || (needle !== '' && items.some(moment => moment.title.toLowerCase().includes(needle)))
            return (
              <section className={`episode-fold${expanded ? ' is-open' : ''}`} key={episode.id} ref={episode.id === activeEpisode ? linked : undefined}>
                <div className="episode-head">
                  <button className="episode-toggle" type="button" aria-expanded={expanded} onClick={() => toggle(episode.id)}>
                    <ChevronRight size={14} aria-hidden="true" className="episode-chevron" />
                    <span className="episode-number">{episodeLabel(episode)}</span>
                    <span className="episode-name">{shortTitle(episode)}</span>
                    {items.length > 0 && <span className="episode-count">{items.length}</span>}
                  </button>
                  <button className="row-play" type="button" aria-label={`从头播放 ${episodeLabel(episode)}`} onClick={() => onPlayEpisode(episode)}>
                    <Play size={12} aria-hidden="true" />
                  </button>
                  <button className="row-play" type="button" aria-label={`分享 ${episodeLabel(episode)}`} onClick={event => onShare(episode, event.currentTarget)}>
                    <Share2 size={12} aria-hidden="true" />
                  </button>
                </div>
                {expanded && (
                  <div className="episode-chapters">
                    {items.map(moment => (
                      <div className={`row row--moment${moment.id === activeMoment ? ' is-active' : ''}`} key={moment.id}>
                        <button className="row-play" type="button" aria-label={`从 ${timeLabel(moment.startSec)} 开始听`} onClick={() => onPlay(moment)}>
                          <Play size={11} aria-hidden="true" />
                        </button>
                        <button className="row-main" type="button" onClick={() => onMoment(moment)}>
                          <span className="row-when">{timeLabel(moment.startSec)}</span>
                          <span className="row-title">{moment.title}</span>
                        </button>
                      </div>
                    ))}
                    <SourceLinks episode={episode} />
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </div>
      {player}
    </dialog>
  )
}

/**
 * The mini player. It knows the segment it plays: a line along the bottom fills as the segment goes, the time counts
 * within the segment, and at its end the player stops and offers the next one. The title leads back to the segment's
 * card on the map.
 */
function PlayerBar({ player, onOpen }: { player: ReturnType<typeof usePlayer>; onOpen?: () => void }) {
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
