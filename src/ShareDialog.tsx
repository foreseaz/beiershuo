import { useEffect, useState } from 'react'
import { Download, Link2, Share2, X } from 'lucide-react'
import { entityPath, type Entity, type Episode, type Moment } from './domain'
import { renderShareCard } from './shareCard'

type Props = {
  entity: Entity
  tint: string
  maker?: string
  episodes: Map<string, Episode>
  moments: Map<string, Moment>
  onClose: () => void
}

/** Preview the share card, then save it, hand it to the system share sheet, or copy the page link. */
export function ShareDialog({ entity, tint, maker, episodes, moments, onClose }: Props) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [preview, setPreview] = useState('')
  const [note, setNote] = useState('')
  const url = `${window.location.origin}${entityPath(entity)}`
  const file = blob ? new File([blob], `贝儿说-${entity.name}.png`, { type: 'image/png' }) : null
  const canShareFile = Boolean(file && navigator.canShare?.({ files: [file] }))

  useEffect(() => {
    let live = true
    let objectUrl = ''
    renderShareCard({ entity, url, tint, maker, episodes, moments })
      .then(result => {
        if (!live) return
        objectUrl = URL.createObjectURL(result)
        setBlob(result)
        setPreview(objectUrl)
      })
      .catch(() => live && setNote('卡片生成失败，请稍后再试'))
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [entity, url, tint, maker, episodes, moments])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const share = async () => {
    if (!file) return
    try {
      await navigator.share({ files: [file], title: `贝儿说 · ${entity.name}`, url })
    } catch {
      // Dismissing the share sheet is not an error worth showing.
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
    <div className="share" role="dialog" aria-modal="true" aria-label={`分享「${entity.name}」`}>
      <button className="share-scrim" type="button" aria-label="关闭" onClick={onClose} />
      <div className="share-panel">
        <button className="icon-button share-close" type="button" aria-label="关闭" onClick={onClose}><X size={17} aria-hidden="true" /></button>
        <div className="share-preview">
          {preview ? <img src={preview} alt={`「${entity.name}」的分享卡片`} /> : <p className="share-wait">{note || '正在生成卡片…'}</p>}
        </div>
        <div className="share-actions">
          {canShareFile && <button type="button" onClick={share}><Share2 size={15} aria-hidden="true" /> 分享</button>}
          <a className={blob ? '' : 'is-disabled'} href={preview || undefined} download={`贝儿说-${entity.name}.png`}>
            <Download size={15} aria-hidden="true" /> 保存图片
          </a>
          <button type="button" onClick={copy}><Link2 size={15} aria-hidden="true" /> 复制链接</button>
        </div>
        {note && preview && <p className="share-note">{note}</p>}
      </div>
    </div>
  )
}
