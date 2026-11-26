import { useEffect, useMemo } from 'react'
import { ArrowUpRight, Play, Share2 } from 'lucide-react'
import { Cover, Portrait, entityLink } from './Visual'
import { ApplePodcastsIcon, XiaoyuzhouIcon } from './platforms'
import {
  ENTITY_LABELS, SHOW_XIAOYUZHOU, episodeLabel, shortTitle, timeLabel,
  type Atlas, type Entity, type Episode, type Mention, type Moment, type Topic,
} from './domain'

type Props = {
  atlas: Atlas
  entity: Entity
  episodes: Map<string, Episode>
  onEntity: (entity: Entity) => void
  onTopic: (id: string) => void
  onMoment: (moment: Moment) => void
  onPlay: (episode: Episode, startSec: number, title: string) => void
  onShare: (trigger: HTMLButtonElement) => void
}

/** One page shape for people, books and concepts, over the same starfield as the map. */
export function EntityPage({ atlas, entity, episodes, onEntity, onTopic, onMoment, onPlay, onShare }: Props) {
  const entities = atlas.entities ?? []
  const byId = useMemo(() => new Map(entities.map(item => [item.id, item])), [entities])
  const moments = useMemo(() => new Map(atlas.moments.map(moment => [moment.id, moment])), [atlas])
  const link = entityLink(entity, entity.author ? byId.get(entity.author) : undefined)
  const topics = entity.topicIds.map(id => atlas.topics.find(topic => topic.id === id)).filter((topic): topic is Topic => Boolean(topic))

  useEffect(() => {
    document.title = `${entity.name} · 贝儿说`
    return () => { document.title = '贝儿说 · 次要人生主题星图' }
  }, [entity])


  // Related pages: a book's author, a person's books and concepts, a concept's people.
  const related: { label: string; items: Entity[] }[] = []
  if (entity.kind === 'book' && entity.author && byId.get(entity.author)) related.push({ label: '作者', items: [byId.get(entity.author)!] })
  if (entity.kind === 'film' && entity.people?.length) {
    related.push({ label: '主创', items: entity.people.map(id => byId.get(id)).filter((item): item is Entity => Boolean(item)) })
  }
  if (entity.kind === 'person') {
    const books = entities.filter(item => item.author === entity.id)
    const films = entities.filter(item => item.kind === 'film' && item.people?.includes(entity.id))
    const concepts = entities.filter(item => item.kind === 'concept' && item.people?.includes(entity.id))
    if (books.length) related.push({ label: '著作', items: books })
    if (films.length) related.push({ label: '作品', items: films })
    if (concepts.length) related.push({ label: '相关概念', items: concepts })
  }
  if (entity.kind === 'concept' && entity.people?.length) {
    related.push({ label: '相关人物', items: entity.people.map(id => byId.get(id)).filter((item): item is Entity => Boolean(item)) })
  }

  // A person's books and films count as theirs: someone named only through a book's title still comes up in that
  // episode. Their own mentions come first, and a chapter or note already listed is not listed twice.
  const works = entity.kind === 'person'
    ? entities.filter(item => item.author === entity.id || (item.kind === 'film' && item.people?.includes(entity.id)))
    : []
  type Point = Mention & { work?: Entity }
  const groups = new Map<string, Point[]>()
  for (const point of [...entity.mentions, ...works.flatMap(work => work.mentions.map(mention => ({ ...mention, work })))] as Point[]) {
    const list = groups.get(point.episodeId) ?? []
    if (!list.some(other => (other.momentId ?? other.via) === (point.momentId ?? point.via))) list.push(point)
    groups.set(point.episodeId, list)
  }
  const ordered = [...groups].sort(([a], [b]) => episodes.get(b)!.publishedAt.localeCompare(episodes.get(a)!.publishedAt))
  const throughWorks = ordered.length > 0 && !entity.mentions.length

  // Everything else named in the same episodes, most shared first.
  const own = new Set(groups.keys())
  const nearby = entities
    .filter(item => item.id !== entity.id && !related.some(group => group.items.includes(item)))
    .map(item => ({ item, shared: new Set(item.mentions.filter(point => own.has(point.episodeId)).map(point => point.episodeId)).size }))
    .filter(entry => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.item.mentions.length - a.item.mentions.length)
    .slice(0, 12)

  return (
    <div className="entity-content">
        <header className="entity-head">
          <div className={`entity-heading${entity.kind === 'concept' ? '' : ' entity-heading--visual'}`}>
            {entity.kind !== 'concept' && (
              <div className="entity-visual">
                {entity.kind === 'person' ? <Portrait entity={entity} size={112} />
                  : <Cover entity={entity} maker={byId.get(entity.author ?? entity.people?.[0] ?? '')?.name} width="var(--entity-cover-width)" />}
              </div>
            )}
            <div>
              <p className="entity-kind">{ENTITY_LABELS[entity.kind]}{entity.kind === 'film' && entity.format ? ` · ${entity.format}${entity.year ? ` · ${entity.year}` : ''}` : ''}</p>
              <h1 className="entity-name">{entity.kind === 'book' || entity.kind === 'film' ? `《${entity.name}》` : entity.name}</h1>
              <div className="entity-actions">
                <button className="entity-link" type="button" onClick={event => onShare(event.currentTarget)}><Share2 size={13} aria-hidden="true" /> 分享卡片</button>
                {link && <a className="entity-link" href={link.href} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight size={13} aria-hidden="true" /></a>}
              </div>
            </div>
          </div>
          {entity.note && <p className="entity-note">{entity.note}</p>}
          {topics.length > 0 && (
            <div className="entity-topics">
              {topics.map(topic => (
                <button key={topic.id} className="entity-topic" type="button" onClick={() => onTopic(topic.id)}>
                  <span className="row-dot" style={{ background: topic.color, boxShadow: `0 0 10px ${topic.color}` }} aria-hidden="true" />
                  {topic.title}
                </button>
              ))}
            </div>
          )}
        </header>

        {related.map(group => (
          <section className="entity-section" key={group.label}>
            <p className="panel-section">{group.label}</p>
            <div className="entity-chips">
              {group.items.map(item => (
                <button key={item.id} className="search-chip" type="button" onClick={() => onEntity(item)}>
                  {item.kind === 'book' || item.kind === 'film' ? `《${item.name}》` : item.name}
                </button>
              ))}
            </div>
          </section>
        ))}

        <section className="entity-section card">
          <p className="panel-section">
            {!ordered.length ? '节目里还没有提到' : throughWorks ? `通过著作在 ${ordered.length} 集里出现` : `在 ${ordered.length} 集里出现`}
          </p>
          {ordered.map(([episodeId, points]) => {
            const episode = episodes.get(episodeId)!
            return (
              <div className="entity-episode" key={episodeId}>
                <p className="episode-title"><span>{episodeLabel(episode)}</span> {shortTitle(episode)}</p>
                {points.map(point => {
                  const moment = point.momentId ? moments.get(point.momentId) : undefined
                  if (moment) {
                    return (
                      <div className="row row--moment" key={moment.id}>
                        <button className="row-play" type="button" aria-label={`从 ${timeLabel(moment.startSec)} 开始听`} onClick={() => onPlay(episode, moment.startSec, moment.title)}>
                          <Play size={12} aria-hidden="true" />
                        </button>
                        <button className="row-main" type="button" onClick={() => onMoment(moment)}>
                          <span className="row-when">{timeLabel(moment.startSec)}</span>
                          <span className="row-title">{moment.title}</span>
                        </button>
                      </div>
                    )
                  }
                  return (
                    <div className="row row--moment" key={`${episodeId}-${point.via}`}>
                      <button className="row-play" type="button" aria-label="从头开始听" onClick={() => onPlay(episode, 0, shortTitle(episode))}>
                        <Play size={12} aria-hidden="true" />
                      </button>
                      <a className="row-main" href={episode.xiaoyuzhouUrl} target="_blank" rel="noreferrer">
                        <span className="row-when">{point.via === 'notes' ? '节目简介' : '单集标题'}</span>
                        <span className="row-title">
                          在这一集的{point.via === 'notes' ? '延伸书目' : '标题'}里提到{point.work ? `《${point.work.name}》` : ''} <ArrowUpRight size={13} aria-hidden="true" />
                        </span>
                      </a>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </section>

        {nearby.length > 0 && (
          <section className="entity-section">
            <p className="panel-section">同一集里还谈到</p>
            <div className="entity-chips">
              {nearby.map(({ item }) => (
                <button key={item.id} className={`search-chip search-chip--${item.kind}`} type="button" onClick={() => onEntity(item)}>
                  {item.kind === 'book' || item.kind === 'film' ? `《${item.name}》` : item.name}
                </button>
              ))}
            </div>
          </section>
        )}
        <div className="subscribe-cta">
          <img src="/brand/show-cover.png" alt="" width="44" height="44" />
          <span className="subscribe-text"><strong>订阅《次要人生》</strong><small>倪贝儿的心理播客</small></span>
          <span className="subscribe-links">
            <a href={atlas.show?.xiaoyuzhouUrl ?? SHOW_XIAOYUZHOU} target="_blank" rel="noreferrer"><XiaoyuzhouIcon size={18} />小宇宙</a>
            {atlas.show?.appleUrl && <a href={atlas.show.appleUrl} target="_blank" rel="noreferrer"><ApplePodcastsIcon size={18} />Apple Podcasts</a>}
          </span>
        </div>
        <p className="entity-source">名字是从节目标题、章节和简介里找到的；点「▶」从那一段原声开始听。{entity.image && <> 照片：{entity.image.credit}，<a href={entity.image.source} target="_blank" rel="noreferrer">来源</a>。</>}</p>
    </div>
  )
}
