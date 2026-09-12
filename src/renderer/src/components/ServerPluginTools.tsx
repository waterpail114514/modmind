import { useEffect, useState } from 'react'
import { FileCode2, LoaderCircle, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import type { ServerCore, ServerCoreBuild, ServerPluginDependency, ServerProfile, PluginDownloadVersion } from '../../../shared/serverPlugin'
import { useConfirmDialog } from './InteractionDialogs'
import { platformLabel } from '../../../shared/projectPlatform'

export function ServerPluginSettings({ project, disabled }: { project: ProjectInfo; disabled: boolean }): React.JSX.Element {
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  const [builds, setBuilds] = useState<ServerCoreBuild[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { let active = true; void window.modmind.serverPlugin.profile(project.path).then(value => { if (active) setProfile(value) }).catch(error => { if (active) setNotice(String(error)) }); return () => { active = false } }, [project.path])
  const patch = (value: Partial<ServerProfile>): void => { setProfile(previous => previous ? { ...previous, ...value } : null); setNotice('存在未保存的设置') }
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setNotice(''); try { await action() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  return <section className="modpack-tool-section server-plugin-settings"><div className="modpack-tool-heading"><div><span className="plugin-card-kicker">CONFIGURATION</span><h2>服务端核心与运行配置</h2><p>启动前确认核心、Java 和端口；运行中的服务端会锁定这些设置。</p></div></div>{profile ? <><fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0 }}><div className="modpack-form-grid">
    <label>核心<select value={profile.core} onChange={event => { patch({ core: event.target.value as ServerCore, build: undefined, localJar: undefined }); setBuilds([]) }}>{(project.loader === 'velocity' ? ['velocity', 'custom'] : ['paper', 'purpur', 'spigot', 'folia', 'custom']).map(core => <option key={core} value={core}>{core}</option>)}</select></label>
    <label>运行版本<input value={profile.version} onChange={event => { patch({ version: event.target.value, build: undefined }); setBuilds([]) }} /></label>
    <label>构建<select value={profile.build ?? ''} onChange={event => patch({ build: event.target.value || undefined })}><option value="">首次运行锁定稳定构建</option>{profile.build && !builds.some(item => item.build === profile.build) ? <option value={profile.build}>{profile.build}</option> : null}{builds.map(item => <option key={item.build} value={item.build}>{item.build} · {item.channel}</option>)}</select></label>
    <label>Java<select value={profile.javaVersion} onChange={event => patch({ javaVersion: Number(event.target.value) })}>{[8, 17, 21, 25].map(version => <option key={version}>{version}</option>)}</select></label>
    <label>内存 MB<input type="number" min={512} max={32768} step={512} value={profile.memoryMb} onChange={event => patch({ memoryMb: Number(event.target.value) })} /></label>
    <label>端口<input type="number" min={1024} max={65535} value={profile.port} onChange={event => patch({ port: Number(event.target.value) })} /></label>
  </div><div className="modpack-tool-actions"><label><input type="checkbox" checked={profile.onlineMode} onChange={event => patch({ onlineMode: event.target.checked })} /> 在线身份验证</label>{profile.core !== 'velocity' ? <label><input type="checkbox" checked={profile.eulaAccepted} onChange={event => patch({ eulaAccepted: event.target.checked })} /> 我接受 Minecraft EULA</label> : null}<a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">EULA</a></div>
  <div className="modpack-tool-actions"><button className="secondary-button" onClick={() => void run(async () => { setBuilds(await window.modmind.serverPlugin.builds(profile.core, profile.version)); setNotice('构建目录已更新') })}><RefreshCw size={15} />刷新构建</button><button className="secondary-button" onClick={() => void run(async () => { const next = await window.modmind.serverPlugin.importCore(project.path); if (next) { setProfile(next); setNotice('本地核心已导入，兼容性待运行验证') } })}><Upload size={15} />导入核心 JAR</button><button className="primary-button" onClick={() => void run(async () => { setProfile(await window.modmind.serverPlugin.saveProfile(project.path, profile)); setNotice('运行设置已保存') })}><Save size={15} />保存</button></div></fieldset>{profile.localJar ? <p className="modpack-inline-note">{profile.localJar}</p> : null}</> : <LoaderCircle className="spin" size={18} />}{notice ? <p role="status" className="modpack-inline-note">{notice}</p> : null}</section>
}

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
  useEffect(() => { void refresh().catch(error => setNotice(String(error))) }, [project.path])
  const run = async (action: () => Promise<unknown>): Promise<void> => { setBusy(true); setNotice(''); try { await action(); await refresh() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  return <div className="addon-relationships-page plugin-dependencies-page"><header className="content-toolbar addon-relationships-toolbar"><div><h1>依赖与联动</h1><p>{project.loader} · {project.minecraftVersion} · 让编译依赖与测试服插件保持一致</p></div><div className="modpack-tool-actions"><button className="secondary-button" onClick={onOpenCode}><FileCode2 size={15} />编译依赖</button><button className="primary-button" disabled={busy} onClick={() => void run(() => window.modmind.serverPlugin.importDependencies(project.path))}><Upload size={15} />导入插件</button></div></header>
    <div className="plugin-dependency-layout">
      <section className="addon-browser-section plugin-search-card"><div className="addon-section-heading"><div><h2>下载兼容插件</h2><p>从 Modrinth 查找与当前平台匹配的运行依赖。</p></div></div><div className="plugin-search-bar"><input aria-label="插件搜索" placeholder="搜索插件名称或 ID" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && query.trim()) void run(async () => { setHits(await window.modmind.serverPlugin.search(project.path, query)); setVersions([]) }) }} /><button className="secondary-button" disabled={busy || !query.trim()} onClick={() => void run(async () => { setHits(await window.modmind.serverPlugin.search(project.path, query)); setVersions([]) })}>搜索</button></div><div className="plugin-search-results">{hits.map(hit => <button className="plugin-search-result" key={hit.id} disabled={busy} onClick={() => void run(async () => { const next = await window.modmind.serverPlugin.dependencyVersions(project.path, hit.id); setVersions(next); setVersionId(next[0]?.id ?? '') })}><span><strong>{hit.name}</strong><small>{hit.description || hit.id}</small></span><span className="plugin-result-arrow">›</span></button>)}{!hits.length ? <p className="plugin-empty">输入插件名称开始搜索</p> : null}</div>{versions.length ? <div className="plugin-version-picker"><select aria-label="插件版本" value={versionId} onChange={event => setVersionId(event.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="primary-button" disabled={busy || !versionId} onClick={() => void run(() => window.modmind.serverPlugin.downloadDependency(project.path, versionId))}>下载并安装</button></div> : null}</section>
      <div className="plugin-dependency-stack"><section className="addon-targets-section"><div className="addon-section-heading"><div><h2>编译 API</h2><p>只参与编译解析，避免把 API 误装进运行服。</p></div></div><div className="plugin-compact-fields"><label>Maven 坐标<input value={coordinate} onChange={event => setCoordinate(event.target.value)} placeholder="group:artifact:version" /></label><label>仓库地址<input value={repository} onChange={event => setRepository(event.target.value)} placeholder="可选，默认使用项目仓库" /></label></div><button className="secondary-button" disabled={busy || !coordinate.trim()} onClick={() => void run(async () => { await window.modmind.production.dependencies.installMaven({ coordinate, repository, configuration: 'compileOnly' }); setNotice('API 已声明，构建时解析；运行插件需单独安装') })}>添加 compileOnly API</button></section>
      <section className="addon-targets-section"><div className="addon-section-heading"><div><h2>测试服运行插件</h2><p>这里的 JAR 会部署到本机测试服 plugins 目录。</p></div></div><div className="plugin-runtime-list">{items.map(item => <div className="plugin-runtime-row" key={item.fileName}><span className="plugin-runtime-mark" /><span><strong>{item.descriptor.name} <em>{item.descriptor.version}</em></strong><small>{item.fileName} · {item.descriptor.dependencies.map(dependency => dependency.name).join(', ') || '无声明依赖'}</small></span><button className="icon-button" title="移除运行插件" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: '移除运行依赖', message: `移除 ${item.descriptor.name} 的 JAR；保留测试服中的插件数据。`, confirmLabel: '移除', tone: 'danger' })) await run(() => window.modmind.serverPlugin.removeDependency(project.path, item.fileName)) })()}><Trash2 size={15} /></button></div>)}</div>{!items.length ? <p className="plugin-empty">暂无运行依赖插件</p> : null}</section></div>
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
    } catch (error) { setReport(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  return <section className="migration-band"><div className="section-title-row"><h2>插件版本迁移</h2><span>{platformLabel(project.loader)} · {project.minecraftVersion}</span></div><div className="migration-controls"><select aria-label="目标插件平台" value={platform} onChange={event => { setPlatform(event.target.value as ProjectInfo['loader']); setReport('') }}>{(['paper', 'spigot', 'folia', 'velocity'] as const).map(item => <option key={item} value={item}>{platformLabel(item)}</option>)}</select><input aria-label="目标 API 版本" value={version} onChange={event => { setVersion(event.target.value); setReport('') }} /><button className="secondary-button" disabled={busy || !version.trim()} onClick={() => void inspect()}><RefreshCw size={15} />预检</button>{report ? <button className="primary-button" onClick={() => onPlan(`请把当前服务端插件迁移到 ${platform} ${version}。先创建备份与隔离迁移副本，检查源码、描述文件、依赖和 Java 要求，复用成熟平台 API。不要只修改版本号；完成编译、核心加载及相关业务验证。预检结果：${report}`)}>交给工作台</button> : null}</div>{report ? <p className="modpack-inline-note" role="status">{report}</p> : null}</section>
}
