import { recordDiagnosticArtifact } from '../../../../src/main/diagnosticArtifacts'
import { isManagedRepositoryFailure } from '../../../../src/main/gradleRepositoryPolicy'
import { watchGradleBuild } from '../../../../src/main/gradleDiagnostics'
import { hasConnectorBridge, validateRuntimeModArtifact } from '../../../../src/main/modpackArtifactValidation'
import { isSafeModJarFileName } from '../../../../src/main/modpackFilename'
import { isGradleNetworkFailure } from '../../../../src/main/gradleFailure'
import { gradleRunDirectory, normalizeProcessExitCode } from '../../../../src/main/gradleProcess'
import { diagnoseAssets,launch,LaunchPrecheck,MinecraftFolder,Version } from '@xmcl/core'
import { finished } from 'node:stream/promises'
import {
fetchJavaRuntimeManifest,
getFabricLoaders,
getForgeVersionList,
getQuiltLoaders,
getVersionList,
installDependenciesTask,
installFabric,
installForgeTask,
installJavaRuntimeTask,
installNeoForgedTask,
installQuiltVersion,
installTask,
JavaRuntimeTargetType
} from '@xmcl/installer'
import { app,net } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { createReadStream,createWriteStream,promises as fs } from 'node:fs'
import path from 'node:path'

import { BuildRuntimeManager,exists,probeJavaHome,projectArtifactName,projectDataDirectory,summarizeGradleFailure,validateModArtifact,type GradleRuntimeSelection } from '../../../../src/main/buildRuntime'
import { boundedGradleJavaOptions,GRADLE_NETWORK_TIMEOUTS } from '../../../../src/main/gradleNetworkPolicy'
import { diagnosticJournal } from '../../../../src/main/diagnosticLog'
import { verifiedDownload } from '../../../../src/main/downloadService'
import { isMissingFileError,isTransientFileLockError,lockedFileReadError,retryTransientFileLock } from '../../../../src/main/fileLockRetry'
import { forgeInstallerVersion, forgeInstallerUrl } from '../../../../src/main/forgeInstallerVersion'
import { managedJavaEnvironment } from '../../../../src/main/javaEnvironment'
import { prepareLegacyForgeJavaCompatibility } from './legacyForgeJavaCompatibility'
import { prepareLoaderApiTestPolicy } from '../../../../src/main/loaderApiTestPolicy'
import { javaRuntimeTargetForJavaVersion,javaRuntimeTargetForMinecraft,javaVersionForMinecraft } from '../../../../src/main/loaderCompatibility'
import {
BMCLAPI_BASE_URL,
MINECRAFT_VERSION_MANIFEST_SOURCES,
resolveMinecraftVersionFromManifests
} from '../../../../src/main/minecraftVersionManifest'
import { modpackModsRoot } from '../../../../src/main/modpackPaths'
import { assertModpackDependenciesReady,readModpackManifest,readModpackModuleProject,syncModpackOverrides,syncReloadableKubeJsScripts } from '../../../../src/main/modpackService'
import { spawnManaged,stopProcessTree } from '../../../../src/main/processTree'
import { sameProjectPath } from '../../../../src/main/projectPath'
import { findPluginArtifact } from '../../../../src/main/serverPluginService'
import type {
GradleVerificationResult,
MinecraftCrashInfo,
MinecraftLaunchOptions,
MinecraftLaunchTestResult,
MinecraftManagedMod,
MinecraftRuntimeEvent,
MinecraftRuntimeState
} from '../../../../src/shared/minecraft'
import { isJavaLoader,platformLabel } from '../../../../src/shared/projectPlatform'
import type { LoaderKind,ProjectInfo } from '../../../../src/shared/types'
import { applyNarratorPreference,gameDirectoryForLaunch,validateJvmArguments } from './minecraftLaunchPreferences'
import { runMinecraftTaskWithRecovery, minecraftDownloadRecoveryOptions } from './minecraftTaskRecovery'
import { minecraftDownloadDispatcher } from '../../../../src/main/minecraftDownloadNetwork'
import { validManagedJavaCache, MANAGED_JAVA_MANIFEST } from '../../../../src/main/managedJavaIntegrity'
import { loaderMetadataFetch } from '../../../../src/main/loaderMetadataDownload'
import { fetchTextWithRetry } from '../../../../src/main/networkRequest'
import { downloadFailureText } from '../../../../src/shared/downloadFailure'
import { prepareLoaderInstaller, loaderLibraryHost } from '../../../../src/main/loaderInstallerDownload'
import { managedJavaExecutable,normalizeRuntimeMetadata,type RuntimeMetadata } from './runtimeMetadata'
import { installedRuntimeCandidates } from './minecraftRuntimeCache'
import { BackgroundGameControlSession, backgroundGameWindowsHide } from './gameControlSession'
const BMCLAPI = BMCLAPI_BASE_URL

const MINECRAFT_ASSET_HOSTS = [`${BMCLAPI}/assets`, 'https://resources.download.minecraft.net']

const MINECRAFT_MAVEN_HOSTS = [`${BMCLAPI}/maven`, 'https://libraries.minecraft.net', 'https://repo1.maven.org/maven2']

const FORGE_MAVEN_HOSTS = [`${BMCLAPI}/maven`, 'https://maven.minecraftforge.net']

const NEOFORGE_MAVEN_HOSTS = [`${BMCLAPI}/maven`, 'https://maven.neoforged.net/releases']

function mirrorVersionJsonUrl(versionId: string): string {
  return `${BMCLAPI}/version/${encodeURIComponent(versionId)}/${encodeURIComponent(versionId)}.json`
}

function mirrorMinecraftJarUrl(versionId: string, side: 'client' | 'server'): string {
  return `${BMCLAPI}/version/${encodeURIComponent(versionId)}/${side}`
}

function officialAssetIndexUrls(version: { assets?: string; assetIndex?: { sha1?: string } }): string[] {
  const id = version.assets?.trim()
  const sha1 = version.assetIndex?.sha1?.trim()
  if (!id || !sha1) return []
  return [
    `https://piston-meta.mojang.com/v1/packages/${sha1}/${encodeURIComponent(id)}.json`,
    `https://launchermeta.mojang.com/v1/packages/${sha1}/${encodeURIComponent(id)}.json`
  ]
}

const MAX_ASSET_INDEX_BYTES = 32 * 1024 * 1024

function assetIndexPath(resourceRoot: string, version: { assets?: string }): string | null {
  const id = version.assets?.trim()
  return id ? path.join(resourceRoot, 'assets', 'indexes', `${id}.json`) : null
}

function hashedAssetIndexPath(resourceRoot: string, sha1: string): string {
  return path.join(resourceRoot, 'assets', 'indexes', `${sha1}.json`)
}

async function validAssetIndex(filePath: string, expectedSha1: string): Promise<boolean> {
  try {
    if ((await fs.stat(filePath)).size < 1) return false
    if ((await sha1File(filePath)) !== expectedSha1.toLowerCase()) return false
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { objects?: unknown }
    return Boolean(parsed && parsed.objects && typeof parsed.objects === 'object' && !Array.isArray(parsed.objects))
  } catch {
    return false
  }
}

/** XMCL stores the verified index under its hash; launches use the named alias. */
async function reuseAssetIndex(version: { assets?: string; assetIndex?: { sha1?: string } }, resourceRoot: string): Promise<boolean> {
  const expectedSha1 = version.assetIndex?.sha1?.trim().toLowerCase()
  const destination = assetIndexPath(resourceRoot, version)
  if (!expectedSha1 || !destination) return false
  const hashedDestination = hashedAssetIndexPath(resourceRoot, expectedSha1)
  if (await validAssetIndex(destination, expectedSha1)) {
    if (!(await validAssetIndex(hashedDestination, expectedSha1))) await fs.copyFile(destination, hashedDestination)
    return true
  }
  if (await validAssetIndex(hashedDestination, expectedSha1)) {
    await fs.copyFile(hashedDestination, destination)
    return true
  }
  return false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function ensureAssetIndex(
  version: { assets?: string; assetIndex?: { sha1?: string } },
  resourceRoot: string,
  signal?: AbortSignal
): Promise<void> {
  const expectedSha1 = version.assetIndex?.sha1?.trim().toLowerCase()
  const destination = assetIndexPath(resourceRoot, version)
  if (!expectedSha1 || !destination) return
  const hashedDestination = hashedAssetIndexPath(resourceRoot, expectedSha1)
  if (await reuseAssetIndex(version, resourceRoot)) return

  await fs.rm(destination, { force: true }).catch(() => undefined)
  await fs.rm(hashedDestination, { force: true }).catch(() => undefined)
  const pending = `${destination}.pending-${process.pid}-${Date.now()}`
  const pendingHash = `${hashedDestination}.pending-${process.pid}-${Date.now()}`
  const failures: string[] = []
  for (const url of officialAssetIndexUrls(version)) {
    try {
      const response = await domesticMinecraftFetch(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length < 1 || body.length > MAX_ASSET_INDEX_BYTES) throw new Error(`invalid response size: ${body.length}`)
      const actualSha1 = createHash('sha1').update(body).digest('hex')
      if (actualSha1 !== expectedSha1) throw new Error(`SHA1 mismatch: expected ${expectedSha1}, got ${actualSha1}`)
      const parsed = JSON.parse(body.toString('utf8')) as { objects?: unknown }
      if (!parsed || !parsed.objects || typeof parsed.objects !== 'object' || Array.isArray(parsed.objects)) {
        throw new Error('asset index JSON does not contain an objects map')
      }
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(pending, body, { flag: 'w' })
      await fs.rename(pending, destination)
      await fs.writeFile(pendingHash, body, { flag: 'w' })
      await fs.rename(pendingHash, hashedDestination)
      diagnosticJournal.record({
        subsystem: 'minecraft-download',
        operation: 'asset-index',
        phase: 'success',
        message: 'Minecraft asset index downloaded and verified',
        data: { url, destination, bytes: body.length, sha1: actualSha1 }
      })
      return
    } catch (error) {
      if (signal?.aborted) throw abortError()
      const detail = errorMessage(error)
      failures.push(`${url}: ${detail}`)
      diagnosticJournal.record({
        subsystem: 'minecraft-download',
        operation: 'asset-index',
        phase: 'error',
        level: 'warning',
        message: 'Minecraft asset index request failed',
        data: { url, destination },
        error
      })
      await fs.rm(pending, { force: true }).catch(() => undefined)
      await fs.rm(pendingHash, { force: true }).catch(() => undefined)
    }
  }
  const detail = failures.join('; ')
  const error = new Error(`Minecraft asset index download failed${detail ? `: ${detail}` : ''}`)
  throw error
}

async function domesticMinecraftFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const timeout = AbortSignal.timeout(90_000)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const startedAt = Date.now()
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  try {
    const response = await net.fetch(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input,
      {...init, signal} as any
    ) as unknown as Response
    const durationMs = Date.now() - startedAt
    if (!response.ok || durationMs >= 5_000) {
      diagnosticJournal.record({
        subsystem: 'minecraft-download',
        operation: 'fetch',
        phase: response.ok ? 'slow-response' : 'http-error',
        level: response.ok ? 'warning' : 'error',
        message: `${response.ok ? 'Slow' : 'Failed'} Minecraft request: HTTP ${response.status}`,
        durationMs,
        data: { url, status: response.status, redirected: response.redirected, responseUrl: response.url }
      })
    }
    return response
  } catch (error) {
    diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'fetch', phase: 'error', message: 'Minecraft network request failed', durationMs: Date.now() - startedAt, data: { url }, error })
    throw error
  }
}

