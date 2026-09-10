import { spawnManaged, stopProcessTree } from './processTree'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { collectBuiltModpackModuleArtifacts, readModpackManifest, syncModpackOverrides } from './modpackService'
import { readModpackLock } from './modpackLockService'
import { modpackModsRoot } from './modpackPaths'

/** Pinned upstream release used by the deterministic server-pack action. */
export const SERVER_PACK_CREATOR_VERSION = '8.1.2'
export const SERVER_PACK_CREATOR_MIN_JAVA = 21
export const SERVER_PACK_CREATOR_SHA256 = '6ecb5f604326a8cb74ede15f667d170e2001cd968ab7f99592a0045ff27b0fca'
export const SERVER_PACK_CREATOR_URL = `https://github.com/Griefed/ServerPackCreator/releases/download/${SERVER_PACK_CREATOR_VERSION}/ServerPackCreator-${SERVER_PACK_CREATOR_VERSION}.jar`
export const SERVER_PACK_CREATOR_RESOURCE_DIRECTORY = 'server-pack-creator'
export const SERVER_PACK_CREATOR_FILE_NAME = `ServerPackCreator-${SERVER_PACK_CREATOR_VERSION}.jar`

export interface ServerPackCreatorOptions {
  project: ProjectInfo
  outputDirectory: string
  javaPath: string
  cacheDirectory: string
  port?: number
  onlineMode?: boolean
  acceptEula: boolean
  includeUnknownSideMods?: boolean
  signal?: AbortSignal
  onProgress?: (message: string) => void
  onOutput?: (output: string) => void
}

export interface ServerPackCreatorResult {
  root: string
  copiedMods: string[]
  skippedClientMods: string[]
  directMods: string[]
  warnings: string[]
  manifestPath: string
  engine: 'serverpackcreator'
  engineVersion: string
  logPath: string
}

