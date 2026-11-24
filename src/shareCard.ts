import QRCode from 'qrcode'
import { ENTITY_LABELS, episodeLabel, timeLabel, type Entity, type Episode, type Moment } from './domain'

const W = 1080
const H = 1440
const PAD = 84
const SERIF = '"Beier Serif", "Source Han Serif SC", "Noto Serif SC", "Songti SC", serif'
const SANS = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const IVORY = '#f8f2e6'
const SOFT = 'rgba(228, 216, 195, 0.88)'
const MUTED = 'rgba(217, 205, 184, 0.6)'
const BLUE = '#a9b8ff'

type Row = { label: string; title: string }
type CardInput = {
  entity: Entity
  url: string
  tint: string
  maker?: string
  episodes: Map<string, Episode>
  moments: Map<string, Moment>
}

const shortTitle = (episode: Episode) => episode.title.replace(/^EP\s*\d+\s*[.．:：|｜]?\s*/i, '')

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

/** Break text into lines that fit `width`, character by character (Chinese has no spaces to break on). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const lines: string[] = []
  let line = ''
  for (const character of text) {
    if (ctx.measureText(line + character).width > width && line) {
      lines.push(line)
      line = character
      if (lines.length === maxLines) break
    } else {
      line += character
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  const used = lines.join('').length
  if (used < [...text].length && lines.length) {
    let last = lines[lines.length - 1]
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last}…`
  }
  return lines
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number) {
  return wrap(ctx, text, width, 1)[0] ?? ''
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>(resolve => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

/** Where the show comes back to this person, book, film or idea, newest episode first. */
function rowsFor(entity: Entity, episodes: Map<string, Episode>, moments: Map<string, Moment>): { rows: Row[]; count: number } {
  const points = [...entity.mentions].sort((a, b) =>
    episodes.get(b.episodeId)!.publishedAt.localeCompare(episodes.get(a.episodeId)!.publishedAt) || (a.startSec ?? 0) - (b.startSec ?? 0))
  const rows = points.map(point => {
    const episode = episodes.get(point.episodeId)!
    const moment = point.momentId ? moments.get(point.momentId) : undefined
    return {
      label: moment ? `${episodeLabel(episode)} · ${timeLabel(moment.startSec)}` : episodeLabel(episode),
      title: moment?.title ?? shortTitle(episode),
    }
  })
  return { rows, count: new Set(points.map(point => point.episodeId)).size }
}

