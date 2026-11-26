import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { dayLabel, episodeLabel, shortTitle, type Episode } from './domain'

type RailProps = {
  /** Newest first: the latest episode sits at the top of the rail and the first one at its foot. */
  episodes: Episode[]
  /** The episode whose card is open. */
  active: string
  /** Episodes to mark, with a colour: those that mention the chosen sub-topic. */
  marks: Map<string, string>
  /** The episode now playing. */
  playing: string
  /** How many sub-topics each episode mentions, for the callout. */
  starCount: (id: string) => number
  /** The episode under the pointer or finger (null when it leaves), so the map can light it. */
  onPreview: (id: string | null) => void
  onSelect: (id: string) => void
}

// Room above the first tick and below the last, how far the magnification reaches, and the least room a month
// label needs (px).
const PAD = 8
const REACH = 20
const LABEL_GAP = 15
// Wheel travel per step, so a mouse wheel moves one episode per notch and a trackpad needs a deliberate stroke.
const NOTCH = 40

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

let haptic: HTMLLabelElement | null = null
/**
 * One light tap as the finger crosses a tick. The vibration API where there is one; iPhone Safari has none, but
 * flipping a hidden `switch` checkbox plays the system's own haptic tick (iOS 18+). Elsewhere it does nothing.
 */
function detent(pointerType: string) {
  if (pointerType !== 'touch') return
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(5)
    return
  }
  if (!haptic) {
    const label = document.createElement('label')
    label.setAttribute('aria-hidden', 'true')
    label.style.display = 'none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    label.appendChild(input)
    document.body.appendChild(label)
    haptic = label
  }
  haptic.click()
}

/**
 * The first tick of each month (in rail order) gets the month beside it; the topmost label and the first label of
 * each new year carry the year.
 */
function monthLabels(episodes: Episode[]) {
  const labels: { index: number; text: string }[] = []
  let last = ''
  episodes.forEach((episode, index) => {
    const [year, month] = new Date(episode.publishedAt)
      .toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Shanghai' }).split('-')
    const key = `${year}-${month}`
    if (key === last) return
    labels.push({ index, text: !last || !last.startsWith(year) ? `${year}.${Number(month)}` : `${Number(month)}月` })
    last = key
  })
  return labels
}

/**
 * Every episode as a tick on a vertical timeline at the right edge, newest at the top. Ticks swell under the pointer
 * like the Dock and Time Machine; the one under it lights its sub-topics on the map and names itself in a callout. A
 * click opens it. The wheel and the arrow keys walk from episode to episode, one per notch; a finger scrubs with a
 * light tap per tick and opens the episode it lifts on.
 */