function minecraftAssetHosts(attempt: number): string[] {
  return attempt % 2 === 1 ? MINECRAFT_ASSET_HOSTS : [MINECRAFT_ASSET_HOSTS[1], MINECRAFT_ASSET_HOSTS[0]]
}

function minecraftMavenHosts(attempt: number): string[] {
  return attempt % 2 === 1
    ? MINECRAFT_MAVEN_HOSTS
    : [MINECRAFT_MAVEN_HOSTS[1], MINECRAFT_MAVEN_HOSTS[0], MINECRAFT_MAVEN_HOSTS[2]]
}

export function multiplayerLaunchOptions(version: string, server: { ip: string; port: number }): { server?: typeof server; quickPlayMultiplayer?: string } {
  const [major, minor] = version.split('.').map(Number)
  return major > 1 || (major === 1 && minor >= 20)
    ? { quickPlayMultiplayer: `${server.ip}:${server.port}` }
    : { server }
}

function managedLoaderApiName(project: ProjectInfo): string {
  const api = project.loader === 'quilt' ? 'quilted-fabric-api' : 'fabric-api'
  return `modmind-managed-${api}.jar`
}

function summarizeMinecraftCrash(report: string): string {
  const lines = report.split(/\r?\n/)
  const description = lines.find((line) => line.startsWith('Description:'))
  const entrypoint = lines.find((line) => line.includes('Could not execute entrypoint'))
  const causes = lines.filter((line) => line.startsWith('Caused by:'))
  const rootCause = causes.at(-1)
  const modFrames = lines
    .filter((line) => /^\s*at (?:knot\/\/)?dev\.modmind\./.test(line))
    .slice(0, 6)
    .map((line) => line.trim())
  const diagnostic = rootCause?.includes("This registry can't create intrusive holders")
    ? 'DIAGNOSTIC HINT: Check registration timing and compatible registry lifecycle support for this Minecraft version. Fabric API may be supplied externally or through the required jar-in-jar modules; this error alone does not prove the full Fabric API is required. Inspect the artifact and loaded modules before changing dependencies.'
    : undefined
  return [description, entrypoint, rootCause, ...modFrames, diagnostic].filter(Boolean).join('\n')
}

async function replaceModArtifact(source: string, target: string, loader: LoaderKind, importedPack = false): Promise<void> {
  const pending = `${target}.pending`
  const backup = `${target}.backup`

  // Recover an interrupted swap before attempting another deployment.
  if (!(await exists(target)) && (await exists(backup))) await fs.rename(backup, target)
  await fs.rm(pending, { force: true })
  await fs.copyFile(source, pending)
  await validateModArtifact(pending, loader, source, importedPack)

  let backedUp = false
  try {
    await fs.rm(backup, { force: true })
    if (await exists(target)) {
      await fs.rename(target, backup)
      backedUp = true
    }
    await fs.rename(pending, target)
    await fs.rm(backup, { force: true })
  } catch (error) {
    await fs.rm(pending, { force: true }).catch(() => undefined)
    if (backedUp && !(await exists(target)) && (await exists(backup))) {
      await fs.rename(backup, target).catch(() => undefined)
    }
    throw error
  }
}

async function fetchCompatibleJavaRuntimeManifest(target: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const dispatcher = minecraftDownloadDispatcher()
  const abort = (): void => { void dispatcher.destroy().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await fetchJavaRuntimeManifest({ target: target as JavaRuntimeTargetType, dispatcher })
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    await dispatcher.close()
  }
}

export function runtimeDownloadError(error: unknown, depth = 0): string {
  if (depth >= 5) return error instanceof Error ? error.message : String(error)
  if (error instanceof AggregateError) return error.errors.slice(0, 8).map(cause => runtimeDownloadError(cause, depth + 1)).join('; ') || error.message
  if (error instanceof Error) {
    const destination = (error as Error & { destination?: unknown }).destination
    const cause = error.cause ? runtimeDownloadError(error.cause, depth + 1) : ''
    return [typeof destination === 'string' ? destination : '', error.message || error.name, cause].filter(Boolean).join(': ')
  }
  return String(error)
}

function offlineUuid(username: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

function abortError(message = 'Minecraft 操作已取消'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' })
}

async function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) throw abortError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function sha256File(filePath: string): Promise<{ size: number; sha256: string }> {
  try {
    return await retryTransientFileLock(async () => {
      const stat = await fs.stat(filePath)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
      return { size: stat.size, sha256: hash.digest('hex') }
    })
  } catch (error) {
    if (isTransientFileLockError(error)) throw lockedFileReadError(filePath, error)
    throw error
  }
}

async function sha1File(filePath: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function readConfiguredLoaderVersion(project: ProjectInfo): Promise<string | undefined> {
  const propertiesPath = path.join(project.path, 'gradle.properties')
  const content = await fs.readFile(propertiesPath, 'utf8').catch(() => '')
  const value = content.match(/^(?:loader_version|forge_version|neo_version|neoforge_version)\s*=\s*([^\s#]+)\s*$/m)?.[1]
  return value && /^[0-9A-Za-z.+_-]+$/.test(value) ? value : undefined
}

async function readConfiguredLoaderApiVersion(project: ProjectInfo): Promise<string | undefined> {
  const content = await fs.readFile(path.join(project.path, 'gradle.properties'), 'utf8').catch(() => '')
  const properties = project.loader === 'quilt' ? ['qfapi_version'] : ['fabric_api_version', 'fabric_version']
  const value = properties.map((property) => content.match(new RegExp(`^${property}\\s*=\\s*([^\\s#]+)\\s*$`, 'm'))?.[1]).find(Boolean)
  return value && /^[0-9A-Za-z.+_-]+$/.test(value) ? value : undefined
}

export class MinecraftRuntimeManager extends BuildRuntimeManager {
  private backgroundGameControl: BackgroundGameControlSession | null = null

  getBackgroundGameControl(): BackgroundGameControlSession {
    const project = this.requireProject()
    if (!this.backgroundGameControl || !this.process) throw new Error('当前测试实例未启用后台控制')
    this.backgroundGameControl.assertProject(project.path)
    return this.backgroundGameControl
  }

  // This override is bundled in testing.mmfeature, so released preview.4 hosts
  // receive the fix without replacing their shared BuildRuntimeManager.
  protected override gradleEnvironment(runtime: GradleRuntimeSelection): NodeJS.ProcessEnv {
    const environment = super.gradleEnvironment(runtime)
    return { ...environment, JAVA_TOOL_OPTIONS: boundedGradleJavaOptions(environment.JAVA_TOOL_OPTIONS) }
  }

  buildRecoveryState() {
    return { status: this.buildPromise ? 'running' : 'idle', canCancel: Boolean(this.buildController), state: this.getState(), networkTimeouts: GRADLE_NETWORK_TIMEOUTS, appliesTo: 'new-build-java-processes' }
  }

  async cancelBuild() {
    const active = this.buildPromise
    if (!active) return { status: 'idle', state: this.getState() }
    this.buildController?.abort()
    if (this.buildProcess) await stopProcessTree(this.buildProcess)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([active.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })])
    } finally { if (timer) clearTimeout(timer) }
    return { status: this.buildPromise === active ? 'cancelling' : 'cancelled', state: this.getState() }
  }

  async ensureServerTestJava(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return (await this.ensureJava(this.requireProject(), signal)).javaPath
  }
  isBusy(): boolean { return Boolean(this.process || this.preparePromise || this.buildPromise || this.verificationProcess) }
managedMinecraftDirectory(): string {
    return this.resourceRoot()
  }

async refresh(): Promise<MinecraftRuntimeState> {
    const project = this.requireProject()
    if (this.stateProjectPath && !sameProjectPath(this.stateProjectPath, project.path)
      && (this.state.running || Boolean(this.process) || Boolean(this.preparePromise) || Boolean(this.buildPromise) || Boolean(this.verificationProcess))) {
      return this.getState()
    }
    if (!isJavaLoader(project.loader)) {
      const mods = await this.listMods()
      this.updateState({
        minecraftVersion: project.minecraftVersion,
        loader: project.loader,
        installed: true,
        running: false,
        mods,
        message: project.loader === 'bedrock' ? '基岩 Add-On 工程已就绪' : '网易 Mod SDK 工程已就绪'
      })
      return this.getState()
    }
    const metadata = await this.readMetadata(project)
    const mods = await this.listMods()
    const lastCrash = this.state.lastCrash ?? (await this.readLatestCrash(project, 0))
    this.updateState({
      minecraftVersion: project.minecraftVersion,
      loader: project.loader,
      instancePath: this.instanceRoot(project),
      installed: Boolean(metadata),
      loaderVersionId: metadata?.loaderVersionId,
      fabricVersionId: metadata?.fabricVersionId,
      loaderVersion: metadata?.loaderVersion,
      javaPath: metadata?.javaPath,
      mods,
      lastCrash
    })
    return this.getState()
  }

  prepare(signal?: AbortSignal): Promise<MinecraftRuntimeState> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.preparePromise) return waitWithAbort(this.preparePromise, signal)
    const controller = new AbortController()
    const generation = ++this.prepareGeneration
    this.prepareController = controller
    const forwardAbort = (): void => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    this.preparePromise = this.prepareInternal(controller.signal, generation)
      .catch((error: unknown) => {
        if (this.prepareGeneration === generation) this.prepareGeneration += 1
        const message = downloadFailureText(error)
        diagnosticJournal.record({
          subsystem: 'minecraft',
          operation: 'prepare',
          phase: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error',
          message,
          error
        })
        if (error instanceof Error && error.name === 'AbortError') {
          this.updateState({ stage: 'idle', running: false, message: 'Minecraft 准备已取消' })
          throw error
        }
        this.updateState({ stage: 'error', message })
        this.onEvent({ stage: 'error', message, level: 'error', time: new Date().toISOString() })
        throw error
      })
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort)
        if (this.prepareController === controller) this.prepareController = null
        this.preparePromise = null
      })
    return waitWithAbort(this.preparePromise, signal)
  }

async cancelPreparation(): Promise<MinecraftRuntimeState> {
    const active = this.preparePromise
    this.prepareController?.abort()
    if (active) await active.catch(() => undefined)
    return this.getState()
  }

