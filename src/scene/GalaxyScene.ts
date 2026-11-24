import * as THREE from 'three'
import {
  BlendFunction, BloomEffect, EffectComposer, EffectPass, NoiseEffect, RenderPass, ToneMappingEffect, ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import * as glsl from './shaders'

export type Point = { x: number; y: number }
/** A big topic, drawn as a nebula. x and y are normalised screen coordinates (0–1, y down) in the overview. */
export type Nebula = { id: string; x: number; y: number; depth: number; tint: string }
/** A sub-topic star inside a nebula. weight (0–1) grows with how often the show comes back to it. */
export type SubStar = { id: string; nebula: string; weight: number }
/** One episode that talks about both sub-topics. Several episodes between the same pair bend apart. */
export type Thread = { id: string; from: string; to: string; bend: number; primary: boolean }
/** An explicit trip of the camera, from a click: to a nebula, to a star, or back out to the whole sky. */
export type Travel = { seq: number; nebula?: string | null; star?: string | null }
export type GalaxyFrame = {
  width: number
  height: number
  nebulae: Map<string, Point & { radius: number }>
  stars: Map<string, Point>
  /** 0 in the overview, 1 once the camera is as close as a focused nebula. */
  zoom: number
}
export type GalaxyOptions = {
  onFrame: (frame: GalaxyFrame) => void
  onNebula: (id: string) => void
  onStar: (id: string) => void
  onThread: (id: string) => void
  onHover: (hover: { thread: string; x: number; y: number } | null) => void
  /** A sub-topic star under the pointer (its lines are showing), or null once the pointer has moved on. */
  onHoverStar: (star: string | null) => void
  /** True while the sky is being dragged, pinched or wheeled. */
  onGesture: (active: boolean) => void
  onView: (nebula: string | null) => void
  onEmpty: () => void
  /** The sub-topic whose label is under (x, y), if any: a label counts as part of its star. */
  labelAt?: (x: number, y: number) => string | null
  reducedMotion: boolean
  /** Start in the 3D view (see setDepth). */
  deep?: boolean
}

const OVERVIEW = 20
const CLOSE = 8.5
const MIN_DISTANCE = 3.2
const MAX_DISTANCE = 30
const FOV = 40
const NEBULA_RADIUS = 2.3
// 3D view: the ring of nebulae alternates this far in front of and behind the hub, and the camera starts from this
// angle, turning slowly (radians per second) while nobody is touching the sky.
const CROWN = 3.6
const DEEP_YAW = -0.32
const DEEP_PITCH = 0.48
// The 3D overview stands further back: the near side of the ring would otherwise spill off the screen.
const OVERVIEW_DEEP = 25
const SPIN = 0.035
const MAX_PITCH = 1.25
const BAKE_SIZE = 320
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV) / 2)
const color = (hex: string, scale = 1) => new THREE.Color(hex).multiplyScalar(scale)

// Colours the frame loop eases towards; allocated once, never per frame.
const PALETTE = {
  core: color('#fff4e6'), coreSelected: color('#f3f5ff'), haloSelected: color('#5068ff'),
  threadMid: color('#8f9bd9'), threadMidLit: color('#3448ff', 1.3), threadEnd: color('#e9dcc6'), threadEndLit: color('#eef0ff'),
}
const NO_DRIFT = new THREE.Vector3()


function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

function hash(text: string) {
  let value = 2166136261
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0
  return value
}

