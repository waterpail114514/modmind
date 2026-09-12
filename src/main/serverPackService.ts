import { spawnManaged, stopProcessTree } from './processTree'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { JavaLoaderKind, LoaderKind, ProjectInfo, ServerPackManifest } from '../shared/types'
import { managedJavaEnvironment } from './javaEnvironment'
import { fetchJsonWithRetry } from './networkRequest'
import { commitDirectory, preserveLegacyServerInstance } from './serverInstance'
import { collectBuiltModpackModuleArtifacts, readModpackManifest, syncModpackOverrides } from './modpackService'
import { modpackModsRoot } from './modpackPaths'
import { auditModpackLock, readModpackLock } from './modpackLockService'
import { verifiedDownload, type DownloadSource } from './downloadService'
import { buildWithServerPackCreator } from './serverPackCreatorService'
import { windowsCmdInvocation } from './windowsCommand'
import { createStoredZip } from './bedrockAddon'
import { isSafeModJarFileName, safeModJarFileName } from './modpackFilename'

export interface ServerPackOptions {
  outputDirectory: string
  port?: number
  acceptEula: boolean
  includeUnknownSideMods?: boolean
  onlineMode?: boolean
  preserveExistingFiles?: boolean
  engine?: 'internal' | 'serverpackcreator'
  javaPath?: string
  cacheDirectory?: string
  onProgress?: (message: string) => void
  onOutput?: (output: string) => void
}

export interface ServerPackResult {
  root: string
  copiedMods: string[]
  skippedClientMods: string[]
  directMods?: string[]
  warnings: string[]
  manifestPath: string
  engine?: 'internal' | 'serverpackcreator'
  engineVersion?: string
  logPath?: string
}

export interface ServerRuntimeInstallOptions {
  serverPack: ServerPackResult
  javaPath: string
  signal?: AbortSignal
  onDownloadProgress?: (progress: { source: DownloadSource; downloaded: number; total?: number }) => void
}

export interface ServerRuntimeResult {
  serverJar?: string
  launchCommand: string[]
  windowsVerbatimArguments?: boolean
  loader: LoaderKind
  loaderVersion: string
}

interface ServerRuntimeMarker {
  minecraftVersion: string
  loader: JavaLoaderKind
  loaderVersion: string
}

function safePort(value: number | undefined): number {
  const port = Number.isInteger(value) ? value! : 25565
  if (port < 1024 || port > 65535) throw new Error('server port must be between 1024 and 65535')
  return port
}

function safeRoot(root: string): string { return path.resolve(root) }

function projectDataDirectory(_project: ProjectInfo): '.modmind' {
  return '.modmind'
}

function defaultServerPackDirectory(project: ProjectInfo): string {
  return path.join(project.path, projectDataDirectory(project), 'server-pack')
}

function resolvedServerPackDirectory(project: ProjectInfo, outputDirectory = defaultServerPackDirectory(project)): string {
  const projectRoot = safeRoot(project.path)
  const output = safeRoot(outputDirectory)
  if (!output.startsWith(`${projectRoot}${path.sep}`)) throw new Error('server pack output must stay inside the active project directory')
  return output
}

/** Reads the materialized server pack only; client manifest data is never used as a fallback. */
export async function readServerPackManifest(project: ProjectInfo, outputDirectory = defaultServerPackDirectory(project)): Promise<ServerPackManifest | null> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required to read a server pack manifest')
  const projectRoot = safeRoot(project.path)
  const output = safeRoot(outputDirectory)
  if (!output.startsWith(`${projectRoot}${path.sep}`)) throw new Error('server pack output must stay inside the active project directory')
  const manifestPath = path.join(output, 'modmind.server.json')
  const raw = await fs.readFile(manifestPath, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return null
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !Array.isArray((value as { mods?: unknown }).mods)) throw new Error(`invalid server pack manifest: ${manifestPath}`)
  const manifest = value as ServerPackManifest
  if (!manifest.mods.every((mod) => typeof mod === 'string')) throw new Error(`invalid server pack mod list: ${manifestPath}`)
  if (manifest.directMods !== undefined && (!Array.isArray(manifest.directMods) || !manifest.directMods.every((mod) => typeof mod === 'string'))) throw new Error(`invalid direct mod list: ${manifestPath}`)
  return manifest
}

