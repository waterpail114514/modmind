import { spawnManaged, stopProcessTree } from './processTree'
import { createHash } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { JavaLoaderKind, ProjectInfo } from '../shared/types'
import type { HeadlessSmokeTestResult, MinecraftRuntimeEvent } from '../shared/minecraft'
import { verifiedDownload } from './downloadService'
import { downloadActivities } from './downloadActivityService'
import { openInteractiveTerminal } from './nativeTerminal'

export const HEADLESS_MC_VERSION = '2.10.0'
export const HEADLESS_MC_LAUNCHER_URL = `https://github.com/headlesshq/headlessmc/releases/download/${HEADLESS_MC_VERSION}/headlessmc-launcher-${HEADLESS_MC_VERSION}.jar`
export const HEADLESS_MC_LAUNCHER_MIRROR_URL = `https://ghfast.top/${HEADLESS_MC_LAUNCHER_URL}`
export const HEADLESS_MC_LAUNCHER_SHA256 = '52bd5006f478377b3893011d458562977d38c65ead6d2b31089beb4d614f13cd'

const HEADLESS_MC_LAUNCHER_FILE = `headlessmc-launcher-${HEADLESS_MC_VERSION}.jar`
const DEFAULT_STABLE_WINDOW_MS = 20_000
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024

export interface HeadlessMcSmokeInput {
  project: ProjectInfo
  gameDirectory: string
  sourceModsDirectory: string
  javaPath: string
  /** Managed runtime root holding versions/libraries/assets so the launcher can reuse downloaded content. */
  managedMinecraftDirectory?: string
  /** Exact prepared launcher profile; avoids HeadlessMC choosing another cached loader. */
  loaderVersionId?: string
  stableWindowMs?: number
  serverAddress?: string
  joinTimeoutMs?: number
  offline?: boolean
  onDownloadProgress?: (progress: { message: string; downloaded: number; total?: number }) => void
}

export interface HeadlessMcServiceOptions {
  userDataDirectory: string
  onEvent: (event: MinecraftRuntimeEvent) => void
}

export function supportsHeadlessMc(loader: ProjectInfo['loader']): loader is JavaLoaderKind {
  return loader === 'fabric' || loader === 'forge' || loader === 'neoforge'
}

export function headlessMcLaunchCommand(loader: JavaLoaderKind, minecraftVersion: string, offline = false, loaderVersionId?: string): string {
  if (!supportsHeadlessMc(loader)) throw new Error(`${loader} 暂不支持 HeadlessMC 无头测试`)
  if (!/^[0-9A-Za-z._-]{1,40}$/.test(minecraftVersion)) throw new Error('Minecraft 版本无效')
  const target = loaderVersionId?.trim() || `${loader}:${minecraftVersion}`
  if (!/^[0-9A-Za-z._+:-]{1,160}$/.test(target)) throw new Error('Minecraft Loader profile 无效')
  return `launch ${target} -lwjgl${offline ? ' -offline' : ''}`
}

export class HeadlessMcService {
  private readonly root: string
  private child: ChildProcessWithoutNullStreams | null = null
  private downloadPromise: Promise<string> | null = null
  private stopRequested = false

  constructor(private readonly options: HeadlessMcServiceOptions) {
    this.root = path.join(options.userDataDirectory, 'headlessmc', HEADLESS_MC_VERSION)
  }

  isRunning(): boolean { return Boolean(this.child && this.child.exitCode === null && !this.child.killed) }

  async openLoginConsole(javaPath: string): Promise<void> {
    if (!await isFile(javaPath)) throw new Error('HeadlessMC 找不到可用于登录的 Java 运行时')
    const launcherPath = await this.ensureLauncher()
    await openInteractiveTerminal({ executable: javaPath, args: ['-jar', launcherPath], cwd: this.root }, path.join(this.options.userDataDirectory, 'terminal-sessions'))
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    const child = this.child
    if (!child) return
    try { child.stdin.write('exit\n') } catch { /* The child may have already closed stdin. */ }
    await this.killProcessTree(child)
    await this.waitForExit(child, 5_000)
    if (this.child === child) this.child = null
  }