async launch(options: MinecraftLaunchOptions, signal?: AbortSignal): Promise<MinecraftRuntimeState> {
    const project = this.requireProject()
    const withoutProjectMod = options.withoutProjectMod === true
    if (withoutProjectMod && (project.kind === 'modpack' || !isJavaLoader(project.loader))) throw new Error('仅启动游戏只适用于 Java Mod 项目')
    if (!this.vanillaClient && !isJavaLoader(project.loader)) {
      throw new Error(project.loader === 'bedrock'
        ? '国际基岩版需要安装版 Minecraft 客户端；请先构建 .mcaddon 并导入游戏。自动本地部署将在后续设备集成中提供'
        : '网易版必须通过官方开发者工作台启动 PC 或手机测试，ModMind 不能绕过工作台与账号授权')
    }
    if (this.process && this.state.running) throw new Error('Minecraft 测试实例已经在运行')
    const username = options.username.trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('离线用户名需要 3-16 个字母、数字或下划线')
    if (!Number.isInteger(options.maxMemoryMb) || options.maxMemoryMb < 1024 || options.maxMemoryMb > 16384) {
      throw new Error('最大内存需要在 1024-16384 MB 之间')
    }
    const width = options.width ?? 1280, height = options.height ?? 720
    if (!Number.isInteger(width) || width < 640 || width > 3840 || !Number.isInteger(height) || height < 360 || height > 2160) {
      throw new Error('游戏窗口尺寸需在 640×360 至 3840×2160 之间')
    }
    const extraJVMArgs = validateJvmArguments(options.extraJVMArgs)
    if (options.backgroundControl !== undefined && typeof options.backgroundControl !== 'boolean') throw new Error('后台控制选项无效')

    if (!this.vanillaClient && project.kind !== 'modpack' && !withoutProjectMod) {
      const syncedArtifact = path.join(this.modsRoot(project), projectArtifactName(project))
      if (!(await exists(syncedArtifact))) throw new Error('测试实例中没有已同步的项目 Mod，请先点击“构建并同步”')
      await validateModArtifact(syncedArtifact, project.loader)
    } else if (!this.vanillaClient && project.kind === 'modpack') {
      const manifest = await assertModpackDependenciesReady(project)
      const synced = await fs.readFile(path.join(this.instanceRoot(project), 'modmind-pack-sync.json'), 'utf8')
        .then((value) => JSON.parse(value) as { files?: unknown })
        .catch(() => null)
      if (!synced || !Array.isArray(synced.files)) throw new Error('整合包尚未同步，请先点击“同步整合包”')
      // Validate the files that will actually run, even when a previous sync receipt exists.
      const mods = await this.listMods()
      const installedNames = new Set(mods.map(mod => mod.name.toLowerCase()))
      if (synced.files.some(name => !isSafeModJarFileName(name) || !installedNames.has(name.toLowerCase()))) {
        throw new Error('测试实例缺少已同步的整合包 Mod 或同步记录无效，请重新同步整合包')
      }
      const connectorBridge = await hasConnectorBridge(mods.map(mod => mod.path), project.loader)
      for (const mod of mods) {
        signal?.throwIfAborted()
        const warnings = await validateRuntimeModArtifact(mod.path, project.loader, mod.name, true, connectorBridge)
        for (const warning of warnings) this.emit('launching', warning, 'warning')
      }
      if (!manifest.mods.length && !manifest.modules.length) this.emit('launching', '正在启动空整合包实例')
    }
    if (signal?.aborted) throw Object.assign(new Error('Minecraft 启动已取消'), { name: 'AbortError' })
    await this.prepare(signal)
    const metadata = await this.readMetadata(project)
    if (!metadata) throw new Error('Minecraft 测试实例尚未准备完成')
    const launchJavaPath = await this.resolveLaunchJava(project, metadata)
    signal?.throwIfAborted()

    const instanceRoot = this.instanceRoot(project)
    const gameDirectory = gameDirectoryForLaunch(instanceRoot, withoutProjectMod)
    await fs.mkdir(gameDirectory, { recursive: true })
    if (!this.vanillaClient) await prepareLegacyForgeJavaCompatibility(project.loader, project.minecraftVersion, gameDirectory)
    await applyNarratorPreference(gameDirectory, options.disableNarrator !== false)
    this.stopRequested = false
    this.updateState({ lastCrash: undefined })
    this.emit('launching', withoutProjectMod ? '正在启动不加载项目 Mod 的游戏' : '正在生成离线启动参数')
    const launchedAt = Date.now()
    let child: ChildProcess
    const backgroundControl = options.backgroundControl === true ? await BackgroundGameControlSession.prepare(project.path, gameDirectory) : null
    const launchJVMArgs = backgroundControl ? backgroundControl.jvmArguments(extraJVMArgs, project.loader) : extraJVMArgs
    try {
      child = await launch({
        spawn: (command, args, options) => {
          signal?.throwIfAborted()
          if (!backgroundControl && !this.minecraftMcpPort) return spawnManaged(command, [...(args ?? [])], options ?? {})
          const environment = managedJavaEnvironment(options?.env ?? process.env)
          if (this.minecraftMcpPort) environment.MC_MCP_PORT = String(this.minecraftMcpPort)
          return spawnManaged(command, [...(args ?? [])], {
            ...options,
            env: backgroundControl ? backgroundControl.environment(environment) : environment
          })
        },
        gamePath: gameDirectory,
        resourcePath: this.resourceRoot(),
        version: metadata.loaderVersionId,
        javaPath: launchJavaPath,
        gameProfile: { name: username, id: offlineUuid(username) },
        accessToken: '0',
        userType: 'legacy',
        launcherName: 'ModMind',
        launcherBrand: 'ModMind',
        minMemory: Math.min(512, options.maxMemoryMb),
        maxMemory: options.maxMemoryMb,
        resolution: { width, height },
        ...(launchJVMArgs.length ? { extraJVMArgs: launchJVMArgs } : {}),
        ...(options.server ? multiplayerLaunchOptions(project.minecraftVersion, options.server) : {}),
        extraExecOption: { cwd: gameDirectory, windowsHide: backgroundControl ? backgroundGameWindowsHide(project.minecraftVersion) : false }
      })
    } catch (error) {
      await backgroundControl?.dispose()
      const message = error instanceof Error ? error.message : String(error)
      const detail = /spawn\s+unknown/i.test(message)
        ? `${message}\nJava: ${launchJavaPath}\n实例目录：${instanceRoot}\nLoader：${metadata.loaderVersionId}`
        : message
      this.updateState({ stage: 'error', running: false, message: detail })
      this.onEvent({ stage: 'error', message: detail, level: 'error', time: new Date().toISOString() })
      if (detail !== message) throw new Error(detail, { cause: error })
      throw error
    }
    this.process = child
    if (backgroundControl) {
      try { backgroundControl.bind(child); this.backgroundGameControl = backgroundControl }
      catch (error) { this.killProcessTree(child); await backgroundControl.dispose(); throw error }
      const clear = (): void => { if (this.backgroundGameControl === backgroundControl) this.backgroundGameControl = null }
      child.once('exit', clear)
      child.once('error', clear)
    }
    const launcherLog = createWriteStream(path.join(gameDirectory, 'launcher-console.log'), { flags: 'w' })
    let transcriptFailure = ''
    const logFinished = finished(launcherLog).catch(() => undefined)
    launcherLog.on('error', error => {
      transcriptFailure = `Minecraft 日志写入失败：${error.message}`
      child.stdout?.unpipe(launcherLog)
      child.stderr?.unpipe(launcherLog)
      this.updateState({ stage: 'error', running: false, message: transcriptFailure })
      this.emit('error', transcriptFailure, 'error')
      this.killProcessTree(child)
    })
    child.stdout?.pipe(launcherLog, { end: false })
    child.stderr?.pipe(launcherLog, { end: false })
    child.stdout?.on('data', (chunk: Buffer) => this.emit('running', chunk.toString('utf8').trim(), 'info', false))
    child.stderr?.on('data', (chunk: Buffer) => this.emit('running', chunk.toString('utf8').trim(), 'warning', false))
    child.once('spawn', () => {
      if (transcriptFailure) { this.killProcessTree(child); return }
      this.updateState({ stage: 'running', running: true, pid: child.pid, instancePath: gameDirectory, mods: withoutProjectMod ? [] : this.state.mods, message: withoutProjectMod ? 'Minecraft 游戏运行中（未加载项目 Mod）' : 'Minecraft 测试实例运行中' })
      this.emit('running', `Minecraft 已启动，进程 ID ${child.pid ?? '-'}`)
    })
    child.once('error', (error) => {
      this.process = null
      launcherLog.end()
      this.updateState({ stage: 'error', running: false, pid: undefined, message: error.message })
      this.emit('error', error.message, 'error')
    })
    child.once('close', (code, signal) => {
      this.process = null
      const intentionallyStopped = this.stopRequested
      if (!launcherLog.destroyed && !launcherLog.writableEnded) launcherLog.end()
      void logFinished.then(() => {
        if (transcriptFailure) {
          this.updateState({ stage: 'error', running: false, pid: undefined, message: transcriptFailure })
          return
        }
        return this.handleMinecraftExit(project, launchedAt, code, signal, intentionallyStopped, gameDirectory)
      }).catch(error => this.emit('error', error instanceof Error ? error.message : String(error), 'error'))
    })
    return this.getState()
  }

async testLaunch(options: MinecraftLaunchOptions, stableWindowMs = 20_000, signal?: AbortSignal): Promise<MinecraftLaunchTestResult> {
    await this.launch(options, signal)
    const deadline = Date.now() + stableWindowMs
    this.emit('running', `正在验证 Minecraft 启动稳定性（${Math.round(stableWindowMs / 1000)} 秒）`)
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.stop()
        throw Object.assign(new Error('Minecraft 验证已取消'), { name: 'AbortError' })
      }
      if (!this.process) {
        const crashDeadline = Date.now() + 3_000
        while (!this.state.lastCrash && Date.now() < crashDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return { success: false, state: this.getState(), crash: this.state.lastCrash }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!this.process || !this.state.running) {
      return { success: false, state: this.getState(), crash: this.state.lastCrash }
    }
    this.emit('running', 'Minecraft 已通过启动稳定性验证')
    return { success: true, state: this.getState() }
  }

async stop(): Promise<MinecraftRuntimeState> {
    await this.backgroundGameControl?.release().catch(() => undefined)
    await this.cancelPreparation()
    this.buildController?.abort()
    await this.backgroundGameControl?.release().catch(() => undefined)
    const active = this.process
    const activeBuild = this.buildProcess
    const activeVerification = this.verificationProcess
    if (active && !active.killed) {
      this.stopRequested = true
      this.killProcessTree(active)
    }
    if (this.buildProcess && !this.buildProcess.killed) this.killProcessTree(this.buildProcess)
    if (this.verificationProcess && !this.verificationProcess.killed) this.killProcessTree(this.verificationProcess)
    await Promise.all([active, activeBuild, activeVerification].filter((child): child is ChildProcess => Boolean(child)).map(stopProcessTree))
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const minecraftStopping = Boolean(active && this.process === active)
      const buildStopping = Boolean(activeBuild && this.buildProcess === activeBuild)
      const verificationStopping = Boolean(activeVerification && this.verificationProcess === activeVerification)
      if (!minecraftStopping && !buildStopping && !verificationStopping) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return this.getState()
  }

