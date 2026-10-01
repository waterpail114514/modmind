import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useState } from 'react'
import { FileCode2, LoaderCircle, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import type { ServerPluginDependency, PluginDownloadVersion } from '../../../shared/serverPlugin'
import { useConfirmDialog } from './InteractionDialogs'
import { platformLabel } from '../../../shared/projectPlatform'


export function ServerPluginDependencies({ project, onOpenCode }: { project: ProjectInfo; onOpenCode: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [versions, setVersions] = useState<PluginDownloadVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [coordinate, setCoordinate] = useState('')
  const [repository, setRepository] = useState('')
  const [items, setItems] = useState<ServerPluginDependency[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const { confirm, dialog } = useConfirmDialog()
  const refresh = (): Promise<void> => window.modmind.serverPlugin.dependencies(project.path).then(setItems)
  useEffect(() => { void refresh().catch(error => setNotice(reportClientFailure(error))) }, [project.path])
  const run = async (action: () => Promise<unknown>): Promise<void> => { setBusy(true); setNotice(''); try { await action(); await refresh() } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) } }
  return <div className="addon-relationships-page plugin-dependencies-page"><header className="content-toolbar addon-relationships-toolbar"><h1 className="visually-hidden">依赖与联动</h1><div className="modpack-tool-actions"><button className="secondary-button" onClick={onOpenCode}><FileCode2 size={15} />编译依赖</button><button className="primary-button" disabled={busy} onClick={() => void run(() => window.modmind.serverPlugin.importDependencies(project.path))}><Upload size={15} />导入插件</button></div></header>
    <div className="plugin-dependency-layout">
      <section className="addon-browser-section plugin-search-card"><div className="addon-section-heading"><div><h2>下载兼容插件</h2></div></div><div className="plugin-search-bar"><input aria-label="插件搜索" placeholder="搜索插件名称或 ID" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && query.trim()) void run(async () => { setHits(await window.modmind.serverPlugin.search(project.path, query)); setVersions([]) }) }} /><button className="secondary-button" disabled={busy || !query.trim()} onClick={() => void run(async () => { setHits(await window.modmind.serverPlugin.search(project.path, query)); setVersions([]) })}>搜索</button></div><div className="plugin-search-results">{hits.map(hit => <button className="plugin-search-result" key={hit.id} disabled={busy} onClick={() => void run(async () => { const next = await window.modmind.serverPlugin.dependencyVersions(project.path, hit.id); setVersions(next); setVersionId(next[0]?.id ?? '') })}><span><strong>{hit.name}</strong><small>{hit.description || hit.id}</small></span><span className="plugin-result-arrow">›</span></button>)}{!hits.length ? <p className="plugin-empty">输入插件名称开始搜索</p> : null}</div>{versions.length ? <div className="plugin-version-picker"><select aria-label="插件版本" value={versionId} onChange={event => setVersionId(event.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="primary-button" disabled={busy || !versionId} onClick={() => void run(() => window.modmind.serverPlugin.downloadDependency(project.path, versionId))}>下载并安装</button></div> : null}</section>
      <div className="plugin-dependency-stack"><section className="addon-targets-section"><div className="addon-section-heading"><div><h2>编译 API</h2></div></div><div className="plugin-compact-fields"><label>Maven 坐标<input value={coordinate} onChange={event => setCoordinate(event.target.value)} placeholder="group:artifact:version" /></label><label>仓库地址<input value={repository} onChange={event => setRepository(event.target.value)} placeholder="可选，默认使用项目仓库" /></label></div><button className="secondary-button" disabled={busy || !coordinate.trim()} onClick={() => void run(async () => { await window.modmind.production.dependencies.installMaven({ coordinate, repository, configuration: 'compileOnly' }); setNotice('API 已声明，构建时解析；运行插件需单独安装') })}>添加 compileOnly API</button></section>
      <section className="addon-targets-section"><div className="addon-section-heading"><div><h2>测试服运行插件</h2></div></div><div className="plugin-runtime-list">{items.map(item => <div className="plugin-runtime-row" key={item.fileName}><span className="plugin-runtime-mark" /><span><strong>{item.descriptor.name} <em>{item.descriptor.version}</em></strong><small>{item.fileName} · {item.descriptor.dependencies.map(dependency => dependency.name).join(', ') || '无声明依赖'}</small></span><button className="icon-button" title="移除运行插件" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: '移除运行依赖', message: `移除 ${item.descriptor.name} 的 JAR；保留测试服中的插件数据。`, confirmLabel: '移除', tone: 'danger' })) await run(() => window.modmind.serverPlugin.removeDependency(project.path, item.fileName)) })()}><Trash2 size={15} /></button></div>)}</div>{!items.length ? <p className="plugin-empty">暂无运行依赖插件</p> : null}</section></div>
    </div>{notice ? <p className="plugin-dependency-notice" role="status">{notice}</p> : null}{dialog}</div>
}

export function ServerPluginMigration({ project, onPlan }: { project: ProjectInfo; onPlan: (prompt: string) => void }): React.JSX.Element {
  const [platform, setPlatform] = useState(project.loader)
  const [version, setVersion] = useState(project.minecraftVersion)
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState(false)
  const inspect = async (): Promise<void> => {
    setBusy(true)
    try {
      const descriptor = await window.modmind.serverPlugin.inspect(project.path)
      const dependencies = await window.modmind.serverPlugin.dependencies(project.path)
      setReport(`当前 ${project.loader} ${project.minecraftVersion} → ${platform} ${version}。${descriptor ? `入口 ${descriptor.main}；命令 ${descriptor.commands.length}；权限 ${descriptor.permissions.length}。` : '描述文件将在构建时生成。'}运行依赖 ${dependencies.length} 项。${platform === 'folia' ? '需要逐项检查区域与实体线程调度。' : platform === 'velocity' || project.loader === 'velocity' ? '代理与世界插件之间需要业务架构适配。' : '需要重新解析 API、编译及真实核心验证。'}尚未修改工程。`)
    } catch (error) { setReport(reportClientFailure(error)) } finally { setBusy(false) }
  }
  return <section className="migration-band"><div className="section-title-row"><h2>插件版本迁移</h2><span>{platformLabel(project.loader)} · {project.minecraftVersion}</span></div><div className="migration-controls"><select aria-label="目标插件平台" value={platform} onChange={event => { setPlatform(event.target.value as ProjectInfo['loader']); setReport('') }}>{(['paper', 'spigot', 'folia', 'velocity'] as const).map(item => <option key={item} value={item}>{platformLabel(item)}</option>)}</select><input aria-label="目标 API 版本" value={version} onChange={event => { setVersion(event.target.value); setReport('') }} /><button className="secondary-button" disabled={busy || !version.trim()} onClick={() => void inspect()}><RefreshCw size={15} />预检</button>{report ? <button className="primary-button" onClick={() => onPlan(`请把当前服务端插件迁移到 ${platform} ${version}。先创建备份与隔离迁移副本，检查源码、描述文件、依赖和 Java 要求，复用成熟平台 API。不要只修改版本号；完成编译、核心加载及相关业务验证。预检结果：${report}`)}>交给工作台</button> : null}</div>{report ? <p className="modpack-inline-note" role="status">{report}</p> : null}</section>
}
