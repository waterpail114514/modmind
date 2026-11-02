import { diagnosticJournal, redactDiagnosticText } from '../../../../src/main/diagnosticLog'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { MinecraftManagedMod, MinecraftRuntimeState } from '../../../../src/shared/minecraft'
import type { MinecraftRuntimeManager } from './minecraftRuntime'
import { SerialState } from '../../../../src/main/liveConfiguration'
import { sameProjectPath } from '../../../../src/main/projectPath'
import { CreationFeedbackService } from '../../../../src/main/creationFeedbackService'
import { installNativeMcp, nativeMcpFor, nativeMcpRelease, NativeMinecraftMcpClient } from './nativeMinecraftMcp'

type Runtime = Pick<MinecraftRuntimeManager, 'getState' | 'launch' | 'stop'>
interface Dependencies {
  currentProject: () => ProjectInfo | null
  build: (project: ProjectInfo, signal?: AbortSignal) => Promise<MinecraftManagedMod>
  createRuntime: (project: ProjectInfo, directory: string, port: number) => Runtime
  install?: typeof installNativeMcp
}
interface Session {
  id: string; project: ProjectInfo; directory: string; runtime: Runtime; port: number
  client?: NativeMinecraftMcpClient; revision: string; controller: AbortController
  ownerSignal?: AbortSignal
  releaseAbort?: () => void
  diagnosticHistory?: Array<{ phase: string; time: string; error?: string }>
}

export class NativeMinecraftTestService {
  isBusy(): boolean { return Boolean(this.startup?.status === 'running' || this.session || this.stopping) }
  private startup?: { id: string; project: ProjectInfo; owner?: AbortSignal; fingerprint: string; controller: AbortController; status: 'running' | 'ready' | 'failed' | 'cancelled'; error?: string; result?: unknown; finished: Promise<void> }
  private session?: Session
  private lane = new SerialState()
  private stopping?: Promise<void>
  private starting?: AbortController
  constructor(private readonly dependencies: Dependencies) {}
  assertReadyForSignal(signal: AbortSignal): void {
    if (this.startup?.owner === signal && this.startup.status === 'running') throw new Error('玩家测试仍在准备；请用 modmind_test_session operation=state 等待 ready=true 后再结束任务')
  }
  async stopForSignal(signal: AbortSignal): Promise<void> {
    if (this.session?.ownerSignal === signal || this.startup?.owner === signal) await this.stop()
  }

