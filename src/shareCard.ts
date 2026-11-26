import QRCode from 'qrcode'
import { ENTITY_LABELS, episodeLabel, timeLabel, type Entity, type Episode, type Moment, type Topic } from './domain'
import { coverDesign } from './coverDesign'
import { APPLE_PODCASTS_BADGE, XIAOYUZHOU_BADGE } from './platforms'
import type { Nebula, SubStar, Thread } from './scene/GalaxyScene'
import { layoutNebulae } from './StarMap'
import { renderGalaxyStill, type GalaxyStill } from './scene/still'

/**
 * The share card: 1080px wide, as tall as its content needs between 3:4 (1440) and 9:16 (1920), so it fills a phone
 * screen in a story or a chat. An episode leads with its title and opening chapters. An entity leads with its
 * portrait, cover or name, followed by the episodes that mention it. The site's own card is the star map itself, its
 * topics named on it. Every card ends with ways to listen.
 */
const W = 1080
const MIN_H = 1440
const MAX_H = 1920
const PAD = 84
const FOOT = 340
const SERIF = '"Beier Serif", "Source Han Serif SC", "Noto Serif SC", "Songti SC", serif'
const SANS = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const IVORY = '#f8f2e6'
const SOFT = 'rgba(228, 216, 195, 0.86)'
const MUTED = 'rgba(217, 205, 184, 0.58)'
const BLUE = '#a9b8ff'
const CHAPTERS_PER_EPISODE = 2
const SOLO_EPISODE_CHAPTERS = 4
// The site card: the star map fills the top HERO px and fades into a short band of type at the foot.
const HERO = 1460
// Where the ring of nebulae sits on the map, as fractions of HERO: from under the top edge to above the name.
const SKY_TOP = 0.165
const SKY_BOTTOM = 0.79
const SUBTOPICS_PER_TOPIC = 2

export type SiteShare = {
  kind: 'site'
  topics: Topic[]
  stars: (SubStar & { name: string })[]
  threads: Thread[]
  episodeCount: number
  momentCount: number
}

export type ShareSubject =
  | { kind: 'entity'; entity: Entity; tint: string; maker?: string }
  | { kind: 'episode'; episode: Episode; tint: string }
  | SiteShare

type CardInput = {
  subject: ShareSubject
  url: string
  episodes: Map<string, Episode>
  moments: Map<string, Moment>
}
type Chapter = { startSec: number; title: string }
type Block = { episode: Episode; chapters: Chapter[] }

/** Canvas letter-spacing, where the browser supports it. */
function spacing(ctx: CanvasRenderingContext2D, value: string) {
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = value
}

const shortTitle = (episode: Episode) => episode.title.replace(/^EP\s*\d+\s*[.．:：|｜]?\s*/i, '')

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