async testGradleTask(candidates: string[], stableWindowMs = 0, signal?: AbortSignal): Promise<GradleVerificationResult> {
    const project = this.requireProject()
    if (!isJavaLoader(project.loader)) return { skipped: true, success: true, summary: `${platformLabel(project.loader)} 不使用 Gradle 运行任务` }
    if (project.kind === 'modpack') return { skipped: true, success: true, summary: '整合包没有统一的 Gradle 运行任务；请使用客户端启动测试' }
    if (this.process || this.verificationProcess || this.buildPromise) throw new Error('已有 Minecraft、构建或验证任务正在运行')
    await this.authorizeBuild?.(project)
    return this.testGradleTaskAttempt(project, candidates, stableWindowMs, signal, 0, 0)
  }

  private async testGradleTaskAttempt(project: ProjectInfo, candidates: string[], stableWindowMs: number, signal: AbortSignal | undefined, toolchainRetryAttempt: number, distributionRetryAttempt: number): Promise<GradleVerificationResult> {
    if (signal?.aborted) throw Object.assign(new Error('Gradle 验证已取消'), { name: 'AbortError' })
    await this.prepareGradleMavenFallback(project, signal, distributionRetryAttempt > 0)
    await this.prepareGradleWrapperDownload(project, 0, signal)
    const runtime = await this.gradleRuntime(project, signal)
    const env = this.gradleEnvironment(runtime)
    if (signal?.aborted) throw Object.assign(new Error('Gradle 验证已取消'), { name: 'AbortError' })
    const taskLogDirectory = path.join(project.path, projectDataDirectory(project), 'builds')
    await fs.mkdir(taskLogDirectory, { recursive: true }).catch(() => undefined)
    const taskLogPath = path.join(taskLogDirectory, `gradle-tasks-${Date.now()}-${randomUUID()}.log`)
    const taskList = this.spawnGradle(runtime, project, ['tasks', '--all', '--console=plain', '--no-daemon'], env)
    const taskDiagnostics = (this.watchGradleDiagnostics?.bind(this) ?? watchGradleBuild)({ child: taskList, projectPath: project.path, dataRoot: path.join(project.path, projectDataDirectory(project)), javaHome: runtime.javaHome, gradleUserHome: env.GRADLE_USER_HOME!, logPath: taskLogPath })
    this.verificationProcess = taskList
    const abortTaskList = (): void => this.killProcessTree(taskList)
    signal?.addEventListener('abort', abortTaskList, { once: true })
    if (signal?.aborted) abortTaskList()
    let taskOutput = ''
    taskList.stdout.on('data', (chunk: Buffer) => { taskDiagnostics.output(); if (taskOutput.length < 2_000_000) taskOutput += chunk.toString('utf8') })
    taskList.stderr.on('data', (chunk: Buffer) => { taskDiagnostics.output(); if (taskOutput.length < 2_000_000) taskOutput += chunk.toString('utf8') })
    let taskSpawnError = ''
    taskList.once('error', (error) => { taskSpawnError = `${error.name}: ${error.message}` })
    const taskExit = await new Promise<number>((resolve) => {
      taskList.once('close', (code) => resolve(normalizeProcessExitCode(code) ?? 1))
    })
    await fs.writeFile(taskLogPath, taskOutput).catch(() => undefined)
    await taskDiagnostics.finish(taskExit, signal?.aborted === true)
    signal?.removeEventListener('abort', abortTaskList)
    this.verificationProcess = null
    if (signal?.aborted) throw Object.assign(new Error('Gradle 验证已取消'), { name: 'AbortError' })
    if (taskExit !== 0) {
      const recovered = await this.retryGradleVerification(project, taskOutput, signal, toolchainRetryAttempt, distributionRetryAttempt)
      if (recovered) return this.testGradleTaskAttempt(project, candidates, stableWindowMs, signal, recovered.toolchainRetryAttempt, recovered.distributionRetryAttempt)
      throw new Error(`无法读取 Gradle 任务${taskSpawnError ? `：Wrapper 启动失败：${taskSpawnError}` : `：${summarizeGradleFailure(taskOutput)}`}`)
    }
    const task = candidates.find((candidate) => new RegExp(`^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(taskOutput))
    if (!task) return { skipped: true, success: true, summary: `项目没有提供 ${candidates.join(' / ')} 任务` }

    // Loom uses run for both sides; Forge/NeoForge templates use separate directories.
    for (const directory of new Set(['run', gradleRunDirectory(task)])) {
      const runDirectory = path.join(project.path, directory)
      await fs.mkdir(runDirectory, { recursive: true })
      await fs.writeFile(path.join(runDirectory, 'eula.txt'), 'eula=true\n', 'utf8')
    }
    const logDirectory = path.join(project.path, projectDataDirectory(project), 'builds')
    await fs.mkdir(logDirectory, { recursive: true })
    const logPath = path.join(logDirectory, `${task}-${Date.now()}.log`)
    const log = createWriteStream(logPath, { flags: 'w' })
    this.emit('testing-server', `正在执行 Gradle ${task}`)
    const preparationTasks = ['runClient', 'runServer', 'runGameTestServer'].includes(task)
      ? ['processResources', 'classes']
      : []
    const child = this.spawnGradle(runtime, project, [...preparationTasks, task, '--console=plain', '--no-daemon', '--stacktrace'], env)
    const diagnostics = (this.watchGradleDiagnostics?.bind(this) ?? watchGradleBuild)({ child, projectPath: project.path, dataRoot: path.join(project.path, projectDataDirectory(project)), javaHome: runtime.javaHome, gradleUserHome: env.GRADLE_USER_HOME!, logPath })
    child.once('close', code => { void diagnostics.finish(normalizeProcessExitCode(code), signal?.aborted === true) })
    this.verificationProcess = child
    let output = ''
    let readyAt = 0
    let executionStartedAt = 0
    const capture = (chunk: Buffer, level: MinecraftRuntimeEvent['level']): void => {
      diagnostics.output()
      const text = chunk.toString('utf8')
      log.write(text)
      output = `${output}${text}`.slice(-200_000)
      if (new RegExp('> Task (?:[^\\s]*:)?' + task + '(?:\\s|$)').test(output)) executionStartedAt ||= Date.now()
      if (/Done \([\d.]+s\)!|For help, type "help"|Server started|Dedicated server took/i.test(output)) readyAt ||= Date.now()
      const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1)
      if (line) this.emit('testing-server', line, level, false)
    }
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'info'))
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'warning'))
    let exitCode: number | null = null
    let spawnError = ''
    child.once('error', (error) => { spawnError = `${error.name}: ${error.message}` })
    child.once('close', (code) => { exitCode = normalizeProcessExitCode(code) ?? 1 })
    const abort = (): void => this.killProcessTree(child)
    signal?.addEventListener('abort', abort, { once: true })
    const executionBudgetMs = stableWindowMs ? 5 * 60_000 : 10 * 60_000
    while (exitCode === null && (!executionStartedAt || Date.now() - executionStartedAt < executionBudgetMs)) {
      if (signal?.aborted) break
      if (stableWindowMs && readyAt && Date.now() - readyAt >= stableWindowMs) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const reachedStableWindow = Boolean(exitCode === null && stableWindowMs && readyAt && Date.now() - readyAt >= stableWindowMs)
    if (exitCode === null) this.killProcessTree(child)
    const stopDeadline = Date.now() + 5_000
    while (exitCode === null && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
    signal?.removeEventListener('abort', abort)
    this.verificationProcess = null
    await new Promise<void>((resolve) => log.end(resolve))
    if (signal?.aborted) throw Object.assign(new Error(`${task} 已取消`), { name: 'AbortError' })
    if (reachedStableWindow || (!stableWindowMs && exitCode === 0)) {
      this.emit('idle', `${task} 验证通过`)
      return { task, skipped: false, success: true, summary: reachedStableWindow ? `服务端就绪后稳定运行 ${Math.round(stableWindowMs / 1000)} 秒` : `${task} 执行成功`, logPath }
    }
    if (exitCode !== null && exitCode !== 0) {
      const recovered = await this.retryGradleVerification(project, output, signal, toolchainRetryAttempt, distributionRetryAttempt)
      if (recovered) return this.testGradleTaskAttempt(project, candidates, stableWindowMs, signal, recovered.toolchainRetryAttempt, recovered.distributionRetryAttempt)
    }
    const detail = spawnError ? `无法启动 Gradle Wrapper：${spawnError}` : summarizeGradleFailure(output)
    this.emit('error', `${task} 验证失败`, 'error')
    return { task, skipped: false, success: false, summary: detail || (exitCode === null ? `${task} 超时` : `${task} 退出代码 ${exitCode}`), logPath }
  }

  private async retryGradleVerification(project: ProjectInfo, logText: string, signal: AbortSignal | undefined, toolchainRetryAttempt: number, distributionRetryAttempt: number): Promise<{ toolchainRetryAttempt: number; distributionRetryAttempt: number } | null> {
    if (signal?.aborted) return null
      if (toolchainRetryAttempt < 4 && await this.ensureDetectedBuildToolchains(logText, project, signal)) {
      this.emit('testing-server', '已根据验证日志补齐工具链，正在重试 Gradle 任务', 'warning')
      return { toolchainRetryAttempt: toolchainRetryAttempt + 1, distributionRetryAttempt }
    }
    if (distributionRetryAttempt < 2 && (isGradleNetworkFailure(logText) || distributionRetryAttempt === 0 && isManagedRepositoryFailure(logText))) {
      this.emit('testing-server', 'Gradle 下载或依赖镜像暂时不可用，正在使用备用源与项目原仓库重试', 'warning')
      if (isGradleNetworkFailure(logText)) await this.prepareGradleWrapperDownload(project, distributionRetryAttempt + 1, signal)
      return { toolchainRetryAttempt, distributionRetryAttempt: distributionRetryAttempt + 1 }
    }
    return null
  }

async syncProjectMod(): Promise<MinecraftManagedMod | null> {
    const project = this.requireProject()
    if (!isJavaLoader(project.loader)) return (await this.listMods())[0] ?? null
    if (this.process && this.state.running) {
      throw new Error('Minecraft 测试实例正在运行。请先停止测试，再同步项目模组；运行中的 JAR 不允许被覆盖')
    }
    const buildDirectory = path.join(project.path, 'build', 'libs')
    if (!(await exists(buildDirectory))) {
      this.emit('syncing-mod', '未发现 build/libs，启动时将保留现有项目 JAR', 'warning')
      return null
    }
    const entries = await fs.readdir(buildDirectory, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jar') && !/(sources|javadoc|dev|shadow)/i.test(entry.name))
        .map(async (entry) => {
          const source = path.join(buildDirectory, entry.name)
          return { source, stat: await fs.stat(source) }
        })
    )
    const latest = candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]
    if (!latest) return null
    await validateModArtifact(latest.source, project.loader)
    const modsDirectory = this.modsRoot(project)
    await fs.mkdir(modsDirectory, { recursive: true })
    await replaceModArtifact(latest.source, path.join(modsDirectory, projectArtifactName(project)), project.loader)
    this.emit('syncing-mod', `已同步项目模组：${path.basename(latest.source)}`)
    const mods = await this.listMods()
    this.updateState({ mods })
    return mods.find((mod) => mod.projectArtifact) ?? null
  }

async syncModpack(): Promise<MinecraftRuntimeState> {
    const project = this.requireProject()
    if (project.kind !== 'modpack') throw new Error('The active project is not a modpack')
    if (!isJavaLoader(project.loader)) throw new Error('Only Java Edition modpacks can use the local test instance')
    if (this.process && this.state.running) throw new Error('Stop the running Minecraft test instance before syncing the modpack')

    const manifest = await assertModpackDependenciesReady(project)
    const directory = this.modsRoot(project)
    const statePath = path.join(this.instanceRoot(project), 'modmind-pack-sync.json')
    const previous: { files?: unknown; overrides?: unknown } = await fs.readFile(statePath, 'utf8')
      .then((value) => JSON.parse(value) as { files?: unknown; overrides?: unknown })
      .catch(() => ({}))
    const previousFiles = Array.isArray(previous.files)
      ? previous.files.map((value: unknown) => typeof value === 'string' ? value : (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : '')).filter((value): value is string => Boolean(value) && path.basename(value) === value)
      : []
    const previouslySynced = new Set(previousFiles.map((value) => value.toLowerCase()))
    const totalSteps = Math.max(1, (manifest.mods.length + manifest.modules.length) * 2 + 1)
    let completedSteps = 0
    const reportSync = (message: string): void => this.emitProgress('syncing-mod', message, completedSteps, totalSteps)
    reportSync(`正在校验整合包文件（0/${manifest.mods.length + manifest.modules.length}）`)

    const sources: Array<{ source: string; targetName: string; integrity: { size: number; sha256: string } }> = []
    const missingManaged: string[] = []
    for (const mod of manifest.mods) {
      const source = path.join(modpackModsRoot(project, manifest), mod.fileName)
      if (!(await exists(source))) {
        missingManaged.push(mod.fileName)
        continue
      }
      const actual = await sha256File(source)
      if (actual.size !== mod.size || actual.sha256 !== mod.sha256) throw new Error(`整合包 Mod ${mod.fileName} 已被修改，请更新清单后再同步`)
      sources.push({ source, targetName: mod.fileName, integrity: actual })
      completedSteps += 1
      reportSync(`正在校验整合包文件（${completedSteps}/${manifest.mods.length + manifest.modules.length}）`)
    }
    for (const module of manifest.modules) {
      const moduleProject = await readModpackModuleProject(project, module)
      const root = moduleProject.path
      const output = path.join(root, 'build', 'libs')
      const findLatest = async (): Promise<{ source: string; stat: Awaited<ReturnType<typeof fs.stat>> } | undefined> => {
        const entries = await fs.readdir(output, { withFileTypes: true }).catch(() => [])
        const candidates = await Promise.all(entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jar') && !/(sources|javadoc|dev|shadow)/i.test(entry.name))
          .map(async (entry) => {
            const source = path.join(output, entry.name)
            return { source, stat: await fs.stat(source) }
          }))
        return candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]
      }
      let latest = await findLatest()
      if (!latest) {
        await this.authorizeBuild?.(moduleProject)
        if (!(await exists(path.join(root, 'build.gradle'))) && !(await exists(path.join(root, 'build.gradle.kts')))) {
          throw new Error(`自制 Mod ${module.name} 缺少 Gradle 构建文件`)
        }
        this.emit('building-mod', `正在构建自制 Mod：${module.name}`)
        await this.runGradleBuild(moduleProject)
        latest = await findLatest()
      }
      if (latest) {
        sources.push({ source: latest.source, targetName: `modmind-local-${module.namespace}.jar`, integrity: await sha256File(latest.source) })
        completedSteps += 1
        reportSync(`正在校验整合包文件（${completedSteps}/${manifest.mods.length + manifest.modules.length}）`)
      } else missingManaged.push(`自制 Mod ${module.name}（尚未构建）`)
    }
    if (missingManaged.length) throw new Error(`整合包缺少清单中声明的内容：${missingManaged.join('、')}`)
    const names = sources.map((entry) => entry.targetName.toLowerCase())
    if (new Set(names).size !== names.length) throw new Error('整合包中存在重复的 Mod 文件名，无法同步')

    await fs.mkdir(directory, { recursive: true })
    const staging = await fs.mkdtemp(path.join(this.instanceRoot(project), 'modmind-pack-stage-'))
    const written: string[] = []
    const staged: string[] = []
    try {
      for (const entry of sources) {
        const destination = path.join(directory, entry.targetName)
        const targetHash = await sha256File(destination).catch((error) => {
          if (isMissingFileError(error)) return null
          throw error
        })
        if (targetHash && targetHash.size === entry.integrity.size && targetHash.sha256 === entry.integrity.sha256) {
          if (!previouslySynced.has(entry.targetName.toLowerCase())) await validateModArtifact(entry.source, project.loader, entry.source, true)
          written.push(entry.targetName)
        } else {
          await replaceModArtifact(entry.source, path.join(staging, entry.targetName), project.loader, true)
          written.push(entry.targetName)
          staged.push(entry.targetName)
        }
        completedSteps += 1
        reportSync(`正在同步整合包 Mod（${completedSteps - manifest.mods.length - manifest.modules.length}/${sources.length}）`)
      }
      const currentNames = new Set(written)
      await Promise.all(previousFiles.filter((file) => !currentNames.has(file)).map((file: string) => fs.rm(path.join(directory, file), { force: true })))
      for (const name of staged) await fs.rename(path.join(staging, name), path.join(directory, name))
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    const previousOverrides = Array.isArray(previous.overrides)
      ? previous.overrides.filter((value: unknown): value is string => typeof value === 'string')
      : []
    reportSync('正在同步整合包配置与资源')
    const overrides = await syncModpackOverrides(project, this.instanceRoot(project), previousOverrides)
    completedSteps = totalSteps
    reportSync('整合包同步完成')
    await fs.mkdir(path.dirname(statePath), { recursive: true })
    await fs.writeFile(statePath, `${JSON.stringify({ files: written, overrides, artifacts: sources.map(entry => ({ name: entry.targetName, ...entry.integrity })) }, null, 2)}\n`, 'utf8')
    await recordDiagnosticArtifact(project,'pack-mods-synced',{entries:sources.flatMap(entry=>[{name:`source/${entry.targetName}`,path:entry.source},{name:`deployed/${entry.targetName}`,path:path.join(directory,entry.targetName)}]),metadata:{destinationPath:directory,removed:previousFiles.filter((file:string)=>!written.includes(file))}})
    this.emit('syncing-mod', `Synced ${written.length} modpack mods and ${overrides.length} override files`)
    await this.refresh()
    this.updateState({ stage: 'idle', message: `已同步 ${written.length} 个整合包 Mod 和 ${overrides.length} 个配置文件` })
    return this.getState()
  }

async syncKubeJsServerScripts(): Promise<{ copied: string[]; removed: string[]; reloadRequired: boolean; state: MinecraftRuntimeState }> {
    const project = this.requireProject()
    if (project.kind !== 'modpack' || !isJavaLoader(project.loader)) throw new Error('KubeJS 脚本同步仅适用于 Java 整合包')
    const statePath = path.join(this.instanceRoot(project), 'modmind-pack-sync.json')
    const synced = await fs.readFile(statePath, 'utf8').then(text => JSON.parse(text) as { files?: unknown; overrides?: unknown }).catch(() => null)
    if (!synced || !Array.isArray(synced.files) || !Array.isArray(synced.overrides) || synced.overrides.some(value => typeof value !== 'string')) {
      throw new Error('测试实例尚未完整同步；请停止游戏并先同步整合包')
    }
    const result = await syncReloadableKubeJsScripts(project, this.instanceRoot(project), synced.overrides)
    const pending = `${statePath}.pending-${process.pid}-${randomUUID()}`
    try {
      await fs.writeFile(pending, `${JSON.stringify({ ...synced, overrides: result.overrides }, null, 2)}\n`, 'utf8')
      await fs.rename(pending, statePath)
    } finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
    const changed = result.copied.length + result.removed.length > 0
    const reloadRequired = this.state.running && changed
    const message = reloadRequired
      ? `已同步 ${result.copied.length} 个 KubeJS 服务端脚本，移除 ${result.removed.length} 个；请在游戏内执行 /reload 使改动生效`
      : changed ? `KubeJS 服务端脚本同步完成：更新 ${result.copied.length} 个，移除 ${result.removed.length} 个` : 'KubeJS 服务端脚本没有变化'
    this.emit('syncing-mod', message, 'info', false)
    this.updateState({ message })
    return { copied: result.copied, removed: result.removed, reloadRequired, state: this.getState() }
  }

async importMods(filePaths: string[]): Promise<MinecraftManagedMod[]> {
    const project = this.requireProject()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 不支持导入 Java Mod JAR`)
    const destination = this.modsRoot(project)
    await fs.mkdir(destination, { recursive: true })
    for (const filePath of filePaths) {
      if (path.extname(filePath).toLowerCase() !== '.jar') continue
      const name = path.basename(filePath)
      if (name.toLowerCase() === projectArtifactName(project) || (['fabric', 'quilt'].includes(project.loader) && name.toLowerCase() === managedLoaderApiName(project))) continue
      await fs.copyFile(filePath, path.join(destination, name))
    }
    const mods = await this.listMods()
    this.updateState({ mods })
    this.emit('idle', `前置模组已更新，共 ${mods.filter((mod) => !mod.projectArtifact).length} 个`)
    return mods
  }

async removeMod(name: string): Promise<MinecraftManagedMod[]> {
    const project = this.requireProject()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 没有托管 Java Mod 列表`)
    if (name === projectArtifactName(project) || (['fabric', 'quilt'].includes(project.loader) && name === managedLoaderApiName(project)) || path.basename(name) !== name) {
      throw new Error('不能删除项目模组、托管依赖或无效路径')
    }
    const target = path.join(this.modsRoot(project), name)
    if (path.dirname(target) !== this.modsRoot(project)) throw new Error('无效的模组路径')
    await fs.rm(target, { force: true })
    const mods = await this.listMods()
    this.updateState({ mods })
    return mods
  }

async listMods(): Promise<MinecraftManagedMod[]> {
    if (this.vanillaClient) return []
    const project = this.requireProject()
    if (project.kind === 'server-plugin') return findPluginArtifact(project).then(artifact => [artifact]).catch(() => [])
    if (!isJavaLoader(project.loader)) {
      const output = path.join(project.path, 'build')
      const entries = await fs.readdir(output, { withFileTypes: true }).catch(() => [])
      const suffix = project.loader === 'bedrock' ? '.mcaddon' : '.zip'
      const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map(async (entry) => {
        const absolute = path.join(output, entry.name)
        const stat = await fs.stat(absolute)
        return { name: entry.name, path: absolute, size: stat.size, modifiedAt: stat.mtime.toISOString(), projectArtifact: true }
      }))
      return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    }
    const directory = this.modsRoot(project)
    await fs.mkdir(directory, { recursive: true })
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const mods = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
        .map(async (entry): Promise<MinecraftManagedMod> => {
          const filePath = path.join(directory, entry.name)
          const stat = await fs.stat(filePath)
          return {
            name: entry.name,
            path: filePath,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            projectArtifact: entry.name === projectArtifactName(project)
          }
        })
    )
    return mods.sort((a, b) => Number(b.projectArtifact) - Number(a.projectArtifact) || a.name.localeCompare(b.name))
  }

destroy(): void {
    if (this.process) void stopProcessTree(this.process)
    if (this.buildProcess && !this.buildProcess.killed) this.killProcessTree(this.buildProcess)
    if (this.verificationProcess && !this.verificationProcess.killed) this.killProcessTree(this.verificationProcess)
    this.process = null
    this.buildProcess = null
    this.verificationProcess = null
  }

protected async prepareInternal(signal?: AbortSignal, generation = this.prepareGeneration): Promise<MinecraftRuntimeState> {
    const project = this.requireProject()
    if (signal?.aborted) throw abortError()
    if (!this.vanillaClient && !isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 必须使用对应官方客户端或开发者工作台测试`)
    const configuredLoaderVersion = this.vanillaClient ? 'vanilla' : (await readConfiguredLoaderVersion(project)) ?? project.loaderVersion
    await fs.mkdir(this.instanceRoot(project), { recursive: true })
    await fs.mkdir(this.resourceRoot(), { recursive: true })
    if (signal?.aborted) throw abortError()
    this.emit('preparing', `正在检查本地 Minecraft ${project.minecraftVersion}`)
    if (!this.vanillaClient && project.kind !== 'modpack' && (project.loader === 'fabric' || project.loader === 'quilt')) await this.ensureManagedLoaderApi(project, signal)
    let cached = await this.readMetadata(project)
    const cachedVersionId = cached?.loaderVersionId
    const matchingMetadata = cached && (!configuredLoaderVersion || cached.loaderVersion === configuredLoaderVersion)
    const cachedDependenciesReady = cached && matchingMetadata && await this.verifyCachedRuntime(cached.loaderVersionId)
    if (cached && !cachedDependenciesReady) await this.removeInvalidCachedAssetIndex(cached.loaderVersionId)
    if (!cachedDependenciesReady) {
      cached = null
      // Player tests use a new isolated game directory on every run. Its missing
      // runtime.json does not mean the shared Minecraft/loader needs reinstalling.
      const candidates = await installedRuntimeCandidates(this.resourceRoot(), project.minecraftVersion, project.loader, configuredLoaderVersion, this.vanillaClient)
      for (const versionId of candidates) {
        if (matchingMetadata && versionId === cachedVersionId) continue
        if (signal?.aborted) throw abortError()
        if (!await this.verifyCachedRuntime(versionId, true, signal)) continue
        const java = await this.ensureJava(project, signal, generation)
        if (signal?.aborted) throw abortError()
        cached = {
          minecraftVersion: project.minecraftVersion, loader: project.loader,
          loaderVersionId: versionId, loaderVersion: configuredLoaderVersion!,
          fabricVersionId: project.loader === 'fabric' ? versionId : undefined,
          javaPath: java.javaPath, javaTarget: java.target, javaSource: java.source,
          preparedAt: new Date().toISOString()
        }
        await fs.writeFile(this.metadataPath(project), JSON.stringify(cached, null, 2), 'utf8')
        diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'runtime-cache', phase: 'reused', message: 'Reused installed Minecraft runtime for this instance', data: { versionId, instancePath: this.instanceRoot(project) } })
        break
      }
    } else if (cached && !await probeJavaHome(path.dirname(path.dirname(cached.javaPath)), javaVersionForMinecraft(project.minecraftVersion), false)) {
      // Repair Java independently; it must not invalidate a verified game install.
      const java = await this.ensureJava(project, signal, generation)
      if (signal?.aborted) throw abortError()
      cached = { ...cached, javaPath: java.javaPath, javaTarget: java.target, javaSource: java.source }
      await fs.writeFile(this.metadataPath(project), JSON.stringify(cached, null, 2), 'utf8')
    }
    if (signal?.aborted) throw abortError()
    if (cached) {
      this.updateState({
        stage: 'idle',
        minecraftVersion: project.minecraftVersion,
        loader: project.loader,
        loaderVersionId: cached.loaderVersionId,
        fabricVersionId: cached.fabricVersionId,
        loaderVersion: cached.loaderVersion,
        javaPath: cached.javaPath,
        instancePath: this.instanceRoot(project),
        installed: true,
        message: '测试实例已准备',
        mods: await this.listMods()
      })
      return this.getState()
    }

    this.emit('preparing', `正在准备 Minecraft ${project.minecraftVersion}`)
    const { target, javaPath, source: javaSource } = await this.ensureJava(project, signal, generation)
    if (signal?.aborted) throw abortError()

    this.emit('downloading-game', `正在检查并补全 Minecraft ${project.minecraftVersion}`)
    diagnosticJournal.record({
      subsystem: 'minecraft-download',
      operation: 'install-client',
      phase: 'start',
      message: `Installing Minecraft ${project.minecraftVersion}`,
      data: {
        resourceRoot: this.resourceRoot(),
        instancePath: this.instanceRoot(project),
        cacheMiss: !cachedVersionId ? 'instance-metadata-missing' : matchingMetadata ? 'runtime-invalid' : 'loader-version-changed',
        versionManifest: MINECRAFT_VERSION_MANIFEST_SOURCES[0].url,
        versionManifestFallbacks: MINECRAFT_VERSION_MANIFEST_SOURCES.slice(1).map((source) => source.url),
        assetHosts: MINECRAFT_ASSET_HOSTS,
        mavenHosts: MINECRAFT_MAVEN_HOSTS,
        loader: project.loader,
        loaderVersion: configuredLoaderVersion
      }
    })
    const resolvedVersion = await resolveMinecraftVersionFromManifests(
      project.minecraftVersion,
      async (source) => await getVersionList({
        remote: source.url,
        fetch: (input, init) => {
          const signals = [init?.signal, signal].filter((value): value is AbortSignal => Boolean(value))
          const mergedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
          return domesticMinecraftFetch(input, { ...init, signal: mergedSignal })
        }
      }),
      {
        onFailure: (failure) => diagnosticJournal.record({
          subsystem: 'minecraft-download',
          operation: 'version-manifest',
          phase: 'source-failed',
          level: 'warning',
          message: `Minecraft version manifest source failed: ${failure.source.label}`,
          data: {
            minecraftVersion: project.minecraftVersion,
            source: failure.source.url,
            message: failure.message
          }
        })
      }
    )
    if (resolvedVersion.failures.length > 0) {
      diagnosticJournal.record({
        subsystem: 'minecraft-download',
        operation: 'version-manifest',
        phase: 'fallback-success',
        level: 'warning',
        message: `Minecraft version manifest fallback succeeded via ${resolvedVersion.source.label}`,
        data: {
          minecraftVersion: project.minecraftVersion,
          source: resolvedVersion.source.url,
          failures: resolvedVersion.failures.map((failure) => ({
            source: failure.source.url,
            message: failure.message
          }))
        }
      })
    }
    const versionMeta = resolvedVersion.version
    await ensureAssetIndex(versionMeta as unknown as { assets?: string; assetIndex?: { sha1?: string } }, this.resourceRoot(), signal)
    const dispatcher = minecraftDownloadDispatcher()
    let loaderVersion = configuredLoaderVersion
    let loaderVersionId = ''
    try {
      await runMinecraftTaskWithRecovery({
        signal,
        createTask: (attempt) => installTask(versionMeta, this.resourceRoot(), {
          ...minecraftDownloadRecoveryOptions(attempt),
          side: 'client',
          assetsDownloadConcurrency: 4,
          librariesDownloadConcurrency: 4,
          dispatcher,
          json: attempt % 2 === 1 ? [mirrorVersionJsonUrl(project.minecraftVersion), versionMeta.url] : [versionMeta.url, mirrorVersionJsonUrl(project.minecraftVersion)],
          client: attempt % 2 === 1 ? [mirrorMinecraftJarUrl(project.minecraftVersion, 'client')] : [],
          assetsIndexUrl: (version) => officialAssetIndexUrls(version),
          useHashForAssetsIndex: true,
          assetsHost: minecraftAssetHosts(attempt),
          mavenHost: minecraftMavenHosts(attempt),
          fetch: domesticMinecraftFetch
        }),
        onUpdate: (task) => this.emitProgress('downloading-game', `正在检查并补全 Minecraft ${project.minecraftVersion}`, task.progress, task.total, generation),
        onRetry: (attempt, error) => {
          const source = attempt % 2 === 0 ? 'Mojang 官方源' : 'BMCLAPI'
          this.emit('downloading-game', `${error.message}，正在切换到 ${source} 自动重试（${attempt}/3）`, 'warning')
          diagnosticJournal.record({
            subsystem: 'minecraft-download',
            operation: 'install-client',
            phase: 'retry',
            level: 'warning',
            message: `Minecraft download stalled; retrying with ${source}`,
            data: { attempt, minecraftVersion: project.minecraftVersion, source }
          })
        }
      })
      if (signal?.aborted) throw abortError()

      if (!this.vanillaClient) this.emit('installing-loader', `正在安装 ${project.loader} Loader`)
      if (this.vanillaClient) {
        loaderVersion = 'vanilla'
        loaderVersionId = project.minecraftVersion
      } else if (project.loader === 'fabric') {
        const fetchMetadata = loaderMetadataFetch('fabric', domesticMinecraftFetch, loaderVersion)
        const loaders = await getFabricLoaders({ signal, fetch: fetchMetadata })
        const loader = loaderVersion
          ? loaders.find((item) => item.version === loaderVersion)
          : loaders.find((item) => item.stable) ?? loaders[0]
        if (!loader) throw new Error(loaderVersion ? `Fabric Meta 没有返回 Loader ${loaderVersion}` : 'Fabric Meta 没有返回可用 Loader')
        loaderVersion = loader.version
        loaderVersionId = await installFabric({
          minecraftVersion: project.minecraftVersion,
          version: loader.version,
          minecraft: this.resourceRoot(),
          side: 'client',
          signal,
          fetch: fetchMetadata
        })
      } else if (project.loader === 'quilt') {
        const fetchMetadata = loaderMetadataFetch('quilt', domesticMinecraftFetch, loaderVersion)
        const loaders = await getQuiltLoaders({ signal, fetch: fetchMetadata })
        const loader = loaderVersion
          ? loaders.find((item) => item.version === loaderVersion)
          : loaders.find((item) => !/(?:alpha|beta|rc)/i.test(item.version)) ?? loaders[0]
        if (!loader) throw new Error(loaderVersion ? `Quilt Meta 没有返回 Loader ${loaderVersion}` : 'Quilt Meta 没有返回可用 Loader')
        loaderVersion = loader.version
        loaderVersionId = await installQuiltVersion({
          minecraftVersion: project.minecraftVersion,
          version: loader.version,
          minecraft: this.resourceRoot(),
          side: 'client',
          signal,
          fetch: fetchMetadata
        })
      } else if (project.loader === 'forge') {
        if (!loaderVersion) {
          const forge = await getForgeVersionList({ minecraft: project.minecraftVersion, dispatcher })
          const selected = forge.versions.find((entry) => entry.type === 'recommended') ?? forge.versions.find((entry) => entry.type === 'latest') ?? forge.versions[0]
          if (!selected) throw new Error(`Forge 没有返回 Minecraft ${project.minecraftVersion} 的版本`)
          loaderVersion = `${project.minecraftVersion}-${selected.version}`
        }
        const forgeVersion = forgeInstallerVersion(project.minecraftVersion, loaderVersion)
        const installerUrl = forgeInstallerUrl(project.minecraftVersion, loaderVersion)
        await prepareLoaderInstaller({ loader: 'forge', minecraftVersion: project.minecraftVersion, version: forgeVersion, installerUrl, resourceRoot: this.resourceRoot(), signal, onProgress: progress => this.emitProgress('installing-loader', `正在下载 Forge 安装器：${progress.source.label}`, progress.downloaded, progress.total ?? 0, generation) })
        loaderVersionId = await runMinecraftTaskWithRecovery({
          signal,
          stallTimeoutMs: 120_000,
          createTask: (attempt) => installForgeTask(
            { mcversion: project.minecraftVersion, version: forgeVersion, installer: { path: installerUrl } },
            this.resourceRoot(),
            { java: javaPath, side: 'client', inheritsFrom: project.minecraftVersion, mavenHost: attempt % 2 === 1 ? FORGE_MAVEN_HOSTS : [...FORGE_MAVEN_HOSTS].reverse(), dispatcher, ...minecraftDownloadRecoveryOptions(attempt) }
          ),
          onUpdate: (task) => this.emitProgress('installing-loader', `正在安装 Forge ${loaderVersion}`, task.progress, task.total, generation),
          onRetry: (attempt, error) => this.emit('installing-loader', `${error.message}，正在切换下载源重试 Forge 安装（${attempt}/3）`, 'warning')
        })
      } else {
        if (!loaderVersion) throw new Error(`NeoForge ${project.minecraftVersion} 缺少加载器版本`)
        const artifact = project.minecraftVersion === '1.20.1' ? 'forge' : 'neoforge'
        await prepareLoaderInstaller({ loader: 'neoforge', minecraftVersion: project.minecraftVersion, version: loaderVersion, resourceRoot: this.resourceRoot(), signal, onProgress: progress => this.emitProgress('installing-loader', `正在下载 NeoForge 安装器：${progress.source.label}`, progress.downloaded, progress.total ?? 0, generation) })
        loaderVersionId = await runMinecraftTaskWithRecovery({
          signal,
          stallTimeoutMs: 120_000,
          createTask: (attempt) => {
            const hosts = attempt % 2 === 1 ? NEOFORGE_MAVEN_HOSTS : [...NEOFORGE_MAVEN_HOSTS].reverse()
            return installNeoForgedTask(artifact, loaderVersion!, this.resourceRoot(), { java: javaPath, side: 'client', mavenHost: hosts, libraryHost: loaderLibraryHost(hosts), dispatcher, ...minecraftDownloadRecoveryOptions(attempt) })
          },
          onUpdate: (task) => this.emitProgress('installing-loader', `正在安装 NeoForge ${loaderVersion}`, task.progress, task.total, generation),
          onRetry: (attempt, error) => this.emit('installing-loader', `${error.message}，正在重试 NeoForge 安装（${attempt}/3）`, 'warning')
        })
      }
      const resolved = await Version.parse(this.resourceRoot(), loaderVersionId)
      if (signal?.aborted) throw abortError()
      await runMinecraftTaskWithRecovery({
        signal,
        createTask: (attempt) => installDependenciesTask(resolved, {
          ...minecraftDownloadRecoveryOptions(attempt),
          assetsDownloadConcurrency: 4,
          librariesDownloadConcurrency: 4,
          dispatcher,
          assetsHost: minecraftAssetHosts(attempt),
          mavenHost: minecraftMavenHosts(attempt),
          assetsIndexUrl: (version) => officialAssetIndexUrls(version),
          useHashForAssetsIndex: true,
          fetch: domesticMinecraftFetch
        }),
        onUpdate: (task) => this.emitProgress('downloading-game', `正在校验 Minecraft ${project.minecraftVersion} 资源与依赖`, task.progress, task.total, generation),
        onRetry: (attempt, error) => this.emit('downloading-game', `${error.message}，正在重新校验缓存并切换下载源（${attempt}/3）`, 'warning')
      })

      const metadata: RuntimeMetadata = {
        minecraftVersion: project.minecraftVersion,
        loader: project.loader,
        loaderVersionId,
        fabricVersionId: project.loader === 'fabric' ? loaderVersionId : undefined,
        loaderVersion,
        javaPath,
        javaTarget: target,
        javaSource: javaSource,
        preparedAt: new Date().toISOString()
      }
      await fs.writeFile(this.metadataPath(project), JSON.stringify(metadata, null, 2), 'utf8')
    } finally {
      await dispatcher.close()
    }

    const metadata = await this.readMetadata(project)
    if (!metadata) throw new Error('Minecraft 运行时安装完成但元数据未写入')
    this.updateState({
      stage: 'idle',
      minecraftVersion: project.minecraftVersion,
      loader: project.loader,
      loaderVersionId: metadata.loaderVersionId,
      fabricVersionId: metadata.fabricVersionId,
      loaderVersion: metadata.loaderVersion,
      javaPath: metadata.javaPath,
      instancePath: this.instanceRoot(project),
      installed: true,
      message: this.vanillaClient ? 'Minecraft 原版客户端已准备完成' : `Minecraft 与 ${project.loader} 已准备完成`,
      mods: await this.listMods()
    })
    this.emit('idle', '测试实例准备完成')
    return this.getState()
  }