export function EpisodeRail({ episodes, active, marks, playing, starCount, onPreview, onSelect }: RailProps) {
  const rail = useRef<HTMLDivElement>(null)
  const ticks = useRef<(HTMLSpanElement | null)[]>([])
  const [height, setHeight] = useState(0)
  const [preview, setPreview] = useState<number | null>(null)
  const state = useRef({ preview: null as number | null, pointer: 'mouse', dragging: false, wheel: 0 })
  const latest = useRef({ episodes, active, onPreview, onSelect })
  latest.current = { episodes, active, onPreview, onSelect }

  const count = episodes.length
  const step = count > 1 ? Math.max(0, height - PAD * 2) / (count - 1) : 0
  const yOf = (index: number) => PAD + index * step
  const indexAt = (y: number) => clamp(Math.round((y - PAD) / Math.max(step, 1e-6)), 0, count - 1)
  const activeIndex = episodes.findIndex(episode => episode.id === active)
  const months = useMemo(() => monthLabels(episodes), [episodes])
  const monthStarts = useMemo(() => new Set(months.map(month => month.index)), [months])
  // Where months crowd together, keep the labels that fit; a year wins over the month just before it.
  const shownMonths: typeof months = []
  for (const month of months) {
    const previous = shownMonths.at(-1)
    if (!previous || (month.index - previous.index) * step >= LABEL_GAP) shownMonths.push(month)
    else if (month.text.includes('.') && shownMonths.length > 1) shownMonths[shownMonths.length - 1] = month
  }

  useEffect(() => {
    const element = rail.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** Swell the ticks near y (px from the rail's top); null lets them all settle. Written straight to the DOM. */
  const magnify = (y: number | null) => {
    ticks.current.forEach((tick, index) => {
      if (!tick) return
      const distance = y === null ? Infinity : yOf(index) - y
      tick.style.setProperty('--boost', y === null ? '0' : Math.exp(-(distance * distance) / (2 * REACH * REACH)).toFixed(3))
    })
  }

  const peek = (index: number | null, feel = false) => {
    const current = state.current
    if (current.preview === index) return
    if (feel && index !== null && current.preview !== null) detent(current.pointer)
    current.preview = index
    setPreview(index)
    latest.current.onPreview(index === null ? null : latest.current.episodes[index].id)
  }

  /** Walk one tick up (-1, newer) or down (+1, older) from the open episode, or open the newest when none is. */
  const walk = (by: number) => {
    const { episodes: list, active: open } = latest.current
    const from = list.findIndex(episode => episode.id === open)
    const index = clamp(from < 0 ? 0 : from + by, 0, list.length - 1)
    peek(null)
    magnify(yOf(index))
    latest.current.onSelect(list[index].id)
  }

  // The wheel needs a non-passive listener to keep the page (and the map under it) from zooming.
  useEffect(() => {
    const element = rail.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = state.current
      current.wheel += event.deltaY
      if (Math.abs(current.wheel) < NOTCH) return
      const by = Math.sign(current.wheel)
      current.wheel = 0
      walk(by)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  })

  const local = (event: React.PointerEvent) => event.clientY - rail.current!.getBoundingClientRect().top
  const settle = () => {
    magnify(null)
    peek(null)
  }

  const focused = preview ?? (activeIndex >= 0 ? activeIndex : null)
  const shown = focused === null ? null : episodes[focused]
  return (
    <div
      ref={rail}
      className={`episode-rail${preview !== null ? ' is-peeking' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="单集时间轴"
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={focused === null ? count : focused + 1}
      aria-valuetext={shown ? `${episodeLabel(shown)} ${shortTitle(shown)}` : '还没有打开单集'}
      onPointerMove={event => {
        const current = state.current
        current.pointer = event.pointerType
        if (event.pointerType !== 'mouse' && !current.dragging) return
        const y = local(event)
        magnify(y)
        peek(indexAt(y), true)
      }}
      onPointerDown={event => {
        const current = state.current
        current.pointer = event.pointerType
        if (event.pointerType === 'mouse') return
        event.currentTarget.setPointerCapture(event.pointerId)
        current.dragging = true
        const y = local(event)
        magnify(y)
        peek(indexAt(y))
        detent(event.pointerType)
      }}
      onPointerUp={event => {
        const current = state.current
        if (event.pointerType === 'mouse' && event.button !== 0) return
        const index = indexAt(local(event))
        if (current.dragging) {
          current.dragging = false
          settle()
        }
        onSelect(episodes[index].id)
      }}
      onPointerCancel={() => {
        state.current.dragging = false
        settle()
      }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') settle() }}
      onKeyDown={event => {
        const keys: Record<string, () => void> = {
          ArrowUp: () => walk(-1), ArrowLeft: () => walk(-1), ArrowDown: () => walk(1), ArrowRight: () => walk(1),
          Home: () => onSelect(episodes[0].id), End: () => onSelect(episodes[count - 1].id),
        }
        const run = keys[event.key]
        if (!run) return
        event.preventDefault()
        run()
      }}
      onBlur={settle}
    >
      {shownMonths.map(({ index, text }) => (
        <span key={index} className={`rail-month${text.includes('.') ? ' is-year' : ''}`} style={{ top: yOf(index) }} aria-hidden="true">{text}</span>
      ))}
      {episodes.map((episode, index) => (
        <span
          key={episode.id}
          ref={element => { ticks.current[index] = element }}
          className={`rail-tick${monthStarts.has(index) ? ' is-month' : ''}${index === activeIndex ? ' is-active' : ''}${
            index === preview ? ' is-preview' : ''}${marks.has(episode.id) ? ' is-marked' : ''}${episode.id === playing ? ' is-playing' : ''}`}
          style={{ top: yOf(index), '--mark': marks.get(episode.id) } as CSSProperties}
          aria-hidden="true"
        />
      ))}
      {shown && preview !== null && (
        <div className="rail-callout" style={{ top: yOf(preview) }} aria-hidden="true">
          <span className="rail-callout-meta">
            {episodeLabel(shown)} · {dayLabel(shown.publishedAt)}
            {starCount(shown.id) > 0 && ` · ${starCount(shown.id)} 个小主题`}
          </span>
          <span className="rail-callout-title">{shortTitle(shown)}</span>
        </div>
      )}
    </div>
  )
}
