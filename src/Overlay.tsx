import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'

type Props = {
  label: string
  /** Changes with the page shown, so the panel scrolls back to the top. */
  page: string
  canBack: boolean
  onBack: () => void
  onClose: () => void
  children: ReactNode
}

/**
 * The shell for people, books, films, concepts and their indexes: a panel over the right of the
 * sky. ✕, Esc or a click on the visible sky goes straight back to the map, however deep you are;
 * ← steps back one page inside the panel.
 */
export function Overlay({ label, page, canBack, onBack, onClose, children }: Props) {
  const scroll = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 })
  }, [page])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={label}>
      <button className="overlay-scrim" type="button" aria-label="关闭，回到星图" onClick={onClose} />
      <div className="overlay-panel">
        <header className="overlay-bar">
          {canBack
            ? <button className="overlay-nav" type="button" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> 上一页</button>
            : <span />}
          <span className="overlay-label">{label}</span>
          <button className="icon-button overlay-close" type="button" onClick={onClose} aria-label="关闭，回到星图" title="回到星图（Esc）">
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="overlay-scroll" ref={scroll}>{children}</div>
      </div>
    </div>
  )
}
