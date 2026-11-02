import { useState } from 'react'
import { ExternalLink, GitCompareArrows, LoaderCircle, Search } from 'lucide-react'
import type { MappingClassDetail, MappingClassResult } from '../../src/shared/mappings'
import { platformLabel } from '../../src/shared/projectPlatform'
import { reportClientFailure as errorMessage } from '../../src/renderer/src/lib/clientFailure'
import { javaMod, registerFeature, type FeaturePageContext } from '../sdk/renderer'

function Mappings({ project }: FeaturePageContext): React.JSX.Element | null {
  const [mappingQuery, setMappingQuery] = useState('')
  const [mappingResults, setMappingResults] = useState<MappingClassResult[]>([])
  const [mappingDetail, setMappingDetail] = useState<MappingClassDetail | null>(null)
  const [mappingMemberQuery, setMappingMemberQuery] = useState('')
  const [mappingBusy, setMappingBusy] = useState(false)
  const [mappingMessage, setMappingMessage] = useState('输入任意命名空间中的类名，例如 Item、class_1792 或 C_1381_')

  const searchMappings = async (): Promise<void> => {
    if (!project || !mappingQuery.trim()) return
    setMappingBusy(true)
    setMappingDetail(null)
    try {
      const result = await window.modmind.mappings.search(project.minecraftVersion, mappingQuery)
      setMappingResults(result.results)
      setMappingMessage(result.results.length
        ? `Minecraft ${result.version} · ${result.results.length} 个结果 · ${result.cached ? '本地缓存' : '已从 mappings.dev 下载并缓存'}`
        : `Minecraft ${result.version} 中没有匹配的类`)
    } catch (error) {
      setMappingResults([])
      setMappingMessage(errorMessage(error))
    } finally {
      setMappingBusy(false)
    }
  }

  const openMapping = async (entry: MappingClassResult): Promise<void> => {
    if (!project) return
    setMappingBusy(true)
    try {
      const className = entry.names.Mojang ?? Object.values(entry.names)[0]
      const detail = await window.modmind.mappings.getClass(project.minecraftVersion, className)
      setMappingDetail(detail)
      setMappingMemberQuery('')
      setMappingMessage(`${detail.members.length} 个字段、构造器和方法 · ${detail.cached ? '本地缓存' : '已缓存供离线使用'}`)
    } catch (error) {
      setMappingMessage(errorMessage(error))
    } finally {
      setMappingBusy(false)
    }
  }

  const filteredMappingMembers = mappingDetail?.members.filter((member) => {
    const query = mappingMemberQuery.trim().toLowerCase()
    return !query || `${member.type} ${Object.values(member.names).join(' ')}`.toLowerCase().includes(query)
  }) ?? []
  if (!project) return null
  return (
              <div className="mappings-page">
                <div className="content-toolbar">
                  <h1 className="visually-hidden">Minecraft 映射表</h1><span className="toolbar-context">Minecraft {project.minecraftVersion}</span>
                  <div className="toolbar-actions">
                    <button className="mapping-source-link" onClick={() => void window.modmind.mappings.openLoaderDocs(project.loader)}><ExternalLink size={13} />{platformLabel(project.loader)} 文档</button>
                    <button className="mapping-source-link" onClick={() => void window.modmind.mappings.openSource(project.minecraftVersion)}><ExternalLink size={13} />mappings.dev</button>
                  </div>
                </div>
                <div className="mapping-search-band">
                  <div className="mapping-search-box">
                    <Search size={16} />
                    <input
                      value={mappingQuery}
                      onChange={(event) => setMappingQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') void searchMappings() }}
                      placeholder="搜索类名或包名"
                    />
                    <button className="primary-button" disabled={mappingBusy || !mappingQuery.trim()} onClick={() => void searchMappings()}>
                      {mappingBusy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}查询
                    </button>
                  </div>
                  <p>{mappingMessage}</p>
                </div>
                <div className="mapping-layout">
                  <aside className="mapping-results">
                    <div className="panel-title"><span>类列表</span><small>{mappingResults.length}</small></div>
                    {mappingResults.map((entry) => {
                      const primary = entry.names.Mojang ?? Object.values(entry.names)[0]
                      return (
                        <button key={entry.pagePath} className={mappingDetail?.pagePath === entry.pagePath ? 'selected' : ''} onClick={() => void openMapping(entry)}>
                          <strong>{primary.split('/').at(-1)}</strong>
                          <span>{primary.replaceAll('/', '.')}</span>
                          <small>{Object.entries(entry.names).filter(([namespace]) => namespace !== 'Mojang').slice(0, 2).map(([namespace, name]) => `${namespace}: ${name.split('/').at(-1)}`).join(' · ')}</small>
                        </button>
                      )
                    })}
                    {!mappingResults.length ? <div className="mapping-empty"><GitCompareArrows size={24} /><span>查询结果会显示在这里</span></div> : null}
                  </aside>
                  <section className="mapping-detail">
                    {mappingDetail ? (
                      <>
                        <div className="mapping-detail-head">
                          <div><span>声明</span><h2>{mappingDetail.declaration}</h2></div>
                          <input value={mappingMemberQuery} onChange={(event) => setMappingMemberQuery(event.target.value)} placeholder="筛选字段或方法" />
                        </div>
                        <div className="mapping-class-names">
                          {Object.entries(mappingDetail.names).map(([namespace, name]) => <div key={namespace}><span>{namespace}</span><code>{name.replaceAll('/', '.')}</code></div>)}
                        </div>
                        <div className="mapping-member-heading"><strong>成员列表</strong><span>{filteredMappingMembers.length} 条</span></div>
                        <div className="mapping-members">
                          {filteredMappingMembers.map((member, index) => (
                            <article key={`${member.kind}-${index}`}>
                              <div><span className={`mapping-kind ${member.kind}`}>{member.kind}</span><code>{member.type}</code></div>
                              <dl>{Object.entries(member.names).map(([namespace, name]) => <div key={namespace}><dt>{namespace}</dt><dd>{name}</dd></div>)}</dl>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : <div className="mapping-detail-empty"><GitCompareArrows size={30} /><h2>选择一个类查看完整映射</h2></div>}
                  </section>
                </div>
              </div>
  )
}
registerFeature('mappings', { apiVersion: 2, pages: [{ id: 'mappings', label: '映射表', group: '开发', icon: GitCompareArrows, supports: javaMod, component: Mappings }] })
