import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as THREE from 'three'
import type { AtlasPath, Topic } from './domain'

type MapProps = {
  topics: Topic[]
  paths: AtlasPath[]
  activeId: string
  episodeMarks: Map<string, string>
  onSelect: (id: string) => void
  onPath: (path: AtlasPath) => void
  card: ReactNode
}

type Point = { x: number; y: number }
type TopicPoint = Point & { depth: number }

function normalizeTopics(topics: Topic[]) {
  const axes = [0, 1, 2].map(axis => topics.map(topic => topic.position[axis]))
  const minimums = axes.map(axis => Math.min(...axis))
  const maximums = axes.map(axis => Math.max(...axis))
  const unit = (value: number, axis: number) => {
    const span = maximums[axis] - minimums[axis]
    return span ? (value - minimums[axis]) / span : 0.5
  }

  return new Map(topics.map(topic => [topic.id, {
    x: unit(topic.position[0], 0),
    y: 1 - unit(topic.position[1], 1),
    depth: (unit(topic.position[2], 2) - 0.5) * 4,
  }]))
}

function fittedPoint(point: Point, narrow = false): Point {
  return narrow
    ? { x: 0.19 + point.x * 0.62, y: 0.23 + point.y * 0.43 }
    : { x: 0.15 + point.x * 0.62, y: 0.24 + point.y * 0.46 }
}

function seededRandom() {
  let seed = 53221
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

function makeTexture(kind: 'glow' | 'spikes' | 'speck') {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas context')
  const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)

  if (kind === 'glow') {
    glow.addColorStop(0, 'rgba(255,255,255,1)')
    glow.addColorStop(0.10, 'rgba(255,255,255,.67)')
    glow.addColorStop(0.31, 'rgba(255,255,255,.2)')
    glow.addColorStop(0.64, 'rgba(255,255,255,.035)')
  } else {
    glow.addColorStop(0, 'rgba(255,255,255,1)')
    glow.addColorStop(0.07, 'rgba(255,255,255,1)')
    glow.addColorStop(0.15, 'rgba(255,255,255,.28)')
    glow.addColorStop(0.45, 'rgba(255,255,255,.035)')
  }

  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 128, 128)

  if (kind === 'spikes') {
    ctx.translate(64, 64)
    ctx.globalCompositeOperation = 'screen'
    for (let index = 0; index < 8; index += 1) {
      const length = index % 2 === 0 ? 60 : 43
      const beam = ctx.createLinearGradient(0, 0, length, 0)
      beam.addColorStop(0, 'rgba(255,255,255,.94)')
      beam.addColorStop(0.34, 'rgba(255,255,255,.6)')
      beam.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = beam
      ctx.beginPath()
      ctx.moveTo(-3, -2.5)
      ctx.quadraticCurveTo(10, -1, length, 0)
      ctx.quadraticCurveTo(10, 1, -3, 2.5)
      ctx.fill()
      ctx.rotate(Math.PI / 4)
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function sprite(texture: THREE.Texture, color: THREE.ColorRepresentation, opacity = 1) {
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, color, opacity, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }))
}

