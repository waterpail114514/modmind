import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import type { ProjectInfo } from '../shared/types'
import type { IsolatedServerResult, IsolatedServerStep, IsolatedServerTask, ServerFixtureInput } from '../shared/serverScenario'
import { ServerFixtureService, fixtureVersionMatches } from './serverFixtureService'
import { ServerProcess } from './serverVerificationService'
import { installServerRuntime, type ServerPackResult } from './serverPackService'
import { configureLocalServer } from './serverInstance'
import { sameProjectPath } from './projectPath'

interface TaskRecord { project: ProjectInfo; state: IsolatedServerTask; controller: AbortController; finished: Promise<void>; server?: ServerProcess }
interface Options {
  fixtures: ServerFixtureService
  java: (project: ProjectInfo, signal: AbortSignal) => Promise<{ path: string; version: string }>
  install?: typeof installServerRuntime
  createProcess?: () => ServerProcess
}
const finishedStatuses = new Set(['completed', 'failed', 'cancelled'])
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
async function ownedRoot(project: ProjectInfo, create = true): Promise<string> {
  const root = await fs.realpath(project.path)
  let directory = root
  for (const part of ['.modmind', 'server', 'scenarios']) {
    directory = path.join(directory, part)
    if (create) await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('隔离测试目录不得包含符号链接')
  }
  return directory
}
function validateSteps(value: unknown): IsolatedServerStep[] {
  if (!Array.isArray(value) || !value.length || value.length > 40) throw new Error('场景需要 1–40 个步骤')
  return value.map((step, index) => {
    if (!step || typeof step !== 'object') throw new Error(`第 ${index + 1} 步无效`)
    const operation = step.operation ?? 'command'
    if (operation !== 'command' && operation !== 'restart') throw new Error('不支持的场景操作')
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1000 || step.timeoutMs > 120000)) throw new Error('步骤超时需要在 1000–120000 毫秒之间')
    if (operation === 'restart') return { operation } as IsolatedServerStep
    if (typeof step.command !== 'string' || !step.command.trim() || step.command.length > 1000 || /[\r\n]/.test(step.command)) throw new Error(`第 ${index + 1} 步命令无效`)
    if (!Array.isArray(step.expect) || !step.expect.length || step.expect.length > 20 || step.expect.some((entry: unknown) => typeof entry !== 'string' || !entry.trim() || entry.length > 500)) throw new Error(`第 ${index + 1} 步需要 1–20 条日志断言`)
    return { operation, command: step.command.trim(), expect: [...step.expect], timeoutMs: step.timeoutMs }
  })
}
async function unusedPort(): Promise<number> {
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)) })
  })
}

export class IsolatedServerScenarioService {
  private readonly tasks = new Map<string, TaskRecord>()
  constructor(private readonly options: Options) {}
  isBusy(): boolean { return [...this.tasks.values()].some(task => task.state.status === 'running' || task.server) }

