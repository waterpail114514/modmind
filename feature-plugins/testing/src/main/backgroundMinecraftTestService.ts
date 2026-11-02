import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { MinecraftManagedMod } from '../../../../src/shared/minecraft'
import { isJavaLoader } from '../../../../src/shared/projectPlatform'
import { validateGameTestInput } from '../../../../src/shared/gameControl'
import { OwnedTestPreparation } from '../../../../src/main/ownedTestPreparation'
import { sameProjectPath } from '../../../../src/main/projectPath'
import { SerialState } from '../../../../src/main/liveConfiguration'
import { diagnosticJournal } from '../../../../src/main/diagnosticLog'
import { copyNativeTestInstance } from './nativeMinecraftTestService'
import { GameControlActions } from './gameControlActions'
import { gameDirectoryForLaunch } from './minecraftLaunchPreferences'
import type { MinecraftRuntimeManager } from './minecraftRuntime'
import type { LocalServerManager } from './localServerService'

type Runtime = Pick<MinecraftRuntimeManager, 'getState' | 'launch' | 'stop' | 'getBackgroundGameControl'>
interface Dependencies {
  currentProject: () => ProjectInfo | null
  build: (project: ProjectInfo, signal?: AbortSignal) => Promise<MinecraftManagedMod>
  createRuntime: (project: ProjectInfo, directory: string, vanilla: boolean) => Runtime
  server?: () => LocalServerManager
  launch?: (operation: () => Promise<unknown>) => Promise<unknown>
}
interface Session {
  id: string; project: ProjectInfo; directory: string; runtime: Runtime; controller: AbortController; owner?: AbortSignal
  actions?: GameControlActions; releaseAbort?: () => void; heartbeat?: ReturnType<typeof setInterval>; serverOwned?: boolean; serverId?: string; phase: string
}
export class BackgroundMinecraftTestService {
  private preparation = new OwnedTestPreparation()
  private lane = new SerialState()
  private session?: Session
  private stopping?: Promise<void>
  constructor(private readonly dependencies: Dependencies) {}
  isBusy() { return Boolean(this.preparation.running || this.session || this.stopping) }
  hasSession(id?: unknown): boolean { return Boolean((this.session || this.preparation.id) && (!id || id === (this.session?.id ?? this.preparation.id))) }
  assertReadyForSignal(signal: AbortSignal) { this.preparation.assertReadyForSignal(signal) }
  async stopForSignal(signal: AbortSignal) { if (this.session?.owner === signal || this.preparation.owns(signal)) await this.stop() }
  async projectChanged(projectPath?: string) { if (this.hasSession() && !this.preparation.belongsTo(projectPath)) await this.stop() }
  private supported(project: ProjectInfo) { return isJavaLoader(project.loader) || project.kind === 'server-plugin' && ['paper', 'spigot', 'folia'].includes(project.loader) }
  async execute(project: ProjectInfo, category: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!sameProjectPath(this.dependencies.currentProject()?.path ?? '', project.path)) throw new Error('后台游戏控制仅操作当前项目')
    validateGameTestInput(category, input)
    if (category === 'session' && input.operation === 'capabilities') return { supported: this.supported(project), backend: 'background-agent', modes: this.supported(project) ? ['rendered'] : [], backgroundInput: true, hiddenRendering: false, requiresControlMod: false, supportTier: 'experimental', runtimeVerified: false,
      capabilities: { screenshot: true, key: true, mouse: true, text: true, scroll: true, drag: true, combo: true, batch: true, takeover: true, semanticGui: false, semanticWorld: false },
      detail: '按真实画面操作。后台输入不抢前台；全版本/Loader逐项运行验收另行完成。最小化、隐藏、锁屏不保证持续渲染。' }
    if (category === 'session' && ['start', 'state'].includes(String(input.operation))) {
      if (input.operation === 'start') {
        if (!this.supported(project)) throw new Error('后台桥支持 Java 客户端；当前平台没有对应的受管游戏客户端')
        if (this.stopping) throw new Error('后台测试正在停止，请等待完成')
        if (input.mode !== 'rendered') throw new Error('后台桥需要 rendered 模式')
        if (input.hidden === true) throw new Error('后台操作不需要隐藏窗口；隐藏/最小化渲染尚未验收')
        for (const [name, min, max] of [['maxMemoryMb', 1024, 16384], ['width', 640, 3840], ['height', 360, 2160], ['readyTimeoutMs', 30000, 900000]] as const) if (input[name] !== undefined && (typeof input[name] !== 'number' || !Number.isInteger(input[name]) || input[name] < min || input[name] > max)) throw new Error(`${name} 需在 ${min}–${max} 之间`)
        if (input.withoutProjectMod !== undefined && typeof input.withoutProjectMod !== 'boolean') throw new Error('withoutProjectMod 无效')
        if (input.withoutProjectMod === true && project.kind === 'modpack') throw new Error('整合包测试需要保留已同步的内容')
        if (input.username !== undefined && (typeof input.username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(input.username))) throw new Error('离线测试角色名需要 3–16 个字母、数字或下划线')
      }
      const result = await this.preparation.invoke(project, input, signal,
        (id, preparationSignal) => this.lane.run(() => this.start(project, input, id, preparationSignal, signal)), () => this.snapshot())
      if (this.session?.actions) { const current = await this.state(signal); return { ...result, ...current, status: result.status, ready: result.ready && current.ready } }
      return result
    }
    if (category === 'session' && input.operation === 'stop') {
      if (input.sessionId && !this.hasSession(input.sessionId)) throw new Error('测试会话已过期')
      const preparing = this.preparation.running, stopping = this.stop()
      if (preparing) { void stopping.catch(() => undefined); return { sessionId: this.preparation.id, status: 'cancelling', stopped: false } }
      await stopping; return { status: 'stopped', stopped: true }
    }
    const session = this.require(project, input.sessionId)
    const combined = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal
    if (!session.actions || !session.runtime.getState().running) throw new Error('后台客户端尚未就绪或已退出')
    if (category === 'session') {
      const owners = { pause: 'paused', resume: 'ai', takeover: 'human' } as const
      const owner = owners[input.operation as keyof typeof owners]
      if (!owner) throw new Error('不支持的后台会话操作')
      const state = await session.actions.ownership(owner); return { ...this.snapshot(), ...state, sessionId: session.id }
    }
    if (category === 'capture') return { sessionId: session.id, backend: 'background-agent', nativeRendering: true, visualVerified: false, captures: [await session.actions.capture(combined)] }
    if (category === 'action') return { sessionId: session.id, ...await session.actions.action(input, combined) }
    if (category === 'observe') {
      if (input.operation === 'result') return { sessionId: session.id, ...session.actions.result(input.requestId) }
      if (input.operation === 'logs') return this.logs(session, input.after)
      return { sessionId: session.id, observation: await this.state(combined), semanticGui: false, instruction: 'Use test_capture to inspect the actual screen.' }
    }
    if (category === 'scenario') throw new Error('后台桥不生成游戏语义断言；请使用 test_action 的 batch，再读取真实截图判断')
    throw new Error('不支持的后台控制类别')
  }
  private require(project: ProjectInfo, id: unknown): Session {
    const session = this.session
    if (!session || !sameProjectPath(session.project.path, project.path) || id !== session.id) throw new Error('测试会话已过期，请读取当前会话')
    return session
  }
  private snapshot() {
    const session = this.session
    return { sessionId: session?.id, mode: 'rendered', backend: 'background-agent', running: session?.runtime.getState().running ?? false, phase: session?.phase ?? 'preparing', supportTier: 'experimental', hiddenRendering: false, backgroundInput: true, visualVerified: false, gameplayVerified: false, currentAction: session?.actions?.active() }
  }
  private async state(signal?: AbortSignal) { const state = await this.session!.runtime.getBackgroundGameControl().status(signal); return { ...state, ...this.snapshot(), ownership: state.ownership } }
  private async phase(session: Session, phase: string) {
    session.phase = phase
    diagnosticJournal.record({ subsystem: 'minecraft', operation: 'background-session', phase, message: 'Background game session: ' + phase, data: { sessionId: session.id, projectPath: session.project.path, runtime: session.runtime.getState() } })
  }
  private async start(project: ProjectInfo, input: Record<string, unknown>, id: string, signal: AbortSignal, owner?: AbortSignal): Promise<object> {
    if (this.session) throw new Error('已有后台游戏会话，请先停止')
    const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'player-tests', id, 'game')
    const vanilla = project.kind === 'server-plugin'
    const runtime = this.dependencies.createRuntime(project, directory, vanilla)
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const launchDirectory = gameDirectoryForLaunch(directory, !vanilla && input.withoutProjectMod === true)
    const session: Session = { id, project: { ...project }, directory: launchDirectory, runtime, controller, owner, phase: 'preparing' }
    this.session = session
    const abort = () => { controller.abort(); void this.stop().catch(() => undefined) }
    owner?.addEventListener('abort', abort, { once: true }); session.releaseAbort = () => owner?.removeEventListener('abort', abort)
    try {
      await fs.mkdir(directory, { recursive: true })
      if (!vanilla && input.withoutProjectMod !== true) {
        await this.phase(session, 'building')
        const artifact = await this.dependencies.build(project, combined)
        const source = project.kind === 'modpack' ? path.dirname(artifact.path) : path.dirname(path.dirname(artifact.path))
        await copyNativeTestInstance(source, directory)
        if (project.kind === 'modpack') await fs.copyFile(path.join(source, 'modmind-pack-sync.json'), path.join(directory, 'modmind-pack-sync.json'))
      }
      combined.throwIfAborted()
      // Only owned settings; physical user keybindings, saves and options are not copied.
      await fs.mkdir(launchDirectory, { recursive: true })
      await fs.writeFile(path.join(launchDirectory, 'options.txt'), 'pauseOnLostFocus:false\nnarrator:0\nguiScale:2\n')
      let serverAddress: { ip: string; port: number } | undefined
      if (vanilla) {
        if (!this.dependencies.server) throw new Error('本机测试服不可用')
        const server = this.dependencies.server(); session.serverOwned = !server.isRunning()
        const cancelStart = () => { if (session.serverOwned) void server.stop().catch(() => undefined) }
        combined.addEventListener('abort', cancelStart, { once: true })
        let state: ReturnType<LocalServerManager['getState']>
        try { state = session.serverOwned ? await server.start({ acceptEula: input.acceptEula === true, onlineMode: false, localPlayerTest: true }) : server.getState() }
        finally { combined.removeEventListener('abort', cancelStart) }
        combined.throwIfAborted()
        session.serverId = state.sessionId
        if (!state.port || !state.running) throw new Error('测试服未就绪')
        serverAddress = { ip: '127.0.0.1', port: state.port }
      }
      const defaultMemory = Math.max(1024, Math.min(4096, Math.floor(Math.min(os.totalmem() * 0.5, os.freemem() * 0.75) / (256 * 1024 ** 2)) * 256))
      await this.phase(session, 'launching')
      const launch = () => runtime.launch({ username: String(input.username ?? 'ModMindTest'), maxMemoryMb: Number(input.maxMemoryMb ?? defaultMemory), width: Number(input.width ?? 1280), height: Number(input.height ?? 720), withoutProjectMod: !vanilla && input.withoutProjectMod === true, backgroundControl: true, server: serverAddress }, combined)
      if (this.dependencies.launch) await this.dependencies.launch(launch); else await launch()
      await this.phase(session, 'connecting')
      const bridge = runtime.getBackgroundGameControl()
      await bridge.waitUntilReady(combined, Number(input.readyTimeoutMs ?? 300_000))
      bridge.assertProject(project.path)
      session.actions = new GameControlActions(bridge, path.dirname(directory))
      session.heartbeat = setInterval(() => { if (!controller.signal.aborted) void bridge.status().catch(() => undefined) }, 2000); session.heartbeat.unref()
      await this.phase(session, 'ready')
      return this.snapshot()
    } catch (error) { await this.phase(session, combined.aborted ? 'cancelled' : 'failed'); await this.cleanup(); throw error }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.preparation.cancel(); this.session?.controller.abort()
    void this.session?.actions?.cancel().catch(() => undefined)
    const request = this.lane.run(() => this.cleanup()); this.stopping = request
    void request.finally(() => { if (this.stopping === request) this.stopping = undefined }).catch(() => undefined)
    return request
  }
  private async cleanup(): Promise<void> {
    const session = this.session; if (!session) return
    if (session.heartbeat) clearInterval(session.heartbeat)
    await session.actions?.cancel().catch(() => undefined)
    await session.runtime.stop()
    if (session.serverOwned && this.dependencies.server) { const server = this.dependencies.server(); if (server.getState().sessionId === session.serverId) await server.stop() }
    session.releaseAbort?.(); this.session = undefined
  }
  private async logs(session: Session, after: unknown) {
    if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)) throw new Error('日志游标无效')
    const file = path.join(session.directory, 'logs', 'latest.log')
    const handle = await fs.open(file, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return fs.open(path.join(session.directory, 'launcher-console.log'), 'r')
    })
    try { const stat = await handle.stat(); const start = Math.max(0, Math.min(Number(after ?? 0), stat.size), stat.size - 65536); const bytes = Buffer.alloc(Math.min(65536, stat.size - start)); const read = await handle.read(bytes, 0, bytes.length, start); return { sessionId: session.id, logs: { text: bytes.subarray(0, read.bytesRead).toString('utf8'), cursor: start + read.bytesRead, truncated: start > Number(after ?? 0) } } }
    finally { await handle.close() }
  }
}
