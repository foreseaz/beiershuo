import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Clapperboard, CornerDownLeft, Search, Users, X } from 'lucide-react'
import {
  dayLabel, episodeLabel, shortTitle, timeLabel,
  type Atlas, type Entity, type EntityKind, type Episode, type Moment, type Topic,
} from './domain'
import { Portrait } from './Visual'
import { useDialog, useKeyboardViewport } from './dialog'

type Props = {
  atlas: Atlas
  episodes: Map<string, Episode>
  onTopic: (id: string) => void
  onStar: (id: string) => void
  onEntity: (entity: Entity) => void
  onIndex: (kind: EntityKind) => void
  onMoment: (moment: Moment) => void
  onEpisode: (id: string) => void
  onClose: () => void
}

type Item =
  | { type: 'topic'; key: string; topic: Topic; stars: number }
  | { type: 'entity'; key: string; entity: Entity; episodes: number; topic?: Topic; by?: string }
  | { type: 'episode'; key: string; episode: Episode; chapters: number }
  | { type: 'moment'; key: string; moment: Moment; episode: Episode }
type Group = { id: string; title: string; items: Item[]; total: number }

/** Everyday words people bring to the show; each one has results. */
const SUGGESTED = ['内耗', '讨好', '拖延', '孤独', '安全感', '羞耻', '配得感', '迷茫', '边界感', '低精力', '亲密关系', '自责']
const LIMITS: Record<string, number> = { topic: 7, concept: 6, person: 5, book: 5, film: 3, episode: 4, moment: 6 }
const GROUPS: { id: string; title: string }[] = [
  { id: 'topic', title: '主题' },
  { id: 'concept', title: '小主题' },
  { id: 'person', title: '人物' },
  { id: 'book', title: '书' },
  { id: 'film', title: '影片与节目' },
  { id: 'episode', title: '单集' },
  { id: 'moment', title: '章节' },
]