/** Returns only a previously synchronized server pack; it never materializes one from client files. */
export async function readExistingServerPack(project: ProjectInfo, outputDirectory = defaultServerPackDirectory(project)): Promise<ServerPackResult | null> {
  const manifest = await readServerPackManifest(project, outputDirectory)
  if (!manifest) return null
  const root = safeRoot(outputDirectory)
  const engine = manifest.engine === 'internal' || manifest.engine === 'serverpackcreator' ? manifest.engine : undefined
  return {
    root,
    copiedMods: [...manifest.mods],
    skippedClientMods: [...manifest.skippedClientMods],
    directMods: [...(manifest.directMods ?? [])],
    warnings: [],
    manifestPath: path.join(root, 'modmind.server.json'),
    engine,
    engineVersion: manifest.engineVersion,
    logPath: manifest.engineLog
  }
}

async function currentServerPackModNames(root: string): Promise<string[]> {
  const directory = path.join(root, 'mods')
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
  return entries
    .filter((entry) => entry.isFile() && isSafeModJarFileName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
}

async function writeCurrentServerPackManifest(project: ProjectInfo, root: string, previous: ServerPackManifest): Promise<ServerPackManifest> {
  const mods = await currentServerPackModNames(root)
  const next: ServerPackManifest = {
    ...previous,
    mods,
    eulaAccepted: true,
    generatedAt: new Date().toISOString()
  }
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n', 'utf8')
  await fs.writeFile(path.join(root, 'modmind.server.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

async function requireEditableServerPack(project: ProjectInfo, outputDirectory?: string): Promise<{ root: string; manifest: ServerPackManifest }> {
  const root = resolvedServerPackDirectory(project, outputDirectory)
  const manifest = await readServerPackManifest(project, root)
  if (!manifest) throw new Error('请先同步服务端包')
  return { root, manifest }
}

/** Adds selected JARs to an already synchronized server pack and refreshes its manifest. */
export async function addServerPackMods(project: ProjectInfo, sourcePaths: string[], outputDirectory?: string): Promise<ServerPackManifest> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required to edit a server pack')
  const { root, manifest } = await requireEditableServerPack(project, outputDirectory)
  if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.length > 100) throw new Error('select between 1 and 100 mod JAR files')
  const sources = await Promise.all(sourcePaths.map(async (sourcePath) => {
    const source = path.resolve(sourcePath)
    const fileName = safeModJarFileName(path.basename(source))
    const stat = await fs.stat(source).catch(() => null)
    if (!stat?.isFile() || stat.size < 1) throw new Error(`invalid mod JAR: ${fileName}`)
    return { source, fileName }
  }))
  const selectedNames = new Set<string>()
  for (const source of sources) {
    const key = source.fileName.toLowerCase()
    if (selectedNames.has(key)) throw new Error(`duplicate selected mod JAR: ${source.fileName}`)
    selectedNames.add(key)
  }
  const modsDirectory = path.join(root, 'mods')
  await fs.mkdir(modsDirectory, { recursive: true })
  for (const source of sources) {
    const target = path.join(modsDirectory, source.fileName)
    if (await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) throw new Error(`server pack already contains ${source.fileName}`)
  }
  await Promise.all(sources.map((source) => fs.copyFile(source.source, path.join(modsDirectory, source.fileName))))
  return writeCurrentServerPackManifest(project, root, manifest)
}

/** Removes one JAR from an already synchronized server pack and refreshes its manifest. */
export async function removeServerPackMod(project: ProjectInfo, fileName: string, outputDirectory?: string): Promise<ServerPackManifest> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required to edit a server pack')
  const { root, manifest } = await requireEditableServerPack(project, outputDirectory)
  const safeName = safeModJarFileName(fileName)
  const target = path.join(root, 'mods', safeName)
  const stat = await fs.stat(target).catch(() => null)
  if (!stat?.isFile()) throw new Error(`server pack mod does not exist: ${safeName}`)
  await fs.rm(target, { force: true })
  return writeCurrentServerPackManifest(project, root, manifest)
}

const SERVER_PACK_EXPORT_IGNORED_DIRECTORIES = new Set(['logs', 'crash-reports', 'debug', 'world', 'world_nether', 'world_the_end'])
const SERVER_PACK_EXPORT_IGNORED_FILES = new Set(['.modmind-server-runtime.json'])

async function collectServerPackExportEntries(root: string, relative = ''): Promise<Array<{ name: string; data: Buffer }>> {
  const directory = path.join(root, ...relative.split('/').filter(Boolean))
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const collected: Array<{ name: string; data: Buffer }> = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    const childPath = path.join(root, ...childRelative.split('/'))
    if (entry.isDirectory()) {
      if (!relative && SERVER_PACK_EXPORT_IGNORED_DIRECTORIES.has(entry.name)) continue
      collected.push(...await collectServerPackExportEntries(root, childRelative))
      continue
    }
    if (!entry.isFile() || (!relative && SERVER_PACK_EXPORT_IGNORED_FILES.has(entry.name))) continue
    collected.push({ name: childRelative, data: await fs.readFile(childPath) })
  }
  return collected
}

