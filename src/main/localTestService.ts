import type { ProjectInfo } from '../shared/types'
import type { LocalServerState, LocalTestOptions, LocalTestState, MinecraftRuntimeEvent, MinecraftRuntimeState } from '../shared/minecraft'
import type { LocalServerManager } from './localServerService'
import type { MinecraftRuntimeManager } from './minecraftRuntime'

type Client = Pick<MinecraftRuntimeManager, 'prepare' | 'syncModpack' | 'launch' | 'stop'>
interface Dependencies {
  project: () => ProjectInfo
  server: LocalServerManager
  createClient: (project: ProjectInfo, onState: (state: MinecraftRuntimeState) => void, onEvent: (event: MinecraftRuntimeEvent) => void) => Promise<Client>
  onState: (state: LocalTestState) => void
}

export class LocalTestService {
  private state: LocalTestState = { stage: 'idle', active: false, message: '尚未开始测试', recentLogs: [] }
  private controller?: AbortController
  private pending?: Promise<LocalTestState>
  private stopping?: Promise<LocalTestState>
  private client?: Client
  private serverId?: string

  constructor(private readonly dependencies: Dependencies) {}

  getState(): LocalTestState { return structuredClone(this.state) }
  isBusy(): boolean { return this.state.active || Boolean(this.pending || this.stopping) }

  serverChanged(state: LocalServerState): void {
    if (this.state.active && this.serverId === state.sessionId && !this.pending && !this.stopping && !state.running) {
      this.update({ stage: 'error', message: `服务端已停止：${state.message}` })
    }
  }

  start(options: LocalTestOptions): Promise<LocalTestState> {
    if (this.isBusy() || this.dependencies.server.isBusy()) return Promise.reject(new Error('请先停止当前测试或服务端'))
    if (!options || typeof options.username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(options.username) || !Number.isInteger(options.maxMemoryMb) || options.maxMemoryMb < 1024 || options.maxMemoryMb > 16384) {
      return Promise.reject(new Error('玩家名需要 3-16 个字母、数字或下划线，内存需要在 1024-16384 MB 之间'))
    }
    const project = this.dependencies.project()
    if (!['modpack', 'server-plugin'].includes(project.kind ?? '') || project.loader === 'velocity') {
      return Promise.reject(new Error('一键测试需要整合包或世界服插件项目；Velocity 请使用单独启动服务端并配置后端世界服'))
    }
    this.controller = new AbortController()
    this.update({ projectPath: project.path, active: true, stage: 'preparing', message: '正在准备服务端与客户端', client: undefined, recentLogs: [] })
    const pending = this.startInternal(project, options, this.controller.signal)
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined }).catch(() => undefined)
    return pending
  }

  private async startInternal(project: ProjectInfo, options: LocalTestOptions, signal: AbortSignal): Promise<LocalTestState> {
    const server = this.dependencies.server
    try {
      this.client = await this.dependencies.createClient(project, state => {
        if (this.controller?.signal !== signal) return
        this.update({ client: state })
        if (!signal.aborted && state.stage === 'error') this.update({ stage: 'error', message: state.message })
        else if (!signal.aborted && state.running) this.update({ stage: 'running', message: '客户端运行中' })
        else if (!signal.aborted && state.stage === 'stopped') this.update({ stage: 'stopped', message: '客户端已退出，服务端仍在运行' })
      }, event => {
        if (this.controller?.signal === signal) this.update({ recentLogs: [...this.state.recentLogs, { time: event.time, message: event.message, level: event.level }].slice(-300) })
      })
      signal.throwIfAborted()
      if (server.isBusy()) throw new Error('服务端已被另一项操作占用，请先停止后重试')
      const started = server.start({ port: options.port, acceptEula: true, onlineMode: false, localPlayerTest: true }, async serverSignal => {
        const combined = AbortSignal.any([signal, serverSignal])
        combined.throwIfAborted()
        this.update({ message: '正在准备客户端' })
        await this.client!.prepare(combined)
        combined.throwIfAborted()
        if (project.kind === 'modpack') await this.client!.syncModpack()
        combined.throwIfAborted()
        this.update({ stage: 'starting-server', message: '两端已准备，正在启动服务端' })
      })
      this.serverId = server.getState().sessionId
      const ready = await started
      signal.throwIfAborted()
      if (!ready.running || !ready.port) throw new Error('服务端尚未就绪，未启动客户端')
      this.update({ stage: 'launching-client', message: '服务端已就绪，正在启动客户端' })
      const launched = await this.client.launch({ ...options, width: 1280, height: 720, server: { ip: '127.0.0.1', port: ready.port } }, signal)
      signal.throwIfAborted()
      if (launched.stage === 'error') throw new Error(launched.message)
      return this.getState()
    } catch (error) {
      try { await this.cleanup() }
      catch (cleanupError) {
        this.update({ stage: 'error', message: `测试停止失败：${String(cleanupError)}` })
        throw cleanupError
      }
      this.update({ active: false, stage: signal.aborted ? 'stopped' : 'error', message: signal.aborted ? '测试已取消' : error instanceof Error ? error.message : String(error) })
      if (!signal.aborted) throw error
      return this.getState()
    }
  }

  stop(): Promise<LocalTestState> {
    if (this.stopping) return this.stopping
    if (!this.isBusy()) return Promise.resolve(this.getState())
    this.controller?.abort()
    this.update({ stage: 'stopping', message: '正在停止测试' })
    const request = this.stopInternal().catch(error => {
      this.update({ stage: 'error', message: `测试停止失败：${String(error)}` })
      throw error
    })
    this.stopping = request
    void request.finally(() => { this.stopping = undefined }).catch(() => undefined)
    return request
  }

  private async stopInternal(): Promise<LocalTestState> {
    // Stop the server first during preparation to abort its downloads/build and the preparation hook.
    if (this.pending && this.ownsServer()) await this.dependencies.server.stop()
    await this.pending?.catch(() => undefined)
    await this.cleanup()
    this.update({ active: false, stage: 'stopped', message: '测试已停止' })
    return this.getState()
  }

  private ownsServer(): boolean { return Boolean(this.serverId && this.dependencies.server.getState().sessionId === this.serverId) }

  private async cleanup(): Promise<void> {
    try { await this.client?.stop() }
    finally { if (this.ownsServer()) await this.dependencies.server.stop() }
    this.client = undefined
    this.serverId = undefined
  }

  private update(patch: Partial<LocalTestState>): void {
    this.state = { ...this.state, ...patch }
    this.dependencies.onState(this.getState())
  }
}