/** Punctuation that may not start a line: it hangs off the end of the line before instead. */
const NO_START = /[，。、；：！？）》」』”’,.;:!?)\]]/
const OPENING_MARKS = /[（《〈「『【〔“‘(\[]+$/
const INSIDE_WORD = /[\p{Script=Latin}\p{Number}'’-]/u
const TRAILING_WORD = /(?:^|\s)([\p{Script=Latin}\p{Number}'’-]+)$/u

/** Break Chinese at characters and keep Latin words and opening marks together when there is room. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const lines: string[] = []
  let line = ''
  let clipped = false
  for (const character of text.trim()) {
    if (!line && /\s/.test(character)) continue
    if (!line || ctx.measureText(line + character).width <= width || NO_START.test(character)) {
      line += character
      continue
    }
    const opening = line.match(OPENING_MARKS)?.[0]
    const word = INSIDE_WORD.test(character) ? line.match(TRAILING_WORD)?.[1] : undefined
    const pending = opening ?? word ?? ''
    const carry = pending === line ? '' : pending
    lines.push(line.slice(0, line.length - carry.length).trimEnd())
    line = (carry + character).trimStart()
    if (lines.length === maxLines) {
      clipped = true
      break
    }
  }
  if (!clipped && line && lines.length < maxLines) lines.push(line.trimEnd())
  if (clipped) {
    const last = [...lines[lines.length - 1]]
    while (last.length && ctx.measureText(`${last.join('').trimEnd()}…`).width > width) last.pop()
    lines[lines.length - 1] = `${last.join('').trimEnd()}…`
  }
  return lines
}

const fit = (ctx: CanvasRenderingContext2D, text: string, width: number) => wrap(ctx, text, width, 1)[0] ?? ''

/** Wrap into as few lines as `wrap` would, but as even as possible, so a title never leaves one character alone. */
function balanced(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const count = wrap(ctx, text, width, maxLines).length
  if (count < 2) return wrap(ctx, text, width, maxLines)
  let narrow = width
  while (narrow > 40 && wrap(ctx, text, narrow - 4, 99).length === count) narrow -= 4
  return wrap(ctx, text, narrow, maxLines)
}

/** A sub-topic tag's colour: mostly warm ivory, a third its nebula's tint, at `alpha`. */
function tag(tint: string, alpha: number) {
  const hex = tint.replace('#', '')
  const channel = (index: number, base: number) => Math.round(parseInt(hex.slice(index * 2, index * 2 + 2), 16) * 0.35 + base * 0.65)
  return `rgba(${channel(0, 228)}, ${channel(1, 221)}, ${channel(2, 210)}, ${alpha.toFixed(2)})`
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>(resolve => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

/** Episodes newest first, each with the chapters where this comes up (from its moments, or the episode's chapter list). */
function blocksFor(entity: Entity, episodes: Map<string, Episode>, moments: Map<string, Moment>): Block[] {
  const byEpisode = new Map<string, Chapter[]>()
  for (const point of entity.mentions) {
    const episode = episodes.get(point.episodeId)
    if (!episode) continue
    const list = byEpisode.get(episode.id) ?? []
    const moment = point.momentId ? moments.get(point.momentId) : undefined
    const chapter: Chapter | undefined = moment
      ?? (point.startSec === null ? undefined : episode.chapters.find(item => item.startSec === point.startSec))
    if (chapter && !list.some(item => item.startSec === chapter.startSec)) list.push({ startSec: chapter.startSec, title: chapter.title })
    byEpisode.set(episode.id, list)
  }
  return [...byEpisode]
    .sort(([a], [b]) => episodes.get(b)!.publishedAt.localeCompare(episodes.get(a)!.publishedAt))
    .map(([id, list]) => ({ episode: episodes.get(id)!, chapters: list.sort((a, b) => a.startSec - b.startSec) }))
}

/** The site's cover design (coverDesign.ts), drawn onto the card. */
function drawCover(ctx: CanvasRenderingContext2D, entity: Entity, maker: string | undefined, x: number, y: number, w: number) {
  const design = coverDesign(entity)
  const h = w * 1.45
  const u = w / 100
  ctx.save()
  ctx.shadowColor = 'rgba(2, 4, 16, 0.6)'
  ctx.shadowBlur = 50
  ctx.shadowOffsetY = 22
  ctx.fillStyle = design.paper[1]
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, [4, 10, 10, 4])
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, [4, 10, 10, 4])
  ctx.clip()
  const paper = ctx.createLinearGradient(x, y, x + w * 0.55, y + h)
  paper.addColorStop(0, design.paper[0])
  paper.addColorStop(1, design.paper[1])
  ctx.fillStyle = paper
  ctx.fillRect(x, y, w, h)
  const glow = ctx.createRadialGradient(x + w * 0.85, y + h * 0.04, 0, x + w * 0.85, y + h * 0.04, w * 0.9)
  glow.addColorStop(0, `${design.accent}38`)
  glow.addColorStop(1, `${design.accent}00`)
  ctx.fillStyle = glow
  ctx.fillRect(x, y, w, h)
  if (design.layout === 'orb' || design.layout === 'poster') {
    const size = design.layout === 'poster' ? 54 * u : 36 * u
    const cx = x + 53 * u
    const cy = y + (design.layout === 'poster' ? 20 * u : 14 * u) + size / 2
    const orb = ctx.createRadialGradient(cx - size * 0.12, cy - size * 0.16, 0, cx, cy, size / 2)
    orb.addColorStop(0, '#ffffff')
    orb.addColorStop(0.15, design.accent)
    orb.addColorStop(0.68, `${design.accent}40`)
    orb.addColorStop(1, `${design.accent}00`)
    ctx.globalAlpha = design.layout === 'poster' ? 0.7 : 1
    ctx.fillStyle = orb
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  const spine = ctx.createLinearGradient(x, 0, x + w * 0.07, 0)
  spine.addColorStop(0, 'rgba(0, 0, 0, 0.34)')
  spine.addColorStop(0.6, 'rgba(255, 255, 255, 0.07)')
  spine.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = spine
  ctx.fillRect(x, y, w * 0.07, h)

  const size = design.titleSize * w
  ctx.fillStyle = design.ink
  ctx.font = `600 ${size}px ${SERIF}`
  ctx.textBaseline = 'alphabetic'
  const softInk = (alpha: number) => { ctx.globalAlpha = alpha }
  if (design.layout === 'vertical') {
    const characters = [...entity.name]
    characters.forEach((character, index) => {
      const width = ctx.measureText(character).width
      ctx.fillText(character, x + w - 12 * u - size / 2 - width / 2, y + 12 * u + size * (index + 0.86) * 1.16)
    })
    if (maker) {
      ctx.font = `400 ${6 * u}px ${SERIF}`
      softInk(0.72)
      const marks = [...maker].slice(0, 9)
      marks.forEach((character, index) => {
        const width = ctx.measureText(character).width
        ctx.fillText(character, x + 16 * u + 3 * u - width / 2, y + h - 11 * u - (marks.length - index - 0.85) * 6 * u * 1.16)
      })
      softInk(1)
    }
    ctx.strokeStyle = design.accent
    ctx.lineWidth = 2
    ctx.strokeRect(x + 16 * u, y + 13 * u, 11 * u, 11 * u)
    ctx.fillStyle = design.accent
    ctx.font = `600 ${6.5 * u}px ${SERIF}`
    ctx.textAlign = 'center'
    ctx.fillText('贝', x + 21.5 * u, y + 20.8 * u)
    ctx.textAlign = 'left'
  } else {
    const centred = design.layout !== 'rule'
    const inner = w - 26 * u
    const left = x + 15 * u
    const middle = x + 54 * u
    const lines = balanced(ctx, entity.name, inner, 4)
    const block = lines.length * size * 1.28
    let top = design.layout === 'orb' ? y + 60 * u : design.layout === 'poster' ? y + h - 9 * u - 6 * u - 18 * u - (maker ? 9 * u : 0) - block : y + 13 * u
    ctx.textAlign = centred ? 'center' : 'left'
    for (const line of lines) {
      ctx.fillText(line, centred ? middle : left, top + size)
      top += size * 1.28
    }
    ctx.fillStyle = design.accent
    const rule = design.layout === 'rule' ? 20 * u : 12 * u
    top += design.layout === 'rule' ? 7 * u : 5 * u
    ctx.fillRect(centred ? middle - rule / 2 : left, top, rule, 2)
    top += design.layout === 'rule' ? 5 * u : 4 * u
    ctx.fillStyle = design.ink
    if (maker) {
      ctx.font = `400 ${6.6 * u}px ${SERIF}`
      softInk(0.72)
      ctx.fillText(fit(ctx, maker, inner), centred ? middle : left, top + 6.6 * u)
      softInk(1)
      top += 6.6 * u * 1.3
    }
    const foot = entity.kind === 'film' ? [entity.format, entity.year].filter(Boolean).join(' · ') : '贝儿说'
    ctx.font = `400 ${5 * u}px ${SERIF}`
    softInk(0.45)
    ctx.fillText(foot, centred ? middle : left, design.layout === 'poster' ? top + 9 * u : y + h - 10 * u)
    softInk(1)
    ctx.textAlign = 'left'
  }
  ctx.restore()
  return h
}

/** Draw the share card and return it as a PNG. */
export async function renderShareCard({ subject, url, episodes, moments }: CardInput): Promise<Blob> {
  const tint = subject.kind === 'site' ? BLUE : subject.tint
  const entity = subject.kind === 'entity' ? subject.entity : undefined
  const episode = subject.kind === 'episode' ? subject.episode : undefined
  await Promise.all([
    document.fonts?.load(`600 88px "Beier Serif"`),
    document.fonts?.load(`400 32px "Beier Serif"`),
  ]).catch(() => undefined)
  const [portrait, showCover, appleBadge, xiaoyuzhouBadge] = await Promise.all([
    entity?.kind === 'person' && entity.image ? loadImage(entity.image.src) : Promise.resolve(null),
    loadImage('/brand/show-cover.png'),
    loadImage(APPLE_PODCASTS_BADGE),
    loadImage(XIAOYUZHOU_BADGE),
  ])
  const code = document.createElement('canvas')
  // Drawn at the size it is shown, so the modules stay sharp.
  await QRCode.toCanvas(code, url, { margin: 0, width: subject.kind === 'site' ? 144 : 220, errorCorrectionLevel: 'M', color: { dark: '#141a40', light: '#ffffff' } })
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = MAX_H
  const png = () => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('无法生成图片'))), 'image/png'))
  if (subject.kind === 'site') {
    // Without WebGL the card still shows the topics, over soft glows where the nebulae would be.
    // The phone's upright ring, stretched to fill the map from top to bottom.
    const upright = layoutNebulae(subject.topics, true)
    const top = Math.min(...upright.map(nebula => nebula.y))
    const span = Math.max(...upright.map(nebula => nebula.y)) - top || 1
    const nebulae = upright.map(nebula => ({ ...nebula, y: SKY_TOP + ((nebula.y - top) / span) * (SKY_BOTTOM - SKY_TOP) }))
    const still = await renderGalaxyStill({ nebulae, stars: subject.stars, threads: subject.threads }, W, HERO).catch(() => null)
    drawSite(canvas.getContext('2d')!, subject, nebulae, still)
    return png()
  }
  const blocks = entity ? blocksFor(entity, episodes, moments) : []
  const measure = canvas.getContext('2d')!
  // Lay out once without drawing to learn how many episodes fit and how tall the card needs to be, then draw for real.
  const layout = compose(measure, false, MAX_H, null)
  const height = Math.round(Math.min(MAX_H, Math.max(MIN_H, layout.bottom + FOOT + PAD)))
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  compose(ctx, true, height, layout.plan)
  return png()

  /** Lay out the card. Without a plan it decides how many chapters each episode shows (none once out of room) and returns that plan. */
  function compose(ctx: CanvasRenderingContext2D, draw: boolean, H: number, plan: number[] | null) {
    // The site card has its own layout (drawSite).
    if (subject.kind === 'site') return { bottom: 0, plan: [] }
    const spaced = (value: string) => spacing(ctx, value)
    const text = (value: string, x: number, y: number) => { if (draw) ctx.fillText(value, x, y) }
    ctx.textBaseline = 'alphabetic'
    if (draw) paintSky(ctx, H)

    // Masthead, with the kind on the right.
    ctx.font = `400 26px ${SERIF}`
    spaced('8px')
    ctx.fillStyle = MUTED
    text('贝儿说 · 次要人生', PAD, 112)
    ctx.font = `400 26px ${SERIF}`
    spaced('10px')
    const kind = subject.kind === 'episode' ? episodeLabel(subject.episode) : ENTITY_LABELS[subject.entity.kind]
    const kindWidth = ctx.measureText(kind).width
    ctx.fillStyle = tint
    if (draw) {
      ctx.beginPath()
      ctx.arc(W - PAD - kindWidth - 22, 103, 7, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = SOFT
    text(kind, W - PAD - kindWidth, 112)

    if (subject.kind === 'episode') {
      let y = 272
      const title = shortTitle(subject.episode)
      const width = W - PAD * 2
      let titleSize = 88
      ctx.font = `600 ${titleSize}px ${SERIF}`
      spaced('2px')
      ctx.fillStyle = IVORY
      let lines = wrap(ctx, title, width, 4)
      const lastLine = lines.at(-1) ?? ''
      if (lines.length > 1 && ctx.measureText(lastLine).width < width / 3) {
        // Try a smaller headline before leaving a single word or character on the last line.
        ctx.font = `600 80px ${SERIF}`
        const compact = wrap(ctx, title, width, 4)
        if (compact.length < lines.length) {
          titleSize = 80
          lines = compact
        } else {
          ctx.font = `600 ${titleSize}px ${SERIF}`
          const balanced = wrap(ctx, title, width * 0.82, 4)
          if (balanced.length === lines.length && !balanced.at(-1)?.endsWith('…')) lines = balanced
        }
      }
      for (const line of lines) {
        text(line, PAD, y)
        y += titleSize + 22
      }

      const chapters = subject.episode.chapters.slice(0, SOLO_EPISODE_CHAPTERS)
      if (chapters.length) {
        drawDivider(y - 46)
        ctx.font = `400 27px ${SANS}`
        spaced('6px')
        ctx.fillStyle = MUTED
        text('本集章节', PAD, y + 14)
        y += 76
        for (const chapter of chapters) {
          ctx.font = `400 28px ${SERIF}`
          spaced('1px')
          ctx.fillStyle = BLUE
          text(timeLabel(chapter.startSec), PAD, y)
          ctx.font = `400 34px ${SERIF}`
          ctx.fillStyle = SOFT
          for (const line of wrap(ctx, chapter.title, W - PAD * 2 - 134, 2)) {
            text(line, PAD + 134, y)
            y += 45
          }
          y += 26
        }
      }
      if (draw) paintFoot(ctx, H)
      return { bottom: y, plan: [] }
    }

    // Lead: a cover beside the title for books and films, a portrait beside the name for people, the name alone for ideas.
    const { entity, maker } = subject
    let y = 188
    const name = entity.kind === 'book' || entity.kind === 'film' ? `《${entity.name}》` : entity.name
    if (entity.kind === 'book' || entity.kind === 'film') {
      const coverWidth = 300
      spaced('0px')
      const coverHeight = draw ? drawCover(ctx, entity, maker, PAD, y, coverWidth) : coverWidth * 1.45
      const x = PAD + coverWidth + 56
      const width = W - PAD - x
      spaced('2px')
      ctx.font = `600 64px ${SERIF}`
      ctx.fillStyle = IVORY
      let line = y + 76
      for (const part of wrap(ctx, name, width, 3)) { text(part, x - 18, line); line += 82 }
      if (maker) {
        spaced('2px')
        ctx.font = `400 34px ${SERIF}`
        ctx.fillStyle = SOFT
        text(fit(ctx, maker, width), x, line + 6)
        line += 60
      }
      if (entity.kind === 'film' && (entity.format || entity.year)) {
        ctx.font = `400 26px ${SANS}`
        ctx.fillStyle = MUTED
        text([entity.format, entity.year].filter(Boolean).join(' · '), x, line + 4)
        line += 50
      }
      // The note sits beside the cover, where there is room.
      if (entity.note) {
        line += 40
        spaced('1px')
        ctx.font = `400 30px ${SERIF}`
        ctx.fillStyle = SOFT
        const room = Math.max(1, Math.min(5, Math.floor((y + coverHeight - line) / 48) + 1))
        for (const part of wrap(ctx, entity.note, width, room)) { text(part, x, line); line += 48 }
      }
      y = Math.max(y + coverHeight, line) + 64
    } else if (entity.kind === 'person') {
      const size = 196
      if (draw) {
        ctx.save()
        ctx.shadowColor = `${tint}66`
        ctx.shadowBlur = 40
        ctx.beginPath()
        ctx.arc(PAD + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
        ctx.fillStyle = '#1b2148'
        ctx.fill()
        ctx.restore()
        ctx.save()
        ctx.beginPath()
        ctx.arc(PAD + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
        ctx.clip()
        if (portrait) {
          const scale = Math.max(size / portrait.width, size / portrait.height)
          ctx.drawImage(portrait, PAD + size / 2 - (portrait.width * scale) / 2, y + size / 2 - (portrait.height * scale) / 2, portrait.width * scale, portrait.height * scale)
        } else {
          const ground = ctx.createRadialGradient(PAD + size * 0.35, y + size * 0.3, 0, PAD + size / 2, y + size / 2, size * 0.7)
          ground.addColorStop(0, '#3a4380')
          ground.addColorStop(1, '#141938')
          ctx.fillStyle = ground
          ctx.fillRect(PAD, y, size, size)
          ctx.fillStyle = '#f3e9d6'
          ctx.font = `600 ${size * 0.4}px ${SERIF}`
          ctx.textAlign = 'center'
          ctx.fillText(entity.name.replace(/^[A-Z][a-z]*\s|^[^·\s]+·/, '').slice(0, 1), PAD + size / 2, y + size * 0.64)
          ctx.textAlign = 'left'
        }
        ctx.restore()
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(PAD + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
        ctx.stroke()
      }
      const x = PAD + size + 48
      spaced('4px')
      ctx.font = `600 76px ${SERIF}`
      ctx.fillStyle = IVORY
      const lines = wrap(ctx, name, W - PAD - x, 2)
      let line = y + size / 2 + 26 - (lines.length - 1) * 46
      for (const part of lines) { text(part, x, line); line += 92 }
      y += size + 56
    } else {
      spaced('4px')
      ctx.font = `600 96px ${SERIF}`
      ctx.fillStyle = IVORY
      if (draw) {
        ctx.shadowColor = `${tint}99`
        ctx.shadowBlur = 40
      }
      y += 60
      for (const part of wrap(ctx, name, W - PAD * 2, 2)) { text(part, PAD, y + 40); y += 116 }
      ctx.shadowBlur = 0
      y += 8
    }
    if (entity.note && entity.kind !== 'book' && entity.kind !== 'film') {
      spaced('1px')
      ctx.font = `400 34px ${SERIF}`
      ctx.fillStyle = SOFT
      for (const part of wrap(ctx, entity.note, W - PAD * 2, 3)) { text(part, PAD, y + 34); y += 56 }
    }

    // Where it comes up: each episode's title leads, a couple of its chapters sit smaller beneath.
    y += 40
    drawDivider(y)
    y += 62
    ctx.font = `400 26px ${SANS}`
    spaced('6px')
    ctx.fillStyle = MUTED
    text(blocks.length ? `在 ${blocks.length} 期节目里谈到` : '通过作品出现在节目里', PAD, y)
    y += 30
    const limit = H - FOOT - PAD - 50
    const picks: number[] = []
    for (const [index, block] of blocks.entries()) {
      if (plan && index >= plan.length) break
      ctx.font = `600 40px ${SERIF}`
      spaced('1px')
      const titleLines = wrap(ctx, shortTitle(block.episode), W - PAD * 2, 2)
      const rows = (count: number) => count + (count && block.chapters.length > count ? 1 : 0)
      const height = (count: number) => 40 + 34 + titleLines.length * 54 + rows(count) * 46 + 12
      // Short of room, an episode keeps its title and gives up chapters first.
      const full = Math.min(CHAPTERS_PER_EPISODE, block.chapters.length)
      const count = plan ? plan[index] : [full, Math.min(1, full), 0].find(option => y + height(option) <= limit) ?? (index ? -1 : 0)
      if (count < 0) break
      picks.push(count)
      y += 40 + 34
      ctx.font = `400 26px ${SERIF}`
      spaced('3px')
      ctx.fillStyle = BLUE
      text(episodeLabel(block.episode), PAD, y)
      y += 14
      ctx.font = `600 40px ${SERIF}`
      spaced('1px')
      ctx.fillStyle = IVORY
      for (const part of titleLines) { y += 54; text(part, PAD, y - 8) }
      for (const chapter of block.chapters.slice(0, count)) {
        y += 46
        ctx.font = `400 25px ${SERIF}`
        spaced('0px')
        ctx.fillStyle = 'rgba(169, 184, 255, 0.75)'
        text(timeLabel(chapter.startSec), PAD + 2, y)
        ctx.font = `400 28px ${SERIF}`
        ctx.fillStyle = SOFT
        text(fit(ctx, chapter.title, W - PAD * 2 - 112), PAD + 110, y)
      }
      if (rows(count) > count) {
        y += 46
        ctx.font = `400 24px ${SANS}`
        ctx.fillStyle = MUTED
        text(`还有 ${block.chapters.length - count} 段`, PAD + 110, y)
      }
      y += 12
    }
    const shown = picks.length
    if (blocks.length > shown) {
      y += 56
      ctx.font = `400 24px ${SANS}`
      spaced('2px')
      ctx.fillStyle = MUTED
      text(`还有 ${blocks.length - shown} 期 · 扫码看全部`, PAD, y)
    }

    if (draw) paintFoot(ctx, H)
    return { bottom: y, plan: picks }

    function drawDivider(y: number) {
      if (!draw) return
      ctx.strokeStyle = 'rgba(241, 227, 200, 0.25)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(PAD, y)
      ctx.lineTo(PAD + 120, y)
      ctx.stroke()
    }

  }

  function paintFoot(ctx: CanvasRenderingContext2D, H: number) {
    const top = H - PAD - FOOT + 70
    ctx.strokeStyle = 'rgba(241, 227, 200, 0.16)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD, top - 30)
    ctx.lineTo(W - PAD, top - 30)
    ctx.stroke()
    // The show, then where to listen, each platform with its own mark.
    if (showCover) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(PAD + 44, top + 44, 44, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(showCover, PAD, top, 88, 88)
      ctx.restore()
    }
    ctx.fillStyle = IVORY
    ctx.font = `600 38px ${SERIF}`
    spacing(ctx, '4px')
    ctx.fillText('次要人生', PAD + 112, top + 42)
    ctx.font = `400 24px ${SERIF}`
    ctx.fillStyle = SOFT
    spacing(ctx, '1px')
    ctx.fillText('Flip Your Mind · 倪贝儿', PAD + 112, top + 80)
    let x = PAD
    const row = top + 113
    ctx.font = `400 27px ${SERIF}`
    ctx.fillStyle = IVORY
    spacing(ctx, '1px')
    const badges = [{ image: appleBadge, label: 'Apple Podcasts' }, { image: xiaoyuzhouBadge, label: '小宇宙' }]
    for (const badge of badges) {
      if (badge.image) {
        const height = 60
        const width = height * badge.image.naturalWidth / badge.image.naturalHeight
        ctx.drawImage(badge.image, x, row, width, height)
        x += width + 20
      } else {
        ctx.fillText(badge.label, x, row + 38)
        x += ctx.measureText(badge.label).width + 20
      }
    }
    ctx.font = `400 24px ${SANS}`
    ctx.fillStyle = MUTED
    spacing(ctx, '1px')
    ctx.fillText('搜索「次要人生」收听', PAD, row + 107)
    ctx.fillText(new URL(url).host, PAD, row + 147)
    // A code that opens this page, which has the subscribe links.
    const size = 220
    const qx = W - PAD - size
    const qy = top - 4
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.roundRect(qx - 14, qy - 14, size + 28, size + 28, 18)
    ctx.fill()
    ctx.drawImage(code, qx, qy, size, size)
    ctx.font = `400 22px ${SANS}`
    ctx.fillStyle = MUTED
    ctx.textAlign = 'center'
    ctx.fillText(episode ? '扫码打开单集' : '扫码看完整星图', qx + size / 2, qy + size + 56)
    ctx.textAlign = 'left'
  }

  /**
   * The whole site: the star map takes three quarters of the card, each topic named on its nebula with its two
   * strongest sub-topics beside their stars. Under it, one quiet band: the name with a line on what it is, what it
   * holds, and the show with where to listen and a code to open the map.
   */
  function drawSite(ctx: CanvasRenderingContext2D, site: SiteShare, nebulae: Nebula[], still: GalaxyStill | null) {
    const H = MAX_H
    // The band's rows, from the foot up: the code's caption and the address share the last baseline.
    const last = H - 72
    const qrPlate = 168
    const plateTop = last - 38 - qrPlate
    const ruleY = plateTop - 32
    const statsY = ruleY - 46
    const markY = statsY - 84
    const kickerY = markY - 78
    paintSky(ctx, H)
    const hero = document.createElement('canvas')
    hero.width = W
    hero.height = HERO
    const sky = hero.getContext('2d')!
    const nebulaAt = new Map<string, { x: number; y: number; radius: number }>()
    if (still) {
      sky.drawImage(still.image, 0, 0)
      for (const [id, point] of still.frame.nebulae) nebulaAt.set(id, point)
    } else {
      for (const nebula of nebulae) {
        const point = { x: nebula.x * W, y: nebula.y * HERO, radius: HERO * 0.158 }
        nebulaAt.set(nebula.id, point)
        const glow = sky.createRadialGradient(point.x, point.y, 0, point.x, point.y, point.radius * 1.3)
        glow.addColorStop(0, `${nebula.tint}66`)
        glow.addColorStop(0.5, `${nebula.tint}22`)
        glow.addColorStop(1, `${nebula.tint}00`)
        sky.fillStyle = glow
        sky.fillRect(0, 0, W, HERO)
      }
    }
    // Fade the map's lower edge into the card.
    sky.globalCompositeOperation = 'destination-in'
    const fade = sky.createLinearGradient(0, 0, 0, HERO)
    fade.addColorStop(0, '#000')
    fade.addColorStop(0.8, '#000')
    fade.addColorStop(1, 'rgba(0, 0, 0, 0)')
    sky.fillStyle = fade
    sky.fillRect(0, 0, W, HERO)
    ctx.drawImage(hero, 0, 0)

    // Labels, as on the map: topics are glowing serif headings with a short rule in their colour; sub-topics are
    // small sans tags tinted towards their nebula. Nothing overlaps, nothing runs off the card.
    type Box = { left: number; top: number; right: number; bottom: number }
    const taken: Box[] = [{ left: 0, top: 0, right: W, bottom: 64 }]
    const clear = (box: Box) => box.left >= PAD * 0.5 && box.right <= W - PAD * 0.5 && box.bottom <= kickerY - 56
      && !taken.some(other => !(box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom))
    const portrait = HERO > W * 1.05
    const titles: { topic: Topic; x: number; y: number }[] = []
    ctx.textBaseline = 'alphabetic'
    for (const topic of site.topics) {
      const point = nebulaAt.get(topic.id)
      if (!point) continue
      ctx.font = `600 38px ${SERIF}`
      spacing(ctx, '12px')
      const width = ctx.measureText(topic.title).width - 12
      const y = point.y - Math.min(point.radius * (portrait ? 0.6 : 0.95), 475) + 4
      const x = Math.min(Math.max(point.x, PAD + width / 2), W - PAD - width / 2)
      titles.push({ topic, x, y })
      // Wide clearance at the sides, so a tag never reads as part of the title.
      taken.push({ left: x - width / 2 - 40, top: y - 44, right: x + width / 2 + 40, bottom: y + 34 })
    }
    if (still) {
      const byTopic = new Map<string, (SubStar & { name: string })[]>()
      for (const star of site.stars) byTopic.set(star.nebula, [...(byTopic.get(star.nebula) ?? []), star])
      for (const topic of site.topics) {
        const strongest = [...(byTopic.get(topic.id) ?? [])].sort((a, b) => b.weight - a.weight)
        let shown = 0
        for (const star of strongest) {
          if (shown >= SUBTOPICS_PER_TOPIC) break
          const point = still.frame.stars.get(star.id)
          if (!point) continue
          const size = 23 + star.weight * 7
          ctx.font = `400 ${size}px ${SANS}`
          spacing(ctx, '0.5px')
          const width = ctx.measureText(star.name).width
          const gap = 14 + star.weight * 10
          const right = { left: point.x + gap, top: point.y - size * 0.75, right: point.x + gap + width, bottom: point.y + size * 0.45 }
          const left = { ...right, left: point.x - gap - width, right: point.x - gap }
          const box = clear(right) ? right : clear(left) ? left : null
          if (!box) continue
          taken.push(box)
          shown += 1
          ctx.save()
          ctx.shadowColor = 'rgba(5, 7, 20, 0.95)'
          ctx.shadowBlur = 14
          ctx.fillStyle = tag(topic.color, 0.6 + star.weight * 0.35)
          ctx.fillText(star.name, box.left, point.y + size * 0.36)
          ctx.restore()
        }
      }
    }
    for (const { topic, x, y } of titles) {
      ctx.font = `600 38px ${SERIF}`
      spacing(ctx, '12px')
      ctx.textAlign = 'center'
      ctx.save()
      ctx.shadowColor = topic.color
      ctx.shadowBlur = 36
      ctx.fillStyle = '#fbf4e6'
      ctx.fillText(topic.title, x + 6, y)
      ctx.shadowBlur = 4
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
      ctx.fillText(topic.title, x + 6, y)
      ctx.restore()
      ctx.textAlign = 'left'
      ctx.save()
      ctx.fillStyle = topic.color
      ctx.shadowColor = topic.color
      ctx.shadowBlur = 12
      ctx.fillRect(x - 20, y + 20, 40, 2.5)
      ctx.restore()
    }

    // What this is, then the name with one line on it, a hairline between them.
    ctx.font = `400 22px ${SERIF}`
    spacing(ctx, '8px')
    ctx.fillStyle = MUTED
    ctx.fillText('次要人生 · 主题星图', PAD, kickerY)
    ctx.save()
    ctx.font = `600 64px ${SERIF}`
    spacing(ctx, '10px')
    ctx.fillStyle = IVORY
    ctx.shadowColor = 'rgba(130, 150, 255, 0.4)'
    ctx.shadowBlur = 28
    ctx.fillText('贝儿说', PAD - 3, markY)
    const markWidth = ctx.measureText('贝儿说').width - 10
    ctx.restore()
    const lineX = PAD + markWidth + 64
    ctx.fillStyle = 'rgba(241, 227, 200, 0.22)'
    ctx.fillRect(lineX - 32, markY - 54, 1, 62)
    ctx.font = `400 24px ${SERIF}`
    spacing(ctx, '1.5px')
    ctx.fillStyle = SOFT
    ctx.fillText('从一个生活里的问题出发，', lineX, markY - 30)
    ctx.fillText('沿着主题找回《次要人生》里的那段话。', lineX, markY + 4)

    // What it holds, in one line.
    const stats: [number, string][] = [
      [site.episodeCount, '期节目'], [site.topics.length, '个主题'], [site.stars.length, '个小主题'], [site.momentCount, '个章节'],
    ]
    let x = PAD
    for (const [value, label] of stats) {
      ctx.font = `600 36px ${SERIF}`
      spacing(ctx, '0.5px')
      ctx.fillStyle = IVORY
      ctx.fillText(String(value), x, statsY)
      x += ctx.measureText(String(value)).width + 8
      ctx.font = `400 20px ${SANS}`
      spacing(ctx, '2px')
      ctx.fillStyle = MUTED
      ctx.fillText(label, x, statsY)
      x += ctx.measureText(label).width + 46
    }
    ctx.fillStyle = 'rgba(241, 227, 200, 0.14)'
    ctx.fillRect(PAD, ruleY, W - PAD * 2, 1)

    // The show, where to listen and the address on the left; the code on the right, its top and caption on the
    // same lines as theirs.
    const coverSize = 64
    if (showCover) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(PAD + coverSize / 2, plateTop + coverSize / 2, coverSize / 2, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(showCover, PAD, plateTop, coverSize, coverSize)
      ctx.restore()
    }
    ctx.font = `600 28px ${SERIF}`
    spacing(ctx, '3px')
    ctx.fillStyle = IVORY
    ctx.fillText('次要人生', PAD + coverSize + 20, plateTop + 28)
    ctx.font = `400 19px ${SERIF}`
    spacing(ctx, '1px')
    ctx.fillStyle = SOFT
    ctx.fillText('Flip Your Mind · 倪贝儿', PAD + coverSize + 20, plateTop + 58)
    const listenY = (plateTop + coverSize + last - 20) / 2
    x = PAD
    for (const badge of [{ image: appleBadge, label: 'Apple Podcasts' }, { image: xiaoyuzhouBadge, label: '小宇宙' }]) {
      if (badge.image) {
        const height = 40
        const width = (height * badge.image.naturalWidth) / badge.image.naturalHeight
        ctx.drawImage(badge.image, x, listenY - height / 2, width, height)
        x += width + 12
      } else {
        ctx.font = `400 22px ${SERIF}`
        ctx.fillStyle = IVORY
        ctx.fillText(badge.label, x, listenY + 8)
        x += ctx.measureText(badge.label).width + 18
      }
    }
    ctx.font = `400 20px ${SANS}`
    spacing(ctx, '1px')
    ctx.fillStyle = MUTED
    ctx.fillText('搜索「次要人生」收听', x + 12, listenY + 7)
    ctx.fillText(new URL(url).host, PAD, last)
    const qrX = W - PAD - qrPlate
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.roundRect(qrX, plateTop, qrPlate, qrPlate, 16)
    ctx.fill()
    ctx.drawImage(code, qrX + 12, plateTop + 12, qrPlate - 24, qrPlate - 24)
    ctx.font = `400 19px ${SANS}`
    spacing(ctx, '2px')
    ctx.fillStyle = MUTED
    ctx.textAlign = 'center'
    ctx.fillText('扫码看完整星图', qrX + qrPlate / 2, last)
    ctx.textAlign = 'left'
  }

  // Sky: the site's night gradient, a nebula glow in the topic's colour, a band of dust, scattered stars and threads.
  function paintSky(ctx: CanvasRenderingContext2D, H: number) {
    const sky = ctx.createLinearGradient(0, 0, 0, H)
    sky.addColorStop(0, '#090c22')
    sky.addColorStop(0.55, '#101535')
    sky.addColorStop(1, '#151b41')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, W, H)
    const glow = ctx.createRadialGradient(W * 0.78, H * 0.16, 0, W * 0.78, H * 0.16, 700)
    glow.addColorStop(0, `${tint}55`)
    glow.addColorStop(0.45, `${tint}1c`)
    glow.addColorStop(1, `${tint}00`)
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, W, H)
    const band = ctx.createRadialGradient(W * 0.85, H * 0.78, 0, W * 0.85, H * 0.78, 560)
    band.addColorStop(0, 'rgba(74, 90, 166, 0.26)')
    band.addColorStop(1, 'rgba(74, 90, 166, 0)')
    ctx.fillStyle = band
    ctx.fillRect(0, 0, W, H)
    const id = subject.kind === 'episode' ? subject.episode.id : subject.kind === 'entity' ? subject.entity.id : 'site'
    const random = seeded([...id].reduce((sum, character) => sum * 31 + character.charCodeAt(0), 7) >>> 0)
    for (let i = 0; i < 360; i += 1) {
      const x = random() * W
      const y = random() * H
      const size = 0.5 + Math.pow(random(), 3) * 2.2
      ctx.fillStyle = `rgba(${random() > 0.25 ? '205, 214, 255' : '255, 214, 170'}, ${0.15 + random() * 0.6})`
      ctx.beginPath()
      ctx.arc(x, y, size, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.lineWidth = 1.4
    for (let i = 0; i < 3; i += 1) {
      const from = { x: W * (0.55 + random() * 0.4), y: H * (0.05 + random() * 0.2) }
      const to = { x: W * (0.6 + random() * 0.35), y: H * (0.2 + random() * 0.2) }
      const line = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
      line.addColorStop(0, 'rgba(238, 240, 255, 0)')
      line.addColorStop(0.5, 'rgba(120, 140, 255, 0.3)')
      line.addColorStop(1, 'rgba(238, 240, 255, 0)')
      ctx.strokeStyle = line
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.quadraticCurveTo((from.x + to.x) / 2 + 80, (from.y + to.y) / 2 - 60, to.x, to.y)
      ctx.stroke()
    }
  }
}