/** Creates a deployment ZIP from the synchronized server pack without local logs or world data. */
export async function createServerPackArchive(project: ProjectInfo, outputDirectory?: string): Promise<Buffer> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required to export a server pack')
  const { root } = await requireEditableServerPack(project, outputDirectory)
  const entries = await collectServerPackExportEntries(root)
  if (!entries.length) throw new Error('server pack contains no exportable files')
  return createStoredZip(entries)
}

function normalizedLoaderVersion(loader: JavaLoaderKind, minecraftVersion: string, value: string): string {
  const trimmed = value.trim()
  if (loader === 'forge' && trimmed.startsWith(`${minecraftVersion}-`)) return trimmed.slice(minecraftVersion.length + 1)
  return trimmed
}

async function copyFileChecked(source: string, target: string): Promise<{ size: number; sha256: string }> {
  const bytes = await fs.readFile(source)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, bytes, { mode: 0o600 })
  return { size: bytes.length, sha256 }
}

async function runJava(javaPath: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const child = spawnManaged(javaPath, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: managedJavaEnvironment() })
  let output = ''
  const append = (chunk: Buffer): void => { output = `${output}${chunk.toString('utf8')}`.slice(-80_000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const abort = (): void => { if (child.pid) void stopProcessTree(child) }
  signal?.addEventListener('abort', abort, { once: true })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  }).finally(() => signal?.removeEventListener('abort', abort))
  if (signal?.aborted) throw Object.assign(new Error('server runtime installation cancelled'), { name: 'AbortError' })
  if (exitCode !== 0) throw new Error(`server installer exited with ${exitCode}: ${output.slice(-8_000)}`)
}