  async projectChanged(projectPath?: string): Promise<void> {
    if ((this.session || this.startup) && (!projectPath || !sameProjectPath(projectPath, (this.session?.project ?? this.startup!.project).path))) await this.stop()
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    let resolve!: () => void; let reject!: (error: unknown) => void
    const pending = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    this.stopping = pending
    this.starting?.abort()
    this.startup?.controller.abort()
    this.session?.controller.abort()
    void this.lane.run(() => this.cleanup()).then(resolve, reject)
    void pending.finally(() => { if (this.stopping === pending) this.stopping = undefined }).catch(() => undefined)
    return pending
  }
  private async recordSession(session: Session, phase: string, error?: unknown): Promise<void> {
    const history = session.diagnosticHistory ??= []
    history.push({ phase, time: new Date().toISOString(), ...(error === undefined ? {} : { error: String(error).slice(0, 4_000) }) })
    if (history.length > 16) history.splice(0, history.length - 16)
    const data = { sessionId: session.id, projectPath: session.project.path, directory: session.directory, port: session.port,
      phase, time: new Date().toISOString(), cancelled: session.controller.signal.aborted, ownerAborted: session.ownerSignal?.aborted,
      runtime: session.runtime.getState(), history, error: error === undefined ? undefined : String(error).slice(0, 4_000) }
    diagnosticJournal.record({ subsystem: 'minecraft', operation: 'native-test-session', phase, message: 'Native test session: ' + phase, data, error })
    try {
      const parent = path.dirname(session.directory)
      await fs.mkdir(parent, { recursive: true })
      const temporary = path.join(parent, 'session-' + randomUUID() + '.tmp')
      await fs.writeFile(temporary, redactDiagnosticText(JSON.stringify(data, null, 2)), { flag: 'wx' })
      await fs.rename(temporary, path.join(parent, 'session.json'))
    } catch (failure) {
      diagnosticJournal.record({ subsystem: 'diagnostics', operation: 'native-session-evidence', phase: 'error', level: 'warning', message: 'Unable to save native test session evidence', error: failure })
    }
  }
  private async cleanup(): Promise<void> {
    const session = this.session
    if (!session) return
    // Retain ownership if stop fails, so cleanup can be retried.
    await this.recordSession(session, 'stopping')
    await session.runtime.stop()
    await this.recordSession(session, 'stopped')
    session.releaseAbort?.()
    this.session = undefined
  }
  execute(project: ProjectInfo, category: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!sameProjectPath(this.dependencies.currentProject()?.path ?? '', project.path)) return Promise.reject(new Error('玩家测试仅操作当前项目'))
    if (category === 'session' && input.operation === 'capabilities') return this.capabilities(project)
    if (category === 'session' && ['start', 'state'].includes(String(input.operation))) return this.startupRequest(project, input, signal)
    if (category === 'session' && input.operation === 'stop') {
      const current = this.session?.id ?? this.startup?.id
      if (input.sessionId && input.sessionId !== current) return Promise.reject(new Error('测试会话不匹配'))
      const stopping = this.stop()
      if (this.startup?.status === 'running') { void stopping.catch(() => undefined); return Promise.resolve({ sessionId: current, status: 'cancelling', stopped: false }) }
      return stopping.then(() => ({ sessionId: current, status: 'stopped', stopped: true }))
    }
    return this.lane.run(async () => {
      signal?.throwIfAborted()
      if (category === 'session' && input.operation === 'capabilities') {
        const entry = nativeMcpFor(project.minecraftVersion, project.loader)
        return { supported: Boolean(entry), supportTier: entry ? 'experimental' : 'unavailable', backend: 'minecraft-mod-mcp', release: entry?.release ?? nativeMcpRelease, modes: entry ? ['rendered'] : [], hiddenRendering: false, runtimeVerified: false,
          catalog: entry ? { minecraft: entry.minecraft, loader: entry.loader, sha256: entry.sha256 } : null,
          detail: '模组真实交互测试：启动独立客户端，读取原生截图、GUI、玩家及世界状态，执行点击/按键/视角/命令。启动后仍需验证具体操作；不支持的版本不替换为相近版本。' }
      }
      if (!sameProjectPath(this.dependencies.currentProject()?.path ?? '', project.path)) throw new Error('玩家测试仅操作当前项目')
      if (category === 'session' && input.operation === 'start') return this.start(project, input, signal)
      const session = this.session
      if (!session || !sameProjectPath(session.project.path, project.path) || (input.sessionId !== session.id && !(category === 'session' && input.operation === 'state' && !input.sessionId))) throw new Error('测试会话已过期，请先启动当前会话')
      if (category === 'session' && input.operation === 'state') return this.state(session)
      if (!session.client || !session.runtime.getState().running) throw new Error('测试客户端尚未就绪或已退出')
      const combined = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal
      if (category === 'capture') return { sessionId: session.id, nativeRendering: true, visualVerified: false, captures: [await session.client.capture(path.join(session.directory, 'screenshots'), combined)] }
      if (category === 'observe') {
        if (input.operation === 'logs') {
          const logPath = path.join(session.directory, 'logs', 'latest.log')
          const handle = await fs.open(logPath, 'r')
          let text: string
          try {
            const stat = await handle.stat(); const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024))
            const read = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length))
            text = buffer.subarray(0, read.bytesRead).toString('utf8')
          } finally { await handle.close() }
          return { sessionId: session.id, logPath, evidence: await new CreationFeedbackService(project).evidence(text, 'native-client-log') }
        }
        return { sessionId: session.id, observation: await this.observe(session, combined) }
      }
      if (category === 'action') return { sessionId: session.id, ...await this.action(session, input, combined), gameplayVerified: false }
      if (category === 'scenario') {
        const steps = input.steps
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('场景需要 1–20 步')
        // Validate the entire scenario before performing its first side effect.
        for (const step of steps) {
          if (!step || typeof step !== 'object' || !Array.isArray(step.expect) || !step.expect.length || step.expect.length > 10 || step.expect.some((x: unknown) => typeof x !== 'string' || !x || x.length > 500)) throw new Error('每步必须有明确的预期文本')
          nativeAction(step)
        }
        const results = []
        const feedback = new CreationFeedbackService(project)
        for (const step of steps) {
          const before = await this.observe(session, combined)
          const action = await this.action(session, { ...step, revision: before.revision }, combined)
          const observation = await this.observe(session, combined)
          const passed = step.expect.every((value: string) => observation.text.includes(value))
          const evidence = await feedback.evidence(JSON.stringify({ action, observation }), 'native-test-scenario')
          results.push({ action, observation, passed, evidenceId: evidence.id })
          await feedback.check({ stage: 'interaction', passed, detail: `步骤 ${results.length}：${step.operation}`, sessionId: session.id, evidenceId: evidence.id })
          if (!passed) return { sessionId: session.id, success: false, failedStep: results.length, results, visualVerified: false }
        }
        return { sessionId: session.id, success: true, results, visualVerified: false }
      }
      throw new Error('不支持的测试操作')
    })
  }
  private async capabilities(project: ProjectInfo) {
    const entry = nativeMcpFor(project.minecraftVersion, project.loader)
    return { supported: Boolean(entry), supportTier: entry ? 'experimental' : 'unavailable', backend: 'minecraft-mod-mcp', release: entry?.release ?? nativeMcpRelease, modes: entry ? ['rendered'] : [], hiddenRendering: false, runtimeVerified: false,
      catalog: entry ? { minecraft: entry.minecraft, loader: entry.loader, sha256: entry.sha256 } : null,
      detail: '启动返回 sessionId；查询 state，ready 后再操作。下载和构建在后台继续；stop 可取消准备阶段。' }
  }
  private async startupRequest(project: ProjectInfo, input: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const wait = input.waitSeconds ?? 0
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0 || wait > 20) throw new Error('waitSeconds 需要在 0–20 之间')
    if (input.operation === 'start') {
      if (this.stopping) throw new Error('测试正在停止，请等待停止完成')
      if (input.mode !== 'rendered' || input.hidden === true) throw new Error('模组 MCP 交互测试需要 rendered 可见客户端')
      if (!nativeMcpFor(project.minecraftVersion, project.loader)) throw new Error(`尚无匹配 ${project.minecraftVersion} / ${project.loader} 的 MCP 正式发布包`)
      if (input.maxMemoryMb !== undefined) number(input.maxMemoryMb, 'maxMemoryMb', 1024, 16384, true)
      if (input.readyTimeoutMs !== undefined) number(input.readyTimeoutMs, 'readyTimeoutMs', 30000, 900000, true)
      const { operation: _operation, waitSeconds: _wait, sessionId: _sessionId, ...parameters } = input
      const fingerprint = JSON.stringify([project.path, project.minecraftVersion, project.loader, parameters])
      if (this.startup && !this.startup.controller.signal.aborted && ['running', 'ready'].includes(this.startup.status)) {
        if (this.startup.owner !== signal || this.startup.fingerprint !== fingerprint) throw new Error('已有不同参数或其他会话拥有的测试任务，请查询或停止')
      } else {
        const task: NonNullable<NativeMinecraftTestService['startup']> = { id: randomUUID(), project: { ...project }, owner: signal, fingerprint, controller: new AbortController(), status: 'running', finished: Promise.resolve() }
        this.startup = task
        const combined = signal ? AbortSignal.any([signal, task.controller.signal]) : task.controller.signal
        // Register ownership and ID before any queued or network work.
        task.finished = this.lane.run(async () => {
          combined.throwIfAborted()
          task.result = await this.start(project, input, combined, task.id, signal)
          task.status = 'ready'
        }).catch(error => { task.status = combined.aborted ? 'cancelled' : 'failed'; task.error = String(error) })
      }
    }
    const task = this.startup
    if (!task || !sameProjectPath(task.project.path, project.path) || (input.sessionId && input.sessionId !== task.id)) throw new Error('测试会话已过期，请先启动当前会话')
    if (task.status === 'running' && wait) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([task.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, wait * 1000) })]) }
      finally { clearTimeout(timer) }
    }
    const exited = task.status === 'ready' && !task.controller.signal.aborted && !this.session?.runtime.getState().running
    return { ...(task.status === 'ready' ? task.result as object : {}), ...(this.session ? this.state(this.session) : {}), sessionId: task.id, taskId: task.id,
      status: task.controller.signal.aborted ? (this.stopping ? 'cancelling' : 'cancelled') : task.status,
      ...(exited ? { status: 'failed' } : {}),
      ready: task.status === 'ready' && !task.controller.signal.aborted && !exited && Boolean(this.session?.client),
      phase: this.session?.diagnosticHistory?.at(-1)?.phase ?? task.status, error: exited ? '测试客户端已退出，请停止会话后检查日志' : task.error,
      instruction: task.status === 'running' ? 'Poll modmind_test_session operation=state with this sessionId and waitSeconds<=20. Do not start again. Only ready=true permits interactions.' : undefined }
  }
  private state(session: Session) {
    return { sessionId: session.id, id: session.id, mode: 'rendered', backend: 'minecraft-mod-mcp', directory: session.directory,
      running: session.runtime.getState().running, ready: Boolean(session.client), hiddenRendering: false,
      supportTier: 'experimental', actionsVerified: false,
      capabilities: { screenshot: true, gui: true, key: true, inventory: true, command: true, look: true, click: true, text: true, scroll: true, interact: true, tooltip: false },
      visualVerified: false, gameplayVerified: false }
  }
  private async start(project: ProjectInfo, input: Record<string, unknown>, signal?: AbortSignal, taskId?: string, ownerSignal = signal) {
    if (this.session) throw new Error('已有测试会话，请先停止；不会重复启动')
    if (input.mode !== 'rendered' || input.hidden === true) throw new Error('模组 MCP 交互测试需要 rendered 可见客户端；无头检查请使用原有测试入口')
    const entry = nativeMcpFor(project.minecraftVersion, project.loader)
    if (!entry) throw new Error(`尚无匹配 ${project.minecraftVersion} / ${project.loader} 的 MCP 正式发布包；可继续使用启动检查和 GameTest`)
    const id = taskId ?? randomUUID()
    const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'player-tests', id, 'game')
    const controller = new AbortController()
    this.starting = controller
    let port: number
    try { port = await unusedLocalPort(); controller.signal.throwIfAborted(); signal?.throwIfAborted() }
    catch (error) { this.starting = undefined; throw error }
    const runtime = this.dependencies.createRuntime(project, directory, port)
    const session: Session = { id, project, directory, runtime, port, revision: '', controller, ownerSignal }
    this.session = session
    this.starting = undefined
    const onAbort = (): void => { controller.abort(); void this.stop().catch(() => undefined) }
    signal?.addEventListener('abort', onAbort, { once: true })
    session.releaseAbort = () => signal?.removeEventListener('abort', onAbort)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      combined.throwIfAborted()
      await this.recordSession(session, 'building')
      const artifact = await this.dependencies.build(project, combined)
      await this.recordSession(session, 'copying-instance')
      combined.throwIfAborted()
      const sourceInstance = project.kind === 'modpack' ? path.dirname(artifact.path) : path.dirname(path.dirname(artifact.path))
      await copyNativeTestInstance(sourceInstance, directory)
      await this.recordSession(session, 'installing-mcp')
      await (this.dependencies.install ?? installNativeMcp)(entry, path.join(directory, 'mods'), combined)
      // No user saves/options copied. Keep the owned instance responsive when focus moves to ModMind.
      await fs.writeFile(path.join(directory, 'options.txt'), 'pauseOnLostFocus:false\n')
      combined.throwIfAborted()
      await this.recordSession(session, 'launching')
      const defaultMemory = Math.max(1024, Math.min(4096, Math.floor(Math.min(os.totalmem() * 0.5, os.freemem() * 0.75) / (256 * 1024 ** 2)) * 256))
      const launched = await runtime.launch({ username: 'ModMindTest', maxMemoryMb: Number(input.maxMemoryMb ?? defaultMemory), width: 1280, height: 720 }, combined)
      if (launched.stage === 'error') throw new Error(launched.message)
      await this.recordSession(session, 'connecting-mcp')
      const deadline = Date.now() + Number(input.readyTimeoutMs ?? 300_000)
      let lastError = '尚未连接'
      while (Date.now() < deadline) {
        combined.throwIfAborted()
        const state: MinecraftRuntimeState = runtime.getState()
        if (state.stage === 'error' || state.stage === 'stopped') throw new Error(`测试客户端已退出：${state.message}`)
        if (state.pid && state.running) {
          const client = new NativeMinecraftMcpClient(port, state.pid, () => runtime.getState().running && runtime.getState().pid === state.pid)
          try {
            await client.verify(combined)
            const control = await client.command('enter_control_mode', {}, combined)
            if (control.control_mode !== true) throw new Error('MCP 控制模式未就绪')
            session.client = client
            await this.recordSession(session, 'ready')
            return { ...this.state(session), observation: await this.observe(session, combined) }
          } catch (error) {
            lastError = String(error)
            if (/身份不匹配/.test(lastError)) throw error
          }
        }
        await delay(300, undefined, { signal: combined })
      }
      throw new Error(`Minecraft MCP 未就绪：${lastError}`)
    } catch (error) {
      await this.recordSession(session, combined.aborted ? 'cancelled' : 'failed', error)
      await new CreationFeedbackService(project).evidence(String(error), 'native-client-failure').catch(() => undefined)
      await this.cleanup()
      throw error
    }
  }
  private async observe(session: Session, signal: AbortSignal) {
    const screen = await session.client!.command('get_screen_buttons', {}, signal)
    const player = await session.client!.command('get_player_info', {}, signal)
    const world = await session.client!.command('get_world_info', {}, signal)
    const revision = createHash('sha256').update(JSON.stringify(screen)).digest('hex')
    session.revision = revision
    const warnings = Array.isArray(screen.buttons) && screen.buttons.length === 0
      ? ['上游未返回 GUI 按钮；可能是当前界面没有按钮，也可能是版本映射未解析。请读取真实截图并使用坐标操作，不能猜测按钮索引。'] : []
    return { revision, screen, player, world, warnings, text: JSON.stringify({ screen, player, world }), acknowledged: true }
  }
  private async action(session: Session, input: Record<string, unknown>, signal: AbortSignal) {
    const request = nativeAction(input)
    if (['click', 'text', 'scroll'].includes(String(input.operation))) {
      if (!input.revision || input.revision !== session.revision) throw new Error('界面观测已过期，请重新观察')
      const fresh = await session.client!.command('get_screen_buttons', {}, signal)
      if (createHash('sha256').update(JSON.stringify(fresh)).digest('hex') !== session.revision) { session.revision = ''; throw new Error('界面已改变，请重新观察') }
    }
    session.revision = ''
    const result = await session.client!.command(request.command, request.params, signal)
    if (typeof result.result === 'string' && /^(no player|no world|not |cannot|could not)/i.test(result.result)) throw new Error(`Minecraft MCP：${result.result}`)
    return { acknowledged: true, result, text: JSON.stringify(result) }
  }
}

