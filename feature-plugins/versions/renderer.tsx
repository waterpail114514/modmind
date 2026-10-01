import { useEffect, useState } from 'react'
import { Archive, ChevronRight, CircleAlert, History, LoaderCircle, PackageOpen, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import type { LoaderKind, LoaderVersionOption, ProjectMigrationPreview, SnapshotInfo, SnapshotStorageInfo } from '../../src/shared/types'
import { isJavaLoader, platformLabel } from '../../src/shared/projectPlatform'
import GitWorkspace from './components/GitWorkspace'
import { ServerPluginMigration } from '../../src/renderer/src/components/ServerPluginTools'
import { useConfirmDialog } from '../../src/renderer/src/components/InteractionDialogs'
import { reportClientFailure as errorMessage } from '../../src/renderer/src/lib/clientFailure'
import { anyProject, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  )
}

function formatStorageBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.ceil(value / 1024)} KB`
}


function Versions(context: FeaturePageContext): React.JSX.Element | null {
  const { project, setNotice } = context
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [snapshotStorage, setSnapshotStorage] = useState<SnapshotStorageInfo | null>(null)
  const [snapshotStorageError, setSnapshotStorageError] = useState('')
  const [restoringSnapshotId, setRestoringSnapshotId] = useState('')
  const [deletingSnapshotId, setDeletingSnapshotId] = useState('')
  const [loaderCatalog, setLoaderCatalog] = useState<LoaderVersionOption[]>([])
  const [migrationLoader, setMigrationLoader] = useState<LoaderKind>('fabric')
  const [migrationVersion, setMigrationVersion] = useState('')
  const [migrationPreview, setMigrationPreview] = useState<ProjectMigrationPreview | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const currentSnapshotStorage = snapshotStorage
  const snapshotStorageWarning = Boolean(currentSnapshotStorage?.warning)
  const building = context.projectBusy, planning = context.projectBusy
  const migrationVersions = loaderCatalog.filter(option => option.loader === migrationLoader)
  const selectedMigrationVersion = migrationVersion || migrationVersions[0]?.minecraftVersion || ''
  const refreshSnapshots = (): Promise<void> => project ? window.modmind.snapshots.list(project.path).then(setSnapshots) : Promise.resolve()
  const refreshFiles = context.filesChanged
  useEffect(() => {
    if (!project) return
    let active = true
    const path = project.path
    void window.modmind.snapshots.list(path).then(value => { if (active) setSnapshots(value) }).catch(error => { if (active) setNotice(errorMessage(error)) })
    void window.modmind.project.listLoaderVersions().then(value => { if (active) setLoaderCatalog(value) }).catch(() => undefined)
    const accept = (value: SnapshotStorageInfo): void => { if (active && value.projectPath === path) { setSnapshotStorage(value); setSnapshotStorageError(''); void refreshSnapshots() } }
    const unsubscribe = window.modmind.snapshots.onStorageChanged(accept)
    void window.modmind.snapshots.storage(path).then(accept).catch(error => { if (active) setSnapshotStorageError(errorMessage(error)) })
    return () => { active = false; unsubscribe() }
  }, [project?.path])
  const createSnapshot = async (): Promise<void> => {
    if (!project) return
    try { const result = await window.modmind.snapshots.create('手动快照', project.path); await refreshSnapshots(); setNotice(`已保存 ${result.fileCount} 个文件`) } catch (error) { setNotice(`快照失败：${errorMessage(error)}`) }
  }
  const restoreSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    if (!project || restoringSnapshotId || deletingSnapshotId || context.projectBusy || migrationBusy) return
    if (!await requestConfirm({ title: `恢复快照“${snapshot.label}”？`, message: '当前项目状态会先自动备份，恢复失败时会自动回滚。代码编辑器中的修改会先保存，并包含在安全备份中。', confirmLabel: '恢复快照', actionIcon: 'restore' })) return
    setRestoringSnapshotId(snapshot.id)
    try { await context.saveBeforeRestore(); const result = await window.modmind.snapshots.restore(snapshot.id, project.path); context.projectRestored(result.project); await refreshSnapshots(); setNotice(`已恢复“${result.snapshot.label}”，恢复前状态已备份为 ${result.backup.id.slice(0, 19)}`) } catch (error) { setNotice(`恢复失败：${errorMessage(error)}`) } finally { setRestoringSnapshotId('') }
  }
  const deleteSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    if (!project || restoringSnapshotId || deletingSnapshotId || context.projectBusy || migrationBusy) return
    if (!await requestConfirm({ title: `永久删除快照“${snapshot.label}”？`, message: '删除后无法从 ModMind 恢复', confirmLabel: '永久删除', tone: 'danger' })) return
    setDeletingSnapshotId(snapshot.id)
    try { setSnapshots(await window.modmind.snapshots.delete(snapshot.id, project.path)); setNotice(`已删除快照“${snapshot.label}”`) } catch (error) { setNotice(`删除快照失败：${errorMessage(error)}`) } finally { setDeletingSnapshotId('') }
  }
  const previewMigration = async (): Promise<void> => {
    if (!project || !selectedMigrationVersion) return
    setMigrationBusy(true)
    try { setMigrationPreview(await window.modmind.project.previewMigration({ loader: migrationLoader, minecraftVersion: selectedMigrationVersion })) } catch (error) { setNotice(`迁移预检失败：${errorMessage(error)}`) } finally { setMigrationBusy(false) }
  }
  const runMigration = async (): Promise<void> => {
    if (!migrationPreview || migrationPreview.blockers.length) return
    setMigrationBusy(true)
    try { const result = await window.modmind.project.migrate({ loader: migrationPreview.target.loader, minecraftVersion: migrationPreview.target.minecraftVersion }); if (result) { context.openProject(result.project); setNotice(`迁移项目已生成，报告：${result.reportPath}`) } } catch (error) { setNotice(`迁移失败：${errorMessage(error)}`) } finally { setMigrationBusy(false) }
  }
  if (!project) return null
  return <>
              <div className="standard-page snapshot-page">
                <div className="content-toolbar">
                  <h1 className="visually-hidden">版本与迁移</h1><span className="toolbar-context">{platformLabel(project.loader)} · {project.minecraftVersion}</span>
                  <button className="primary-button" onClick={() => void createSnapshot()}><Plus size={16} />创建快照</button>
                </div>
                {project.kind === 'server-plugin' ? <ServerPluginMigration project={project} onPlan={value => { context.sendToWorkbench(value) }} /> : project.kind !== 'modpack' && (isJavaLoader(project.loader) ? <section className="migration-band">
                  <div className="section-title-row"><h2>迁移目标</h2><span>生成到新目录</span></div>
                  <div className="migration-controls">
                    <div className="segmented-control">
                      {(['fabric', 'quilt', 'forge', 'neoforge'] as const).map((loader) => <button key={loader} className={migrationLoader === loader ? 'active' : ''} onClick={() => { setMigrationLoader(loader); setMigrationVersion(''); setMigrationPreview(null) }}>{loader === 'fabric' ? 'Fabric' : loader === 'quilt' ? 'Quilt' : loader === 'forge' ? 'Forge' : 'NeoForge'}</button>)}
                    </div>
                    <select value={selectedMigrationVersion} onChange={(event) => { setMigrationVersion(event.target.value); setMigrationPreview(null) }}>
                      {migrationVersions.map((option) => <option key={`${option.loader}-${option.minecraftVersion}`} value={option.minecraftVersion}>{option.minecraftVersion}</option>)}
                    </select>
                    <button className="secondary-button" disabled={migrationBusy || !selectedMigrationVersion} onClick={() => void previewMigration()}>{migrationBusy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}预检</button>
                  </div>
                  {migrationPreview ? <div className="migration-preview">
                    <div><strong>{migrationPreview.source.loader} {migrationPreview.source.minecraftVersion}</strong><ChevronRight size={15} /><strong>{migrationPreview.target.loader} {migrationPreview.target.minecraftVersion}</strong>{migrationPreview.target.supportTier === 'stable' ? <span className="migration-tier stable">稳定</span> : null}</div>
                    {migrationPreview.warnings.map((warning) => <p key={warning}><CircleAlert size={14} />{warning}</p>)}
                    {migrationPreview.blockers.map((blocker) => <p className="error" key={blocker}><X size={14} />{blocker}</p>)}
                    <button className="primary-button" disabled={migrationBusy || Boolean(migrationPreview.blockers.length)} onClick={() => void runMigration()}>{migrationBusy ? <LoaderCircle className="spin" size={15} /> : <PackageOpen size={15} />}生成迁移项目</button>
                  </div> : null}
                </section> : <section className="migration-band"><div className="section-title-row"><h2>平台版本</h2><span>{platformLabel(project.loader)}</span></div><p>基岩与网易工程不执行 Java Loader 自动迁移。升级最低引擎或 Mod SDK 前请先创建快照，并按目标平台 API 逐项验证</p></section>)}
                <GitWorkspace project={project} onFilesChanged={() => { void refreshFiles(); void refreshSnapshots() }} />
                <div className={`snapshot-storage ${snapshotStorageWarning ? 'warning' : ''} ${snapshotStorageError ? 'error' : ''}`} role={snapshotStorageError ? 'alert' : snapshotStorageWarning ? 'status' : undefined}>
                  {currentSnapshotStorage ? <>
                    <strong>{snapshotStorageWarning ? '备份占用偏大' : '备份占用'}</strong>
                    <span>磁盘去重估算 {formatStorageBytes(currentSnapshotStorage.uniqueBytes)} · 按文件累计 {formatStorageBytes(currentSnapshotStorage.logicalBytes)}</span>
                    {snapshotStorageWarning ? <p>{currentSnapshotStorage.incomplete ? '文件过多，统计未完成。' : ''}历史运行数据不会自动删除；可在下方移除不再需要的快照。</p> : null}
                  </> : snapshotStorageError ? <><strong>无法统计备份占用</strong><span>{snapshotStorageError}</span><button className="secondary-button compact" type="button" onClick={() => { setSnapshotStorageError(''); void window.modmind.snapshots.storage(project.path).then(setSnapshotStorage).catch(error => setSnapshotStorageError(errorMessage(error))) }}>重试</button></> : <span>正在统计备份占用…</span>}
                </div>
                <div className="snapshot-list">
                  {snapshots.length ? snapshots.map((snapshot) => (
                    <article className="snapshot-row" key={snapshot.id}>
                      <span className="snapshot-icon"><Archive size={18} /></span>
                      <div><h3>{snapshot.label}</h3><p>{formatDate(snapshot.createdAt)} · {snapshot.fileCount} 个文件</p></div>
                      <code>{snapshot.id.slice(0, 19)}</code>
                      <div className="snapshot-actions">
                        <button
                          className="icon-button"
                          title="恢复此快照"
                          disabled={Boolean(restoringSnapshotId) || Boolean(deletingSnapshotId) || building || planning || migrationBusy}
                          onClick={() => void restoreSnapshot(snapshot)}
                        >
                          {restoringSnapshotId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
                        </button>
                        <button
                          className="icon-button danger"
                          title="删除此快照"
                          disabled={Boolean(restoringSnapshotId) || Boolean(deletingSnapshotId) || building || planning || migrationBusy}
                          onClick={() => void deleteSnapshot(snapshot)}
                        >
                          {deletingSnapshotId === snapshot.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                        </button>
                      </div>
                    </article>
                  )) : <div className="large-empty"><History size={26} /><h3>还没有版本快照</h3></div>}
                </div>
              </div>
  {confirmDialog}</>
}
registerFeature('versions', { apiVersion: 2, pages: [{ id: 'snapshots', label: '版本记录', group: '项目', icon: History, supports: anyProject, component: Versions }] })
