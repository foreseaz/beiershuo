import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Minus, Plus } from 'lucide-react'
import type { Topic } from './domain'
import { GalaxyScene, type GalaxyFrame, type Nebula, type Point, type SubStar, type Thread, type Travel } from './scene/GalaxyScene'

export type GalaxyStar = SubStar & { name: string }

type MapProps = {
  topics: Topic[]
  stars: GalaxyStar[]
  threads: Thread[]
  selected: string | null
  related: Set<string>
  current: string | null
  travel: Travel
  reducedMotion: boolean
  threadLabel: (id: string) => string
  onView: (nebula: string | null) => void
  onNebula: (id: string) => void
  onStar: (id: string) => void
  onThread: (id: string) => void
  onBack: () => void
  onOverview: () => void
  card: ReactNode
  cardFixed: boolean
}

const NARROW = 680
// A nebula's labels appear once it is this wide on screen (px radius), and its title steps aside when it fills the view.
const LABELS_FROM = 150
const TITLE_UNTIL = 420

/** Topic positions (topics.json) → nebula centres in the overview, spread to use the whole sky. */
function layoutNebulae(topics: Topic[], narrow: boolean): Nebula[] {
  const axis = (i: 0 | 1 | 2) => {
    const values = topics.map(topic => topic.position[i])
    const min = Math.min(...values)
    const span = Math.max(...values) - min || 1
    return (value: number) => (value - min) / span
  }
  const [ux, uy, uz] = [axis(0), axis(1), axis(2)]
  return topics.map(topic => {
    const x = ux(topic.position[0])
    const y = 1 - uy(topic.position[1])
    return {
      id: topic.id,
      x: narrow ? 0.2 + x * 0.6 : 0.16 + x * 0.66,
      y: narrow ? 0.16 + y * 0.52 : 0.15 + y * 0.64,
      depth: (uz(topic.position[2]) - 0.5) * 2.5,
      tint: topic.color,
    }
  })
}

type Rect = { left: number; top: number; right: number; bottom: number }
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

/** Put the card beside the selected star, on the side with the fewest labels under it. */
function placeCard(frame: GalaxyFrame, star: Point, size: { width: number; height: number }, obstacles: Rect[]) {
  const { width, height } = size
  const candidates = [
    { left: star.x + 40, top: star.y - height * 0.35 },
    { left: star.x + 40, top: star.y - height + 30 },
    { left: star.x + 40, top: star.y - 30 },
    { left: star.x - 40 - width, top: star.y - height * 0.35 },
    { left: star.x - 40 - width, top: star.y - height + 30 },
    { left: star.x - 40 - width, top: star.y - 30 },
  ]
  const bounds = { left: 16, top: 84, right: frame.width - 16, bottom: frame.height - 96 }
  const score = (c: { left: number; top: number }, index: number) => {
    const box = { left: c.left, top: c.top, right: c.left + width, bottom: c.top + height }
    const outside = Math.max(0, bounds.left - box.left) + Math.max(0, box.right - bounds.right) +
      Math.max(0, bounds.top - box.top) + Math.max(0, box.bottom - bounds.bottom)
    return outside * 600 + obstacles.reduce((sum, rect) => sum + overlap(box, rect), 0) + index * 400
  }
  const scores = candidates.map(score)
  const chosen = candidates[scores.indexOf(Math.min(...scores))]
  return {
    left: chosen.left, top: chosen.top,
    anchor: { x: chosen.left < star.x ? chosen.left + width : chosen.left, y: Math.min(Math.max(star.y, chosen.top + 18), chosen.top + height - 18) },
  }
}