function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${name} 必须在 ${min}–${max} 范围内`)
  return value
}
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error('操作文字无效')
  return value
}
export function nativeAction(input: Record<string, unknown>): { command: string; params: Record<string, unknown> } {
  switch (input.operation) {
    case 'click':
      if (input.x !== undefined || input.y !== undefined) return { command: 'click', params: { x: number(input.x, 'x', 0, 16384, true), y: number(input.y, 'y', 0, 16384, true), button: ['left', 'right', 'middle'][number(input.button ?? 0, 'button', 0, 2, true)] } }
      if (input.button !== undefined && input.button !== 0) throw new Error('按钮索引只支持左键；右键请使用截图坐标')
      return { command: 'click_button_index', params: { index: number(input.slot, 'slot', 0, 10000, true) } }
    case 'text': return { command: 'type_text', params: { text: text(input.text), press_enter: input.pressEnter === true } }
    case 'command': return { command: 'execute_command', params: { command: '/' + text(input.command).replace(/^\//, '') } }
    case 'key': {
      const key = text(input.key, 80)
      if (!/^(?:key\.keyboard\.)?[a-z0-9_. -]+$/i.test(key)) throw new Error('按键名称无效')
      return { command: 'press_key', params: { key: key.startsWith('key.keyboard.') ? key : `key.keyboard.${key.toLowerCase()}`, hold_seconds: number(input.durationMs ?? 80, 'durationMs', 1, 2000, true) / 1000 } }
    }
    case 'inventory': return { command: 'press_key', params: { key: 'key.keyboard.e', hold_seconds: 0.08 } }
    case 'close': return { command: 'close_screen', params: {} }
    case 'look': return { command: 'set_view_angle', params: { yaw: number(input.yaw, 'yaw', -180, 180), pitch: number(input.pitch, 'pitch', -90, 90) } }
    case 'scroll': return { command: 'scroll', params: { clicks: number(input.clicks, 'clicks', -20, 20, true) } }
    case 'interact': return { command: 'right_click', params: {} }
    default: throw new Error('不支持的模组玩家操作')
  }
}

export async function copyNativeTestInstance(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  const metadata = path.join(source, 'runtime.json')
  if (await fs.lstat(metadata).then(stat => stat.isFile() && !stat.isSymbolicLink()).catch(() => false)) await fs.copyFile(metadata, path.join(destination, 'runtime.json'))
  for (const name of ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'kubejs', 'scripts']) {
    const from = path.join(source, name)
    const stat = await fs.lstat(from).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
    await fs.cp(from, path.join(destination, name), { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() })
  }
}
async function unusedLocalPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配测试端口')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
