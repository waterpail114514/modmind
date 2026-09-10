import { useEffect, useMemo, useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, Binary, Box, CheckCircle2, CircleAlert, Download, ExternalLink, Eye, FileArchive, FolderOpen, HardDriveDownload, LoaderCircle, RefreshCw, Search, ShieldCheck, Trash2, Upload } from 'lucide-react'
import type { ModpackManifest, ModpackModuleSide, ProjectInfo } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'

type SortMode = 'name' | 'size' | 'added'
type AuditState = { success: boolean; checked: number; errors: string[] } | null
type LockDependency = { provider?: 'modrinth' | 'curseforge'; projectId?: string; versionId?: string; kind?: string }
type LockMod = { fileName?: string; dependencies?: LockDependency[] }
type LockState = { mods?: LockMod[] } | null

function formatBytes(value: number): string {
  if (!value) return '大小未知'
  if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return Math.ceil(value / 1024) + ' KB'
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
const moduleSides: Array<{ value: ModpackModuleSide; label: string }> = [
  { value: 'both', label: '双端' },
  { value: 'server', label: '服务端' },
  { value: 'client', label: '客户端' },
  { value: 'unknown', label: '未设置' }
]

export default function ModpackModListWorkspace({ project, onOpenModule, onDecompile }: { project: ProjectInfo; onOpenModule?: (module: ProjectInfo) => void; onDecompile?: (jarPath: string) => void }): React.JSX.Element {
  const [manifest, setManifest] = useState<ModpackManifest | null>(null)
  const [lock, setLock] = useState<LockState>(null)
  const [audit, setAudit] = useState<AuditState>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('name')
  const [descending, setDescending] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()

  const load = async (): Promise<void> => {
    setBusy('refresh'); setNotice('')
    try {
      const result = await Promise.all([window.modmind.modpack.get(), window.modmind.modpack.readLock()])
      setManifest(result[0]); setLock(result[1] as LockState); setSelected(new Set()); setAudit(null)
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  const runAudit = async (): Promise<void> => {
    if (busy) return
    setBusy('audit'); setNotice('')
    try {
      const result = await window.modmind.modpack.auditLock() as AuditState
      setAudit(result)
      if (result?.success) setNotice('锁定审计通过，已检查 ' + result.checked + ' 个 Mod')
      else if (result) setNotice('发现 ' + result.errors.length + ' 个文件问题，请检查列表中的异常项')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  const importMods = async (): Promise<void> => {
    if (busy) return
    setBusy('import'); setNotice('')
    try {
      setManifest(await window.modmind.modpack.importMods()); setLock(await window.modmind.modpack.readLock() as LockState); setAudit(null); setNotice('已导入选中的 Mod')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  const removeMods = async (fileNames: string[]): Promise<void> => {
    if (busy || !fileNames.length) return
    const label = fileNames.length === 1 ? fileNames[0] : fileNames.length + ' 个 Mod'
    if (!await requestConfirm({ title: '移除整合包模组？', message: '此操作会删除本地 JAR，并同步更新锁定清单', detail: label, confirmLabel: '移除模组', cancelLabel: '保留模组', tone: 'danger' })) return
    setBusy('remove'); setNotice('')
    try {
      let next = manifest
      for (const fileName of fileNames) next = await window.modmind.modpack.removeMod(fileName)
      setManifest(next); setLock(await window.modmind.modpack.readLock() as LockState); setSelected(new Set()); setAudit(null); setNotice('已移除 ' + label + '')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  const createModule = async (): Promise<void> => {
    const name = moduleName.trim()
    if (!name || busy) return
    setBusy('module'); setNotice('')
    try { setManifest(await window.modmind.modpack.createModule(name)); setModuleName('') }
    catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  const updateModuleSide = async (namespace: string, side: ModpackModuleSide): Promise<void> => {
    if (busy) return
    setBusy('module-side'); setNotice('')
    try { setManifest(await window.modmind.modpack.updateModuleSide(namespace, side)); setNotice('已更新自制模组端标注') }
    catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  useEffect(() => {
    let active = true
    setBusy('initial')
    void Promise.all([window.modmind.modpack.get(), window.modmind.modpack.readLock()]).then(([nextManifest, nextLock]) => {
      if (!active) return
      setManifest(nextManifest); setLock(nextLock as LockState); setAudit(null)
    }).catch((error) => { if (active) setNotice(errorMessage(error)) }).finally(() => { if (active) setBusy('') })
    return () => { active = false }
  }, [project.path])

  const mods = manifest?.mods ?? []
  const modules = manifest?.modules ?? []
  const manifestFiles = useMemo(() => new Set(mods.map((mod) => mod.fileName.toLowerCase())), [mods])
  const lockFiles = useMemo(() => new Set((lock?.mods ?? []).map((mod) => mod.fileName?.toLowerCase()).filter((name): name is string => name !== undefined && manifestFiles.has(name))), [lock, manifestFiles])
  const filteredMods = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return mods.filter((mod) => !needle || mod.fileName.toLowerCase().includes(needle)).sort((left, right) => {
      const value = sort === 'size' ? left.size - right.size : sort === 'added' ? left.addedAt.localeCompare(right.addedAt) : left.fileName.localeCompare(right.fileName)
      return (descending ? -1 : 1) * (value || left.fileName.localeCompare(right.fileName))
    })
  }, [mods, query, sort, descending])
  const totalSize = mods.reduce((sum, mod) => sum + mod.size, 0)
  const selectedVisible = filteredMods.filter((mod) => selected.has(mod.fileName))
  const toggleSelected = (fileName: string): void => setSelected((current) => { const next = new Set(current); if (next.has(fileName)) next.delete(fileName); else next.add(fileName); return next })
  const toggleAll = (): void => setSelected((current) => { const next = new Set(current); const allSelected = filteredMods.length > 0 && filteredMods.every((mod) => next.has(mod.fileName)); filteredMods.forEach((mod) => allSelected ? next.delete(mod.fileName) : next.add(mod.fileName)); return next })
  const installDependency = async (dependency: LockDependency): Promise<void> => {
    if (!dependency.provider || !dependency.projectId || !dependency.versionId || busy) return
    setBusy(`dependency:${dependency.provider}:${dependency.projectId}`); setNotice('')
    try { await window.modmind.modpack.installProviderFile(dependency.provider, dependency.projectId, dependency.versionId); await load(); setNotice('前置模组已下载并加入整合包') }
    catch (error) { setNotice(errorMessage(error)) } finally { setBusy('') }
  }
  const dependencyUrl = (dependency: LockDependency): string | null => dependency.provider && dependency.projectId
    ? `${dependency.provider === 'modrinth' ? 'https://modrinth.com/mod/' : 'https://www.curseforge.com/minecraft/mc-mods/'}${encodeURIComponent(dependency.projectId)}` : null

  return <div className="modpack-mod-list-page">
    <header className="content-toolbar modpack-mod-list-toolbar"><div><h1>模组列表</h1><p>管理整合包中的第三方模组和自制模组，保持文件与锁定清单一致</p></div><div className="modpack-mod-list-actions"><button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => void importMods()}>{busy === 'import' ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}导入 Mod</button><button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => void runAudit()}>{busy === 'audit' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}审计锁定</button><button className="icon-button" type="button" title="刷新模组列表" aria-label="刷新模组列表" disabled={Boolean(busy)} onClick={() => void load()}>{busy === 'refresh' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button></div></header>
    <div className="modpack-mod-list-summary" aria-label="模组统计"><div><HardDriveDownload size={16} /><span>第三方模组</span><strong>{mods.length}</strong></div><div><Download size={16} /><span>占用空间</span><strong>{formatBytes(totalSize)}</strong></div><div className={audit?.success ? 'is-ok' : audit ? 'is-warning' : ''}><ShieldCheck size={16} /><span>锁定状态</span><strong>{audit?.success ? '已通过' : audit ? '需检查' : lockFiles.size + ' 项'}</strong></div><div><Box size={16} /><span>自制模组</span><strong>{modules.length}</strong></div></div>
    <div className="modpack-mod-list-groups"><section className="modpack-mod-list-section modpack-third-party-section"><div className="modpack-mod-list-heading"><div><HardDriveDownload size={17} /><div><h2>第三方模组</h2><p>支持搜索、排序、批量移除和锁定清单审计</p></div></div><span>{filteredMods.length}{query ? ' / ' + mods.length : ''}</span></div>
      <div className="modpack-list-tools"><label className="modpack-list-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名" aria-label="搜索第三方模组" /></label><label className="modpack-sort"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="name">名称</option><option value="size">大小</option><option value="added">添加时间</option></select></label><button className="icon-button" type="button" title={descending ? '改为升序' : '改为降序'} aria-label={descending ? '改为升序' : '改为降序'} onClick={() => setDescending((value) => !value)}>{descending ? <ArrowDownAZ size={15} /> : <ArrowUpAZ size={15} />}</button></div>
      {filteredMods.length ? <div className="modpack-bulk-bar"><label><input type="checkbox" checked={Boolean(filteredMods.length) && filteredMods.every((mod) => selected.has(mod.fileName))} onChange={toggleAll} />全选当前结果</label><span>{selected.size ? '已选择 ' + selected.size + ' 项' : '选择后可批量移除'}</span><button className="secondary-button compact danger" type="button" disabled={!selectedVisible.length || Boolean(busy)} onClick={() => void removeMods(selectedVisible.map((mod) => mod.fileName))}><Trash2 size={14} />移除所选</button></div> : null}
      <div className="modpack-list">{filteredMods.map((mod) => { const locked = lockFiles.has(mod.fileName.toLowerCase()); const lockMod = lock?.mods?.find((entry) => entry.fileName?.toLowerCase() === mod.fileName.toLowerCase()); const dependencies = lockMod?.dependencies ?? []; const auditError = audit?.errors.some((error) => error.includes(mod.fileName)); return <div className={'modpack-row modpack-mod-row' + (auditError ? ' has-error' : '')} key={mod.fileName + ':' + mod.sha256}><input className="modpack-row-check" type="checkbox" checked={selected.has(mod.fileName)} onChange={() => toggleSelected(mod.fileName)} aria-label={'选择 ' + mod.fileName} /><FileArchive size={16} /><span><strong>{mod.fileName}</strong><small>{formatBytes(mod.size)} · {locked ? '已锁定' : '未写入锁定清单'} · {new Date(mod.addedAt).toLocaleDateString()}</small>{dependencies.length ? <small className="modpack-dependencies"><span>前置：</span>{dependencies.map((dependency) => { const url = dependencyUrl(dependency); const key = `${dependency.provider}:${dependency.projectId}`; return <span className="modpack-dependency" key={key}>{url ? <a href={url} target="_blank" rel="noreferrer" title="打开前置平台页面"><ExternalLink size={11} />{dependency.projectId}</a> : <span>{dependency.projectId ?? '未知前置'}</span>}{dependency.provider && dependency.projectId && dependency.versionId ? <button className="icon-button" type="button" title="下载前置" aria-label={`下载前置 ${dependency.projectId}`} disabled={Boolean(busy)} onClick={() => void installDependency(dependency)}><Download size={12} /></button> : null}</span> })}</small> : null}</span><span className={'modpack-lock-state ' + (auditError ? 'error' : locked ? 'ok' : 'warning')} title={auditError ? '文件校验失败' : locked ? '已写入锁定清单' : '未找到锁定记录'}>{auditError ? <CircleAlert size={15} /> : locked ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}</span>{onDecompile ? <button className="icon-button" type="button" title="反编译查看源码" aria-label={'反编译 ' + mod.fileName} disabled={Boolean(busy)} onClick={() => onDecompile(project.path + '/mods/' + mod.fileName)}><Binary size={15} /></button> : null}<button className="icon-button" type="button" title="在文件管理器中显示" aria-label={'显示 ' + mod.fileName} disabled={Boolean(busy)} onClick={() => void window.modmind.project.reveal('mods/' + mod.fileName, project.path)}><Eye size={15} /></button><button className="icon-button danger" type="button" title="移除 Mod" aria-label={'移除 ' + mod.fileName} disabled={Boolean(busy)} onClick={() => void removeMods([mod.fileName])}><Trash2 size={15} /></button></div> })}{!filteredMods.length ? <p className="modpack-empty">{mods.length ? '没有匹配的 Mod' : '还没有已安装的第三方模组，前往“模组下载”添加'}</p> : null}</div>
      {audit?.errors.length ? <div className="modpack-audit-errors" role="status">{audit.errors.slice(0, 4).map((error) => <span key={error}><CircleAlert size={14} />{error}</span>)}</div> : null}</section>
      <section className="modpack-mod-list-section"><div className="modpack-mod-list-heading"><div><Box size={17} /><div><h2>自制模组</h2><p>在项目中维护的独立 Mod 模块</p></div></div><span>{modules.length}</span></div><div className="modpack-module-create"><input value={moduleName} maxLength={80} placeholder="例如：核心玩法" onChange={(event) => setModuleName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createModule() }} /><button className="primary-button" type="button" disabled={Boolean(busy) || !moduleName.trim()} onClick={() => void createModule()}>{busy === 'module' ? <LoaderCircle className="spin" size={15} /> : <Box size={15} />}新建自制模组</button></div><div className="modpack-list">{modules.map((module) => <div className="modpack-row modpack-local-module-row" key={module.namespace}><Box size={16} /><span><strong>{module.name}</strong><small>{module.namespace} · {module.path}</small></span><label className="modpack-module-side"><span>端类型</span><select value={module.side ?? 'both'} disabled={Boolean(busy)} onChange={(event) => void updateModuleSide(module.namespace, event.target.value as ModpackModuleSide)}>{moduleSides.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => void window.modmind.modpack.openModule(module.namespace).then((value) => onOpenModule?.(value)).catch((error) => setNotice(errorMessage(error)))}><FolderOpen size={14} />打开</button></div>)}{!modules.length ? <p className="modpack-empty">还没有自制模组，创建一个独立模块开始编写</p> : null}</div></section></div>
    {notice ? <div className="modpack-mod-list-notice" role="status">{notice}</div> : null}
    {confirmDialog}
  </div>
}
