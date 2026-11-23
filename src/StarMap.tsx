import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AtlasPath, Topic } from './domain'
import { SkyScene, type Point, type SkyFrame, type SkyNode } from './scene/SkyScene'

export type TopicPair = { key: string; from: string; to: string; paths: AtlasPath[] }

type MapProps = {
  topics: Topic[]
  pairs: TopicPair[]
  activeId: string
  episodeMarks: Map<string, string>
  reducedMotion: boolean
  onSelect: (id: string) => void
  onPair: (pair: TopicPair) => void
  card: ReactNode
}

const NARROW = 680

/** Topic positions (topics.json) → resting screen layout, tuned against the concept frame. */
function layoutNodes(topics: Topic[], narrow: boolean): SkyNode[] {
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
      x: narrow ? 0.16 + x * 0.66 : 0.155 + x * 0.625,
      y: narrow ? 0.12 + y * 0.42 : 0.09 + y * 0.59,
      depth: (uz(topic.position[2]) - 0.5) * 3,
      tint: topic.color,
    }
  })
}

type Rect = { left: number; top: number; right: number; bottom: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const cardSlot = { index: 0, active: '' }

/**
 * Put the card beside the focused star without covering any star label: prefer the
 * concept's upper-right slot, then a grid around the star, then beside the star's own
 * label. Only switch when another slot is clearly better, so the card does not jump
 * while the camera drifts. Slots beside the label carry no leader line.
 */
function placeCard(
  frame: SkyFrame, star: Point, card: HTMLElement, labels: Map<string, HTMLDivElement>, activeId: string, slot: { index: number; active: string },
) {
  const width = card.offsetWidth
  const height = card.offsetHeight
  const root = card.parentElement!.getBoundingClientRect()
  const boxes: Rect[] = []
  let own: Rect | undefined
  for (const [id, element] of labels) {
    const rect = element.querySelector('.star-label')!.getBoundingClientRect()
    const box = { left: rect.left - root.left - 8, top: rect.top - root.top - 8, right: rect.right - root.left + 8, bottom: rect.bottom - root.top + 8 }
    boxes.push(box)
    if (id === activeId) own = box
  }
  const lefts = [star.x + 64, star.x + 220, star.x - 64 - width, star.x - 220 - width, star.x - 40, star.x - width / 2]
  const tops = [star.y - 116 - height, star.y - 40 - height, star.y + 92, star.y + 170]
  const candidates = tops.flatMap((top, row) =>
    lefts.map((left, column) => ({ left, top, cost: (row + column * 1.5) * 900, leader: true })))
  if (own) {
    const right = Math.max(own.right, star.x + 20) + 12
    const left = Math.min(own.left, star.x - 20) - 12 - width
    for (const top of [star.y - height / 2, star.y - 40, star.y - height + 40]) {
      candidates.push({ left: right, top, cost: 5000, leader: false }, { left, top, cost: 6000, leader: false })
    }
  }
  const bounds = { left: 16, top: 76, right: frame.width - 16, bottom: frame.height - 96 }
  const score = (c: typeof candidates[number]) => {
    const box = { left: c.left, top: c.top, right: c.left + width, bottom: c.top + height }
    const outside = Math.max(0, bounds.left - box.left) + Math.max(0, box.right - bounds.right) +
      Math.max(0, bounds.top - box.top) + Math.max(0, box.bottom - bounds.bottom)
    const overlap = boxes.reduce((sum, label) => sum +
      Math.max(0, Math.min(box.right, label.right) - Math.max(box.left, label.left)) *
      Math.max(0, Math.min(box.bottom, label.bottom) - Math.max(box.top, label.top)), 0)
    return outside * 400 + overlap * 2 + c.cost
  }
  const scores = candidates.map(score)
  const best = scores.indexOf(Math.min(...scores))
  // Stick to the current slot while the same star stays focused, unless another is clearly better.
  if (slot.active !== activeId || scores[best] + 2500 < scores[slot.index]) slot.index = best
  slot.active = activeId
  const chosen = candidates[slot.index]
  // The leader meets the card on the edge facing the star, at the corner nearest to it.
  const above = chosen.top + height <= star.y
  const anchor = {
    x: clamp(star.x, chosen.left + 14, chosen.left + width - 14),
    y: above ? chosen.top + height - 14 : chosen.top + 14,
  }
  if (star.x <= chosen.left) anchor.x = chosen.left
  else if (star.x >= chosen.left + width) anchor.x = chosen.left + width
  return { left: chosen.left, top: chosen.top, anchor: chosen.leader ? anchor : null }
}

export function StarMap({ topics, pairs, activeId, episodeMarks, reducedMotion, onSelect, onPair, card }: MapProps) {
  const rootRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const leaderRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  const labelRefs = useRef(new Map<string, HTMLDivElement>())
  const pinRefs = useRef(new Map<string, HTMLButtonElement>())
  const sceneRef = useRef<SkyScene | null>(null)
  const latest = useRef({ activeId, onSelect, onPair, pairs })
  const lastFrame = useRef<SkyFrame | null>(null)
  const [webgl, setWebgl] = useState(true)
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW)
  const nodes = useMemo(() => layoutNodes(topics, narrow), [topics, narrow])
  latest.current = { activeId, onSelect, onPair, pairs }

  // Position the DOM overlay (labels, pins, card and its leader line) from projected star positions.
  const place = useRef((frame: SkyFrame) => {
    lastFrame.current = frame
    for (const [id, element] of labelRefs.current) {
      const point = frame.nodes.get(id)
      if (point) element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`
    }
    for (const [key, element] of pinRefs.current) {
      const point = frame.links.get(key)
      if (point) element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`
    }
    const star = frame.nodes.get(latest.current.activeId)
    const cardElement = cardRef.current
    if (!star || !cardElement) return
    if (frame.width < NARROW) {
      cardElement.style.transform = ''
      leaderRef.current?.setAttribute('d', '')
      dotRef.current?.setAttribute('r', '0')
      return
    }
    const { left, top, anchor } = placeCard(frame, star, cardElement, labelRefs.current, latest.current.activeId, cardSlot)
    cardElement.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
    if (!anchor) {
      leaderRef.current?.setAttribute('d', '')
      dotRef.current?.setAttribute('r', '0')
      return
    }
    const start = { x: star.x, y: star.y + (anchor.y < star.y ? -16 : 16) }
    const bend = anchor.y < star.y ? -1 : 1
    leaderRef.current?.setAttribute('d',
      `M${start.x} ${start.y} C${start.x} ${start.y + bend * 70} ${anchor.x - (anchor.x - start.x) * 0.55} ${anchor.y} ${anchor.x} ${anchor.y}`)
    dotRef.current?.setAttribute('cx', String(anchor.x))
    dotRef.current?.setAttribute('cy', String(anchor.y))
    dotRef.current?.setAttribute('r', '2.6')
  })

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const container = canvasRef.current
    if (!container || !SkyScene.supported()) {
      setWebgl(false)
      return
    }
    let scene: SkyScene
    try {
      scene = new SkyScene(container, {
        reducedMotion,
        onFrame: frame => place.current(frame),
        onStar: id => latest.current.onSelect(id),
        onLink: key => {
          const pair = latest.current.pairs.find(item => item.key === key)
          if (pair) latest.current.onPair(pair)
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

  useEffect(() => { sceneRef.current?.setNodes(nodes) }, [nodes])
  useEffect(() => { sceneRef.current?.setLinks(pairs.map(pair => ({ id: pair.key, from: pair.from, to: pair.to }))) }, [pairs])
  useEffect(() => {
    sceneRef.current?.setActive(activeId, pairs.filter(pair => pair.from === activeId || pair.to === activeId).map(pair => pair.key))
  }, [activeId, pairs])
  useEffect(() => { sceneRef.current?.setReducedMotion(reducedMotion) }, [reducedMotion])

  // Without WebGL, place the overlay at the resting layout so the map still works.
  useEffect(() => {
    if (webgl) return
    const root = rootRef.current
    if (!root) return
    const update = () => {
      const width = root.clientWidth
      const height = root.clientHeight
      place.current({
        width, height, links: new Map(),
        nodes: new Map(nodes.map(node => [node.id, { x: node.x * width, y: node.y * height }])),
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [webgl, nodes, activeId])

  // Re-place the card when its content changes size, between animation frames.
  useEffect(() => {
    const element = cardRef.current
    if (!element) return
    const observer = new ResizeObserver(() => { if (lastFrame.current) place.current(lastFrame.current) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const activePairs = pairs.filter(pair => pair.from === activeId || pair.to === activeId)
  const titles = new Map(topics.map(topic => [topic.id, topic.title]))

  return (
    <section ref={rootRef} className={`star-map${webgl ? '' : ' star-map--flat'}`} aria-label="主题星图">
      <div className="star-canvas" ref={canvasRef} aria-hidden="true" />
      <svg className="star-leader" aria-hidden="true">
        <path ref={leaderRef} />
        <circle ref={dotRef} r="0" />
      </svg>
      {topics.map(topic => {
        const active = topic.id === activeId
        const node = nodes.find(item => item.id === topic.id)!
        return (
          <div
            key={topic.id}
            ref={element => { if (element) labelRefs.current.set(topic.id, element); else labelRefs.current.delete(topic.id) }}
            className={`star-anchor${active ? ' is-active' : ''}${!narrow && node.x > 0.86 ? ' is-east' : ''}`}
          >
            <button className="star-label" type="button" aria-pressed={active} onClick={() => onSelect(topic.id)}>
              <span className="star-name">{topic.title}</span>
            </button>
            {episodeMarks.has(topic.id) && <span className="star-episode" aria-hidden="true">{episodeMarks.get(topic.id)}</span>}
          </div>
        )
      })}
      {activePairs.map(pair => {
        const other = titles.get(pair.from === activeId ? pair.to : pair.from)
        return (
          <button
            key={pair.key}
            className="path-pin"
            type="button"
            aria-label={`连到${other}：${pair.paths.length} 段`}
            ref={element => { if (element) pinRefs.current.set(pair.key, element); else pinRefs.current.delete(pair.key) }}
            onClick={() => onPair(pair)}
          >
            <span className="path-pin-dot" aria-hidden="true" />
            <span className="path-pin-tip">{pair.paths[0]?.label} · {other}</span>
          </button>
        )
      })}
      <div className="scene-card" ref={cardRef}>{card}</div>
    </section>
  )
}
