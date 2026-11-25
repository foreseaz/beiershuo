import { useEffect, useRef, useState } from 'react'
import { Download, Link2, Share2, X } from 'lucide-react'
import { type Episode, type Moment } from './domain'
import { useDialog, useDialogExit } from './dialog'
import { renderShareCard, type ShareSubject } from './shareCard'
import { useSheetDrag } from './sheet'

type Props = {
  subject: ShareSubject
  path: string
  episodes: Map<string, Episode>
  moments: Map<string, Moment>
  onClose: () => void
}

/**
 * Preview the share card over a blurred sky, then hand it to the system share sheet, save it, or copy the page link.
 * On phones the card sits above a tray of large buttons that can be dragged down to close.
 */
export function ShareDialog({ subject, path, episodes, moments, onClose }: Props) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [preview, setPreview] = useState('')
  const [failed, setFailed] = useState(false)
  const [note, setNote] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const tray = useRef<HTMLDivElement>(null)
  const { leaving, close } = useDialogExit(onClose)
  const url = new URL(path, window.location.origin).href
  const title = subject.kind === 'entity' ? subject.entity.name : subject.episode.title
  const name = `贝儿说-${title.replace(/[\\/:*?"<>|]/g, ' ')}.png`
  const file = blob ? new File([blob], name, { type: 'image/png' }) : null
  const canShareFile = Boolean(file && navigator.canShare?.({ files: [file] }))

  useDialog(dialog)
  useSheetDrag({ sheet: tray, handle: tray, onDismiss: onClose })

  useEffect(() => {
    let live = true
    let objectUrl = ''
    renderShareCard({ subject, url, episodes, moments })
      .then(result => {
        if (!live) return
        objectUrl = URL.createObjectURL(result)
        setBlob(result)
        setPreview(objectUrl)
      })
      .catch(() => { if (live) setFailed(true) })
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [subject, url, episodes, moments])

  const share = async () => {
    if (!file) return
    try {
      await navigator.share({ files: [file], title: `贝儿说 · ${title}`, url })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setNote('暂时无法分享，请保存图片或复制链接')
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setNote('链接已复制')
    } catch {
      setNote(url)
    }
  }

  return (
    <dialog ref={dialog} className={`app-dialog share${leaving ? ' is-leaving' : ''}`} aria-label={`分享「${title}」`}
      onCancel={event => { event.preventDefault(); close() }}>
      <button className="share-scrim" type="button" aria-label="关闭" tabIndex={-1} onClick={close} />
      <button className="share-close" type="button" aria-label="关闭" onClick={close}><X size={18} aria-hidden="true" /></button>
      <div className="share-stage">
        {preview
          ? <img className="share-card" src={preview} alt={`「${title}」的分享卡片`} />
          : <div className={`share-skeleton${failed ? ' is-failed' : ''}`} role="status"><span>{failed ? '卡片生成失败，请稍后再试' : '正在生成卡片…'}</span></div>}
      </div>
      <div className="share-tray" ref={tray}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="share-actions">
          {canShareFile && (
            <button type="button" onClick={share}>
              <span className="share-action-icon"><Share2 size={19} aria-hidden="true" /></span>分享
            </button>
          )}
          <a className={blob ? '' : 'is-disabled'} href={preview || undefined} download={name} aria-disabled={!blob}>
            <span className="share-action-icon"><Download size={19} aria-hidden="true" /></span>保存图片
          </a>
          <button type="button" onClick={copy}>
            <span className="share-action-icon"><Link2 size={19} aria-hidden="true" /></span>复制链接
          </button>
        </div>
        <p className="share-note" aria-live="polite">{note}</p>
      </div>
    </dialog>
  )
}