function makeSky(texture: THREE.Texture, size: number, count: number, band: boolean) {
  const random = seededRandom()
  const positions: number[] = []
  const colors: number[] = []
  for (let index = 0; index < count; index += 1) {
    const x = (random() - 0.5) * 65
    const y = band
      ? x * 0.32 - 7.2 + (random() + random() + random() - 1.5) * 3.5
      : (random() - 0.5) * 43
    positions.push(x, y, -8 - random() * 14)
    const light = band ? 0.22 + random() * 0.30 : 0.35 + random() * 0.55
    const color = new THREE.Color(random() > 0.27 ? '#bac8ff' : '#e7b993').multiplyScalar(light)
    colors.push(color.r, color.g, color.b)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    map: texture, size, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
}

function pathCurve(start: THREE.Vector3, end: THREE.Vector3, index: number) {
  const delta = end.clone().sub(start)
  const curve = Math.min(delta.length() * 0.24, 1.6) * (index % 2 === 0 ? -1 : 1)
  const controlA = start.clone().addScaledVector(delta, 0.35).add(new THREE.Vector3(0, curve, 1.2))
  const controlB = start.clone().addScaledVector(delta, 0.66).add(new THREE.Vector3(0, curve, 1.2))
  return new THREE.CubicBezierCurve3(start, controlA, controlB, end)
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const x = end.x - start.x
  const y = end.y - start.y
  const lengthSquared = x * x + y * y
  const t = lengthSquared ? THREE.MathUtils.clamp(((point.x - start.x) * x + (point.y - start.y) * y) / lengthSquared, 0, 1) : 0
  return Math.hypot(point.x - start.x - t * x, point.y - start.y - t * y)
}

export function StarMap({ topics, paths, activeId, episodeMarks, onSelect, onPath, card }: MapProps) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const topicRefs = useRef(new Map<string, HTMLDivElement>())
  const pathRefs = useRef(new Map<string, HTMLButtonElement>())
  const selection = useRef({ activeId, onPath })
  const [hasWebGl, setHasWebGl] = useState(false)
  const points = useMemo(() => normalizeTopics(topics), [topics])
  const renderedPaths = useMemo(() => {
    const pairs = new Set<string>()
    return paths.filter(path => {
      if (path.sourceTopicId === path.targetTopicId || !points.has(path.sourceTopicId) || !points.has(path.targetTopicId)) return false
      const pair = [path.sourceTopicId, path.targetTopicId].sort().join('|')
      if (pairs.has(pair)) return false
      pairs.add(pair)
      return true
    })
  }, [paths, points])

  useEffect(() => {
    selection.current = { activeId, onPath }
  }, [activeId, onPath])

  useEffect(() => {
    const container = sceneRef.current
    if (!container) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    } catch {
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65))
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(41, 1, 0.1, 110)
    const glow = makeTexture('glow')
    const spikes = makeTexture('spikes')
    const speck = makeTexture('speck')
    scene.add(makeSky(speck, 0.09, 2700, true), makeSky(speck, 0.095, 1150, false), makeSky(speck, 0.22, 75, false))
    const nodes = topics.map(topic => {
      const group = new THREE.Group()
      const color = new THREE.Color(topic.color)
      const halo = sprite(glow, color, 0.63)
      const flare = sprite(spikes, '#ffe7c9', 1)
      const core = sprite(glow, '#fff3e6')
      group.add(halo, flare, core)
      scene.add(group)
      return { id: topic.id, location: points.get(topic.id)!, group, halo, flare, core, color }
    })
    const nodeIndex = new Map(nodes.map(node => [node.id, node]))
    const wires = renderedPaths.map(path => {
      const geometry = new THREE.BufferGeometry()
      const material = new THREE.LineBasicMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      })
      const line = new THREE.Line(geometry, material)
      scene.add(line)
      return { path, geometry, material, line, projected: [] as Point[] }
    })
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const target = new THREE.Vector2()
    const current = new THREE.Vector2()
    const focusX = new THREE.Vector2()
    const center = new THREE.Vector3()
    const projectPosition = new THREE.Vector3()
    let width = 1
    let height = 1
    let frame = 0
    let lastActive = ''
    let dragging = false
    let dragged = false
    const pointerDown = new THREE.Vector2()
    const dragStart = new THREE.Vector2()
    let dirty = true
    let inView = true

    function project(position: THREE.Vector3): Point {
      projectPosition.copy(position).project(camera)
      return { x: (projectPosition.x + 1) * width * 0.5, y: (1 - projectPosition.y) * height * 0.5 }
    }

    function resize() {
      if (!container) return
      width = Math.max(1, container.clientWidth)
      height = Math.max(1, container.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      const narrow = width < 680
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)
      for (const node of nodes) {
        const fit = fittedPoint(node.location, narrow)
        const halfHeight = (19 - node.location.depth) * tangent
        node.group.position.set((fit.x * 2 - 1) * halfHeight * camera.aspect, (1 - fit.y * 2) * halfHeight, node.location.depth)
      }
      wires.forEach((wire, index) => {
        const start = nodeIndex.get(wire.path.sourceTopicId)!.group.position
        const end = nodeIndex.get(wire.path.targetTopicId)!.group.position
        const samples = pathCurve(start, end, index).getPoints(56)
        wire.geometry.setFromPoints(samples)
        wire.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(samples.length * 3), 3))
        wire.geometry.computeBoundingSphere()
      })
      dirty = true
      requestFrame()
    }

    function requestFrame() {
      if (!frame && inView) frame = window.requestAnimationFrame(draw)
    }

    function draw() {
      frame = 0
      const id = selection.current.activeId
      const active = nodeIndex.get(id)
      const next = active?.location
      if (lastActive !== id) {
        focusX.y = mediaQuery.matches || width < 680 ? 0 : ((next?.x ?? 0.5) - 0.5) * 0.65
        dirty = true
      }
      const rate = mediaQuery.matches ? 1 : 0.095
      current.lerp(target, rate)
      focusX.x += (focusX.y - focusX.x) * rate
      const easing = current.distanceToSquared(target) > 0.000005 || Math.abs(focusX.y - focusX.x) > 0.002

      if (dirty || easing) {
        camera.position.set(current.x + focusX.x, current.y, 19)
        center.set(focusX.x * 0.12, 0, 0)
        camera.lookAt(center)
        camera.updateMatrixWorld()

        for (const node of nodes) {
          const selected = node.id === id
          const color = selected ? '#6480ff' : node.color
          const scale = (width < 680 ? 0.81 : 1) * (selected ? 1.42 : 1)
          node.halo.material.color.set(color)
          node.halo.material.opacity = selected ? 0.85 : 0.64
          node.halo.scale.setScalar(2.75 * scale)
          node.flare.scale.setScalar(1.15 * scale)
          node.flare.material.color.set(selected ? '#b8c7ff' : '#ffddbd')
          node.core.scale.setScalar(0.37 * scale)
          const point = project(node.group.position)
          const label = topicRefs.current.get(node.id)
          label?.style.setProperty('left', `${point.x}px`)
          label?.style.setProperty('top', `${point.y}px`)
          if (selected) {
            cardRef.current?.style.setProperty('--anchor-x', `${point.x}px`)
            cardRef.current?.style.setProperty('--anchor-y', `${point.y}px`)
          }
        }

        for (const wire of wires) {
          const visible = wire.path.sourceTopicId === id || wire.path.targetTopicId === id
          const anchor = wire.geometry.getAttribute('position')
          const colors = wire.geometry.getAttribute('color')
          const edgeColor = new THREE.Color()
          const indigo = new THREE.Color('#4863fa')
          const pearl = new THREE.Color('#e9d8ff')
          const warm = new THREE.Color('#d1b8a3')
          wire.material.opacity = visible ? 0.87 : 0.25
          wire.projected = []
          for (let index = 0; index < anchor.count; index += 1) {
            const t = index / (anchor.count - 1)
            const brightness = Math.pow(Math.abs(t * 2 - 1), 1.6)
            edgeColor.copy(visible ? indigo : warm)
            if (visible) edgeColor.lerp(pearl, brightness)
            colors.setXYZ(index, edgeColor.r, edgeColor.g, edgeColor.b)
            wire.projected.push(project(new THREE.Vector3().fromBufferAttribute(anchor, index)))
          }
          colors.needsUpdate = true
          const button = pathRefs.current.get(wire.path.id)
          const midpoint = wire.projected[Math.floor(wire.projected.length / 2)]
          button?.style.setProperty('left', `${midpoint.x}px`)
          button?.style.setProperty('top', `${midpoint.y}px`)
        }
        renderer.render(scene, camera)
        lastActive = id
        dirty = false
      }
      if (easing) requestFrame()
    }

    function start(event: PointerEvent) {
      if (event.button !== 0) return
      dragging = true
      dragged = false
      pointerDown.set(event.clientX, event.clientY)
      dragStart.copy(target)
      renderer.domElement.setPointerCapture(event.pointerId)
    }

    function move(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect()
      if (!dragging) {
        renderer.domElement.style.cursor = findWire({ x: event.clientX - rect.left, y: event.clientY - rect.top }) ? 'pointer' : 'grab'
        return
      }
      const dx = event.clientX - pointerDown.x
      const dy = event.clientY - pointerDown.y
      if (Math.hypot(dx, dy) > 5) dragged = true
      if (!dragged || mediaQuery.matches) return
      renderer.domElement.style.cursor = 'grabbing'
      target.set(THREE.MathUtils.clamp(dragStart.x - dx * 0.018, -3.2, 3.2), THREE.MathUtils.clamp(dragStart.y + dy * 0.016, -2.5, 2.5))
      dirty = true
      requestFrame()
    }

    function findWire(point: Point) {
      const id = selection.current.activeId
      return wires.find(wire => {
        if (wire.path.sourceTopicId !== id && wire.path.targetTopicId !== id) return false
        return wire.projected.some((start, index, projected) => index > 0 && distanceToSegment(point, projected[index - 1], start) < 12)
      })
    }

    function end(event: PointerEvent) {
      if (!dragging) return
      dragging = false
      renderer.domElement.style.cursor = 'grab'
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
      if (dragged || event.type === 'pointercancel') return
      const rect = renderer.domElement.getBoundingClientRect()
      const wire = findWire({ x: event.clientX - rect.left, y: event.clientY - rect.top })
      if (wire) selection.current.onPath(wire.path)
    }

    function changeMotion() {
      if (mediaQuery.matches) {
        target.set(0, 0)
        focusX.set(0, 0)
      }
      dirty = true
      requestFrame()
    }

    function contextLost(event: Event) {
      event.preventDefault()
      inView = false
      setHasWebGl(false)
    }

    function contextRestored() {
      inView = true
      setHasWebGl(true)
      dirty = true
      requestFrame()
    }

    const observer = new ResizeObserver(resize)
    observer.observe(container)
    const canvas = renderer.domElement
    canvas.addEventListener('pointerdown', start)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('webglcontextlost', contextLost)
    canvas.addEventListener('webglcontextrestored', contextRestored)
    mediaQuery.addEventListener('change', changeMotion)
    const onSelection = () => requestFrame()
    container.addEventListener('atlas-selection', onSelection)
    resize()
    setHasWebGl(true)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      for (const node of nodes) {
        node.halo.material.dispose()
        node.flare.material.dispose()
        node.core.material.dispose()
      }
      for (const wire of wires) {
        wire.geometry.dispose()
        wire.material.dispose()
      }
      scene.children.forEach(object => {
        if (object instanceof THREE.Points) {
          object.geometry.dispose()
          object.material.dispose()
        }
      })
      glow.dispose()
      spikes.dispose()
      speck.dispose()
      renderer.dispose()
      canvas.remove()
      mediaQuery.removeEventListener('change', changeMotion)
      container.removeEventListener('atlas-selection', onSelection)
    }
  }, [points, renderedPaths, topics])

  useEffect(() => {
    sceneRef.current?.dispatchEvent(new Event('atlas-selection'))
  }, [activeId])

  const activePoint = fittedPoint(points.get(activeId) ?? { x: 0.5, y: 0.5 })
  return (
    <section className={`star-map${hasWebGl ? ' star-map--webgl' : ''}`} aria-label="主题星图">
      <div className="space-dust" aria-hidden="true" />
      <div className="star-canvas" ref={sceneRef} aria-hidden="true" />
      {topics.map(topic => {
        const point = points.get(topic.id)!
        const fit = fittedPoint(point)
        const mobile = fittedPoint(point, true)
        const active = activeId === topic.id
        return (
          <div
            ref={element => { if (element) topicRefs.current.set(topic.id, element); else topicRefs.current.delete(topic.id) }}
            className={`star-anchor${active ? ' star-anchor--active' : ''}${point.x > 0.69 ? ' star-anchor--east' : ''}`}
            style={{
              '--atlas-x': `${fit.x * 100}%`, '--atlas-y': `${fit.y * 100}%`,
              '--atlas-mobile-x': `${mobile.x * 100}%`, '--atlas-mobile-y': `${mobile.y * 100}%`, '--star-color': topic.color,
            } as CSSProperties}
            key={topic.id}
          >
            <button className="star-label" type="button" aria-pressed={active} onClick={() => onSelect(topic.id)}>
              <span className="star-disc" aria-hidden="true" />
              <span className="star-name">{topic.title}</span>
              {episodeMarks.has(topic.id) && <span className="star-episode">{episodeMarks.get(topic.id)}</span>}
            </button>
          </div>
        )
      })}
      {renderedPaths.filter(path => path.sourceTopicId === activeId || path.targetTopicId === activeId).map(path => {
        const start = points.get(path.sourceTopicId)!
        const end = points.get(path.targetTopicId)!
        const middle = fittedPoint({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 })
        const other = topics.find(topic => topic.id === (path.sourceTopicId === activeId ? path.targetTopicId : path.sourceTopicId))
        return (
          <button
            className="path-pin"
            key={path.id}
            type="button"
            aria-label={`${path.label}：${other?.title ?? path.target.title}`}
            ref={element => { if (element) pathRefs.current.set(path.id, element); else pathRefs.current.delete(path.id) }}
            style={{ '--path-x': `${middle.x * 100}%`, '--path-y': `${middle.y * 100}%` } as CSSProperties}
            onClick={() => onPath(path)}
          >
            <span aria-hidden="true" />
            <span className="path-tip" aria-hidden="true">{path.label}</span>
          </button>
        )
      })}
      <div
        className="scene-card"
        ref={cardRef}
        style={{ '--anchor-x': `${activePoint.x * 100}%`, '--anchor-y': `${activePoint.y * 100}%` } as CSSProperties}
      >
        {card}
      </div>
    </section>
  )
}