  async run(input: HeadlessMcSmokeInput, signal?: AbortSignal): Promise<HeadlessSmokeTestResult> {
    if (this.isRunning()) throw new Error('HeadlessMC 冒烟测试已经在运行')
    this.stopRequested = false
    if (!supportsHeadlessMc(input.project.loader)) {
      throw new Error(`HeadlessMC 首版仅支持 Fabric、Forge 和 NeoForge，当前项目为 ${input.project.loader}`)
    }
    if (!await isFile(input.javaPath)) throw new Error('HeadlessMC 找不到当前 Minecraft 所需的 Java 运行时')
    const launcherPath = await this.ensureLauncher(signal, input.onDownloadProgress)
    if (signal?.aborted) throw abortError()

    const modsDirectory = path.join(input.gameDirectory, 'mods')
    const logDirectory = path.join(input.gameDirectory, 'logs')
    await fs.mkdir(input.gameDirectory, { recursive: true })
    await fs.rm(modsDirectory, { recursive: true, force: true })
    await Promise.all([fs.mkdir(modsDirectory, { recursive: true }), fs.mkdir(logDirectory, { recursive: true })])
    await this.copyManagedMods(input.sourceModsDirectory, modsDirectory)

    const transcriptPath = path.join(logDirectory, `headlessmc-${Date.now()}.log`)
    const stableWindowMs = clampStableWindow(input.stableWindowMs)
    const command = headlessMcLaunchCommand(input.project.loader, input.project.minecraftVersion, input.offline === true, input.loaderVersionId)
    const launcherArguments = [
      `-Dhmc.gamedir=${input.gameDirectory}`,
      `-Dhmc.java.versions=${input.javaPath}`,
      // Reuse the managed runtime's versions/libraries/assets so offline or
      // blocked networks never re-download Mojang-hosted content here.
      ...(input.managedMinecraftDirectory ? [`-Dhmc.mcdir=${input.managedMinecraftDirectory}`] : []),
      // Headless smoke tests never render, so tiny placeholder assets avoid the
      // largest download and its flaky resources.download.minecraft.net host.
      '-Dhmc.assets.dummy=true',
      ...jvmProxyArguments()
    ]
    this.emit('headless-testing', `启动 HeadlessMC ${HEADLESS_MC_VERSION}`)
    this.emit('headless-testing', `无头命令：${command}`)
    const child = spawnManaged(input.javaPath, [
      ...launcherArguments,
      '-jar',
      launcherPath
    ], {
      cwd: this.root,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    const log = createWriteStream(transcriptPath, { flags: 'w' })
    const lines: string[] = []
    let transcriptSize = 0
    let launchObserved = false
    let joinObserved = false
    let authenticationFailure = ''
    let processError = ''
    let aborted = false
    // The launcher downloads missing vanilla libraries/assets itself; surface
    // that fallback traffic in the global download indicator.
    let launcherDownloadActivityId: string | null = null

    const append = (chunk: Buffer, level: MinecraftRuntimeEvent['level']): void => {
      const text = chunk.toString('utf8')
      if (transcriptSize < MAX_TRANSCRIPT_BYTES) {
        const remaining = MAX_TRANSCRIPT_BYTES - transcriptSize
        const output = text.slice(0, remaining)
        transcriptSize += Buffer.byteLength(output, 'utf8')
        log.write(output)
      }
      const nextLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => line.split(/\r+\s*/)).filter(Boolean)
      for (const line of nextLines) {
        lines.push(line)
        if (lines.length > 80) lines.shift()
        if (/(?:launch(?:ing|ed).*minecraft|starting minecraft|starting game|game process)/i.test(line)) launchObserved = true
        if (/(?:joined the game|joining.*server|connected to.*server|logged in.*server|player joined)/i.test(line)) joinObserved = true
        if (/(?:not logged in|please log in|login required|no account|authentication failed)/i.test(line)) authenticationFailure = line

        const libraryProgress = /Downloading Libraries\s+(\d+)%/.exec(line)
        if (libraryProgress) {
          const percent = Math.max(0, Math.min(100, Number(libraryProgress[1])))
          if (!launcherDownloadActivityId) {
            launcherDownloadActivityId = downloadActivities.start({ label: 'HeadlessMC 补全游戏库', detail: 'HeadlessMC 内置下载' })
          }
          downloadActivities.update(launcherDownloadActivityId, { label: 'HeadlessMC 补全游戏库', downloadedBytes: percent, totalBytes: 100 })
          if (percent >= 100) {
            downloadActivities.complete(launcherDownloadActivityId, 'HeadlessMC 游戏库已就绪')
            launcherDownloadActivityId = null
          }
        } else {
          const assetMatch = /Downloading assets from (\S+)/.exec(line)
          if (assetMatch && launcherDownloadActivityId !== null) {
            downloadActivities.update(launcherDownloadActivityId, { detail: `正在下载资产：${assetMatch[1]}` })
          }
        }

        this.emit('headless-testing', line.slice(0, 1_000), level)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'info'))
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'warning'))
    child.once('error', (error) => { processError = error.message })

