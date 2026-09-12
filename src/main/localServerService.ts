import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectInfo } from '../shared/types'
import type { LocalServerEvent, LocalServerOperationProgress, LocalServerState } from '../shared/minecraft'
import { buildServerPack, installServerRuntime, readExistingServerPack } from './serverPackService'
import { ServerProcess, type ServerProcessOptions } from './serverVerificationService'
import type { ServerScenarioStep, ServerScenarioResult } from './serverVerificationService'
import { configureLocalServer, deployServerInstance, preserveLegacyServerInstance } from './serverInstance'
import { preparePluginServer } from './serverCoreService'
import { throwIfAborted } from './asyncControl'

export interface LocalServerStartOptions {
  port?: number
  acceptEula?: boolean
  onlineMode?: boolean
}

export interface LocalServerManagerOptions {
  getProject: () => ProjectInfo | null
  getJavaPath: (project?: ProjectInfo, major?: number) => Promise<string>
  cacheDirectory?: string
  buildPlugin?: (project: ProjectInfo, signal: AbortSignal) => Promise<unknown>
  onState: (state: LocalServerState) => void
  onEvent: (event: LocalServerEvent) => void
}

function dataDirectory(_project: ProjectInfo): '.modmind' {
  return '.modmind'
}

function validPort(value: number | undefined): number {
  const port = Number.isInteger(value) ? value! : 25565
  if (port < 1024 || port > 65535) throw new Error('本机服务端端口需要在 1024-65535 之间')
  return port
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class LocalServerManager {
  private readonly getProject: LocalServerManagerOptions['getProject']
  private readonly getJavaPath: LocalServerManagerOptions['getJavaPath']
  private readonly onState: LocalServerManagerOptions['onState']
  private readonly onEvent: LocalServerManagerOptions['onEvent']
  private process: ServerProcess | null = null
  private startPromise: Promise<LocalServerState> | null = null
  private lastProgressUpdateAt = 0
  private controller: AbortController | null = null
  private verificationController: AbortController | null = null
  private readonly options: LocalServerManagerOptions
  private state: LocalServerState = {
    stage: 'idle',
    minecraftVersion: '',
    running: false,
    recentLogs: [],
    message: '本机服务端尚未启动'
  }

  constructor(options: LocalServerManagerOptions) {
    this.options = options
    this.getProject = options.getProject
    this.getJavaPath = options.getJavaPath
    this.onState = options.onState
    this.onEvent = options.onEvent
  }

  getState(): LocalServerState {
    return {
      ...this.state,
      recentLogs: this.state.recentLogs.map((entry) => ({ ...entry })),
      operationProgress: this.state.operationProgress ? { ...this.state.operationProgress } : undefined
    }
  }

  isRunning(): boolean { return Boolean(this.process?.isRunning()) }
  isBusy(): boolean { return Boolean(this.startPromise || this.verificationController || this.process?.isRunning() || this.state.stage === 'stopping') }

  async verify<T>(options: LocalServerStartOptions, action: (state: LocalServerState, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.verificationController || this.startPromise) throw new Error('服务端正在执行另一项操作')
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const startedHere = !this.isRunning()
    this.verificationController = controller
    const abort = (): void => { this.controller?.abort() }
    combined.addEventListener('abort', abort, { once: true })
    try {
      throwIfAborted(combined)
      const state = startedHere ? await this.start(options) : this.getState()
      throwIfAborted(combined)
      this.update({ canCancel: true, message: '正在运行服务端验证' })
      return await action(state, combined)
    } finally {
      combined.removeEventListener('abort', abort)
      this.verificationController = null
      this.update({ canCancel: false })
      if (startedHere) await this.stop()
    }
  }

  async runScenario(steps: ServerScenarioStep[], signal?: AbortSignal): Promise<ServerScenarioResult> {
    if (!this.process?.isRunning()) throw new Error('请先启动本机服务端')
    return this.process.runScenario(steps, signal)
  }

  recordOperation(message: string, level: LocalServerEvent['level'] = 'info', logPath?: string): void {
    if (logPath) this.state = { ...this.state, logPath }
    this.capture(message, level)
  }

  setOperationProgress(progress: LocalServerOperationProgress): void {
    const fraction = progress.fraction === undefined ? undefined : Math.min(Math.max(progress.fraction, 0), 1)
    const next = { ...progress, fraction }
    const previous = this.state.operationProgress
    const now = Date.now()
    const messageChanged = previous?.message !== next.message
    const fractionChanged = Math.abs((previous?.fraction ?? -1) - (next.fraction ?? -1)) >= 0.01
    if (!messageChanged && !fractionChanged && now - this.lastProgressUpdateAt < 120) return
    this.lastProgressUpdateAt = now
    this.update({ operationProgress: next })
  }

  clearOperationProgress(): void {
    if (!this.state.operationProgress) return
    this.lastProgressUpdateAt = 0
    this.update({ operationProgress: undefined })
  }

  async start(options: LocalServerStartOptions = {}): Promise<LocalServerState> {
    if (this.startPromise) return this.startPromise
    this.controller = new AbortController()
    const pending = this.startInternal(options, this.controller.signal)
    this.startPromise = pending
    try {
      return await pending
    } finally {
      if (this.startPromise === pending) this.startPromise = null
    }
  }

  private async startInternal(options: LocalServerStartOptions, signal: AbortSignal): Promise<LocalServerState> {
    const project = this.requireProject()
    if (this.process?.isRunning()) throw new Error('本机服务端已经在运行')
    let port = validPort(options.port)
    const root = path.join(project.path, dataDirectory(project), 'server-pack')
    this.update({ projectPath: project.path, sessionId: randomUUID(), canCancel: true, address: undefined, stage: 'preparing', running: false, minecraftVersion: project.minecraftVersion, loader: project.loader, loaderVersion: project.loaderVersion, port, pid: undefined, logPath: undefined, operationProgress: undefined, message: '正在准备本机服务端', recentLogs: [] })
    try {
      let pack: ServerProcessOptions['pack']
      let runtime: ServerProcessOptions['runtime']
      if (project.kind === 'server-plugin') {
        await this.options.buildPlugin?.(project, signal)
        throwIfAborted(signal)
        const prepared = await preparePluginServer(project, { javaPath: major => this.getJavaPath(project, major), cacheDirectory: this.options.cacheDirectory ?? path.join(project.path, '.modmind/server/cache'), signal, onProgress: (message, fraction) => this.setOperationProgress({ message, fraction }), onDownloadProgress: ({ downloaded, total, source }) => this.setOperationProgress({ message: `正在下载 ${source.label}`, downloaded, total, fraction: total ? downloaded / total : undefined }) })
        pack = prepared.pack; runtime = prepared.runtime; port = prepared.profile.port
      } else {
        await preserveLegacyServerInstance(project.path, root)
        const built = await readExistingServerPack(project, root) ?? await buildServerPack(project, { outputDirectory: root, port, acceptEula: options.acceptEula === true, onlineMode: options.onlineMode === true })
        throwIfAborted(signal)
        const instanceRoot = path.join(project.path, '.modmind/server/instances/modpack')
        const deployment = await deployServerInstance(built.root, instanceRoot, signal)
        if (deployment.conflicts.length) this.capture(`保留本地配置：${deployment.conflicts.join(', ')}`, 'warning')
        pack = { ...built, root: instanceRoot, manifestPath: path.join(instanceRoot, 'modmind.server.json') }
        await configureLocalServer(pack.root, port, options.onlineMode === true, options.acceptEula === true)
        this.update({ stage: 'installing', message: '正在准备匹配版本的服务端运行时' })
        const javaPath = await this.getJavaPath(project)
        throwIfAborted(signal)
        runtime = await installServerRuntime({ serverPack: pack, javaPath, signal, onDownloadProgress: ({ downloaded, total, source }) => this.setOperationProgress({ message: `正在下载 ${source.label}`, downloaded, total, fraction: total ? downloaded / total : undefined }) }, project)
      }
      throwIfAborted(signal)
      this.update({ stage: 'starting', message: '正在启动本机服务端' })
      const server = new ServerProcess()
      this.process = server
      const processOptions: ServerProcessOptions = {
        pack,
        runtime,
        port,
        signal,
        stopCommand: project.loader === 'velocity' ? 'shutdown' : 'stop',
        onEvent: (event) => this.capture(event.message, event.level),
        onExit: (code, signal) => {
          if (this.process !== server || this.state.stage === 'stopping') return
          this.process = null
          const message = code === 0 ? '本机服务端已停止' : `本机服务端已退出（代码 ${code ?? '未知'}${signal ? `，信号 ${signal}` : ''}）`
          this.update({ stage: code === 0 ? 'stopped' : 'error', running: false, pid: undefined, message })
          this.emit({ stage: code === 0 ? 'stopped' : 'error', message, level: code === 0 ? 'info' : 'error' })
        }
      }
      const started = await server.start(processOptions)
      this.update({ canCancel: false, operationProgress: undefined, port, stage: 'running', running: true, address: started.address, logPath: started.logPath, pid: server.pid, message: '本机服务端运行中；业务场景尚未验证' })
      this.emit({ stage: 'running', message: `服务端已就绪：${started.address}` })
      return this.getState()
    } catch (error) {
      await this.process?.stop(1_000)
      this.process = null
      const message = signal.aborted ? '本机服务端启动已取消' : `本机服务端启动失败：${describeError(error)}`
      this.update({ canCancel: false, operationProgress: undefined, stage: signal.aborted ? 'stopped' : 'error', running: false, pid: undefined, message })
      this.emit({ stage: 'error', message, level: 'error' })
      throw error
    }
  }

  async stop(): Promise<LocalServerState> {
    this.verificationController?.abort()
    if (this.startPromise) {
      this.controller?.abort()
      this.update({ stage: 'stopping', canCancel: false, message: '正在取消服务端准备' })
      await this.startPromise.catch(() => undefined)
    }
    const server = this.process
    if (!server) {
      if (this.state.stage !== 'idle') this.update({ stage: 'stopped', running: false, pid: undefined, message: '本机服务端已停止' })
      return this.getState()
    }
    this.update({ stage: 'stopping', message: '正在停止本机服务端' })
    await server.stop()
    this.process = null
    this.update({ stage: 'stopped', running: false, pid: undefined, message: '本机服务端已停止' })
    this.emit({ stage: 'stopped', message: '本机服务端已停止' })
    return this.getState()
  }

  async restart(options: LocalServerStartOptions = {}): Promise<LocalServerState> {
    await this.stop()
    return this.start(options)
  }

  async sendCommand(command: string): Promise<LocalServerState> {
    if (!this.process?.isRunning()) throw new Error('请先启动本机服务端')
    this.process.sendCommand(command)
    this.emit({ stage: 'running', message: `已发送命令：${command.trim()}` })
    return this.getState()
  }

  async destroy(): Promise<void> {
    await this.stop().catch(() => undefined)
  }

  private requireProject(): ProjectInfo {
    const project = this.getProject()
    if (!project || !['modpack', 'server-plugin'].includes(project.kind ?? '')) throw new Error('本机服务端需要整合包或服务端插件项目')
    if (project.kind === 'modpack' && !['fabric', 'quilt', 'forge', 'neoforge'].includes(project.loader)) throw new Error('当前整合包 Loader 不支持本机服务端')
    return project
  }

  private update(patch: Partial<LocalServerState>): void {
    this.state = {
      ...this.state,
      ...patch,
      recentLogs: patch.recentLogs ? patch.recentLogs.map((entry) => ({ ...entry })) : this.state.recentLogs,
      operationProgress: patch.operationProgress ? { ...patch.operationProgress } : patch.operationProgress === undefined && 'operationProgress' in patch ? undefined : this.state.operationProgress
    }
    this.onState(this.getState())
  }

  private capture(message: string, level: LocalServerEvent['level'] = 'info'): void {
    const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (!lines.length) return
    const time = new Date().toISOString()
    const recentLogs = [...this.state.recentLogs, ...lines.map((message) => ({ message, time, level }))].slice(-240)
    this.update({ recentLogs })
    for (const line of lines.slice(-8)) this.emit({ stage: this.state.stage, message: line, level })
  }

  private emit(event: Omit<LocalServerEvent, 'time'>): void {
    this.onEvent({ ...event, time: new Date().toISOString() })
  }
}
