import { spawnManaged, stopProcessTree } from './processTree'
import { app, net } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { Agent, interceptors } from 'undici'
import { LaunchPrecheck, MinecraftFolder, Version, launch } from '@xmcl/core'
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
import type {
  MinecraftLaunchOptions,
  GradleVerificationResult,
  MinecraftCrashInfo,
  MinecraftLaunchTestResult,
  MinecraftManagedMod,
  MinecraftRuntimeEvent,
  MinecraftRuntimeStage,
  MinecraftRuntimeState
} from '../shared/minecraft'
import type { JavaPreferences, DetectedJavaHome, LoaderKind, ProjectInfo } from '../shared/types'
import { isJavaLoader, isServerPluginPlatform, platformLabel } from '../shared/projectPlatform'
import { findPluginArtifact } from './serverPluginService'
import { buildMavenPlugin } from './mavenBuild'
import { isForgeJavaProvisioningFailure, isGradleNetworkFailure } from './gradleFailure'
import { readModpackManifest, syncModpackOverrides } from './modpackService'
import { modpackModsRoot } from './modpackPaths'
import { buildJavaRangeForProject, gradleVersionForProject, javaRuntimeTargetForJavaVersion, javaRuntimeTargetForMinecraft, javaVersionForMinecraft } from './loaderCompatibility'
import { buildBedrockAddon, buildNeteaseArchive } from './bedrockAddon'
import { ensureManagedJdk, type ManagedJdkProgress } from './jdkDownload'
import { sameProjectPath } from './projectPath'
import { ensureGradleMavenFallback, gradleDistributionSources, type GradleDownloadSourcePreference } from './gradleDownload'
import { windowsCmdInvocation } from './windowsCommand'
import { managedJavaExecutable, normalizeRuntimeMetadata, type RuntimeMetadata } from './runtimeMetadata'
import { diagnosticJournal } from './diagnosticLog'
import { verifiedDownload } from './downloadService'
import { downloadActivities } from './downloadActivityService'
import { describeProcessTermination, MANAGED_GRADLE_BUILD_ARGUMENTS, normalizeProcessExitCode } from './gradleProcess'
import { isMissingFileError, isTransientFileLockError, lockedFileReadError, retryTransientFileLock } from './fileLockRetry'
import {
  BMCLAPI_BASE_URL,
  MINECRAFT_VERSION_MANIFEST_SOURCES,
  resolveMinecraftVersionFromManifests
} from './minecraftVersionManifest'
import { runMinecraftTaskWithRecovery } from './minecraftTaskRecovery'
import { getNetworkProxyUrl } from './networkRequest'
import { detectToolchainRequirements, mergeToolchainJavaHomes } from './toolchainDetection'

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

import { javaProxyOptions } from './javaEnvironment'

/**
 * Electron's network stack uses the platform certificate store. This matters
 * on Windows when a proxy or security product installs a trusted root there,
 * while Node/Undici still reports UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 */
async function ensureAssetIndex(
  version: { assets?: string; assetIndex?: { sha1?: string } },
  resourceRoot: string,
  signal?: AbortSignal
): Promise<void> {
  const expectedSha1 = version.assetIndex?.sha1?.trim().toLowerCase()
  const destination = assetIndexPath(resourceRoot, version)
  if (!expectedSha1 || !destination) return
  const hashedDestination = hashedAssetIndexPath(resourceRoot, expectedSha1)
  if (await validAssetIndex(destination, expectedSha1)) {
    if (!(await validAssetIndex(hashedDestination, expectedSha1))) {
      await fs.copyFile(destination, hashedDestination).catch(() => undefined)
    }
    return
  }
  if (await validAssetIndex(hashedDestination, expectedSha1)) {
    await fs.copyFile(hashedDestination, destination).catch(() => undefined)
    return
  }

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

function minecraftDownloadDispatcher() {
  return new Agent({ connections: 4, bodyTimeout: 60_000, headersTimeout: 30_000 }).compose(
    interceptors.retry({ maxRetries: 3 }),
    interceptors.redirect({ maxRedirections: 5 })
  )
}

function minecraftAssetHosts(attempt: number): string[] {
  return attempt % 2 === 1 ? MINECRAFT_ASSET_HOSTS : [MINECRAFT_ASSET_HOSTS[1], MINECRAFT_ASSET_HOSTS[0]]
}

function minecraftMavenHosts(attempt: number): string[] {
  return attempt % 2 === 1
    ? MINECRAFT_MAVEN_HOSTS
    : [MINECRAFT_MAVEN_HOSTS[1], MINECRAFT_MAVEN_HOSTS[0], MINECRAFT_MAVEN_HOSTS[2]]
}

interface MinecraftRuntimeOptions {
  getProject: () => ProjectInfo | null
  onState: (state: MinecraftRuntimeState) => void
  onEvent: (event: MinecraftRuntimeEvent) => void
  authorizeBuild?: (project: ProjectInfo) => Promise<void>
  getGradleDownloadSource?: () => Promise<GradleDownloadSourcePreference>
  getJavaPreference?: () => Promise<Partial<JavaPreferences> | undefined>
  prepareProjectDependencies?: (project: ProjectInfo, signal?: AbortSignal) => Promise<void>
}

export function gradleVersionFor(project: ProjectInfo): string {
  return gradleVersionForProject(project)
}

interface GradleRuntimeSelection {
  executable: string
  javaHome: string
  usesWrapper: true
  source: 'wrapper'
}

export function projectGradleWrapperExecutable(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(projectRoot, platform === 'win32' ? 'gradlew.bat' : 'gradlew')
}

function projectDataDirectory(_project: ProjectInfo): '.modmind' {
  return '.modmind'
}

function projectArtifactName(_project: ProjectInfo): string {
  return 'modmind-current-project.jar'
}

function managedLoaderApiName(project: ProjectInfo): string {
  const api = project.loader === 'quilt' ? 'quilted-fabric-api' : 'fabric-api'
  return `modmind-managed-${api}.jar`
}

function summarizeGradleFailure(logText: string): string {
  const lines = logText.split(/\r?\n/)
  if (isForgeJavaProvisioningFailure(logText)) {
    const requirements = detectToolchainRequirements(logText)
    const requested = requirements.javaMajors.length ? `（日志要求 Java ${requirements.javaMajors.join('、')}）` : ''
    return `Forge/Mavenizer 无法准备项目所需的 JDK${requested}。ModMind 已尝试自动下载并配置；请检查网络代理或下载源\n${lines.filter(Boolean).slice(-8).join('\n')}`
  }
  if (isGradleNetworkFailure(logText)) {
    return '项目 Gradle Wrapper 无法取得配置的 Gradle 分发包。请检查 gradle/wrapper/gradle-wrapper.properties、网络或代理设置'
  }
  const compilerErrors: string[] = []
  for (let index = 0; index < lines.length && compilerErrors.length < 12; index += 1) {
    if (!/\.java:\d+:\s*(?:error|错误):/i.test(lines[index])) continue
    compilerErrors.push(...lines.slice(index, index + 3).map((line) => line.trimEnd()).filter(Boolean))
  }
  if (compilerErrors.length) return compilerErrors.join('\n')

  const whatWentWrong = lines.findIndex((line) => line.trim() === '* What went wrong:')
  if (whatWentWrong >= 0) {
    const end = lines.findIndex((line, index) => index > whatWentWrong && line.trim().startsWith('* Try:'))
    return lines.slice(whatWentWrong + 1, end > whatWentWrong ? end : whatWentWrong + 14).filter(Boolean).join('\n')
  }
  return lines.filter(Boolean).slice(-16).join('\n')
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
    ? 'DETERMINISTIC DIAGNOSTIC: Moving Item/Block construction into register() does not fix this failure. Ensure a compatible Fabric API is declared in Gradle, present in the runtime mods directory, and loaded before registering content during ModInitializer.'
    : undefined
  return [description, entrypoint, rootCause, ...modFrames, diagnostic].filter(Boolean).join('\n')
}

async function listExtractedFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  await visit(root)
  return files
}