protected async verifyCachedRuntime(versionId: string, verifyAssets = false, signal?: AbortSignal): Promise<boolean> {
    let check = 'version-json'
    try {
      const folder = MinecraftFolder.from(this.resourceRoot())
      const version = await Version.parse(folder, versionId)
      const precheckOptions = { gamePath: this.resourceRoot(), javaPath: '', version: version.id }
      check = 'client-jar'
      await LaunchPrecheck.checkVersion(folder, version, precheckOptions)
      check = 'libraries'
      await LaunchPrecheck.checkLibraries(folder, version, precheckOptions)
      check = 'natives'
      await LaunchPrecheck.checkNatives(folder, version, precheckOptions)
      check = 'asset-index'
      if (!await reuseAssetIndex(version, this.resourceRoot())) throw new Error('Minecraft asset index is missing or invalid')
      // A profile may have been written by an interrupted installation. Without
      // a completed instance record, verify its objects before adopting it.
      if (verifyAssets) {
        check = 'assets'
        const index = JSON.parse(await fs.readFile(folder.getAssetsIndex(version.assets), 'utf8')) as { objects: Record<string, { hash: string; size: number }> }
        const entries = Object.entries(index.objects)
        for (let offset = 0; offset < entries.length; offset += 16) {
          if (signal?.aborted) throw abortError()
          const issues = await diagnoseAssets(Object.fromEntries(entries.slice(offset, offset + 16)), folder, { strict: true, signal })
          if (issues.length) throw new Error(`Minecraft asset is missing or invalid: ${issues[0].asset.name}`)
        }
      }
      return true
    } catch (error) {
      if (signal?.aborted) throw abortError()
      diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'runtime-cache', phase: 'invalid', level: 'warning', message: 'Installed Minecraft runtime failed cache verification', data: { versionId, check }, error })
      return false
    }
  }

