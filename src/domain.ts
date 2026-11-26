export type Topic = {
  id: string
  title: string
  description: string
  aliases: string[]
  color: string
  position: [number, number, number]
}

export type Episode = {
  id: string
  title: string
  number: number | null
  publishedAt: string
  durationSec: number
  playableDurationSec: number
  audioUrl: string | null
  appleUrl: string
  xiaoyuzhouUrl: string
  officialTopic: string | null
  chapters: { startSec: number; title: string }[]
  topicIds?: string[]
  /** The episode carries its own background music, so the site music stays silent while it plays. */
  musicBed?: boolean
}

export type RelationKind = 'related' | 'perspective' | 'continues'

export type Moment = {
  id: string
  episodeId: string
  topicIds: string[]
  kind: 'insight' | 'method' | 'chapter'
  title: string
  summary: string
  startSec: number
  endSec: number | null
  speaker: 'beier' | 'other' | 'unsure' | null
  source: 'audio_verified' | 'show_notes'
  steps?: { text: string; startSec: number }[]
}

type Relation = {
  id: string
  sourceMomentId: string
  targetMomentId: string
  reason: string
  kind: RelationKind
}

type ChapterPath = {
  id: string
  sourceEpisodeId: string
  sourceStartSec: number
  targetEpisodeId: string
  targetStartSec: number
  topicIds: string[]
  reason: string
  kind?: RelationKind
}

export type Atlas = {
  schemaVersion: 1
  contentRevision: string
  show: { name: string; host: string; appleUrl: string; xiaoyuzhouUrl: string }
  topics: Topic[]
  episodes: Episode[]
  moments: Moment[]
  relations: Relation[]
  chapterPaths?: ChapterPath[]
  entities?: Entity[]
  keywords?: { text: string; count: number }[]
}

/** The show's page on 小宇宙, used by the brand mark. */
export const SHOW_XIAOYUZHOU = 'https://www.xiaoyuzhoufm.com/podcast/6847be042278dd073b42f27c'

export type EntityKind = 'person' | 'book' | 'film' | 'concept'

export type Mention = { episodeId: string; startSec: number | null; momentId: string | null; via: 'chapter' | 'title' | 'notes' }

export type Entity = {
  id: string
  kind: EntityKind
  name: string
  note: string
  aliases: string[]
  author?: string
  people?: string[]
  topicIds: string[]
  mentions: Mention[]
  /** Parent topic for concepts that appear as sub-topic stars. */
  topic?: string
  image?: { src: string; credit: string; source: string }
  year?: number
  format?: string
  link?: { href: string; label: string }
}

export const ENTITY_ROUTES: Record<EntityKind, string> = { person: 'people', book: 'books', film: 'films', concept: 'concepts' }
export const ENTITY_LABELS: Record<EntityKind, string> = { person: '人物', book: '书', film: '影片/节目', concept: '概念' }

export function entityPath(entity: Pick<Entity, 'kind' | 'id'>) {
  return `/${ENTITY_ROUTES[entity.kind]}/${entity.id}`
}

export type Route = { kind: EntityKind; id: string } | { index: EntityKind } | null

/** `/people` → the people index, `/people/winnicott` → one person, anything else → the star map. */
export function parseRoute(pathname: string): Route {
  const index = pathname.match(/^\/(people|books|films|concepts)\/?$/)
  if (index) return { index: (Object.keys(ENTITY_ROUTES) as EntityKind[]).find(key => ENTITY_ROUTES[key] === index[1])! }
  return parseEntityPath(pathname)
}

export const indexPath = (kind: EntityKind) => `/${ENTITY_ROUTES[kind]}`

/** `/people/winnicott` → { kind: 'person', id: 'winnicott' } */
export function parseEntityPath(pathname: string): { kind: EntityKind; id: string } | null {
  const match = pathname.match(/^\/(people|books|films|concepts)\/([a-z0-9-]+)\/?$/)
  if (!match) return null
  const kind = (Object.keys(ENTITY_ROUTES) as EntityKind[]).find(key => ENTITY_ROUTES[key] === match[1])!
  return { kind, id: match[2] }
}

export type Anchor = { episode: Episode; startSec: number; title: string }

export type AtlasPath = {
  id: string
  sourceTopicId: string
  targetTopicId: string
  reason: string
  label: string
  source: Anchor
  target: Anchor
  sourceMomentId?: string
  targetMomentId?: string
}