function loaderSources(loader: JavaLoaderKind, minecraftVersion: string, loaderVersion: string): { sources: DownloadSource[]; direct: boolean } {
  loaderVersion = normalizedLoaderVersion(loader, minecraftVersion, loaderVersion)
  if (loader === 'fabric') {
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(loaderVersion)}/1.0.1/server/jar`
    return { direct: true, sources: [{ id: 'fabric-meta', label: 'Fabric Meta', url }] }
  }
  if (loader === 'quilt') {
    return { direct: false, sources: [{ id: 'quilt-meta', label: 'Quilt Installer 元数据', url: 'https://meta.quiltmc.org/v3/versions/installer' }] }
  }
  const file = loader === 'forge' ? `forge-${minecraftVersion}-${loaderVersion}-installer.jar` : `neoforge-${loaderVersion}-installer.jar`
  const primary = loader === 'forge' ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${minecraftVersion}-${loaderVersion}/${file}` : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/${file}`
  const mirror = loader === 'forge' ? `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${minecraftVersion}-${loaderVersion}/${file}` : `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${loaderVersion}/${file}`
  return { direct: false, sources: [{ id: 'official', label: `${loader} 官方 Maven`, url: primary }, { id: 'bmclapi', label: 'BMCLAPI 镜像', url: mirror }] }
}

async function detectInstalledServerRuntime(root: string, project: ProjectInfo, javaPath: string, requireMarker = true): Promise<ServerRuntimeResult | null> {
  const expectedLoaderVersion = normalizedLoaderVersion(project.loader as JavaLoaderKind, project.minecraftVersion, project.loaderVersion ?? '')
  const markerPath = path.join(root, '.modmind-server-runtime.json')
  const marker = await fs.readFile(markerPath, 'utf8').then((content) => JSON.parse(content) as Partial<ServerRuntimeMarker>).catch(() => null)
  const markerMatches = Boolean(marker
    && marker.minecraftVersion === project.minecraftVersion
    && marker.loader === project.loader
    && marker.loaderVersion === expectedLoaderVersion)
  if (requireMarker && !markerMatches) return null
  const jarCandidates = project.loader === 'quilt' ? ['quilt-server-launch.jar'] : ['server.jar', `${project.loader}-server.jar`, 'forge-server.jar', 'neoforge-server.jar']
  const serverJar = (await Promise.all(jarCandidates.map(async (name) => {
    const file = path.join(root, name)
    return await fs.stat(file).then((stat) => stat.isFile()).catch(() => false) ? file : null
  }))).find((value): value is string => Boolean(value))
  if (serverJar) {
    await fs.writeFile(path.join(root, 'start-server.cmd'), `@echo off\n"${javaPath.replaceAll('"', '')}" -Xms2G -Xmx4G -jar "${path.basename(serverJar)}" nogui\n`, 'utf8')
    await fs.writeFile(path.join(root, 'start-server.sh'), `#!/bin/sh\nexec "${javaPath.replaceAll('"', '')}" -Xms2G -Xmx4G -jar "$(dirname "$0")/${path.basename(serverJar)}" nogui\n`, 'utf8')
    return { serverJar, launchCommand: [javaPath, '-Xms2G', '-Xmx4G', '-jar', serverJar, 'nogui'], loader: project.loader as JavaLoaderKind, loaderVersion: expectedLoaderVersion }
  }
  const generatedWindows = path.join(root, 'run.bat')
  const generatedUnix = path.join(root, 'run.sh')
  if (!(await fs.stat(generatedWindows).then((stat) => stat.isFile()).catch(() => false)) && !(await fs.stat(generatedUnix).then((stat) => stat.isFile()).catch(() => false))) return null
  const script = process.platform === 'win32' ? generatedWindows : generatedUnix
  if (process.platform === 'win32') {
    const invocation = windowsCmdInvocation(script, ['nogui'])
    return { launchCommand: [invocation.command, ...invocation.args], windowsVerbatimArguments: invocation.windowsVerbatimArguments, loader: project.loader as JavaLoaderKind, loaderVersion: expectedLoaderVersion }
  }
  return { launchCommand: ['sh', script, 'nogui'], loader: project.loader as JavaLoaderKind, loaderVersion: expectedLoaderVersion }
}

export function serverRuntimeDownloadDescription(project: Pick<ProjectInfo, 'loader' | 'minecraftVersion' | 'loaderVersion'>): { label: string; sources: string[] } {
  const loaderVersion = normalizedLoaderVersion(project.loader as JavaLoaderKind, project.minecraftVersion, project.loaderVersion ?? '')
  if (!loaderVersion) return { label: `${project.loader} / Minecraft ${project.minecraftVersion} (missing loader version)`, sources: [] }
  const selected = loaderSources(project.loader as JavaLoaderKind, project.minecraftVersion, loaderVersion)
  return { label: `${project.loader} loader ${loaderVersion} / Minecraft ${project.minecraftVersion}`, sources: selected.sources.map((source) => source.url) }
}

