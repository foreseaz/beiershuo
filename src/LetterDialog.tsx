import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BookHeart, Check, Lock, NotebookPen, PenLine, Phone, Send, Tv, UserRound, X } from 'lucide-react'
import { track } from './analytics'
import { PHONE_QUERY, useDialog, useKeyboardViewport } from './dialog'
import { LETTER_LIMITS, readDraft, saveDraft, sendLetter, type LetterAbout } from './letters'
import { ApplePodcastsIcon, XiaoyuzhouIcon } from './platforms'

type Props = {
  /** Where the dialog was opened from, for statistics: the top bar or the player. */
  from: string
  about: LetterAbout | null
  xiaoyuzhouUrl: string
  appleUrl?: string
  onClose: () => void
}

type Channel = { id: string; name: string; hint: string; url: string; icon: ReactNode }

/** The places 贝儿 already reads, for those who would rather write there. */
function channels(xiaoyuzhouUrl: string, appleUrl?: string): Channel[] {
  return [
    { id: 'xiaoyuzhou', name: '小宇宙', hint: '在单集下面评论', url: xiaoyuzhouUrl, icon: <XiaoyuzhouIcon size={16} /> },
    ...(appleUrl ? [{ id: 'apple', name: 'Apple 播客', hint: '评分，写评论', url: appleUrl, icon: <ApplePodcastsIcon size={16} /> }] : []),
    { id: 'questions', name: '咨询师回信 · 提问', hint: '问题征集表：想请咨询师在节目里回信', url: 'https://jsj.top/f/Od5kZB', icon: <NotebookPen size={15} /> },
    { id: 'xiaohongshu', name: '小红书 @倪贝儿', hint: '贝儿自己的账号', url: 'https://www.xiaohongshu.com/user/profile/5a9e5c8e11be102e2a1ab3cf', icon: <BookHeart size={15} /> },
    { id: 'xiaohongshu-show', name: '小红书 @次要人生', hint: '节目的账号', url: 'https://www.xiaohongshu.com/user/profile/67bde3b9000000000a03c355', icon: <BookHeart size={15} /> },
    { id: 'bilibili', name: 'B站', hint: 'B站 · 倪贝儿3：视频版节目', url: 'https://space.bilibili.com/12018873', icon: <Tv size={15} /> },
  ]
}

/**
 * A letter to 贝儿 about the show as a whole, or about the segment it was opened from. It is not shown anywhere on the
 * site; the Worker keeps it for 贝儿 (see README · 留言). The draft survives closing the dialog by mistake.
 */
