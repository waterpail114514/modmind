import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, CircleAlert, Download, FolderOpen, LoaderCircle, LogIn, PackageOpen, RefreshCw, X } from 'lucide-react'
import type { DeviceConnectionState, ExistingProjectAnalysis, ExistingProjectInspectionProgress, ProjectInfo } from '../../../shared/types'
import { studioCreationRecords, studioFieldVisible, studioFormInput, studioFormValues } from '../../../shared/studios'
import { refreshFeaturePlugins, useFeaturePlugins } from '../featurePlugins'
import { featureInstallPlan } from '../featureInstallPlan'
import { onboardingGoalForProject, onboardingGoals, onboardingRequiredFeatures, pendingOnboardingFeatures, type OnboardingSession } from '../onboarding'
import { useFeatureStore } from '../useFeatureStore'
import { StudioFields } from './StudioProjectForm'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const bytes = (value: number): string => value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`

export function MokoAccountPanel({ account, onAccountChange, onSkip }: { account: DeviceConnectionState; onAccountChange: (state: DeviceConnectionState) => void; onSkip: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState<'login' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0), pending = useRef<'login' | 'cancel' | null>(null)
  const run = async (operation: () => Promise<DeviceConnectionState>, kind: 'login' | 'cancel'): Promise<void> => {
    if (pending.current && (kind !== 'cancel' || pending.current === 'cancel')) return
    const ticket = ++request.current
    pending.current = kind; setBusy(kind); setError('')
    try { const state = await operation(); if (ticket === request.current) onAccountChange(state) }
    catch (reason) { if (ticket === request.current) setError(message(reason)) }
    finally { if (ticket === request.current) { pending.current = null; setBusy(null) } }
  }
  const authorizing = account.status === 'authorizing'
  return <section className="moko-choice-panel moko-account-panel" aria-label="连接账号">
    <h2>{authorizing ? '等你回来' : '连接你的账号'}</h2>
    {authorizing ? <p className="moko-panel-status"><LoaderCircle size={18} className="spin" />请在浏览器完成授权，登录结果会自动显示在这里。</p> : <p className="moko-panel-status">连接后就可以让 AI 帮你一起创作，也可以稍后再连。</p>}
    {!account.configured ? <p className="moko-panel-error" role="alert">账号服务暂未配置，可以先继续教程。</p> : null}
    {error || account.status === 'error' ? <p className="moko-panel-error" role="alert"><CircleAlert size={16} />{error || account.message || '连接失败，请重试。'}</p> : null}
    <div className="moko-panel-actions">
      {authorizing ? <button className="secondary-button" disabled={busy === 'cancel'} onClick={() => void run(() => window.modmind.device.cancelAuthorization(), 'cancel')}><X size={16} />取消授权</button> : <button className="primary-button" disabled={Boolean(busy) || !account.configured} onClick={() => void run(() => window.modmind.device.authorize(), 'login')}>{busy ? <LoaderCircle size={17} className="spin" /> : <LogIn size={17} />}{account.status === 'error' ? '重新登录' : '登录账号'}</button>}
      <button className="moko-text-button" disabled={Boolean(busy)} onClick={onSkip}>稍后登录</button>
    </div>
  </section>
}

export function MokoToolsPanel({ session, onContinue, onBusyChange, continueLabel }: { session: OnboardingSession; onContinue: () => void; onBusyChange: (busy: boolean) => void; continueLabel?: string }): React.JSX.Element {
  const store = useFeatureStore(), plugins = useFeaturePlugins()
  const required = onboardingRequiredFeatures(session.goal, session.task)
  const pending = pendingOnboardingFeatures(required, store.entries, plugins.catalog, plugins.modules)
  const plan = featureInstallPlan(store.entries, required)
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(false)
  const [error, setError] = useState(''), [cancelled, setCancelled] = useState(false)
  const [progress, setProgress] = useState({ total: 0, completed: 0 })
  const stopped = useRef(false), mounted = useRef(true), inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true } }, [])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const refresh = async (): Promise<void> => {
    setChecking(true); setError('')
    try { await Promise.all([window.modmind.featurePlugins.refreshStore(), refreshFeaturePlugins()]) }
    catch (reason) { if (mounted.current) setError(message(reason)) }
    finally { if (mounted.current) setChecking(false) }
  }
  const prepare = async (): Promise<void> => {
    if (inFlight.current || plan.error) return
    inFlight.current = true; stopped.current = false
    setBusy(true); setError(''); setCancelled(false)
    setProgress({ total: required.length, completed: 0 })
    try {
      for (const [index, id] of required.entries()) {
        if (stopped.current) break
        const entry = (await window.modmind.featurePlugins.store()).entries.find(value => value.id === id)
        if (stopped.current) break
        if (!entry) throw new Error(`暂时找不到所需工具：${id}`)
        if (entry.installed && !entry.enabled && !entry.error && !entry.updateAvailable) await window.modmind.featurePlugins.setEnabled(id, true)
        else if (!entry.available || entry.updateAvailable) {
          if (entry.builtin) throw new Error(`${entry.name}没有正常加载，请修复软件安装后重试。`)
          await window.modmind.featurePlugins.installOfficial(id)
          // An updated component may intentionally retain its disabled state.
          const updated = (await window.modmind.featurePlugins.store()).entries.find(value => value.id === id)
          if (updated?.installed && !updated.enabled && !updated.error) await window.modmind.featurePlugins.setEnabled(id, true)
        }
        if (mounted.current) setProgress({ total: required.length, completed: index + 1 })
      }
      await refreshFeaturePlugins()
    } catch (reason) { if (mounted.current && !stopped.current) setError(message(reason)) }
    finally { inFlight.current = false; if (mounted.current) { setBusy(false); setCancelled(stopped.current) } }
  }
  const stop = (): void => { stopped.current = true; void window.modmind.featurePlugins.cancelDownload().catch(reason => setError(message(reason))) }
  const job = store.job
  const jobActive = Boolean(job && ['downloading', 'installing'].includes(job.phase))
  const ready = plugins.ready && required.length > 0 && pending.length === 0
  const rendererError = pending.map(id => plugins.records.find(record => record.id === id)?.error).find(Boolean)
  const issue = error || rendererError || (!ready && (plan.error || plugins.error)) || (!store.entries.length && store.error)
  return <section className="moko-workflow-panel" aria-labelledby="moko-tools-title">
    <h2 id="moko-tools-title">准备创作工具</h2>
    <div className="moko-panel-content">
      <ul className="moko-tool-list">{required.map(id => {
        const entry = store.entries.find(value => value.id === id)
        const available = !pending.includes(id)
        const active = jobActive && job?.id === id
        return <li key={id}>{available ? <Check size={17} /> : active ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}<span>{entry?.name ?? id}</span><span>{available ? entry?.builtin ? '内置' : '已就绪' : active ? job?.phase === 'installing' ? '正在安装' : '正在下载' : entry?.updateAvailable ? '更新' : entry?.installed ? '待启用' : '待下载'}</span></li>
      })}</ul>
      <div className="moko-install-status" role="status">
        {busy || jobActive ? <><span>{jobActive ? `${job?.name} · ${job?.phase === 'installing' ? '正在安装' : `${bytes(job?.downloaded ?? 0)}${job?.total ? ` / ${bytes(job.total)}` : ''}`}` : `正在检查工具 ${progress.completed} / ${progress.total}`}</span><progress aria-label="工具准备进度" max={job?.total || progress.total || 1} value={jobActive && job?.total ? job.downloaded : progress.completed} /></> : <span>{ready ? '工具都准备好了，可以继续。' : cancelled ? '下载已取消，已安装的工具会保留。' : store.checking || !plugins.ready ? '正在读取工具状态…' : plan.bytes ? `需要下载 ${bytes(plan.bytes)}，包含所需依赖。` : '已有工具会直接复用。'}</span>}
      </div>
      {issue ? <p className="moko-panel-error" role="alert"><CircleAlert size={16} />{issue}</p> : null}
      {!busy && required.some(id => store.entries.find(entry => entry.id === id)?.updateAvailable) ? <p className="moko-panel-status">这次会更新已有工具。请先保存正在编辑的内容。</p> : null}
    </div>
    <div className="moko-panel-actions">
      {busy || jobActive ? <button className="secondary-button" disabled={!busy || job?.phase === 'installing'} onClick={stop}>取消下载</button> : ready ? <button className="primary-button" onClick={onContinue}>{continueLabel ?? (session.projectMode === 'existing' ? '确认项目配置' : '配置项目')}<ArrowRight size={17} /></button> : <button className="primary-button" disabled={checking || !plugins.ready || !store.entries.length || Boolean(plan.error)} onClick={() => void prepare()}><Download size={17} />{error || cancelled ? '继续准备工具' : '下载并准备工具'}</button>}
      <button className="moko-text-button" disabled={busy || jobActive || checking} onClick={() => void refresh()}><RefreshCw size={15} />{checking ? '正在检查…' : '重新检查'}</button>
    </div>
  </section>
}

export function MokoExistingPanel({ selectedProject, onInspected, onSelectedProject, onOpened, onBusyChange }: { selectedProject?: ProjectInfo; onInspected: (analysis: ExistingProjectAnalysis) => void; onSelectedProject: (project: ProjectInfo) => void; onOpened: (project: ProjectInfo) => void; onBusyChange: (busy: boolean) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [progress, setProgress] = useState<ExistingProjectInspectionProgress | null>(null)
  const inFlight = useRef(false), mounted = useRef(true), stopProgress = useRef<() => void>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopProgress.current?.() } }, [])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const inspect = async (sourceType: 'folder' | 'zip'): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setProgress(null)
    try {
      stopProgress.current = window.modmind.project.onInspectionProgress(value => { if (mounted.current) setProgress(value) })
      const inspection = await window.modmind.project.inspectExisting(sourceType)
      if (!inspection || !mounted.current) return
      if ('existingProject' in inspection) {
        if (inspection.archive) throw new Error('压缩包里已经是 ModMind 项目，请先解压，再选择项目文件夹。')
        if (!onboardingGoalForProject(inspection.existingProject)) throw new Error('教程暂不支持这个项目类型，可以直接进入工作台后打开。')
        onSelectedProject(inspection.existingProject)
      } else {
        if (!onboardingGoalForProject(inspection.inferred)) throw new Error('教程暂不支持这个项目类型，可以换一个项目，或直接进入工作台。')
        onInspected(inspection)
      }
    } catch (reason) { if (mounted.current) setError(message(reason)) }
    finally { stopProgress.current?.(); stopProgress.current = undefined; inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const open = async (): Promise<void> => {
    if (!selectedProject || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const current = await window.modmind.project.current()
      const opened = current?.path === selectedProject.path ? current : await window.modmind.project.openRecent(selectedProject.path)
      onOpened(opened)
    } catch (reason) { if (mounted.current) setError(message(reason)) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="moko-workflow-panel" aria-labelledby="moko-existing-title">
    <h2 id="moko-existing-title">{selectedProject ? '打开已有项目' : '选择已有项目'}</h2>
    <div className="moko-panel-content">
      {selectedProject ? <p className="moko-panel-status">{selectedProject.name}</p> : <div className="moko-existing-choices"><button className="moko-choice" disabled={busy} onClick={() => void inspect('folder')}><FolderOpen size={20} /><span>项目文件夹</span><ArrowRight size={17} /></button><button className="moko-choice" disabled={busy} onClick={() => void inspect('zip')}><PackageOpen size={20} /><span>项目压缩包</span><ArrowRight size={17} /></button></div>}
      <div className="moko-install-status" role="status">{busy ? <><span className="moko-panel-status"><LoaderCircle size={17} className="spin" />{selectedProject ? '正在打开项目…' : progress ? `${progress.phase === 'extracting' ? '正在解压' : '正在识别'} ${progress.sourceName}` : '请选择项目…'}</span>{progress?.phase === 'extracting' ? <progress aria-label="项目解压进度" max={100} value={progress.percent} /> : null}</> : null}</div>
      {error ? <p className="moko-panel-error" role="alert"><CircleAlert size={16} />{error}</p> : null}
    </div>
    {selectedProject ? <div className="moko-panel-actions"><button className="primary-button" disabled={busy} onClick={() => void open()}>{busy ? <LoaderCircle size={17} className="spin" /> : <FolderOpen size={17} />}打开项目并继续</button></div> : null}
  </section>
}

export function MokoProjectPanel({ session, update, analysis, onCreated, onBusyChange }: { session: OnboardingSession; update: (patch: Partial<OnboardingSession>) => void; analysis?: ExistingProjectAnalysis | null; onCreated: (project: ProjectInfo) => void; onBusyChange: (busy: boolean) => void }): React.JSX.Element {
  const features = useFeaturePlugins()
  const studioId = onboardingGoals.find(goal => goal.id === session.goal)?.studioId
  const record = studioCreationRecords(features.records, features.catalog).find(value => value.definition.id === studioId)
  // Reuse studio fields for both creation and adoption, preserving detected project settings.
  const definition = useMemo(() => {
    if (!record?.definition.creation) return undefined
    const fields = record.definition.creation.fields.map(field => {
      if (!analysis && field.id === 'edition') return { ...field, default: 'java', readOnly: true, options: field.options?.filter(option => option.value === 'java') }
      if (analysis?.kind === 'complete' && field.bind === 'loader') return { ...field, readOnly: true }
      if (analysis?.minecraftVersions && field.bind === 'minecraftVersion') return { ...field, type: 'input' as const, source: undefined, options: undefined }
      return field
    })
    if (analysis && !fields.some(field => field.id === 'namespace')) fields.push({ id: 'namespace', title: '命名空间', type: 'input', required: true, default: analysis.inferred.namespace })
    return { ...record.definition, creation: { fields } }
  }, [record?.definition, analysis])
  const values = useMemo<Record<string, string>>(() => definition ? { ...studioFormValues(definition, analysis?.inferred), ...session.projectDraft, ...(!analysis ? { edition: 'java' } : {}) } : {}, [definition, session.projectDraft, analysis])
  const fields = definition?.creation?.fields.filter(field => !field.readOnly && studioFieldVisible(field.when, values)) ?? []
  const index = Math.min(session.fieldIndex, Math.max(0, fields.length - 1)), field = fields[index]
  const form = useRef<HTMLFormElement>(null), creating = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const submit = async (): Promise<void> => {
    if (!definition || !record?.available || !field || creating.current || session.projectMode === 'existing' && !analysis || !form.current?.reportValidity()) return
    if (field.required && !values[field.id]?.trim()) { setError('这一项还没有填好。'); return }
    setError('')
    if (index < fields.length - 1) { update({ fieldIndex: index + 1 }); return }
    const missing = fields.findIndex(value => value.required && !values[value.id]?.trim())
    if (missing >= 0) { update({ fieldIndex: missing }); setError('先把这一项填好，再创建项目。'); return }
    creating.current = true; setBusy(true)
    try {
      const input = studioFormInput(definition, values)
      const project = analysis
        ? await window.modmind.project.adoptExisting({ ...input, sourcePath: analysis.sourcePath, namespace: values.namespace })
        : await window.modmind.project.create(input)
      if (project) onCreated(project)
      else setError('还没有选择保存位置，填写的内容已保留。')
    } catch (reason) { setError(message(reason)) }
    finally { creating.current = false; setBusy(false) }
  }
  return <form className="moko-workflow-panel moko-project-panel" ref={form} onSubmit={event => { event.preventDefault(); void submit() }}>
    <h2>{analysis ? '确认项目配置' : '配置你的作品'}</h2>
    <div className="moko-panel-content">
      {analysis && (analysis.kind === 'partial' || analysis.kind === 'api-docs') ? <p className="moko-panel-status">{analysis.kind === 'partial' ? '识别到部分源码' : '识别到 API 文档'}，会创建项目并导入这些内容。</p> : null}
      {definition && field ? <><p className="moko-panel-status">{analysis ? `${analysis.sourceName} · ` : ''}{index + 1} / {fields.length}</p><StudioFields definition={definition} fieldId={field.id} values={values} onChange={projectDraft => update({ projectDraft })} disabled={busy} versionCandidates={analysis?.minecraftVersions} /></> : <p className="moko-panel-status">{features.ready ? '工作台还没有准备好，请返回上一步重新检查工具。' : '正在读取项目配置…'}</p>}
      {error ? <p className="moko-panel-error" role="alert"><CircleAlert size={16} />{error}</p> : null}
    </div>
    <div className="moko-panel-actions">
      <button className="primary-button" type="submit" disabled={busy || !record?.available || !field || session.projectMode === 'existing' && !analysis}>{busy ? <LoaderCircle size={17} className="spin" /> : index === fields.length - 1 ? <FolderOpen size={17} /> : null}{busy ? analysis ? '正在导入…' : '正在创建…' : index === fields.length - 1 ? analysis ? '导入项目并继续' : '选择位置并创建项目' : '下一项'}{!busy && index < fields.length - 1 ? <ArrowRight size={17} /> : null}</button>
      {index > 0 ? <button className="moko-text-button" type="button" disabled={busy} onClick={() => { setError(''); update({ fieldIndex: index - 1 }) }}>上一项</button> : null}
    </div>
  </form>
}
