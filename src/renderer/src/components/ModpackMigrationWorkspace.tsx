import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Binary,
  CheckCircle2,
  FileCode2,
  FolderOutput,
  HelpCircle,
  History,
  LoaderCircle,
  PackageSearch,
  RotateCcw,
  Trash2,
  Upload,
  Wrench,
  XCircle
} from 'lucide-react'
import type {
  JavaLoaderKind,
  LoaderVersionOption,
  ModpackContentKind,
  ModpackMigrationAssessment,
  ModpackMigrationCandidate,
  ModpackMigrationContentDecision,
  ModpackMigrationCreateResult,
  ModpackMigrationModAssessment,
  ModpackMigrationModDecision,
  ModpackMigrationModuleDecision,
  ModpackMigrationProgress,
  ModpackMigrationRecord,
  ModpackMigrationStatus,
  ProjectInfo
} from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'

const loaders: Array<{ value: JavaLoaderKind; label: string }> = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' }
]

const statusMeta: Record<ModpackMigrationStatus, { label: string; icon: typeof CheckCircle2 }> = {
  compatible: { label: '官方兼容', icon: CheckCircle2 },
  replacement: { label: '有候选平替', icon: AlertTriangle },
  'source-port': { label: '迁移源码', icon: Wrench },
  missing: { label: '没有目标版本', icon: XCircle },
  unknown: { label: '无法识别', icon: HelpCircle }
}

const contentLabels: Record<ModpackContentKind, string> = {
  config: '配置与默认项',
  scripts: '脚本与 KubeJS',
  datapacks: '数据包',
  quests: '任务与指南',
  resourcepacks: '资源包',
  shaderpacks: '光影包',
  ui: '界面资源',
  worlds: '存档与世界',
  client: '玩家预设',
  server: '服务端配置',
  other: '其他文件'
}

const identityLabels: Record<ModpackMigrationModAssessment['identityEvidence'], string> = {
  lock: '锁文件身份',
  hash: '平台哈希身份',
  metadata: '名称与版本反查',
  mcmod: 'MC百科辅助识别',
  unknown: '身份未确认'
}

function errorMessage(error: unknown): string {
  return reportClientFailure(error)
}

function candidateKey(candidate: ModpackMigrationCandidate): string {
  return `${candidate.provider}:${candidate.projectId}:${candidate.versionId}`
}

function decisionText(decision: ModpackMigrationModDecision | undefined): string {
  if (!decision) return '尚未取舍'
  if (decision.action === 'defer') return '暂缓，保留迁移证据'
  if (decision.action === 'remove') return '从目标包移除'
  if (decision.action === 'manual-file') return `手工导入 ${decision.filePath.split(/[\\/]/).at(-1)}`
  if (decision.action === 'create-compat-module') return '创建自制兼容模块'
  if (decision.action === 'use-replacement') return `采用平替 ${decision.candidate.name}`
  return `采用官方版本 ${decision.candidate.versionName}`
}

