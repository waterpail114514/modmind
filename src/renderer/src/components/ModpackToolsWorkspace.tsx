import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, BookOpen, Box, ClipboardList, FileCheck2, FolderOpen, Gauge, LoaderCircle, Network, PackageSearch, Play, RotateCw, Server, ShieldCheck, Sparkles, Square, TerminalSquare } from 'lucide-react'
import type { ModpackManifest, ModpackProviderInfo, ProjectInfo, ServerPackManifest } from '../../../shared/types'
import type { LocalServerState } from '../../../shared/minecraft'
import FtbQuestEditor from './FtbQuestEditor'
import { ServerPluginSettings } from './ServerPluginTools'

type ToolSection = 'content' | 'automation' | 'server' | 'modules'

type PlanEntry = { request: string; parent?: string; dependencyKind?: string; blocking?: boolean; selected?: { filename?: string; provider?: string; projectId?: string }; reason?: string }
type ModpackPlanView = { success?: boolean; required?: PlanEntry[]; optional?: PlanEntry[]; dependencies?: PlanEntry[]; conflicts?: string[]; warnings?: string[]; review?: { installCount?: number; providers?: string[]; unresolved?: number; optionalSuggestions?: number } }
type OptimizationProfileView = { id: string; name: string; description?: string }

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function initialServerState(project: ProjectInfo): LocalServerState { return { stage: 'idle', minecraftVersion: project.minecraftVersion, loader: project.loader, loaderVersion: project.loaderVersion, running: false, recentLogs: [], message: '本机服务端尚未启动' } }
function serverStageLabel(stage: LocalServerState['stage']): string { return ({ idle: '未启动', preparing: '准备中', building: '构建中', installing: '安装运行时', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', error: '需要处理' })[stage] }
function commaList(value: string): string[] { return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))] }
function serverLogTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '--:--'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp)
}
function bytesLabel(value: number | undefined): string {
  if (!Number.isFinite(value) || !value || value < 0) return ''
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`
}

export default function ModpackToolsWorkspace({ project, section, onOpenModule }: { project: ProjectInfo; section: ToolSection; onOpenModule?: (module: ProjectInfo) => void }): React.JSX.Element {
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [serverNoticeTone, setServerNoticeTone] = useState<'success' | 'error'>('success')
  const [plan, setPlan] = useState<ModpackPlanView | null>(null)
  const [profiles, setProfiles] = useState<OptimizationProfileView[]>([])
  const [selectedProfile, setSelectedProfile] = useState('safe-client')
  const [requiredMods, setRequiredMods] = useState('')
  const [optionalMods, setOptionalMods] = useState('')
  const [excludedMods, setExcludedMods] = useState('')
  const [providers, setProviders] = useState<ModpackProviderInfo[]>([])
  const [enabledProviders, setEnabledProviders] = useState<string[]>([])
  const [chapterId, setChapterId] = useState('getting-started')
  const [chapterTitle, setChapterTitle] = useState('入门任务')
  const [questId, setQuestId] = useState('first-step')
  const [questTitle, setQuestTitle] = useState('开始冒险')
  const [taskType, setTaskType] = useState<'item' | 'location' | 'checkmark'>('checkmark')
  const [taskItem, setTaskItem] = useState('minecraft:crafting_table')
  const [bookId, setBookId] = useState('guide')
  const [bookName, setBookName] = useState('整合包指南')
  const [landingText, setLandingText] = useState('从这里开始你的旅程')
  const [categoryId, setCategoryId] = useState('getting-started')
  const [categoryName, setCategoryName] = useState('入门')
  const [entryId, setEntryId] = useState('welcome')
  const [entryName, setEntryName] = useState('欢迎')
  const [entryText, setEntryText] = useState('查看任务书，完成第一项任务')
  const [port, setPort] = useState(25565)
  const [serverState, setServerState] = useState<LocalServerState>(() => initialServerState(project))
  const serverConsoleRef = useRef<HTMLDivElement>(null)
  const followConsoleRef = useRef(true)
  const [serverCommand, setServerCommand] = useState('')
  const [serverOnlineMode, setServerOnlineMode] = useState(false)
  const serverEulaAccepted = true
  const [serverPackManifest, setServerPackManifest] = useState<ServerPackManifest | null>(null)
  const [scenarioCommand, setScenarioCommand] = useState('say ModMind 本机场景通过')
  const [scenarioEvidence, setScenarioEvidence] = useState('ModMind 本机场景通过')
  const [manifest, setManifest] = useState<ModpackManifest | null>(null)
  const [moduleName, setModuleName] = useState('')

  useEffect(() => {
    if (section !== 'modules') return
    void window.modmind.modpack.get().then(setManifest).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
  }, [section, project.path])

  useEffect(() => {
    if (section !== 'automation') return
    void Promise.all([window.modmind.modpack.listOptimizationProfiles(), window.modmind.modpack.providers()]).then(([value, available]) => {
      const next = Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => typeof item.id === 'string' && typeof item.name === 'string').map((item) => ({ id: String(item.id), name: String(item.name), description: typeof item.description === 'string' ? item.description : undefined })) : []
      setProfiles(next)
      if (next.length && !next.some((profile) => profile.id === selectedProfile)) setSelectedProfile(next[0].id)
      const nextProviders = Array.isArray(available) ? available as ModpackProviderInfo[] : []
      setProviders(nextProviders)
      setEnabledProviders(nextProviders.map((provider) => provider.id))
    }).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
  }, [section])

  useEffect(() => {
    if (section !== 'server') return
    let active = true
    setServerPackManifest(null)
    void Promise.all([window.modmind.modpack.getServerState(), project.kind === 'modpack' ? window.modmind.modpack.getServerPackManifest() : Promise.resolve(null)]).then(([state, pack]) => {
      if (!active) return
      setServerState(!state.projectPath || state.projectPath === project.path ? state : initialServerState(project))
      setServerPackManifest(pack)
    }).catch((error) => { setServerNoticeTone('error'); setNotice(error instanceof Error ? error.message : String(error)) })
    const removeState = window.modmind.modpack.onServerState((state) => { if (active && (!state.projectPath || state.projectPath === project.path)) setServerState(state) })
    const removeEvent = window.modmind.modpack.onServerEvent((event) => { if (event.level === 'error') { setServerNoticeTone('error'); setNotice(event.message) } })
    return () => { active = false; removeState(); removeEvent() }
  }, [section, project.path])

  useEffect(() => {
    const consoleOutput = serverConsoleRef.current
    if (!consoleOutput || !followConsoleRef.current) return
    consoleOutput.scrollTop = consoleOutput.scrollHeight
  }, [serverState.recentLogs])

  const selectedProfileInfo = useMemo(() => profiles.find((profile) => profile.id === selectedProfile), [profiles, selectedProfile])

  const run = (key: string, action: () => Promise<unknown>, success: (value: unknown) => string): void => {
    if (busy) return
    setBusy(key)
    setNotice('')
    void action().then((value) => {
      if (asRecord(value).success === false) throw new Error(String(asRecord(value).message ?? '验证未通过'))
      if (key.startsWith('server-')) setServerNoticeTone('success')
      setNotice(success(value))
    }).catch((error) => {
      if (key.startsWith('server-')) setServerNoticeTone('error')
      setNotice(error instanceof Error ? error.message : String(error))
    }).finally(() => setBusy(''))
  }

  const createPlan = (): void => {
    run('plan', () => window.modmind.modpack.plan({ required: commaList(requiredMods), optional: commaList(optionalMods), excluded: commaList(excludedMods), ...(enabledProviders.length ? { providers: enabledProviders } : {}) }), (value) => {
      const next = value as ModpackPlanView
      setPlan(next)
      const resolved = [...(next.required ?? []), ...(next.optional ?? [])].filter((entry) => entry.selected).length
      return next.success ? `方案已生成，可安装 ${resolved} 个 Mod` : `方案存在未解决项，请先处理 ${next.warnings?.length ?? 0} 条提示`
    })
  }

  const renderContent = (): React.JSX.Element => <>
    <FtbQuestEditor project={project} />
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><BookOpen size={18} /><div><h2>Patchouli 指南书</h2><p>创建包含一个分类和一篇条目的完整基础书籍</p></div></div>
      <div className="modpack-form-grid three"><label>书籍标识<input value={bookId} onChange={(event) => setBookId(event.target.value)} /></label><label>书籍名称<input value={bookName} onChange={(event) => setBookName(event.target.value)} /></label><label>首页文本<input value={landingText} onChange={(event) => setLandingText(event.target.value)} /></label><label>分类标识<input value={categoryId} onChange={(event) => setCategoryId(event.target.value)} /></label><label>分类名称<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} /></label><label>条目标识<input value={entryId} onChange={(event) => setEntryId(event.target.value)} /></label><label>条目名称<input value={entryName} onChange={(event) => setEntryName(event.target.value)} /></label><label className="wide">条目正文<textarea value={entryText} onChange={(event) => setEntryText(event.target.value)} /></label></div>
      <div className="modpack-tool-actions"><button className="primary-button" disabled={Boolean(busy)} onClick={() => run('book', () => window.modmind.modpack.writePatchouliBook({ bookId, name: bookName, landingText, categories: [{ id: categoryId, name: categoryName, icon: 'minecraft:book', entries: [{ id: entryId, name: entryName, icon: 'minecraft:book', text: entryText }] }] }), (value) => `已写入 ${Array.isArray(value) ? value.length : 0} 个指南文件`)}>{busy === 'book' ? <LoaderCircle className="spin" size={16} /> : <BookOpen size={16} />}写入指南书</button></div>
    </section>
  </>

  const renderAutomation = (): React.JSX.Element => <>
    <header className="content-toolbar"><div><h1>依赖与优化</h1><p>把构思变为可审计的 Mod 方案，随后安装、锁定和优化</p></div></header>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><PackageSearch size={18} /><div><h2>Mod 方案</h2><p>每行或逗号分隔一个名称。安装前先展示兼容性与未解决项</p></div></div>
      <div className="modpack-form-grid"><label>必需 Mod<textarea value={requiredMods} onChange={(event) => setRequiredMods(event.target.value)} placeholder="例如：Create，FTB Quests" /></label><label>可选 Mod<textarea value={optionalMods} onChange={(event) => setOptionalMods(event.target.value)} placeholder="例如：JEI，Jade" /></label><label>排除 Mod<textarea value={excludedMods} onChange={(event) => setExcludedMods(event.target.value)} placeholder="例如：OptiFine" /></label></div>
      <div className="modpack-tool-actions"><button className="primary-button" disabled={Boolean(busy) || !commaList(requiredMods).length} onClick={createPlan}>{busy === 'plan' ? <LoaderCircle className="spin" size={16} /> : <PackageSearch size={16} />}生成方案</button><button className="secondary-button" disabled={Boolean(busy) || !plan?.success} onClick={() => run('apply-plan', () => window.modmind.modpack.applyPlan(plan), (value) => `已安装 ${Array.isArray(asRecord(value).installed) ? (asRecord(value).installed as unknown[]).length : 0} 个 Mod，并已完成锁定审计`)}>{busy === 'apply-plan' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}安装方案</button></div>
      {providers.length ? <div className="modpack-provider-options" aria-label="搜索平台">{providers.map((provider) => <label key={provider.id} className="check-row"><input type="checkbox" checked={enabledProviders.includes(provider.id)} onChange={() => setEnabledProviders((current) => current.includes(provider.id) ? current.filter((id) => id !== provider.id) : [...current, provider.id])} />{provider.label}<small>{provider.supportsDependencies ? '支持前置解析' : '仅搜索'}</small></label>)}</div> : null}
      {plan ? <div className={`modpack-result ${plan.success ? 'success' : 'warning'}`}><strong>{plan.success ? '方案可安装' : '方案待处理'}</strong>{[...(plan.required ?? []), ...(plan.optional ?? []), ...(plan.dependencies ?? [])].map((entry) => <span key={`${entry.request}-${entry.selected?.filename ?? entry.reason}`} className={entry.parent ? 'dependency-result' : undefined}>{entry.parent ? `${entry.parent} → ` : ''}{entry.request}：{entry.selected?.filename ?? entry.reason ?? '未解析'}</span>)}{plan.review ? <span>审核摘要：预计安装 {plan.review.installCount ?? 0} 个，未解决 {plan.review.unresolved ?? 0} 项{plan.review.optionalSuggestions ? `，可选前置 ${plan.review.optionalSuggestions} 项` : ''}</span> : null}{plan.conflicts?.map((conflict) => <span key={conflict}>冲突：{conflict}</span>)}{plan.warnings?.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
    </section>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><ShieldCheck size={18} /><div><h2>锁定审计</h2><p>检查已记录的 JAR 是否仍与锁定的文件大小和 SHA-256 一致</p></div></div>
      <div className="modpack-tool-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => run('audit', () => window.modmind.modpack.auditLock(), (value) => { const audit = asRecord(value); return audit.success ? `锁定审计通过，已检查 ${String(audit.checked ?? 0)} 个文件` : `锁定审计失败：${Array.isArray(audit.errors) ? audit.errors.join('；') : '请查看项目日志'}` })}>{busy === 'audit' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}审计锁定</button><button className="icon-button" title="读取锁定清单" disabled={Boolean(busy)} onClick={() => run('read-lock', () => window.modmind.modpack.readLock(), (value) => `当前锁定 ${Array.isArray(asRecord(value).mods) ? (asRecord(value).mods as unknown[]).length : 0} 个 Mod`)}><FileCheck2 size={16} /></button></div>
    </section>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><Gauge size={18} /><div><h2>性能优化</h2><p>只安装已解析为当前版本与加载器兼容的候选项</p></div></div>
      <div className="modpack-tool-actions"><label className="inline-field">优化档<select value={selectedProfile} onChange={(event) => setSelectedProfile(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><button className="secondary-button" disabled={Boolean(busy) || !selectedProfile} onClick={() => run('optimization', () => window.modmind.modpack.applyOptimizationProfile({ profileId: selectedProfile }), (value) => { const result = asRecord(value); return `已应用优化档；配置修改 ${Array.isArray(result.appliedPatches) ? result.appliedPatches.length : 0} 项，提示 ${Array.isArray(result.warnings) ? result.warnings.length : 0} 条` })}>{busy === 'optimization' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}应用优化</button></div>
      {selectedProfileInfo?.description ? <p className="modpack-inline-note">{selectedProfileInfo.description}</p> : null}
    </section>
  </>

  const renderServerPanel = (): React.JSX.Element => {
    const serverBusy = Boolean(busy && busy.startsWith('server-')) || Boolean(serverState.canCancel)
    const startable = !serverState.running && !serverBusy
    const runtimeReadyToCheck = Boolean(serverPackManifest)
    const operationProgress = serverState.operationProgress
    const operationPercent = operationProgress?.fraction === undefined ? undefined : Math.round(operationProgress.fraction * 100)
    const operationBytes = operationProgress?.total ? `${bytesLabel(operationProgress.downloaded)} / ${bytesLabel(operationProgress.total)}` : ''
    const runServerAction = (key: string, action: () => Promise<unknown>, success: string | ((value: unknown) => string)): void => run(`server-${key}`, action, (value) => typeof success === 'function' ? success(value) : success)
    const statusTone = serverState.stage === 'error' ? 'error' : serverState.running ? 'running' : 'idle'
    const serverInput = { port, acceptEula: true, onlineMode: serverOnlineMode }
    return <>
      <header className="content-toolbar server-panel-toolbar">
        <div><h1>服务端测试</h1><p>{project.loader} Loader {project.loaderVersion || '未记录'} · Minecraft {project.minecraftVersion}</p></div>
        <div className="server-panel-toolbar-actions">
          <span className={`server-status-pill ${statusTone}`}><span className="server-status-dot" />{serverStageLabel(serverState.stage)}</span>
          {serverState.canCancel ? <button className="secondary-button" onClick={() => void window.modmind.modpack.stopServer().catch(error => setNotice(String(error)))}><Square size={15} />取消准备</button> : serverState.running ? <button className="secondary-button danger" disabled={serverBusy} onClick={() => runServerAction('stop', () => window.modmind.modpack.stopServer(), '本机服务端已停止')}><Square size={15} />停止</button> : <button className="primary-button" disabled={!startable} onClick={() => runServerAction('start', () => window.modmind.modpack.startServer(serverInput), '本机服务端已启动')}><Play size={15} />启动</button>}
          <button className="secondary-button" disabled={serverBusy || !serverState.running} onClick={() => runServerAction('restart', () => window.modmind.modpack.restartServer(serverInput), '本机服务端已重启')}><RotateCw size={15} />重启</button>
        </div>
      </header>
      {project.kind === 'server-plugin' ? <details className="server-configuration"><summary>核心与运行配置<span>核心、Java、内存与端口</span></summary><ServerPluginSettings project={project} disabled={serverBusy || serverState.running} /></details> : null}
      <section className="server-panel-hero">
        <div className="server-panel-hero-copy"><div className={`server-panel-icon ${statusTone}`}><Server size={22} /></div><div><span className="server-panel-eyebrow">LOCAL INSTANCE</span><h2>{serverState.running ? '服务端正在运行' : serverState.stage === 'error' ? '服务端需要处理' : '服务端控制台'}</h2><p>{serverState.message}</p></div></div>
        <div className="server-panel-hero-meta"><span><Network size={14} />127.0.0.1:{serverState.port ?? port}</span>{serverState.pid ? <span><Activity size={14} />PID {serverState.pid}</span> : null}</div>
      </section>
      <section className="server-stat-grid" aria-label="服务端状态">
        <div className="server-stat"><span>游戏版本</span><strong>{project.minecraftVersion}</strong><small>{project.loader} {project.loaderVersion || 'Loader 未记录'}</small></div>
        <div className="server-stat"><span>连接地址</span><strong>127.0.0.1</strong></div>
        <div className="server-stat"><span>运行端口</span><strong>{serverState.port ?? port}</strong><small>{serverState.running ? '端口已就绪' : '启动后监听'}</small></div>
        <div className="server-stat"><span>日志文件</span><strong>{serverState.logPath ? '已生成' : '等待启动'}</strong><small>{serverState.logPath ? serverState.logPath.split(/[\\/]/).at(-1) : 'server-pack/logs'}</small></div>
      </section>
      {operationProgress ? <section className="server-operation-progress" aria-live="polite">
        <div className="server-operation-progress-copy"><span>{operationProgress.message}</span><strong>{operationBytes || (operationPercent === undefined ? '处理中' : `${operationPercent}%`)}</strong></div>
        <div className="server-operation-progress-track" role="progressbar" aria-label="服务端操作进度" aria-valuemin={0} aria-valuemax={100} {...(operationPercent === undefined ? {} : { 'aria-valuenow': operationPercent })}>
          <span className={operationPercent === undefined ? 'indeterminate' : undefined} style={operationPercent === undefined ? undefined : { width: `${operationPercent}%` }} />
        </div>
      </section> : null}
      <section className="server-panel-grid">
        <div className="server-console-panel">
          <div className="server-panel-section-heading"><div><span className="server-panel-eyebrow">LIVE OUTPUT</span><h2>实时控制台</h2></div><span className="server-console-count">{serverState.recentLogs.length} 行</span></div>
          <div ref={serverConsoleRef} onScroll={event => { const node = event.currentTarget; followConsoleRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40 }} className="server-console-output" role="log" aria-live="off">{serverState.recentLogs.length ? serverState.recentLogs.map((entry, index) => <div key={`${entry.time}-${index}`}><span className="server-console-gutter">{serverLogTime(entry.time)}</span><span>{entry.message}</span></div>) : <div className="server-console-empty">启动服务端后，日志会实时显示在这里</div>}</div>
          <form className="server-command-bar" onSubmit={(event) => { event.preventDefault(); const command = serverCommand.trim(); if (!command || !serverState.running || serverBusy) return; runServerAction('command', () => window.modmind.modpack.sendServerCommand(command), `已发送命令：${command}`); setServerCommand('') }}><TerminalSquare size={16} /><input value={serverCommand} onChange={(event) => setServerCommand(event.target.value)} disabled={!serverState.running || serverBusy} placeholder={serverState.running ? '输入服务器命令，例如 list' : '启动服务端后可输入命令'} aria-label="服务器命令" /><button className="secondary-button compact" type="submit" disabled={!serverState.running || !serverCommand.trim() || serverBusy}>发送</button></form>
        </div>
        <aside className="server-side-panel">
          <div className="server-panel-section-heading"><div><span className="server-panel-eyebrow">OPERATIONS</span><h2>运维操作</h2></div></div>
          {project.kind === 'modpack' ? <><div className="server-operation-list">
            <button className="server-operation" disabled={serverBusy || serverState.running} onClick={() => runServerAction('pack', async () => {
              const result = await window.modmind.modpack.buildServerPack({ ...serverInput, engine: 'serverpackcreator', includeUnknownSideMods: false })
              setServerPackManifest(await window.modmind.modpack.getServerPackManifest())
              return result
            }, '服务端包已更新')}><FileCheck2 size={17} /><span><strong>同步服务端包</strong><small>使用 ServerPackCreator 自动筛选并复制</small></span></button>
            <button className="server-operation" disabled={serverBusy || !runtimeReadyToCheck} title={runtimeReadyToCheck ? undefined : '请先同步服务端包'} onClick={() => runServerAction('runtime', () => window.modmind.modpack.installServerRuntime(serverInput), '服务端运行时已就绪')}><Server size={17} /><span><strong>检查运行时</strong><small>{runtimeReadyToCheck ? '确认 Loader 和 Java 版本匹配' : '请先同步服务端包'}</small></span></button>
            <button className="server-operation" disabled={serverBusy || !runtimeReadyToCheck} title={runtimeReadyToCheck ? undefined : '请先同步服务端包'} onClick={() => runServerAction('verify', () => window.modmind.modpack.verifyServerJoin(serverInput), '本机联机验证已完成')}><ShieldCheck size={17} /><span><strong>启动并验证</strong><small>{runtimeReadyToCheck ? '使用隔离客户端验证加入' : '请先同步服务端包'}</small></span></button>
          </div>
          <div className="server-settings-block"><h3>启动设置</h3><label className="server-setting-row"><span>监听端口</span><input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={serverState.running || serverBusy} /></label><label className="server-setting-row check-row"><input type="checkbox" checked={serverOnlineMode} onChange={(event) => setServerOnlineMode(event.target.checked)} disabled={serverState.running || serverBusy} /><span>启用正版在线验证</span></label></div></> : <div className="server-settings-block"><h3>场景验证</h3><label className="field-label">命令<input value={scenarioCommand} onChange={event => setScenarioCommand(event.target.value)} /></label><label className="field-label">预期新日志<input value={scenarioEvidence} onChange={event => setScenarioEvidence(event.target.value)} /></label><button className="secondary-button" disabled={!serverState.running || serverBusy || !scenarioCommand.trim() || !scenarioEvidence.trim()} onClick={() => runServerAction('scenario', () => window.modmind.modpack.runServerScenario({ steps: [{ command: scenarioCommand, expect: [scenarioEvidence] }] }), '场景验证通过')}><ShieldCheck size={15} />验证场景</button></div>}
        </aside>
      </section>
      {notice ? <div className={`server-panel-notice ${serverNoticeTone}`} role="status">{notice}</div> : null}
    </>
  }

  const renderServer = (): React.JSX.Element => <>
    <header className="content-toolbar"><div><h1>服务端测试</h1><p>{project.loader} Loader {project.loaderVersion || '未记录'} · Minecraft {project.minecraftVersion}</p></div></header>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><Server size={18} /><div><h2>服务端设置</h2></div></div>
      <div className="modpack-form-grid"><label>本机端口<input type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label></div>
      <div className="modpack-tool-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => run('server-pack', () => window.modmind.modpack.buildServerPack({ port, engine: 'serverpackcreator', includeUnknownSideMods: false, acceptEula: true, onlineMode: false }), (value) => { const result = asRecord(value); return `已生成服务端包，包含 ${Array.isArray(result.copiedMods) ? result.copiedMods.length : 0} 个 Mod` })}>{busy === 'server-pack' ? <LoaderCircle className="spin" size={16} /> : <Server size={16} />}生成服务端包</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => run('server-runtime', () => window.modmind.modpack.installServerRuntime({ port, acceptEula: true, onlineMode: false }), (value) => `服务端运行时已就绪：${String(asRecord(value).serverJar ?? '启动脚本')}`)}>{busy === 'server-runtime' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}安装运行时</button></div>
    </section>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><Play size={18} /><div><h2>本机联机验证</h2><p>启动本机服务端，等待端口就绪，再让 HeadlessMC 使用隔离测试实例连接</p></div></div>
      <div className="modpack-tool-actions"><button className="primary-button" disabled={Boolean(busy) || !serverEulaAccepted} onClick={() => run('server-join', () => window.modmind.modpack.verifyServerJoin({ port, acceptEula: serverEulaAccepted, onlineMode: false }), (value) => { const result = asRecord(value); return result.success ? `本机联机验证通过：${String(result.address ?? '')}` : `本机联机验证未通过：${String(result.message ?? '')}` })}>{busy === 'server-join' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}启动并验证</button></div>
    </section>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><TerminalSquare size={18} /><div><h2>服务端场景</h2><p>发送服务器命令，并要求日志包含指定证据后才视为通过</p></div></div>
      <div className="modpack-form-grid"><label>服务器命令<input value={scenarioCommand} onChange={(event) => setScenarioCommand(event.target.value)} /></label><label>预期日志<input value={scenarioEvidence} onChange={(event) => setScenarioEvidence(event.target.value)} /></label></div>
      <div className="modpack-tool-actions"><button className="secondary-button" disabled={Boolean(busy) || !serverEulaAccepted || !scenarioCommand.trim() || !scenarioEvidence.trim()} onClick={() => run('server-scenario', () => window.modmind.modpack.runServerScenario({ port, acceptEula: serverEulaAccepted, onlineMode: false, steps: [{ command: scenarioCommand.trim(), expect: [scenarioEvidence.trim()] }] }), (value) => { const result = asRecord(value); return result.success ? `场景通过，已完成 ${String(result.completed ?? 0)} 步` : `场景失败于第 ${String(result.failedStep ?? '?')} 步` })}>{busy === 'server-scenario' ? <LoaderCircle className="spin" size={16} /> : <TerminalSquare size={16} />}运行场景</button></div>
    </section>
  </>

  const createModule = (): void => {
    if (!moduleName.trim() || busy) return
    setBusy('module')
    setNotice('')
    void window.modmind.modpack.createModule(moduleName.trim()).then(setManifest).then(() => setModuleName('')).catch((error) => setNotice(error instanceof Error ? error.message : String(error))).finally(() => setBusy(''))
  }

  const renderModules = (): React.JSX.Element => <>
    <header className="content-toolbar"><div><h1>自制模组</h1><p>把需要编写和维护的模块独立管理，构建后再同步到整合包实例</p></div></header>
    <section className="modpack-tool-section">
      <div className="modpack-tool-heading"><Box size={18} /><div><h2>模块工作区</h2><p>每个模块都是一个独立工程，可以单独打开、编写和构建</p></div></div>
      <div className="modpack-module-create"><input value={moduleName} maxLength={80} placeholder="例如：核心玩法" onChange={(event) => setModuleName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createModule() }} /><button className="primary-button" disabled={Boolean(busy) || !moduleName.trim()} onClick={createModule}>{busy === 'module' ? <LoaderCircle className="spin" size={15} /> : <Box size={15} />}新建自制模组</button></div>
      <div className="modpack-list">{manifest?.modules.map((module) => <div className="modpack-row" key={module.namespace}><Box size={16} /><span><strong>{module.name}</strong><small>{module.namespace} · {module.path}</small></span><button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void window.modmind.modpack.openModule(module.namespace).then((value) => onOpenModule?.(value)).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}><FolderOpen size={14} />打开</button></div>)}{!manifest?.modules.length ? <p className="modpack-empty">还没有自制模组，先创建一个模块</p> : null}</div>
      {notice ? <div className="modpack-result warning"><strong>状态</strong><span>{notice}</span></div> : null}
    </section>
  </>

  return <div className="modpack-tool-workspace" data-section={section}>{section === 'content' ? renderContent() : section === 'automation' ? renderAutomation() : section === 'server' ? renderServerPanel() : renderModules()}{section !== 'server' && section !== 'modules' && notice ? <div className="toast">{notice}</div> : null}</div>
}
