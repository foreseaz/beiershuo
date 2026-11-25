import type { Entity } from './domain'

/**
 * The site's own covers for books, films and shows: no publisher artwork is copied. Each title gets a palette and a
 * layout from its id, so a shelf looks varied but every cover reads as part of one series. Shared by the page
 * covers (Visual.tsx) and the share card (shareCard.ts).
 */
export type CoverLayout = 'rule' | 'vertical' | 'orb' | 'poster'
export type CoverDesign = {
  layout: CoverLayout
  paper: [string, string]
  ink: string
  accent: string
  light: boolean
  /** Title size as a share of the cover's width. */
  titleSize: number
}

const PALETTES: { paper: [string, string]; ink: string; accent: string; light?: boolean }[] = [
  { paper: ['#22306a', '#0d1331'], ink: '#f4ead6', accent: '#e8c27a' },
  { paper: ['#62202e', '#290c15'], ink: '#f7e7d3', accent: '#f2b48b' },
  { paper: ['#1e4a3c', '#0a1f19'], ink: '#eef3e3', accent: '#c6e09a' },
  { paper: ['#8a5b28', '#3c260f'], ink: '#fdf2de', accent: '#ffdc98' },
  { paper: ['#482a61', '#1b0f28'], ink: '#f6e9f7', accent: '#e2b6ff' },
  { paper: ['#1d5260', '#09222a'], ink: '#eaf7f8', accent: '#9ce2ea' },
  { paper: ['#efe6d3', '#d6c7aa'], ink: '#26223b', accent: '#a5422f', light: true },
  { paper: ['#97422a', '#43170c'], ink: '#fff1e3', accent: '#ffc89e' },
]

export function hue(id: string) {
  let value = 0
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return value
}

/** Titles count as wide or narrow by their characters: a CJK character is one, a Latin letter about half. */
export function titleLength(title: string) {
  let length = 0
  for (const character of title) length += /[　-鿿＀-￯]/.test(character) ? 1 : 0.55
  return length
}

export function coverDesign(entity: Pick<Entity, 'id' | 'name' | 'kind'>): CoverDesign {
  const seed = hue(entity.id)
  const palette = PALETTES[seed % PALETTES.length]
  const length = titleLength(entity.name)
  const latin = !/[　-鿿]/.test(entity.name)
  let layout: CoverLayout = 'rule'
  if (entity.kind === 'film') layout = 'poster'
  else if (!latin && length <= 6 && seed % 3 === 0) layout = 'vertical'
  else if (seed % 3 === 1 && length <= 8) layout = 'orb'
  const titleSize = layout === 'vertical'
    ? (length <= 3 ? 0.17 : length <= 5 ? 0.14 : 0.12)
    : length <= 3 ? 0.16 : length <= 5 ? 0.135 : length <= 8 ? 0.115 : 0.095
  // Films stay on a dark ground whatever the palette: they read as posters.
  const darkened = Boolean(palette.light) && layout === 'poster'
  return {
    layout,
    paper: darkened ? ['#2a2440', '#0f0c1d'] : palette.paper,
    ink: darkened ? '#f6eedf' : palette.ink,
    accent: darkened ? '#e8c27a' : palette.accent,
    light: Boolean(palette.light) && !darkened,
    titleSize,
  }
}
