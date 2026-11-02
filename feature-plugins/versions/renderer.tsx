import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, History, LoaderCircle, PackageOpen, Plus, Search, X } from 'lucide-react'
import type { LoaderKind, LoaderVersionOption, ProjectMigrationPreview, SnapshotInfo, SnapshotStorageInfo } from '../../src/shared/types'
import { isJavaLoader, platformLabel } from '../../src/shared/projectPlatform'
import GitWorkspace from './components/GitWorkspace'
import { ServerPluginMigration } from '../../src/renderer/src/components/ServerPluginTools'
import { useConfirmDialog } from '../../src/renderer/src/components/InteractionDialogs'
import { reportClientFailure as errorMessage } from '../../src/renderer/src/lib/clientFailure'
import { anyProject, registerFeature, type FeaturePageContext } from '../sdk/renderer'
import SnapshotList from '../../src/renderer/src/components/SnapshotList'
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
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState('')
  const [creatingSnapshot, setCreatingSnapshot] = useState(false)
  const [snapshotStorage, setSnapshotStorage] = useState<SnapshotStorageInfo | null>(null)
  const [snapshotStorageError, setSnapshotStorageError] = useState('')
  const [restoringSnapshotId, setRestoringSnapshotId] = useState('')
  const [deletingSnapshotId, setDeletingSnapshotId] = useState('')
  const [loaderCatalog, setLoaderCatalog] = useState<LoaderVersionOption[]>([])
  const [migrationLoader, setMigrationLoader] = useState<LoaderKind>('fabric')
  const [migrationVersion, setMigrationVersion] = useState('')
  const [migrationPreview, setMigrationPreview] = useState<ProjectMigrationPreview | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const projectPathRef = useRef(project?.path ?? '')
  const visibleRef = useRef(context.visible)
  const mountedPathRef = useRef('')
  const snapshotRequestsRef = useRef(new Map<string, { promise: Promise<void>; revision: number }>())
  const snapshotMutationsRef = useRef(new Map<string, { kind: 'create' | 'restore' | 'delete'; id?: string }>())
  const snapshotListRevisionRef = useRef(0)
  projectPathRef.current = project?.path ?? ''
  visibleRef.current = context.visible
  const isActiveProject = (path: string): boolean => Boolean(path && visibleRef.current && projectPathRef.current === path && mountedPathRef.current === path)
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const currentSnapshotStorage = snapshotStorage?.projectPath === project?.path ? snapshotStorage : null
  const snapshotStorageWarning = Boolean(currentSnapshotStorage?.warning)
  const migrationVersions = loaderCatalog.filter(option => option.loader === migrationLoader)
  const selectedMigrationVersion = migrationVersion || migrationVersions[0]?.minecraftVersion || ''
  const refreshSnapshots = (): Promise<void> => {
    const path = project?.path ?? ''
    if (!isActiveProject(path)) return Promise.resolve()
    const running = snapshotRequestsRef.current.get(path)
    if (running) return running.revision === snapshotListRevisionRef.current ? running.promise : running.promise.catch(() => undefined).then(() => refreshSnapshots())
    setSnapshotsLoading(true)
    setSnapshotsError('')
    const revision = snapshotListRevisionRef.current
    const request = window.modmind.snapshots.list(path).then(value => {
      if (isActiveProject(path) && revision === snapshotListRevisionRef.current) setSnapshots(value)
    }).catch(error => {
      if (isActiveProject(path) && revision === snapshotListRevisionRef.current) setSnapshotsError(`版本列表加载失败：${errorMessage(error)}`)
      throw error
    }).finally(() => {
      if (snapshotRequestsRef.current.get(path)?.promise === request) snapshotRequestsRef.current.delete(path)
      if (isActiveProject(path)) setSnapshotsLoading(false)
    })
    snapshotRequestsRef.current.set(path, { promise: request, revision })
    return request
  }
  const refreshSnapshotStorage = async (): Promise<void> => {
    const path = project?.path ?? ''
    if (!isActiveProject(path)) return
    setSnapshotStorageError('')
    try {
      const value = await window.modmind.snapshots.storage(path)
      if (isActiveProject(path)) setSnapshotStorage(value)
    } catch (error) {
      if (isActiveProject(path)) setSnapshotStorageError(errorMessage(error))
    }
  }
  const refreshFiles = context.filesChanged
  useEffect(() => {
    if (!project || !context.visible) return
    let active = true
    const path = project.path
    mountedPathRef.current = path
    snapshotListRevisionRef.current += 1
    setSnapshots([])
    setSnapshotsError('')
    setSnapshotStorage(null)
    setSnapshotStorageError('')
    const mutation = snapshotMutationsRef.current.get(path)
    setCreatingSnapshot(mutation?.kind === 'create')
    setRestoringSnapshotId(mutation?.kind === 'restore' ? mutation.id ?? '' : '')
    setDeletingSnapshotId(mutation?.kind === 'delete' ? mutation.id ?? '' : '')
    setMigrationLoader(project.loader)
    setMigrationVersion('')
    setMigrationPreview(null)
    void refreshSnapshots().catch(() => undefined)
    void window.modmind.project.listLoaderVersions().then(value => { if (active) setLoaderCatalog(value) }).catch(() => undefined)
    const accept = (value: SnapshotStorageInfo): void => { if (active && isActiveProject(path) && value.projectPath === path) { setSnapshotStorage(value); setSnapshotStorageError(''); void refreshSnapshots().catch(() => undefined) } }
    const unsubscribe = window.modmind.snapshots.onStorageChanged(accept)
    void refreshSnapshotStorage()
    return () => { active = false; if (mountedPathRef.current === path) mountedPathRef.current = ''; unsubscribe() }
  }, [project?.path, context.visible])
  const createSnapshot = async (): Promise<void> => {
    const path = project?.path ?? ''
    if (!isActiveProject(path) || context.projectBusy || migrationBusy || snapshotMutationsRef.current.has(path)) return
    snapshotMutationsRef.current.set(path, { kind: 'create' })
    setCreatingSnapshot(true)
    try {
      const result = await window.modmind.snapshots.create('手动快照', path)
      if (!isActiveProject(path)) return
      snapshotListRevisionRef.current += 1
      setSnapshots(current => [result, ...current.filter(snapshot => snapshot.id !== result.id)])
      setNotice(`已保存 ${result.fileCount} 个文件`)
    } catch (error) { if (isActiveProject(path)) setNotice(`快照失败：${errorMessage(error)}`) }
    finally { snapshotMutationsRef.current.delete(path); if (isActiveProject(path)) setCreatingSnapshot(false) }
  }
  const restoreSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    const path = project?.path ?? ''
    if (!isActiveProject(path) || snapshotMutationsRef.current.has(path) || context.projectBusy || migrationBusy) return
    if (!await requestConfirm({ title: `恢复快照“${snapshot.label}”？`, message: '当前项目状态会先自动备份，恢复失败时会自动回滚。代码编辑器中的修改会先保存，并包含在安全备份中。', confirmLabel: '恢复快照', actionIcon: 'restore' })) return
    if (!isActiveProject(path) || snapshotMutationsRef.current.has(path)) return
    snapshotMutationsRef.current.set(path, { kind: 'restore', id: snapshot.id })
    setRestoringSnapshotId(snapshot.id)
    try {
      await context.saveBeforeRestore()
      if (!isActiveProject(path)) return
      const result = await window.modmind.snapshots.restore(snapshot.id, path)
      if (!isActiveProject(path)) return
      snapshotListRevisionRef.current += 1
      context.projectRestored(result.project)
      await snapshotRequestsRef.current.get(path)?.promise.catch(() => undefined)
      await refreshSnapshots()
      if (isActiveProject(path)) setNotice(`已恢复“${result.snapshot.label}”，恢复前状态已备份为 ${result.backup.id.slice(0, 19)}`)
    } catch (error) { if (isActiveProject(path)) setNotice(`恢复失败：${errorMessage(error)}`) }
    finally { snapshotMutationsRef.current.delete(path); if (isActiveProject(path)) setRestoringSnapshotId('') }
  }
  const deleteSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    const path = project?.path ?? ''
    if (!isActiveProject(path) || snapshotMutationsRef.current.has(path) || context.projectBusy || migrationBusy) return
    if (!await requestConfirm({ title: `永久删除快照“${snapshot.label}”？`, message: '删除后无法从 ModMind 恢复', confirmLabel: '永久删除', tone: 'danger' })) return
    if (!isActiveProject(path) || snapshotMutationsRef.current.has(path)) return
    snapshotMutationsRef.current.set(path, { kind: 'delete', id: snapshot.id })
    setDeletingSnapshotId(snapshot.id)
    try {
      const next = await window.modmind.snapshots.delete(snapshot.id, path)
      if (isActiveProject(path)) { snapshotListRevisionRef.current += 1; setSnapshots(next); setNotice(`已删除快照“${snapshot.label}”`) }
    } catch (error) { if (isActiveProject(path)) setNotice(`删除快照失败：${errorMessage(error)}`) }
    finally { snapshotMutationsRef.current.delete(path); if (isActiveProject(path)) setDeletingSnapshotId('') }
  }
  const deleteSnapshots = async (selected: SnapshotInfo[]): Promise<import('../../src/shared/types').SnapshotBatchDeleteResult | undefined> => {
    const path = project?.path ?? ''
    if (!selected.length || !isActiveProject(path) || snapshotMutationsRef.current.has(path) || context.projectBusy || migrationBusy) return
    if (!await requestConfirm({ title: '永久删除所选 ' + selected.length + ' 个快照？', message: '仅删除所选快照，不修改当前项目文件。删除后无法从 ModMind 恢复。', confirmLabel: '永久删除 ' + selected.length + ' 个快照', tone: 'danger' })) return
    if (!isActiveProject(path) || snapshotMutationsRef.current.has(path)) return
    snapshotMutationsRef.current.set(path, { kind: 'delete', id: '__batch__' })
    setDeletingSnapshotId('__batch__')
    try {
      const result = await window.modmind.snapshots.deleteMany(selected.map(snapshot => snapshot.id), path)
      if (isActiveProject(path)) { snapshotListRevisionRef.current += 1; setSnapshots(result.snapshots); setNotice('已删除 ' + result.deletedIds.length + ' 个快照' + (result.failed.length ? '，' + result.failed.length + ' 个未删除' : '')) }
      return result
    } finally { snapshotMutationsRef.current.delete(path); if (isActiveProject(path)) setDeletingSnapshotId('') }
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
                  <button className="primary-button" disabled={creatingSnapshot || Boolean(restoringSnapshotId) || Boolean(deletingSnapshotId) || context.projectBusy || migrationBusy} onClick={() => void createSnapshot()}>{creatingSnapshot ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建快照</button>
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
                  </> : snapshotStorageError ? <><strong>无法统计备份占用</strong><span>{snapshotStorageError}</span><button className="secondary-button compact" type="button" onClick={() => void refreshSnapshotStorage()}>重试</button></> : <span>正在统计备份占用…</span>}
                </div>
                <SnapshotList key={project.path} snapshots={snapshots} loading={snapshotsLoading} error={snapshotsError} onRetry={() => void refreshSnapshots().catch(() => undefined)} restoringId={restoringSnapshotId} deletingId={deletingSnapshotId} disabled={creatingSnapshot || Boolean(restoringSnapshotId) || Boolean(deletingSnapshotId) || context.projectBusy || migrationBusy} onRestore={snapshot => void restoreSnapshot(snapshot)} onDelete={snapshot => void deleteSnapshot(snapshot)} onDeleteMany={deleteSnapshots} formatDate={formatDate} />
              </div>
  {confirmDialog}</>
}
registerFeature('versions', { apiVersion: 2, pages: [{ id: 'snapshots', label: '版本记录', group: '项目', icon: History, supports: anyProject, component: Versions }] })