export function LetterDialog({ from, about: openedAbout, xiaoyuzhouUrl, appleUrl, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  useDialog(dialog)
  useKeyboardViewport(dialog)
  const [about, setAbout] = useState(openedAbout)
  const [body, setBody] = useState(readDraft)
  const [signing, setSigning] = useState(false)
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [website, setWebsite] = useState('')
  const [state, setState] = useState<'writing' | 'sending' | 'sent'>('writing')
  const [error, setError] = useState('')
  // A phone would raise its keyboard before anyone has seen the dialog.
  const [focusFirst] = useState(() => !window.matchMedia(PHONE_QUERY).matches)

  useEffect(() => saveDraft(body), [body])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (state === 'sending') return
    if (!body.trim()) {
      setError('先写点什么吧。')
      return
    }
    setState('sending')
    setError('')
    const failure = await sendLetter({
      body, name, contact, website,
      about: about?.label ?? '',
      page: about?.page ?? window.location.pathname + window.location.search,
    })
    if (failure) {
      setError(failure)
      setState('writing')
      return
    }
    track('letter_sent', { from, about: about?.label ?? null, with_name: Boolean(name.trim()), with_contact: Boolean(contact.trim()) })
    setBody('')
    setState('sent')
  }

  return (
    <dialog ref={dialog} className="app-dialog search letter" aria-label="给贝儿留言" onCancel={event => {
      event.preventDefault()
      onClose()
    }}>
      <button className="search-scrim" type="button" tabIndex={-1} aria-label="关闭" onClick={onClose} />
      <div className="search-sheet letter-sheet">
        <div className="letter-head">
          <h2 className="letter-title">给贝儿留言</h2>
          <button className="icon-button letter-close" type="button" aria-label="关闭" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </div>

        <div className="letter-body">
          {state === 'sent' ? (
            <div className="letter-sent" role="status">
              <span className="letter-sent-mark" aria-hidden="true"><Check size={20} strokeWidth={1.8} /></span>
              <p className="letter-sent-title">收到了，谢谢你</p>
              <button className="letter-link" type="button" onClick={() => { setAbout(null); setState('writing') }}>
                <PenLine size={14} aria-hidden="true" />再写一封
              </button>
            </div>
          ) : (
            <form className="letter-form" onSubmit={submit} noValidate>
              {about && (
                <p className="letter-about">
                  <span className="letter-about-text">关于 {about.label}</span>
                  <button type="button" aria-label="不针对这一段" title="不针对这一段" onClick={() => setAbout(null)}>
                    <X size={13} aria-hidden="true" />
                  </button>
                </p>
              )}
              <textarea
                className="letter-text"
                value={body}
                onChange={event => { setBody(event.target.value); setError('') }}
                maxLength={LETTER_LIMITS.body}
                rows={6}
                placeholder="想对贝儿说的话、你的故事、想听的话题……"
                aria-label="留言"
                autoFocus={focusFirst}
              />
              {body.length > LETTER_LIMITS.body - 200 && (
                <p className="letter-count" aria-live="polite">{body.length} / {LETTER_LIMITS.body}</p>
              )}
              {signing ? (
                <div className="letter-fields">
                  <input value={name} onChange={event => setName(event.target.value)} maxLength={LETTER_LIMITS.name}
                    placeholder="称呼" aria-label="称呼，可不填" autoComplete="nickname" autoFocus />
                  <input value={contact} onChange={event => setContact(event.target.value)} maxLength={LETTER_LIMITS.contact}
                    placeholder="邮箱或小红书号，想收到回复的话" aria-label="联系方式，可不填" autoComplete="off" />
                </div>
              ) : (
                <button className="letter-link" type="button" onClick={() => setSigning(true)}>
                  <UserRound size={14} aria-hidden="true" />留个称呼或联系方式
                </button>
              )}
              {/* People never see this field; bots that fill it in are told the letter was sent. */}
              <input className="letter-trap" name="website" value={website} onChange={event => setWebsite(event.target.value)}
                tabIndex={-1} autoComplete="off" aria-hidden="true" />
              {error && <p className="letter-error" role="alert">{error}</p>}
              <div className="letter-send-row">
                <span className="letter-private"><Lock size={12} aria-hidden="true" />不会公开</span>
                <button className="letter-send" type="submit" disabled={state === 'sending'}>
                  <Send size={15} aria-hidden="true" />{state === 'sending' ? '寄出中…' : '寄出'}
                </button>
              </div>
            </form>
          )}

          <div className="letter-elsewhere">
            <p className="letter-elsewhere-label">也可以在这里找到贝儿</p>
            <div className="letter-channels">
              {channels(xiaoyuzhouUrl, appleUrl).map(channel => (
                <a key={channel.id} href={channel.url} target="_blank" rel="noreferrer" title={channel.hint}
                  onClick={() => track('letter_channel_opened', { channel: channel.id })}>
                  <span className="letter-channel-icon" aria-hidden="true">{channel.icon}</span>{channel.name}
                </a>
              ))}
            </div>
            <p className="letter-care"><Phone size={12} aria-hidden="true" />难受的时候，可以先打心理援助热线 <a href="tel:12356">12356</a></p>
          </div>
        </div>
      </div>
    </dialog>
  )
}