/** Fabric API is a legal jar-in-jar: its compiled classes live in nested JARs. */
async function containsCompiledClass(root: string, files: string[]): Promise<boolean> {
  if (files.some((file) => file.endsWith('.class'))) return true
  const nestedJars = files.filter((file) => /^META-INF\/jars\/[^/]+\.jar$/i.test(file))
  for (const nested of nestedJars) {
    const nestedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-nested-jar-'))
    try {
      await extractZip(path.join(root, nested), { dir: nestedRoot })
      const nestedFiles = await listExtractedFiles(nestedRoot)
      if (nestedFiles.some((file) => file.endsWith('.class'))) return true
    } catch {
      // A malformed nested archive is rejected by the loader; keep checking other entries.
    } finally {
      await fs.rm(nestedRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return false
}

async function validateModArtifact(filePath: string, loader: LoaderKind, displayPath = filePath): Promise<void> {
  const stat = await fs.stat(filePath)
  if (stat.size < 1_024) throw new Error('Mod JAR is implausibly small')
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-jar-'))
  try {
    await extractZip(filePath, { dir: temporaryRoot })
    const files = await listExtractedFiles(temporaryRoot)
    const descriptors = loader === 'fabric'
      ? ['fabric.mod.json']
      : loader === 'quilt' ? ['quilt.mod.json']
        : loader === 'forge' ? ['META-INF/mods.toml', 'mcmod.info'] : ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']
    if (!descriptors.some((descriptor) => files.includes(descriptor))) {
      throw new Error(`Mod JAR does not contain a ${loader} descriptor`)
    }
    if (!(await containsCompiledClass(temporaryRoot, files))) throw new Error('Mod JAR does not contain compiled class files')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Mod JAR "${path.basename(displayPath)}": ${detail}`)
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function replaceModArtifact(source: string, target: string, loader: LoaderKind): Promise<void> {
  const pending = `${target}.pending`
  const backup = `${target}.backup`

  // Recover an interrupted swap before attempting another deployment.
  if (!(await exists(target)) && (await exists(backup))) await fs.rename(backup, target)
  await fs.rm(pending, { force: true })
  await fs.copyFile(source, pending)
  await validateModArtifact(pending, loader, source)

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

async function fetchCompatibleJavaRuntimeManifest(target: string) {
  const agent = new Agent({ connections: 4 })
  const dispatcher = agent.compose((dispatch) => (options, handler) => {
    const compatibleOptions = { ...options }
    delete (compatibleOptions as typeof compatibleOptions & { throwOnError?: boolean }).throwOnError
    return dispatch(compatibleOptions, handler)
  })
  try {
    return await fetchJavaRuntimeManifest({ target: target as JavaRuntimeTargetType, dispatcher })
  } finally {
    await dispatcher.close()
  }
}

function offlineUuid(username: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
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

interface JavaProbeResult {
  javaPath: string
  major: number
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

async function probeJavaHome(home: string, minimumMajor: number, requireJavac: boolean, maximumMajor = Number.POSITIVE_INFINITY): Promise<JavaProbeResult | null> {
  let normalizedHome = home.trim().replace(/^"|"$/g, '')
  if (path.basename(normalizedHome).toLowerCase() === (process.platform === 'win32' ? 'java.exe' : 'java')) {
    normalizedHome = path.dirname(path.dirname(normalizedHome))
  }
  if (!normalizedHome) return null
  const javaPath = path.join(normalizedHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  if (!(await isNonEmptyFile(javaPath))) return null
  let output: {code: number; text: string}
  try {
    output = await new Promise<{code: number; text: string}>((resolve) => {
      let text = ''
      const child = spawn(javaPath, ['-version'], { cwd: normalizedHome, windowsHide: true, shell: false })
      const finish = (code: number): void => resolve({ code, text: text.slice(-8_000) })
      const timer = setTimeout(() => {
        if (child.pid) {
          void stopProcessTree(child)
        }
        finish(124)
      }, 10_000)
      const capture = (chunk: Buffer): void => { text += chunk.toString('utf8') }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      child.once('error', () => { clearTimeout(timer); finish(1) })
      child.once('exit', (code) => { clearTimeout(timer); finish(code ?? 1) })
    })
  } catch {
    return null
  }
  if (output.code !== 0) return null
  const rawVersion = output.text.match(/version\s+["'](?:1\.)?(\d+)/i)?.[1]
  const major = rawVersion ? Number(rawVersion) : 0
  if (!major || major < minimumMajor || major > maximumMajor) return null
  if (!requireJavac) return { javaPath, major }
  const javacPath = path.join(normalizedHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
  if (!(await isNonEmptyFile(javacPath))) return null
  let compiler = false
  try {
    compiler = await new Promise<boolean>((resolve) => {
      const child = spawn(javacPath, ['-version'], { cwd: normalizedHome, windowsHide: true, shell: false })
      const timer = setTimeout(() => {
        if (child.pid) {
          void stopProcessTree(child)
        }
        resolve(false)
      }, 10_000)
      child.once('error', () => { clearTimeout(timer); resolve(false) })
      child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
    })
  } catch {
    return null
  }
  return compiler ? { javaPath, major } : null
}

async function configuredBuildJavaHomes(project: ProjectInfo): Promise<string[]> {
  const properties = await fs.readFile(path.join(project.path, 'gradle.properties'), 'utf8').catch(() => '')
  const configured = properties.match(/^org\.gradle\.java\.home\s*=\s*(.+)$/m)?.[1]?.trim().replaceAll('\\\\', '\\')
  const pathHomes: string[] = []
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (!trimmed) continue
    const candidate = path.basename(trimmed).toLowerCase() === 'bin' ? path.dirname(trimmed) : trimmed
    const javaExecutable = path.join(candidate, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    if (await exists(javaExecutable)) pathHomes.push(candidate)
  }
  // Windows often exposes Java through a PATH shim (for example Oracle's
  // Common Files\Java\javapath), so the PATH entry itself is not a JDK home.
  // Ask the selected Java runtime for its real home before falling back to the
  // bundled Minecraft runtime.
  const discoveredHomes = await discoverJavaHomesFromPath()
  return [...new Set([
    configured,
    process.env.JAVA_HOME,
    process.env.JDK_HOME,
    ...discoveredHomes,
    ...pathHomes
  ].filter((value): value is string => Boolean(value && value.trim())))]
}

async function discoverJavaHomesFromPath(): Promise<string[]> {
  const command = process.platform === 'win32' ? 'java.exe' : 'java'
  return await new Promise<string[]>((resolve) => {
    let output = ''
    const child = spawn(command, ['-XshowSettings:properties', '-version'], {
      windowsHide: true,
      shell: false,
      env: process.env
    })
    const timer = setTimeout(() => {
      if (child.pid) {
        void stopProcessTree(child)
      }
      resolve([])
    }, 10_000)
    const capture = (chunk: Buffer): void => { output += chunk.toString('utf8') }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const finish = (): void => {
      clearTimeout(timer)
      const home = output.match(/^\s*java\.home\s*=\s*(.+?)\s*$/m)?.[1]?.trim()
      if (!home) return resolve([])
      const normalized = home.replace(/^"|"$/g, '')
      const homes = [normalized]
      if (path.basename(normalized).toLowerCase() === 'jre') homes.push(path.dirname(normalized))
      resolve(homes)
    }
    child.once('error', finish)
    child.once('exit', finish)
  })
}

/** Validate an arbitrary user-provided JDK home (or bin/java path) without version constraints. */
export async function probeJavaHomeInfo(home: string): Promise<{ valid: boolean; major: number }> {
  const candidate = await probeJavaHome(home, 1, false)
  return candidate ? { valid: true, major: candidate.major } : { valid: false, major: 0 }
}

async function listSubdirectoryPaths(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

// Launcher vendors (Oracle, Adoptium, Azul, Microsoft, ...) each install into
// their own root; scanning the well-known parents is enough to populate the
// settings picker without walking whole drives.
async function commonRootJavaHomeCandidates(): Promise<string[]> {
  if (process.platform === 'win32') {
    const home = os.homedir()
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const roots = [
      path.join(programFiles, 'Java'),
      path.join(programFiles, 'Eclipse Adoptium'),
      path.join(programFiles, 'Microsoft'),
      path.join(programFiles, 'Zulu'),
      path.join(programFiles, 'Amazon Corretto'),
      path.join(programFilesX86, 'Zulu'),
      path.join(programFiles, 'Azul Systems'),
      path.join(programFilesX86, 'Java'),
      path.join(programFilesX86, 'Eclipse Adoptium'),
      path.join(home, '.jdks')
    ]
    const candidates = (await Promise.all(roots.map(listSubdirectoryPaths))).flat()
    // macOS-style layouts rarely appear on Windows but a few distributions
    // still nest under Contents/Home.
    for (const candidate of [...candidates]) {
      const contentsHome = path.join(candidate, 'Contents', 'Home')
      if (await exists(path.join(contentsHome, 'bin', 'java.exe'))) candidates.push(contentsHome)
    }
    return [...candidates, ...(await Promise.all(candidates.map(listSubdirectoryPaths))).flat()]
  }
  if (process.platform === 'darwin') {
    const roots = await listSubdirectoryPaths('/Library/Java/JavaVirtualMachines')
    return roots.map((candidate) => path.join(candidate, 'Contents', 'Home'))
  }
  return await listSubdirectoryPaths('/usr/lib/jvm')
}

/**
 * Enumerate locally installed Java homes for the settings picker. Probes every
 * candidate so entries carry their actual major version and dead installs are
 * filtered out.
 */
export async function detectInstalledJavaHomes(savedHomes: string[] = []): Promise<DetectedJavaHome[]> {
  const userData = app.getPath('userData')
  const pathHomes: string[] = []
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    const executable = path.join(directory, process.platform === 'win32' ? 'java.exe' : 'java')
    const real = await fs.realpath(executable).catch(() => '')
    if (real) pathHomes.push(path.dirname(path.dirname(real)))
  }
  const candidates = [
    ...savedHomes,
    ...pathHomes,
    ...await listSubdirectoryPaths(path.join(userData, 'minecraft-runtime', 'java')),
    ...await listSubdirectoryPaths(path.join(userData, 'build-jdks')),
    ...await commonRootJavaHomeCandidates(),
    ...(process.env.JAVA_HOME ? [process.env.JAVA_HOME] : []),
    ...(process.env.JDK_HOME ? [process.env.JDK_HOME] : []),
    ...await discoverJavaHomesFromPath()
  ].map((value) => value.trim().replace(/^"|"$/g, '')).filter(Boolean)
  const queued = new Set<string>()
  const seen = new Set<string>()
  const detected: DetectedJavaHome[] = []
  for (const candidate of candidates) {
    const candidateKey = path.resolve(candidate).toLowerCase()
    if (queued.has(candidateKey)) continue
    queued.add(candidateKey)
    const probed = await probeJavaHome(candidate, 8, false).catch(() => null)
    if (!probed) continue
    const probedHome = path.dirname(path.dirname(probed.javaPath))
    const home = await fs.realpath(probedHome).catch(() => probedHome)
    const homeKey = process.platform === 'win32' ? home.toLowerCase() : home
    if (seen.has(homeKey)) continue
    seen.add(homeKey)
    detected.push({ home, major: probed.major })
  }
  return detected
}

async function findFile(root: string, predicate: (name: string, fullPath: string) => boolean): Promise<string | null> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        const nested = await findFile(fullPath, predicate)
        if (nested) return nested
      } else if (entry.isFile() && predicate(entry.name, fullPath)) {
        return fullPath
      }
    }
  } catch {
    return null
  }
  return null
}

async function findFiles(
  root: string,
  predicate: (name: string, fullPath: string) => boolean,
  limit = 500
): Promise<string[]> {
  const matches: string[] = []
  const visit = async (directory: string): Promise<void> => {
    if (matches.length >= limit) return
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= limit) return
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile() && predicate(entry.name, fullPath)) matches.push(fullPath)
    }
  }
  await visit(root)
  return matches
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

export class MinecraftRuntimeManager {
  private readonly getProject: () => ProjectInfo | null
  private readonly onState: (state: MinecraftRuntimeState) => void
  private readonly onEvent: (event: MinecraftRuntimeEvent) => void
  private readonly authorizeBuild?: (project: ProjectInfo) => Promise<void>
  private readonly getGradleDownloadSource?: () => Promise<GradleDownloadSourcePreference>
  private readonly getJavaPreference?: () => Promise<Partial<JavaPreferences> | undefined>
  private readonly prepareProjectDependencies?: (project: ProjectInfo, signal?: AbortSignal) => Promise<void>
  private process: ChildProcess | null = null
  private preparePromise: Promise<MinecraftRuntimeState> | null = null
  private prepareController: AbortController | null = null
  private prepareGeneration = 0
  private buildPromise: Promise<MinecraftManagedMod> | null = null
  private buildController: AbortController | null = null
  private buildProcess: ChildProcess | null = null
  private verificationProcess: ChildProcess | null = null
  private readonly gradleCleanupPromises = new Map<string, Promise<void>>()
  /** JDK homes discovered from failed builds, keyed by the requested major. */
  private readonly buildToolchainHomes = new Map<number, string>()
  private stopRequested = false
  private lastProgressAt = 0
  private lastProgressStage: MinecraftRuntimeStage | '' = ''
  private stateProjectPath = ''
  private state: MinecraftRuntimeState = {
    stage: 'idle',
    minecraftVersion: '',
    installed: false,
    running: false,
    message: '等待准备测试实例',
    mods: []
  }

  constructor(options: MinecraftRuntimeOptions) {
    this.getProject = options.getProject
    this.onState = options.onState
    this.onEvent = options.onEvent
    this.authorizeBuild = options.authorizeBuild
    this.getGradleDownloadSource = options.getGradleDownloadSource
    this.getJavaPreference = options.getJavaPreference
    this.prepareProjectDependencies = options.prepareProjectDependencies
  }

  getState(): MinecraftRuntimeState {
    return { ...this.state, ...(this.stateProjectPath ? {projectPath: this.stateProjectPath} : {}), mods: [...this.state.mods] }
  }

  /** Root holding versions/libraries/assets installed through the BMCLAPI mirrors. */
  managedMinecraftDirectory(): string {
    return this.resourceRoot()
  }

  /** Prepare Java for server-side pack tools without downloading a Minecraft instance or loader. */
  async ensureJavaRuntime(
    onProgress?: (message: string) => void,
    minimumMajorOverride?: number,
    onDownloadProgress?: (progress: ManagedJdkProgress) => void
  ): Promise<string> {
    const project = this.requireProject()
    const projectMinimumMajor = javaVersionForMinecraft(project.minecraftVersion)
    const minimumMajor = Math.max(projectMinimumMajor, minimumMajorOverride ?? projectMinimumMajor)
    const runtimeTarget = javaRuntimeTargetForMinecraft(project.minecraftVersion)
    const preferredToolsJava = await this.preferredJavaHome('tools')
    if (preferredToolsJava) {
      const preferredCandidate = await probeJavaHome(preferredToolsJava, minimumMajor, false)
      if (preferredCandidate) {
        onProgress?.(`正在使用手动选择的 Java ${preferredCandidate.major}`)
        return preferredCandidate.javaPath
      }
      onProgress?.(`手动选择的 Java 不满足工具运行要求（至少 Java ${minimumMajor}），已回退到自动配置`)
    }
    const cachedRuntime = minimumMajor === projectMinimumMajor
      ? await probeJavaHome(path.join(this.runtimeRoot(), runtimeTarget), minimumMajor, false)
      : null
    if (cachedRuntime) {
      onProgress?.(`正在使用已缓存的 Java ${cachedRuntime.major}`)
      return cachedRuntime.javaPath
    }
    onProgress?.(`正在下载 Java ${minimumMajor}`)
    let reportedSource = ''
    const managed = await ensureManagedJdk(path.join(app.getPath('userData'), 'build-jdks'), minimumMajor, (progress) => {
      const message = `正在从 ${progress.source} 下载完整 JDK ${minimumMajor}`
      this.emitProgress('downloading-java', message, progress.downloaded, progress.total)
      onDownloadProgress?.(progress)
      if (progress.source !== reportedSource) {
        reportedSource = progress.source
        onProgress?.(message)
      }
    })
    const candidate = await probeJavaHome(managed.home, minimumMajor, false)
    if (!candidate) throw new Error(`已下载的 JDK 无法运行 ServerPackCreator：${managed.home}`)
    onProgress?.(`Java ${candidate.major} 已就绪：${managed.source}`)
    return candidate.javaPath
  }

  /** Prepare a Java runtime for tools that do not belong to a project (for example decompilation). */
  async ensureJavaRuntimeForTools(
    minimumMajor = 21,
    onProgress?: (message: string) => void,
    onDownloadProgress?: (progress: ManagedJdkProgress) => void
  ): Promise<string> {
    const requiredMajor = Number.isInteger(minimumMajor) ? Math.max(8, minimumMajor) : 21
    const runtimeTarget = javaRuntimeTargetForJavaVersion(requiredMajor)
    const preferredToolsJava = await this.preferredJavaHome('tools')
    if (preferredToolsJava) {
      const preferredCandidate = await probeJavaHome(preferredToolsJava, requiredMajor, false)
      if (preferredCandidate) {
        onProgress?.(`正在使用手动选择的 Java ${preferredCandidate.major}`)
        return preferredCandidate.javaPath
      }
      onProgress?.(`手动选择的 Java 不满足工具运行要求（至少 Java ${requiredMajor}），已回退到自动配置`)
    }
    const cachedRuntime = await probeJavaHome(path.join(this.runtimeRoot(), runtimeTarget), requiredMajor, false)
    if (cachedRuntime) {
      onProgress?.(`正在使用已缓存的 Java ${cachedRuntime.major}`)
      return cachedRuntime.javaPath
    }
    onProgress?.(`正在下载 Java ${requiredMajor}`)
    let reportedSource = ''
    const managed = await ensureManagedJdk(path.join(app.getPath('userData'), 'build-jdks'), requiredMajor, (progress) => {
      const message = `正在从 ${progress.source} 下载完整 JDK ${requiredMajor}`
      this.emitProgress('downloading-java', message, progress.downloaded, progress.total)
      onDownloadProgress?.(progress)
      if (progress.source !== reportedSource) {
        reportedSource = progress.source
        onProgress?.(message)
      }
    })
    const candidate = await probeJavaHome(managed.home, requiredMajor, false)
    if (!candidate) throw new Error(`已下载的 JDK 无法运行反编译工具：${managed.home}`)
    onProgress?.(`Java ${candidate.major} 已就绪：${managed.source}`)
    return candidate.javaPath
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
    if (this.preparePromise) return waitWithAbort(this.preparePromise, signal)
    const controller = new AbortController()
    const generation = ++this.prepareGeneration
    this.prepareController = controller
    const forwardAbort = (): void => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    this.preparePromise = this.prepareInternal(controller.signal, generation)
      .catch((error: unknown) => {
        if (this.prepareGeneration === generation) this.prepareGeneration += 1
        const message = error instanceof Error ? error.message : String(error)
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
    if (!isJavaLoader(project.loader)) {
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

    if (project.kind !== 'modpack') {
      const syncedArtifact = path.join(this.modsRoot(project), projectArtifactName(project))
      if (!(await exists(syncedArtifact))) throw new Error('测试实例中没有已同步的项目 Mod，请先点击“构建并同步”')
      await validateModArtifact(syncedArtifact, project.loader)
    } else {
      const manifest = await readModpackManifest(project)
      const synced = await fs.readFile(path.join(this.instanceRoot(project), 'modmind-pack-sync.json'), 'utf8')
        .then((value) => JSON.parse(value) as { files?: unknown })
        .catch(() => null)
      if (!synced || !Array.isArray(synced.files)) throw new Error('整合包尚未同步，请先点击“同步整合包”')
      if (!manifest.mods.length && !manifest.modules.length) this.emit('launching', '正在启动空整合包实例')
    }
    if (signal?.aborted) throw Object.assign(new Error('Minecraft 启动已取消'), { name: 'AbortError' })
    await this.prepare(signal)
    const metadata = await this.readMetadata(project)
    if (!metadata) throw new Error('Minecraft 测试实例尚未准备完成')
    const launchJavaPath = await this.resolveLaunchJava(project, metadata)

    const instanceRoot = this.instanceRoot(project)
    await fs.mkdir(instanceRoot, { recursive: true })
    this.stopRequested = false
    this.updateState({ lastCrash: undefined })
    this.emit('launching', '正在生成离线启动参数')
    const launchedAt = Date.now()
    let child: ChildProcess
    try {
      child = await launch({
        spawn: (command, args, options) => spawnManaged(command, [...(args ?? [])], options ?? {}),
        gamePath: instanceRoot,
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
        resolution: { width: options.width ?? 1280, height: options.height ?? 720 },
        extraExecOption: { cwd: instanceRoot, windowsHide: false }
      })
    } catch (error) {
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
    const launcherLog = createWriteStream(path.join(instanceRoot, 'launcher-console.log'), { flags: 'w' })
    child.stdout?.pipe(launcherLog, { end: false })
    child.stderr?.pipe(launcherLog, { end: false })
    child.stdout?.on('data', (chunk: Buffer) => this.emit('running', chunk.toString('utf8').trim(), 'info', false))
    child.stderr?.on('data', (chunk: Buffer) => this.emit('running', chunk.toString('utf8').trim(), 'warning', false))
    child.once('spawn', () => {
      this.updateState({ stage: 'running', running: true, pid: child.pid, message: 'Minecraft 测试实例运行中' })
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
      launcherLog.end(() => {
        void this.handleMinecraftExit(project, launchedAt, code, signal, intentionallyStopped)
      })
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

  async inspectMinecraftClass(className: string): Promise<string> {
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(className)) {
      throw new Error('Minecraft 类名格式无效')
    }
    const project = this.requireProject()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 不使用 Java mappings`)
    const cacheRoot = path.join(
      app.getPath('userData'),
      'gradle-runtime',
      'cache',
      'caches',
      'fabric-loom',
      'minecraftMaven',
      'net',
      'minecraft',
      'minecraft-merged'
    )
    const mappedJar = await findFile(
      cacheRoot,
      (name, fullPath) => name.endsWith('.jar') && name.includes(project.minecraftVersion) && !fullPath.includes('intermediary')
    )
    if (!mappedJar) throw new Error('尚未找到当前版本的 Minecraft 映射 JAR；请先调用 build_project')
    const { javaPath } = await this.ensureJava(project)
    const javap = path.join(path.dirname(javaPath), process.platform === 'win32' ? 'javap.exe' : 'javap')
    const runJavap = async (classPath: string): Promise<{ output: string; error: string; exitCode: number }> => {
      const child = spawn(javap, ['-classpath', classPath, className], { windowsHide: true, shell: false })
      let output = ''
      let errorOutput = ''
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length < 100_000) output += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (errorOutput.length < 20_000) errorOutput += chunk.toString('utf8')
      })
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('javap class inspection timed out'))
        }, 20_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolve(code ?? 1)
        })
      })
      return { output: output.trim(), error: errorOutput.trim(), exitCode }
    }

    const minecraftResult = await runJavap(mappedJar)
    if (minecraftResult.exitCode === 0) return minecraftResult.output

    const modulesRoot = path.join(
      app.getPath('userData'),
      'gradle-runtime',
      'cache',
      'caches',
      'modules-2',
      'files-2.1'
    )
    const classGroupPrefix = className.split('.').slice(0, 2).join('.')
    const groupDirectories = (await fs.readdir(modulesRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name === classGroupPrefix || entry.name.startsWith(`${classGroupPrefix}.`))
      .map((entry) => path.join(modulesRoot, entry.name))
    const dependencyJars = (
      await Promise.all(
        groupDirectories.map((directory) =>
          findFiles(directory, (name) => name.endsWith('.jar') && !/(?:sources|javadoc)\.jar$/i.test(name))
        )
      )
    ).flat()
    dependencyJars.push(
      ...(await findFiles(
        this.modsRoot(project),
        (name) => name.endsWith('.jar') && name !== projectArtifactName(project),
        100
      ))
    )
    const uniqueJars = [...new Set(dependencyJars)]
    if (uniqueJars.length) {
      const dependencyResult = await runJavap([mappedJar, ...uniqueJars].join(path.delimiter))
      if (dependencyResult.exitCode === 0) return dependencyResult.output
      if (dependencyResult.error) throw new Error(dependencyResult.error)
    }
    throw new Error(minecraftResult.error || `javap exited with code ${minecraftResult.exitCode}`)
  }

  async stop(): Promise<MinecraftRuntimeState> {
    await this.cancelPreparation()
    this.buildController?.abort()
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

  private killProcessTree(child: ChildProcess): void {
    void stopProcessTree(child)
  }

  private spawnGradle(
    runtime: GradleRuntimeSelection,
    project: ProjectInfo,
    args: string[],
    env: NodeJS.ProcessEnv
  ): ChildProcessWithoutNullStreams {
    const toolchainHomes = env.MODMIND_GRADLE_JAVA_HOMES?.trim()
    const toolchainEnvNames = env.MODMIND_GRADLE_JAVA_ENV_NAMES?.trim()
    const managedArguments = toolchainHomes
      ? [
          `-Dorg.gradle.java.installations.paths=${toolchainHomes}`,
          ...(toolchainEnvNames ? [`-Dorg.gradle.java.installations.fromEnv=${toolchainEnvNames}`] : []),
          '-Dorg.gradle.java.installations.auto-detect=true',
          '-Dorg.gradle.java.installations.auto-download=false',
          ...args
        ]
      : args
    const invocation = process.platform === 'win32'
      ? windowsCmdInvocation(runtime.executable, managedArguments)
      : { command: runtime.executable, args: managedArguments, windowsVerbatimArguments: false as const }
    return spawnManaged(invocation.command, invocation.args, {
      cwd: project.path,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      env
    })
  }

  private gradleEnvironment(runtime: GradleRuntimeSelection): NodeJS.ProcessEnv {
    const homes = mergeToolchainJavaHomes(this.buildToolchainHomes.values())
    const javaEnvironment = Object.fromEntries([...this.buildToolchainHomes.entries()].map(([major, home]) => [`MODMIND_JAVA_${major}`, home]))
    const javaEnvironmentNames = Object.keys(javaEnvironment).join(',')
    const proxy = javaProxyOptions(getNetworkProxyUrl())
    const existingJavaOptions = process.env.JAVA_TOOL_OPTIONS?.trim() ?? ''
    return {
      ...process.env,
      JAVA_HOME: runtime.javaHome,
      GRADLE_USER_HOME: path.join(app.getPath('userData'), 'gradle-runtime', 'cache'),
      ...(homes ? { MODMIND_GRADLE_JAVA_HOMES: homes } : {}),
      ...(javaEnvironmentNames ? { MODMIND_GRADLE_JAVA_ENV_NAMES: javaEnvironmentNames, ...javaEnvironment } : {}),
      ...(proxy ? { JAVA_TOOL_OPTIONS: `${existingJavaOptions}${existingJavaOptions ? ' ' : ''}${proxy}` } : {})
    }
  }

  private async stopStaleGradleDaemons(runtime: GradleRuntimeSelection, project: ProjectInfo, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
    const key = `${runtime.javaHome}|${gradleVersionFor(project)}`
    const existing = this.gradleCleanupPromises.get(key)
    if (existing) return existing
    const cleanup = (async (): Promise<void> => {
      if (signal?.aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
      this.emit('building-mod', '正在清理 ModMind 上次遗留的 Gradle 守护进程')
      const child = this.spawnGradle(runtime, project, ['--stop', '--console=plain'], env)
      let output = ''
      let spawnError = ''
      child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-20_000) })
      child.stderr.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-20_000) })
      child.once('error', (error) => { spawnError = error.message })
      const abort = (): void => this.killProcessTree(child)
      signal?.addEventListener('abort', abort, { once: true })
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          this.killProcessTree(child)
          resolve({ code: null, signal: null, timedOut: true })
        }, 20_000)
        child.once('close', (code, closeSignal) => {
          clearTimeout(timer)
          resolve({ code: normalizeProcessExitCode(code), signal: closeSignal, timedOut: false })
        })
      })
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
      if (spawnError || result.timedOut || result.code !== 0) {
        const detail = spawnError || (result.timedOut ? '清理超过 20 秒' : describeProcessTermination(result.code, result.signal))
        this.emit('building-mod', `Gradle 历史进程清理未完成：${detail}${output.trim() ? `；${output.trim().split(/\r?\n/).at(-1)}` : ''}`, 'warning')
      }
    })()
    this.gradleCleanupPromises.set(key, cleanup)
    try {
      await cleanup
    } catch (error) {
      this.gradleCleanupPromises.delete(key)
      throw error
    }
  }

  private async gradleRuntime(project: ProjectInfo): Promise<GradleRuntimeSelection> {
    const javaPath = await this.ensureBuildJava(project)
    const wrapperPath = projectGradleWrapperExecutable(project.path)
    if (!(await exists(wrapperPath))) {
      throw new Error(`项目缺少 Gradle Wrapper：${path.basename(wrapperPath)}。请先在项目根目录提供可用的 Wrapper`)
    }
    if (process.platform !== 'win32') await fs.chmod(wrapperPath, 0o755)
    return { executable: wrapperPath, javaHome: path.dirname(path.dirname(javaPath)), usesWrapper: true, source: 'wrapper' }
  }

  private async ensureBuildJava(project: ProjectInfo): Promise<string> {
    const range = buildJavaRangeForProject(project)
    const preferredBuildJava = await this.preferredJavaHome('build')
    if (preferredBuildJava) {
      const preferredCandidate = await probeJavaHome(preferredBuildJava, range.minimum, true, range.maximum)
      if (preferredCandidate) {
        this.buildToolchainHomes.set(preferredCandidate.major, path.dirname(path.dirname(preferredCandidate.javaPath)))
        this.emit('building-mod', `使用手动选择的 JDK ${preferredCandidate.major}：${preferredCandidate.javaPath}`)
        return preferredCandidate.javaPath
      }
      this.emit(
        'building-mod',
        `手动选择的 JDK 不满足本项目编译要求（需要 Java ${range.minimum}${Number.isFinite(range.maximum) ? ` - ${range.maximum}` : '+'}，且包含 javac），已回退到自动配置：${preferredBuildJava}`,
        'warning'
      )
    }
    for (const home of await configuredBuildJavaHomes(project)) {
      const candidate = await probeJavaHome(home, range.minimum, true, range.maximum)
      if (candidate) {
        this.buildToolchainHomes.set(candidate.major, path.dirname(path.dirname(candidate.javaPath)))
        this.emit('building-mod', `使用项目/系统 JDK ${candidate.major}：${candidate.javaPath}`)
        return candidate.javaPath
      }
      this.emit('building-mod', `已跳过不可用的项目/系统 Java：${home}`, 'warning')
    }
    const managed = await ensureManagedJdk(path.join(app.getPath('userData'), 'build-jdks'), range.minimum, (progress) => {
      this.emitProgress('downloading-java', `正在从${progress.source}下载完整 JDK ${range.minimum}`, progress.downloaded, progress.total)
    })
    const candidate = await probeJavaHome(managed.home, range.minimum, true, range.maximum)
    if (!candidate) {
      throw new Error(`ModMind 下载的 JDK 无法用于 Gradle 编译：${managed.home}。请设置有效的 JDK（包含 javac）或修复 JDK 缓存`)
    }
    this.emit('building-mod', `使用已验证的 JDK ${candidate.major}（${managed.source}）：${candidate.javaPath}`)
    this.buildToolchainHomes.set(candidate.major, path.dirname(path.dirname(candidate.javaPath)))
    return candidate.javaPath
  }

  /**
   * Forge and Gradle can request additional toolchain JDKs after the build has
   * already started. Resolve those versions from the actual failure output,
   * register their homes with Gradle, and let the caller retry the same task.
   */
  private async ensureDetectedBuildToolchains(logText: string, project?: ProjectInfo): Promise<boolean> {
    const requirements = detectToolchainRequirements(logText)
    const configuredHomes = project ? await configuredBuildJavaHomes(project) : []
    let changed = false
    for (const major of requirements.javaMajors) {
      if (this.buildToolchainHomes.has(major)) continue
      const existing = await Promise.all(configuredHomes.map((home) => probeJavaHome(home, major, true, major)))
      const configured = existing.find((candidate): candidate is JavaProbeResult => Boolean(candidate))
      if (configured) {
        this.buildToolchainHomes.set(major, path.dirname(path.dirname(configured.javaPath)))
        this.emit('building-mod', `发现并配置现有 JDK ${major}：${configured.javaPath}`)
        changed = true
        continue
      }
      this.emit('building-mod', `构建日志要求 Java ${major}，正在自动准备对应 JDK`, 'warning')
      const managed = await ensureManagedJdk(path.join(app.getPath('userData'), 'build-jdks'), major, (progress) => {
        this.emitProgress('downloading-java', `正在为构建下载 JDK ${major}（${progress.source}）`, progress.downloaded, progress.total)
      })
      const candidate = await probeJavaHome(managed.home, major, true)
      if (!candidate) throw new Error(`自动下载的 JDK ${major} 未通过 javac 验证：${managed.home}`)
      this.buildToolchainHomes.set(major, path.dirname(path.dirname(candidate.javaPath)))
      this.emit('building-mod', `JDK ${major} 已配置，正在重新尝试构建`)
      changed = true
    }
    return changed
  }

  async testGradleTask(candidates: string[], stableWindowMs = 0, signal?: AbortSignal): Promise<GradleVerificationResult> {
    const project = this.requireProject()
    if (!isJavaLoader(project.loader)) return { skipped: true, success: true, summary: `${platformLabel(project.loader)} 不使用 Gradle 运行任务` }
    if (project.kind === 'modpack') return { skipped: true, success: true, summary: '整合包没有统一的 Gradle 运行任务；请使用客户端启动测试' }
    if (this.process || this.verificationProcess || this.buildPromise) throw new Error('已有 Minecraft、构建或验证任务正在运行')
    await this.authorizeBuild?.(project)
    const runtime = await this.gradleRuntime(project)
    const env = this.gradleEnvironment(runtime)
    const taskList = this.spawnGradle(runtime, project, ['tasks', '--all', '--console=plain', '--no-daemon'], env)
    let taskOutput = ''
    taskList.stdout.on('data', (chunk: Buffer) => { if (taskOutput.length < 2_000_000) taskOutput += chunk.toString('utf8') })
    taskList.stderr.on('data', (chunk: Buffer) => { if (taskOutput.length < 2_000_000) taskOutput += chunk.toString('utf8') })
    const taskExit = await new Promise<number>((resolve, reject) => {
      taskList.once('error', reject)
      taskList.once('exit', (code) => resolve(code ?? 1))
    })
    if (taskExit !== 0) throw new Error(`无法读取 Gradle 任务：${summarizeGradleFailure(taskOutput)}`)
    const task = candidates.find((candidate) => new RegExp(`^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(taskOutput))
    if (!task) return { skipped: true, success: true, summary: `项目没有提供 ${candidates.join(' / ')} 任务` }

    await fs.mkdir(path.join(project.path, 'run'), { recursive: true })
    await fs.writeFile(path.join(project.path, 'run', 'eula.txt'), 'eula=true\n', 'utf8')
    const logDirectory = path.join(project.path, projectDataDirectory(project), 'builds')
    await fs.mkdir(logDirectory, { recursive: true })
    const logPath = path.join(logDirectory, `${task}-${Date.now()}.log`)
    const log = createWriteStream(logPath, { flags: 'w' })
    this.emit('testing-server', `正在执行 Gradle ${task}`)
    const preparationTasks = ['runClient', 'runServer', 'runGameTestServer'].includes(task)
      ? ['processResources', 'classes']
      : []
    const child = this.spawnGradle(runtime, project, [...preparationTasks, task, '--console=plain', '--no-daemon', '--stacktrace'], env)
    this.verificationProcess = child
    let output = ''
    let readyAt = 0
    const capture = (chunk: Buffer, level: MinecraftRuntimeEvent['level']): void => {
      const text = chunk.toString('utf8')
      log.write(text)
      output = `${output}${text}`.slice(-200_000)
      if (/Done \([\d.]+s\)!|For help, type "help"|Server started|Dedicated server took/i.test(text)) readyAt ||= Date.now()
      const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1)
      if (line) this.emit('testing-server', line, level, false)
    }
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'info'))
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'warning'))
    let exitCode: number | null = null
    child.once('exit', (code) => { exitCode = code ?? 1 })
    const abort = (): void => this.killProcessTree(child)
    signal?.addEventListener('abort', abort, { once: true })
    const deadline = Date.now() + (stableWindowMs ? 150_000 : 10 * 60_000)
    while (exitCode === null && Date.now() < deadline) {
      if (signal?.aborted) break
      if (stableWindowMs && readyAt && Date.now() - readyAt >= stableWindowMs) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const reachedStableWindow = Boolean(stableWindowMs && readyAt && Date.now() - readyAt >= stableWindowMs)
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
    const detail = summarizeGradleFailure(output)
    this.emit('error', `${task} 验证失败`, 'error')
    return { task, skipped: false, success: false, summary: detail || (exitCode === null ? `${task} 超时` : `${task} 退出代码 ${exitCode}`), logPath }
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

    const manifest = await readModpackManifest(project)
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
      const root = path.resolve(project.path, ...module.path.split('/'))
      if (!root.startsWith(`${path.resolve(project.path)}${path.sep}`)) throw new Error(`自制 Mod ${module.name} 的路径无效`)
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
        const moduleProject: ProjectInfo = { ...project, kind: 'mod', name: module.name, namespace: module.namespace, path: root }
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
          if (!previouslySynced.has(entry.targetName.toLowerCase())) await validateModArtifact(entry.source, project.loader)
          written.push(entry.targetName)
        } else {
          await replaceModArtifact(entry.source, path.join(staging, entry.targetName), project.loader)
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
    await fs.writeFile(statePath, `${JSON.stringify({ files: written, overrides }, null, 2)}\n`, 'utf8')
    this.emit('syncing-mod', `Synced ${written.length} modpack mods and ${overrides.length} override files`)
    await this.refresh()
    this.updateState({ stage: 'idle', message: `已同步 ${written.length} 个整合包 Mod 和 ${overrides.length} 个配置文件` })
    return this.getState()
  }

  buildProject(signal?: AbortSignal): Promise<MinecraftManagedMod> {
    if (this.buildPromise) return this.buildPromise
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(signal?.reason)
    if (signal?.aborted) forwardAbort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })
    this.buildController = controller
    this.buildPromise = this.buildProjectInternal(controller.signal)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof Error && error.name === 'AbortError') {
          this.updateState({ stage: 'idle', message: '构建已取消' })
          this.onEvent({ stage: 'idle', message: '构建已取消', level: 'info', time: new Date().toISOString() })
          throw error
        }
        this.updateState({ stage: 'error', message })
        this.onEvent({ stage: 'error', message, level: 'error', time: new Date().toISOString() })
        throw error
      })
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort)
        if (this.buildController === controller) this.buildController = null
        this.buildPromise = null
      })
    return this.buildPromise
  }

  private async buildProjectInternal(signal?: AbortSignal, retryAttempt = 0): Promise<MinecraftManagedMod> {
    const project = this.requireProject()
    if (this.process && this.state.running) {
      throw new Error('Minecraft 测试实例正在运行。请先停止测试再构建，避免覆盖正在加载的项目 JAR')
    }
    if (signal?.aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
    await this.authorizeBuild?.(project)
    if (project.kind === 'modpack') return this.buildModpackInternal(project, signal)
    if (project.kind === 'server-plugin') {
      if (!isServerPluginPlatform(project.loader)) throw new Error('插件工程平台无效')
      if (await exists(path.join(project.path, 'pom.xml')) && !await exists(path.join(project.path, 'build.gradle')) && !await exists(path.join(project.path, 'build.gradle.kts'))) {
        await buildMavenPlugin(project, { javaPath: await this.ensureBuildJava(project), cacheRoot: path.join(app.getPath('userData'), 'maven-runtime'), signal, onOutput: output => this.emit('building-mod', output.trim().slice(-2000)) })
      } else await this.runGradleBuild(project, signal)
      const artifact = await findPluginArtifact(project)
      this.updateState({ stage: 'idle', message: `插件构建完成：${artifact.name}`, mods: [artifact] })
      return artifact
    }
    if (!isJavaLoader(project.loader)) {
      this.emit('building-mod', project.loader === 'bedrock' ? '正在校验并打包基岩 Add-On' : '正在校验并归档网易工作台工程')
      const artifactPath = project.loader === 'bedrock'
        ? await buildBedrockAddon(project)
        : await buildNeteaseArchive(project)
      const stat = await fs.stat(artifactPath)
      const artifact: MinecraftManagedMod = {
        name: path.basename(artifactPath),
        path: artifactPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        projectArtifact: true
      }
      this.updateState({ stage: 'idle', message: `构建完成：${artifact.name}`, mods: [artifact] })
      this.emit('syncing-mod', project.loader === 'bedrock' ? '已生成可导入的 .mcaddon' : '已生成网易开发者工作台工程归档')
      return artifact
    }
    await this.prepareProjectDependencies?.(project, signal)
    await this.prepareGradleMavenFallback(project)
    await this.prepareGradleWrapperDownload(project, retryAttempt)
    const runtime = await this.gradleRuntime(project)
    const logDirectory = path.join(project.path, projectDataDirectory(project), 'builds')
    const logPath = path.join(logDirectory, 'minecraft-test-build.log')
    await fs.mkdir(logDirectory, { recursive: true })
    const javaHome = runtime.javaHome
    const javaPath = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const gradleEnvironment = this.gradleEnvironment(runtime)
    await this.stopStaleGradleDaemons(runtime, project, gradleEnvironment, signal)
    if (signal?.aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
    const log = createWriteStream(logPath, { flags: 'w' })
    this.emit('building-mod', '正在使用项目 Gradle Wrapper 执行 gradlew build')

    const child = this.spawnGradle(runtime, project, [...MANAGED_GRADLE_BUILD_ARGUMENTS], gradleEnvironment)
    this.buildProcess = child
    let spawnError = ''
    child.once('error', (error) => {
      spawnError = `${error.name}: ${error.message}${typeof (error as NodeJS.ErrnoException).code === 'string' ? ` (code ${(error as NodeJS.ErrnoException).code})` : ''}`
    })
    let aborted = false
    const abortBuild = (): void => {
      aborted = true
      if (!child.pid) return
      void stopProcessTree(child)
    }
    signal?.addEventListener('abort', abortBuild, { once: true })
    const recentLines: string[] = []
    let gradleDownloadActivityId = ''
    const capture = (chunk: Buffer, level: MinecraftRuntimeEvent['level']): void => {
      const text = chunk.toString('utf8')
      log.write(text)
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      recentLines.push(...lines)
      if (recentLines.length > 60) recentLines.splice(0, recentLines.length - 60)
      const visible = lines.at(-1)
      if (visible) this.emit('building-mod', visible, level, false)
      const downloadUrl = text.match(/Downloading\s+(https?:\/\/[^\s\r\n]+)/i)?.[1]
      if (downloadUrl && !gradleDownloadActivityId) {
        const fileName = decodeURIComponent(new URL(downloadUrl).pathname.split('/').at(-1) || 'Gradle distribution')
        gradleDownloadActivityId = downloadActivities.start({ label: fileName, detail: 'Gradle Wrapper' })
      }
    }
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'info'))
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'warning'))
    const termination = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, closeSignal) => resolve({ code: normalizeProcessExitCode(code), signal: closeSignal }))
    })
    this.buildProcess = null
    signal?.removeEventListener('abort', abortBuild)
    await new Promise<void>((resolve) => log.end(resolve))
    if (gradleDownloadActivityId) {
      if (termination.code === 0) downloadActivities.complete(gradleDownloadActivityId)
      else downloadActivities.fail(gradleDownloadActivityId, recentLines.at(-1) || `Gradle ${describeProcessTermination(termination.code, termination.signal)}`)
    }
    if (aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
    if (spawnError) throw new Error(`无法启动 Gradle Wrapper：${spawnError}\nJava: ${javaPath}\nWrapper: ${runtime.executable}\n工作目录：${project.path}`)
    if (termination.code !== 0) {
      const fullLog = await fs.readFile(logPath, 'utf8').catch(() => recentLines.join('\n'))
      if (!aborted && retryAttempt < 4) {
        const toolchainsPrepared = await this.ensureDetectedBuildToolchains(fullLog, project)
        if (toolchainsPrepared) {
          this.emit('building-mod', '已根据构建日志补齐工具链，正在重试原构建任务', 'warning')
          return this.buildProjectInternal(signal, retryAttempt + 1)
        }
      }
      const detail = summarizeGradleFailure(fullLog)
      if (!aborted && retryAttempt < 2 && isGradleNetworkFailure(fullLog)) {
        this.emit('building-mod', 'Gradle 下载源暂时不可用，正在切换备用源重试', 'warning')
        return this.buildProjectInternal(signal, retryAttempt + 1)
      }
      throw new Error(`Gradle 构建失败（${describeProcessTermination(termination.code, termination.signal)}）${detail ? `\n${detail}` : ''}\n完整日志：${logPath}`)
    }
    const artifact = await this.syncProjectMod()
    if (!artifact) throw new Error('Gradle 构建成功，但 build/libs 中没有找到可运行的 Mod JAR')
    this.emit('syncing-mod', '项目构建完成并已同步到测试实例')
    return artifact
  }

  private async buildModpackInternal(project: ProjectInfo, signal?: AbortSignal): Promise<MinecraftManagedMod> {
    if (!isJavaLoader(project.loader)) throw new Error('整合包必须使用 Java Edition Loader')
    const manifest = await readModpackManifest(project)
    for (const module of manifest.modules) {
      const moduleRoot = path.resolve(project.path, ...module.path.split('/'))
      if (!moduleRoot.startsWith(`${path.resolve(project.path)}${path.sep}`)) throw new Error(`自制 Mod ${module.name} 的路径无效`)
      const moduleProject: ProjectInfo = { ...project, kind: 'mod', name: module.name, namespace: module.namespace, path: moduleRoot }
      if (!(await exists(path.join(moduleRoot, 'build.gradle'))) && !(await exists(path.join(moduleRoot, 'build.gradle.kts')))) {
        throw new Error(`自制 Mod ${module.name} 缺少 Gradle 构建文件`)
      }
      await this.authorizeBuild?.(moduleProject)
      this.emit('building-mod', `正在构建自制 Mod：${module.name}`)
      await this.runGradleBuild(moduleProject, signal)
    }
    await this.syncModpack()
    const mods = await this.listMods()
    const size = mods.reduce((total, mod) => total + mod.size, 0)
    const artifact: MinecraftManagedMod = {
      name: `${project.namespace}.mrpack 工作区`,
      path: project.path,
      size,
      modifiedAt: new Date().toISOString(),
      projectArtifact: true
    }
    this.updateState({ stage: 'idle', message: `整合包构建并同步完成：${mods.length} 个 Mod`, mods })
    return artifact
  }

  private async prepareGradleWrapperDownload(project: ProjectInfo, attempt: number, signal?: AbortSignal): Promise<void> {
    const propertiesPath = path.join(project.path, 'gradle', 'wrapper', 'gradle-wrapper.properties')
    const content = await fs.readFile(propertiesPath, 'utf8').catch(() => '')
    const match = content.match(/distributionUrl=.*?gradle-([0-9A-Za-z.+_-]+)-(bin|all)\.zip/i)
    if (!match) return
    const configuredUrl = content.match(/^distributionUrl\s*=\s*(.+)$/mi)?.[1]?.trim().replaceAll('\\:', ':') ?? ''
    const preference = await this.getGradleDownloadSource?.() ?? 'auto'
    const sources = gradleDistributionSources(match[1], preference, match[2].toLowerCase() as 'bin' | 'all')
    if (project.kind === 'server-plugin') {
      const checksum = content.match(/^distributionSha256Sum\s*=\s*([a-f0-9]{64})\s*$/mi)?.[1]
      if (checksum && /^https:\/\//i.test(configuredUrl)) {
        const key = BigInt(`0x${createHash('md5').update(configuredUrl).digest('hex')}`).toString(36)
        const filename = `gradle-${match[1]}-${match[2]}.zip`
        const cache = path.join(app.getPath('userData'), 'gradle-runtime/cache/wrapper/dists', filename.slice(0, -4), key)
        const archive = path.join(cache, filename)
        if (!await exists(`${archive}.ok`) && !await exists(archive)) {
          await verifiedDownload.download({ sources: sources.map(source => ({ ...source })), destination: archive, expectedHash: { algorithm: 'sha256', value: checksum }, signal, timeoutMs: 120_000, retriesPerSource: 1, onProgress: progress => this.emitProgress('building-mod', `正在下载 Gradle ${match[1]}：${progress.source.label}`, progress.downloaded, progress.total ?? 0) })
        }
        return
      }
    }
    // Keep the project's original/recommended distribution on the first run.
    // Only rewrite the URL after a failed attempt, then walk every distinct
    // mirror before surfacing the original failure.
    if (attempt === 0 && /^https:\/\//i.test(configuredUrl)) return
    const alternatives = sources.filter((source) => source.url !== configuredUrl)
    const index = sources.findIndex(source => source.url === configuredUrl)
    const source = index >= 0 ? sources[(index + 1) % sources.length] : alternatives[0]
    if (!source) return
    const next = content.replace(/distributionUrl=.*$/m, `distributionUrl=${source.url.replace(/:/g, '\\:')}`)
    if (next !== content) await fs.writeFile(propertiesPath, next, 'utf8')
  }

  private async prepareGradleMavenFallback(project: ProjectInfo): Promise<void> {
    if (project.loader !== 'fabric' && project.loader !== 'quilt') return
    for (const name of ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']) {
      const target = path.join(project.path, name)
      const source = await fs.readFile(target, 'utf8').catch(() => null)
      if (source === null) continue
      const next = ensureGradleMavenFallback(source, name.endsWith('.kts'))
      if (next !== source) await fs.writeFile(target, next, 'utf8')
    }
  }

  private async runGradleBuild(project: ProjectInfo, signal?: AbortSignal, retryAttempt = 0): Promise<void> {
    await this.prepareGradleMavenFallback(project)
    await this.prepareGradleWrapperDownload(project, retryAttempt, signal)
    const runtime = await this.gradleRuntime(project)
    const logDirectory = path.join(project.path, projectDataDirectory(project), 'builds')
    const logPath = path.join(logDirectory, 'minecraft-test-build.log')
    await fs.mkdir(logDirectory, { recursive: true })
    const javaHome = runtime.javaHome
    const javaPath = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const gradleEnvironment = this.gradleEnvironment(runtime)
    await this.stopStaleGradleDaemons(runtime, project, gradleEnvironment, signal)
    if (signal?.aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
    const log = createWriteStream(logPath, { flags: 'w' })
    const child = this.spawnGradle(runtime, project, [...MANAGED_GRADLE_BUILD_ARGUMENTS], gradleEnvironment)
    this.buildProcess = child
    let output = ''
    let spawnError = ''
    let aborted = false
    let gradleDownloadActivityId = ''
    child.once('error', (error) => { spawnError = `${error.name}: ${error.message}` })
    const abort = (): void => {
      aborted = true
      if (child.pid) this.killProcessTree(child)
    }
    signal?.addEventListener('abort', abort, { once: true })
    const capture = (chunk: Buffer, level: MinecraftRuntimeEvent['level']): void => {
      const text = chunk.toString('utf8')
      output = `${output}${text}`.slice(-200_000)
      log.write(text)
      const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1)
      if (line) this.emit('building-mod', line, level, false)
      const downloadUrl = text.match(/Downloading\s+(https?:\/\/[^\s\r\n]+)/i)?.[1]
      if (downloadUrl && !gradleDownloadActivityId) {
        const fileName = decodeURIComponent(new URL(downloadUrl).pathname.split('/').at(-1) || 'Gradle distribution')
        gradleDownloadActivityId = downloadActivities.start({ label: fileName, detail: 'Gradle Wrapper' })
      }
    }
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'info'))
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'warning'))
    const termination = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, closeSignal) => resolve({ code: normalizeProcessExitCode(code), signal: closeSignal }))
    })
    this.buildProcess = null
    signal?.removeEventListener('abort', abort)
    await new Promise<void>((resolve) => log.end(resolve))
    if (gradleDownloadActivityId) {
      if (termination.code === 0) downloadActivities.complete(gradleDownloadActivityId)
      else downloadActivities.fail(gradleDownloadActivityId, output.trim().split(/\r?\n/).at(-1) || `Gradle ${describeProcessTermination(termination.code, termination.signal)}`)
    }
    if (aborted) throw Object.assign(new Error('构建已取消'), { name: 'AbortError' })
    if (spawnError) throw new Error(`无法启动 Gradle Wrapper：${spawnError}\nJava: ${javaPath}\nWrapper: ${runtime.executable}`)
    if (termination.code !== 0) {
      const fullLog = await fs.readFile(logPath, 'utf8').catch(() => output)
      if (!aborted && retryAttempt < 4) {
        const toolchainsPrepared = await this.ensureDetectedBuildToolchains(fullLog, project)
        if (toolchainsPrepared) {
          this.emit('building-mod', '已根据构建日志补齐工具链，正在重试原构建任务', 'warning')
          return this.runGradleBuild(project, signal, retryAttempt + 1)
        }
      }
      if (!aborted && retryAttempt < 2 && isGradleNetworkFailure(fullLog)) {
        this.emit('building-mod', 'Gradle 下载源暂时不可用，正在切换备用源重试', 'warning')
        return this.runGradleBuild(project, signal, retryAttempt + 1)
      }
      throw new Error(`自制 Mod 构建失败（${describeProcessTermination(termination.code, termination.signal)}）\n${summarizeGradleFailure(fullLog)}\n完整日志：${logPath}`)
    }
  }

  async buildDependencyProject(project: ProjectInfo, signal?: AbortSignal): Promise<string> {
    if (!isJavaLoader(project.loader) || project.kind === 'modpack') throw new Error('关联目标必须是 Java 模组项目')
    if (signal?.aborted) throw Object.assign(new Error('关联项目构建已取消'), { name: 'AbortError' })
    await this.authorizeBuild?.(project)
    this.emit('building-mod', `正在构建关联项目：${project.name}`)
    await this.runGradleBuild(project, signal)
    const directory = path.join(project.path, 'build', 'libs')
    const candidates = await Promise.all((await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jar') && !/(?:sources|javadoc|dev|shadow)/i.test(entry.name))
      .map(async (entry) => ({ path: path.join(directory, entry.name), stat: await fs.stat(path.join(directory, entry.name)) })))
    const artifact = candidates.filter((entry) => entry.stat.size >= 1_024).sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]
    if (!artifact) throw new Error(`关联项目 ${project.name} 构建完成但没有生成可用 JAR`)
    await validateModArtifact(artifact.path, project.loader)
    return artifact.path
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

  private async prepareInternal(signal?: AbortSignal, generation = this.prepareGeneration): Promise<MinecraftRuntimeState> {
    const project = this.requireProject()
    if (signal?.aborted) throw abortError()
    if (!isJavaLoader(project.loader)) throw new Error(`${platformLabel(project.loader)} 必须使用对应官方客户端或开发者工作台测试`)
    const configuredLoaderVersion = (await readConfiguredLoaderVersion(project)) ?? project.loaderVersion
    await fs.mkdir(this.instanceRoot(project), { recursive: true })
    await fs.mkdir(this.resourceRoot(), { recursive: true })
    if (signal?.aborted) throw abortError()
    if (project.kind !== 'modpack' && (project.loader === 'fabric' || project.loader === 'quilt')) await this.ensureManagedLoaderApi(project)
    const cached = await this.readMetadata(project)
    const cachedVersionJson = cached
      ? path.join(this.resourceRoot(), 'versions', cached.loaderVersionId, `${cached.loaderVersionId}.json`)
      : ''
    const cachedJavaReady = cached
      ? await probeJavaHome(path.dirname(path.dirname(cached.javaPath)), javaVersionForMinecraft(project.minecraftVersion), false)
      : false
    const cachedDependenciesReady = cached && cachedJavaReady && await this.verifyCachedRuntime(cached.loaderVersionId)
    if (cached && !cachedDependenciesReady) await this.removeInvalidCachedAssetIndex(cached.loaderVersionId)
    if (
      cached &&
      (!configuredLoaderVersion || cached.loaderVersion === configuredLoaderVersion) &&
      cachedJavaReady &&
      cachedDependenciesReady &&
      (await exists(cachedVersionJson))
    ) {
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

    this.emit('downloading-game', `正在下载 Minecraft ${project.minecraftVersion}`)
    diagnosticJournal.record({
      subsystem: 'minecraft-download',
      operation: 'install-client',
      phase: 'start',
      message: `Installing Minecraft ${project.minecraftVersion}`,
      data: {
        resourceRoot: this.resourceRoot(),
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
        onUpdate: (task) => this.emitProgress('downloading-game', `正在下载 Minecraft ${project.minecraftVersion}`, task.progress, task.total, generation),
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

      this.emit('installing-loader', `正在安装 ${project.loader} Loader`)
      if (project.loader === 'fabric') {
        const loaders = await getFabricLoaders({ signal, fetch: (url, init) => domesticMinecraftFetch(`${BMCLAPI}/fabric-meta${new URL(url).pathname}`, init) })
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
          fetch: (url, init) => domesticMinecraftFetch(`${BMCLAPI}/fabric-meta${new URL(url).pathname}`, init)
        })
      } else if (project.loader === 'quilt') {
        const loaders = await getQuiltLoaders({ signal, fetch: (url, init) => domesticMinecraftFetch(`${BMCLAPI}/quilt-meta${new URL(url).pathname}`, init) })
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
          fetch: (url, init) => domesticMinecraftFetch(`${BMCLAPI}/quilt-meta${new URL(url).pathname}`, init)
        })
      } else if (project.loader === 'forge') {
        if (!loaderVersion) {
          const forge = await getForgeVersionList({ minecraft: project.minecraftVersion })
          const selected = forge.versions.find((entry) => entry.type === 'recommended') ?? forge.versions.find((entry) => entry.type === 'latest') ?? forge.versions[0]
          if (!selected) throw new Error(`Forge 没有返回 Minecraft ${project.minecraftVersion} 的版本`)
          loaderVersion = `${project.minecraftVersion}-${selected.version}`
        }
        const forgeVersion = loaderVersion.startsWith(`${project.minecraftVersion}-`)
          ? loaderVersion.slice(project.minecraftVersion.length + 1)
          : loaderVersion
        loaderVersionId = await runMinecraftTaskWithRecovery({
          signal,
          stallTimeoutMs: 120_000,
          createTask: () => installForgeTask(
            { mcversion: project.minecraftVersion, version: forgeVersion },
            this.resourceRoot(),
            { java: javaPath, side: 'client', mavenHost: FORGE_MAVEN_HOSTS, dispatcher }
          ),
          onUpdate: (task) => this.emitProgress('installing-loader', `正在安装 Forge ${loaderVersion}`, task.progress, task.total, generation),
          onRetry: (attempt, error) => this.emit('installing-loader', `${error.message}，正在重试 Forge 安装（${attempt}/3）`, 'warning')
        })
      } else {
        if (!loaderVersion) throw new Error(`NeoForge ${project.minecraftVersion} 缺少加载器版本`)
        const artifact = project.minecraftVersion === '1.20.1' ? 'forge' : 'neoforge'
        loaderVersionId = await runMinecraftTaskWithRecovery({
          signal,
          stallTimeoutMs: 120_000,
          createTask: () => installNeoForgedTask(artifact, loaderVersion!, this.resourceRoot(), { java: javaPath, side: 'client', mavenHost: NEOFORGE_MAVEN_HOSTS, dispatcher }),
          onUpdate: (task) => this.emitProgress('installing-loader', `正在安装 NeoForge ${loaderVersion}`, task.progress, task.total, generation),
          onRetry: (attempt, error) => this.emit('installing-loader', `${error.message}，正在重试 NeoForge 安装（${attempt}/3）`, 'warning')
        })
      }
      const resolved = await Version.parse(this.resourceRoot(), loaderVersionId)
      if (signal?.aborted) throw abortError()
      await runMinecraftTaskWithRecovery({
        signal,
        createTask: (attempt) => installDependenciesTask(resolved, {
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
      message: `Minecraft 与 ${project.loader} 已准备完成`,
      mods: await this.listMods()
    })
    this.emit('idle', '测试实例准备完成')
    return this.getState()
  }

  private requireProject(): ProjectInfo {
    const project = this.getProject()
    if (project && (!this.stateProjectPath || (!this.state.running && !this.process && !this.preparePromise && !this.buildPromise && !this.verificationProcess))) {
      this.stateProjectPath = project.path
    }
    if (!project) throw new Error('请先创建或打开一个 Mod 项目')
    return project
  }

  /**
   * Metadata is written after the initial download, but individual library
   * files or extracted natives can still become truncated later. Validate the
   * cache before treating it as ready so launch can repair it through the
   * normal installer path instead of surfacing an opaque AggregateError.
   */
  private async verifyCachedRuntime(versionId: string): Promise<boolean> {
    try {
      const folder = MinecraftFolder.from(this.resourceRoot())
      const version = await Version.parse(folder, versionId)
      const precheckOptions = { gamePath: this.resourceRoot(), javaPath: '', version: version.id }
      await LaunchPrecheck.checkVersion(folder, version, precheckOptions)
      await LaunchPrecheck.checkLibraries(folder, version, precheckOptions)
      await LaunchPrecheck.checkNatives(folder, version, precheckOptions)
      const assetIndex = version.assetIndex
      if (!assetIndex?.sha1) return false
      const assetIndexPath = folder.getPath('assets', 'indexes', `${version.assets}.json`)
      if (await sha1File(assetIndexPath) !== assetIndex.sha1) return false
      return true
    } catch {
      return false
    }
  }

  private async removeInvalidCachedAssetIndex(versionId: string): Promise<void> {
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

  private resourceRoot(): string {
    return path.join(app.getPath('userData'), 'minecraft-runtime', 'game')
  }

  private runtimeRoot(): string {
    return path.join(app.getPath('userData'), 'minecraft-runtime', 'java')
  }

  private async preferredJavaHome(scenario: keyof JavaPreferences): Promise<string> {
    const preferences = await this.getJavaPreference?.().catch(() => undefined)
    const value = preferences?.[scenario]
    return typeof value === 'string' ? value.trim().replace(/^"|"$/g, '') : ''
  }

  /** Resolve the Java used for launching and loader installs: manual pick first, managed runtime as fallback. */
  private async ensureJava(project: ProjectInfo, signal?: AbortSignal, generation?: number): Promise<{ target: string; javaPath: string; source: 'managed' | 'custom' }> {    const minimumMajor = javaVersionForMinecraft(project.minecraftVersion)
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

  /**
   * Picks the Java for an upcoming launch without re-downloading anything:
   * honors a manual pick added after preparation, otherwise reuses whatever
   * the instance was prepared with.
   */
  private async resolveLaunchJava(project: ProjectInfo, metadata: RuntimeMetadata): Promise<string> {
    const preferredGameJava = await this.preferredJavaHome('game')
    if (!preferredGameJava) return metadata.javaPath
    const candidate = await probeJavaHome(preferredGameJava, javaVersionForMinecraft(project.minecraftVersion), false)
    if (candidate) return candidate.javaPath
    this.emit('launching', `手动选择的 Java 当前不可用，已改用实例配置的 Java：${metadata.javaPath}`, 'warning')
    return metadata.javaPath
  }

  private async ensureManagedJava(minimumMajor: number, requestedTarget?: string, signal?: AbortSignal, generation?: number): Promise<{ target: string; javaPath: string }> {
    const target = requestedTarget ?? javaRuntimeTargetForJavaVersion(minimumMajor)
    const javaHome = path.join(this.runtimeRoot(), target)
    const javaPath = managedJavaExecutable(this.runtimeRoot(), target)
    if (!(await probeJavaHome(javaHome, minimumMajor, false).catch(() => null))) {
      const stagingHome = `${javaHome}.staging-${randomUUID()}`
      this.emit('downloading-java', `正在下载托管 Java：${target}`)
      const manifest = await fetchCompatibleJavaRuntimeManifest(target)
      await fs.rm(stagingHome, { recursive: true, force: true })
      try {
        await runMinecraftTaskWithRecovery({
          signal,
          createTask: () => installJavaRuntimeTask({ destination: stagingHome, manifest }),
          onUpdate: (task) => this.emitProgress('downloading-java', '正在下载 Java Runtime', task.progress, task.total, generation),
          onRetry: (attempt, error) => this.emit('downloading-java', `${error.message}，正在重新下载 Java Runtime（${attempt}/3）`, 'warning')
        })
        if (signal?.aborted) throw abortError()
        if (!(await probeJavaHome(stagingHome, minimumMajor, false).catch(() => null))) {
          throw new Error(`下载的托管 Java 验证失败：${managedJavaExecutable(path.dirname(stagingHome), path.basename(stagingHome))}`)
        }
        await fs.rm(javaHome, { recursive: true, force: true })
        await fs.rename(stagingHome, javaHome)
      } finally {
        await fs.rm(stagingHome, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    if (!(await probeJavaHome(javaHome, minimumMajor, false).catch(() => null))) {
      throw new Error(`托管 Java 安装后仍无法运行：${javaPath}。缓存可能损坏、架构不匹配或被安全软件拦截`)
    }
    return { target, javaPath }
  }

  private async ensureManagedLoaderApi(project: ProjectInfo): Promise<void> {
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

    const encodedVersion = encodeURIComponent(version)
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
        const checksumResponse = await fetch(`${source}.sha1`, { signal: AbortSignal.timeout(30_000) })
        if (!checksumResponse.ok) throw new Error(`SHA-1 HTTP ${checksumResponse.status}`)
        expected = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        if (!expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error(`${label} SHA-1 格式无效`)
        break
      } catch (error) {
        checksumError = error
      }
    }
    if (!expected) throw new Error(`${label} 校验信息下载失败：${checksumError instanceof Error ? checksumError.message : String(checksumError)}`)
    await verifiedDownload.download({
      sources: sources.map((url, index) => ({ id: `${project.loader}-api-${index + 1}`, label: `${label} 下载源 ${index + 1}`, url })),
      destination: target,
      expectedHash: { algorithm: 'sha1', value: expected },
      maxBytes: 256 * 1024 * 1024,
      retriesPerSource: 2
    })
    await fs.writeFile(marker, version, 'utf8')
    this.emit('installing-fabric', `${label} ${version} 已就绪`)
  }

  private instanceRoot(project: ProjectInfo): string {
    return path.join(project.path, projectDataDirectory(project), 'minecraft')
  }

  private modsRoot(project: ProjectInfo): string {
    return path.join(this.instanceRoot(project), 'mods')
  }

  private metadataPath(project: ProjectInfo): string {
    return path.join(this.instanceRoot(project), 'runtime.json')
  }

  private async handleMinecraftExit(
    project: ProjectInfo,
    launchedAt: number,
    code: number | null,
    signal: NodeJS.Signals | null,
    intentionallyStopped: boolean
  ): Promise<void> {
    const abnormalExitCode = code !== 0 && code !== null
    const parsedCrash = abnormalExitCode ? await this.readLatestCrash(project, launchedAt) : undefined
    const normalShutdown = abnormalExitCode && !parsedCrash && await this.readNormalShutdownEvidence(project, launchedAt)
    const crashed = abnormalExitCode && !intentionallyStopped && !normalShutdown
    if (!crashed) {
      const message = `Minecraft 已退出${signal ? ` (${signal})` : ''}`
      await fs.writeFile(path.join(this.instanceRoot(project), 'last-clean-exit'), new Date().toISOString(), 'utf8').catch(() => undefined)
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

  private async readNormalShutdownEvidence(project: ProjectInfo, launchedAt: number): Promise<boolean> {
    const candidates = [
      path.join(this.instanceRoot(project), 'launcher-console.log'),
      path.join(this.instanceRoot(project), 'logs', 'latest.log')
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

  private async readLatestCrash(project: ProjectInfo, launchedAt: number): Promise<MinecraftCrashInfo | undefined> {
    try {
      const instanceRoot = this.instanceRoot(project)
      const crashDirectory = path.join(instanceRoot, 'crash-reports')
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
        const cleanExitTime = await fs.stat(path.join(instanceRoot, 'last-clean-exit')).then((stat) => stat.mtimeMs).catch(() => 0)
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

  private async readMetadata(project: ProjectInfo): Promise<RuntimeMetadata | null> {
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

  private updateState(changes: Partial<MinecraftRuntimeState>): void {
    this.state = { ...this.state, ...changes }
    this.onState(this.getState())
  }

  private emit(
    stage: MinecraftRuntimeStage,
    message: string,
    level: MinecraftRuntimeEvent['level'] = 'info',
    updateState = true
  ): void {
    if (!message) return
    const event: MinecraftRuntimeEvent = { stage, message, level, time: new Date().toISOString(), ...(this.stateProjectPath ? {projectPath: this.stateProjectPath} : {}) }
    this.onEvent(event)
    if (updateState) this.updateState({ stage, message })
  }

  private emitProgress(stage: MinecraftRuntimeStage, message: string, progress: number, total: number, generation?: number): void {
    if (generation !== undefined && generation !== this.prepareGeneration) return
    const now = Date.now()
    const finished = total > 0 && progress >= total
    if (this.lastProgressStage === stage && now - this.lastProgressAt < 150 && !finished) return
    this.lastProgressAt = now
    this.lastProgressStage = stage
    this.onEvent({ stage, message, progress, total, time: new Date().toISOString(), level: 'info' })
    this.updateState({ stage, message })
  }
}
