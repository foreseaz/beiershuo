import * as THREE from 'three'
import {
  BlendFunction, BloomEffect, EffectComposer, EffectPass, NoiseEffect, RenderPass, ToneMappingEffect, ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import * as glsl from './shaders'

export type Point = { x: number; y: number }
/** A topic star. x and y are normalised screen coordinates (0–1, y down) at rest. */
export type SkyNode = { id: string; x: number; y: number; depth: number; tint: string }
export type SkyLink = { id: string; from: string; to: string }
export type SkyFrame = { width: number; height: number; nodes: Map<string, Point>; links: Map<string, Point> }
export type SkyOptions = {
  onFrame: (frame: SkyFrame) => void
  onLink: (id: string) => void
  onStar: (id: string) => void
  reducedMotion: boolean
}

const CAMERA_Z = 20
const FOV = 40
const color = (hex: string, scale = 1) => new THREE.Color(hex).multiplyScalar(scale)

const STAR = {
  idle: { core: color('#fff4e6'), halo: color('#ffac55'), intensity: 1, spike: 0.6, scale: 1.8 },
  active: { core: color('#f3f5ff'), halo: color('#4f66ff'), intensity: 1.75, spike: 1.1, scale: 3.3 },
}
const LINK = {
  active: { end: color('#eef0ff'), mid: color('#2f44ff', 1.4), width: 9, intensity: 2.2, opacity: 1, pulse: 1 },
  idle: { end: color('#cdbca8'), mid: color('#8d93bb'), width: 3, intensity: 0.42, opacity: 0.55, pulse: 0 },
}
// Hand-placed foreground light, read off the concept frame: x, y, diameter in px at 1058 px tall, opacity.
const BOKEH: [number, number, number, number][] = [
  [0.595, 0.825, 24, 1.2], [0.658, 0.874, 15, 1], [0.93, 0.643, 28, 0.55], [0.85, 0.888, 36, 0.38],
  [0.256, 0.958, 22, 0.55], [0.354, 0.642, 9, 0.8], [0.822, 0.758, 11, 0.6], [0.975, 0.83, 46, 0.22],
  [0.47, 0.985, 16, 0.5], [0.63, 0.07, 12, 0.35], [0.06, 0.55, 8, 0.5],
]
// Faint decorative orbits in normalised screen space: centre, radii, rotation, arc start/end.
const ORBITS: [number, number, number, number, number, number, number][] = [
  [0.25, 0.47, 0.2, 0.36, 0.32, 0, Math.PI * 2],
  [0.92, 0.18, 0.2, 0.13, -0.2, Math.PI * 0.55, Math.PI * 1.25],
]

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
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

type StarObject = {
  node: SkyNode
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  halo: THREE.Color
}
type LinkObject = {
  link: SkyLink
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  samples: THREE.Vector3[]
  projected: Point[]
}

export class SkyScene {
  static supported() {
    try {
      const canvas = document.createElement('canvas')
      return Boolean(canvas.getContext('webgl2'))
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
  private readonly stars = new Map<string, StarObject>()
  private readonly links = new Map<string, LinkObject>()
  private readonly orbits: THREE.Mesh[] = []
  private readonly bokeh: { mesh: THREE.Mesh; material: THREE.ShaderMaterial; spec: number[] }[] = []
  private readonly dust: THREE.Points[] = []
  private readonly low: boolean
  private nodes: SkyNode[] = []
  private linkList: SkyLink[] = []
  private active = ''
  private activeLinks = new Set<string>()
  private width = 1
  private height = 1
  private frame = 0
  private time = 0
  private dirty = true
  private running = true
  private reducedMotion: boolean
  private readonly pan = new THREE.Vector2()
  private readonly panTarget = new THREE.Vector2()
  private readonly focus = new THREE.Vector2()
  private readonly focusTarget = new THREE.Vector2()
  private drag: { id: number; x: number; y: number; start: THREE.Vector2; moved: boolean } | null = null
  private readonly observer: ResizeObserver
  private readonly projectVector = new THREE.Vector3()

  constructor(private readonly container: HTMLElement, private readonly options: SkyOptions) {
    this.reducedMotion = options.reducedMotion
    this.low = window.matchMedia('(max-width: 680px), (pointer: coarse)').matches
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.low ? 1.5 : 1.75))
    this.renderer.setClearColor(0x000000, 1)
    container.appendChild(this.renderer.domElement)
    this.camera.position.set(0, 0, CAMERA_Z)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType })
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const bloom = new BloomEffect({
      mipmapBlur: true, luminanceThreshold: 0.3, luminanceSmoothing: 0.25, intensity: 1.25, radius: 0.8,
      levels: this.low ? 6 : 8,
    })
    const grain = new NoiseEffect({ blendFunction: BlendFunction.SCREEN, premultiply: false })
    grain.blendMode.opacity.value = 0.012
    this.composer.addPass(new EffectPass(
      this.camera, bloom, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
      new VignetteEffect({ offset: 0.3, darkness: 0.6 }), grain,
    ))

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl.fullscreenVertex, fragmentShader: glsl.skyFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTop: { value: color('#0a0d26') }, uMid: { value: color('#121739') }, uBottom: { value: color('#151b41') },
        uNebula: { value: color('#26306e', 0.3) }, uBand: { value: color('#4a5aa6', 0.42) },
        uBandWarm: { value: color('#a7836b', 0.25) },
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
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() }, uTwinkle: { value: 0.22 } },
    })
    this.buildDust()
    this.buildBokeh()

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
    this.loop()
  }

  setNodes(nodes: SkyNode[]) {
    for (const star of this.stars.values()) {
      this.scene.remove(star.mesh)
      star.material.dispose()
    }
    this.stars.clear()
    nodes.forEach((node, index) => {
      const halo = STAR.idle.halo.clone().lerp(color(node.tint), 0.22)
      const material = additive({
        vertexShader: glsl.billboardVertex, fragmentShader: glsl.starFragment,
        uniforms: {
          uScale: { value: STAR.idle.scale }, uCore: { value: STAR.idle.core.clone() }, uHalo: { value: halo.clone() },
          uIntensity: { value: STAR.idle.intensity }, uSpike: { value: STAR.idle.spike }, uTime: { value: 0 },
          uPhase: { value: index * 1.7 },
        },
      })
      const mesh = new THREE.Mesh(this.billboard, material)
      mesh.frustumCulled = false
      mesh.renderOrder = 5
      this.scene.add(mesh)
      this.stars.set(node.id, { node, mesh, material, halo })
    })
    this.nodes = nodes
    this.layout()
  }

  setLinks(links: SkyLink[]) {
    this.linkList = links.filter(link => link.from !== link.to)
    this.layout()
  }

  setActive(id: string, activeLinks: Iterable<string>) {
    this.active = id
    this.activeLinks = new Set(activeLinks)
    const node = this.nodes.find(item => item.id === id)
    // Ease the camera a little towards the focused star, as if leaning in.
    this.focusTarget.set(node && !this.reducedMotion ? (node.x - 0.5) * 0.9 : 0, node && !this.reducedMotion ? (0.5 - node.y) * 0.4 : 0)
    this.wake()
  }

  setReducedMotion(value: boolean) {
    this.reducedMotion = value
    this.wake()
  }

  dispose() {
    this.running = false
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('webglcontextlost', this.onContextLost)
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    document.removeEventListener('visibilitychange', this.onVisibility)
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

  // ---------------------------------------------------------------- layout

  private worldAt(x: number, y: number, z: number, target = new THREE.Vector3()) {
    const half = (CAMERA_Z - z) * Math.tan(THREE.MathUtils.degToRad(FOV) / 2)
    return target.set((x * 2 - 1) * half * this.camera.aspect, (1 - y * 2) * half, z)
  }

  private pixelsToWorld(pixels: number, z: number) {
    const half = (CAMERA_Z - z) * Math.tan(THREE.MathUtils.degToRad(FOV) / 2)
    return (pixels / this.height) * half * 2
  }

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
    const scale = this.low ? 0.5 : 0.65
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
    const scale = Math.min(1.1, Math.max(0.72, this.height / 1000)) * (this.width < 680 ? 0.8 : 1)
    for (const star of this.stars.values()) {
      this.worldAt(star.node.x, star.node.y, star.node.depth, star.mesh.position)
      star.material.userData.scale = scale
    }
    this.layoutLinks()
    this.layoutOrbits()
    this.layoutBokeh()
    this.layoutBand()
    this.wake()
  }

  private layoutLinks() {
    for (const object of this.links.values()) {
      this.scene.remove(object.mesh)
      object.mesh.geometry.dispose()
      object.material.dispose()
    }
    this.links.clear()
    for (const link of this.linkList) {
      const from = this.stars.get(link.from)
      const to = this.stars.get(link.to)
      if (!from || !to) continue
      const start = from.mesh.position
      const end = to.mesh.position
      const delta = end.clone().sub(start)
      // Sag downwards (or to the right for steep links) so lines read as hanging threads.
      let normal = new THREE.Vector3(-delta.y, delta.x, 0).normalize()
      if (Math.abs(delta.x) > Math.abs(delta.y) * 0.5 ? normal.y > 0 : normal.x < 0) normal.negate()
      const sag = Math.min(delta.length() * 0.17, 1.5)
      const curve = new THREE.CubicBezierCurve3(
        start.clone(),
        start.clone().addScaledVector(delta, 0.34).addScaledVector(normal, sag).add(new THREE.Vector3(0, 0, 0.8)),
        start.clone().addScaledVector(delta, 0.72).addScaledVector(normal, sag * 0.55).add(new THREE.Vector3(0, 0, 0.6)),
        end.clone(),
      )
      const samples = curve.getSpacedPoints(64)
      const material = additive({
        vertexShader: glsl.ribbonVertex, fragmentShader: glsl.ribbonFragment,
        uniforms: {
          uResolution: { value: new THREE.Vector2(this.width, this.height) }, uWidth: { value: LINK.idle.width },
          uEnd: { value: LINK.idle.end.clone() }, uMid: { value: LINK.idle.mid.clone() },
          uIntensity: { value: LINK.idle.intensity }, uOpacity: { value: LINK.idle.opacity },
          uDash: { value: Math.round(delta.length() * 9) }, uPulse: { value: 0 }, uTime: { value: 0 },
        },
      })
      const mesh = new THREE.Mesh(ribbonGeometry(samples), material)
      mesh.frustumCulled = false
      mesh.renderOrder = 2
      this.scene.add(mesh)
      this.links.set(link.id, { link, mesh, material, samples, projected: [] })
    }
  }

  private layoutOrbits() {
    for (const mesh of this.orbits) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.orbits.length = 0
    for (const [cx, cy, rx, ry, rotation, from, to] of ORBITS) {
      const points: THREE.Vector3[] = []
      const aspect = this.height / this.width
      for (let i = 0; i <= 160; i += 1) {
        const angle = from + (to - from) * (i / 160)
        const x = Math.cos(angle) * rx * aspect
        const y = Math.sin(angle) * ry
        const px = cx + (x * Math.cos(rotation) - y * Math.sin(rotation)) / aspect
        const py = cy + x * Math.sin(rotation) + y * Math.cos(rotation)
        points.push(this.worldAt(px, py, -2.5 + Math.sin(angle) * 1.5))
      }
      const material = additive({
        vertexShader: glsl.ribbonVertex, fragmentShader: glsl.ribbonFragment,
        uniforms: {
          uResolution: { value: new THREE.Vector2(this.width, this.height) }, uWidth: { value: 1.8 },
          uEnd: { value: color('#7f87b8') }, uMid: { value: color('#c4c9ea') }, uIntensity: { value: 0.2 },
          uOpacity: { value: 1 }, uDash: { value: 260 }, uPulse: { value: 0 }, uTime: { value: 0 },
        },
      })
      const mesh = new THREE.Mesh(ribbonGeometry(points), material)
      mesh.frustumCulled = false
      mesh.renderOrder = 1
      this.scene.add(mesh)
      this.orbits.push(mesh)
    }
  }

  private buildBokeh() {
    BOKEH.forEach((spec, index) => {
      const material = additive({
        vertexShader: glsl.billboardVertex, fragmentShader: glsl.bokehFragment,
        uniforms: {
          uScale: { value: 1 }, uColor: { value: color(index % 4 === 3 ? '#ffd9a8' : '#ffb466', 1.5) },
          uOpacity: { value: spec[3] }, uTime: { value: 0 }, uPhase: { value: index * 2.3 },
        },
      })
      const mesh = new THREE.Mesh(this.billboard, material)
      mesh.frustumCulled = false
      mesh.renderOrder = 8
      this.scene.add(mesh)
      this.bokeh.push({ mesh, material, spec })
    })
  }

  private layoutBokeh() {
    for (const { mesh, material, spec } of this.bokeh) {
      const z = 7
      this.worldAt(spec[0], spec[1], z, mesh.position)
      material.uniforms.uScale.value = this.pixelsToWorld(spec[2] * (this.height / 1058), z)
    }
  }

  private points(count: number, place: (random: () => number, i: number) => [THREE.Vector3, number, THREE.Color], seed: number) {
    const random = seeded(seed)
    const position = new Float32Array(count * 3)
    const size = new Float32Array(count)
    const tint = new Float32Array(count * 3)
    const phase = new Float32Array(count)
    for (let i = 0; i < count; i += 1) {
      const [point, pixels, light] = place(random, i)
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
    points.renderOrder = 0
    return points
  }

  private buildDust() {
    const blue = color('#c8d2ff')
    const warm = color('#ffd2a6')
    const far = this.points(this.low ? 600 : 1100, random => [
      new THREE.Vector3((random() - 0.5) * 95, (random() - 0.5) * 60, -42 + random() * 14),
      0.9 + random() * 1.5,
      (random() > 0.22 ? blue : warm).clone().multiplyScalar(0.08 + Math.pow(random(), 2) * 0.55),
    ], 7)
    const mid = this.points(this.low ? 50 : 90, random => [
      new THREE.Vector3((random() - 0.5) * 50, (random() - 0.5) * 32, -14 + random() * 8),
      1.8 + random() * 2.6,
      (random() > 0.35 ? blue : warm).clone().multiplyScalar(0.6 + Math.pow(random(), 3) * 2.2),
    ], 11)
    const specks = this.points(this.low ? 16 : 26, random => [
      new THREE.Vector3((random() - 0.5) * 34, (random() - 0.65) * 22, -3 + random() * 6),
      2.2 + random() * 2,
      color('#ffb066').multiplyScalar(0.9 + random() * 2.2),
    ], 23)
    this.dust.push(far, mid, specks)
    this.scene.add(far, mid, specks)
  }

  private layoutBand() {
    const old = this.dust[3]
    if (old) {
      this.scene.remove(old)
      old.geometry.dispose()
    }
    // Fine dust that follows the milky band painted into the sky texture.
    const z = -26
    const band = this.points(this.low ? 1800 : 5200, random => {
      const x = 0.36 + Math.pow(random(), 0.8) * 0.72
      const spread = (random() + random() + random() - 1.5) * 0.07
      const y = 1 - (0.02 + 0.62 * (x - 0.42)) + spread
      const bright = Math.pow(random(), 4)
      return [this.worldAt(x, y, z - random() * 6), 0.7 + bright * 2.2,
        color(random() > 0.15 ? '#b9c6ff' : '#ffd9b5').multiplyScalar(0.12 + bright * 0.9)]
    }, 31)
    this.dust[3] = band
    this.scene.add(band)
  }

  // ---------------------------------------------------------------- loop

  private wake() {
    this.dirty = true
    if (!this.frame && this.running) this.frame = requestAnimationFrame(this.loop)
  }

  private readonly loop = () => {
    this.frame = 0
    if (!this.running) return
    const delta = Math.min(this.clock.getDelta(), 0.05)
    const animate = !this.reducedMotion
    if (animate) this.time += delta
    const rate = animate ? 1 - Math.pow(0.0015, delta) : 1
    this.pan.lerp(this.panTarget, rate)
    this.focus.lerp(this.focusTarget, rate * 0.7)
    const drift = animate ? new THREE.Vector2(Math.sin(this.time * 0.07) * 0.22, Math.cos(this.time * 0.053) * 0.14) : new THREE.Vector2()
    this.camera.position.set(this.pan.x + this.focus.x + drift.x, this.pan.y + this.focus.y + drift.y, CAMERA_Z)
    this.camera.lookAt(this.focus.x * 0.35, this.focus.y * 0.35, 0)
    this.camera.updateMatrixWorld()
    this.skyCopy.uniforms.uShift.value.set(-(this.pan.x + this.focus.x) * 0.0035, -(this.pan.y + this.focus.y) * 0.0035)

    let settling = false
    for (const [id, star] of this.stars) {
      const target = id === this.active ? STAR.active : STAR.idle
      const u = star.material.uniforms
      const scale = (star.material.userData.scale ?? 1) * target.scale
      const intensity = id === this.active || !this.active ? target.intensity : target.intensity * 0.88
      u.uScale.value += (scale - u.uScale.value) * rate
      u.uIntensity.value += (intensity - u.uIntensity.value) * rate
      u.uSpike.value += (target.spike - u.uSpike.value) * rate
      u.uCore.value.lerp(target.core, rate)
      u.uHalo.value.lerp(id === this.active ? STAR.active.halo : star.halo, rate)
      u.uTime.value = this.time
      settling ||= Math.abs(scale - u.uScale.value) > 0.002
    }
    for (const [id, object] of this.links) {
      const target = this.activeLinks.has(id) ? LINK.active : LINK.idle
      const u = object.material.uniforms
      u.uWidth.value += (target.width - u.uWidth.value) * rate
      u.uIntensity.value += (target.intensity - u.uIntensity.value) * rate
      u.uOpacity.value += (target.opacity - u.uOpacity.value) * rate
      u.uPulse.value += ((animate ? target.pulse : 0) - u.uPulse.value) * rate
      u.uEnd.value.lerp(target.end, rate)
      u.uMid.value.lerp(target.mid, rate)
      u.uTime.value = this.time
      u.uResolution.value.set(this.width, this.height)
      u.uDash.value = this.activeLinks.has(id) ? 0 : Math.round(object.samples[0].distanceTo(object.samples[object.samples.length - 1]) * 9)
      settling ||= Math.abs(target.width - u.uWidth.value) > 0.05
    }
    for (const mesh of this.orbits) (mesh.material as THREE.ShaderMaterial).uniforms.uResolution.value.set(this.width, this.height)
    for (const { material } of this.bokeh) material.uniforms.uTime.value = this.time
    this.dustMaterial.uniforms.uTime.value = this.time
    this.dustMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio()
    settling ||= this.pan.distanceToSquared(this.panTarget) > 1e-5 || this.focus.distanceToSquared(this.focusTarget) > 1e-5

    if (animate || this.dirty || settling) {
      this.composer.render(delta)
      this.emitFrame()
      this.dirty = false
    }
    if (animate || settling) this.frame = requestAnimationFrame(this.loop)
  }

  private project(point: THREE.Vector3): Point {
    this.projectVector.copy(point).project(this.camera)
    return { x: (this.projectVector.x + 1) * this.width * 0.5, y: (1 - this.projectVector.y) * this.height * 0.5 }
  }

  private emitFrame() {
    const nodes = new Map<string, Point>()
    for (const [id, star] of this.stars) nodes.set(id, this.project(star.mesh.position))
    const links = new Map<string, Point>()
    for (const [id, object] of this.links) {
      object.projected = object.samples.filter((_, i) => i % 4 === 0 || i === object.samples.length - 1).map(point => this.project(point))
      links.set(id, this.project(object.samples[Math.floor(object.samples.length / 2)]))
    }
    this.options.onFrame({ width: this.width, height: this.height, nodes, links })
  }

  // ---------------------------------------------------------------- input

  private pick(x: number, y: number) {
    const point = { x, y }
    let star: string | undefined
    let best = 34
    for (const [id, object] of this.stars) {
      const at = this.project(object.mesh.position)
      const distance = Math.hypot(at.x - x, at.y - y)
      if (distance < best) { best = distance; star = id }
    }
    if (star) return { star }
    const link = [...this.links.values()]
      .filter(object => this.activeLinks.has(object.link.id))
      .find(object => object.projected.some((p, i, all) => i > 0 && distanceToSegment(point, all[i - 1], p) < 12))
    return link ? { link: link.link.id } : {}
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: this.panTarget.clone(), moved: false }
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const canvas = this.renderer.domElement
    if (!this.drag) {
      const rect = canvas.getBoundingClientRect()
      const hit = this.pick(event.clientX - rect.left, event.clientY - rect.top)
      canvas.style.cursor = hit.star || hit.link ? 'pointer' : 'grab'
      return
    }
    const dx = event.clientX - this.drag.x
    const dy = event.clientY - this.drag.y
    if (Math.hypot(dx, dy) > 5) this.drag.moved = true
    if (!this.drag.moved || this.reducedMotion) return
    canvas.style.cursor = 'grabbing'
    this.panTarget.set(
      THREE.MathUtils.clamp(this.drag.start.x - dx * 0.012, -2.6, 2.6),
      THREE.MathUtils.clamp(this.drag.start.y + dy * 0.012, -1.8, 1.8),
    )
    this.wake()
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag
    this.drag = null
    const canvas = this.renderer.domElement
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    canvas.style.cursor = 'grab'
    if (!drag || drag.moved || event.type === 'pointercancel') return
    const rect = canvas.getBoundingClientRect()
    const hit = this.pick(event.clientX - rect.left, event.clientY - rect.top)
    if (hit.star) this.options.onStar(hit.star)
    else if (hit.link) this.options.onLink(hit.link)
  }

  private readonly onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    } else {
      this.clock.getDelta()
      this.wake()
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
    this.wake()
  }
}