protected async removeInvalidCachedAssetIndex(versionId: string): Promise<void> {
    try {
      const folder = MinecraftFolder.from(this.resourceRoot())
      const version = await Version.parse(folder, versionId)
      if (!version.assetIndex?.sha1) return
      const assetIndexPath = folder.getPath('assets', 'indexes', `${version.assets}.json`)
      if (await sha1File(assetIndexPath) !== version.assetIndex.sha1) {
        await fs.rm(assetIndexPath, { force: true })
      }
    } catch {
      // A missing or malformed cache is repaired by the normal installer.
    }
  }

protected resourceRoot(): string {
    return path.join(app.getPath('userData'), 'minecraft-runtime', 'game')
  }

protected async ensureJava(project: ProjectInfo, signal?: AbortSignal, generation?: number): Promise<{ target: string; javaPath: string; source: 'managed' | 'custom' }> {    const minimumMajor = javaVersionForMinecraft(project.minecraftVersion)
    const target = javaRuntimeTargetForMinecraft(project.minecraftVersion)
    const preferredGameJava = await this.preferredJavaHome('game')
    if (preferredGameJava) {
      const candidate = await probeJavaHome(preferredGameJava, minimumMajor, false)
      if (candidate) {
        this.emit('preparing', `使用手动选择的 Java ${candidate.major}：${candidate.javaPath}`)
        return { target, javaPath: candidate.javaPath, source: 'custom' }
      }
      this.emit('preparing', `手动选择的 Java 不满足 Minecraft ${project.minecraftVersion} 的要求（至少 Java ${minimumMajor}），已回退到自动配置：${preferredGameJava}`, 'warning')
    }
    return { ...await this.ensureManagedJava(minimumMajor, target, signal, generation), source: 'managed' }
  }