export function timeLabel(seconds: number) {
  const timestamp = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(timestamp / 3600)
  const minutes = Math.floor((timestamp % 3600) / 60)
  const remainder = String(timestamp % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${String(minutes).padStart(2, '0')}:${remainder}`
}

export function episodeLabel(episode: Episode) {
  return episode.number === null ? '单集' : `EP${episode.number}`
}

/** The title without its leading episode number. */
export const shortTitle = (episode: Episode) => episode.title.replace(/^EP\s*\d+\s*[.．:：|｜]?\s*/i, '')

/** Month and day in Beijing time, when the show publishes: 11月26日. */
export const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' })

export function momentSource(moment: Moment) {
  if (moment.source === 'show_notes') return '节目导读'
  return moment.speaker === 'beier' ? '贝儿 · 核听' : '原声核听'
}

/**
 * Fetch the atlas, retrying twice: Cloudflare's edge security sometimes answers a first request with a 403 page
 * and lets the same request through a moment later.
 */
async function fetchAtlas(signal: AbortSignal) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('/data/v1/atlas.json', { signal, cache: attempt ? 'no-store' : 'default' })
    if (response.ok && response.headers.get('content-type')?.includes('json')) return response
    if (attempt === 2) throw new Error('主题数据暂时不可用')
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    signal.throwIfAborted()
  }
}

export async function loadAtlas(signal: AbortSignal): Promise<Atlas> {
  const response = await fetchAtlas(signal)
  const data = await response.json() as Partial<Atlas>
  if (data.schemaVersion !== 1 || !data.show || !Array.isArray(data.topics) || !data.topics.length ||
    !Array.isArray(data.episodes) || !Array.isArray(data.moments) || !Array.isArray(data.relations)) {
    throw new Error('主题数据格式有误')
  }
  return data as Atlas
}

export function getAtlasPaths(atlas: Atlas): AtlasPath[] {
  const episodes = new Map(atlas.episodes.map(episode => [episode.id, episode]))
  const moments = new Map(atlas.moments.map(moment => [moment.id, moment]))
  const labels = { related: '相似处境', perspective: '另一种看法', continues: '接着听' }
  const paths: AtlasPath[] = []

  for (const relation of atlas.relations) {
    const from = moments.get(relation.sourceMomentId)
    const to = moments.get(relation.targetMomentId)
    if (!from || !to) continue
    const sourceEpisode = episodes.get(from.episodeId)
    const targetEpisode = episodes.get(to.episodeId)
    if (!sourceEpisode || !targetEpisode) continue
    const sourceTopicId = from.topicIds[0]
    const targetTopicId = to.topicIds.find(id => id !== sourceTopicId) ?? to.topicIds[0]
    if (!sourceTopicId || !targetTopicId) continue
    paths.push({
      id: relation.id, sourceTopicId, targetTopicId, reason: relation.reason, label: labels[relation.kind],
      source: { episode: sourceEpisode, startSec: from.startSec, title: from.title },
      target: { episode: targetEpisode, startSec: to.startSec, title: to.title },
      sourceMomentId: from.id, targetMomentId: to.id,
    })
  }

  for (const path of atlas.chapterPaths ?? []) {
    const sourceEpisode = episodes.get(path.sourceEpisodeId)
    const targetEpisode = episodes.get(path.targetEpisodeId)
    if (!sourceEpisode || !targetEpisode) continue
    const sourceChapter = sourceEpisode.chapters.find(chapter => chapter.startSec === path.sourceStartSec)
    const targetChapter = targetEpisode.chapters.find(chapter => chapter.startSec === path.targetStartSec)
    if (!sourceChapter || !targetChapter) continue
    const from = atlas.moments.find(moment => moment.episodeId === sourceEpisode.id && moment.startSec === sourceChapter.startSec)
    const to = atlas.moments.find(moment => moment.episodeId === targetEpisode.id && moment.startSec === targetChapter.startSec)
    const sourceTopicId = path.topicIds[0] ?? from?.topicIds[0]
    const targetTopicId = path.topicIds[1] ?? to?.topicIds.find(id => id !== sourceTopicId) ?? sourceTopicId
    if (!sourceTopicId || !targetTopicId) continue
    paths.push({
      id: path.id, sourceTopicId, targetTopicId, reason: path.reason, label: path.kind ? labels[path.kind] : '节目导读',
      source: { episode: sourceEpisode, ...sourceChapter }, target: { episode: targetEpisode, ...targetChapter },
      sourceMomentId: from?.id, targetMomentId: to?.id,
    })
  }

  return paths
}

export function topicMoments(atlas: Atlas, topicId: string) {
  return atlas.moments.filter(moment => moment.topicIds.includes(topicId))
}
