import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useRef, useState } from 'react'
import { ClipboardList, FileCheck2, FolderOpen, LoaderCircle, Play, RotateCw, Server, ShieldCheck, Square, TerminalSquare } from 'lucide-react'
import type { ProjectInfo, ServerPackManifest } from '../../../shared/types'
import type { LocalServerState, LocalTestState } from '../../../shared/minecraft'
import { ServerPluginSettings } from './ServerPluginSettings'
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function initialServerState(project: ProjectInfo): LocalServerState { return { stage: 'idle', minecraftVersion: project.minecraftVersion, loader: project.loader, loaderVersion: project.loaderVersion, running: false, recentLogs: [], message: '本机服务端尚未启动' } }
function serverStageLabel(stage: LocalServerState['stage']): string { return ({ idle: '未启动', preparing: '准备中', building: '构建中', installing: '安装运行时', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', error: '需要处理' })[stage] }
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

export default function ServerTestWorkspace({ project }: { project: ProjectInfo }): React.JSX.Element {
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [serverNoticeTone, setServerNoticeTone] = useState<'success' | 'error'>('success')
  const [port, setPort] = useState(25565)
  const [testState, setTestState] = useState<LocalTestState>({ stage: 'idle', active: false, message: '尚未开始测试', recentLogs: [] })
  const [testUsername, setTestUsername] = useState(() => localStorage.getItem('modmind.minecraft.username') || 'ModMindDev')
  const [testMemory, setTestMemory] = useState(() => Number(localStorage.getItem('modmind.minecraft.memory')) || 4096)
  const [consoleTab, setConsoleTab] = useState<'server' | 'client'>('server')
  const [serverState, setServerState] = useState<LocalServerState>(() => initialServerState(project))
  const serverConsoleRef = useRef<HTMLDivElement>(null)
  const followConsoleRef = useRef(true)
  const [serverCommand, setServerCommand] = useState('')
  const [serverOnlineMode, setServerOnlineMode] = useState(false)
  const [serverPackManifest, setServerPackManifest] = useState<ServerPackManifest | null>(null)
  const [scenarioCommand, setScenarioCommand] = useState('say ModMind 本机场景通过')
  const [scenarioEvidence, setScenarioEvidence] = useState('ModMind 本机场景通过')
  useEffect(() => {
    let active = true
    const acceptTest = (state: LocalTestState): void => { if (active && (!state.projectPath || state.projectPath === project.path)) setTestState(state) }
    const removeTest = window.modmind.localTest.onState(acceptTest)
    void window.modmind.localTest.getState().then(acceptTest).catch(error => setNotice(reportClientFailure(error)))
    setServerPackManifest(null)
    void Promise.all([window.modmind.modpack.getServerState(), project.kind === 'modpack' ? window.modmind.modpack.getServerPackManifest() : Promise.resolve(null)]).then(([state, pack]) => {
      if (!active) return
      setServerState(!state.projectPath || state.projectPath === project.path ? state : initialServerState(project))
      setServerPackManifest(pack)
    }).catch((error) => { setServerNoticeTone('error'); setNotice(reportClientFailure(error)) })
    const removeState = window.modmind.modpack.onServerState((state) => { if (active && (!state.projectPath || state.projectPath === project.path)) setServerState(state) })
    const removeEvent = window.modmind.modpack.onServerEvent((event) => { if (event.level === 'error') { setServerNoticeTone('error'); setNotice(event.message) } })
    return () => { active = false; removeState(); removeEvent(); removeTest() }
  }, [project.path])

  useEffect(() => {
    const consoleOutput = serverConsoleRef.current
    if (!consoleOutput || !followConsoleRef.current) return
    consoleOutput.scrollTop = consoleOutput.scrollHeight
  }, [serverState.recentLogs, testState.recentLogs, consoleTab])

  const run = (key: string, action: () => Promise<unknown>, success: (value: unknown) => string): void => {
    if (busy) return
    setBusy(key)
    setNotice('')
    void action().then((value) => {
      if (asRecord(value).success === false) throw new Error(String(asRecord(value).message ?? '验证未通过'))
      if (key.startsWith('server-') || key.startsWith('test-')) setServerNoticeTone('success')
      setNotice(success(value))
    }).catch((error) => {
      if (key.startsWith('server-') || key.startsWith('test-')) setServerNoticeTone('error')
      setNotice(reportClientFailure(error))
    }).finally(() => setBusy(''))
  }

  const renderServerPanel = (): React.JSX.Element => {
    const testPreparing = testState.active && ['preparing', 'starting-server', 'launching-client', 'stopping'].includes(testState.stage)
    const serverBusy = Boolean(busy && busy.startsWith('server-')) || Boolean(serverState.canCancel) || testPreparing || (testState.active && !serverState.running)
    const startable = !serverState.running && !serverBusy
    const runtimeReadyToCheck = Boolean(serverPackManifest)
    const operationProgress = serverState.operationProgress
    const operationPercent = operationProgress?.fraction === undefined ? undefined : Math.round(operationProgress.fraction * 100)
    const operationBytes = operationProgress?.total ? `${bytesLabel(operationProgress.downloaded)} / ${bytesLabel(operationProgress.total)}` : ''
    const runServerAction = (key: string, action: () => Promise<unknown>, success: string | ((value: unknown) => string)): void => run(`server-${key}`, action, (value) => typeof success === 'function' ? success(value) : success)
    const statusTone = serverState.stage === 'error' ? 'error' : serverState.running ? 'running' : 'idle'
    const serverInput = { port, acceptEula: true, onlineMode: serverOnlineMode }
    const testInput = { username: testUsername.trim(), maxMemoryMb: testMemory, port }
    const testOptionsValid = /^[A-Za-z0-9_]{3,16}$/.test(testInput.username) && Number.isInteger(testMemory) && testMemory >= 1024 && testMemory <= 16384
    const consoleLogs = consoleTab === 'server' ? serverState.recentLogs : testState.recentLogs
    const startTest = (): Promise<LocalTestState> => {
      localStorage.setItem('modmind.minecraft.username', testInput.username)
      localStorage.setItem('modmind.minecraft.memory', String(testMemory))
      return window.modmind.localTest.start(testInput)
    }
    return <>
      <header className="content-toolbar server-panel-toolbar">
        <h1 className="visually-hidden">测试</h1><div className="server-instance-summary"><strong>{project.loader} · {project.minecraftVersion}</strong><span>127.0.0.1:{serverState.port ?? port}</span></div>
        <div className="server-panel-toolbar-actions">
          <span className={`server-status-pill ${statusTone}`}><span className="server-status-dot" />服务端：{serverStageLabel(serverState.stage)}</span>
          {testState.active ? <button className="secondary-button danger" disabled={testState.stage === 'stopping'} onClick={() => void window.modmind.localTest.stop().catch(error => setNotice(reportClientFailure(error)))}><Square size={15} />{testPreparing ? '取消测试' : '停止测试'}</button> : serverState.canCancel || serverState.running ? <button className="secondary-button" onClick={() => void window.modmind.modpack.stopServer().catch(error => setNotice(reportClientFailure(error)))}><Square size={15} />停止服务端</button> : <button className="primary-button" disabled={!startable || Boolean(busy) || !testOptionsValid || project.loader === 'velocity'} onClick={() => run('test-start', startTest, () => '')}><Play size={15} />开始测试</button>}
          <button className="secondary-button" disabled={Boolean(busy) || testPreparing || !testState.active || !testOptionsValid} onClick={() => run('test-restart', async () => { await window.modmind.localTest.stop(); return startTest() }, () => '')}><RotateCw size={15} />重新测试</button>
        </div>
      </header>
      <div className="local-test-status" role={testState.stage === 'error' ? 'alert' : 'status'}><span>{testState.message}</span><span>客户端：{testState.client?.running ? '运行中' : testState.client?.message || '未启动'}</span></div>
      {project.loader === 'velocity' ? <p className="server-runtime-message">Velocity 需要后端世界服，请在运维与验证中单独启动服务端。</p> : null}
      <details className="server-configuration"><summary>测试设置<span>{testUsername} · {testMemory} MB · 本机离线</span></summary><div className="modpack-form-grid"><label>玩家名<input value={testUsername} maxLength={16} disabled={testState.active} onChange={event => setTestUsername(event.target.value)} /></label><label>客户端内存（MB）<input type="number" min={1024} max={16384} step={512} value={testMemory} disabled={testState.active} onChange={event => setTestMemory(Number(event.target.value))} /></label></div></details>
      {project.kind === 'server-plugin' ? <details className="server-configuration"><summary>核心与运行配置<span>核心、Java、内存与端口</span></summary><ServerPluginSettings project={project} disabled={serverBusy || serverState.running || testState.active} /></details> : null}
      {serverState.stage === 'error' && serverState.message ? <p className="server-runtime-message" role="alert">{serverState.message}</p> : null}
      <details className="server-runtime-details"><summary>运行详情</summary><dl><div><dt>Loader</dt><dd>{project.loader} {project.loaderVersion || '未记录'}</dd></div><div><dt>进程</dt><dd>{serverState.pid ?? '未启动'}</dd></div><div><dt>日志文件</dt><dd>{serverState.logPath || '启动后生成'}</dd></div></dl></details>
      {operationProgress ? <section className="server-operation-progress" aria-live="polite">
        <div className="server-operation-progress-copy"><span>{operationProgress.message}</span><strong>{operationBytes || (operationPercent === undefined ? '处理中' : `${operationPercent}%`)}</strong></div>
        <div className="server-operation-progress-track" role="progressbar" aria-label="服务端操作进度" aria-valuemin={0} aria-valuemax={100} {...(operationPercent === undefined ? {} : { 'aria-valuenow': operationPercent })}>
          <span className={operationPercent === undefined ? 'indeterminate' : undefined} style={operationPercent === undefined ? undefined : { width: `${operationPercent}%` }} />
        </div>
      </section> : null}
      <section className="server-panel-grid">
        <div className="server-console-panel">
          <div className="server-panel-section-heading"><div className="local-test-console-tabs" role="tablist" aria-label="测试日志"><button role="tab" aria-selected={consoleTab === 'server'} onClick={() => setConsoleTab('server')}>服务端</button><button role="tab" aria-selected={consoleTab === 'client'} onClick={() => setConsoleTab('client')}>客户端</button></div><span className="server-console-count">{consoleLogs.length} 行</span></div>
          <div ref={serverConsoleRef} onScroll={event => { const node = event.currentTarget; followConsoleRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40 }} className="server-console-output" role="log" aria-label={consoleTab === 'server' ? '服务端日志' : '客户端日志'} aria-live="off">{consoleLogs.length ? consoleLogs.map((entry, index) => <div key={`${entry.time}-${index}`}><span className="server-console-gutter">{serverLogTime(entry.time)}</span><span>{entry.message}</span></div>) : <div className="server-console-empty">暂无{consoleTab === 'server' ? '服务端' : '客户端'}日志</div>}</div>
          {consoleTab === 'server' ? <form className="server-command-bar" onSubmit={(event) => { event.preventDefault(); const command = serverCommand.trim(); if (!command || !serverState.running || serverBusy) return; runServerAction('command', () => window.modmind.modpack.sendServerCommand(command), `已发送命令：${command}`); setServerCommand('') }}><TerminalSquare size={16} /><input value={serverCommand} onChange={(event) => setServerCommand(event.target.value)} disabled={!serverState.running || serverBusy} placeholder={serverState.running ? '输入服务器命令，例如 list' : '启动服务端后可输入命令'} aria-label="服务器命令" /><button className="secondary-button compact" type="submit" disabled={!serverState.running || !serverCommand.trim() || serverBusy}>发送</button></form> : null}
        </div>
        <details className="server-side-panel"><summary>运维与验证</summary>
          <div className="modpack-tool-actions"><button className="secondary-button" disabled={!startable || testState.active || Boolean(busy)} onClick={() => runServerAction('start', () => window.modmind.modpack.startServer(serverInput), '本机服务端已启动')}><Server size={15} />单独启动服务端</button><button className="secondary-button" disabled={serverBusy || testState.active || !serverState.running} onClick={() => runServerAction('restart', () => window.modmind.modpack.restartServer(serverInput), '本机服务端已重启')}><RotateCw size={15} />重启服务端</button></div>

          {project.kind === 'modpack' ? <><div className="server-operation-list">
            <button className="server-operation" disabled={serverBusy || serverState.running} onClick={() => runServerAction('pack', async () => {
              const result = await window.modmind.modpack.buildServerPack({ ...serverInput, engine: 'serverpackcreator', includeUnknownSideMods: false })
              setServerPackManifest(await window.modmind.modpack.getServerPackManifest())
              return result
            }, '服务端包已更新')}><FileCheck2 size={17} /><span><strong>同步服务端包</strong></span></button>
            <button className="server-operation" disabled={serverBusy || !runtimeReadyToCheck} title={runtimeReadyToCheck ? undefined : '请先同步服务端包'} onClick={() => runServerAction('runtime', () => window.modmind.modpack.installServerRuntime(serverInput), '服务端运行时已就绪')}><Server size={17} /><span><strong>检查运行时</strong></span></button>
            <button className="server-operation" disabled={serverBusy || !runtimeReadyToCheck} title={runtimeReadyToCheck ? undefined : '请先同步服务端包'} onClick={() => runServerAction('verify', () => window.modmind.modpack.verifyServerJoin(serverInput), '本机联机验证已完成')}><ShieldCheck size={17} /><span><strong>启动并验证</strong></span></button>
          </div>
          <div className="server-settings-block"><h3>启动设置</h3><label className="server-setting-row"><span>监听端口</span><input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={serverState.running || serverBusy} /></label><label className="server-setting-row check-row"><input type="checkbox" checked={serverOnlineMode} onChange={(event) => setServerOnlineMode(event.target.checked)} disabled={serverState.running || serverBusy} /><span>启用正版在线验证</span></label></div></> : <div className="server-settings-block"><h3>场景验证</h3><label className="field-label">命令<input value={scenarioCommand} onChange={event => setScenarioCommand(event.target.value)} /></label><label className="field-label">预期新日志<input value={scenarioEvidence} onChange={event => setScenarioEvidence(event.target.value)} /></label><button className="secondary-button" disabled={!serverState.running || serverBusy || !scenarioCommand.trim() || !scenarioEvidence.trim()} onClick={() => runServerAction('scenario', () => window.modmind.modpack.runServerScenario({ steps: [{ command: scenarioCommand, expect: [scenarioEvidence] }] }), '场景验证通过')}><ShieldCheck size={15} />验证场景</button></div>}
        </details>
      </section>
      {notice ? <div className={`server-panel-notice ${serverNoticeTone}`} role="status">{notice}</div> : null}
    </>
  }

  return <div className="modpack-tool-workspace" data-section="server">{renderServerPanel()}</div>
}
