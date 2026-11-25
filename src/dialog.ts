import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export const PHONE_QUERY = '(max-width: 680px), (pointer: coarse) and (max-height: 560px)'

export function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useLayoutEffect(() => {
    const query = window.matchMedia(PHONE_QUERY)
    const update = () => setPhone(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

/** Let the browser manage focus, Escape, and the inert page behind a modal. */
export function useDialog(ref: RefObject<HTMLDialogElement | null>, modal = true) {
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement
    if (modal) dialog.showModal()
    else dialog.show()
    return () => {
      dialog.close()
      if (modal && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [ref, modal])
}

/** The iOS keyboard shrinks the visual viewport while fixed elements keep the layout viewport. */
export function useKeyboardViewport(ref: RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport
    const dialog = ref.current
    if (!viewport || !dialog) return
    const update = () => {
      if (viewport.scale === 1 && viewport.height < window.innerHeight - 1) {
        dialog.style.setProperty('--keyboard-top', `${viewport.offsetTop}px`)
        dialog.style.setProperty('--keyboard-height', `${viewport.height}px`)
      } else {
        dialog.style.removeProperty('--keyboard-top')
        dialog.style.removeProperty('--keyboard-height')
      }
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [ref])
}

export function useDialogExit(onClose: () => void) {
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useLayoutEffect(() => () => window.clearTimeout(timer.current), [])

  const close = useCallback(() => {
    if (timer.current !== undefined) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose()
      return
    }
    setLeaving(true)
    timer.current = window.setTimeout(onClose, 220)
  }, [onClose])

  return { leaving, close }
}
