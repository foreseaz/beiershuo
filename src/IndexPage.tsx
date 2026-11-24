import { useEffect, useMemo } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { ENTITY_LABELS, type Atlas, type Entity, type EntityKind } from './domain'
import { Cover, Portrait, entityLink } from './Visual'

type Props = { atlas: Atlas; kind: EntityKind; onEntity: (entity: Entity) => void }

const TITLES: Record<EntityKind, string> = { person: '节目里提到的人', book: '节目里提到的书', film: '节目里提到的影片与节目', concept: '概念' }

/** The people, books or films index: one consistent page shape over the starfield. */
export function IndexPage({ atlas, kind, onEntity }: Props) {
  const entities = atlas.entities ?? []
  const byId = useMemo(() => new Map(entities.map(item => [item.id, item])), [entities])
  const items = useMemo(() => entities
    .filter(item => item.kind === kind)
    .map(item => ({ item, episodes: new Set(item.mentions.map(point => point.episodeId)).size }))
    .sort((a, b) => b.episodes - a.episodes || a.item.name.localeCompare(b.item.name, 'zh')), [entities, kind])

  useEffect(() => {
    document.title = `${ENTITY_LABELS[kind]} · 贝儿说`
    return () => { document.title = '贝儿说 · 次要人生主题星图' }
  }, [kind])


  const maker = (item: Entity) => {
    const id = item.author ?? item.people?.[0]
    return id ? byId.get(id) : undefined
  }

  return (
    <div className="entity-content index-content">
        <header className="entity-head">
          <p className="entity-kind">{ENTITY_LABELS[kind]} · {items.length}</p>
          <h1 className="entity-name index-title">{TITLES[kind]}</h1>
        </header>
        <div className={`index-grid index-grid--${kind}`}>
          {items.map(({ item, episodes }) => {
            const by = maker(item)
            const link = entityLink(item, by)
            return (
              <article className="index-card" key={item.id}>
                <button className="index-card-main" type="button" onClick={() => onEntity(item)}>
                  {kind === 'person' ? <Portrait entity={item} size={84} /> : <Cover entity={item} maker={by?.name} width={112} />}
                  <span className="index-card-name">{kind === 'person' ? item.name : `《${item.name}》`}</span>
                  {kind !== 'person' && by && <span className="index-card-by">{by.name}</span>}
                  <span className="index-card-note">{item.note}</span>
                  <span className="index-card-count">{episodes ? `${episodes} 集里提到` : '作者 · 通过著作出现'}</span>
                </button>
                {link && (
                  <a className="index-card-link" href={link.href} target="_blank" rel="noreferrer" aria-label={`${item.name}：${link.label}`}>
                    {link.label} <ArrowUpRight size={12} aria-hidden="true" />
                  </a>
                )}
              </article>
            )
          })}
        </div>
        {kind === 'person' && <p className="entity-source">照片来自 Wikimedia Commons，按各自的自由授权使用，作者与授权写在每个人的页面上；没有自由授权照片的人显示字母标记。</p>}
        {kind !== 'person' && <p className="entity-source">封面是本站按书名设计的，不是出版方的封面。</p>}
    </div>
  )
}
