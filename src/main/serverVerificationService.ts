import { spawnManaged, stopProcessTree } from './processTree'
import { createWriteStream, promises as fs } from 'node:fs'
import type { WriteStream } from 'node:fs'
import net from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { HeadlessSmokeTestResult, MinecraftRuntimeEvent } from '../shared/minecraft'
import { HeadlessMcService } from './headlessMcService'
import { buildServerPack, installServerRuntime, type ServerPackResult, type ServerRuntimeResult } from './serverPackService'

export interface ServerProcessOptions {
  pack: ServerPackResult
  runtime: ServerRuntimeResult
  port: number
  readyTimeoutMs?: number
  onEvent?: (event: MinecraftRuntimeEvent) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface ServerJoinVerificationOptions {
  project: ProjectInfo
  javaPath: string
  serverPack?: ServerPackResult
  headless: HeadlessMcService
  gameDirectory: string
  /** Managed runtime root reused by HeadlessMC to avoid direct Mojang downloads. */
  managedMinecraftDirectory?: string
  stableWindowMs?: number
  joinTimeoutMs?: number
  onlineMode?: boolean
  onEvent?: (event: MinecraftRuntimeEvent) => void
  onProgress?: (progress: { message: string; fraction?: number; downloaded?: number; total?: number }) => void
}

export interface ServerJoinVerificationResult {
  success: boolean
  address: string
  serverLogPath: string
  headless: HeadlessSmokeTestResult
  message: string
}

export interface ServerScenarioStep {
  command: string
  expect?: string[]
  timeoutMs?: number
}

export interface ServerScenarioResult {
  success: boolean
  completed: number
  failedStep?: number
  evidence: string[]
  logPath: string
}

function event(onEvent: ServerProcessOptions['onEvent'], message: string, level: MinecraftRuntimeEvent['level'] = 'info'): void {
  onEvent?.({ stage: 'testing-server', message, level, time: new Date().toISOString() })
}

function isWindowsBatchPausePrompt(value: string): boolean {
  return /(?:\uFFFD.*\.\s*\.\s*\.|press any key to continue|请按任意键继续)/iu.test(value)
}

/** Returns an actionable hint only when the server output names the failing mod. */
export function serverModRetryAdvice(output: string, copiedMods: readonly string[] = []): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const failureLine = /(?:failed to (?:load|scan|parse|read|resolve) (?:a )?(?:mod|mod file|jar)|could(?: not|n't) (?:load|scan|parse|read|resolve) (?:a )?(?:mod|mod file|jar)|unable to (?:load|scan|parse|read|resolve) (?:a )?(?:mod|mod file|jar)|invalid mod(?: file| metadata)?|not a valid mod|mod resolution encountered|mod loading has failed|loading errors encountered|error loading mod|\bmod\s+['"`][a-z0-9][a-z0-9_.-]*['"`].*(?:requires|is incompatible|failed|cannot|could not|is not compatible))/i
  const knownMods = copiedMods.map((fileName) => ({ fileName, normalized: fileName.toLowerCase() })).filter(({ normalized }) => normalized.endsWith('.jar'))

  for (let index = 0; index < lines.length; index += 1) {
    if (!failureLine.test(lines[index])) continue
    const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 5)).join('\n')
    const normalizedContext = context.toLowerCase()
    const fileName = knownMods.find((mod) => normalizedContext.includes(mod.normalized))?.fileName
    if (fileName) return `试试删除《${fileName}》再重试`

    const modId = [
      /(?:failed to|could(?: not|n't)|unable to)\s+(?:load|resolve|parse)\s+(?:a )?mod\s+['"`]?([a-z0-9][a-z0-9_.-]{1,100})['"`]?/i,
      /\bmod\s+['"`]([a-z0-9][a-z0-9_.-]{1,100})['"`](?:\s*\([^)]*\))?\s+(?:requires|is incompatible|failed|cannot|could not|is not compatible)/i,
      /\b(?:mod id|modid)\s*[:=]\s*['"`]?([a-z0-9][a-z0-9_.-]{1,100})['"`]?/i,
      /loading errors encountered:\s*\[([a-z0-9][a-z0-9_.-]{1,100})/i
    ].map((pattern) => context.match(pattern)?.[1]).find(Boolean)
    if (modId) return `试试删除《${modId}》再重试`
  }
  return undefined
}

function tcpProbe(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(false) })
  })
}