function resolvedInside(root: string, target: string): boolean {
  return path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`)
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const bytes = await fs.readFile(filePath)
  hash.update(bytes)
  return hash.digest('hex')
}

async function javaMajorVersion(javaPath: string): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(javaPath, ['-version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let text = ''
    const append = (chunk: Buffer): void => { text = `${text}${chunk.toString('utf8')}`.slice(-4_000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(text) : reject(new Error(`java -version exited with ${code ?? 1}: ${text}`)))
  })
  const match = output.match(/version\s+"(?:1\.)?(\d+)/i)
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN
  if (!Number.isInteger(major)) throw new Error(`unable to determine Java version from ${javaPath}`)
  return major
}

async function assertServerPackCreatorJava(javaPath: string): Promise<void> {
  const major = await javaMajorVersion(javaPath)
  if (major < SERVER_PACK_CREATOR_MIN_JAVA) {
    throw new Error(`ServerPackCreator ${SERVER_PACK_CREATOR_VERSION} requires Java ${SERVER_PACK_CREATOR_MIN_JAVA}+, but ${javaPath} is Java ${major}`)
  }
}

export function serverPackCreatorBundledJarCandidates(
  appPath = process.cwd(),
  packagedResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
): string[] {
  const candidates = [
    packagedResourcesPath && path.join(packagedResourcesPath, SERVER_PACK_CREATOR_RESOURCE_DIRECTORY, SERVER_PACK_CREATOR_FILE_NAME),
    path.join(appPath, 'resources', SERVER_PACK_CREATOR_RESOURCE_DIRECTORY, SERVER_PACK_CREATOR_FILE_NAME)
  ].filter((candidate): candidate is string => Boolean(candidate))
  return [...new Set(candidates)]
}

async function ensureBundledServerPackCreator(): Promise<string> {
  const candidates = serverPackCreatorBundledJarCandidates()
  for (const candidate of candidates) {
    const existing = await fs.stat(candidate).catch(() => null)
    if (existing?.isFile() && existing.size > 1_000_000 && (await sha256(candidate)) === SERVER_PACK_CREATOR_SHA256) return candidate
  }
  throw new Error(`bundled ServerPackCreator ${SERVER_PACK_CREATOR_VERSION} is missing or failed SHA-256 verification; checked ${candidates.join(', ')}`)
}

export function serverPackCreatorCommand(jarPath: string, configPath: string, destination: string, home: string): string[] {
  return ['-jar', jarPath, '-lang', 'en_us', '-config', configPath, '--destination', destination, '--home', home]
}

async function runCreator(javaPath: string, jarPath: string, configPath: string, workingDirectory: string, destination: string, home: string, logPath: string, signal?: AbortSignal, onOutput?: (output: string) => void): Promise<string> {
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const child = spawnManaged(javaPath, serverPackCreatorCommand(jarPath, configPath, destination, home), {
    cwd: workingDirectory,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })
  let output = ''
  const append = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output = `${output}${text}`.slice(-120_000)
    onOutput?.(text)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const abort = (): void => {
    if (!child.pid) return
    void stopProcessTree(child)
  }
  signal?.addEventListener('abort', abort, { once: true })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  }).finally(() => signal?.removeEventListener('abort', abort))
  await fs.writeFile(logPath, output, 'utf8')
  if (signal?.aborted) throw Object.assign(new Error('ServerPackCreator generation cancelled'), { name: 'AbortError' })
  if (exitCode !== 0) throw new Error(`ServerPackCreator exited with ${exitCode}: ${output.slice(-8_000)}`)
  return output
}

function assertCreatorOutputSucceeded(output: string): void {
  const failure = [
    /UnsupportedClassVersionError/i,
    /Couldn.t parse config file/i,
    /Config check not successful/i,
    /Encountered \d+ errors during the configuration check/i
  ].find((pattern) => pattern.test(output))
  if (failure) throw new Error(`ServerPackCreator reported a failed generation: ${output.slice(-8_000)}`)
}

async function listJarNames(root: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, 'mods'), { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map((entry) => entry.name).sort((left, right) => left.localeCompare(right))
}

/** Materializes ModMind's split workspace layout as the client-instance layout expected upstream. */
async function materializeClientInstance(project: ProjectInfo, root: string): Promise<Awaited<ReturnType<typeof readModpackManifest>>> {
  const manifest = await readModpackManifest(project)
  const modsRoot = modpackModsRoot(project, manifest)
  await fs.mkdir(path.join(root, 'mods'), { recursive: true })
  for (const mod of manifest.mods) {
    const source = path.join(modsRoot, mod.fileName)
    const stat = await fs.stat(source).catch(() => null)
    if (!stat?.isFile()) throw new Error(`missing mod ${mod.fileName}`)
    await fs.copyFile(source, path.join(root, 'mods', mod.fileName))
  }
  await syncModpackOverrides(project, root)
  return manifest
}

function tomlString(value: string): string {
  // TOML basic strings use the same escaping rules needed for JSON strings.
  return JSON.stringify(value)
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`
}

function serverPackCreatorModPrefix(fileName: string): string {
  return fileName.replace(/\.jar$/i, '')
}

function serverPackCreatorLoader(loader: ProjectInfo['loader']): string {
  if (loader === 'fabric') return 'Fabric'
  if (loader === 'quilt') return 'Quilt'
  if (loader === 'forge') return 'Forge'
  if (loader === 'neoforge') return 'NeoForge'
  throw new Error(`ServerPackCreator does not support ${loader} modpacks`)
}

function normalizedServerPackCreatorLoaderVersion(project: ProjectInfo): string {
  const value = project.loaderVersion?.trim() ?? ''
  if (project.loader === 'forge' && value.startsWith(`${project.minecraftVersion}-`)) return value.slice(project.minecraftVersion.length + 1)
  return value
}

