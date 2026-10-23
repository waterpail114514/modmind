import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Transform } from 'node:stream'
import { launch } from '@xmcl/core'
import type { ChildProcess } from 'node:child_process'
import { spawnManaged, terminateProcessTree } from '../../../../src/main/processTree'
import { managedJavaEnvironment } from '../../../../src/main/javaEnvironment'
import { sameProjectPath } from '../../../../src/main/projectPath'
import type { ProjectInfo, DetectedJavaHome } from '../../../../src/shared/types'
import type { ShaderRuntimeCapabilities, ShaderRuntimeSession } from '../../../../src/shared/shaderStudio'
import { assertShaderProject, hash, safeFile } from './shaderFiles'
import { exportShader } from './shaderExportService'
import { readRuntimeBinding, shaderInstalledVersion, installedShaderMods, shaderModClosure, shaderRuntimeCapabilities } from './shaderRuntimeEnvironment'
import { ShaderSessionAgentClient, shaderSessionAgentJar } from './shaderSessionAgentClient'

export interface ShaderSessionDependencies {
  currentProject: () => ProjectInfo | null
  bindingDirectory: string
  javaHomes: () => Promise<DetectedJavaHome[]>
  launch?: typeof launch
  client?: (port: number, pid: number, id: string, secret: string, alive: () => boolean) => ShaderSessionAgentClient
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  terminate?: typeof terminateProcessTree
}
interface Session {
  project: ProjectInfo
  state: ShaderRuntimeSession
  controller: AbortController
  child?: ChildProcess
  client?: ShaderSessionAgentClient
  task?: Promise<void>
  preparation?: Promise<void>
  stopping?: Promise<void>
  lane: Promise<unknown>
  releaseOwner?: () => void
  lease?: NodeJS.Timeout
  owner?: AbortSignal
}
const active = (session: Session) => ['preparing', 'launching', 'ready', 'stopping'].includes(session.state.status) || Boolean(session.child?.pid && session.child.exitCode === null && session.child.signalCode === null)