export function StarMap(props: MapProps) {
  const { topics, stars, threads, selected, related, current, travel, reducedMotion, card, cardFixed } = props
  const canvasRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const leaderRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const nebulaRefs = useRef(new Map<string, HTMLButtonElement>())
  const starRefs = useRef(new Map<string, HTMLButtonElement>())
  const widths = useRef(new Map<string, number>())
  const shown = useRef(new Map<string, boolean>())
  const cardSize = useRef({ width: 340, height: 300 })
  const sceneRef = useRef<GalaxyScene | null>(null)
  const latest = useRef(props)
  const lastFrame = useRef<GalaxyFrame | null>(null)
  const [webgl, setWebgl] = useState(true)
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW)
  const nebulae = useMemo(() => layoutNebulae(topics, narrow), [topics, narrow])
  const parent = useMemo(() => new Map(stars.map(star => [star.id, star.nebula])), [stars])
  const parentRef = useRef(parent)
  latest.current = props
  parentRef.current = parent

  // Positions every overlay element from the projected scene, touching only transforms and, on change, classes.
  const place = useRef((frame: GalaxyFrame) => {
    lastFrame.current = frame
    const { selected: chosen, related: near, current: inside, cardFixed: fixed } = latest.current
    for (const [id, element] of nebulaRefs.current) {
      const point = frame.nebulae.get(id)
      if (!point) continue
      element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${(point.y - Math.min(point.radius * 0.62, 150)).toFixed(1)}px, 0)`
      const visible = point.radius < TITLE_UNTIL && id !== inside
      if (shown.current.get(`n:${id}`) !== visible) {
        shown.current.set(`n:${id}`, visible)
        element.dataset.hidden = visible ? '' : '1'
      }
    }
    const obstacles: Rect[] = []
    for (const [id, element] of starRefs.current) {
      const point = frame.stars.get(id)
      const nebula = frame.nebulae.get(parentRef.current.get(id) ?? '')
      const onScreen = point !== undefined && point.x > -80 && point.x < frame.width + 20 && point.y > -30 && point.y < frame.height + 30
      const visible = onScreen && (id === chosen || near.has(id) || (nebula !== undefined && nebula.radius > LABELS_FROM))
      if (shown.current.get(id) !== visible) {
        shown.current.set(id, visible)
        element.dataset.visible = visible ? '1' : ''
        element.tabIndex = visible ? 0 : -1
      }
      if (!point || !visible) continue
      element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`
      obstacles.push({ left: point.x - 8, top: point.y - 12, right: point.x + 14 + (widths.current.get(id) ?? 60), bottom: point.y + 12 })
    }
    const cardElement = cardRef.current
    const star = chosen ? frame.stars.get(chosen) : undefined
    if (!cardElement || fixed || !star || frame.width < NARROW) {
      if (cardElement) cardElement.style.transform = ''
      leaderRef.current?.setAttribute('d', '')
      dotRef.current?.setAttribute('r', '0')
      return
    }
    const { left, top, anchor } = placeCard(frame, star, cardSize.current, obstacles)
    cardElement.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
    const bend = (anchor.x - star.x) * 0.5
    leaderRef.current?.setAttribute('d', `M${star.x} ${star.y} C${star.x + bend} ${star.y} ${anchor.x - bend} ${anchor.y} ${anchor.x} ${anchor.y}`)
    dotRef.current?.setAttribute('cx', String(anchor.x))
    dotRef.current?.setAttribute('cy', String(anchor.y))
    dotRef.current?.setAttribute('r', '2.2')
  })

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const container = canvasRef.current
    if (!container || !GalaxyScene.supported()) {
      setWebgl(false)
      return
    }
    let scene: GalaxyScene
    try {
      scene = new GalaxyScene(container, {
        reducedMotion,
        onFrame: frame => place.current(frame),
        onNebula: id => latest.current.onNebula(id),
        onStar: id => latest.current.onStar(id),
        onThread: id => latest.current.onThread(id),
        onView: id => latest.current.onView(id),
        onEmpty: () => latest.current.onBack(),
        onHover: hover => {
          const tip = tipRef.current
          if (!tip) return
          if (!hover) { tip.classList.remove('is-visible'); return }
          tip.textContent = latest.current.threadLabel(hover.thread)
          tip.style.transform = `translate3d(${hover.x + 14}px, ${hover.y + 14}px, 0)`
          tip.classList.add('is-visible')
        },
      })
    } catch {
      setWebgl(false)
      return
    }
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
    // The scene is created once; later prop changes are pushed through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { sceneRef.current?.setGalaxy(nebulae, stars, threads) }, [nebulae, stars, threads])
  useEffect(() => { sceneRef.current?.setSelection(selected, related) }, [selected, related])
  useEffect(() => { sceneRef.current?.travel(travel) }, [travel, stars])
  useEffect(() => { sceneRef.current?.setReducedMotion(reducedMotion) }, [reducedMotion])
  useEffect(() => { if (lastFrame.current) place.current(lastFrame.current) }, [selected, related, current, cardFixed])

  // Measure label widths once (after the web font loads), never inside the frame loop.
  useEffect(() => {
    const measure = () => {
      for (const [id, element] of starRefs.current) widths.current.set(id, element.offsetWidth)
    }
    measure()
    void document.fonts?.ready.then(measure)
  }, [stars])

  useEffect(() => {
    const element = cardRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      cardSize.current = { width: element.offsetWidth, height: element.offsetHeight }
      if (lastFrame.current) place.current(lastFrame.current)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const focused = topics.find(topic => topic.id === current)
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const star of stars) result.set(star.nebula, (result.get(star.nebula) ?? 0) + 1)
    return result
  }, [stars])

  const zoom = (factor: number) => {
    const canvas = canvasRef.current?.querySelector('canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: Math.log(factor) / 0.0016, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, cancelable: true,
    }))
  }

  return (
    <section className={`galaxy${current ? ' is-focused' : ''}${webgl ? '' : ' galaxy--flat'}`} aria-label="主题星图">
      <div className="star-canvas" ref={canvasRef} aria-hidden="true" />
      <svg className="star-leader" aria-hidden="true">
        <path ref={leaderRef} />
        <circle ref={dotRef} r="0" />
      </svg>
      {topics.map(topic => (
        <button
          key={topic.id}
          ref={element => { if (element) nebulaRefs.current.set(topic.id, element); else nebulaRefs.current.delete(topic.id) }}
          className="nebula-label"
          style={{ '--tint': topic.color } as React.CSSProperties}
          type="button"
          onClick={() => props.onNebula(topic.id)}
        >
          <span className="nebula-title">{topic.title}</span>
          <span className="nebula-meta">{counts.get(topic.id) ?? 0} 个小主题</span>
        </button>
      ))}
      {stars.map(star => (
        <button
          key={star.id}
          ref={element => { if (element) starRefs.current.set(star.id, element); else starRefs.current.delete(star.id) }}
          className={`star-tag${star.id === selected ? ' is-selected' : ''}${related.has(star.id) ? ' is-related' : ''}${star.nebula === current ? '' : ' is-away'}`}
          style={{ '--tint': topics.find(topic => topic.id === star.nebula)?.color } as React.CSSProperties}
          type="button"
          tabIndex={-1}
          onClick={() => props.onStar(star.id)}
        >
          {star.name}
        </button>
      ))}
      <div className="thread-tip" ref={tipRef} aria-hidden="true" />
      {focused && (
        <div className="galaxy-crumb">
          <button type="button" onClick={props.onOverview}><ArrowLeft size={14} aria-hidden="true" /> 全部主题</button>
          <p className="galaxy-crumb-title" style={{ '--tint': focused.color } as React.CSSProperties}>{focused.title}</p>
          <p className="galaxy-crumb-note">{focused.description}</p>
        </div>
      )}
      {webgl && (
        <div className="zoom-controls" aria-label="缩放">
          <button type="button" aria-label="放大" onClick={() => zoom(0.7)}><Plus size={15} aria-hidden="true" /></button>
          <button type="button" aria-label="缩小" onClick={() => zoom(1.4)}><Minus size={15} aria-hidden="true" /></button>
        </div>
      )}
      <div className={`scene-card${cardFixed ? ' is-fixed' : ''}${card ? '' : ' is-empty'}`} ref={cardRef}>{card}</div>
    </section>
  )
}