async function writeServerPackCreatorConfig(project: ProjectInfo, source: string, configPath: string): Promise<void> {
  const lock = await readModpackLock(project)
  const whitelist = lock.mods.filter((mod) => mod.side === 'server' || mod.side === 'both').map((mod) => serverPackCreatorModPrefix(mod.fileName))
  const clientMods = lock.mods.filter((mod) => mod.side === 'client').map((mod) => serverPackCreatorModPrefix(mod.fileName))
  const loaderVersion = normalizedServerPackCreatorLoaderVersion(project)
  if (!loaderVersion) throw new Error(`no ${project.loader} loader version is recorded for ServerPackCreator`)
  const directories = (await fs.readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'server-pack')
    .map((entry) => entry.name)
  if (!directories.includes('mods')) directories.push('mods')
  directories.sort((left, right) => left.localeCompare(right))
  const inclusions = directories.map((directory) => [
    '[[inclusions]]',
    `\tdestination = ""`,
    `\texclusionFilter = ""`,
    `\tsource = ${tomlString(directory)}`,
    `\tinclusionFilter = ""`
  ].join('\n')).join('\n')
  const config = [
    '# Generated by ModMind for the bundled upstream ServerPackCreator.',
    'configVersion = "4"',
    'plugins = {}',
    `modpackDir = ${tomlString(source)}`,
    `whitelist = ${tomlArray(whitelist)}`,
    `clientMods = ${tomlArray(clientMods)}`,
    'serverIconPath = ""',
    'serverPropertiesPath = ""',
    `minecraftVersion = ${tomlString(project.minecraftVersion)}`,
    `modLoader = ${tomlString(serverPackCreatorLoader(project.loader))}`,
    `modLoaderVersion = ${tomlString(loaderVersion)}`,
    'includeServerIcon = false',
    'includeServerProperties = false',
    'includeZipCreation = false',
    'javaArgs = ""',
    'serverPackSuffix = ""',
    '',
    '[scripts]',
    '\tSPC_JAVA_SPC = "java"',
    '',
    inclusions,
    ''
  ].join('\n')
  await fs.writeFile(configPath, config, 'utf8')
}

