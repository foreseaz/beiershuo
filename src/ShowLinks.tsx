import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, BookHeart, ChevronDown, NotebookPen, Tv } from 'lucide-react'
import { track } from './analytics'
import { SHOW_XIAOYUZHOU } from './domain'
import { ApplePodcastsIcon, XiaoyuzhouIcon } from './platforms'

type Link = { id: string; name: string; hint: string; url: string; icon: ReactNode }

/** 贝儿's and the show's own places. This site is a listener's, so it sends people there rather than collecting anything. */
function links(xiaoyuzhouUrl: string, appleUrl?: string): Link[] {
  return [
    { id: 'xiaoyuzhou', name: '小宇宙', hint: '订阅，在单集下面评论', url: xiaoyuzhouUrl, icon: <XiaoyuzhouIcon size={18} /> },
    ...(appleUrl ? [{ id: 'apple', name: 'Apple 播客', hint: '订阅，评分，写评论', url: appleUrl, icon: <ApplePodcastsIcon size={18} /> }] : []),
    { id: 'xiaohongshu', name: '小红书 @倪贝儿', hint: '贝儿自己的账号', url: 'https://www.xiaohongshu.com/user/profile/5a9e5c8e11be102e2a1ab3cf', icon: <BookHeart size={17} /> },
    { id: 'xiaohongshu-show', name: '小红书 @次要人生', hint: '节目的账号', url: 'https://www.xiaohongshu.com/user/profile/67bde3b9000000000a03c355', icon: <BookHeart size={17} /> },
    { id: 'bilibili', name: 'B站 @倪贝儿3', hint: '视频版节目', url: 'https://space.bilibili.com/12018873', icon: <Tv size={17} /> },
    { id: 'questions', name: '咨询师回信 · 提问', hint: '问题征集表，想请咨询师在节目里回信', url: 'https://jsj.top/f/Od5kZB', icon: <NotebookPen size={17} /> },
  ]
}

/**
 * The show's cover and name in the brand. They open a short list of 贝儿's own channels: it rises above the brand at the
 * bottom left of wide screens, and drops below the top bar on phones. A press outside, Escape or following a link closes it.
 */
export function ShowLinks({ xiaoyuzhouUrl = SHOW_XIAOYUZHOU, appleUrl }: { xiaoyuzhouUrl?: string; appleUrl?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node && root.current?.contains(event.target))) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>('.brand-show')?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="brand-show-wrap" ref={root}>
      <button className="brand-show" type="button" aria-expanded={open} aria-controls="show-links" title="在这些地方找到贝儿"
        onClick={() => {
          if (!open) track('show_links_opened')
          setOpen(!open)
        }}>
        <img src="/brand/show-cover.png" alt="" width="30" height="30" />
        <span>次要人生</span>
        <ChevronDown className="brand-show-chevron" size={14} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {open && (
        <nav className="show-links" id="show-links" aria-label="在这些地方找到贝儿">
          <p className="show-links-label">在这些地方找到贝儿</p>
          <ul>
            {links(xiaoyuzhouUrl, appleUrl).map(link => (
              <li key={link.id}>
                <a href={link.url} target="_blank" rel="noreferrer" onClick={() => {
                  track('channel_opened', { channel: link.id })
                  setOpen(false)
                }}>
                  <span className="show-links-icon" aria-hidden="true">{link.icon}</span>
                  <span className="show-links-text">
                    <span className="show-links-name">{link.name}</span>
                    <span className="show-links-hint">{link.hint}</span>
                  </span>
                  <ArrowUpRight className="show-links-arrow" size={14} strokeWidth={1.5} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
          <p className="show-links-note">贝儿说是一位听众做的星图，不是节目的官方网站。</p>
        </nav>
      )}
    </div>
  )
}