protected async resolveLaunchJava(project: ProjectInfo, metadata: RuntimeMetadata): Promise<string> {
    const preferredGameJava = await this.preferredJavaHome('game')
    if (!preferredGameJava) return metadata.javaPath
    const candidate = await probeJavaHome(preferredGameJava, javaVersionForMinecraft(project.minecraftVersion), false)
    if (candidate) return candidate.javaPath
    this.emit('launching', `手动选择的 Java 当前不可用，已改用实例配置的 Java：${metadata.javaPath}`, 'warning')
    return metadata.javaPath
  }

protected async ensureManagedJava(minimumMajor: number, requestedTarget?: string, signal?: AbortSignal, generation?: number): Promise<{ target: string; javaPath: string }> {
    const target = requestedTarget ?? javaRuntimeTargetForJavaVersion(minimumMajor)
    const javaHome = path.join(this.runtimeRoot(), target)
    const javaPath = managedJavaExecutable(this.runtimeRoot(), target)
    if (!await validManagedJavaCache(javaHome) || !(await probeJavaHome(javaHome, minimumMajor, false).catch(() => null))) {
      const stagingHome = `${javaHome}.staging-${randomUUID()}`
      this.emit('downloading-java', `正在下载托管 Java：${target}`)
      const manifest = await fetchCompatibleJavaRuntimeManifest(target, signal)
      await fs.rm(stagingHome, { recursive: true, force: true })
      const dispatcher = minecraftDownloadDispatcher()
      try {
        await runMinecraftTaskWithRecovery({
          signal,
          createTask: (attempt) => installJavaRuntimeTask({ destination: stagingHome, manifest, dispatcher, ...minecraftDownloadRecoveryOptions(attempt) }),
          onUpdate: (task) => this.emitProgress('downloading-java', '正在下载 Java Runtime', task.progress, task.total, generation),
          onRetry: (attempt, error) => this.emit('downloading-java', `${error.message}，正在重新下载 Java Runtime（${attempt}/3）`, 'warning')
        })
        if (signal?.aborted) throw abortError()
        if (!(await probeJavaHome(stagingHome, minimumMajor, false).catch(() => null))) {
          throw new Error(`下载的托管 Java 验证失败：${managedJavaExecutable(path.dirname(stagingHome), path.basename(stagingHome))}`)
        }
        await fs.writeFile(path.join(stagingHome, MANAGED_JAVA_MANIFEST), JSON.stringify(manifest), 'utf8')
        await fs.rm(javaHome, { recursive: true, force: true })
        await fs.rename(stagingHome, javaHome)
      } catch (error) {
        if (signal?.aborted) throw abortError()
        throw new Error(`Java Runtime 下载或校验失败：${runtimeDownloadError(error)}`, { cause: error })
      } finally {
        try { await dispatcher.close() }
        finally { await fs.rm(stagingHome, { recursive: true, force: true }).catch(() => undefined) }
      }
    }
    if (!(await probeJavaHome(javaHome, minimumMajor, false).catch(() => null))) {
      throw new Error(`托管 Java 安装后仍无法运行：${javaPath}。缓存可能损坏、架构不匹配或被安全软件拦截`)
    }
    return { target, javaPath }
  }

