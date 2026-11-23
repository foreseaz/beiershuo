import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import {
  ENTITY_LABELS, episodeLabel, timeLabel,
  type Atlas, type Entity, type Episode, type Moment, type Topic,
} from './domain'

type WordKind = 'topic' | 'person' | 'book' | 'film' | 'concept' | 'keyword'
type Word = { key: string; text: string; kind: WordKind; weight: number; topic?: Topic; entity?: Entity; terms: string[] }

type Props = {
  atlas: Atlas
  episodes: Map<string, Episode>
  onTopic: (id: string) => void
  onEntity: (entity: Entity) => void
  onMoment: (moment: Moment) => void
  onClose: () => void
}

const SUGGESTED = ['内耗', '讨好', '拖延', '孤独', '安全感', '羞耻', '配得感', '主体性', '迷茫', '边界感', '虚无', '低精力']
const fold = (text: string) => text.normalize('NFKC').replace(/[\s·・•‧\-—_.,'’]/g, '').toLowerCase()

function buildWords(atlas: Atlas): Word[] {
  const words = new Map<string, Word>()
  const add = (word: Word) => { if (!words.has(fold(word.text))) words.set(fold(word.text), word) }
  for (const topic of atlas.topics) add({ key: `t-${topic.id}`, text: topic.title, kind: 'topic', weight: 1, topic, terms: [topic.title, ...topic.aliases] })
  for (const entity of atlas.entities ?? []) {
    add({ key: `e-${entity.id}`, text: entity.name, kind: entity.kind, weight: Math.min(1, 0.35 + entity.mentions.length / 12), entity, terms: [entity.name, ...entity.aliases] })
  }
  for (const topic of atlas.topics) {
    for (const alias of topic.aliases) add({ key: `a-${topic.id}-${alias}`, text: alias, kind: 'keyword', weight: 0.35, terms: [alias] })
  }
  for (const keyword of atlas.keywords ?? []) {
    add({ key: `k-${keyword.text}`, text: keyword.text, kind: 'keyword', weight: Math.min(0.9, 0.25 + keyword.count / 40), terms: [keyword.text] })
  }
  return [...words.values()]
}

/** Evenly spread points on a sphere (Fibonacci lattice), dealt out in a fixed shuffled order. */
function sphere(count: number) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const points = Array.from({ length: count }, (_, i) => {
    const y = 1 - (i / Math.max(1, count - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = golden * i
    return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius }
  })
  let seed = 20251123
  for (let i = points.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const j = seed % (i + 1)
    ;[points[i], points[j]] = [points[j], points[i]]
  }
  return points
}

export function SearchSpace({ atlas, episodes, onTopic, onEntity, onMoment, onClose }: Props) {
  const [query, setQuery] = useState('')
  // Fewer, smaller words on small screens so the field reads as a sky, not a wall of text.
  const allWords = useMemo(() => buildWords(atlas), [atlas])
  const words = useMemo(() => {
    const all = allWords
    const limit = Math.round(Math.min(180, Math.max(60, (window.innerWidth * window.innerHeight) / 9000)))
    const kept = new Set([...all].sort((a, b) => Number(Boolean(b.topic)) - Number(Boolean(a.topic)) || b.weight - a.weight).slice(0, limit))
    return all.filter(word => kept.has(word))
  }, [allWords])
  const points = useMemo(() => sphere(words.length), [words.length])
  const elements = useRef<(HTMLButtonElement | null)[]>([])
  const needle = fold(query)
  const matches = useMemo(() => new Set(needle ? allWords.filter(word => word.terms.some(term => fold(term).includes(needle))).map(word => word.key) : []), [needle, allWords])
  const matchRef = useRef({ needle, matches })
  matchRef.current = { needle, matches }

  // Turn the sphere slowly; the pointer tilts it. Each word is projected in JS so text always faces the viewer.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 }
    const lift = new Float32Array(words.length)
    let angle = 0.6
    let frame = 0
    let last = performance.now()
    const onMove = (event: PointerEvent) => {
      tilt.tx = (event.clientY / window.innerHeight - 0.5) * 0.5
      tilt.ty = (event.clientX / window.innerWidth - 0.5) * 0.6
    }
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!reduced) angle += dt * 0.06
      tilt.x += (tilt.tx - tilt.x) * 0.05
      tilt.y += (tilt.ty - tilt.y) * 0.05
      const width = window.innerWidth
      const height = window.innerHeight
      const radius = Math.min(width * 0.4, height * 0.62)
      const perspective = radius * 2.4
      const [cy, sy, cx, sx] = [Math.cos(angle + tilt.y), Math.sin(angle + tilt.y), Math.cos(0.25 + tilt.x), Math.sin(0.25 + tilt.x)]
      const { needle: active, matches: hits } = matchRef.current
      words.forEach((word, i) => {
        const element = elements.current[i]
        if (!element) return
        const point = points[i]
        const x1 = point.x * cy + point.z * sy
        const z1 = -point.x * sy + point.z * cy
        const y2 = point.y * cx - z1 * sx
        const z2 = point.y * sx + z1 * cx
        const hit = active && hits.has(word.key)
        lift[i] += ((hit ? 1 : 0) - lift[i]) * (reduced ? 1 : 0.08)
        // Matches drift toward the viewer; everything else recedes while a query is active.
        const z = (z2 + lift[i] * (1.4 - z2)) * radius
        const scale = perspective / (perspective - z)
        const depth = (z2 + 1) / 2
        const base = active ? (hit ? 1 : 0.1) : 0.1 + Math.pow(depth, 1.6) * 0.8
        element.style.transform = `translate3d(${(width / 2 + x1 * radius * scale).toFixed(1)}px, ${(height / 2 + y2 * radius * 0.8 * scale).toFixed(1)}px, 0) translate(-50%, -50%) scale(${(scale * (0.7 + word.weight * 0.35)).toFixed(3)})`
        element.style.opacity = (base * (0.6 + 0.4 * Math.min(1, scale))).toFixed(3)
        element.style.zIndex = String(Math.round(z + radius * 2))
        element.style.pointerEvents = z2 > -0.2 || hit ? 'auto' : 'none'
      })
      frame = requestAnimationFrame(draw)
    }
    window.addEventListener('pointermove', onMove)
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
    }
  }, [words, points])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = (word: Word) => {
    if (word.topic) onTopic(word.topic.id)
    else if (word.entity) onEntity(word.entity)
    else setQuery(word.text)
  }

  const hits = allWords.filter(word => matches.has(word.key)).sort((a, b) => b.weight - a.weight)
  const entityHits = hits.filter(word => word.entity).slice(0, 8)
  const topicHits = hits.filter(word => word.topic)
  const mentioned = new Set(entityHits.flatMap(word => word.entity!.mentions.map(point => point.momentId)).filter(Boolean))
  const momentHits = needle ? atlas.moments.filter(moment => mentioned.has(moment.id) || fold(moment.title).includes(needle))
    .sort((a, b) => episodes.get(b.episodeId)!.publishedAt.localeCompare(episodes.get(a.episodeId)!.publishedAt) || a.startSec - b.startSec)
    .slice(0, 30) : []
  const suggestions = needle ? hits.filter(word => !word.topic && !word.entity).slice(0, 10)
    : SUGGESTED.map(text => allWords.find(word => word.text === text)).filter((word): word is Word => Boolean(word))

  return (
    <div className="search-space" role="dialog" aria-label="搜索">
      <div className="search-words" aria-hidden="true">
        {words.map((word, i) => (
          <button
            key={word.key}
            ref={element => { elements.current[i] = element }}
            className={`search-word search-word--${word.kind}${matches.has(word.key) ? ' is-match' : ''}`}
            style={word.topic ? { color: word.topic.color } : undefined}
            type="button"
            tabIndex={-1}
            onClick={() => choose(word)}
          >
            {word.text}
          </button>
        ))}
      </div>
      <button className="search-close icon-button" type="button" aria-label="关闭搜索" onClick={onClose}><X size={20} aria-hidden="true" /></button>
      <div className="search-center">
        <label className="search-field">
          <Search size={22} strokeWidth={1.5} aria-hidden="true" />
          <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="一个词、一个人、一本书" aria-label="搜索人物、书、概念和片段" />
        </label>
        {suggestions.length > 0 && (
          <div className="search-suggest">
            {!needle && <span className="search-suggest-label">试试</span>}
            {suggestions.map(word => (
              <button key={word.key} className="search-chip" type="button" onClick={() => setQuery(word.text)}>{word.text}</button>
            ))}
          </div>
        )}
        {needle && (
          <div className="search-results">
            {topicHits.length > 0 && <p className="panel-section">主题</p>}
            {topicHits.map(word => (
              <button className="row" type="button" key={word.key} onClick={() => onTopic(word.topic!.id)}>
                <span className="row-dot" style={{ background: word.topic!.color }} aria-hidden="true" />
                <span className="row-title">{word.topic!.title}</span>
                <span className="row-meta">{word.topic!.description}</span>
              </button>
            ))}
            {entityHits.length > 0 && <p className="panel-section">人物 · 书 · 影片 · 概念</p>}
            {entityHits.map(word => (
              <button className="row" type="button" key={word.key} onClick={() => onEntity(word.entity!)}>
                <span className="row-kind">{ENTITY_LABELS[word.entity!.kind]}</span>
                <span className="row-title">{word.entity!.name}</span>
                <span className="row-meta">{word.entity!.note} · {word.entity!.mentions.length} 处</span>
              </button>
            ))}
            {momentHits.length > 0 && <p className="panel-section">片段</p>}
            {momentHits.map(moment => {
              const episode = episodes.get(moment.episodeId)!
              return (
                <button className="row" type="button" key={moment.id} onClick={() => onMoment(moment)}>
                  <span className="row-when">{episodeLabel(episode)} · {timeLabel(moment.startSec)}</span>
                  <span className="row-title">{moment.title}</span>
                </button>
              )
            })}
            {!topicHits.length && !entityHits.length && !momentHits.length && <p className="panel-empty">节目里还没有谈到「{query.trim()}」</p>}
          </div>
        )}
      </div>
    </div>
  )
}