export async function buildServerPack(project: ProjectInfo, options: ServerPackOptions): Promise<ServerPackResult> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required to build a server pack')
  await preserveLegacyServerInstance(project.path, options.outputDirectory)
  if (options.engine === 'serverpackcreator') {
    const manifest = await readModpackManifest(project)
    if (!manifest.mods.length) {
      return buildServerPack(project, { ...options, engine: 'internal' })
    }
    if (!options.javaPath || !options.cacheDirectory) throw new Error('ServerPackCreator requires Java and an application cache directory')
    return buildWithServerPackCreator({
      project,
      outputDirectory: options.outputDirectory,
      javaPath: options.javaPath,
      cacheDirectory: options.cacheDirectory,
      port: options.port,
      onlineMode: options.onlineMode,
      acceptEula: options.acceptEula,
      includeUnknownSideMods: options.includeUnknownSideMods,
      onProgress: options.onProgress,
      onOutput: options.onOutput
    })
  }
  const output = safeRoot(options.outputDirectory)
  const projectRoot = safeRoot(project.path)
  if (!output.startsWith(`${projectRoot}${path.sep}`)) throw new Error('server pack output must stay inside the active project directory')
  const staging = `${output}.staging-${process.pid}-${Date.now()}`
  const port = safePort(options.port)
  const manifest = await readModpackManifest(project)
  const localModules = await collectBuiltModpackModuleArtifacts(project)
  const lock = await readModpackLock(project)
  const audit = await auditModpackLock(project)
  if (!audit.success && lock.mods.length) throw new Error(`modpack lock audit failed: ${audit.errors.join('; ')}`)
  const byName = new Map(lock.mods.map((mod) => [mod.fileName.toLowerCase(), mod]))
  const copiedMods: string[] = []
  const directMods: string[] = []
  const skippedClientMods: string[] = []
  const warnings: string[] = []
  const copiedNames = new Set<string>()
  if (manifest.mods.length && !lock.mods.length) warnings.push('no provider lock records exist; server/client side metadata is unknown and all manifest mods are treated as server-compatible')
  try {
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(path.join(staging, 'mods'), { recursive: true })
    for (const mod of manifest.mods) {
      const locked = byName.get(mod.fileName.toLowerCase())
      if (locked?.side === 'client') { skippedClientMods.push(mod.fileName); continue }
      if (locked?.side === 'unknown' && options.includeUnknownSideMods === false) { skippedClientMods.push(mod.fileName); warnings.push(`side unknown, skipped ${mod.fileName}`); continue }
      const source = path.join(modpackModsRoot(project, manifest), mod.fileName)
      if (!(await fs.stat(source).then((stat) => stat.isFile()).catch(() => false))) throw new Error(`missing mod ${mod.fileName}`)
      if (copiedNames.has(mod.fileName.toLowerCase())) throw new Error(`duplicate server mod filename: ${mod.fileName}`)
      await copyFileChecked(source, path.join(staging, 'mods', mod.fileName))
      copiedNames.add(mod.fileName.toLowerCase())
      copiedMods.push(mod.fileName)
    }
    for (const module of localModules) {
      if (module.module.side === 'client') {
        skippedClientMods.push(module.fileName)
        continue
      }
      if (copiedNames.has(module.fileName.toLowerCase())) throw new Error(`duplicate server mod filename: ${module.fileName}`)
      await copyFileChecked(module.path, path.join(staging, 'mods', module.fileName))
      copiedNames.add(module.fileName.toLowerCase())
      copiedMods.push(module.fileName)
      directMods.push(module.fileName)
    }
    const overrides = await syncModpackOverrides(project, staging)
    const properties = ['server-ip=127.0.0.1', `server-port=${port}`, `online-mode=${options.onlineMode !== false}`, 'enable-command-block=true', ' motd=ModMind Server'.replace(/^ /, '')].join('\n') + '\n'
    await fs.writeFile(path.join(staging, 'server.properties'), properties, 'utf8')
    await fs.writeFile(path.join(staging, 'eula.txt'), `eula=${options.acceptEula ? 'true' : 'false'}\n`, 'utf8')
    const packManifest = { version: 1, name: manifest.name, minecraftVersion: manifest.minecraftVersion, loader: manifest.loader, loaderVersion: project.loaderVersion ?? '', port, onlineMode: options.onlineMode !== false, eulaAccepted: options.acceptEula, mods: copiedMods, skippedClientMods, directMods, overrides, generatedAt: new Date().toISOString() }
    const manifestPath = path.join(staging, 'modmind.server.json')
    await fs.writeFile(manifestPath, `${JSON.stringify(packManifest, null, 2)}\n`, 'utf8')
    if (options.preserveExistingFiles && await fs.stat(output).then((stat) => stat.isDirectory()).catch(() => false)) {
      const managedRoots = new Set(['mods', 'overrides', 'server.properties', 'eula.txt', 'modmind.server.json'])
      for (const entry of await fs.readdir(output, { withFileTypes: true })) {
        if (managedRoots.has(entry.name)) continue
        await fs.cp(path.join(output, entry.name), path.join(staging, entry.name), { recursive: true, force: true })
      }
    }
    await commitDirectory(staging, output)
    return { root: output, copiedMods, skippedClientMods, directMods, warnings, manifestPath: path.join(output, 'modmind.server.json') }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function installServerRuntime(options: ServerRuntimeInstallOptions, project: ProjectInfo): Promise<ServerRuntimeResult> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required to install a server runtime')
  if (!(await fs.stat(options.javaPath).then((stat) => stat.isFile()).catch(() => false))) throw new Error('a valid Java executable is required')
  const loaderVersion = normalizedLoaderVersion(project.loader as JavaLoaderKind, project.minecraftVersion, project.loaderVersion ?? '')
  if (!loaderVersion) throw new Error(`no ${project.loader} loader version is recorded in the project`)
  const installed = await detectInstalledServerRuntime(options.serverPack.root, project, options.javaPath)
  if (installed) return installed
  const selected = loaderSources(project.loader as JavaLoaderKind, project.minecraftVersion, loaderVersion)
  const target = path.join(options.serverPack.root, selected.direct ? 'server.jar' : 'installer.jar')
  if (project.loader === 'quilt') {
    const installers = await fetchJsonWithRetry<Array<{ url: string; hashes?: { sha256?: string } }>>('https://meta.quiltmc.org/v3/versions/installer', { signal: options.signal })
    const installer = installers.find(entry => /^https:\/\//.test(entry.url) && /^[a-f0-9]{64}$/i.test(entry.hashes?.sha256 ?? ''))
    if (!installer) throw new Error('Quilt Installer 目录没有可校验的发行文件')
    await verifiedDownload.download({ sources: [{ id: 'quilt-installer', label: 'Quilt 官方安装器', url: installer.url }], expectedHash: { algorithm: 'sha256', value: installer.hashes!.sha256! }, destination: target, signal: options.signal, onProgress: options.onDownloadProgress })
  } else await verifiedDownload.download({ sources: selected.sources, destination: target, maxBytes: 512 * 1024 * 1024, retriesPerSource: 2, signal: options.signal, onProgress: options.onDownloadProgress })
  if (!selected.direct) {
    const args = project.loader === 'quilt'
      ? ['-jar', target, 'install', 'server', project.minecraftVersion, loaderVersion, `--install-dir="${options.serverPack.root}"`, '--download-server']
      : ['-jar', target, '--installServer']
    await runJava(options.javaPath, args, options.serverPack.root, options.signal)
    await fs.rm(target, { force: true })
  }
  // The installer creates the runtime before ModMind writes its marker, so the
  // first post-install detection must be allowed to discover an unmarked runtime.
  const runtime = await detectInstalledServerRuntime(options.serverPack.root, project, options.javaPath, false)
  if (!runtime) throw new Error(`server runtime installer completed but no server jar or generated run script was found in ${options.serverPack.root}`)
  await fs.writeFile(path.join(options.serverPack.root, '.modmind-server-runtime.json'), `${JSON.stringify({ minecraftVersion: project.minecraftVersion, loader: project.loader, loaderVersion }, null, 2)}\n`, 'utf8')
  return runtime
}