protected async ensureManagedLoaderApi(project: ProjectInfo, signal?: AbortSignal): Promise<void> {
    if (project.loader !== 'fabric' && project.loader !== 'quilt') return
    if (!await prepareLoaderApiTestPolicy(project.path, project.loader as 'fabric' | 'quilt')) {
      this.emit('installing-loader', '测试配置已禁用完整 API 自动安装，并清理 ModMind 托管的 API；验证无外置 API 时还需检查其余模组与内嵌依赖')
      return
    }
    const version = project.apiVersion ?? await readConfiguredLoaderApiVersion(project)
    const label = project.loader === 'quilt' ? 'Quilted Fabric API' : 'Fabric API'
    if (!version) {
      this.emit('installing-loader', `Minecraft ${project.minecraftVersion} 没有配置托管 ${label}`, 'warning')
      return
    }
    const modsDirectory = this.modsRoot(project)
    const target = path.join(modsDirectory, managedLoaderApiName(project))
    const marker = path.join(modsDirectory, `.modmind-${project.loader}-api-version`)
    await fs.mkdir(modsDirectory, { recursive: true })
    const installedVersion = await fs.readFile(marker, 'utf8').catch(() => '')
    if (installedVersion.trim() === version && (await exists(target))) return

    // Quilt's Maven front end treats an encoded '+' as a different artifact.
    // '+' is safe in a path segment; keep all separators and query markers encoded.
    const encodedVersion = encodeURIComponent(version).replaceAll('%2B', '+')
    const relativePath = project.loader === 'quilt'
      ? `org/quiltmc/quilted-fabric-api/quilted-fabric-api/${encodedVersion}/quilted-fabric-api-${encodedVersion}.jar`
      : `net/fabricmc/fabric-api/fabric-api/${encodedVersion}/fabric-api-${encodedVersion}.jar`
    const sources = project.loader === 'quilt'
      ? [`${BMCLAPI}/maven/${relativePath}`, `https://maven.quiltmc.org/repository/release/${relativePath}`]
      : [`${BMCLAPI}/maven/${relativePath}`, `https://maven.fabricmc.net/${relativePath}`]
    this.emit('installing-fabric', `正在准备 ${label} ${version}`)
    let expected = ''
    let checksumError: unknown
    for (const source of sources) {
      try {
        expected = (await fetchTextWithRetry(`${source}.sha1`, { timeoutMs: 30_000, signal })).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        if (!expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error(`${label} SHA-1 格式无效`)
        break
      } catch (error) {
        signal?.throwIfAborted()
        checksumError = error
      }
    }
    if (!expected) throw new Error(`${label} 校验信息下载失败：${checksumError instanceof Error ? checksumError.message : String(checksumError)}`)
    await verifiedDownload.download({
      sources: sources.map((url, index) => ({ id: `${project.loader}-api-${index + 1}`, label: `${label} 下载源 ${index + 1}`, url })),
      destination: target,
      expectedHash: { algorithm: 'sha1', value: expected },
      maxBytes: 256 * 1024 * 1024,
      signal,
      retriesPerSource: 2
    })
    await fs.writeFile(marker, version, 'utf8')
    this.emit('installing-fabric', `${label} ${version} 已就绪`)
  }

protected instanceRoot(project: ProjectInfo): string {
    return this.instanceDirectory ?? path.join(project.path, projectDataDirectory(project), 'minecraft')
  }

protected modsRoot(project: ProjectInfo): string {
    return path.join(this.instanceRoot(project), 'mods')
  }

protected metadataPath(project: ProjectInfo): string {
    return path.join(this.instanceRoot(project), 'runtime.json')
  }

protected async handleMinecraftExit(
    project: ProjectInfo,
    launchedAt: number,
    code: number | null,
    signal: NodeJS.Signals | null,
    intentionallyStopped: boolean,
    gameDirectory: string
  ): Promise<void> {
    const abnormalExitCode = code !== 0 && code !== null
    const parsedCrash = abnormalExitCode ? await this.readLatestCrash(project, launchedAt, gameDirectory) : undefined
    const normalShutdown = abnormalExitCode && !parsedCrash && await this.readNormalShutdownEvidence(project, launchedAt, gameDirectory)
    const crashed = abnormalExitCode && !intentionallyStopped && !normalShutdown
    if (!crashed) {
      const message = `Minecraft 已退出${signal ? ` (${signal})` : ''}`
      await fs.writeFile(path.join(gameDirectory, 'last-clean-exit'), new Date().toISOString(), 'utf8').catch(() => undefined)
      this.updateState({ stage: 'stopped', running: false, pid: undefined, message, lastCrash: undefined })
      this.emit('stopped', message, 'info')
      return
    }

    const signedCode = code > 0x7fffffff ? code - 0x100000000 : code
    const lastCrash: MinecraftCrashInfo = parsedCrash ?? {
      summary: `Minecraft 异常退出，代码 ${signedCode}`,
      exitCode: signedCode,
      time: new Date().toISOString()
    }
    lastCrash.exitCode = signedCode
    const { summary, reportPath } = lastCrash
    const message = summary.split('\n')[0] || `Minecraft 异常退出，代码 ${signedCode}`
    this.updateState({ stage: 'error', running: false, pid: undefined, message, lastCrash })
    this.emit('error', `${message}${reportPath ? `\n崩溃报告：${reportPath}` : ''}`, 'error')
  }

protected async readNormalShutdownEvidence(project: ProjectInfo, launchedAt: number, gameDirectory = this.instanceRoot(project)): Promise<boolean> {
    const candidates = [
      path.join(gameDirectory, 'launcher-console.log'),
      path.join(gameDirectory, 'logs', 'latest.log')
    ]
    for (const filePath of candidates) {
      const stat = await fs.stat(filePath).catch(() => null)
      if (!stat || stat.mtimeMs < launchedAt - 2_000) continue
      const content = await fs.readFile(filePath, 'utf8').catch(() => '')
      const tail = content.slice(-96_000)
      if (/(?:Stopping!|Stopping server|Saving (?:all )?worlds|Saving players|Shutting down|Shutdown complete|Exiting game)/i.test(tail)) return true
    }
    return false
  }

protected async readLatestCrash(project: ProjectInfo, launchedAt: number, gameDirectory = this.instanceRoot(project)): Promise<MinecraftCrashInfo | undefined> {
    try {
      const crashDirectory = path.join(gameDirectory, 'crash-reports')
      const entries = await fs.readdir(crashDirectory, { withFileTypes: true })
      const reports = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
          .map(async (entry) => {
            const filePath = path.join(crashDirectory, entry.name)
            return { filePath, stat: await fs.stat(filePath) }
          })
      )
      const latest = reports.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]
      if (!latest || latest.stat.mtimeMs < launchedAt - 2_000) return undefined
      if (launchedAt === 0) {
        const cleanExitTime = await fs.stat(path.join(gameDirectory, 'last-clean-exit')).then((stat) => stat.mtimeMs).catch(() => 0)
        if (latest.stat.mtimeMs <= cleanExitTime) return undefined
      }
      const summary = summarizeMinecraftCrash(await fs.readFile(latest.filePath, 'utf8'))
      if (!summary) return undefined
      return {
        summary,
        reportPath: latest.filePath,
        exitCode: null,
        time: latest.stat.mtime.toISOString()
      }
    } catch {
      return undefined
    }
  }

protected async readMetadata(project: ProjectInfo): Promise<RuntimeMetadata | null> {
    try {
      const metadata = JSON.parse(await fs.readFile(this.metadataPath(project), 'utf8')) as Partial<RuntimeMetadata>
      const normalized = normalizeRuntimeMetadata(project, metadata, this.runtimeRoot())
      if (!normalized) return null

      // A copied project can contain a Java path from another Windows user.
      // Keep the cache useful by rewriting only the derived runtime fields.
      if (metadata.javaPath !== normalized.javaPath || metadata.javaTarget !== normalized.javaTarget || metadata.javaSource !== normalized.javaSource) {
        await fs.writeFile(this.metadataPath(project), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8').catch(() => undefined)
      }
      return normalized
    } catch {
      return null
    }
  }
protected finishBuildArtifact() { return this.syncProjectMod() }
protected async finishModpackBuild(_project: ProjectInfo) { await this.syncModpack(); return this.listMods() }
}
export { detectInstalledJavaHomes,gradleVersionFor,probeJavaHomeInfo,projectGradleWrapperExecutable } from '../../../../src/main/buildRuntime'