/** Draw a 3:4 share card (1080×1440) and return it as a PNG. */
export async function renderShareCard({ entity, url, tint, maker, episodes, moments }: CardInput): Promise<Blob> {
  await Promise.all([
    document.fonts?.load(`600 88px "Beier Serif"`),
    document.fonts?.load(`400 32px "Beier Serif"`),
  ]).catch(() => undefined)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const spaced = (value: string) => { if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = value }

  // Sky: the site's night gradient, a nebula glow in the topic's colour, a band of dust and scattered stars.
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#090c22')
  sky.addColorStop(0.55, '#111637')
  sky.addColorStop(1, '#151b41')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W * 0.74, H * 0.24, 0, W * 0.74, H * 0.24, 640)
  glow.addColorStop(0, `${tint}66`)
  glow.addColorStop(0.45, `${tint}22`)
  glow.addColorStop(1, `${tint}00`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)
  const band = ctx.createRadialGradient(W * 0.85, H * 0.8, 0, W * 0.85, H * 0.8, 520)
  band.addColorStop(0, 'rgba(74, 90, 166, 0.28)')
  band.addColorStop(1, 'rgba(74, 90, 166, 0)')
  ctx.fillStyle = band
  ctx.fillRect(0, 0, W, H)
  const random = seeded([...entity.id].reduce((sum, character) => sum * 31 + character.charCodeAt(0), 7) >>> 0)
  for (let i = 0; i < 320; i += 1) {
    const x = random() * W
    const y = random() * H
    const size = 0.5 + Math.pow(random(), 3) * 2.2
    ctx.fillStyle = `rgba(${random() > 0.25 ? '205, 214, 255' : '255, 214, 170'}, ${0.2 + random() * 0.7})`
    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fill()
  }
  // A few thin threads, the site's motif for "these come up together".
  ctx.lineWidth = 1.4
  for (let i = 0; i < 3; i += 1) {
    const from = { x: W * (0.5 + random() * 0.45), y: H * (0.08 + random() * 0.3) }
    const to = { x: W * (0.55 + random() * 0.4), y: H * (0.3 + random() * 0.3) }
    const line = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
    line.addColorStop(0, 'rgba(238, 240, 255, 0)')
    line.addColorStop(0.5, 'rgba(120, 140, 255, 0.35)')
    line.addColorStop(1, 'rgba(238, 240, 255, 0)')
    ctx.strokeStyle = line
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo((from.x + to.x) / 2 + 80, (from.y + to.y) / 2 - 60, to.x, to.y)
    ctx.stroke()
  }

  // Masthead and kind.
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = MUTED
  ctx.font = `400 26px ${SERIF}`
  spaced('8px')
  ctx.fillText('贝儿说 · 次要人生', PAD, 112)
  ctx.fillStyle = tint
  ctx.beginPath()
  ctx.arc(PAD + 7, 196, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = `400 28px ${SERIF}`
  spaced('10px')
  ctx.fillText(ENTITY_LABELS[entity.kind], PAD + 28, 206)

  // Name and note.
  spaced('4px')
  ctx.fillStyle = IVORY
  ctx.font = `600 88px ${SERIF}`
  ctx.shadowColor = `${tint}88`
  ctx.shadowBlur = 36
  const name = entity.kind === 'book' || entity.kind === 'film' ? `《${entity.name}》` : entity.name
  let y = 318
  for (const line of wrap(ctx, name, W - PAD * 2, 2)) {
    ctx.fillText(line, PAD, y)
    y += 104
  }
  ctx.shadowBlur = 0
  if (maker) {
    ctx.font = `400 30px ${SERIF}`
    ctx.fillStyle = SOFT
    ctx.fillText(maker, PAD, y - 34)
    y += 20
  }
  spaced('1px')
  ctx.font = `400 34px ${SERIF}`
  ctx.fillStyle = SOFT
  for (const line of wrap(ctx, entity.note, W - PAD * 2, 3)) {
    ctx.fillText(line, PAD, y)
    y += 56
  }

  // Where it comes up.
  y += 30
  ctx.strokeStyle = 'rgba(241, 227, 200, 0.25)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, y)
  ctx.lineTo(PAD + 120, y)
  ctx.stroke()
  y += 64
  const { rows, count } = rowsFor(entity, episodes, moments)
  ctx.font = `400 26px ${SANS}`
  spaced('6px')
  ctx.fillStyle = MUTED
  ctx.fillText(count ? `在 ${count} 期节目里谈到` : '通过作品出现在节目里', PAD, y)
  y += 58
  spaced('0px')
  const room = Math.min(6, Math.max(0, Math.floor((H - 420 - y) / 74)))
  for (const row of rows.slice(0, room)) {
    ctx.font = `400 26px ${SERIF}`
    ctx.fillStyle = BLUE
    ctx.fillText(row.label, PAD, y)
    ctx.font = `400 32px ${SERIF}`
    ctx.fillStyle = IVORY
    ctx.fillText(fit(ctx, row.title, W - PAD * 2 - 230), PAD + 230, y)
    y += 74
  }
  if (rows.length > room) {
    ctx.font = `400 24px ${SANS}`
    ctx.fillStyle = MUTED
    ctx.fillText(`还有 ${rows.length - room} 处 · 扫码看全部`, PAD + 230, y)
  }

  // Footer: the show, how to find it, and a code that opens this page with a subscribe link on 小宇宙.
  const qrSize = 232
  const qrX = W - PAD - qrSize
  const qrY = H - PAD - qrSize
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.roundRect(qrX - 14, qrY - 14, qrSize + 28, qrSize + 28, 18)
  ctx.fill()
  const code = document.createElement('canvas')
  await QRCode.toCanvas(code, url, { margin: 0, width: qrSize, errorCorrectionLevel: 'M', color: { dark: '#141a40', light: '#ffffff' } })
  ctx.drawImage(code, qrX, qrY, qrSize, qrSize)
  const cover = await loadImage('/brand/show-cover.png')
  const footY = H - PAD - qrSize + 8
  if (cover) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(PAD + 40, footY + 40, 40, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(cover, PAD, footY, 80, 80)
    ctx.restore()
  }
  ctx.fillStyle = IVORY
  ctx.font = `600 34px ${SERIF}`
  spaced('4px')
  ctx.fillText('次要人生', PAD + 104, footY + 36)
  ctx.font = `400 24px ${SERIF}`
  ctx.fillStyle = SOFT
  spaced('1px')
  ctx.fillText('Flip Your Mind · 倪贝儿', PAD + 104, footY + 74)
  ctx.font = `400 24px ${SANS}`
  ctx.fillStyle = MUTED
  ctx.fillText('小宇宙 / Apple Podcasts 搜索「次要人生」', PAD, footY + 150)
  ctx.fillText('扫码打开这一页的完整星图', PAD, footY + 192)
  ctx.fillText(new URL(url).host, PAD, footY + 234)

  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('无法生成图片'))), 'image/png'))
}