    const abort = (): void => {
      aborted = true
      void this.stop()
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await waitForSpawn(child)
      if (signal?.aborted) throw abortError()
      child.stdin.write(`${command}\n`)
      const startedAt = Date.now()
      while (Date.now() - startedAt < stableWindowMs) {
        if (aborted || this.stopRequested || signal?.aborted) throw abortError()
        if (authenticationFailure) throw new Error(`HeadlessMC 需要先登录正版 Minecraft 账号：${authenticationFailure}`)
        if (processError) throw new Error(`HeadlessMC 无法启动：${processError}`)
        if (child.exitCode !== null) throw new Error(this.exitError(child.exitCode, lines))
        await delay(250)
      }
      if (input.serverAddress) {
        if (!/^\[?[A-Za-z0-9_.:-]+\]?:\d{1,5}$/.test(input.serverAddress)) throw new Error('server address must be host:port')
        child.stdin.write(`connect ${input.serverAddress}\n`)
        const joinDeadline = Date.now() + Math.min(Math.max(input.joinTimeoutMs ?? 30_000, 5_000), 120_000)
        while (!joinObserved && Date.now() < joinDeadline) {
          if (authenticationFailure) throw new Error(`HeadlessMC login failed: ${authenticationFailure}`)
          if (processError) throw new Error(`HeadlessMC could not start: ${processError}`)
          if (child.exitCode !== null) throw new Error(this.exitError(child.exitCode, lines))
          await delay(250)
        }
        if (!joinObserved) throw new Error(`HeadlessMC did not observe a server join for ${input.serverAddress}; transcript: ${transcriptPath}`)
      }
      if (!launchObserved) {
        throw new Error(`HeadlessMC 未确认 Minecraft 已启动。请检查日志：${transcriptPath}`)
      }
      this.emit('headless-testing', `HeadlessMC 已稳定运行 ${Math.round(stableWindowMs / 1_000)} 秒`, 'info')
      return {
        success: true,
        launcherVersion: HEADLESS_MC_VERSION,
        launcherPath,
        transcriptPath,
        stableWindowMs,
        ...(input.serverAddress ? { joinedServer: true, serverAddress: input.serverAddress } : {}),
        message: `HeadlessMC 已稳定运行 ${Math.round(stableWindowMs / 1_000)} 秒`
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      await this.stop()
      await new Promise<void>((resolve) => log.end(resolve))
      if (this.child === child) this.child = null
      if (launcherDownloadActivityId) {
        downloadActivities.fail(launcherDownloadActivityId, 'HeadlessMC 在补全游戏库时退出')
        launcherDownloadActivityId = null
      }
    }
  }

