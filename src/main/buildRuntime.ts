import { app } from 'electron'
import type { ChildProcess,ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream,promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
MinecraftManagedMod,
MinecraftRuntimeEvent,
MinecraftRuntimeStage,
MinecraftRuntimeState
} from '../shared/minecraft'
import { isJavaLoader,isServerPluginPlatform,platformLabel } from '../shared/projectPlatform'
import type { DetectedJavaHome,JavaPreferences,LoaderKind,ProjectInfo } from '../shared/types'
import { buildBedrockAddon,buildNeteaseArchive } from './bedrockAddon'
import { downloadActivities } from './downloadActivityService'
import { verifiedDownload } from './downloadService'
import { ensureGradleMavenFallback,gradleDistributionSources,type GradleDownloadSourcePreference } from './gradleDownload'
import { isForgeJavaProvisioningFailure,isGradleNetworkFailure } from './gradleFailure'
import { describeProcessTermination,MANAGED_GRADLE_BUILD_ARGUMENTS,normalizeProcessExitCode } from './gradleProcess'
import { javaProxyOptions } from './javaEnvironment'
import { ensureManagedJdk,type ManagedJdkProgress } from './jdkDownload'
import { buildJavaRangeForProject,gradleVersionForProject,javaRuntimeTargetForJavaVersion,javaRuntimeTargetForMinecraft,javaVersionForMinecraft } from './loaderCompatibility'
import { buildMavenPlugin } from './mavenBuild'
import { validateRuntimeModArtifact } from './modpackArtifactValidation'
import { collectBuiltModpackModuleArtifacts,createModrinthPackArchive,readModpackManifest,readModpackModuleProject } from './modpackService'
import { getNetworkProxyUrl } from './networkRequest'
import { spawnManaged,stopProcessTree } from './processTree'
import { findPluginArtifact } from './serverPluginService'
import { detectToolchainRequirements,mergeToolchainJavaHomes } from './toolchainDetection'
import { windowsCmdInvocation } from './windowsCommand'
export interface MinecraftRuntimeOptions {
  vanillaClient?: boolean
  instanceDirectory?: string
  /** Reserved local endpoint for an owned MCP test client, never supplied by renderer input. */
  minecraftMcpPort?: number
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

export interface GradleRuntimeSelection {
  executable: string
  javaHome: string
  usesWrapper: true
  source: 'wrapper'
}

export function projectGradleWrapperExecutable(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(projectRoot, platform === 'win32' ? 'gradlew.bat' : 'gradlew')
}

export function projectDataDirectory(_project: ProjectInfo): '.modmind' {
  return '.modmind'
}

export function projectArtifactName(_project: ProjectInfo): string {
  return 'modmind-current-project.jar'
}

export function summarizeGradleFailure(logText: string): string {
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

export async function validateModArtifact(filePath: string, loader: LoaderKind, displayPath = filePath, importedPack = false): Promise<void> {
  await validateRuntimeModArtifact(filePath, loader, displayPath, importedPack)
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export interface JavaProbeResult {
  javaPath: string
  major: number
}

export async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

export async function probeJavaHome(home: string, minimumMajor: number, requireJavac: boolean, maximumMajor = Number.POSITIVE_INFINITY): Promise<JavaProbeResult | null> {
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

export async function configuredBuildJavaHomes(project: ProjectInfo): Promise<string[]> {
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

export async function discoverJavaHomesFromPath(): Promise<string[]> {
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

export async function probeJavaHomeInfo(home: string): Promise<{ valid: boolean; major: number }> {
  const candidate = await probeJavaHome(home, 1, false)
  return candidate ? { valid: true, major: candidate.major } : { valid: false, major: 0 }
}

export async function listSubdirectoryPaths(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

export async function commonRootJavaHomeCandidates(): Promise<string[]> {
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

export async function findFile(root: string, predicate: (name: string, fullPath: string) => boolean): Promise<string | null> {
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

export async function findFiles(
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

export class BuildRuntimeManager {
protected readonly vanillaClient: boolean

protected readonly instanceDirectory?: string

protected readonly minecraftMcpPort?: number

protected readonly getProject: () => ProjectInfo | null

protected readonly onState: (state: MinecraftRuntimeState) => void

protected readonly onEvent: (event: MinecraftRuntimeEvent) => void

protected readonly authorizeBuild?: (project: ProjectInfo) => Promise<void>

protected readonly getGradleDownloadSource?: () => Promise<GradleDownloadSourcePreference>

protected readonly getJavaPreference?: () => Promise<Partial<JavaPreferences> | undefined>

protected readonly prepareProjectDependencies?: (project: ProjectInfo, signal?: AbortSignal) => Promise<void>

protected process: ChildProcess | null = null

protected preparePromise: Promise<MinecraftRuntimeState> | null = null

protected prepareController: AbortController | null = null

protected prepareGeneration = 0

protected buildPromise: Promise<MinecraftManagedMod> | null = null

protected buildController: AbortController | null = null

protected buildProcess: ChildProcess | null = null

protected verificationProcess: ChildProcess | null = null

protected readonly gradleCleanupPromises = new Map<string, Promise<void>>()

protected readonly buildToolchainHomes = new Map<number, string>()

protected stopRequested = false

protected lastProgressAt = 0

protected lastProgressStage: MinecraftRuntimeStage | '' = ''

protected stateProjectPath = ''

protected state: MinecraftRuntimeState = {
    stage: 'idle',
    minecraftVersion: '',
    installed: false,
    running: false,
    message: '等待准备测试实例',
    mods: []
  }

constructor(options: MinecraftRuntimeOptions) {
    this.vanillaClient = options.vanillaClient === true
    this.instanceDirectory = options.instanceDirectory
    this.minecraftMcpPort = options.minecraftMcpPort
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
    const javaPath = await this.ensureJavaRuntime()
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
        path.join(project.path, '.modmind', 'minecraft', 'mods'),
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

protected killProcessTree(child: ChildProcess): void {
    void stopProcessTree(child)
  }

protected spawnGradle(
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

protected gradleEnvironment(runtime: GradleRuntimeSelection): NodeJS.ProcessEnv {
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

protected async stopStaleGradleDaemons(runtime: GradleRuntimeSelection, project: ProjectInfo, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
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

protected async gradleRuntime(project: ProjectInfo): Promise<GradleRuntimeSelection> {
    const javaPath = await this.ensureBuildJava(project)
    const wrapperPath = projectGradleWrapperExecutable(project.path)
    if (!(await exists(wrapperPath))) {
      throw new Error(`项目缺少 Gradle Wrapper：${path.basename(wrapperPath)}。请先在项目根目录提供可用的 Wrapper`)
    }
    if (process.platform !== 'win32') await fs.chmod(wrapperPath, 0o755)
    return { executable: wrapperPath, javaHome: path.dirname(path.dirname(javaPath)), usesWrapper: true, source: 'wrapper' }
  }

protected async ensureBuildJava(project: ProjectInfo): Promise<string> {
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

protected async ensureDetectedBuildToolchains(logText: string, project?: ProjectInfo): Promise<boolean> {
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

protected async buildProjectInternal(signal?: AbortSignal, retryAttempt = 0): Promise<MinecraftManagedMod> {
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
    const artifact = await this.finishBuildArtifact()
    if (!artifact) throw new Error('Gradle 构建成功，但 build/libs 中没有找到可运行的 Mod JAR')
    this.emit('syncing-mod', '项目构建完成')
    return artifact
  }

protected async buildModpackInternal(project: ProjectInfo, signal?: AbortSignal): Promise<MinecraftManagedMod> {
    if (!isJavaLoader(project.loader)) throw new Error('整合包必须使用 Java Edition Loader')
    const manifest = await readModpackManifest(project)
    for (const module of manifest.modules) {
      const moduleProject = await readModpackModuleProject(project, module)
      const moduleRoot = moduleProject.path
      if (!(await exists(path.join(moduleRoot, 'build.gradle'))) && !(await exists(path.join(moduleRoot, 'build.gradle.kts')))) {
        throw new Error(`自制 Mod ${module.name} 缺少 Gradle 构建文件`)
      }
      await this.authorizeBuild?.(moduleProject)
      this.emit('building-mod', `正在构建自制 Mod：${module.name}`)
      await this.runGradleBuild(moduleProject, signal)
    }
    const mods = await this.finishModpackBuild(project)
    const archive = await createModrinthPackArchive(project)
    const artifactPath = path.join(project.path, projectDataDirectory(project), 'builds', `${project.namespace}.mrpack`)
    await fs.mkdir(path.dirname(artifactPath), { recursive: true })
    await fs.writeFile(artifactPath, archive)
    const artifact: MinecraftManagedMod = {
      name: path.basename(artifactPath),
      path: artifactPath,
      size: archive.length,
      modifiedAt: new Date().toISOString(),
      projectArtifact: true
    }
    this.updateState({ stage: 'idle', message: `整合包构建完成：${mods.length} 个 Mod`, mods })
    return artifact
  }

protected async prepareGradleWrapperDownload(project: ProjectInfo, attempt: number, signal?: AbortSignal): Promise<void> {
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

protected async prepareGradleMavenFallback(project: ProjectInfo): Promise<void> {
    if (project.loader !== 'fabric' && project.loader !== 'quilt') return
    for (const name of ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']) {
      const target = path.join(project.path, name)
      const source = await fs.readFile(target, 'utf8').catch(() => null)
      if (source === null) continue
      const next = ensureGradleMavenFallback(source, name.endsWith('.kts'))
      if (next !== source) await fs.writeFile(target, next, 'utf8')
    }
  }

protected async runGradleBuild(project: ProjectInfo, signal?: AbortSignal, retryAttempt = 0): Promise<void> {
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

protected requireProject(): ProjectInfo {
    const project = this.getProject()
    if (project && (!this.stateProjectPath || (!this.state.running && !this.process && !this.preparePromise && !this.buildPromise && !this.verificationProcess))) {
      this.stateProjectPath = project.path
    }
    if (!project) throw new Error('请先创建或打开一个 Mod 项目')
    return project
  }

protected runtimeRoot(): string {
    return path.join(app.getPath('userData'), 'minecraft-runtime', 'java')
  }

protected async preferredJavaHome(scenario: keyof JavaPreferences): Promise<string> {
    const preferences = await this.getJavaPreference?.().catch(() => undefined)
    const value = preferences?.[scenario]
    return typeof value === 'string' ? value.trim().replace(/^"|"$/g, '') : ''
  }

protected updateState(changes: Partial<MinecraftRuntimeState>): void {
    this.state = { ...this.state, ...changes }
    this.onState(this.getState())
  }

protected emit(
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

protected emitProgress(stage: MinecraftRuntimeStage, message: string, progress: number, total: number, generation?: number): void {
    if (generation !== undefined && generation !== this.prepareGeneration) return
    const now = Date.now()
    const finished = total > 0 && progress >= total
    if (this.lastProgressStage === stage && now - this.lastProgressAt < 150 && !finished) return
    this.lastProgressAt = now
    this.lastProgressStage = stage
    this.onEvent({ stage, message, progress, total, time: new Date().toISOString(), level: 'info' })
    this.updateState({ stage, message })
  }

  protected async finishBuildArtifact(): Promise<MinecraftManagedMod | null> {
    const project = this.requireProject()
    const directory = path.join(project.path, 'build', 'libs')
    const candidates = await Promise.all((await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && entry.name.endsWith('.jar') && !/(sources|javadoc|dev|shadow)/i.test(entry.name))
      .map(async entry => { const file = path.join(directory, entry.name); return { file, stat: await fs.stat(file) } }))
    const latest = candidates.sort((a,b) => b.stat.mtimeMs-a.stat.mtimeMs)[0]
    if (!latest) return null
    await validateModArtifact(latest.file, project.loader)
    return {name:path.basename(latest.file),path:latest.file,size:latest.stat.size,modifiedAt:latest.stat.mtime.toISOString(),projectArtifact:true}
  }
  protected async finishModpackBuild(project: ProjectInfo): Promise<MinecraftManagedMod[]> {
    const artifacts = await collectBuiltModpackModuleArtifacts(project)
    return Promise.all(artifacts.map(async artifact => { const stat = await fs.stat(artifact.path); return {name:path.basename(artifact.path),path:artifact.path,size:stat.size,modifiedAt:stat.mtime.toISOString(),projectArtifact:true} }))
  }
  async refresh(): Promise<MinecraftRuntimeState> {
    const project = this.requireProject()
    this.updateState({ minecraftVersion: project.minecraftVersion, ...(!this.buildPromise && !this.verificationProcess ? { stage: 'idle' as const, message: '构建环境已就绪' } : {}) })
    return this.getState()
  }
  async cancelPreparation(): Promise<MinecraftRuntimeState> { return this.getState() }
  async stop(): Promise<MinecraftRuntimeState> {
    this.buildController?.abort()
    await Promise.all([this.buildProcess, this.verificationProcess].filter((child): child is ChildProcess => Boolean(child)).map(stopProcessTree))
    await this.buildPromise?.catch(() => undefined)
    return this.getState()
  }
  destroy(): void { this.buildController?.abort(); if(this.buildProcess) void stopProcessTree(this.buildProcess); if(this.verificationProcess) void stopProcessTree(this.verificationProcess) }

}
