import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { useDialog, useDialogExit } from './dialog'
import { useSheetDrag } from './sheet'

type Props = {
  label: string
  /** Changes with the page shown, so the panel scrolls back to the top. */
  page: string
  canBack: boolean
  onBack: () => void
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/**
 * The shell for people, books, films, concepts and their indexes. On wide screens it is a panel over the right of
 * the sky; on phones it is a sheet that rises from the bottom and can be dragged back down. ✕, Esc or a tap on the
 * visible sky goes straight back to the map, however deep you are; ← steps back one page inside the panel.
 */
export function Overlay({ label, page, canBack, onBack, onClose, children, footer }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const grip = useRef<HTMLElement>(null)
  const { leaving, close } = useDialogExit(onClose)
  useDialog(dialog)
  useSheetDrag({ sheet: panel, handle: grip, scroller: scroll, onDismiss: onClose })

  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 })
  }, [page])

  return (
    <dialog ref={dialog} className={`app-dialog overlay${leaving ? ' is-leaving' : ''}`} aria-label={label}
      onCancel={event => { event.preventDefault(); close() }}>
      <button className="overlay-scrim" type="button" tabIndex={-1} aria-label="关闭，回到星图" onClick={close} />
      <div className="overlay-panel" ref={panel}>
        <header className="overlay-bar" ref={grip}>
          <span className="sheet-grip" aria-hidden="true" />
          {canBack
            ? <button className="overlay-nav" type="button" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> 上一页</button>
            : <span />}
          <span className="overlay-label">{label}</span>
          <button className="icon-button overlay-close" type="button" onClick={close} aria-label="关闭，回到星图" title="回到星图（Esc）">
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="overlay-scroll" ref={scroll}>{children}</div>
        {footer}
      </div>
    </dialog>
  )
}