export class ServerProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private logPath = ''
  private log: WriteStream | null = null
  private outputLines: string[] = []

  isRunning(): boolean { return Boolean(this.child && this.child.exitCode === null) }
  get transcriptPath(): string { return this.logPath }
  get pid(): number | undefined { return this.child?.pid ?? undefined }
  get recentOutput(): string[] { return [...this.outputLines] }

  sendCommand(command: string): void {
    const value = command.trim()
    if (!value || value.length > 1_000 || /[\r\n]/.test(value)) throw new Error('服务器命令无效')
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) throw new Error('本机服务端当前未运行')
    this.child.stdin.write(`${value}\n`)
  }

  async start(options: ServerProcessOptions): Promise<{ address: string; logPath: string }> {
    if (this.isRunning()) throw new Error('server process is already running')
    if (!options.pack.root || !options.runtime.launchCommand.length) throw new Error('server pack runtime is incomplete')
    // The server may have been generated before the app-level agreement was recorded.
    // Always set the runtime file immediately before launch.
    await fs.writeFile(path.join(options.pack.root, 'eula.txt'), 'eula=true\n', 'utf8')
    const logDirectory = path.join(options.pack.root, 'logs')
    await fs.mkdir(logDirectory, { recursive: true })
    this.logPath = path.join(logDirectory, `modmind-server-${Date.now()}.log`)
    this.outputLines = []
    const log = createWriteStream(this.logPath, { flags: 'w' })
    this.log = log
    const [executable, ...args] = options.runtime.launchCommand
    const child = spawnManaged(executable, args, {
      cwd: options.pack.root,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: options.runtime.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    this.child = child
    let output = ''
    let ready = false
    let spawnError = ''
    let batchPausePrompt = false
    const capture = (chunk: Buffer, level: MinecraftRuntimeEvent['level']): void => {
      const text = chunk.toString('utf8')
      log.write(text)
      output = `${output}${text}`.slice(-120_000)
      if (isWindowsBatchPausePrompt(output)) batchPausePrompt = true
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const displayLines = lines.map((line) => isWindowsBatchPausePrompt(line) ? '服务端启动失败，请检查您的服务端包' : line)
      this.outputLines.push(...displayLines)
      if (this.outputLines.length > 500) this.outputLines.splice(0, this.outputLines.length - 500)
      if (/(?:Done \([\d.]+s\)!|For help, type "help"|Server started|Dedicated server took)/i.test(text)) ready = true
      displayLines.slice(-5).forEach((line) => event(options.onEvent, line, level))
    }
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'info'))
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'warning'))
    child.once('error', (error) => { spawnError = error.message })
    child.once('exit', (code, signal) => options.onExit?.(code, signal))
    const deadline = Date.now() + Math.min(Math.max(options.readyTimeoutMs ?? 180_000, 10_000), 15 * 60_000)
    while (Date.now() < deadline && child.exitCode === null) {
      if (spawnError || batchPausePrompt) break
      if (ready && await tcpProbe('127.0.0.1', options.port)) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (spawnError || child.exitCode !== null || !ready || !(await tcpProbe('127.0.0.1', options.port))) {
      await this.stop()
      this.log = null
      const pauseError = batchPausePrompt ? '，服务端启动失败，请检查您的服务端包' : ''
      const modAdvice = batchPausePrompt ? '' : serverModRetryAdvice(output, options.pack.copiedMods)
      const outputTail = batchPausePrompt ? '' : output ? `\n${output.slice(-8_000)}` : ''
      throw new Error(`server did not become ready on 127.0.0.1:${options.port}${pauseError}${spawnError ? `: ${spawnError}` : ''}${modAdvice ? `\n${modAdvice}` : ''}${outputTail}`)
    }
    event(options.onEvent, `server ready on 127.0.0.1:${options.port}`)
    return { address: `127.0.0.1:${options.port}`, logPath: this.logPath }
  }

  async runScenario(steps: ServerScenarioStep[]): Promise<ServerScenarioResult> {
    if (!this.child || this.child.exitCode !== null) throw new Error('server process is not running')
    const evidence: string[] = []
    for (const [index, step] of steps.entries()) {
      const command = typeof step.command === 'string' ? step.command.trim() : ''
      if (!command || command.length > 1_000 || /[\r\n]/.test(command)) throw new Error(`invalid server scenario command at step ${index + 1}`)
      this.sendCommand(command)
      const expected = (step.expect ?? []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()).slice(0, 20)
      const deadline = Date.now() + Math.min(Math.max(step.timeoutMs ?? 10_000, 1_000), 120_000)
      while (expected.length && Date.now() < deadline) {
        const matched = expected.filter((pattern) => this.outputLines.some((line) => line.toLowerCase().includes(pattern.toLowerCase())))
        if (matched.length === expected.length) { evidence.push(...matched.map((pattern) => `${index + 1}: ${pattern}`)); break }
        if (this.child.exitCode !== null) return { success: false, completed: index, failedStep: index + 1, evidence, logPath: this.logPath }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (expected.length && expected.some((pattern) => !this.outputLines.some((line) => line.toLowerCase().includes(pattern.toLowerCase())))) return { success: false, completed: index, failedStep: index + 1, evidence, logPath: this.logPath }
    }
    return { success: true, completed: steps.length, evidence, logPath: this.logPath }
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    await stopProcessTree(child)
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
    if (this.log) await new Promise<void>((resolve) => this.log?.end(resolve))
    this.log = null
    this.child = null
  }
}

