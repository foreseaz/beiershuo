import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react'
import type { Topic } from './domain'
import { GalaxyScene, type GalaxyFrame, type Nebula, type SubStar, type Thread, type Travel } from './scene/GalaxyScene'

export type GalaxyStar = SubStar & { name: string }

type MapProps = {
  topics: Topic[]
  stars: GalaxyStar[]
  threads: Thread[]
  selected: string | null
  related: Set<string>
  /** The highlighted episode and the sub-topics it mentions, or null. */
  episode: { id: string; stars: Set<string> } | null
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
  /** Changes whenever a different card opens, so a collapsed drawer opens again for new content. */
  cardKey: string
  /** Open new cards collapsed to their heading (an episode's card on a phone, so its constellation shows above it). */
  peek?: boolean
}

const NARROW = 680
/** A screen noticeably taller than wide (a phone, a tablet held upright) gets the ring turned top to bottom. */
const isPortrait = () => window.innerHeight > window.innerWidth * 1.05
const isTouch = () => window.matchMedia('(pointer: coarse)').matches
const DEPTH_KEY = 'beiershuo:depth'

/** The 2D/3D choice is a per-browser convenience; storage can be missing or blocked, so every access is guarded. */
function readDepth() {
  try { return window.localStorage.getItem(DEPTH_KEY) === '1' } catch { return false }
}
function saveDepth(deep: boolean) {
  try { window.localStorage.setItem(DEPTH_KEY, deep ? '1' : '0') } catch { /* nothing to keep it in */ }
}
// Sub-topic labels come in as their nebula grows on screen (radius in px at a 900px-tall view): its strongest
// few in the overview, more as the camera nears, all of them from LABELS_FROM. The title steps aside at TITLE_UNTIL.
const OVERVIEW_RADIUS = 140
const OVERVIEW_LABELS = 4
const LABELS_FROM = 240
const TITLE_UNTIL = 420

type Box = { left: number; top: number; right: number; bottom: number }
const overlaps = (a: Box, b: Box) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
const grow = (box: Box, by: number): Box => ({ left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by })

/**
 * How many of a nebula's labels show while nothing is hovered, strongest first. A nebula smaller than the desktop
 * overview's (a phone's pulled-back overview) gets fewer, by its area, so the first view is mostly sky.
 */
function labelBudget(radius: number) {
  if (radius >= LABELS_FROM) return Infinity
  if (radius < OVERVIEW_RADIUS) return OVERVIEW_LABELS * (radius / OVERVIEW_RADIUS) ** 2
  return OVERVIEW_LABELS + (radius - OVERVIEW_RADIUS) * ((18 - OVERVIEW_LABELS) / (LABELS_FROM - OVERVIEW_RADIUS))
}

/**
 * A label's font size and its gap from the star, in px. Mirrors the .star-tag rule in styles.css: it depends on how
 * connected the sub-topic is (w) and how close the camera is (z), never on hover, so a label never jumps.
 */
function labelMetrics(w: number, z: number) {
  return { size: 9.5 + 3 * w + z * (1.5 + 3 * w), gap: 5 + 4 * w + z * (3 + 5 * w) }
}

/**
 * Topic positions (topics.json) → nebula centres in the overview, spread to use the whole sky. The most connected
 * topic sits in the middle with the rest in a ring; a portrait screen turns the ring a quarter so it runs top to bottom.
 */
export function layoutNebulae(topics: Topic[], portrait: boolean): Nebula[] {
  const axis = (i: 0 | 1 | 2) => {
    const values = topics.map(topic => topic.position[i])
    const min = Math.min(...values)
    const span = Math.max(...values) - min || 1
    return (value: number) => (value - min) / span
  }
  const [ux, uy, uz] = [axis(0), axis(1), axis(2)]
  return topics.map(topic => {
    const across = ux(topic.position[0])
    const up = uy(topic.position[1])
    return {
      id: topic.id,
      // Upright, the ring runs from just under the top bar to just above the browser's bottom toolbar.
      x: portrait ? 0.21 + up * 0.58 : 0.2 + across * 0.6,
      y: portrait ? 0.235 + across * 0.585 : 0.2 + (1 - up) * 0.62,
      depth: (uz(topic.position[2]) - 0.5) * 2.5,
      tint: topic.color,
    }
  })
}

