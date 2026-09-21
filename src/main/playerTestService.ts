import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { LocalServerManager } from './localServerService'
import type { HeadlessMcService } from './headlessMcService'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import { CreationFeedbackService } from './creationFeedbackService'
import { TestClientSession } from './testClientSession'
import { SerialState } from './liveConfiguration'
import { specificsFor, installTestSpecifics } from './testSpecifics'
import { sameProjectPath } from './projectPath'
import type { NativeMinecraftTestService } from './nativeMinecraftTestService'

export class PlayerTestService {
  private session?: { id: string; project: ProjectInfo; username: string; directory: string; mode: 'headless' | 'rendered'; joined: boolean; serverOwned: boolean; operatorBefore?: boolean; serverRoot?: string; operatorChanged?: boolean; serverId?: string; buildId?: string }
  private client = new TestClientSession()
  private lane = new SerialState()
  private controller?: AbortController
  private stopping?: Promise<void>
  async stopNativeForSignal(signal: AbortSignal): Promise<void> { await this.dependencies.native?.stopForSignal(signal) }
  async projectChanged(projectPath?: string): Promise<void> {
    await this.dependencies.native?.projectChanged(projectPath)
    if (this.session && (!projectPath || !sameProjectPath(projectPath, this.session.project.path))) await this.stop()
  }
  constructor(private dependencies: { server: () => LocalServerManager; headless: () => HeadlessMcService; currentProject: () => ProjectInfo | null; javaPreferences: () => Promise<import('../shared/types').AgentSettings['javaPreferences']>; onEvent?: (event: import('../shared/minecraft').MinecraftRuntimeEvent) => void; native?: NativeMinecraftTestService }) {}
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.controller?.abort()
    const nativeStop = this.dependencies.native?.stop().then(() => undefined, error => error as Error)
    const request = this.lane.run(async () => { const failure = await nativeStop; await this.cleanup(); if (failure) throw failure })
    this.stopping = request
    try { await request } finally { this.stopping = undefined }
  }
  private async cleanup(): Promise<void> {
    await this.client.stop()
    const session = this.session
    if (!session) return
    const logs = this.client.logs()
    await new CreationFeedbackService(session.project).evidence(logs.lines.join('\n'), 'test-client-stop').catch(() => undefined)
    const server = this.dependencies.server()
    if (server.getState().sessionId === session.serverId) {
      try {
        if (session.operatorChanged && server.isRunning() && session.serverRoot) await setTestOperator(server, session.serverRoot, session.username, session.operatorBefore === true)
      } finally {
        if (session.serverOwned) await server.stop()
      }
    }
    this.session = undefined
  }
  execute(project: ProjectInfo, category: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if ((project.kind ?? 'mod') === 'mod' && this.dependencies.native) return this.dependencies.native.execute(project, category, input, signal)
    if (category === 'session' && input.operation === 'stop') {
      if (this.session && (!sameProjectPath(this.session.project.path, project.path) || input.sessionId !== this.session.id)) return Promise.reject(new Error('测试会话不匹配'))
      return this.stop().then(() => ({ stopped: true }))
    }
    return this.lane.run(async () => {
      signal?.throwIfAborted()
      if (category === 'session' && input.operation === 'capabilities') {
        const entry = specificsFor(project.minecraftVersion, project.kind === 'server-plugin' ? 'fabric' : project.loader)
        return { modes: ['headless', 'rendered'], hiddenRendering: false,
          supported: Boolean(entry && project.loader !== 'velocity' && ['server-plugin', 'modpack'].includes(project.kind ?? '')),
          catalog: entry ? { ...entry, url: undefined } : null, runtimeVerified: false,
          detail: '先检查 catalog，再启动探测。1.20.1 无按键/背包/tooltip。渲染模式显示窗口；隐藏真实渲染未验证。Java Mod 保留已有客户端/GameTest路径；自动多人测试需含目标 Mod 的测试整合包。' }
      }
      if (!sameProjectPath(this.dependencies.currentProject()?.path ?? '', project.path)) throw new Error('玩家测试仅操作当前项目')
      if (category === 'session' && input.operation === 'start') return this.start(project, input, signal)
      if (category === 'session' && input.operation === 'state' && this.session && !input.sessionId) input.sessionId = this.session.id
      const session = this.session
      if (!session || !sameProjectPath(session.project.path, project.path) || session.id !== input.sessionId) throw new Error('测试会话已过期，请先读取或启动当前会话')
      const server = this.dependencies.server()
      if (category === 'session' && input.operation === 'state') return { ...session, project: undefined, running: this.client.isRunning(), capabilities: this.client.capabilities() }
      if (server.getState().sessionId !== session.serverId || !server.isRunning()) throw new Error('测试服已更换或停止，请重新启动测试会话')
      const combined = signal && this.controller ? AbortSignal.any([signal, this.controller.signal]) : signal ?? this.controller?.signal
      const feedback = new CreationFeedbackService(project)
      if (category === 'observe') {
        const logs = this.client.logs(typeof input.after === 'number' ? input.after : 0)
        const observation = input.operation === 'logs' ? undefined : await this.client.observe(combined, typeof input.tooltip === 'number' ? input.tooltip : undefined)
        const evidence = await feedback.evidence(logs.lines.join('\n'), 'test-client')
        return { sessionId: session.id, observation, logs: { cursor: logs.cursor, truncated: logs.truncated, summary: evidence.prompt, evidenceId: evidence.id } }
      }
      if (category === 'capture') {
        const capture = await this.client.capture(combined)
        return { sessionId: session.id, nativeRendering: true, captures: [capture], visualVerified: false }
      }
      if (category === 'action' && input.operation === 'operator') {
        if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须为布尔值')
        session.operatorChanged = true
        await setTestOperator(server, session.serverRoot!, session.username, input.enabled, combined)
        return { sessionId: session.id, commandSent: true, operatorRequested: input.enabled, gameplayVerified: false }
      }
      if (category === 'action') return { sessionId: session.id, ...await this.client.action(input, combined), gameplayVerified: false }
      if (category === 'scenario') {
        const steps = input.steps
        if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new Error('场景需要 1–20 步')
        const results: unknown[] = []
        for (const entry of steps) {
          combined?.throwIfAborted()
          if (!entry || typeof entry !== 'object') throw new Error('场景步骤无效')
          const step = entry as Record<string, unknown>
          if (!Array.isArray(step.expect) || !step.expect.length || step.expect.length > 10 || step.expect.some(x => typeof x !== 'string' || !x || x.length > 500)) throw new Error('每步必须有明确的预期文本')
          if (!step || typeof step !== 'object' || step.operation === 'operator') throw new Error('场景步骤无效')
          const before = await this.client.observe(combined)
          const serverLogPath = server.getState().logPath
          const serverOffset = serverLogPath ? await fs.stat(serverLogPath).then(stat => stat.size).catch(() => 0) : 0
          const action = await this.client.action({ ...step, revision: before.revision }, combined)
          const observation = await this.client.observe(combined)
          const serverText = serverLogPath ? await readLogAfter(serverLogPath, serverOffset) : ''
          const text = `${action.text}\n${observation.text}\n${serverText}`
          const passed = action.acknowledged && observation.acknowledged && step.expect.every(value => `${action.text}\n${observation.text}`.includes(String(value))) && !/Exception|\bERROR\b/.test(text)
          const evidence = await feedback.evidence(text, 'test-scenario')
          results.push({ action, observation, passed, evidenceId: evidence.id })
          await feedback.check({ stage: 'interaction', passed, detail: `步骤 ${results.length}：${step.operation}`, sessionId: session.id, buildId: session.buildId, evidenceId: evidence.id })
          if (!passed) return { sessionId: session.id, success: false, failedStep: results.length, results }
        }
        return { sessionId: session.id, success: true, results, visualVerified: false }
      }
      throw new Error('不支持的测试操作')
    })
  }
  private async start(project: ProjectInfo, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.session) throw new Error(`测试会话 ${this.session.id} 尚未结束，请先停止；不会重复启动`)
    if (!['server-plugin', 'modpack'].includes(project.kind ?? '')) throw new Error('玩家测试需要服务端插件或整合包测试服')
    if (project.loader === 'velocity') throw new Error('Velocity 需要配置后端世界服，暂不自动创建代理拓扑')
    if (input.mode !== 'headless' && input.mode !== 'rendered') throw new Error('mode 必须是 headless 或 rendered')
    if (input.hidden === true) throw new Error('当前尚未验证后台真实渲染；请使用 headless 逻辑测试或 rendered 可见客户端')
    const id = randomUUID(); const username = input.offline === true ? `ModMind_${id.slice(0, 6)}` : String(input.username ?? '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('正版测试需要提供已登录账号的玩家名')
    const entry = specificsFor(project.minecraftVersion, project.kind === 'server-plugin' ? 'fabric' : project.loader)
    if (!entry) throw new Error('未收录可校验的控制插件组合；不会拿相近版本代替')
    const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'player-tests', id)
    this.controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    const abort = (): void => { this.controller?.abort() }
    signal?.addEventListener('abort', abort, { once: true })
    const server = this.dependencies.server()
    this.session = { id, project, username, directory, mode: input.mode, joined: false, serverOwned: !server.isRunning() }
    try {
      await fs.mkdir(directory, { recursive: true })
      const clientProject: ProjectInfo = project.kind === 'server-plugin'
        ? { ...project, kind: 'modpack', loader: 'fabric', loaderVersion: undefined, apiVersion: undefined, path: directory, toolDataDirectory: '.modmind' }
        : { ...project, path: directory, toolDataDirectory: '.modmind' }
      const runtime = new MinecraftRuntimeManager({ getProject: () => clientProject, onState: () => undefined, onEvent: event => this.dependencies.onEvent?.(event), getJavaPreference: this.dependencies.javaPreferences })
      const prepared = await runtime.prepare(combined)
      if (!prepared.javaPath || !prepared.loaderVersionId) throw new Error('测试客户端运行时未准备好')
      const game = path.join(directory, 'game'); const mods = path.join(game, 'mods')
      await fs.mkdir(mods, { recursive: true })
      if (project.kind === 'modpack') {
        const source = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'minecraft', 'mods')
        await copyTestInstance(path.dirname(source), game)
      }
      await installTestSpecifics(entry, mods, combined)
      const prior = server.getState()
      combined.throwIfAborted()
      const cancelServerStart = (): void => { if (this.session?.serverOwned) void server.stop().catch(() => undefined) }
      combined.addEventListener('abort', cancelServerStart, { once: true })
      let state: ReturnType<LocalServerManager['getState']>
      try { state = prior.running ? prior : await server.start({ acceptEula: input.acceptEula === true, onlineMode: input.offline !== true }) }
      finally { combined.removeEventListener('abort', cancelServerStart) }
      this.session.serverId = state.sessionId
      combined.throwIfAborted()
      this.session.buildId = !prior.running && project.kind === 'server-plugin' ? (await new CreationFeedbackService(project).state()).builds.at(-1)?.id : undefined
      if (!state.logPath || !state.port) throw new Error('测试服缺少身份或日志信息')
      const serverRoot = path.dirname(path.dirname(state.logPath))
      const properties = await fs.readFile(path.join(serverRoot, 'server.properties'), 'utf8')
      if (input.offline === true && !/^online-mode=false\s*$/m.test(properties)) throw new Error('当前测试服开启正版验证，不能使用离线测试角色')
      const ops = await fs.readFile(path.join(serverRoot, 'ops.json'), 'utf8').then(text => JSON.parse(text) as Array<{ name: string }>).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      this.session.operatorBefore = ops.some(op => op.name.toLowerCase() === username.toLowerCase())
      this.session.serverRoot = serverRoot
      const logBefore = (await fs.stat(state.logPath)).size
      await this.client.start({ javaPath: prepared.javaPath, launcherPath: await this.dependencies.headless().ensureLauncher(combined), profile: prepared.loaderVersionId, minecraftRoot: runtime.managedMinecraftDirectory(), gameDirectory: game, mode: input.mode, username, offline: input.offline === true, inventorySupported: entry.inventory, keysSupported: entry.key }, combined)
      await this.client.connect(state.port, combined)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        combined?.throwIfAborted()
        const handle = await fs.open(state.logPath, 'r')
        let text = ''
        try { const buffer = Buffer.alloc(256 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, logBefore); text = buffer.subarray(0, bytesRead).toString('utf8') } finally { await handle.close() }
        if (new RegExp(`${username}.*(?:joined the game|logged in with entity id)`).test(text)) { this.session.joined = true; break }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!this.session.joined) throw new Error('未在服务端确认指定测试角色加入；正在连接不算进服成功。正版模式需要明确匹配登录身份。')
      await new CreationFeedbackService(project).check({ stage: 'joined', passed: true, detail: `${username} 加入本机测试服`, sessionId: id, buildId: this.session.buildId })
      return { ...this.session, project: undefined, capabilities: this.client.capabilities(), hiddenRendering: false }
    } catch (error) {
      const logs = this.client.logs()
      await new CreationFeedbackService(project).evidence(`${String(error)}\n${logs.lines.join('\n')}`, 'test-client-failure').catch(() => undefined)
      await this.cleanup()
      throw error
    }
    finally { signal?.removeEventListener('abort', abort) }
  }
}

async function copyTestInstance(source: string, target: string): Promise<void> {
  const files = await fs.readdir(source, { withFileTypes: true }).catch(() => { throw new Error('请先同步整合包客户端实例') })
  if (!files.some(file => file.name === 'modmind-pack-sync.json')) throw new Error('缺少整合包同步凭据，请先同步客户端')
  for (const file of files) {
    if (file.isSymbolicLink() || ['saves', 'logs', 'screenshots', 'crash-reports', 'runtime.json', 'session.lock', 'servers.dat'].includes(file.name)) continue
    const from = path.join(source, file.name)
    await fs.cp(from, path.join(target, file.name), { recursive: true, filter: async input => !(await fs.lstat(input)).isSymbolicLink() })
  }
}
export async function setTestOperator(server: LocalServerManager, root: string, username: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  await server.sendCommand(`${enabled ? 'op' : 'deop'} ${username}`)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const ops = await fs.readFile(path.join(root, 'ops.json'), 'utf8').then(text => JSON.parse(text) as Array<{ name: string }>).catch(() => null)
    if (ops && ops.some(op => op.name.toLowerCase() === username.toLowerCase()) === enabled) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('未确认测试账号权限更新，权限恢复状态需要检查')
}

async function readLogAfter(file: string, offset: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}
