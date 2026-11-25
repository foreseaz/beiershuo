import { GalaxyScene, type GalaxyFrame, type Nebula, type SubStar, type Thread } from './GalaxyScene'

export type GalaxyStill = {
  /** The rendered sky, `width` × `height` px. */
  image: HTMLCanvasElement
  /** Where each nebula and star landed, in the image's px. */
  frame: GalaxyFrame
}

const noop = () => {}

/**
 * Draw the star map once, off screen, for a share card: the same scene the site shows, at width × height px. The
 * scene is laid out at `width / pixelRatio` CSS px, so stars, glows and dust keep the proportions they have on a phone.
 * Resolves with the picture and the frame's positions (scaled to the picture), then throws the scene away.
 */
export function renderGalaxyStill(
  { nebulae, stars, threads }: { nebulae: Nebula[]; stars: SubStar[]; threads: Thread[] },
  width: number,
  height: number,
  pixelRatio = 2.5,
): Promise<GalaxyStill> {
  if (!GalaxyScene.supported()) return Promise.reject(new Error('WebGL unavailable'))
  const host = document.createElement('div')
  const cssWidth = width / pixelRatio
  const cssHeight = height / pixelRatio
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:fixed;left:${-cssWidth - 200}px;top:0;width:${cssWidth}px;height:${cssHeight}px;pointer-events:none;`
  document.body.appendChild(host)

  return new Promise((resolve, reject) => {
    let scene: GalaxyScene | null = null
    let settled = false
    const finish = (error: Error | null, still?: GalaxyStill) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      // Let the frame that called back finish before the scene goes.
      window.setTimeout(() => {
        scene?.dispose()
        host.remove()
      })
      if (error) reject(error)
      else resolve(still!)
    }
    const timer = window.setTimeout(() => finish(new Error('星图渲染超时')), 8000)
    try {
      scene = new GalaxyScene(host, {
        still: { pixelRatio },
        reducedMotion: true,
        // Called straight after a render, while the drawing buffer still holds that frame.
        onFrame: frame => {
          if (settled || frame.nebulae.size < nebulae.length) return
          const source = host.querySelector('canvas')
          if (!source) return finish(new Error('星图渲染失败'))
          const image = document.createElement('canvas')
          image.width = width
          image.height = height
          image.getContext('2d')!.drawImage(source, 0, 0, width, height)
          const scale = width / frame.width
          const nebulaPoints = new Map([...frame.nebulae].map(([id, point]) => [id, { x: point.x * scale, y: point.y * scale, radius: point.radius * scale }]))
          const starPoints = new Map([...frame.stars].map(([id, point]) => [id, { x: point.x * scale, y: point.y * scale }]))
          finish(null, { image, frame: { ...frame, width, height, nebulae: nebulaPoints, stars: starPoints } })
        },
        onNebula: noop, onStar: noop, onThread: noop, onHover: noop, onHoverStar: noop, onGesture: noop, onView: noop, onEmpty: noop,
      })
      scene.setGalaxy(nebulae, stars, threads)
    } catch (error) {
      finish(error instanceof Error ? error : new Error('星图渲染失败'))
    }
  })
}