  start(project: ProjectInfo, input: Record<string, unknown>, ownerSignal?: AbortSignal): IsolatedServerTask {
    if (project.kind !== 'modpack') throw new Error('隔离服务端场景需要整合包项目')
    if (input.acceptEula !== true) throw new Error('启动隔离测试前需要接受 Minecraft EULA')
    if (input.onlineMode === true) throw new Error('隔离场景仅支持本机离线测试')
    if (input.outputDirectory !== undefined) throw new Error('隔离运行目录由宿主管理，不能指定输出目录')
    const fixture = input.fixture as ServerFixtureInput
    if (!fixture || !['fabric', 'quilt', 'forge', 'neoforge'].includes(fixture.loader) || !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(fixture.minecraftVersion) || !/^[0-9][0-9A-Za-z.+_-]{0,79}$/.test(fixture.loaderVersion)) throw new Error('需要固定 Minecraft、Loader 和 Loader 版本')
    const steps = validateSteps(input.steps)
    if (input.port !== undefined && (!Number.isInteger(input.port) || Number(input.port) < 1024 || Number(input.port) > 65535)) throw new Error('测试端口需要在 1024–65535 之间')
    const timeoutMs = input.timeoutMs ?? 600000
    if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 30000 || Number(timeoutMs) > 1800000) throw new Error('总超时需要在 30 秒至 30 分钟之间')
    ownerSignal?.throwIfAborted()
    if (this.isBusy()) throw new Error('已有隔离服务端测试正在运行，请查询或取消该任务')
    while (this.tasks.size >= 32) {
      const expired = [...this.tasks.values()].find(task => finishedStatuses.has(task.state.status))
      if (!expired) throw new Error('隔离任务数量超过上限')
      this.tasks.delete(expired.state.taskId)
    }
    const taskId = randomUUID()
    const controller = new AbortController()
    const state: IsolatedServerTask = { taskId, projectPath: project.path, status: 'running', phase: 'validating', message: '正在校验测试输入', completed: 0, total: steps.length, canCancel: true, recentLogs: [] }
    const task: TaskRecord = { project: { ...project }, state, controller, finished: Promise.resolve() }
    this.tasks.set(taskId, task)
    const abort = (): void => controller.abort(ownerSignal?.reason)
    ownerSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('隔离场景超过总时间限制')), Number(timeoutMs))
    task.finished = this.run(task, structuredClone(fixture), steps, input.port as number | undefined)
      .finally(() => { clearTimeout(timer); ownerSignal?.removeEventListener('abort', abort) })
    return structuredClone(state)
  }

  async read(project: ProjectInfo, taskId?: string, waitSeconds = 0): Promise<IsolatedServerTask | null> {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 20) throw new Error('waitSeconds 需要在 0–20 之间')
    const task = taskId ? this.tasks.get(taskId) : [...this.tasks.values()].reverse().find(entry => sameProjectPath(project.path, entry.project.path))
    if (!task) {
      if (!taskId) {
        let root: string
        try { root = await ownedRoot(project, false) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
        const records = await Promise.all((await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && uuid.test(entry.name)).map(async entry => ({ id: entry.name, time: await fs.stat(path.join(root, entry.name, 'task.json')).then(stat => stat.mtimeMs, () => 0) })))
        records.sort((a, b) => b.time - a.time)
        return records[0]?.time ? this.read(project, records[0].id) : null
      }
      if (!uuid.test(taskId)) throw new Error('任务 ID 无效')
      const root = await ownedRoot(project, false)
      const directory = path.join(root, taskId)
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('隔离任务目录无效')
      const record = JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8')) as IsolatedServerTask
      if (!sameProjectPath(record.projectPath, project.path) || record.taskId !== taskId) throw new Error('隔离任务不属于当前项目')
      if (record.status === 'running') return { ...record, status: 'failed', canCancel: false, error: '应用重启前任务中断，未确认完成；保留目录供检查' }
      return record
    }
    if (!sameProjectPath(task.project.path, project.path)) throw new Error('隔离任务不属于当前项目')
    if (task.state.status === 'running' && waitSeconds) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([task.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, waitSeconds * 1000) })]) }
      finally { clearTimeout(timer) }
    }
    return structuredClone(task.state)
  }

  async cancel(project: ProjectInfo, taskId: string): Promise<IsolatedServerTask> {
    const task = this.tasks.get(taskId)
    if (!task || !sameProjectPath(task.project.path, project.path)) throw new Error('找不到当前项目的隔离任务')
    task.controller.abort(new Error('用户取消隔离测试'))
    if (task.state.status !== 'running' && task.server) task.finished = this.retryCleanup(task)
    if (task.state.status === 'running') { task.state.message = '正在取消隔离测试'; task.state.canCancel = false }
    return structuredClone(task.state)
  }
  async stop(): Promise<void> {
    for (const task of this.tasks.values()) if (task.state.status === 'running') task.controller.abort()
    await Promise.all([...this.tasks.values()].map(task => task.finished))
    for (const task of this.tasks.values()) if (task.server) await this.retryCleanup(task)
  }
  async projectChanged(projectPath?: string): Promise<void> {
    for (const task of this.tasks.values()) if (!projectPath || !sameProjectPath(task.project.path, projectPath)) task.controller.abort()
    await Promise.all([...this.tasks.values()].filter(task => task.controller.signal.aborted).map(task => task.finished))
    for (const task of this.tasks.values()) if (task.controller.signal.aborted && task.server) await this.retryCleanup(task)
  }

  private async run(task: TaskRecord, fixture: ServerFixtureInput, steps: IsolatedServerStep[], requestedPort?: number): Promise<void> {
    const signal = task.controller.signal
    let directory = ''
    let game = ''
    let server: ServerProcess | undefined
    let result: IsolatedServerResult | undefined
    let terminalStatus: IsolatedServerTask['status'] = 'failed'
    const logPaths: string[] = []
    const update = (phase: IsolatedServerTask['phase'], message: string): void => { Object.assign(task.state, { phase, message }) }
    try {
      const root = await ownedRoot(task.project)
      await this.prune(root)
      directory = path.join(root, task.state.taskId)
      await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify(task.state))
      game = path.join(directory, 'game')
      const inventory = await this.options.fixtures.stage(task.project, fixture, game, signal)
      const target: ProjectInfo = { ...task.project, minecraftVersion: fixture.minecraftVersion, loader: fixture.loader, kind: 'modpack', loaderVersion: fixture.loader === 'forge' ? fixture.loaderVersion.replace(`${fixture.minecraftVersion}-`, '') : fixture.loaderVersion }
      update('preparing-java', '正在准备测试 Java')
      const java = await this.options.java(target, signal)
      signal.throwIfAborted()
      for (const constraint of inventory.javaConstraints) {
        const matches = fixtureVersionMatches(java.version, constraint.range, fixture.loader === 'forge' || fixture.loader === 'neoforge')
        if (constraint.kind === 'required' && !matches || constraint.kind === 'incompatible' && matches) throw new Error(`${constraint.modId} 与实际 Java ${java.version} 的依赖约束不匹配：${String(constraint.range)}`)
      }
      const port = requestedPort ?? await unusedPort()
      await configureLocalServer(game, port, false, true)
      await fs.appendFile(path.join(game, 'server.properties'), '\nlevel-name=world\nenable-rcon=false\nenable-query=false\nview-distance=4\nsimulation-distance=4\nmax-players=1\n')
      const pack: ServerPackResult = { root: game, copiedMods: inventory.jars.map(jar => jar.name!), skippedClientMods: [], warnings: [], manifestPath: path.join(game, 'modmind.server.json') }
      await fs.writeFile(pack.manifestPath, JSON.stringify({ ...fixture, jars: inventory.jars, mods: inventory.mods, port, onlineMode: false }))
      result = { success: false, completed: 0, evidence: [], logPath: path.join(directory, 'server.log'), reportPath: path.join(directory, 'result.json'), minecraftVersion: fixture.minecraftVersion, loader: fixture.loader, loaderVersion: target.loaderVersion!, java, jars: inventory.jars, declaredMods: inventory.mods, observedMods: [], warnings: [], cleanup: 'pending' }
      task.state.result = result
      task.state.logPath = result.logPath
      update('installing', '正在安装固定版本的服务端运行时')
      const runtime = await (this.options.install ?? installServerRuntime)({ serverPack: pack, javaPath: java.path, signal, onDownloadProgress: progress => {
        task.state.progress = progress.total ? progress.downloaded / progress.total : undefined
        task.state.message = `正在下载 ${progress.source.label}`
      } }, target)
      runtime.javaPath = java.path
      if (runtime.loader !== target.loader || runtime.loaderVersion !== target.loaderVersion) throw new Error('安装的服务端运行时与固定测试版本不匹配')
      signal.throwIfAborted()
      server = (this.options.createProcess ?? (() => new ServerProcess()))()
      task.server = server
      const start = async (): Promise<void> => {
        update('starting', '正在启动隔离服务端')
        const started = await server!.start({ pack, runtime, port, signal, maxLogBytes: 8 * 1024 * 1024, onEvent: event => {
          task.state.recentLogs.push({ time: event.time, message: event.message.slice(0, 2000) })
          task.state.recentLogs = task.state.recentLogs.slice(-120)
        } })
        logPaths.push(started.logPath)
      }
      await start()
      for (const [index, step] of steps.entries()) {
        signal.throwIfAborted()
        update('scenario', `正在执行第 ${index + 1}/${steps.length} 步`)
        if (step.operation === 'restart') {
          await server.stop(); signal.throwIfAborted(); await start()
          result.evidence.push(`${index + 1}: 隔离服务端重启并就绪`)
        } else {
          const outcome = await server.runScenario([{ command: step.command!, expect: step.expect, timeoutMs: step.timeoutMs }], signal)
          result.evidence.push(...outcome.evidence.map(line => `${index + 1}: ${line.replace(/^1: /, '')}`))
          if (!outcome.success) { result.failedStep = index + 1; break }
        }
        result.completed++
        task.state.completed = result.completed
      }
      result.success = result.completed === steps.length
      terminalStatus = result.success ? 'completed' : 'failed'
      if (!result.success) task.state.error = `第 ${result.failedStep} 步断言未通过`
    } catch (error) {
      terminalStatus = signal.aborted ? 'cancelled' : 'failed'
      const failure = signal.aborted ? signal.reason ?? error : error
      task.state.error = failure instanceof Error ? failure.message : String(failure)
      if (result) result.success = false
    } finally {
      update('stopping', '正在停止隔离服务端并保存结果')
      let stopped = true
      try { await server?.stop() }
      catch (error) { stopped = false; terminalStatus = 'failed'; task.state.error = `未确认服务端停止：${String(error)}`; if (result) result.success = false }
      if (stopped) task.server = undefined
      if (server?.transcriptPath && !logPaths.includes(server.transcriptPath)) logPaths.push(server.transcriptPath)
      if (directory) {
        try {
          const logs = await this.logs([...logPaths, ...(game ? [path.join(game, 'logs/debug.log'), path.join(game, 'logs/latest.log')] : [])])
          await fs.writeFile(path.join(directory, 'server.log'), logs)
          task.state.logPath = path.join(directory, 'server.log')
          if (result) {
            result.observedMods = observeLoadedMods(logs, result.declaredMods)
            if (result.observedMods.length < result.declaredMods.length) result.warnings.push('日志未完整证明加载模组清单；declaredMods 是输入元数据，observedMods 仅含实际日志证据')
          }
          if (stopped && game) await fs.rm(game, { recursive: true, force: true })
          if (result) { result.cleanup = stopped ? 'complete' : 'failed'; await fs.writeFile(result.reportPath, JSON.stringify(result, null, 2)) }
        } catch (error) {
          terminalStatus = 'failed'; task.state.error = `保存证据或清理失败：${String(error)}`
          if (result) { result.success = false; result.cleanup = 'failed' }
        }
        task.state.status = terminalStatus
        update('finished', terminalStatus === 'completed' ? '隔离场景验证通过' : task.state.error ?? '隔离测试结束')
        task.state.canCancel = Boolean(task.server)
        await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify(task.state, null, 2)).catch(error => { task.state.status = 'failed'; task.state.error = `任务结果保存失败：${String(error)}` })
      } else { task.state.status = terminalStatus; task.state.canCancel = false; update('finished', task.state.error ?? '隔离测试结束') }
    }
  }

  private async retryCleanup(task: TaskRecord): Promise<void> {
    Object.assign(task.state, { status: 'running', phase: 'stopping', message: '正在重新停止隔离测试', canCancel: false })
    let directory = ''
    try {
      await task.server?.stop()
      directory = path.join(await ownedRoot(task.project, false), task.state.taskId)
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('隔离测试目录无效')
      await fs.rm(path.join(directory, 'game'), { recursive: true, force: true })
      task.server = undefined
      task.state.status = 'cancelled'; task.state.error = '隔离测试已取消并清理'
      if (task.state.result) {
        task.state.result.cleanup = 'complete'
        await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(task.state.result, null, 2))
      }
    } catch (error) { task.state.status = 'failed'; task.state.error = `清理重试失败：${String(error)}` }
    task.state.phase = 'finished'; task.state.message = task.state.error!; task.state.canCancel = Boolean(task.server)
    if (directory) await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify(task.state, null, 2)).catch(() => undefined)
  }

  private async logs(paths: string[]): Promise<string> {
    let result = ''
    for (const file of paths) {
      const handle = await fs.open(file, 'r').catch(() => null)
      if (!handle) continue
      try {
        const stat = await handle.stat()
        const buffer = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024))
        const read = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length))
        result += `\n=== ${path.basename(file)} ===\n${buffer.subarray(0, read.bytesRead).toString('utf8')}`
      } finally { await handle.close() }
      if (Buffer.byteLength(result) > 16 * 1024 * 1024) { result = result.slice(-8 * 1024 * 1024); break }
    }
    return result
  }

  private async prune(root: string): Promise<void> {
    const records: Array<{ directory: string; modified: number }> = []
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !uuid.test(entry.name)) continue
      const directory = path.join(root, entry.name)
      try {
        const state = JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8')) as IsolatedServerTask
        if (state.taskId === entry.name && finishedStatuses.has(state.status) && state.result?.cleanup !== 'failed') records.push({ directory, modified: (await fs.stat(path.join(directory, 'task.json'))).mtimeMs })
      } catch { /* Unowned or interrupted directories remain available for diagnosis. */ }
    }
    records.sort((a, b) => b.modified - a.modified)
    for (const [index, record] of records.entries()) if (index >= 15 || Date.now() - record.modified > 30 * 86400000) {
      await fs.rm(record.directory, { recursive: true, force: true })
      this.tasks.delete(path.basename(record.directory))
    }
  }
}

export function observeLoadedMods(logs: string, declared: IsolatedServerResult['declaredMods']): IsolatedServerResult['observedMods'] {
  const observed: IsolatedServerResult['observedMods'] = []
  for (const mod of declared) {
    const escaped = mod.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedVersion = mod.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const lines = logs.split(/\r?\n/)
    const match = lines.find(line => new RegExp(`(?:^\\s*-\\s*${escaped}\\s+${escapedVersion}(?:\\s|$)|\\|\\s*${escaped}\\s*\\|\\s*${escapedVersion}\\s*\\|\\s*(?:DONE|COMMON_SET|SIDED_SETUP|COMPLETE)\\s*\\|)`).test(line))
    const container = lines.some(line => /Done \([\d.,]+s\)!/.test(line)) ? lines.find(line => new RegExp(`Creating (?:LowCodeModContainer|FMLModContainer(?: instance)?) for ${escaped}(?:\\s|$)`).test(line)) : undefined
    if (match || container) observed.push({ id: mod.id, version: mod.version, evidence: (match ?? `${container}; server startup completed; version from SHA-256-verified JAR metadata`).slice(0, 2000) })
  }
  return observed
}
