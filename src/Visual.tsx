import type { Entity } from './domain'

function hue(id: string) {
  let value = 0
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return value % 360
}

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
  const shade = hue(entity.id)
  return (
    <span className="portrait" style={{ width: size, height: size, '--shade': shade } as React.CSSProperties}>
      {entity.image
        ? <img src={entity.image.src} alt="" loading="lazy" width={size} height={size} />
        : <span className="portrait-mark" style={{ fontSize: size * 0.38 }}>{entity.name.replace(/^[A-Z][a-z]*\s|^[^·\s]+·/, '').slice(0, 1)}</span>}
    </span>
  )
}

/**
 * A designed cover for a book, film or show, in the site's own style: no publisher artwork is
 * copied. Each title gets its own colour from its id.
 */
export function Cover({ entity, maker, width }: { entity: Entity & { year?: number; format?: string }; maker?: string; width: number }) {
  const shade = hue(entity.id)
  return (
    <span className={`cover cover--${entity.kind}`} style={{ width, height: width * 1.45, '--shade': shade } as React.CSSProperties} aria-hidden="true">
      <span className="cover-rule" />
      <span className="cover-title" style={{ fontSize: Math.max(11, width * (entity.name.length > 8 ? 0.1 : 0.13)) }}>{entity.name}</span>
      {maker && <span className="cover-maker" style={{ fontSize: Math.max(9, width * 0.07) }}>{maker}</span>}
      <span className="cover-foot" style={{ fontSize: Math.max(8, width * 0.06) }}>{entity.kind === 'film' ? [entity.format, entity.year].filter(Boolean).join(' · ') : '贝儿说 · 书架'}</span>
    </span>
  )
}