export function StarMap(props: MapProps) {
  const { topics, stars, threads, selected, related, episode, current, travel, reducedMotion, card, cardKey } = props
  const canvasRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const leaderRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const nebulaRefs = useRef(new Map<string, HTMLButtonElement>())
  const starRefs = useRef(new Map<string, HTMLButtonElement>())
  const sectionRef = useRef<HTMLElement>(null)
  // Label width per px of font size, measured once; with labelMetrics it gives every label's box without layout reads.
  const perPx = useRef(new Map<string, number>())
  const shown = useRef(new Map<string, boolean>())
  const labelState = useRef(new Map<string, string>())
  const boxes = useRef(new Map<string, Box>())
  // The resting labels last shown; they keep their places so the slow camera drift never makes labels blink.
  const resting = useRef(new Set<string>())
  const zoomStep = useRef(-1)
  const hoverStar = useRef<string | null>(null)
  const drawerBox = useRef<{ left: number; top: number } | null>(null)
  // The person's own collapse or expand holds until a different card opens, which starts as `peek` says.
  const [toggled, setToggled] = useState<{ key: string; collapsed: boolean } | null>(null)
  const collapsed = toggled?.key === cardKey ? toggled.collapsed : !!props.peek
  const [deep, setDeep] = useState(readDepth)
  const [hint, setHint] = useState(false)
  const sceneRef = useRef<GalaxyScene | null>(null)
  const latest = useRef(props)
  const lastFrame = useRef<GalaxyFrame | null>(null)
  const [webgl, setWebgl] = useState(true)
  const [portrait, setPortrait] = useState(isPortrait)
  const portraitRef = useRef(portrait)
  portraitRef.current = portrait
  const nebulae = useMemo(() => layoutNebulae(topics, portrait), [topics, portrait])
  const parent = useMemo(() => new Map(stars.map(star => [star.id, star.nebula])), [stars])
  const parentRef = useRef(parent)
  // Each star's rank inside its nebula by connections: the label budget is spent strongest first.
  const rank = useMemo(() => {
    const byNebula = new Map<string, GalaxyStar[]>()
    for (const star of stars) byNebula.set(star.nebula, [...(byNebula.get(star.nebula) ?? []), star])
    return new Map([...byNebula.values()].flatMap(list => [...list].sort((a, b) => b.weight - a.weight).map((star, index) => [star.id, index] as const)))
  }, [stars])
  const rankRef = useRef(rank)
  rankRef.current = rank
  const weightRef = useRef(new Map<string, number>())
  weightRef.current = new Map(stars.map(star => [star.id, star.weight]))
  // Which sub-topics each star's lines reach, for labelling them while it is hovered.
  const partnersOf = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const thread of threads) {
      result.set(thread.from, (result.get(thread.from) ?? new Set()).add(thread.to))
      result.set(thread.to, (result.get(thread.to) ?? new Set()).add(thread.from))
    }
    return result
  }, [threads])
  const partnersRef = useRef(partnersOf)
  latest.current = props
  parentRef.current = parent
  partnersRef.current = partnersOf

  /*
   * Which labels show, by one rule:
   *  - Hovering a star (or its label) shows that star and the sub-topics its lines reach, and nothing else.
   *  - Otherwise a selected star shows with the sub-topics it reaches; the rest stay faint.
   *  - At rest each nebula shows its best-connected labels, more as the camera nears, never two overlapping.
   * Size depends only on connections and zoom, so showing, hovering or selecting never moves a label.
   */
  const place = useRef((frame: GalaxyFrame) => {
    lastFrame.current = frame
    const { selected: chosen, related: linked, current: inside, episode } = latest.current
    const lit = episode?.stars
    const hovered = hoverStar.current
    const reach = hovered ? partnersRef.current.get(hovered) : undefined
    const section = sectionRef.current
    const z = Math.round(frame.zoom * 20) / 20
    if (z !== zoomStep.current) {
      zoomStep.current = z
      section?.style.setProperty('--z', String(z))
    }
    if (section && section.dataset.hovering !== (hovered ? '1' : '')) section.dataset.hovering = hovered ? '1' : ''
    const scale = 900 / Math.max(frame.height, 1)
    const taken: Box[] = []
    for (const [id, element] of nebulaRefs.current) {
      const point = frame.nebulae.get(id)
      if (!point) {
        // Behind the camera in 3D.
        if (shown.current.get(`n:${id}`) !== false) {
          shown.current.set(`n:${id}`, false)
          element.dataset.hidden = '1'
        }
        continue
      }
      // On an upright screen the ring is tighter, so a title sits nearer its own nebula's heart.
      const top = point.y - Math.min(point.radius * (portraitRef.current ? 0.6 : 0.95), 190)
      element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
      const visible = point.radius < TITLE_UNTIL && id !== inside
      if (shown.current.get(`n:${id}`) !== visible) {
        shown.current.set(`n:${id}`, visible)
        element.dataset.hidden = visible ? '' : '1'
      }
      if (visible) taken.push({ left: point.x - 60, top: top - 22, right: point.x + 60, bottom: top + 22 })
    }
    const boxOf = (id: string, point: { x: number; y: number }): Box & { side: '' | 'l' } => {
      const { size, gap } = labelMetrics(weightRef.current.get(id) ?? 0.5, z)
      const width = (perPx.current.get(id) ?? 4) * size + 6
      const top = point.y - size * 0.65
      const bottom = top + size * 1.2 + 2
      // A label that would run off the right edge turns to its star's left instead.
      if (point.x + gap + width > frame.width - 4 && point.x - gap - width >= 4) return { left: point.x - gap - width, top, right: point.x - gap, bottom, side: 'l' }
      return { left: point.x + gap, top, right: point.x + gap + width, bottom, side: '' }
    }
    const decided = new Map<string, { show: '' | '1' | 'dim'; tone: '' | 'lit' | 'near'; point?: { x: number; y: number }; side?: '' | 'l' }>()
    const candidates: { id: string; point: { x: number; y: number }; box: ReturnType<typeof boxOf> }[] = []
    boxes.current.clear()
    for (const id of starRefs.current.keys()) {
      const point = frame.stars.get(id)
      const onScreen = point !== undefined && point.x > -80 && point.x < frame.width + 20 && point.y > -30 && point.y < frame.height + 30
      if (!point || !onScreen) { decided.set(id, { show: '', tone: '' }); continue }
      if (hovered) {
        if (id === hovered || id === chosen) decided.set(id, { show: '1', tone: 'lit', point })
        else if (reach?.has(id)) decided.set(id, { show: '1', tone: 'near', point })
        else decided.set(id, { show: '', tone: '', point })
      } else if (id === chosen) {
        decided.set(id, { show: '1', tone: 'lit', point })
      } else if (linked.has(id)) {
        decided.set(id, { show: '1', tone: 'near', point })
      } else if (lit?.has(id)) {
        decided.set(id, { show: '1', tone: 'lit', point })
      } else {
        const nebula = frame.nebulae.get(parentRef.current.get(id) ?? '')
        const budget = nebula ? labelBudget(nebula.radius * scale) : 0
        decided.set(id, { show: '', tone: '', point })
        // Resting labels only show whole: one cut by the screen edge reads as noise.
        const box = boxOf(id, point)
        if ((rankRef.current.get(id) ?? Infinity) < budget && box.left >= 0 && box.right <= frame.width) candidates.push({ id, point, box })
      }
    }
    // Labels that must show claim their space first; resting labels fill what is left. Those already showing go
    // first and tolerate a slight overlap, new ones need a little clearance: together that stops labels blinking.
    for (const [id, state] of decided) {
      if (!state.show || !state.point) continue
      const box = boxOf(id, state.point)
      state.side = box.side
      taken.push(box)
      boxes.current.set(id, box)
    }
    if (!hovered) {
      const before = resting.current
      candidates.sort((a, b) => Number(before.has(b.id)) - Number(before.has(a.id))
        || (weightRef.current.get(b.id) ?? 0) - (weightRef.current.get(a.id) ?? 0))
      const kept = new Set<string>()
      for (const { id, point, box } of candidates) {
        const test = grow(box, before.has(id) ? -4 : 4)
        if (taken.some(other => overlaps(test, other))) continue
        taken.push(box)
        boxes.current.set(id, box)
        kept.add(id)
        decided.set(id, { show: chosen || lit ? 'dim' : '1', tone: '', point, side: box.side })
      }
      resting.current = kept
    }
    for (const [id, { show, tone, point, side }] of decided) {
      const element = starRefs.current.get(id)
      if (!element) continue
      if (show && element.dataset.side !== side) element.dataset.side = side ?? ''
      const key = `${show}|${tone}`
      const before = labelState.current.get(id)
      // Keep a label tracking its star while it fades out, then stop touching it.
      if (point && (show || (before && !before.startsWith('|')))) {
        element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`
      }
      if (before === key) continue
      labelState.current.set(id, key)
      element.dataset.show = show
      element.dataset.tone = tone
      element.tabIndex = show ? 0 : -1
    }
    // A thin leader from the selected star to the docked drawer keeps the two connected.
    const star = chosen ? frame.stars.get(chosen) : undefined
    const box = drawerBox.current
    if (!star || !box || frame.width < NARROW || star.x > box.left - 24) {
      leaderRef.current?.setAttribute('d', '')
      dotRef.current?.setAttribute('r', '0')
      return
    }
    const anchor = { x: box.left, y: box.top + 34 }
    const bend = (anchor.x - star.x) * 0.5
    leaderRef.current?.setAttribute('d', `M${star.x} ${star.y} C${star.x + bend} ${star.y} ${anchor.x - bend} ${anchor.y} ${anchor.x} ${anchor.y}`)
    dotRef.current?.setAttribute('cx', String(anchor.x))
    dotRef.current?.setAttribute('cy', String(anchor.y))
    dotRef.current?.setAttribute('r', '2.2')
  })

  useEffect(() => {
    const onResize = () => setPortrait(isPortrait())
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
        deep,
        onFrame: frame => place.current(frame),
        onNebula: id => latest.current.onNebula(id),
        onStar: id => latest.current.onStar(id),
        onThread: id => latest.current.onThread(id),
        onView: id => latest.current.onView(id),
        onEmpty: () => latest.current.onBack(),
        labelAt: (x, y) => {
          for (const [id, box] of boxes.current) {
            if (x >= box.left - 2 && x <= box.right + 2 && y >= box.top - 2 && y <= box.bottom + 2) return id
          }
          return null
        },
        onHoverStar: id => {
          hoverStar.current = id
          if (lastFrame.current) place.current(lastFrame.current)
        },
        onGesture: active => { if (cardRef.current) cardRef.current.dataset.gesture = active ? '1' : '' },
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
  useEffect(() => { sceneRef.current?.setEpisode(episode?.id ?? null, episode?.stars ?? new Set()) }, [episode])
  // A trip that frames stars keeps them clear of the card sheet along the bottom of the sky.
  useEffect(() => {
    const aside = cardRef.current
    const sky = canvasRef.current
    const below = aside?.offsetHeight && sky ? Math.max(0, sky.getBoundingClientRect().bottom - aside.getBoundingClientRect().top) : 0
    sceneRef.current?.travel({ ...travel, below })
  }, [travel, stars])
  // The card's height, for what is laid out around it (the episode rail stops above the sheet on a phone).
  useEffect(() => {
    const aside = cardRef.current
    if (!aside) return
    const root = document.documentElement
    const observer = new ResizeObserver(() => root.style.setProperty('--drawer-height', `${aside.offsetHeight}px`))
    observer.observe(aside)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--drawer-height')
    }
  }, [])
  useEffect(() => { sceneRef.current?.setReducedMotion(reducedMotion) }, [reducedMotion])

  const toggleDepth = () => {
    const next = !deep
    setDeep(next)
    saveDepth(next)
    sceneRef.current?.setDepth(next)
    setHint(next)
  }
  // The controls hint shows for a few seconds after switching to 3D.
  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(false), 4500)
    return () => window.clearTimeout(timer)
  }, [hint])
  useEffect(() => { if (lastFrame.current) place.current(lastFrame.current) }, [selected, related, episode, current, card])

  // Measure label widths once (after the web font loads), never inside the frame loop. Width scales with font
  // size (letter spacing is in em), so one measurement per label covers every zoom.
  useEffect(() => {
    const measure = () => {
      for (const [id, element] of starRefs.current) {
        const size = parseFloat(getComputedStyle(element).fontSize) || 12
        perPx.current.set(id, Math.max(0, element.offsetWidth - 6) / size)
      }
    }
    measure()
    void document.fonts?.ready.then(measure)
  }, [stars])

  // The drawer's position is read when it resizes, not in the frame loop.
  useEffect(() => {
    const element = cardRef.current
    if (!element) return
    const read = () => {
      const rect = element.getBoundingClientRect()
      drawerBox.current = rect.width ? { left: rect.left, top: rect.top } : null
      if (lastFrame.current) place.current(lastFrame.current)
    }
    const observer = new ResizeObserver(read)
    observer.observe(element)
    window.addEventListener('resize', read)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', read)
    }
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
    <section ref={sectionRef} className={`galaxy${current ? ' is-focused' : ''}${webgl ? '' : ' galaxy--flat'}`} aria-label="主题星图">
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
          className="star-tag"
          style={{ '--tint': topics.find(topic => topic.id === star.nebula)?.color, '--w': star.weight.toFixed(2) } as React.CSSProperties}
          type="button"
          tabIndex={-1}
          onClick={() => props.onStar(star.id)}
          onFocus={() => sceneRef.current?.setHoverStar(star.id)}
          onBlur={() => sceneRef.current?.setHoverStar(null)}
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
        <div className="zoom-controls" aria-label="视图">
          <button className="depth-toggle" type="button" aria-pressed={deep} onClick={toggleDepth}
            title={deep ? '回到平面星图' : '立体星图：拖动旋转'} aria-label={deep ? '切换到平面视图' : '切换到立体视图'}>
            3D
          </button>
          <button className="zoom-step" type="button" aria-label="放大" onClick={() => zoom(0.7)}><Plus size={15} aria-hidden="true" /></button>
          <button className="zoom-step" type="button" aria-label="缩小" onClick={() => zoom(1.4)}><Minus size={15} aria-hidden="true" /></button>
        </div>
      )}
      {webgl && (
        <p className={`depth-hint${hint ? ' is-visible' : ''}`} aria-live="polite">
          {hint ? (isTouch() ? '单指旋转 · 双指缩放和移动' : '拖动旋转 · Shift + 拖动平移 · 滚轮缩放') : ''}
        </p>
      )}
      <aside className={`info-drawer${card ? '' : ' is-empty'}${collapsed ? ' is-collapsed' : ''}`} ref={cardRef} aria-label="详情">
        {card && (
          <button className="drawer-toggle icon-button" type="button" onClick={() => setToggled({ key: cardKey, collapsed: !collapsed })}
            aria-expanded={!collapsed} aria-label={collapsed ? '展开' : '收起'}>
            {collapsed ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
          </button>
        )}
        {card}
      </aside>
    </section>
  )
}