const fold = (text: string) => text.normalize('NFKC').replace(/[\s·・•‧\-—_.,'’]/g, '').toLowerCase()

/** 3 for an exact name, 2 when a name starts with the query, 1 when it only contains it. */
function score(terms: string[], needle: string) {
  let best = 0
  for (const term of terms) {
    const folded = fold(term)
    if (!folded) continue
    if (folded === needle) return 3
    if (folded.startsWith(needle)) best = Math.max(best, 2)
    else if (folded.includes(needle)) best = Math.max(best, 1)
  }
  return best
}

/** The part of `text` that matches the query, lit. Matches through an alias or folding stay unlit. */
function Marked({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>
}

/**
 * Search: a quiet sheet over the map. Empty, it offers the seven topics, a few everyday words and the indexes;
 * typing lists topics, sub-topics, people, books, films, episodes and chapters in groups, best match first.
 */
export function SearchSpace({ atlas, episodes, onTopic, onStar, onEntity, onIndex, onMoment, onEpisode, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useDialog(dialog)
  useKeyboardViewport(dialog)
  const needle = fold(query)

  const entities = atlas.entities ?? []
  const byId = useMemo(() => new Map(entities.map(item => [item.id, item])), [entities])
  const topicById = useMemo(() => new Map(atlas.topics.map(topic => [topic.id, topic])), [atlas.topics])
  const starCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of entities) if (item.topic) counts.set(item.topic, (counts.get(item.topic) ?? 0) + 1)
    return counts
  }, [entities])
  const counts = useMemo(() => ({
    person: entities.filter(item => item.kind === 'person').length,
    book: entities.filter(item => item.kind === 'book').length,
    film: entities.filter(item => item.kind === 'film').length,
  }), [entities])

  const groups = useMemo<Group[]>(() => {
    if (!needle) return []
    const found = new Map<string, { item: Item; rank: number }[]>(GROUPS.map(group => [group.id, []]))
    for (const topic of atlas.topics) {
      const rank = score([topic.title, ...topic.aliases], needle)
      if (rank) found.get('topic')!.push({ item: { type: 'topic', key: `t-${topic.id}`, topic, stars: starCount.get(topic.id) ?? 0 }, rank })
    }
    const strong = new Set<string>()
    for (const entity of entities) {
      const rank = score([entity.name, ...entity.aliases], needle)
      if (!rank) continue
      if (rank >= 2) strong.add(entity.id)
      const maker = byId.get(entity.author ?? entity.people?.[0] ?? '')
      found.get(entity.kind)?.push({
        item: {
          type: 'entity', key: `e-${entity.id}`, entity,
          episodes: new Set(entity.mentions.map(point => point.episodeId)).size,
          topic: entity.topic ? topicById.get(entity.topic) : undefined,
          by: entity.kind === 'concept' ? undefined : maker?.name,
        },
        rank: rank * 1000 + entity.mentions.length,
      })
    }
    // Episodes: by title (without its number) or official topic, or by number (EP52), newest first among equals.
    const chapterCount = new Map<string, number>()
    for (const moment of atlas.moments) chapterCount.set(moment.episodeId, (chapterCount.get(moment.episodeId) ?? 0) + 1)
    for (const episode of episodes.values()) {
      const rank = Math.max(score([shortTitle(episode), episode.officialTopic ?? ''], needle), fold(episodeLabel(episode)) === needle ? 3 : 0)
      if (!rank) continue
      found.get('episode')!.push({
        item: { type: 'episode', key: `p-${episode.id}`, episode, chapters: chapterCount.get(episode.id) ?? 0 },
        rank: rank * 1e12 + Date.parse(episode.publishedAt) / 1000,
      })
    }
    // Chapters: titles that contain the words first, then chapters where a closely matching name comes up.
    const named = new Set(entities.filter(entity => strong.has(entity.id)).flatMap(entity => entity.mentions.map(point => point.momentId)).filter(Boolean))
    for (const moment of atlas.moments) {
      const direct = fold(moment.title).includes(needle)
      if (!direct && !named.has(moment.id)) continue
      const episode = episodes.get(moment.episodeId)
      if (!episode) continue
      found.get('moment')!.push({
        item: { type: 'moment', key: `m-${moment.id}`, moment, episode },
        rank: (direct ? 2 : 1) * 1e12 + Date.parse(episode.publishedAt) / 1000 - moment.startSec / 1e6,
      })
    }
    return GROUPS.map(group => {
      const all = found.get(group.id)!.sort((a, b) => b.rank - a.rank).map(entry => entry.item)
      return { ...group, total: all.length, items: expanded.has(group.id) ? all : all.slice(0, LIMITS[group.id]) }
    }).filter(group => group.total > 0)
  }, [needle, atlas, entities, byId, topicById, starCount, episodes, expanded])

  const flat = useMemo(() => groups.flatMap(group => group.items), [groups])
  const related = useMemo(() => needle
    ? (atlas.keywords ?? []).filter(keyword => fold(keyword.text) !== needle && fold(keyword.text).includes(needle)).slice(0, 8).map(keyword => keyword.text)
    : [], [needle, atlas.keywords])

  // A new query starts at the top, with every group folded back to its first few.
  useEffect(() => {
    setActive(0)
    setExpanded(new Set())
    list.current?.scrollTo({ top: 0 })
  }, [needle])

  useEffect(() => {
    list.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (item: Item) => {
    if (item.type === 'topic') onTopic(item.topic.id)
    else if (item.type === 'moment') onMoment(item.moment)
    else if (item.type === 'episode') onEpisode(item.episode.id)
    else if (item.entity.kind === 'concept' && item.entity.topic) onStar(item.entity.id)
    else onEntity(item.entity)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!flat.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(index => (index + step + flat.length) % flat.length)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      run(flat[Math.min(active, flat.length - 1)])
    }
  }

  const pick = (text: string) => {
    setQuery(text)
    input.current?.focus()
  }

  let index = -1
  const row = (item: Item) => {
    index += 1
    const at = index
    const lit = at === active
    let lead: ReactNode
    let name: ReactNode
    let sub: ReactNode
    if (item.type === 'topic') {
      lead = <span className="search-lead search-lead--topic" style={{ '--tint': item.topic.color } as React.CSSProperties}><i /></span>
      name = <Marked text={item.topic.title} query={query} />
      sub = `${item.stars} 个小主题 · ${item.topic.description}`
    } else if (item.type === 'episode') {
      lead = <span className="search-lead search-lead--time">{episodeLabel(item.episode)}</span>
      name = <Marked text={shortTitle(item.episode)} query={query} />
      sub = [dayLabel(item.episode.publishedAt), item.chapters ? `${item.chapters} 个章节` : '', item.episode.officialTopic].filter(Boolean).join(' · ')
    } else if (item.type === 'moment') {
      lead = <span className="search-lead search-lead--time">{timeLabel(item.moment.startSec)}</span>
      name = <Marked text={item.moment.title} query={query} />
      sub = `${episodeLabel(item.episode)} · ${shortTitle(item.episode)}`
    } else {
      const { entity } = item
      if (entity.kind === 'person') lead = <span className="search-lead"><Portrait entity={entity} size={32} /></span>
      else if (entity.kind === 'book') lead = <span className="search-lead search-lead--book"><BookOpen size={15} strokeWidth={1.6} /></span>
      else if (entity.kind === 'film') lead = <span className="search-lead search-lead--film"><Clapperboard size={15} strokeWidth={1.6} /></span>
      else lead = <span className="search-lead search-lead--star" style={{ '--tint': item.topic?.color } as React.CSSProperties}><i /></span>
      const title = entity.kind === 'book' || entity.kind === 'film' ? `《${entity.name}》` : entity.name
      name = <Marked text={title} query={query} />
      const where = item.episodes ? `${item.episodes} 集` : '通过著作出现'
      sub = [item.topic?.title ?? item.by, where, entity.note].filter(Boolean).join(' · ')
    }
    return (
      <button
        key={item.key}
        className="search-row"
        type="button"
        data-active={lit ? '1' : undefined}
        onPointerMove={event => { if (event.pointerType === 'mouse' && !lit) setActive(at) }}
        onClick={() => run(item)}
      >
        {lead}
        <span className="search-text">
          <span className="search-name">{name}</span>
          <span className="search-sub">{sub}</span>
        </span>
        <CornerDownLeft className="search-enter" size={14} aria-hidden="true" />
      </button>
    )
  }

  return (
    <dialog ref={dialog} className="app-dialog search" aria-label="搜索" onCancel={event => {
      event.preventDefault()
      if (query) setQuery('')
      else onClose()
    }}>
      <button className="search-scrim" type="button" tabIndex={-1} aria-label="关闭搜索" onClick={onClose} />
      <div className="search-sheet">
        <div className="search-bar">
          <Search className="search-icon" size={19} strokeWidth={1.6} aria-hidden="true" />
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜一个词、一个人、一本书"
            aria-label="搜索主题、人物、书和章节"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {query && (
            <button className="search-clear" type="button" aria-label="清空" onClick={() => pick('')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
          <button className="search-cancel" type="button" onClick={onClose}>
            <span className="search-cancel-key">Esc</span>
            <span className="search-cancel-word">取消</span>
          </button>
        </div>

        <div className="search-body" ref={list}>
          {!needle && (
            <>
              <p className="search-label">七个主题</p>
              <div className="search-topics">
                {atlas.topics.map(topic => (
                  <button key={topic.id} type="button" className="search-topic" onClick={() => onTopic(topic.id)}
                    style={{ '--tint': topic.color } as React.CSSProperties}>
                    <i aria-hidden="true" />
                    <span>{topic.title}</span>
                    <small>{starCount.get(topic.id) ?? 0}</small>
                  </button>
                ))}
              </div>
              <p className="search-label">试试这些词</p>
              <div className="search-chips">
                {SUGGESTED.map(text => <button key={text} type="button" className="search-chip" onClick={() => pick(text)}>{text}</button>)}
              </div>
              <p className="search-label">索引</p>
              <div className="search-indexes">
                <button type="button" onClick={() => onIndex('person')}><Users size={15} strokeWidth={1.6} aria-hidden="true" />人物<small>{counts.person}</small></button>
                <button type="button" onClick={() => onIndex('book')}><BookOpen size={15} strokeWidth={1.6} aria-hidden="true" />书<small>{counts.book}</small></button>
                {counts.film > 0 && <button type="button" onClick={() => onIndex('film')}><Clapperboard size={15} strokeWidth={1.6} aria-hidden="true" />影片<small>{counts.film}</small></button>}
              </div>
            </>
          )}

          {needle && related.length > 0 && (
            <div className="search-chips search-chips--related">
              {related.map(text => <button key={text} type="button" className="search-chip" onClick={() => pick(text)}>{text}</button>)}
            </div>
          )}

          {groups.map(group => (
            <section className="search-group" key={group.id} aria-label={group.title}>
              <p className="search-label">{group.title}<span>{group.total}</span></p>
              {group.items.map(row)}
              {group.total > group.items.length && (
                <button className="search-more" type="button" onClick={() => setExpanded(previous => new Set(previous).add(group.id))}>
                  显示全部 {group.total} 个{group.title}
                </button>
              )}
            </section>
          ))}

          {needle && !groups.length && (
            <div className="search-empty">
              <p>节目里还没有谈到「{query.trim()}」</p>
              <div className="search-chips">
                {SUGGESTED.slice(0, 6).map(text => <button key={text} type="button" className="search-chip" onClick={() => pick(text)}>{text}</button>)}
              </div>
            </div>
          )}
        </div>

        {flat.length > 0 && (
          <p className="search-foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>↵</kbd> 打开</span>
            <span><kbd>Esc</kbd> 清空</span>
          </p>
        )}
      </div>
    </dialog>
  )
}