export class ShaderSessionService {
  private session?: Session
  constructor(private readonly dependencies: ShaderSessionDependencies) {}
  isBusy(): boolean { return Boolean(this.session && active(this.session)) }
  async capabilities(project: ProjectInfo): Promise<ShaderRuntimeCapabilities> {
    this.current(project)
    return shaderRuntimeCapabilities(project, await readRuntimeBinding(this.dependencies.bindingDirectory, project), this.dependencies.javaHomes)
  }
  private current(project: ProjectInfo): void {
    assertShaderProject(project)
    const current = this.dependencies.currentProject()
    if (!current || !sameProjectPath(current.path, project.path) || current.minecraftVersion !== project.minecraftVersion) throw new Error('光影测试仅支持当前项目与目标版本')
  }
  state(project: ProjectInfo, sessionId?: string): ShaderRuntimeSession | null {
    this.current(project)
    const session = this.session
    if (!session) { if (sessionId) throw new Error('光影测试会话已过期'); return null }
    if (!sameProjectPath(session.project.path, project.path) || sessionId && sessionId !== session.state.sessionId) throw new Error('光影测试会话已过期')
    session.state.running = Boolean(session.child?.pid && session.child.exitCode === null && session.child.signalCode === null)
    return structuredClone(session.state)
  }
  start(project: ProjectInfo, versionId: string, owner?: AbortSignal): ShaderRuntimeSession {
    this.current(project); owner?.throwIfAborted()
    if (this.isBusy()) throw new Error('已有光影测试会话，请先停止')
    const id = randomUUID(), now = Date.now()
    const session: Session = { project, controller: new AbortController(), lane: Promise.resolve(), owner,
      state: { sessionId: id, taskId: id, status: 'preparing', message: '正在核对本地环境', directory: path.join(project.path, '.modmind', 'shader-sessions', id, 'game'), versionId,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 20 * 60000).toISOString(), logTail: '', gameVerified: false, running: false } }
    this.session = session
    const abort = () => { void this.stopOwned(session).catch(error => this.message(session, 'failed', String(error))) }
    owner?.addEventListener('abort', abort, { once: true }); session.releaseOwner = () => owner?.removeEventListener('abort', abort)
    session.lease = setTimeout(abort, 20 * 60000); session.lease.unref()
    session.preparation = this.prepare(session)
    session.task = session.preparation.catch(async error => {
      const message = (error as Error).message, cancelled = session.controller.signal.aborted
      await this.stopOwned(session).catch(() => undefined)
      this.message(session, cancelled ? 'stopped' : 'failed', cancelled ? '测试已取消' : message)
    })
    return structuredClone(session.state)
  }
  private message(session: Session, status: ShaderRuntimeSession['status'], message: string): void { session.state.status = status; session.state.message = message }
  private async prepare(session: Session): Promise<void> {
    const signal = session.controller.signal, project = session.project
    const binding = await readRuntimeBinding(this.dependencies.bindingDirectory, project)
    const capabilities = await shaderRuntimeCapabilities(project, binding, this.dependencies.javaHomes)
    signal.throwIfAborted(); this.current(project)
    if (!capabilities.ready || !binding?.runtimeRoot || !capabilities.java) throw new Error(capabilities.issues.join('；'))
    if (!capabilities.versions.some(version => version.id === session.state.versionId)) throw new Error('所选运行库已变化，请重新检查环境')
    const version = await shaderInstalledVersion(binding.runtimeRoot, session.state.versionId)
    const mods = shaderModClosure(await installedShaderMods(binding.instancePath))
    signal.throwIfAborted()
    const relative = `.modmind/shader-sessions/${session.state.sessionId}/game`
    session.state.directory = await safeFile(project.path, relative, true)
    await fs.mkdir(await safeFile(project.path, `${relative}/mods`, true), { recursive: true })
    await fs.mkdir(await safeFile(project.path, `${relative}/config`, true), { recursive: true })
    await fs.mkdir(await safeFile(project.path, `${relative}/shaderpacks`, true), { recursive: true })
    for (const mod of mods) {
      const data = await fs.readFile(mod.file)
      if (hash(data) !== mod.sha256) throw new Error('准备期间 Iris 依赖发生变化，请重试')
      await fs.writeFile(await safeFile(project.path, `${relative}/mods/${mod.id}.jar`, true), data, { flag: 'wx' })
    }
    await this.stageArtifact(session)
    const agent = await safeFile(project.path, `${relative}/session-agent.jar`, true), configuration = await safeFile(project.path, `${relative}/session.properties`, true)
    await fs.writeFile(agent, shaderSessionAgentJar(), { flag: 'wx' })
    const port = await unusedPort(), secret = randomBytes(32).toString('hex')
    await fs.writeFile(configuration, `sessionId=${session.state.sessionId}\nport=${port}\n`, { flag: 'wx' })
    await fs.writeFile(await safeFile(project.path, `${relative}/options.txt`, true), 'pauseOnLostFocus:false\nenableVsync:false\nmaxFps:120\nrenderDistance:8\nsimulationDistance:5\nsoundCategory_master:0.0\n')
    signal.throwIfAborted(); this.current(project)
    const currentBinding = await readRuntimeBinding(this.dependencies.bindingDirectory, project)
    if (JSON.stringify(currentBinding) !== JSON.stringify(binding)) throw new Error('运行库绑定已变化，请重试')
    this.message(session, 'launching', '正在启动独立 Iris 测试实例')
    const log = createWriteStream(await safeFile(project.path, `${relative}/launcher-console.log`, true))
    try {
      const child = await (this.dependencies.launch ?? launch)({ version, resourcePath: binding.runtimeRoot, gamePath: session.state.directory,
        javaPath: path.join(capabilities.java.home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
        nativeRoot: await safeFile(project.path, `${relative}/natives`, true), gameProfile: { name: 'ShaderTest', id: '61d2fabecabe40009ead000000000001' }, accessToken: '0', userType: 'legacy',
        launcherName: 'ModMind', launcherBrand: 'ModMind', minMemory: 512, maxMemory: 2048, resolution: { width: 1280, height: 720 },
        extraJVMArgs: [`-javaagent:${agent}=${configuration}`, '--enable-native-access=ALL-UNNAMED'],
        extraExecOption: { cwd: session.state.directory, windowsHide: true },
        spawn: (command, args, options) => { signal.throwIfAborted(); return spawnManaged(command, [...(args ?? [])], { ...options, windowsHide: true, env: { ...managedJavaEnvironment(options?.env ?? process.env), MODMIND_SHADER_SESSION_TOKEN: secret } }) }
      })
      session.child = child; session.state.pid = child.pid
      let recorded = 0
      const boundedLog = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        const remaining = 4 * 1024 * 1024 - recorded
        if (remaining > 0) { const bytes = chunk.subarray(0, remaining); recorded += bytes.length; callback(null, bytes) }
        else callback()
      } })
      boundedLog.pipe(log)
      child.stdout?.pipe(boundedLog, { end: false }); child.stderr?.pipe(boundedLog, { end: false })
      log.on('error', error => { this.message(session, 'failed', `会话日志写入失败：${error.message}`); void this.stopOwned(session).catch(() => undefined) })
      const append = (bytes: Buffer) => { session.state.logTail = (session.state.logTail + bytes.toString('utf8')).slice(-16384) }
      child.stdout?.on('data', append); child.stderr?.on('data', append)
      child.once('error', error => { boundedLog.end(); this.message(session, 'failed', error.message) })
      child.once('close', code => {
        boundedLog.end(); session.state.running = false; this.release(session)
        session.state.shutdown ??= code === 0 ? 'graceful' : 'exited'
        if (session.state.status !== 'failed') this.message(session, code === 0 ? 'stopped' : 'failed', code === 0 ? '测试进程已退出' : `测试进程退出，代码 ${code}`)
      })
      if (!child.pid) await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      session.state.pid = child.pid
      const alive = () => child.exitCode === null && child.signalCode === null
      session.client = (this.dependencies.client ?? ((...args) => new ShaderSessionAgentClient(...args)))(port, child.pid!, session.state.sessionId, secret, alive)
      const deadline = Date.now() + (this.dependencies.startupTimeoutMs ?? 120000)
      let reason = '客户端尚未就绪'
      while (Date.now() < deadline) {
        signal.throwIfAborted(); this.current(project)
        if (!alive()) throw new Error('Iris 测试进程已退出，请查看会话日志')
        try {
          session.state.observation = await session.client.observe('state', signal)
          signal.throwIfAborted(); this.message(session, 'ready', '测试实例已就绪；进入测试世界后可重载并检查管线')
          return
        } catch (error) { reason = (error as Error).message; if (/身份不匹配/.test(reason)) throw error }
        await delay(300, undefined, { signal })
      }
      throw new Error(`Iris 测试实例未就绪：${reason}`)
    } catch (error) { if (!session.child) log.end(); throw error }
  }
  private async stageArtifact(session: Session): Promise<void> {
    session.controller.signal.throwIfAborted()
    const artifact = await exportShader(session.project, true), name = `shader-${artifact.sha256.slice(0, 24)}.zip`
    const prefix = `.modmind/shader-sessions/${session.state.sessionId}/game`
    const file = await safeFile(session.project.path, `${prefix}/shaderpacks/${name}`, true), data = await fs.readFile(artifact.path)
    if (hash(data) !== artifact.sha256) throw new Error('光影包在复制前发生变化')
    const existing = await fs.stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (existing) {
      if (!existing.isFile() || existing.size !== data.length || hash(await fs.readFile(file)) !== artifact.sha256) throw new Error('独立实例中的同名光影包发生变化，请停止会话后重试')
    } else await fs.writeFile(file, data, { flag: 'wx' })
    if (hash(await fs.readFile(file)) !== artifact.sha256) throw new Error('独立实例光影包校验失败')
    await fs.writeFile(await safeFile(session.project.path, `${prefix}/config/iris.properties`, true), `enableShaders=true\nshaderPack=${name}\ndisableUpdateMessage=true\n`)
    session.state.artifact = { name, revision: artifact.revision, sha256: artifact.sha256 }
  }
  async observe(project: ProjectInfo, id: string, reload = false, signal?: AbortSignal): Promise<ShaderRuntimeSession> {
    this.state(project, id); const session = this.session!
    const task = session.lane.catch(() => undefined).then(async () => {
      this.state(project, id)
      if (session.project.minecraftVersion !== project.minecraftVersion) throw new Error('项目目标版本已变化，请先停止此会话')
      if (session.state.status !== 'ready' || !session.client) throw new Error('测试会话尚未就绪或已退出')
      const combined = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal
      combined.throwIfAborted()
      if (reload) await this.stageArtifact(session)
      combined.throwIfAborted()
      session.state.observation = await session.client.observe(reload ? 'reload' : 'state', combined)
      this.current(project)
      const observation = session.state.observation
      session.state.message = observation.pipelineError ? `Iris 管线错误：${observation.pipelineError}` : observation.packName !== session.state.artifact?.name ? '实际选中的包与当前部署不一致' : observation.pipeline?.includes('IrisRenderingPipeline') ? '当前包已进入 Iris 渲染管线；画质尚未验收' : 'Iris 已读取包；进入世界后检查渲染管线'
      return this.state(project, id)!
    })
    session.lane = task
    return task
  }
  async stop(project: ProjectInfo, id: string): Promise<ShaderRuntimeSession> {
    this.state(project, id); const session = this.session!
    await this.stopOwned(session)
    return structuredClone(session.state)
  }
  private stopOwned(session: Session): Promise<void> {
    if (session.stopping) return session.stopping
    session.controller.abort()
    session.stopping = (async () => {
      // Preparation may still be spawning a child; keep ownership until that step settles.
      this.message(session, 'stopping', '正在停止本次测试')
      await session.preparation?.catch(() => undefined)
      await session.lane.catch(() => undefined)
      const child = session.child
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) { session.state.shutdown ??= 'not-started' }
      else {
        await session.client?.stop().catch(() => undefined)
        const deadline = Date.now() + (this.dependencies.shutdownTimeoutMs ?? 15000)
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
        if (child.exitCode === null && child.signalCode === null) {
          await (this.dependencies.terminate ?? terminateProcessTree)(child)
          session.state.shutdown = 'forced'
          const closed = Date.now() + 5000
          while (child.exitCode === null && child.signalCode === null && Date.now() < closed) await delay(50)
        } else session.state.shutdown = 'graceful'
        if (child.exitCode === null && child.signalCode === null) throw new Error('未确认所属测试进程退出，请重试停止')
      }
      this.release(session)
      session.state.running = false
      this.message(session, 'stopped', session.state.shutdown === 'forced' ? '测试无响应，已清理本次创建的进程' : '测试已停止')
    })().catch(error => { session.stopping = undefined; this.message(session, 'failed', (error as Error).message); throw error })
    return session.stopping
  }
  private release(session: Session) { if (session.lease) clearTimeout(session.lease); session.releaseOwner?.() }
  async projectChanged(projectPath: string | null): Promise<void> { if (this.session && (!projectPath || !sameProjectPath(projectPath, this.session.project.path))) await this.stopOwned(this.session) }
  async dispose(): Promise<void> { if (this.session) await this.stopOwned(this.session) }
  async stopForSignal(signal: AbortSignal): Promise<void> { if (this.session?.owner === signal) await this.stopOwned(this.session) }
}
async function unusedPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('本地端口分配失败')); return } server.close(error => error ? reject(error) : resolve(address.port)) }) })
}