export async function buildAndJoinServer(options: ServerJoinVerificationOptions & { outputDirectory: string; acceptEula: boolean; port: number }): Promise<ServerJoinVerificationResult> {
  if (!options.acceptEula) throw new Error('启动并验证前必须确认 Mojang EULA')
  options.onProgress?.({ message: options.serverPack ? '正在读取已同步的服务端包' : '正在构建验证用服务端包', fraction: 0.36 })
  const pack = options.serverPack ?? await buildServerPack(options.project, { outputDirectory: options.outputDirectory, acceptEula: options.acceptEula, port: options.port, onlineMode: options.onlineMode === true })
  await fs.writeFile(path.join(pack.root, 'eula.txt'), 'eula=true\n', 'utf8')
  options.onProgress?.({ message: '正在下载并安装验证服务端运行时', fraction: 0.44 })
  const runtime = await installServerRuntime({
    serverPack: pack,
    javaPath: options.javaPath,
    onDownloadProgress: ({ source, downloaded, total }) => options.onProgress?.({
      message: `正在从 ${source.label} 下载验证服务端运行时`,
      fraction: total ? 0.44 + 0.16 * downloaded / total : undefined,
      downloaded,
      total
    })
  }, options.project)
  const server = new ServerProcess()
  try {
    options.onProgress?.({ message: '正在启动验证服务端', fraction: 0.62 })
    const started = await server.start({ pack, runtime, port: options.port, onEvent: options.onEvent })
    options.onProgress?.({ message: '正在使用 HeadlessMC 验证加入', fraction: 0.74 })
    const headless = await options.headless.run({
      project: options.project,
      gameDirectory: options.gameDirectory,
      sourceModsDirectory: path.join(pack.root, 'mods'),
      javaPath: options.javaPath,
      managedMinecraftDirectory: options.managedMinecraftDirectory,
      stableWindowMs: options.stableWindowMs ?? 20_000,
      serverAddress: started.address,
      joinTimeoutMs: options.joinTimeoutMs ?? 30_000,
      offline: options.onlineMode !== true,
      onDownloadProgress: ({ message, downloaded, total }) => options.onProgress?.({
        message,
        fraction: total ? 0.74 + 0.2 * downloaded / total : undefined,
        downloaded,
        total
      })
    })
    return { success: Boolean(headless.success && headless.joinedServer), address: started.address, serverLogPath: started.logPath, headless, message: headless.joinedServer ? `HeadlessMC joined ${started.address}` : `HeadlessMC did not prove a server join` }
  } finally {
    await server.stop()
  }
}

export async function runServerScenario(options: { project: ProjectInfo; outputDirectory: string; port: number; acceptEula: boolean; onlineMode?: boolean; javaPath: string; steps: ServerScenarioStep[]; onEvent?: ServerProcessOptions['onEvent'] }): Promise<ServerScenarioResult> {
  const pack = await buildServerPack(options.project, { outputDirectory: options.outputDirectory, port: options.port, acceptEula: options.acceptEula, onlineMode: options.onlineMode === true })
  const runtime = await installServerRuntime({ serverPack: pack, javaPath: options.javaPath }, options.project)
  const server = new ServerProcess()
  try {
    await server.start({ pack, runtime, port: options.port, onEvent: options.onEvent })
    return await server.runScenario(options.steps)
  } finally {
    await server.stop()
  }
}