  private async ensureLauncher(signal?: AbortSignal, onDownloadProgress?: HeadlessMcSmokeInput['onDownloadProgress']): Promise<string> {
    if (this.downloadPromise) return this.downloadPromise
    this.downloadPromise = this.ensureLauncherInternal(signal, onDownloadProgress).finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  private async ensureLauncherInternal(signal?: AbortSignal, onDownloadProgress?: HeadlessMcSmokeInput['onDownloadProgress']): Promise<string> {
    const target = path.join(this.root, HEADLESS_MC_LAUNCHER_FILE)
    if (await hasExpectedSha256(target, HEADLESS_MC_LAUNCHER_SHA256)) return target
    await fs.mkdir(this.root, { recursive: true })
    this.emit('downloading-game', `正在下载 HeadlessMC ${HEADLESS_MC_VERSION}`)
    await verifiedDownload.download({
      sources: [
        { id: 'headlessmc-github', label: 'HeadlessMC GitHub release', url: HEADLESS_MC_LAUNCHER_URL },
        { id: 'headlessmc-ghfast', label: 'HeadlessMC GitHub 加速源', url: HEADLESS_MC_LAUNCHER_MIRROR_URL }
      ],
      destination: target,
      expectedHash: { algorithm: 'sha256', value: HEADLESS_MC_LAUNCHER_SHA256 },
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 5 * 60_000,
      retriesPerSource: 2,
      signal,
      onProgress: ({ source, downloaded, total }) => onDownloadProgress?.({ message: `正在从 ${source.label} 下载 HeadlessMC`, downloaded, total })
    })
    this.emit('downloading-game', 'HeadlessMC 下载并校验完成')
    return target
  }

  private async copyManagedMods(source: string, destination: string): Promise<void> {
    const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => [])
    const jars = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    if (!jars.length) throw new Error('没有已同步的 Mod JAR，请先构建并同步项目')
    await Promise.all(jars.map((entry) => fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name))))
    this.emit('headless-testing', `已同步 ${jars.length} 个 Mod 到 HeadlessMC 隔离实例`)
  }

  private exitError(code: number | null, lines: string[]): string {
    const detail = lines.slice(-12).join('\n')
    return `HeadlessMC 已退出，代码 ${code ?? '未知'}${detail ? `\n${detail}` : ''}`
  }

  private killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    return stopProcessTree(child)
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(timeoutMs)
    ])
  }

  private emit(stage: MinecraftRuntimeEvent['stage'], message: string, level: MinecraftRuntimeEvent['level'] = 'info'): void {
    this.options.onEvent({ stage, message, level, time: new Date().toISOString() })
  }
}

function clampStableWindow(value?: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_STABLE_WINDOW_MS
  return Math.min(Math.max(value, 5_000), 120_000)
}

/**
 * The launcher downloads Mojang libraries and assets with plain Java HTTP
 * clients that ignore environment proxies, so users who need a proxy to reach
 * those hosts would always fail here. Forward the standard variables as JVM
 * proxy properties; values without a scheme default to http.
 */
export function jvmProxyArguments(environment: NodeJS.ProcessEnv = process.env): string[] {
  const httpsProxy = normalizeProxyUrl(environment.HTTPS_PROXY ?? environment.https_proxy)
    ?? normalizeProxyUrl(environment.HTTP_PROXY ?? environment.http_proxy)
  const arguments_: string[] = []
  if (httpsProxy) {
    arguments_.push(`-Dhttps.proxyHost=${httpsProxy.host}`, `-Dhttps.proxyPort=${httpsProxy.port}`)
    if (httpsProxy.userInfo) arguments_.push(`-Dhttps.proxyUser=${httpsProxy.userInfo}`)
  }
  const noProxy = environment.NO_PROXY ?? environment.no_proxy
  if (noProxy) arguments_.push(`-Dhttp.nonProxyHosts=${noProxy.split(',').filter(Boolean).join('|')}`)
  return arguments_
}

function normalizeProxyUrl(value?: string): { host: string; port: string; userInfo?: string } | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    if (!url.hostname) return null
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      ...(url.username ? { userInfo: `${url.username}${url.password ? `:${url.password}` : ''}` } : {})
    }
  } catch {
    return null
  }
}

function abortError(): Error { return Object.assign(new Error('HeadlessMC 冒烟测试已取消'), { name: 'AbortError' }) }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
}

async function isFile(value: string): Promise<boolean> {
  try { return (await fs.stat(value)).isFile() } catch { return false }
}

async function hasExpectedSha256(filePath: string, expected: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(filePath)
    return createHash('sha256').update(bytes).digest('hex') === expected
  } catch {
    return false
  }
}