/** Runs the upstream ServerPackCreator CLI and wraps its output in ModMind metadata. */
export async function buildWithServerPackCreator(options: ServerPackCreatorOptions): Promise<ServerPackCreatorResult> {
  if (options.project.kind !== 'modpack') throw new Error('a modpack project is required to build a server pack')
  if (!(await fs.stat(options.javaPath).then((stat) => stat.isFile()).catch(() => false))) throw new Error('a valid Java executable is required for ServerPackCreator')
  await assertServerPackCreatorJava(options.javaPath)
  const projectRoot = path.resolve(options.project.path)
  const output = path.resolve(options.outputDirectory)
  if (!resolvedInside(projectRoot, output)) throw new Error('server pack output must stay inside the active project directory')
  const cacheDirectory = path.resolve(options.cacheDirectory)
  await fs.mkdir(cacheDirectory, { recursive: true })
  const staging = `${output}.serverpackcreator-${process.pid}-${Date.now()}`
  const source = path.join(projectRoot, options.project.toolDataDirectory ?? '.modmind', `serverpackcreator-source-${process.pid}-${Date.now()}`)
  const home = path.join(cacheDirectory, 'home')
  const logPath = path.join(cacheDirectory, `serverpackcreator-${Date.now()}.log`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.rm(source, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  await fs.mkdir(home, { recursive: true })
  try {
    options.onProgress?.('正在准备 ServerPackCreator 工作目录')
    const manifest = await materializeClientInstance(options.project, source)
    const localArtifacts = await collectBuiltModpackModuleArtifacts(options.project)
    if (!manifest.mods.length) {
      options.onProgress?.('No third-party mods; skipping ServerPackCreator')
      await fs.mkdir(path.join(staging, 'mods'), { recursive: true })
    }
    let outputText = ''
    if (manifest.mods.length) {
      const creator = await ensureBundledServerPackCreator()
      const configPath = path.join(source, 'serverpackcreator.conf')
      await writeServerPackCreatorConfig(options.project, source, configPath)
      options.onProgress?.('ServerPackCreator 正在筛选服务端文件')
      outputText = await runCreator(options.javaPath, creator, configPath, source, staging, home, logPath, options.signal, options.onOutput)
      assertCreatorOutputSucceeded(outputText)
    }
    options.onProgress?.('正在整理筛选后的服务端文件')
    const generatedMods = await listJarNames(staging)
    if (!generatedMods.length && manifest.mods.length) throw new Error(`ServerPackCreator completed without a mods directory: ${outputText.slice(-4_000)}`)
    if (!generatedMods.length) await fs.mkdir(path.join(staging, 'mods'), { recursive: true })
    const lock = await readModpackLock(options.project)
    const lockByName = new Map(lock.mods.map((mod) => [mod.fileName.toLowerCase(), mod]))
    const policyExcluded = generatedMods.filter((fileName) => {
      const side = lockByName.get(fileName.toLowerCase())?.side
      return side === 'client' || (side === 'unknown' && options.includeUnknownSideMods === false)
    })
    await Promise.all(policyExcluded.map((fileName) => fs.rm(path.join(staging, 'mods', fileName), { force: true })))
    const mods = generatedMods.filter((fileName) => !policyExcluded.includes(fileName))
    const copiedNames = new Set(mods.map((mod) => mod.toLowerCase()))
    const directMods: string[] = []
    const skippedLocalMods: string[] = []
    for (const artifact of localArtifacts) {
      const side = artifact.module.side ?? 'both'
      if (side === 'client') {
        skippedLocalMods.push(artifact.fileName)
        continue
      }
      if (copiedNames.has(artifact.fileName.toLowerCase())) throw new Error(`duplicate server mod filename: ${artifact.fileName}`)
      await fs.copyFile(artifact.path, path.join(staging, 'mods', artifact.fileName))
      copiedNames.add(artifact.fileName.toLowerCase())
      mods.push(artifact.fileName)
      directMods.push(artifact.fileName)
    }
    const skippedClientMods = [
      ...manifest.mods.filter((mod) => !copiedNames.has(mod.fileName.toLowerCase())).map((mod) => mod.fileName),
      ...skippedLocalMods
    ]
    const warnings = [
      `Generated by ServerPackCreator ${SERVER_PACK_CREATOR_VERSION}`,
      ...(directMods.length ? [`ModMind directly copied ${directMods.length} self-made mod(s)`] : []),
      ...(policyExcluded.length ? [`ModMind policy skipped ${policyExcluded.length} locked client/unknown-side mod(s)`] : []),
      ...(lock.mods.length ? [] : ['no provider lock records exist; ServerPackCreator performed filename/metadata auto-discovery'])
    ]
    await fs.writeFile(path.join(staging, 'server.properties'), [
      'server-ip=127.0.0.1',
      `server-port=${Number.isInteger(options.port) ? options.port : 25565}`,
      `online-mode=${options.onlineMode !== false}`,
      'enable-command-block=true',
      'motd=ModMind Server'
    ].join('\n') + '\n', 'utf8')
    await fs.writeFile(path.join(staging, 'eula.txt'), `eula=${options.acceptEula ? 'true' : 'false'}\n`, 'utf8')
    const packManifest = {
      version: 1,
      name: manifest.name,
      minecraftVersion: manifest.minecraftVersion,
      loader: manifest.loader,
      loaderVersion: options.project.loaderVersion ?? '',
      engine: 'serverpackcreator',
      engineVersion: SERVER_PACK_CREATOR_VERSION,
      port: Number.isInteger(options.port) ? options.port : 25565,
      onlineMode: options.onlineMode !== false,
      eulaAccepted: options.acceptEula,
      mods,
      skippedClientMods,
      directMods,
      generatedAt: new Date().toISOString(),
      engineLog: logPath
    }
    const manifestPath = path.join(staging, 'modmind.server.json')
    await fs.writeFile(manifestPath, `${JSON.stringify(packManifest, null, 2)}\n`, 'utf8')
    await fs.rm(output, { recursive: true, force: true })
    await fs.rename(staging, output)
    return { root: output, copiedMods: mods, skippedClientMods, directMods, warnings, manifestPath: path.join(output, 'modmind.server.json'), engine: 'serverpackcreator', engineVersion: SERVER_PACK_CREATOR_VERSION, logPath }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(source, { recursive: true, force: true }).catch(() => undefined)
  }
}