function ribbonGeometry(points: THREE.Vector3[]) {
  const count = points.length
  const position = new Float32Array(count * 6)
  const next = new Float32Array(count * 6)
  const side = new Float32Array(count * 2)
  const u = new Float32Array(count * 2)
  const index: number[] = []
  const ahead = new THREE.Vector3()
  for (let i = 0; i < count; i += 1) {
    const point = points[i]
    if (i < count - 1) ahead.copy(points[i + 1])
    else ahead.copy(point).multiplyScalar(2).sub(points[i - 1])
    for (let s = 0; s < 2; s += 1) {
      const k = i * 2 + s
      position.set([point.x, point.y, point.z], k * 3)
      next.set([ahead.x, ahead.y, ahead.z], k * 3)
      side[k] = s === 0 ? -1 : 1
      u[k] = i / (count - 1)
    }
    if (i < count - 1) {
      const a = i * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('aNext', new THREE.BufferAttribute(next, 3))
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  geometry.setAttribute('aU', new THREE.BufferAttribute(u, 1))
  geometry.setIndex(index)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  return geometry
}

function additive(params: THREE.ShaderMaterialParameters) {
  return new THREE.ShaderMaterial({
    ...params, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    // Ribbon winding flips with direction on screen, so never cull.
    side: THREE.DoubleSide,
  })
}

function distanceToSegment(point: Point, a: Point, b: Point) {
  const x = b.x - a.x
  const y = b.y - a.y
  const length = x * x + y * y
  const t = length ? THREE.MathUtils.clamp(((point.x - a.x) * x + (point.y - a.y) * y) / length, 0, 1) : 0
  return Math.hypot(point.x - a.x - t * x, point.y - a.y - t * y)
}

/** flat is where a nebula sits on the map; deep is where it sits in the 3D view. center eases between them. */
type NebulaObject = {
  nebula: Nebula; center: THREE.Vector3; flat: THREE.Vector3; deep: THREE.Vector3
  layers: THREE.Mesh[]; materials: THREE.ShaderMaterial[]; targets: THREE.WebGLRenderTarget[]; turns: number[]
}
/** offset is the star's place in its nebula on the map; deepOffset adds real depth for the 3D view. */
type StarObject = { star: SubStar; mesh: THREE.Mesh; material: THREE.ShaderMaterial; offset: THREE.Vector3; deepOffset: THREE.Vector3; tint: THREE.Color }
type ThreadObject = { thread: Thread; mesh: THREE.Mesh; material: THREE.ShaderMaterial; samples: THREE.Vector3[] }

export class GalaxyScene {
  static supported() {
    try {
      return Boolean(document.createElement('canvas').getContext('webgl2'))
    } catch {
      return false
    }
  }

  private readonly renderer: THREE.WebGLRenderer
  private readonly composer: EffectComposer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)
  private readonly clock = new THREE.Clock()
  private readonly skyTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  private readonly skyMaterial: THREE.ShaderMaterial
  private readonly skyCopy: THREE.ShaderMaterial
  private readonly quad = new THREE.PlaneGeometry(2, 2)
  private readonly billboard = new THREE.PlaneGeometry(1, 1)
  private readonly dustMaterial: THREE.ShaderMaterial
  private readonly nebulae = new Map<string, NebulaObject>()
  private readonly stars = new Map<string, StarObject>()
  private readonly threads = new Map<string, ThreadObject>()
  private readonly dust: THREE.Points[] = []
  // A sphere of stars around the whole galaxy, only seen in the 3D view.
  private readonly shellMaterial: THREE.ShaderMaterial
  private readonly shell: THREE.Points[] = []
  private readonly hub = new THREE.Vector3()
  private readonly low: boolean
  private nebulaList: Nebula[] = []
  private starList: SubStar[] = []
  private threadList: Thread[] = []
  private selected: string | null = null
  private related = new Set<string>()
  private hovered: string | null = null
  private hoverStar: string | null = null
  private hoverStarTimer = 0
  private wheelTimer = 0
  private current: string | null = null
  private travelSeq = -1
  private width = 1
  private height = 1
  private frame = 0
  private ticks = 0
  private time = 0
  private dirty = true
  private running = true
  private active = performance.now()
  private reducedMotion: boolean
  // Camera: a look point and a distance in front of it, each easing towards its goal.
  private readonly look = new THREE.Vector3()
  private readonly lookGoal = new THREE.Vector3()
  private distance = OVERVIEW
  private distanceGoal = OVERVIEW
  // 2D ↔ 3D: mix eases from 0 (flat map) to 1 (3D); yaw and pitch orbit the camera around the look point.
  private mix = 0
  private mixGoal = 0
  private yaw = 0
  private yawGoal = 0
  private pitch = 0
  private pitchGoal = 0
  private spinPause = 0
  private threadsStale = false
  private readonly right = new THREE.Vector3(1, 0, 0)
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly pointers = new Map<number, Point>()
  private gesture: { moved: boolean; spread: number; mid: Point | null } | null = null
  private hoverFrame = 0
  private readonly observer: ResizeObserver
  private readonly projectVector = new THREE.Vector3()
  private readonly world = new THREE.Vector3()

  constructor(private readonly container: HTMLElement, private readonly options: GalaxyOptions) {
    this.reducedMotion = options.reducedMotion
    if (options.deep) {
      this.mix = this.mixGoal = 1
      this.yaw = this.yawGoal = DEEP_YAW
      this.pitch = this.pitchGoal = DEEP_PITCH
      this.distance = this.distanceGoal = OVERVIEW_DEEP
    }
    this.low = window.matchMedia('(max-width: 680px), (pointer: coarse)').matches
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: false })
    // The look is soft light, so a modest pixel ratio costs nothing visible and saves a lot of fill rate.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.low ? 1 : 1.25))
    this.renderer.setClearColor(0x000000, 1)
    container.appendChild(this.renderer.domElement)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType })
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const bloom = new BloomEffect({
      mipmapBlur: true, luminanceThreshold: 0.3, luminanceSmoothing: 0.25, intensity: 1.15, radius: 0.75, levels: this.low ? 5 : 6,
    })
    const grain = new NoiseEffect({ blendFunction: BlendFunction.SCREEN, premultiply: false })
    grain.blendMode.opacity.value = 0.012
    this.composer.addPass(new EffectPass(
      this.camera, bloom, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }), new VignetteEffect({ offset: 0.3, darkness: 0.6 }), grain,
    ))

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl.fullscreenVertex, fragmentShader: glsl.skyFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTop: { value: color('#090c22') }, uMid: { value: color('#101535') }, uBottom: { value: color('#13183c') },
        uNebula: { value: color('#26306e', 0.22) }, uBand: { value: color('#4a5aa6', 0.36) }, uBandWarm: { value: color('#a7836b', 0.2) },
      },
    })
    this.skyCopy = new THREE.ShaderMaterial({
      vertexShader: glsl.fullscreenVertex, fragmentShader: glsl.skyCopyFragment, depthTest: false, depthWrite: false,
      uniforms: { uSky: { value: this.skyTarget.texture }, uShift: { value: new THREE.Vector2() } },
    })
    const backdrop = new THREE.Mesh(this.quad, this.skyCopy)
    backdrop.frustumCulled = false
    backdrop.renderOrder = -10
    this.scene.add(backdrop)

    this.dustMaterial = additive({
      vertexShader: glsl.dustVertex, fragmentShader: glsl.dustFragment,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() }, uTwinkle: { value: 0.22 }, uFade: { value: 1 } },
    })
    this.shellMaterial = this.dustMaterial.clone()
    this.buildDust()
    this.buildShell()

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
    this.loop()
  }

  setGalaxy(nebulae: Nebula[], stars: SubStar[], threads: Thread[]) {
    this.nebulaList = nebulae
    this.starList = stars
    this.threadList = threads
    this.buildNebulae()
    this.buildStars()
    this.layout()
  }

  /** Highlight a selected star and the stars its threads reach. */
  setSelection(star: string | null, related: Set<string>) {
    this.selected = star
    this.related = related
    this.touch()
  }

  /** Fly somewhere because the person clicked something; free zooming and panning never call this. */
  travel(trip: Travel) {
    if (trip.seq === this.travelSeq) return
    this.travelSeq = trip.seq
    const star = trip.star ? this.stars.get(trip.star) : undefined
    const nebula = this.nebulae.get(star?.star.nebula ?? trip.nebula ?? '')
    this.spinPause = performance.now() + 4000
    if (!nebula) {
      this.lookGoal.set(0, 0, 0)
      this.distanceGoal = this.mixGoal ? OVERVIEW_DEEP : OVERVIEW
    } else {
      const wide = this.width > 680
      // Leave room on the right for the card on wide screens, and at the bottom on phones.
      const target = star ? this.world.copy(star.offset).lerp(star.deepOffset, this.mixGoal).add(this.goalCenter(nebula)).lerp(this.goalCenter(nebula), 0.55) : this.goalCenter(nebula)
      this.lookGoal.copy(target)
        .addScaledVector(this.right, wide && star ? 1.1 : wide ? 0.5 : 0)
        .addScaledVector(this.up, wide ? 0 : -1)
      this.distanceGoal = wide ? CLOSE : CLOSE + 3
    }
    this.touch()
  }

  /**
   * Show a sub-topic's lines while the pointer is on it (label or star). Leaving clears them after a
   * blink, just long enough for the pointer to step onto one of the lines to hover or click it.
   */
  setHoverStar(star: string | null) {
    window.clearTimeout(this.hoverStarTimer)
    if (star) {
      if (star !== this.hoverStar) {
        this.hoverStar = star
        this.options.onHoverStar(star)
        this.touch()
      }
      return
    }
    this.hoverStarTimer = window.setTimeout(() => {
      if (!this.hoverStar) return
      this.hoverStar = null
      this.options.onHoverStar(null)
      this.touch()
    }, 120)
  }

  private touchesHoverStar(threadId: string | null) {
    const thread = threadId ? this.threads.get(threadId)?.thread : undefined
    return Boolean(thread && this.hoverStar && (thread.from === this.hoverStar || thread.to === this.hoverStar))
  }

  /**
   * Switch between the flat map and the 3D view. Every nebula and star eases between its two places while the
   * camera swings round to a three-quarter view (or back to face-on), so the change reads as the map unfolding.
   */
  setDepth(deep: boolean) {
    this.mixGoal = deep ? 1 : 0
    // Unwind any slow spin so the way back to face-on is the short way round.
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw))
    this.yawGoal = deep ? DEEP_YAW : 0
    this.pitchGoal = deep ? DEEP_PITCH : 0
    if (!deep) this.lookGoal.z = 0
    if (!this.current && Math.abs(this.distanceGoal - (deep ? OVERVIEW : OVERVIEW_DEEP)) < 1) this.distanceGoal = deep ? OVERVIEW_DEEP : OVERVIEW
    if (this.reducedMotion) {
      this.mix = this.mixGoal
      this.yaw = this.yawGoal
      this.pitch = this.pitchGoal
      this.place()
      this.layoutThreads()
    }
    this.spinPause = performance.now() + 2500
    this.threadsStale = true
    this.touch()
  }

  setReducedMotion(value: boolean) {
    this.reducedMotion = value
    this.touch()
  }

  dispose() {
    this.running = false
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.hoverFrame)
    window.clearTimeout(this.hoverStarTimer)
    window.clearTimeout(this.wheelTimer)
    this.observer.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('pointerleave', this.onPointerLeave)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('webglcontextlost', this.onContextLost)
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    document.removeEventListener('visibilitychange', this.onVisibility)
    for (const object of this.nebulae.values()) object.targets.forEach(target => target.dispose())
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        if (object.geometry !== this.quad && object.geometry !== this.billboard) object.geometry.dispose()
        ;(object.material as THREE.Material).dispose()
      }
    })
    this.quad.dispose()
    this.billboard.dispose()
    this.skyMaterial.dispose()
    this.skyTarget.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    canvas.remove()
  }

  // ---------------------------------------------------------------- building

  private worldAt(x: number, y: number, z: number, target = new THREE.Vector3()) {
    const half = (OVERVIEW - z) * TAN
    return target.set((x * 2 - 1) * half * this.camera.aspect, (1 - y * 2) * half, z)
  }

  /** Nebula gas is computed once per layer into a texture; each frame only reads it back. */
  private buildNebulae() {
    for (const object of this.nebulae.values()) {
      object.layers.forEach(mesh => this.scene.remove(mesh))
      object.materials.forEach(material => material.dispose())
      object.targets.forEach(target => target.dispose())
    }
    this.nebulae.clear()
    const bakeScene = new THREE.Scene()
    const bakeMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl.bakeVertex, fragmentShader: glsl.nebulaFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTint: { value: new THREE.Color() }, uCoreTint: { value: new THREE.Color() }, uIntensity: { value: 1 },
        uTime: { value: 0 }, uSeed: { value: 0 },
      },
    })
    const bakeMesh = new THREE.Mesh(this.quad, bakeMaterial)
    bakeMesh.frustumCulled = false
    bakeScene.add(bakeMesh)
    for (const nebula of this.nebulaList) {
      const seed = (hash(nebula.id) % 1000) / 100
      // Pastel topic colours read as grey gas, so deepen them a little.
      const hsl = { h: 0, s: 0, l: 0 }
      color(nebula.tint).getHSL(hsl)
      const tint = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.25 + 0.15), Math.min(0.62, hsl.l * 0.85))
      const random = seeded(hash(nebula.id) + 17)
      const object: NebulaObject = {
        nebula, center: new THREE.Vector3(), flat: new THREE.Vector3(), deep: new THREE.Vector3(), layers: [], materials: [], targets: [], turns: [],
      }
      for (const [scale, offset] of [[7.4, 0], [5, 2.7]]) {
        const target = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, { type: THREE.HalfFloatType, depthBuffer: false })
        bakeMaterial.uniforms.uTint.value.copy(tint)
        bakeMaterial.uniforms.uCoreTint.value.copy(color(nebula.tint))
        bakeMaterial.uniforms.uSeed.value = seed + offset
        this.renderer.setRenderTarget(target)
        this.renderer.render(bakeScene, this.camera)
        const turn = random() * Math.PI
        const material = additive({
          vertexShader: glsl.nebulaVertex, fragmentShader: glsl.nebulaTextureFragment,
          uniforms: {
            uMap: { value: target.texture }, uScale: { value: scale }, uIntensity: { value: 0.3 },
            uStretch: { value: new THREE.Vector2(1 + random() * 0.6, 0.6 + random() * 0.3) }, uTurn: { value: turn },
          },
        })
        const mesh = new THREE.Mesh(this.billboard, material)
        mesh.frustumCulled = false
        mesh.renderOrder = 1
        this.scene.add(mesh)
        object.layers.push(mesh)
        object.materials.push(material)
        object.targets.push(target)
        object.turns.push(turn)
      }
      this.nebulae.set(nebula.id, object)
    }
    this.renderer.setRenderTarget(null)
    bakeMaterial.dispose()
  }

  private buildStars() {
    for (const object of this.stars.values()) {
      this.scene.remove(object.mesh)
      object.material.dispose()
    }
    this.stars.clear()
    const byNebula = new Map<string, SubStar[]>()
    for (const star of this.starList) byNebula.set(star.nebula, [...(byNebula.get(star.nebula) ?? []), star])
    for (const [nebulaId, members] of byNebula) {
      const nebula = this.nebulaList.find(item => item.id === nebulaId)
      if (!nebula) continue
      const random = seeded(hash(nebulaId))
      const placed: THREE.Vector3[] = []
      // Heavier sub-topics sit nearer the core; keep neighbours apart so labels have room.
      for (const star of [...members].sort((a, b) => b.weight - a.weight)) {
        let offset = new THREE.Vector3()
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const angle = random() * Math.PI * 2
          const radius = NEBULA_RADIUS * (0.15 + 0.95 * Math.pow(random(), 0.8) * (1 - star.weight * 0.4))
          offset = new THREE.Vector3(Math.cos(angle) * radius * 1.3, Math.sin(angle) * radius * 0.9, (random() - 0.5) * 1.4)
          if (placed.every(other => Math.hypot(other.x - offset.x, (other.y - offset.y) * 1.5) > 0.82)) break
        }
        placed.push(offset)
        // In 3D the constellation also spreads forwards and backwards (a rough bell curve, steady per star).
        const depth = seeded(hash(star.id))
        const deepOffset = new THREE.Vector3(offset.x, offset.y, (depth() + depth() + depth() - 1.5) * 2.4)
        // Stars carry their nebula's hue, so each topic's constellation reads as its own colour.
        const hsl = { h: 0, s: 0, l: 0 }
        color(nebula.tint).getHSL(hsl)
        const tint = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.3 + 0.35), 0.6)
        const material = additive({
          vertexShader: glsl.billboardVertex, fragmentShader: glsl.starFragment,
          uniforms: {
            uScale: { value: 0.5 }, uCore: { value: color('#fff4e6') }, uHalo: { value: tint.clone() },
            uIntensity: { value: 0.7 }, uSpike: { value: 0.35 }, uTime: { value: 0 }, uPhase: { value: random() * 10 },
          },
        })
        const mesh = new THREE.Mesh(this.billboard, material)
        mesh.frustumCulled = false
        mesh.renderOrder = 5
        this.scene.add(mesh)
        this.stars.set(star.id, { star, mesh, material, offset, deepOffset, tint })
      }
    }
  }

  private layoutThreads() {
    for (const object of this.threads.values()) {
      this.scene.remove(object.mesh)
      object.mesh.geometry.dispose()
      object.material.dispose()
    }
    this.threads.clear()
    for (const thread of this.threadList) {
      const from = this.stars.get(thread.from)
      const to = this.stars.get(thread.to)
      if (!from || !to) continue
      const start = from.mesh.position
      const end = to.mesh.position
      const delta = end.clone().sub(start)
      const sag = Math.min(delta.length() * 0.1, 0.9) * thread.bend
      const middle = start.clone().addScaledVector(delta, 0.5)
      if (this.mixGoal > 0.5) {
        // 3D: every line bows away from the hub, so the links between topics read as domes over the galaxy;
        // lines between the same two stars fan out around that bow.
        const along = delta.clone().normalize()
        const outward = middle.clone().sub(this.hub)
        outward.addScaledVector(along, -outward.dot(along))
        if (outward.lengthSq() < 1e-4) outward.set(0, 0, 1)
        outward.normalize()
        const across = along.clone().cross(outward)
        middle.addScaledVector(outward, Math.min(delta.length() * 0.22, 2.2)).addScaledVector(across, sag)
      } else {
        const normal = new THREE.Vector3(-delta.y, delta.x, 0).normalize()
        middle.addScaledVector(normal, sag).add(new THREE.Vector3(0, 0, 0.5))
      }
      const curve = new THREE.QuadraticBezierCurve3(start.clone(), middle, end.clone())
      const samples = curve.getSpacedPoints(28)
      const material = additive({
        vertexShader: glsl.ribbonVertex, fragmentShader: glsl.ribbonFragment,
        uniforms: {
          uResolution: { value: new THREE.Vector2(this.width, this.height) }, uWidth: { value: 1.1 },
          uEnd: { value: color('#e9dcc6') }, uMid: { value: color('#8f9bd9') }, uIntensity: { value: 0.2 },
          uOpacity: { value: 0 }, uDash: { value: 0 }, uPulse: { value: 0 }, uTime: { value: 0 }, uFade: { value: 0 },
          // Rays leaving a nebula fade over a fixed distance, whatever the thread's full length.
          uFadeSpan: { value: THREE.MathUtils.clamp(1.3 / curve.getLength(), 0.04, 0.6) },
        },
      })
      const mesh = new THREE.Mesh(ribbonGeometry(samples), material)
      mesh.frustumCulled = false
      mesh.renderOrder = 3
      mesh.visible = false
      this.scene.add(mesh)
      this.threads.set(thread.id, { thread, mesh, material, samples })
    }
  }

  private points(count: number, place: (random: () => number) => [THREE.Vector3, number, THREE.Color], seed: number) {
    const random = seeded(seed)
    const position = new Float32Array(count * 3)
    const size = new Float32Array(count)
    const tint = new Float32Array(count * 3)
    const phase = new Float32Array(count)
    for (let i = 0; i < count; i += 1) {
      const [point, pixels, light] = place(random)
      position.set([point.x, point.y, point.z], i * 3)
      size[i] = pixels
      tint.set([light.r, light.g, light.b], i * 3)
      phase[i] = random()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(tint, 3))
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
    const points = new THREE.Points(geometry, this.dustMaterial)
    points.frustumCulled = false
    return points
  }

  private buildDust() {
    const blue = color('#c8d2ff')
    const warm = color('#ffd2a6')
    const far = this.points(this.low ? 600 : 1200, random => [
      new THREE.Vector3((random() - 0.5) * 120, (random() - 0.5) * 80, -46 + random() * 16),
      0.8 + random() * 1.4,
      (random() > 0.22 ? blue : warm).clone().multiplyScalar(0.08 + Math.pow(random(), 2) * 0.5),
    ], 7)
    const mid = this.points(this.low ? 60 : 140, random => [
      new THREE.Vector3((random() - 0.5) * 60, (random() - 0.5) * 40, -16 + random() * 10),
      0.9 + random() * 1.2,
      (random() > 0.35 ? blue : warm).clone().multiplyScalar(0.18 + Math.pow(random(), 3) * 0.35),
    ], 11)
    this.dust.push(far, mid)
    this.scene.add(far, mid)
  }

  /** 3D only: stars on a sphere round the galaxy, thickest along one tilted band, so turning never finds an edge. */
  private buildShell() {
    const pole = new THREE.Vector3(0.35, 0.88, 0.32).normalize()
    const blue = color('#c8d2ff')
    const warm = color('#ffd2a6')
    const onSphere = (random: () => number) => {
      const z = random() * 2 - 1
      const angle = random() * Math.PI * 2
      const ring = Math.sqrt(1 - z * z)
      return new THREE.Vector3(Math.cos(angle) * ring, Math.sin(angle) * ring, z)
    }
    const scattered = new THREE.Points(this.points(this.low ? 700 : 1600, random => [
      onSphere(random).multiplyScalar(62 + random() * 20),
      0.8 + random() * 1.3,
      (random() > 0.22 ? blue : warm).clone().multiplyScalar(0.08 + Math.pow(random(), 2.5) * 0.55),
    ], 41).geometry, this.shellMaterial)
    const band = new THREE.Points(this.points(this.low ? 1400 : 3600, random => {
      // Pull a random direction towards the band's plane: most of these stars sit close to it.
      const point = onSphere(random)
      point.addScaledVector(pole, -point.dot(pole) * (1 - Math.pow(random(), 3) * 0.35)).normalize()
      const bright = Math.pow(random(), 4)
      return [point.multiplyScalar(66 + random() * 10), 0.7 + bright * 2.2,
        color(random() > 0.15 ? '#b9c6ff' : '#ffd9b5').multiplyScalar(0.08 + bright * 0.7)]
    }, 43).geometry, this.shellMaterial)
    for (const points of [scattered, band]) {
      points.frustumCulled = false
      points.visible = false
      this.shell.push(points)
      this.scene.add(points)
    }
  }

  private layoutBand() {
    const old = this.dust[2]
    if (old) {
      this.scene.remove(old)
      old.geometry.dispose()
    }
    const band = this.points(this.low ? 1500 : 4000, random => {
      const x = 0.36 + Math.pow(random(), 0.8) * 0.72
      const spread = (random() + random() + random() - 1.5) * 0.07
      const y = 1 - (0.02 + 0.62 * (x - 0.42)) + spread
      const bright = Math.pow(random(), 4)
      return [this.worldAt(x, y, -26 - random() * 6), 0.7 + bright * 2.2,
        color(random() > 0.15 ? '#b9c6ff' : '#ffd9b5').multiplyScalar(0.1 + bright * 0.8)]
    }, 31)
    this.dust[2] = band
    this.scene.add(band)
  }

  // ---------------------------------------------------------------- layout

  private resize() {
    this.width = Math.max(1, this.container.clientWidth)
    this.height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(this.width, this.height, false)
    this.composer.setSize(this.width, this.height)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderSky()
    this.layout()
  }

  private renderSky() {
    const scale = this.low ? 0.5 : 0.6
    this.skyTarget.setSize(Math.ceil(this.width * scale), Math.ceil(this.height * scale))
    this.skyMaterial.uniforms.uResolution.value.set(this.width, this.height)
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(this.quad, this.skyMaterial)
    mesh.frustumCulled = false
    scene.add(mesh)
    this.renderer.setRenderTarget(this.skyTarget)
    this.renderer.render(scene, this.camera)
    this.renderer.setRenderTarget(null)
  }

  private layout() {
    const objects = [...this.nebulae.values()]
    for (const object of objects) this.worldAt(object.nebula.x, object.nebula.y, object.nebula.depth, object.flat)
    // 3D: the nebula nearest the middle of the map is the hub; the rest alternate in front of and behind it
    // around the ring, so neighbours separate in depth.
    const middle = objects.reduce((sum, object) => sum.add(object.flat), new THREE.Vector3()).divideScalar(Math.max(objects.length, 1))
    const hub = objects.reduce<NebulaObject | undefined>((best, object) =>
      !best || object.flat.distanceTo(middle) < best.flat.distanceTo(middle) ? object : best, undefined)
    this.hub.copy(hub?.flat ?? middle)
    const ring = objects.filter(object => object !== hub)
      .sort((a, b) => Math.atan2(a.flat.y - this.hub.y, a.flat.x - this.hub.x) - Math.atan2(b.flat.y - this.hub.y, b.flat.x - this.hub.x))
    hub?.deep.copy(hub.flat)
    ring.forEach((object, index) => object.deep.copy(object.flat).setZ((index % 2 ? -1 : 1) * CROWN + object.nebula.depth * 0.6))
    this.place()
    this.layoutThreads()
    this.layoutBand()
    this.touch()
  }

  /** Put every nebula, gas layer and star where the current 2D/3D mix says. */
  private place() {
    const t = this.mix
    for (const object of this.nebulae.values()) {
      object.center.lerpVectors(object.flat, object.deep, t)
      // In 3D the two gas layers part in depth, so turning the sky shows the nebula has thickness.
      object.layers.forEach((mesh, index) => mesh.position.copy(object.center)
        .add(this.world.set(index * 0.3, -index * 0.2, THREE.MathUtils.lerp(-0.6 - index * 0.4, index ? 1.3 : -1.3, t))))
    }
    for (const object of this.stars.values()) {
      const nebula = this.nebulae.get(object.star.nebula)
      if (nebula) object.mesh.position.copy(nebula.center).add(this.world.lerpVectors(object.offset, object.deepOffset, t))
    }
  }

  /** Where a nebula will be once the current 2D/3D change finishes. */
  private goalCenter(object: NebulaObject) {
    return new THREE.Vector3().lerpVectors(object.flat, object.deep, this.mixGoal)
  }

  /** A nebula's radius on screen, in px. */
  private screenRadius(center: THREE.Vector3) {
    this.projectVector.copy(center).applyMatrix4(this.camera.matrixWorldInverse)
    return (NEBULA_RADIUS * this.height) / (2 * Math.max(-this.projectVector.z, 0.1) * TAN)
  }

  private clampGoal() {
    const reach = this.worldAt(1, 1, 0)
    this.lookGoal.x = THREE.MathUtils.clamp(this.lookGoal.x, -Math.abs(reach.x) * 1.1, Math.abs(reach.x) * 1.1)
    this.lookGoal.y = THREE.MathUtils.clamp(this.lookGoal.y, -Math.abs(reach.y) * 1.1, Math.abs(reach.y) * 1.1)
    this.lookGoal.z = THREE.MathUtils.clamp(this.lookGoal.z, -CROWN * 2, CROWN * 2)
    this.distanceGoal = THREE.MathUtils.clamp(this.distanceGoal, MIN_DISTANCE, MAX_DISTANCE)
  }

  // ---------------------------------------------------------------- loop

  private touch() {
    this.active = performance.now()
    this.dirty = true
    if (!this.frame && this.running) this.frame = requestAnimationFrame(this.loop)
  }

  /** The nebula the camera is inside, if it is close enough to count as being in one. */
  private nearestNebula() {
    if (this.distance > 13) return null
    let best: string | null = null
    let closest = 3.4
    for (const [id, object] of this.nebulae) {
      const distance = Math.hypot(object.center.x - this.look.x, object.center.y - this.look.y, (object.center.z - this.look.z) * this.mix)
      if (distance < closest) { closest = distance; best = id }
    }
    return best
  }

  private readonly loop = () => {
    this.frame = 0
    if (!this.running) return
    // Eases follow real elapsed time, so a throttled tab still finishes a flight on time.
    const elapsed = Math.min(this.clock.getDelta(), 0.5)
    const delta = Math.min(elapsed, 0.05)
    const animate = !this.reducedMotion
    if (animate) this.time += delta
    const rate = animate ? 1 - Math.pow(0.0025, elapsed) : 1
    const fly = animate ? 1 - Math.pow(0.02, elapsed) : 1
    // 3D, overview, nobody touching: the sky turns slowly, so depth shows even when you just look.
    if (animate && this.mixGoal === 1 && !this.current && !this.selected && !this.hoverStar && !this.gesture && performance.now() > this.spinPause) {
      this.yaw += delta * SPIN
      this.yawGoal += delta * SPIN
    }
    const morph = animate ? 1 - Math.pow(0.08, elapsed) : 1
    const morphing = Math.abs(this.mixGoal - this.mix) > 1e-3
    this.mix = morphing ? this.mix + (this.mixGoal - this.mix) * morph : this.mixGoal
    if (morphing || this.threadsStale) this.place()
    if (!morphing && this.threadsStale) {
      this.threadsStale = false
      this.layoutThreads()
    }
    this.look.lerp(this.lookGoal, fly)
    this.distance += (this.distanceGoal - this.distance) * fly
    this.yaw += (this.yawGoal - this.yaw) * morph
    this.pitch += (this.pitchGoal - this.pitch) * morph
    const drift = animate ? this.world.set(Math.sin(this.time * 0.07) * 0.15, Math.cos(this.time * 0.053) * 0.09, 0) : NO_DRIFT
    const level = Math.cos(this.pitch)
    this.camera.position.set(
      this.look.x + drift.x + this.distance * Math.sin(this.yaw) * level,
      this.look.y + drift.y + this.distance * Math.sin(this.pitch),
      this.look.z + this.distance * Math.cos(this.yaw) * level,
    )
    this.camera.lookAt(this.look)
    this.camera.updateMatrixWorld()
    // The camera's own right and up, for panning and zooming: exactly x and y when the map faces you.
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    this.up.set(-Math.sin(this.pitch) * Math.sin(this.yaw), level, -Math.sin(this.pitch) * Math.cos(this.yaw))
    this.skyCopy.uniforms.uShift.value.set(-this.look.x * 0.004 - Math.sin(this.yaw) * 0.025, -this.look.y * 0.004 + this.pitch * 0.025)
    // The flat backdrop gives way to the sphere of stars as the map becomes 3D.
    this.dustMaterial.uniforms.uFade.value = 1 - this.mix * 0.85
    this.shellMaterial.uniforms.uFade.value = this.mix
    for (const points of this.shell) points.visible = this.mix > 0.01

    const moving = this.look.distanceToSquared(this.lookGoal) > 1e-5 || Math.abs(this.distance - this.distanceGoal) > 1e-3
      || morphing || Math.abs(this.yawGoal - this.yaw) > 1e-3 || Math.abs(this.pitchGoal - this.pitch) > 1e-3
    const current = this.nearestNebula()
    if (current !== this.current) {
      this.current = current
      this.options.onView(current)
    }
    let settling = moving

    for (const [id, object] of this.nebulae) {
      const target = !current ? 0.34 : id === current ? 0.5 : 0.16
      object.materials.forEach((material, index) => {
        const u = material.uniforms
        u.uIntensity.value += (target - u.uIntensity.value) * rate
        u.uTurn.value = object.turns[index] + this.time * (index ? -0.006 : 0.004)
      })
    }
    for (const [id, object] of this.stars) {
      const inside = object.star.nebula === current
      const isSelected = id === this.selected
      const isRelated = this.related.has(id)
      // Better-connected sub-topics are larger and brighter, so the most discussed stand out.
      const base = 0.26 + object.star.weight * 0.7
      const scale = isSelected ? 1.15 : isRelated ? base * 1.35 : current && !inside ? base * 0.8 : base
      const glow = 0.7 + object.star.weight * 0.6
      const intensity = isSelected ? 1.9 : isRelated ? 1.3 : (!current ? 0.75 : inside ? (this.selected ? 0.8 : 1.05) : 0.4) * glow
      const u = object.material.uniforms
      u.uScale.value += (scale - u.uScale.value) * rate
      u.uIntensity.value += (intensity - u.uIntensity.value) * rate
      u.uSpike.value += ((isSelected ? 1 : 0.35) - u.uSpike.value) * rate
      u.uCore.value.lerp(isSelected ? PALETTE.coreSelected : PALETTE.core, rate)
      u.uHalo.value.lerp(isSelected ? PALETTE.haloSelected : object.tint, rate)
      u.uTime.value = this.time
      settling ||= Math.abs(scale - u.uScale.value) > 0.003
    }
    // Lines stay hidden until they mean something: the hovered or selected sub-topic's episodes.
    for (const [id, object] of this.threads) {
      const { from, to } = object.thread
      const pointed = id === this.hovered
      const lit = !morphing && !this.threadsStale
        && (pointed || [this.selected, this.hoverStar].some(star => star !== null && (from === star || to === star)))
      const u = object.material.uniforms
      if (!lit && u.uOpacity.value < 0.005) {
        object.mesh.visible = false
        continue
      }
      u.uWidth.value += ((pointed ? 3 : 2) - u.uWidth.value) * rate
      u.uIntensity.value += ((pointed ? 2.4 : 1.5) - u.uIntensity.value) * rate
      u.uOpacity.value += ((lit ? 1 : 0) - u.uOpacity.value) * rate
      u.uPulse.value += ((animate && lit ? 1 : 0) - u.uPulse.value) * rate
      u.uMid.value.lerp(PALETTE.threadMidLit, rate)
      u.uEnd.value.lerp(PALETTE.threadEndLit, rate)
      u.uFade.value = 0
      settling ||= Math.abs((lit ? 1 : 0) - u.uOpacity.value) > 0.01
      u.uTime.value = this.time
      u.uResolution.value.set(this.width, this.height)
      object.mesh.visible = u.uOpacity.value > 0.01
    }
    this.dustMaterial.uniforms.uTime.value = this.time
    this.dustMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio()
    this.shellMaterial.uniforms.uTime.value = this.time
    this.shellMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio()

    if (settling) this.active = performance.now()
    // Idle: twinkling still runs, at half the frame rate.
    const idle = performance.now() - this.active > 1500
    this.ticks += 1
    if (this.dirty || settling || (animate && (!idle || this.ticks % 2 === 0))) {
      this.composer.render(delta)
      this.emitFrame()
      this.dirty = false
    }
    if (animate || settling) this.frame = requestAnimationFrame(this.loop)
  }

  private project(point: THREE.Vector3): Point & { behind: boolean } {
    this.projectVector.copy(point).project(this.camera)
    return {
      x: (this.projectVector.x + 1) * this.width * 0.5,
      y: (1 - this.projectVector.y) * this.height * 0.5,
      behind: this.projectVector.z > 1,
    }
  }

  private emitFrame() {
    const nebulae = new Map<string, Point & { radius: number }>()
    for (const [id, object] of this.nebulae) {
      const center = this.project(object.center)
      if (!center.behind) nebulae.set(id, { x: center.x, y: center.y, radius: this.screenRadius(object.center) })
    }
    const stars = new Map<string, Point>()
    for (const [id, object] of this.stars) {
      const point = this.project(object.mesh.position)
      if (!point.behind) stars.set(id, point)
    }
    const zoom = THREE.MathUtils.clamp((OVERVIEW - this.distance) / (OVERVIEW - CLOSE), 0, 1)
    this.options.onFrame({ width: this.width, height: this.height, nebulae, stars, zoom })
  }

  // ---------------------------------------------------------------- input

  private pick(x: number, y: number): { star?: string; nebula?: string; thread?: string } {
    const point = { x, y }
    const zoom = THREE.MathUtils.clamp((OVERVIEW - this.distance) / (OVERVIEW - CLOSE), 0, 1)
    let best = 12 + zoom * 8
    let star: string | undefined
    for (const [id, object] of this.stars) {
      const at = this.project(object.mesh.position)
      if (at.behind) continue
      const distance = Math.hypot(at.x - x, at.y - y)
      if (distance < best) { best = distance; star = id }
    }
    star ??= this.options.labelAt?.(x, y) ?? undefined
    if (star) return { star }
    for (const [id, object] of this.threads) {
      if (!object.mesh.visible || object.material.uniforms.uOpacity.value < 0.3) continue
      const projected = object.samples.filter((_, i) => i % 2 === 0).map(sample => this.project(sample))
      if (projected.some((p, i) => i > 0 && !p.behind && distanceToSegment(point, projected[i - 1], p) < 7)) return { thread: id }
    }
    let nebula: string | undefined
    let closest = Infinity
    for (const [id, object] of this.nebulae) {
      if (id === this.current) continue
      const center = this.project(object.center)
      if (center.behind) continue
      const distance = Math.hypot(center.x - x, center.y - y)
      if (distance < this.screenRadius(object.center) * 0.85 && distance < closest) { closest = distance; nebula = id }
    }
    return nebula ? { nebula } : {}
  }

  private local(event: PointerEvent | WheelEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** Zoom by `factor` keeping the sky under (x, y) where it is. */
  private zoomAt(x: number, y: number, factor: number) {
    const before = this.distanceGoal
    this.distanceGoal = THREE.MathUtils.clamp(before * factor, MIN_DISTANCE, MAX_DISTANCE)
    const shift = (before - this.distanceGoal) * TAN
    this.lookGoal.addScaledVector(this.right, ((x / this.width) * 2 - 1) * shift * this.camera.aspect)
    this.lookGoal.addScaledVector(this.up, (1 - (y / this.height) * 2) * shift)
    this.spinPause = performance.now() + 6000
    this.clampGoal()
    this.touch()
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const { x, y } = this.local(event)
    // Trackpad pinches arrive as wheel events with ctrlKey set and small deltas.
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    this.zoomAt(x, y, Math.exp(delta * (event.ctrlKey ? 0.012 : 0.0016)))
    if (!this.wheelTimer) this.options.onGesture(true)
    window.clearTimeout(this.wheelTimer)
    this.wheelTimer = window.setTimeout(() => {
      this.wheelTimer = 0
      this.options.onGesture(false)
    }, 280)
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    this.pointers.set(event.pointerId, this.local(event))
    this.renderer.domElement.setPointerCapture(event.pointerId)
    const spread = this.spread()
    this.gesture = { moved: this.gesture?.moved ?? false, spread, mid: this.midpoint() }
    if (this.pointers.size === 1) this.gesture.moved = false
    this.spinPause = performance.now() + 6000
  }

  private midpoint(): Point | null {
    const [a, b] = [...this.pointers.values()]
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null
  }

  /** Slide the sky by a screen distance, along the camera's own axes. */
  private pan(dx: number, dy: number) {
    const perPixel = (2 * this.distanceGoal * TAN) / this.height
    this.lookGoal.addScaledVector(this.right, -dx * perPixel).addScaledVector(this.up, dy * perPixel)
    this.clampGoal()
    this.touch()
  }

  private spread() {
    const [a, b] = [...this.pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const canvas = this.renderer.domElement
    const point = this.local(event)
    const previous = this.pointers.get(event.pointerId)
    if (!previous || !this.gesture) {
      // Hover: resolve once per animation frame at most.
      if (!this.hoverFrame) {
        this.hoverFrame = requestAnimationFrame(() => {
          this.hoverFrame = 0
          const hit = this.pick(point.x, point.y)
          const thread = hit.thread ?? null
          if (thread !== this.hovered) {
            this.hovered = thread
            this.touch()
          }
          if (hit.star) this.setHoverStar(hit.star)
          else if (!this.touchesHoverStar(thread)) this.setHoverStar(null)
          else window.clearTimeout(this.hoverStarTimer)
          this.options.onHover(thread ? { thread, x: point.x, y: point.y } : null)
          canvas.style.cursor = hit.star || hit.nebula || hit.thread ? 'pointer' : 'grab'
        })
      }
      return
    }
    this.pointers.set(event.pointerId, point)
    if (this.pointers.size >= 2) {
      const spread = this.spread()
      const mid = this.midpoint()
      if (this.gesture.spread > 0 && spread > 0 && mid) this.zoomAt(mid.x, mid.y, this.gesture.spread / spread)
      // Two fingers moving together slide the sky; in 3D one finger turns it.
      if (this.gesture.mid && mid) this.pan(mid.x - this.gesture.mid.x, mid.y - this.gesture.mid.y)
      this.gesture.spread = spread
      this.gesture.mid = mid
      if (!this.gesture.moved) this.options.onGesture(true)
      this.gesture.moved = true
      return
    }
    const dx = point.x - previous.x
    const dy = point.y - previous.y
    if (!this.gesture.moved && Math.hypot(dx, dy) < 3) return
    if (!this.gesture.moved) this.options.onGesture(true)
    this.gesture.moved = true
    canvas.style.cursor = 'grabbing'
    this.spinPause = performance.now() + 6000
    if (this.mixGoal === 1 && !event.shiftKey) {
      // 3D: dragging turns the sky around the point you are looking at; Shift-drag slides it.
      this.yaw -= dx * 0.005
      this.yawGoal = this.yaw
      this.pitch = this.pitchGoal = THREE.MathUtils.clamp(this.pitch + dy * 0.005, -MAX_PITCH, MAX_PITCH)
      this.touch()
      return
    }
    this.pan(dx, dy)
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    const canvas = this.renderer.domElement
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    this.pointers.delete(event.pointerId)
    const gesture = this.gesture
    if (this.pointers.size > 0) return
    this.gesture = null
    canvas.style.cursor = 'grab'
    if (gesture?.moved) this.options.onGesture(false)
    if (!gesture || gesture.moved || event.type === 'pointercancel') return
    const { x, y } = this.local(event)
    const hit = this.pick(x, y)
    if (hit.star) this.options.onStar(hit.star)
    else if (hit.thread) this.options.onThread(hit.thread)
    else if (hit.nebula) this.options.onNebula(hit.nebula)
    else this.options.onEmpty()
  }

  private readonly onPointerLeave = () => {
    if (this.hovered) {
      this.hovered = null
      this.touch()
    }
    this.setHoverStar(null)
    this.options.onHover(null)
  }

  private readonly onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    } else {
      this.clock.getDelta()
      this.touch()
    }
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault()
    this.running = false
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private readonly onContextRestored = () => {
    this.running = true
    this.renderSky()
    this.buildNebulae()
    this.layout()
  }
}
