import { useEffect, useRef, useState } from 'react'
import { FileText, LoaderCircle, PackagePlus, Plus, RotateCw, ShieldCheck, Square, Trash2 } from 'lucide-react'
import type { JavaLoaderKind, ProjectInfo } from '../../../shared/types'
import type { IsolatedServerStep, IsolatedServerTask, ServerFixtureJar } from '../../../shared/serverScenario'
import { reportClientFailure } from '../lib/clientFailure'
import './server-scenario-controls.css'

type StepForm = { id: number; operation: 'command' | 'restart'; command: string; expected: string; timeoutSeconds: number }
const initialStep = (id: number): StepForm => ({ id, operation: 'command', command: 'say ModMind 场景通过', expected: 'ModMind 场景通过', timeoutSeconds: 10 })

export default function ServerScenarioControls({ project, running, disabled }: { project: ProjectInfo; running: boolean; disabled: boolean }): React.JSX.Element {
  const [isolated, setIsolated] = useState(false)
  const [jars, setJars] = useState<ServerFixtureJar[]>([])
  const [minecraftVersion, setMinecraftVersion] = useState(project.minecraftVersion)
  const [loader, setLoader] = useState(project.loader as JavaLoaderKind)
  const [loaderVersion, setLoaderVersion] = useState(project.loaderVersion ?? '')
  const [steps, setSteps] = useState<StepForm[]>([initialStep(1)])
  const nextStep = useRef(2)
  const [task, setTask] = useState<IsolatedServerTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pollFailed, setPollFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  const active = task?.status === 'running'
  const locked = disabled || busy || active

  useEffect(() => {
    alive.current = true
    setTask(null); setJars([]); setMessage(''); setMinecraftVersion(project.minecraftVersion); setLoader(project.loader as JavaLoaderKind); setLoaderVersion(project.loaderVersion ?? '')
    let current = true
    void window.modmind.modpack.runServerScenario({ operation: 'files' }).then(value => { if (current) setJars((value as { jars: ServerFixtureJar[] }).jars) }).catch(error => { if (current) setMessage(reportClientFailure(error)) })
    void window.modmind.modpack.runServerScenario({ operation: 'state' }).then(value => { if (current && value) { setTask(value as IsolatedServerTask); setIsolated(true) } }).catch(error => { if (current) setMessage(reportClientFailure(error)) })
    return () => { current = false; alive.current = false }
  }, [project.path])

  useEffect(() => {
    if (!task?.taskId || task.status !== 'running') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const value = await window.modmind.modpack.runServerScenario({ operation: 'state', taskId: task.taskId }) as IsolatedServerTask
        if (cancelled) return
        setPollFailed(false); setMessage(''); setTask(value)
        if (value.status === 'running') timer = setTimeout(() => void poll(), 1000)
      } catch (error) {
        if (cancelled) return
        setPollFailed(true); setMessage(reportClientFailure(error))
      }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [task?.taskId, task?.status, refresh])

  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await action() } catch (error) { if (alive.current) setMessage(reportClientFailure(error)) }
    finally { if (alive.current) setBusy(false) }
  }
  const valid = steps.every(step => isolated && step.operation === 'restart' || step.command.trim() && step.expected.trim() && Number.isInteger(step.timeoutSeconds) && step.timeoutSeconds >= 1 && step.timeoutSeconds <= 120)
  const start = (): void => { void perform(async () => {
    const inputSteps: IsolatedServerStep[] = steps.map(step => isolated && step.operation === 'restart' ? { operation: 'restart' } : { command: step.command.trim(), expect: step.expected.split('\n').map(line => line.trim()).filter(Boolean), timeoutMs: step.timeoutSeconds * 1000 })
    const value = await window.modmind.modpack.runServerScenario(isolated
      ? { operation: 'start', fixture: { minecraftVersion: minecraftVersion.trim(), loader, loaderVersion: loaderVersion.trim(), jars }, acceptEula: true, steps: inputSteps }
      : { steps: inputSteps })
    if (!alive.current) return
    if (isolated) { setTask(value as IsolatedServerTask); setPollFailed(false) }
    else { const result = value as { success: boolean; failedStep?: number }; setMessage(result.success ? '场景验证通过' : `第 ${result.failedStep ?? '?'} 步未通过`) }
  }) }
  return <section className="server-settings-block server-scenario-controls">
    <h3>场景验证</h3>
    <div className="scenario-mode" role="group" aria-label="场景运行方式">
      <button type="button" aria-pressed={!isolated} disabled={Boolean(locked)} onClick={() => setIsolated(false)}>当前服务端</button>
      <button type="button" aria-pressed={isolated} disabled={Boolean(locked)} onClick={() => setIsolated(true)}>隔离测试</button>
    </div>
    {isolated ? <>
      <div className="scenario-runtime-fields">
        <label className="field-label">Minecraft<input value={minecraftVersion} disabled={Boolean(locked)} onChange={event => setMinecraftVersion(event.target.value)} /></label>
        <label className="field-label">Loader<select value={loader} disabled={Boolean(locked)} onChange={event => setLoader(event.target.value as JavaLoaderKind)}>{['fabric', 'quilt', 'forge', 'neoforge'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="field-label">Loader 版本<input value={loaderVersion} disabled={Boolean(locked)} onChange={event => setLoaderVersion(event.target.value)} /></label>
      </div>
      <div className="scenario-jar-heading"><span>测试 JAR · {jars.length}</span><button className="secondary-button compact" disabled={Boolean(locked)} onClick={() => void perform(async () => { const selected = await window.modmind.modpack.pickScenarioJars(); if (alive.current) setJars(selected) })}><PackagePlus size={14} />选择 JAR</button></div>
      {jars.length ? <ul className="scenario-jars">{jars.map(jar => <li key={jar.path}><span title={jar.path}>{jar.name ?? jar.path.split(/[\\/]/).at(-1)}</span><button className="icon-button" title={`移除 ${jar.name ?? 'JAR'}`} disabled={Boolean(locked)} onClick={() => void perform(async () => { const selected = await window.modmind.modpack.removeScenarioJar(jar.path); if (alive.current) setJars(selected) })}><Trash2 size={14} /></button></li>)}</ul> : null}
    </> : null}
    <div className="scenario-steps">{steps.map((step, index) => <div className="scenario-step" key={step.id}>
      <div className="scenario-step-heading"><span>步骤 {index + 1}</span>{isolated ? <select aria-label={`步骤 ${index + 1} 操作`} value={step.operation} disabled={Boolean(locked)} onChange={event => setSteps(current => current.map(entry => entry.id === step.id ? { ...entry, operation: event.target.value as StepForm['operation'] } : entry))}><option value="command">命令</option><option value="restart">重启</option></select> : null}<button className="icon-button" title={`删除步骤 ${index + 1}`} disabled={Boolean(locked) || steps.length === 1} onClick={() => setSteps(current => current.filter(entry => entry.id !== step.id))}><Trash2 size={14} /></button></div>
      {step.operation === 'command' || !isolated ? <><label className="field-label">命令<input value={step.command} maxLength={1000} disabled={Boolean(locked)} onChange={event => setSteps(current => current.map(entry => entry.id === step.id ? { ...entry, operation: 'command', command: event.target.value } : entry))} /></label><label className="field-label">预期新日志<textarea rows={2} value={step.expected} disabled={Boolean(locked)} onChange={event => setSteps(current => current.map(entry => entry.id === step.id ? { ...entry, expected: event.target.value } : entry))} /></label><label className="server-setting-row"><span>等待上限（秒）</span><input aria-label={`步骤 ${index + 1} 等待上限（秒）`} type="number" min={1} max={120} value={step.timeoutSeconds} disabled={Boolean(locked)} onChange={event => setSteps(current => current.map(entry => entry.id === step.id ? { ...entry, timeoutSeconds: Number(event.target.value) } : entry))} /></label></> : null}
    </div>)}</div>
    <div className="scenario-actions"><button className="icon-button" title="添加步骤" disabled={Boolean(locked) || steps.length >= 40} onClick={() => setSteps(current => [...current, initialStep(nextStep.current++)])}><Plus size={16} /></button></div>
    {isolated ? <p className="scenario-download-note">首次准备可能下载数百 MB 运行时；测试结束后清理临时存档。</p> : null}
    <div className="scenario-actions">{active || isolated && task?.canCancel ? <button className="secondary-button" disabled={busy || !task!.canCancel} onClick={() => void perform(async () => { const value = await window.modmind.modpack.runServerScenario({ operation: 'cancel', taskId: task!.taskId }); if (alive.current) setTask(value as IsolatedServerTask) })}><Square size={15} />{active ? '取消测试' : '重试停止'}</button> : <button className="secondary-button" disabled={Boolean(locked) || !valid || (isolated ? !jars.length || !minecraftVersion.trim() || !loaderVersion.trim() : !running)} onClick={start}>{busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}{isolated ? '运行隔离场景' : '验证场景'}</button>}
      {pollFailed ? <button className="icon-button" title="重新查询测试进度" onClick={() => { setPollFailed(false); setRefresh(value => value + 1) }}><RotateCw size={15} /></button> : null}
    </div>
    <div className="scenario-status" aria-live="polite">{task && isolated ? <><strong>{task.message}</strong><span>{task.completed}/{task.total} 步</span>{task.logPath ? <button className="secondary-button compact" onClick={() => void perform(() => window.modmind.project.reveal(`.modmind/server/scenarios/${task.taskId}/server.log`, project.path))}><FileText size={14} />查看日志</button> : null}</> : null}{message ? <span role="status">{message}</span> : null}</div>
    {isolated && task?.result ? <details className="scenario-results"><summary>结果与证据</summary><dl><dt>运行版本</dt><dd>{task.result.minecraftVersion} · {task.result.loader} {task.result.loaderVersion} · Java {task.result.java.version}</dd><dt>清理</dt><dd>{task.result.cleanup === 'complete' ? '测试实例已清理' : '待检查'}</dd></dl>{task.result.evidence.map((line, index) => <p key={index}>{line}</p>)}{task.result.warnings.map(line => <p key={line}>{line}</p>)}</details> : null}
  </section>
}
