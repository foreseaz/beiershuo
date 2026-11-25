import type { Entity } from './domain'
import { coverDesign, hue } from './coverDesign'

/** Where to read more: Wikipedia for people, Douban for books and films. */
export function entityLink(entity: Entity, author?: Entity): { href: string; label: string } | null {
  if (entity.link) return entity.link
  const query = encodeURIComponent(entity.kind === 'book' && author ? `${entity.name} ${author.name}` : entity.name)
  if (entity.kind === 'book') return { href: `https://search.douban.com/book/subject_search?search_text=${query}`, label: '豆瓣读书' }
  if (entity.kind === 'film') return { href: `https://search.douban.com/movie/subject_search?search_text=${query}`, label: '豆瓣电影' }
  return null
}

/** A round portrait, or a monogram on a soft star field when no free-licensed photo exists. */
export function Portrait({ entity, size }: { entity: Entity; size: number }) {
  const shade = hue(entity.id) % 360
  return (
    <span className="portrait" style={{ width: size, height: size, '--shade': shade } as React.CSSProperties}>
      {entity.image
        ? <img src={entity.image.src} alt="" loading="lazy" width={size} height={size} />
        : <span className="portrait-mark" style={{ fontSize: size * 0.38 }}>{entity.name.replace(/^[A-Z][a-z]*\s|^[^·\s]+·/, '').slice(0, 1)}</span>}
    </span>
  )
}

/**
 * A designed cover for a book, film or show, in the site's own style (see coverDesign.ts). Its type is sized in
 * container units, so the same cover reads well from a thumbnail to the page header.
 */
export function Cover({ entity, maker, width }: { entity: Entity & { year?: number; format?: string }; maker?: string; width: number | string }) {
  const design = coverDesign(entity)
  const style = {
    '--cover-w': typeof width === 'number' ? `${width}px` : width,
    '--paper-a': design.paper[0],
    '--paper-b': design.paper[1],
    '--ink': design.ink,
    '--accent': design.accent,
    '--title': String(design.titleSize * 100),
  } as React.CSSProperties
  const foot = entity.kind === 'film' ? [entity.format, entity.year].filter(Boolean).join(' · ') : '贝儿说'
  return (
    <span className={`cover cover--${design.layout}${design.light ? ' is-light' : ''}`} style={style} aria-hidden="true">
      <span className="cover-face">
        {(design.layout === 'orb' || design.layout === 'poster') && <span className="cover-orb" />}
        {design.layout === 'vertical' && <span className="cover-seal">贝</span>}
        <span className="cover-title">{entity.name}</span>
        {design.layout !== 'vertical' && <span className="cover-rule" />}
        {maker && <span className="cover-maker">{maker}</span>}
        {design.layout !== 'vertical' && <span className="cover-foot">{foot}</span>}
      </span>
    </span>
  )
}
