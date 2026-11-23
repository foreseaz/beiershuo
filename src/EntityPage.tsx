import { useEffect, useMemo } from 'react'
import { ArrowLeft, ArrowUpRight, Play } from 'lucide-react'
import { Cover, Portrait, entityLink } from './Visual'
import {
  ENTITY_LABELS, episodeLabel, timeLabel,
  type Atlas, type Entity, type Episode, type Moment, type Topic,
} from './domain'

type Props = {
  atlas: Atlas
  entity: Entity
  episodes: Map<string, Episode>
  onBack: () => void
  onEntity: (entity: Entity) => void
  onTopic: (id: string) => void
  onMoment: (moment: Moment) => void
  onPlay: (episode: Episode, startSec: number, title: string) => void
}

const shortTitle = (episode: Episode) => episode.title.replace(/^(EP\s*\d+\s*[.．:：|｜]?\s*)/i, '')

/** One page shape for people, books and concepts, over the same starfield as the map. */
export function EntityPage({ atlas, entity, episodes, onBack, onEntity, onTopic, onMoment, onPlay }: Props) {
  const entities = atlas.entities ?? []
  const byId = useMemo(() => new Map(entities.map(item => [item.id, item])), [entities])
  const moments = useMemo(() => new Map(atlas.moments.map(moment => [moment.id, moment])), [atlas])
  const link = entityLink(entity, entity.author ? byId.get(entity.author) : undefined)
  const topics = entity.topicIds.map(id => atlas.topics.find(topic => topic.id === id)).filter((topic): topic is Topic => Boolean(topic))

  useEffect(() => {
    document.title = `${entity.name} · 贝儿说`
    window.scrollTo(0, 0)
    return () => { document.title = '贝儿说 · 次要人生主题星图' }
  }, [entity])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onBack() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

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

  // Everything else named in the same episodes, most shared first.
  const own = new Set(entity.mentions.map(point => point.episodeId))
  const nearby = entities
    .filter(item => item.id !== entity.id && !related.some(group => group.items.includes(item)))
    .map(item => ({ item, shared: new Set(item.mentions.filter(point => own.has(point.episodeId)).map(point => point.episodeId)).size }))
    .filter(entry => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.item.mentions.length - a.item.mentions.length)
    .slice(0, 12)

  const groups = new Map<string, typeof entity.mentions>()
  for (const point of entity.mentions) groups.set(point.episodeId, [...(groups.get(point.episodeId) ?? []), point])
  const ordered = [...groups].sort(([a], [b]) => episodes.get(b)!.publishedAt.localeCompare(episodes.get(a)!.publishedAt))

  return (
    <div className="entity-page" role="dialog" aria-label={`${ENTITY_LABELS[entity.kind]}：${entity.name}`}>
      <div className="entity-scroll">
        <button className="entity-back" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> 星图</button>
        <header className="entity-head">
          {entity.kind !== 'concept' && (
            <div className="entity-visual">
              {entity.kind === 'person' ? <Portrait entity={entity} size={112} />
                : <Cover entity={entity} maker={byId.get(entity.author ?? entity.people?.[0] ?? '')?.name} width={132} />}
            </div>
          )}
          <p className="entity-kind">{ENTITY_LABELS[entity.kind]}{entity.kind === 'film' && entity.format ? ` · ${entity.format}${entity.year ? ` · ${entity.year}` : ''}` : ''}</p>
          <h1 className="entity-name">{entity.kind === 'book' || entity.kind === 'film' ? `《${entity.name}》` : entity.name}</h1>
          {entity.note && <p className="entity-note">{entity.note}</p>}
          {link && <a className="entity-link" href={link.href} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight size={13} aria-hidden="true" /></a>}
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
          <p className="panel-section">{ordered.length ? `在 ${ordered.length} 集里出现` : '节目里还没有提到'}</p>
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
                        <span className="row-title">在这一集的{point.via === 'notes' ? '延伸书目' : '标题'}里提到 <ArrowUpRight size={13} aria-hidden="true" /></span>
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
        <p className="entity-source">名字是从节目标题、章节和简介里找到的；点「▶」从那一段原声开始听。{entity.image && <> 照片：{entity.image.credit}，<a href={entity.image.source} target="_blank" rel="noreferrer">来源</a>。</>}</p>
      </div>
    </div>
  )
}
