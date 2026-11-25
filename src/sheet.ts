import { useEffect, useRef, type RefObject } from 'react'
import { PHONE_QUERY } from './dialog'

/** Let go past this share of the sheet's height, or flick down faster than this (px/ms), and it closes. */
const CLOSE_DISTANCE = 0.25
const CLOSE_SPEED = 0.5
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

type Options = {
  /** The sheet that moves. Its parent gets `--sheet-drag` (0 → 1) so the scrim can fade with it. */
  sheet: RefObject<HTMLElement | null>
  /** Dragging here always moves the sheet (the header with the grip). */
  handle: RefObject<HTMLElement | null>
  /** Dragging down here moves the sheet only while the content is scrolled to its top. */
  scroller?: RefObject<HTMLElement | null>
  onDismiss: () => void
}

/**
 * Drag a phone bottom sheet down to close it, like a native sheet: it follows the finger, springs back if let go
 * early, and slides away when pulled far enough or flicked. Does nothing on wider screens.
 */
export function useSheetDrag({ sheet, handle, scroller, onDismiss }: Options) {
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    const panel = sheet.current
    const bar = handle.current
    const content = scroller?.current ?? null
    if (!panel) return
    const phone = window.matchMedia(PHONE_QUERY)
    let origin = 0
    let offset = 0
    let samples: { y: number; t: number }[] = []
    let done = false
    let timer: number | undefined

    const begin = (y: number) => {
      window.clearTimeout(timer)
      origin = y
      offset = 0
      samples = [{ y, t: performance.now() }]
    }
    const follow = (y: number) => {
      offset = Math.max(0, y - origin)
      // A little give upwards, so the sheet feels held rather than stuck.
      const shown = y < origin ? -Math.min(14, Math.sqrt(origin - y) * 2) : offset
      panel.style.transition = 'none'
      panel.style.transform = `translate3d(0, ${shown.toFixed(1)}px, 0)`
      const fraction = Math.min(1, offset / Math.max(panel.offsetHeight, 1))
      panel.parentElement?.style.setProperty('--sheet-drag', fraction.toFixed(3))
      samples.push({ y, t: performance.now() })
      if (samples.length > 6) samples.shift()
    }
    const release = (cancelled = false) => {
      const first = samples[0]
      const last = samples[samples.length - 1]
      const speed = first && last && performance.now() - last.t < 90 && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0
      const close = !cancelled && (offset > panel.offsetHeight * CLOSE_DISTANCE || (speed > CLOSE_SPEED && offset > 24))
      const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280
      panel.style.transition = `transform ${duration}ms ${EASE}`
      panel.style.transform = close ? 'translate3d(0, 100%, 0)' : ''
      panel.parentElement?.style.setProperty('--sheet-drag', close ? '1' : '0')
      if (close) {
        done = true
        timer = window.setTimeout(() => dismiss.current(), duration)
      } else {
        timer = window.setTimeout(() => { panel.style.transition = '' }, duration)
      }
    }

    // The header: a press that moves more than a few px becomes a drag; a still press stays a click on its buttons.
    let pointer: number | null = null
    let pointerX = 0
    let dragging = false
    const onPointerDown = (event: PointerEvent) => {
      if (!phone.matches || !event.isPrimary || event.button !== 0 || done) return
      pointer = event.pointerId
      pointerX = event.clientX
      dragging = false
      begin(event.clientY)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return
      if (!dragging) {
        if (Math.abs(event.clientX - pointerX) > Math.max(6, Math.abs(event.clientY - origin))) { pointer = null; return }
        if (Math.abs(event.clientY - origin) < 6) return
        dragging = true
        bar?.setPointerCapture(event.pointerId)
      }
      follow(event.clientY)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return
      pointer = null
      if (dragging) release(event.type === 'pointercancel')
      dragging = false
    }

    // The content: pulling down from the very top moves the sheet; anything else scrolls as usual.
    let touchStart = 0
    let touchX = 0
    let atTop = false
    let pulling = false
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        if (pulling) release(true)
        atTop = pulling = false
        return
      }
      if (!phone.matches || done || !content) return
      touchStart = event.touches[0].clientY
      touchX = event.touches[0].clientX
      atTop = content.scrollTop <= 0
      pulling = false
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!atTop || event.touches.length !== 1) return
      const y = event.touches[0].clientY
      if (!pulling) {
        if (y < touchStart || Math.abs(event.touches[0].clientX - touchX) > Math.max(6, y - touchStart)) { atTop = false; return }
        if (y - touchStart < 6 || !event.cancelable) return
        pulling = true
        begin(touchStart)
      }
      event.preventDefault()
      follow(y)
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (pulling) release(event.type === 'touchcancel')
      atTop = pulling = false
    }

    bar?.addEventListener('pointerdown', onPointerDown)
    bar?.addEventListener('pointermove', onPointerMove)
    bar?.addEventListener('pointerup', onPointerUp)
    bar?.addEventListener('pointercancel', onPointerUp)
    content?.addEventListener('touchstart', onTouchStart, { passive: true })
    content?.addEventListener('touchmove', onTouchMove, { passive: false })
    content?.addEventListener('touchend', onTouchEnd)
    content?.addEventListener('touchcancel', onTouchEnd)
    return () => {
      window.clearTimeout(timer)
      bar?.removeEventListener('pointerdown', onPointerDown)
      bar?.removeEventListener('pointermove', onPointerMove)
      bar?.removeEventListener('pointerup', onPointerUp)
      bar?.removeEventListener('pointercancel', onPointerUp)
      content?.removeEventListener('touchstart', onTouchStart)
      content?.removeEventListener('touchmove', onTouchMove)
      content?.removeEventListener('touchend', onTouchEnd)
      content?.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [sheet, handle, scroller])
}