export default function ModpackMigrationWorkspace({ project, onDecompile }: { project: ProjectInfo; onDecompile?: (jarPath: string) => void }): React.JSX.Element {
  const { confirm, dialog } = useConfirmDialog()
  const [catalog, setCatalog] = useState<LoaderVersionOption[]>([])
  const [loader, setLoader] = useState<JavaLoaderKind>(project.loader as JavaLoaderKind)
  const [targetVersion, setTargetVersion] = useState('')
  const [assessment, setAssessment] = useState<ModpackMigrationAssessment | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ModpackMigrationModDecision>>({})
  const [replacementChoices, setReplacementChoices] = useState<Record<string, string>>({})
  const [moduleDecisions, setModuleDecisions] = useState<Record<string, ModpackMigrationModuleDecision['action']>>({})
  const [contentDecisions, setContentDecisions] = useState<Record<string, ModpackMigrationContentDecision['action']>>({})
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeTone, setNoticeTone] = useState<'success' | 'error'>('success')
  const [result, setResult] = useState<ModpackMigrationCreateResult | null>(null)
  const [progress, setProgress] = useState<ModpackMigrationProgress | null>(null)
  const [history, setHistory] = useState<ModpackMigrationRecord[]>([])

  useEffect(() => {
    let active = true
    void window.modmind.project.listLoaderVersions().then((options) => {
      if (active) setCatalog(options.filter((option) => ['fabric', 'quilt', 'forge', 'neoforge'].includes(option.loader)))
    }).catch((error) => {
      if (!active) return
      setNoticeTone('error')
      setNotice(errorMessage(error))
    })
    return () => { active = false }
  }, [])

  useEffect(() => window.modmind.modpack.onMigrationProgress(setProgress), [])

  useEffect(() => {
    let active = true
    void window.modmind.modpack.migrationHistory().then((records) => { if (active) setHistory(records) }).catch(() => undefined)
    return () => { active = false }
  }, [project.path])

  const versions = useMemo(() => catalog.filter((option) => option.loader === loader), [catalog, loader])
  const unresolved = assessment?.mods.filter((mod) => !decisions[mod.id]).length ?? 0
  const deferred = assessment?.mods.filter((mod) => decisions[mod.id]?.action === 'defer').length ?? 0

  const scan = async (version: string): Promise<void> => {
    if (busy || (loader === project.loader && version === project.minecraftVersion)) return
    setBusy('scan')
    setTargetVersion(version)
    setProgress({ phase: 'inventory', completed: 0, total: 1, message: '正在准备目标版本扫描' })
    setNotice('')
    setResult(null)
    try {
      const next = await window.modmind.modpack.previewMigration({ loader, minecraftVersion: version })
      setProgress({ phase: 'complete', completed: next.mods.length, total: next.mods.length, message: '目标版本扫描完成' })
      setAssessment(next)
      setDecisions(Object.fromEntries(next.mods.map((mod) => [mod.id, mod.compatible
        ? { modId: mod.id, action: 'use-compatible', candidate: mod.compatible } satisfies ModpackMigrationModDecision
        : { modId: mod.id, action: 'defer' } satisfies ModpackMigrationModDecision])))
      setReplacementChoices(Object.fromEntries(next.mods.flatMap((mod) => mod.alternatives[0] ? [[mod.id, candidateKey(mod.alternatives[0])]] : [])))
      setModuleDecisions(Object.fromEntries(next.modules.map((module) => [module.id, 'port-source'])))
      setContentDecisions(Object.fromEntries(next.content.map((content) => [content.kind, content.copyByDefault ? 'copy' : 'exclude'])))
      setNoticeTone('success')
      setNotice(`扫描完成：${next.mods.length} 个 Mod，${next.modules.length} 个源码模块，${next.content.reduce((total, item) => total + item.count, 0)} 项魔改内容`)
    } catch (error) {
      setAssessment(null)
      setProgress(null)
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const chooseReplacement = (modId: string): void => {
    const mod = assessment?.mods.find((entry) => entry.id === modId)
    const selected = mod?.alternatives.find((candidate) => candidateKey(candidate) === replacementChoices[modId])
    if (!selected) return
    setDecisions((current) => ({ ...current, [modId]: { modId, action: 'use-replacement', candidate: selected } }))
  }

  const selectManualJar = async (modId: string): Promise<void> => {
    if (!assessment || busy) return
    setBusy(`jar:${modId}`)
    setNotice('')
    try {
      const selected = await window.modmind.modpack.selectMigrationJar({ loader: assessment.target.loader as JavaLoaderKind, minecraftVersion: assessment.target.minecraftVersion })
      if (!selected) return
      setDecisions((current) => ({ ...current, [modId]: { modId, action: 'manual-file', filePath: selected.filePath } }))
      setNoticeTone('success')
      setNotice(`已为 ${assessment.mods.find((mod) => mod.id === modId)?.sourceName ?? '缺失项'} 选择 ${selected.fileName}`)
    } catch (error) {
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const createMigration = async (mode: 'backup' | 'direct'): Promise<void> => {
    if (!assessment || busy) return
    if (mode === 'direct' && !await confirm({
      title: '不创建备份直接迁移？',
      message: '迁移完成后无法一键撤销。执行失败时仍会自动回滚到迁移前状态。',
      detail: project.path,
      confirmLabel: '直接迁移',
      cancelLabel: '返回并备份',
      tone: 'danger',
      actionIcon: 'continue'
    })) return
    setBusy(`create:${mode}`)
    setNotice('')
    try {
      const created = await window.modmind.modpack.createMigration({
        loader: assessment.target.loader as JavaLoaderKind,
        minecraftVersion: assessment.target.minecraftVersion,
        mode,
        mods: assessment.mods.map((mod) => decisions[mod.id]),
        modules: assessment.modules.map((module) => ({ moduleId: module.id, action: moduleDecisions[module.id] ?? 'remove' })),
        content: assessment.content.map((content) => ({ kind: content.kind, action: contentDecisions[content.kind] ?? 'exclude' }))
      })
      if (!created) return
      setResult(created)
      setHistory(await window.modmind.modpack.migrationHistory().catch(() => []))
      setNoticeTone('success')
      setNotice(`目标整合包已生成：${created.project.path}`)
    } catch (error) {
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const undoMigration = async (migrationId: string): Promise<void> => {
    if (busy) return
    if (!await confirm({
      title: '撤销这次迁移？',
      message: 'ModMind 会先保存当前现场，再恢复迁移前版本。迁移后做过的修改不会丢失。',
      detail: '恢复完成后，可在快照中找回撤销前的现场。',
      confirmLabel: '保存现场并撤销',
      cancelLabel: '保留当前版本',
      actionIcon: 'restore'
    })) return
    setBusy('undo')
    setNotice('')
    try {
      const undone = await window.modmind.modpack.undoMigration(migrationId)
      setNoticeTone('success')
      setNotice(`迁移已撤销；迁移后的现场保存在快照 ${undone.preUndoSnapshot.id}`)
      setResult(null)
      setAssessment(null)
      setProgress(null)
      setHistory(await window.modmind.modpack.migrationHistory().catch(() => []))
    } catch (error) {
      setNoticeTone('error')
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  return <div className="migration-workspace">
    <header className="content-toolbar migration-workspace-toolbar">
      <h1 className="visually-hidden">版本迁移</h1><div className="toolbar-context">{project.loader} {project.minecraftVersion}<ArrowRight size={14} />{assessment ? `${assessment.target.loader} ${assessment.target.minecraftVersion}` : '选择目标版本'}</div>
      <div className="migration-execute-actions">
        <button className="primary-button" type="button" disabled={!assessment || Boolean(busy)} onClick={() => void createMigration('backup')}>{busy === 'create:backup' ? <LoaderCircle className="spin" size={16} /> : <FolderOutput size={16} />}备份并迁移</button>
        <button className="secondary-button" type="button" disabled={!assessment || Boolean(busy)} onClick={() => void createMigration('direct')}>{busy === 'create:direct' ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}直接迁移</button>
      </div>
    </header>

    <section className="migration-target-panel">
      <div className="migration-loader-tabs" role="tablist" aria-label="目标 Loader">{loaders.map((item) => <button key={item.value} type="button" className={loader === item.value ? 'active' : ''} onClick={() => { setLoader(item.value); setTargetVersion(''); setAssessment(null); setProgress(null); setResult(null) }}>{item.label}</button>)}</div>
      <div className="migration-version-strip" aria-label="目标 Minecraft 版本">{versions.map((option) => {
        const current = option.loader === project.loader && option.minecraftVersion === project.minecraftVersion
        const active = option.minecraftVersion === targetVersion && option.loader === loader
        return <button key={`${option.loader}:${option.minecraftVersion}`} type="button" className={active ? 'active' : ''} disabled={current || busy === 'scan'} title={current ? '当前版本' : `扫描 ${option.loader} ${option.minecraftVersion}`} onClick={() => void scan(option.minecraftVersion)}>{option.minecraftVersion}{current ? <small>当前</small> : option.supportTier === 'experimental' ? <small>实验</small> : null}</button>
      })}</div>
    </section>

    {progress ? <section className={`migration-scan-progress ${progress.phase}`} aria-live="polite"><div><span>{progress.message}</span><strong>{progress.phase === 'complete' ? '100%' : progress.total > 0 ? `${Math.round(progress.completed / progress.total * 100)}%` : '0%'}</strong></div><progress max={Math.max(1, progress.total)} value={progress.phase === 'complete' ? Math.max(1, progress.total) : progress.completed} /></section> : null}

    {assessment ? <>
      <section className="migration-summary" aria-label="迁移兼容性统计">
        {(['compatible', 'replacement', 'missing', 'unknown', 'source-port'] as const).map((status) => {
          const Icon = statusMeta[status].icon
          return <div className={`migration-summary-item ${status}`} key={status}><Icon size={17} /><span>{statusMeta[status].label}</span><strong>{assessment.summary[status]}</strong></div>
        })}
      </section>

      {assessment.warnings.length ? <div className="migration-warning-list">{assessment.warnings.map((warning) => <span key={warning}><AlertTriangle size={14} />{warning}</span>)}</div> : null}

      <section className="migration-table-section">
        <div className="migration-section-heading"><div><PackageSearch size={18} /><div><h2>Mod 兼容性</h2><p>{unresolved ? `${unresolved} 项尚未取舍` : deferred ? `${deferred} 项将暂缓，迁移结果会标记为不完整` : '所有 Mod 均已取舍'}</p></div></div></div>
        <div className="migration-table">
          <div className="migration-table-head"><span>源 Mod</span><span>目标判断</span><span>当前取舍</span><span>操作</span></div>
          {assessment.mods.map((mod) => {
            const meta = statusMeta[mod.status]
            const StatusIcon = meta.icon
            const decision = decisions[mod.id]
            const rowBusy = busy === `jar:${mod.id}`
            return <div className={`migration-row ${mod.status}`} key={mod.id}>
              <div className="migration-source"><strong>{mod.sourceName}</strong><small>{mod.sourceFileName}</small><small>{mod.sourceVersion}{mod.sourceProvider ? ` · ${mod.sourceProvider}` : ''}</small><small>{identityLabels[mod.identityEvidence]}</small></div>
              <div className="migration-target-status"><span className={`migration-status ${mod.status}`}><StatusIcon size={14} />{meta.label}</span><small>{mod.reason}</small>{mod.compatible ? <b>{mod.compatible.versionName} · {mod.compatible.fileName}</b> : null}{mod.mcmodMatches?.length ? <span className="migration-mcmod-matches">MC百科：{mod.mcmodMatches.slice(0, 2).map((match, index) => <span key={match.projectId}>{index ? ' · ' : ''}<a href={match.pageUrl} target="_blank" rel="noreferrer">{match.name}</a></span>)}</span> : null}{mod.sourceUrl ? <b>源码可用{mod.sourceLicense ? ` · ${mod.sourceLicense}` : ' · 许可证待确认'}</b> : null}</div>
              <div className={`migration-decision ${decision ? 'resolved' : 'unresolved'}`}>{decisionText(decision)}</div>
              <div className="migration-row-actions">
                {onDecompile && mod.sourceFileName ? <button className="icon-button" type="button" title="反编译查看源码" disabled={Boolean(busy)} onClick={() => onDecompile(`${project.path}/mods/${mod.sourceFileName}`.replaceAll('\\', '/'))}><Binary size={15} /></button> : null}
                {mod.alternatives.length ? <div className="migration-replacement-picker"><select value={replacementChoices[mod.id] ?? ''} disabled={Boolean(busy)} onChange={(event) => setReplacementChoices((current) => ({ ...current, [mod.id]: event.target.value }))}>{mod.alternatives.map((candidate) => <option value={candidateKey(candidate)} key={candidateKey(candidate)}>{candidate.name} · {candidate.versionName}</option>)}</select><button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => chooseReplacement(mod.id)}><CheckCircle2 size={14} />采用</button></div> : null}
                <button className="icon-button" type="button" title="手工导入目标 JAR" disabled={Boolean(busy)} onClick={() => void selectManualJar(mod.id)}>{rowBusy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}</button>
                <button className="icon-button" type="button" title={mod.sourceUrl ? '创建源码移植模块' : '创建自制兼容模块'} disabled={Boolean(busy)} onClick={() => setDecisions((current) => ({ ...current, [mod.id]: { modId: mod.id, action: 'create-compat-module' } }))}><Wrench size={15} /></button>
                <button className="icon-button" type="button" title="暂缓处理并记录到不完整迁移报告" disabled={Boolean(busy)} onClick={() => setDecisions((current) => ({ ...current, [mod.id]: { modId: mod.id, action: 'defer' } }))}><HelpCircle size={15} /></button>
                <button className="icon-button danger" type="button" title="从目标包移除" disabled={Boolean(busy)} onClick={() => setDecisions((current) => ({ ...current, [mod.id]: { modId: mod.id, action: 'remove' } }))}><Trash2 size={15} /></button>
                <button className="icon-button" type="button" title="重置取舍" disabled={Boolean(busy)} onClick={() => setDecisions((current) => ({ ...current, [mod.id]: mod.compatible ? { modId: mod.id, action: 'use-compatible', candidate: mod.compatible } : { modId: mod.id, action: 'defer' } }))}><RotateCcw size={15} /></button>
              </div>
            </div>
          })}
        </div>
      </section>

      {assessment.modules.length ? <section className="migration-table-section">
        <div className="migration-section-heading"><div><FileCode2 size={18} /><div><h2>自制模块</h2></div></div></div>
        <div className="migration-module-list">{assessment.modules.map((module) => <div key={module.id}><Wrench size={16} /><span><strong>{module.name}</strong><small>{module.reason}</small></span><div className="migration-choice-tabs"><button type="button" className={moduleDecisions[module.id] === 'port-source' ? 'active' : ''} onClick={() => setModuleDecisions((current) => ({ ...current, [module.id]: 'port-source' }))}>迁移源码</button><button type="button" className={moduleDecisions[module.id] === 'remove' ? 'active danger' : ''} onClick={() => setModuleDecisions((current) => ({ ...current, [module.id]: 'remove' }))}>移除</button></div></div>)}</div>
      </section> : null}

      {assessment.content.length ? <section className="migration-table-section">
        <div className="migration-section-heading"><div><FileCode2 size={18} /><div><h2>魔改内容</h2></div></div></div>
        <div className="migration-content-grid">{assessment.content.map((content) => <div className={content.status} key={content.kind}><span className="migration-content-status">{content.status === 'compatible' ? <CheckCircle2 size={15} /> : content.status === 'blocked' ? <XCircle size={15} /> : <AlertTriangle size={15} />}</span><span><strong>{contentLabels[content.kind]}</strong><small>{content.count} 项 · {content.reason}</small><small>{content.paths.slice(0, 3).join(' · ')}</small></span><label className="switch-control" title={contentDecisions[content.kind] === 'copy' ? '复制到目标包' : '从目标包排除'}><input type="checkbox" checked={contentDecisions[content.kind] === 'copy'} onChange={(event) => setContentDecisions((current) => ({ ...current, [content.kind]: event.target.checked ? 'copy' : 'exclude' }))} /><span aria-hidden="true" /></label></div>)}</div>
      </section> : null}
    </> : <div className="migration-empty"><PackageSearch size={28} /><strong>选择一个目标版本开始扫描</strong></div>}

    {notice ? <div className={`migration-notice ${noticeTone}`} role="status">{notice}</div> : null}
    {result ? <section className={`migration-result ${result.status}`}><CheckCircle2 size={18} /><div><strong>{result.status === 'complete' ? '原项目已完成迁移' : '原项目已生成不完整迁移'}</strong><span>{result.project.path}</span><small>平台文件 {result.installed.length} · 手工文件 {result.manualFiles.length} · 暂缓 {result.deferred.length} · 移除 {result.removed.length} · 源码模块 {result.portedModules.length}</small>{result.canUndo ? <button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => void undoMigration(result.migrationId)}>{busy === 'undo' ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}撤销迁移</button> : null}</div></section> : null}

    {history.length ? <section className="migration-history-section">
      <div className="migration-section-heading"><div><History size={18} /><div><h2>迁移历史</h2></div></div></div>
      <div className="migration-history-list">{history.map((record) => <div key={record.id} className={record.status}>
        <span><strong>{record.source.loader} {record.source.minecraftVersion}<ArrowRight size={13} />{record.target.loader} {record.target.minecraftVersion}</strong><small>{new Date(record.completedAt).toLocaleString()} · {record.mode === 'backup' ? '备份迁移' : '直接迁移'} · {record.deferred.length} 项暂缓</small></span>
        <span className="migration-history-status">{record.status === 'undone' ? '已撤销' : record.status === 'complete' ? '完整' : '不完整'}</span>
        {record.sourceSnapshotId && record.status !== 'undone' ? <button className="icon-button" type="button" title="撤销这次迁移" disabled={Boolean(busy)} onClick={() => void undoMigration(record.id)}>{busy === 'undo' ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button> : null}
      </div>)}</div>
    </section> : null}
    {dialog}
  </div>
}
