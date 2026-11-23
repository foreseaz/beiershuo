import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, List, Music2, Pause, Play, Search, VolumeX, X } from 'lucide-react'
import {
  entityPath, episodeLabel, getAtlasPaths, loadAtlas, momentSource, parseEntityPath, timeLabel, topicMoments,
  type Anchor, type Atlas, type Entity, type Episode, type Moment, type Topic,
} from './domain'
import { EntityPage } from './EntityPage'
import { SearchSpace } from './SearchSpace'
import { useAmbient } from './ambient'
import { StarMap, type TopicPair } from './StarMap'
import { usePlayer, type Cue } from './player'

type Panel = 'search' | 'list' | null

function readUrl() {
  const params = new URLSearchParams(window.location.search)
  return { topic: params.get('topic') ?? '', moment: params.get('moment') ?? '' }
}

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

export function App() {
  const [atlas, setAtlas] = useState<Atlas | null>(null)
  const [failure, setFailure] = useState('')
  const [activeId, setActiveId] = useState(() => readUrl().topic)
  const [momentId, setMomentId] = useState(() => readUrl().moment)
  const [pairKey, setPairKey] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [route, setRoute] = useState(() => parseEntityPath(window.location.pathname))
  const reducedMotion = useReducedMotion()
  const player = usePlayer()
  // Site music sits low under an episode, and goes silent under episodes with their own music bed.
  const music = useAmbient(player.playing ? (player.cue?.episode.musicBed ? 'mute' : 'low') : 'none')

  useEffect(() => {
    const onPop = () => setRoute(parseEntityPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback((path: string) => {
    window.history.pushState(null, '', path)
    setRoute(parseEntityPath(new URL(path, window.location.origin).pathname))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    loadAtlas(controller.signal).then(setAtlas).catch(error => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '星图暂时打不开')
    })
    return () => controller.abort()
  }, [])

  const episodes = useMemo(() => new Map((atlas?.episodes ?? []).map(episode => [episode.id, episode])), [atlas])
  const moments = useMemo(() => new Map((atlas?.moments ?? []).map(moment => [moment.id, moment])), [atlas])
  const topics = atlas?.topics ?? []

  // Settle the initial focus once data arrives: a deep-linked moment wins, then the topic, then the default.
  useEffect(() => {
    if (!atlas) return
    const moment = momentId ? moments.get(momentId) : undefined
    if (momentId && !moment) setMomentId('')
    if (atlas.topics.some(topic => topic.id === activeId)) return
    const fallback = moment?.topicIds[0] ?? atlas.topics.find(topic => topic.id === 'boundaries')?.id ?? atlas.topics[0].id
    setActiveId(fallback)
    // Only runs when the atlas loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas])

  useEffect(() => {
    if (!activeId || route) return
    const params = new URLSearchParams({ topic: activeId })
    if (momentId) params.set('moment', momentId)
    window.history.replaceState(null, '', `/?${params}`)
  }, [activeId, momentId, route])

  const pairs = useMemo<TopicPair[]>(() => {
    if (!atlas) return []
    const grouped = new Map<string, TopicPair>()
    for (const path of getAtlasPaths(atlas)) {
      if (path.sourceTopicId === path.targetTopicId) continue
      const [from, to] = [path.sourceTopicId, path.targetTopicId].sort()
      const key = `${from}|${to}`
      const pair = grouped.get(key) ?? { key, from, to, paths: [] }
      pair.paths.push(path)
      grouped.set(key, pair)
    }
    return [...grouped.values()]
  }, [atlas])

  const episodeMarks = useMemo(() => {
    const marks = new Map<string, string>()
    const newest = [...(atlas?.episodes ?? [])].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    for (const topic of topics) {
      const episode = newest.find(item => item.topicIds?.[0] === topic.id) ?? newest.find(item => item.topicIds?.includes(topic.id))
      if (episode) marks.set(topic.id, episodeLabel(episode))
    }
    return marks
  }, [atlas, topics])

  const selectTopic = useCallback((id: string) => {
    setActiveId(id)
    setMomentId('')
    setPairKey('')
  }, [])

  const selectMoment = useCallback((moment: Moment, topicId?: string) => {
    setActiveId(current => topicId ?? (moment.topicIds.includes(current) ? current : moment.topicIds[0] ?? current))
    setMomentId(moment.id)
    setPairKey('')
    setPanel(null)
    if (parseEntityPath(window.location.pathname)) go('/')
  }, [go])

  const openEntity = useCallback((entity: Entity) => {
    setPanel(null)
    go(entityPath(entity))
  }, [go])

  const showTopic = useCallback((id: string) => {
    selectTopic(id)
    setPanel(null)
    if (parseEntityPath(window.location.pathname)) go('/')
  }, [go, selectTopic])

  const cueFor = useCallback((episode: Episode, startSec: number, title: string): Cue => ({ episode, startSec, title }), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPanel(null); setPairKey('') }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPanel('search') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!atlas) {
    return (
      <main className="space">
        <div className="space-fallback" aria-hidden="true" />
        <p className="space-status" role="status">{failure || '正在展开星图'}</p>
        <Brand />
      </main>
    )
  }

  const topic = topics.find(item => item.id === activeId) ?? topics[0]
  const pair = pairs.find(item => item.key === pairKey)
  const moment = momentId ? moments.get(momentId) : undefined
  const sorter = byRecency(episodes)
  const inTopic = topicMoments(atlas, topic.id).sort(sorter)
  const entity = route ? atlas.entities?.find(item => item.kind === route.kind && item.id === route.id) : undefined

  let card: ReactNode
  if (pair) {
    card = <PairCard pair={pair} topics={topics} onPlay={anchor => player.play(cueFor(anchor.episode, anchor.startSec, anchor.title))} onClose={() => setPairKey('')} />
  } else if (moment) {
    card = <MomentCard moment={moment} episode={episodes.get(moment.episodeId)!} onPlay={() => player.play(cueFor(episodes.get(moment.episodeId)!, moment.startSec, moment.title))} />
  } else {
    card = <TopicCard topic={topic} moments={inTopic} episodes={episodes}
      onMoment={item => selectMoment(item, topic.id)} onMore={() => setPanel('list')} />
  }

  return (
    <main className={`space${entity ? ' space--page' : ''}`}>
      <StarMap
        topics={topics}
        pairs={pairs}
        activeId={topic.id}
        episodeMarks={episodeMarks}
        reducedMotion={reducedMotion}
        onSelect={selectTopic}
        onPair={item => setPairKey(item.key)}
        card={card}
      />
      {entity && (
        <EntityPage atlas={atlas} entity={entity} episodes={episodes} onBack={() => go('/')} onEntity={openEntity} onTopic={showTopic}
          onMoment={item => selectMoment(item)} onPlay={(episode, startSec, title) => player.play(cueFor(episode, startSec, title))} />
      )}
      <nav className="corner-actions" aria-label="工具">
        <button type="button" onClick={music.toggle} aria-pressed={music.enabled} aria-label={music.enabled ? '关闭背景音乐' : '打开背景音乐'}>
          {music.enabled ? <Music2 size={19} strokeWidth={1.6} aria-hidden="true" /> : <VolumeX size={19} strokeWidth={1.6} aria-hidden="true" />} 音乐
        </button>
        <button type="button" onClick={() => setPanel(panel === 'search' ? null : 'search')} aria-expanded={panel === 'search'}>
          <Search size={20} strokeWidth={1.6} aria-hidden="true" /> 搜索
        </button>
        <button type="button" onClick={() => setPanel(panel === 'list' ? null : 'list')} aria-expanded={panel === 'list'}>
          <List size={20} strokeWidth={1.6} aria-hidden="true" /> 列表
        </button>
      </nav>
      {panel === 'search' && (
        <SearchSpace atlas={atlas} episodes={episodes} onTopic={showTopic} onEntity={openEntity} onMoment={item => selectMoment(item)} onClose={() => setPanel(null)} />
      )}
      {panel === 'list' && (
        <ListPanel atlas={atlas} topic={topic} episodes={episodes} activeMoment={momentId} onMoment={item => selectMoment(item, topic.id)}
          onPlay={item => player.play(cueFor(episodes.get(item.episodeId)!, item.startSec, item.title))} onClose={() => setPanel(null)} />
      )}
      <Brand />
      {player.cue && <PlayerBar player={player} />}
    </main>
  )
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="贝儿说 · 次要人生">
      <span className="brand-name">贝儿说</span>
      <span className="brand-rule" aria-hidden="true" />
      <span className="brand-show">次要人生</span>
    </a>
  )
}

function SourceLinks({ episode }: { episode: Episode }) {
  return (
    <div className="card-links">
      <a href={episode.xiaoyuzhouUrl} target="_blank" rel="noreferrer">小宇宙 <ArrowUpRight size={15} strokeWidth={1.5} aria-hidden="true" /></a>
      <a href={episode.appleUrl} target="_blank" rel="noreferrer">Apple Podcasts <ArrowUpRight size={15} strokeWidth={1.5} aria-hidden="true" /></a>
    </div>
  )
}

function MomentCard({ moment, episode, onPlay }: { moment: Moment; episode: Episode; onPlay: () => void }) {
  return (
    <article className="card">
      <div className="card-body">
        <p className="card-meta">{episodeLabel(episode)} · {timeLabel(moment.startSec)}</p>
        <h2 className="card-title">{moment.title}</h2>
        {moment.summary && <p className="card-summary">{moment.summary}</p>}
      </div>
      <div className="card-foot">
        <button className="card-play" type="button" onClick={onPlay}><Play size={14} aria-hidden="true" /> 听这一段</button>
        <SourceLinks episode={episode} />
      </div>
      <p className="card-source">{momentSource(moment)} · {episode.title}</p>
    </article>
  )
}

function TopicCard({ topic, moments, episodes, onMoment, onMore }: {
  topic: Topic; moments: Moment[]; episodes: Map<string, Episode>; onMoment: (moment: Moment) => void; onMore: () => void
}) {
  const featured = moments[0]
  const count = new Set(moments.map(moment => moment.episodeId)).size
  if (!featured) {
    return (
      <article className="card">
        <div className="card-body">
          <p className="card-meta">{topic.title}</p>
          <p className="card-summary">{topic.description}</p>
          <p className="card-note">这颗星连着的片段还在核听，先从「列表」里按单集听。</p>
        </div>
        <div className="card-foot"><button className="card-more" type="button" onClick={onMore}>全部单集</button></div>
      </article>
    )
  }
  const episode = episodes.get(featured.episodeId)!
  return (
    <article className="card">
      <button className="card-body card-body--button" type="button" onClick={() => onMoment(featured)}>
        <span className="card-meta">{episodeLabel(episode)} · {timeLabel(featured.startSec)}</span>
        <span className="card-title">{featured.title}</span>
      </button>
      <div className="card-foot">
        <SourceLinks episode={episode} />
        <button className="card-more" type="button" onClick={onMore}>{count} 集 · {moments.length} 段</button>
      </div>
    </article>
  )
}

function PairCard({ pair, topics, onPlay, onClose }: {
  pair: TopicPair; topics: Topic[]; onPlay: (anchor: Anchor) => void; onClose: () => void
}) {
  const title = (id: string) => topics.find(topic => topic.id === id)?.title ?? id
  return (
    <article className="card card--pair">
      <div className="card-head">
        <p className="card-meta">{title(pair.from)} ⟷ {title(pair.to)}</p>
        <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
      {pair.paths.slice(0, 3).map(path => (
        <section className="pair" key={path.id}>
          <p className="pair-label">{path.label}</p>
          <p className="pair-reason">{path.reason}</p>
          {[path.source, path.target].map(anchor => (
            <button className="pair-end" type="button" key={`${anchor.episode.id}-${anchor.startSec}`} onClick={() => onPlay(anchor)}>
              <Play size={12} aria-hidden="true" />
              <span className="pair-when">{episodeLabel(anchor.episode)} · {timeLabel(anchor.startSec)}</span>
              <span className="pair-title">{anchor.title}</span>
            </button>
          ))}
        </section>
      ))}
    </article>
  )
}

function ListPanel({ atlas, topic, episodes, activeMoment, onMoment, onPlay, onClose }: {
  atlas: Atlas; topic: Topic; episodes: Map<string, Episode>; activeMoment: string
  onMoment: (moment: Moment) => void; onPlay: (moment: Moment) => void; onClose: () => void
}) {
  const inTopic = topicMoments(atlas, topic.id)
  const showAll = inTopic.length === 0
  const source = showAll ? atlas.moments : inTopic
  const groups = new Map<string, Moment[]>()
  for (const moment of [...source].sort(byRecency(episodes))) {
    groups.set(moment.episodeId, [...(groups.get(moment.episodeId) ?? []), moment])
  }
  return (
    <aside className="panel panel--list" aria-label={showAll ? '全部单集' : `${topic.title}的片段`}>
      <div className="panel-head">
        <p className="panel-title">{showAll ? '全部单集' : topic.title}</p>
        <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
      <div className="panel-scroll">
        {[...groups].map(([episodeId, items]) => {
          const episode = episodes.get(episodeId)!
          return (
            <section className="episode" key={episodeId}>
              <p className="episode-title"><span>{episodeLabel(episode)}</span> {episode.title.replace(/^EP\s*\d+\s*[|｜:：]?\s*/i, '')}</p>
              {items.map(moment => (
                <div className={`row row--moment${moment.id === activeMoment ? ' is-active' : ''}`} key={moment.id}>
                  <button className="row-play" type="button" aria-label={`从 ${timeLabel(moment.startSec)} 开始听`} onClick={() => onPlay(moment)}>
                    <Play size={12} aria-hidden="true" />
                  </button>
                  <button className="row-main" type="button" onClick={() => onMoment(moment)}>
                    <span className="row-when">{timeLabel(moment.startSec)}</span>
                    <span className="row-title">{moment.title}</span>
                  </button>
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

function PlayerBar({ player }: { player: ReturnType<typeof usePlayer> }) {
  const cue = player.cue!
  return (
    <div className="player" role="region" aria-label="正在播放">
      <button className="player-toggle" type="button" onClick={player.toggle} aria-label={player.playing ? '暂停' : '播放'}>
        {player.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <div className="player-text">
        <span className="player-meta">{episodeLabel(cue.episode)} · {player.error || timeLabel(player.position || cue.startSec)}</span>
        <span className="player-title">{cue.title}</span>
      </div>
      <button className="icon-button" type="button" aria-label="停止播放" onClick={player.close}><X size={16} aria-hidden="true" /></button>
    </div>
  )
}
