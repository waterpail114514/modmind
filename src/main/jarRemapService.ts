import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DecompileRemapInfo } from '../shared/decompile'
import { verifiedDownload } from './downloadService'
import { readValidatedTextCache } from './validatedTextCache'

/** Pinned tiny-remapper release bundled with ModMind. */
export const TINY_REMAPPER_VERSION = '0.14.0'
export const TINY_REMAPPER_SHA256 = '0a86f606ca086bd7f90cededa884d23d014696a7d97a8bedc159f9efc5e6026a'
export const TINY_REMAPPER_FILE_NAME = `tiny-remapper-${TINY_REMAPPER_VERSION}.jar`
/** Runtime classpath companions for tiny-remapper (asm 9.9.1 + mapping-io 0.7.1). */
export const TINY_REMAPPER_CLASSPATH_FILES = [
  'asm-9.9.1.jar',
  'asm-commons-9.9.1.jar',
  'asm-tree-9.9.1.jar',
  'asm-util-9.9.1.jar',
  'mapping-io-0.7.1.jar'
] as const

const YARN_META_BASE = 'https://meta.fabricmc.net/v2/versions/yarn'
const YARN_MAVEN_TEMPLATE = 'https://maven.fabricmc.net/net/fabricmc/yarn/%MINECRAFT%+build.%BUILD%/yarn-%MINECRAFT%+build.%BUILD%-v2.jar'
/** Mirrors tried in order; the first entry is the FabricMC maven, later ones are CN-friendly fallbacks via aliyun's central mirror is not applicable (yarn lives on FabricMC only), so we retry the same host. */
const YARN_DOWNLOAD_HOSTS = ['https://maven.fabricmc.net']

export interface RemapJarOptions {
  inputJar: string
  outputJar: string
  /** Path of the tiny-v2 mappings file (already downloaded). */
  mappingsPath: string
  javaPath: string
  /** Optional jars (e.g. other mods or the Minecraft client jar) that resolve inherited members. */
  classpath?: string[]
  signal?: AbortSignal
  onProgress?: (message: string) => void
  onOutput?: (output: string) => void
}

export interface RemapJarResult {
  tool: 'tiny-remapper'
  toolVersion: string
  outputJar: string
}

function resolvedInside(root: string, target: string): boolean {
  return path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`)
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

export function tinyRemapperBundledJarCandidates(
  appPath = process.cwd(),
  packagedResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
): string[] {
  const candidates = [
    packagedResourcesPath && path.join(packagedResourcesPath, 'decompile-tools', TINY_REMAPPER_FILE_NAME),
    path.join(appPath, 'resources', 'decompile-tools', TINY_REMAPPER_FILE_NAME)
  ].filter((candidate): candidate is string => Boolean(candidate))
  return [...new Set(candidates)]
}

async function verifyClasspathCompanions(directory: string): Promise<void> {
  const missing: string[] = []
  for (const file of TINY_REMAPPER_CLASSPATH_FILES) {
    const stat = await fs.stat(path.join(directory, file)).catch(() => null)
    if (!stat?.isFile()) missing.push(file)
  }
  if (missing.length) throw new Error(`bundled remapper dependencies are missing: ${missing.join(', ')}`)
}

export async function ensureBundledTinyRemapper(): Promise<{ jar: string; classpath: string[] }> {
  const candidates = tinyRemapperBundledJarCandidates()
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null)
    if (stat?.isFile() && stat.size > 100_000 && (await sha256(candidate)) === TINY_REMAPPER_SHA256) {
      const directory = path.dirname(candidate)
      await verifyClasspathCompanions(directory)
      return { jar: candidate, classpath: [candidate, ...TINY_REMAPPER_CLASSPATH_FILES.map((file) => path.join(directory, file))] }
    }
  }
  throw new Error(`bundled tiny-remapper ${TINY_REMAPPER_VERSION} is missing or failed SHA-256 verification; checked ${candidates.join(', ')}`)
}

/**
 * Builds the tiny-remapper CLI invocation. Confirmed against the pinned binary:
 * `<input> <output> <mappings> <from> <to> [<classpath>]...`.
 * `--forcePropagation` keeps synthetic accessors consistent; extra flags are avoided so the
 * behavior stays stable across the pinned version.
 */
export function tinyRemapperCommand(javaExecutable: string, classpath: string[], options: Pick<RemapJarOptions, 'inputJar' | 'outputJar' | 'mappingsPath' | 'classpath'>): string[] {
  return [
    javaExecutable,
    '-cp', classpath.join(path.delimiter),
    'net.fabricmc.tinyremapper.Main',
    path.resolve(options.inputJar),
    path.resolve(options.outputJar),
    path.resolve(options.mappingsPath),
    'intermediary',
    'named',
    ...options.classpath?.map((entry) => path.resolve(entry)) ?? []
  ]
}

async function runTinyRemapper(args: string[], workingDirectory: string, signal?: AbortSignal, onOutput?: (output: string) => void): Promise<number> {
  // First element is the java executable; spawn separately.
  const [javaExecutable, ...rest] = args
  const child = spawn(javaExecutable, rest, { cwd: workingDirectory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let output = ''
  const append = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output = `${output}${text}`.slice(-80_000)
    onOutput?.(text)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const abort = (): void => {
    if (!child.pid) return
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).unref()
    else child.kill('SIGTERM')
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    if (signal?.aborted) throw Object.assign(new Error('remapping cancelled'), { name: 'AbortError' })
    if (exitCode !== 0) throw new Error(`tiny-remapper exited with ${exitCode}: ${output.slice(-8_000)}`)
    return exitCode
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

export async function remapJarWithTinyRemapper(options: RemapJarOptions): Promise<RemapJarResult> {
  if (!(await fs.stat(options.javaPath).then((stat) => stat.isFile()).catch(() => false))) throw new Error('a valid Java executable is required for remapping')
  const inputStat = await fs.stat(options.inputJar).catch(() => null)
  if (!inputStat?.isFile()) throw new Error(`input jar does not exist: ${options.inputJar}`)
  if (!resolvedInside(path.dirname(options.outputJar), options.outputJar)) throw new Error('remapped output must stay inside its working directory')
  const mappingStat = await fs.stat(options.mappingsPath).catch(() => null)
  if (!mappingStat?.isFile()) throw new Error(`yarn mappings file does not exist: ${options.mappingsPath}`)
  const { classpath } = await ensureBundledTinyRemapper()
  options.onProgress?.('正在运行 tiny-remapper 还原可读名称')
  await fs.rm(options.outputJar, { force: true }).catch(() => undefined)
  await runTinyRemapper(tinyRemapperCommand(options.javaPath, classpath, options), os.tmpdir(), options.signal, options.onOutput)
  const stat = await fs.stat(options.outputJar).catch(() => null)
  if (!stat?.isFile() || stat.size < 1) throw new Error('tiny-remapper completed without producing an output jar')
  return { tool: 'tiny-remapper', toolVersion: TINY_REMAPPER_VERSION, outputJar: options.outputJar }
}

export interface YarnVersionEntry {
  gameVersion: string
  separator: string
  build: number
  version: string
  stable: boolean
}

export function yarnMappingsCachePath(cacheRoot: string, minecraftVersion: string): string {
  if (!/^[A-Za-z0-9._+-]+$/.test(minecraftVersion)) throw new Error(`invalid Minecraft version: ${minecraftVersion}`)
  return path.join(cacheRoot, 'yarn', `${minecraftVersion}.tiny`)
}

export function pickYarnBuild(entries: YarnVersionEntry[], minecraftVersion: string): YarnVersionEntry | null {
  return entries.filter((entry) => entry.gameVersion === minecraftVersion).sort((left, right) => right.build - left.build)[0] ?? null
}

export function yarnV2MappingsUrl(entry: Pick<YarnVersionEntry, 'gameVersion' | 'build'>): string {
  return YARN_MAVEN_TEMPLATE.replaceAll('%MINECRAFT%', entry.gameVersion).replaceAll('%BUILD%', String(entry.build))
}

/**
 * Downloads (or reuses) yarn tiny-v2 mappings for one Minecraft version.
 * The `.tiny` file inside the yarn v2 jar is extracted without keeping the jar itself.
 */
export function validateYarnMappings(content: string): void {
  const lines = content.split(/\r?\n/)
  const header = lines.shift()?.split('\t') ?? []
  const namespaces = header.slice(3)
  if (header[0] !== 'tiny' || header[1] !== '2' || header[2] !== '0' || !namespaces.includes('intermediary') || !namespaces.includes('named')) throw new Error('Yarn 映射格式无效：缺少 tiny-v2 命名空间')
  let classes = 0
  for (const line of lines) {
    if (!line) continue
    const indent = line.match(/^\t*/)?.[0].length ?? 0
    const columns = line.slice(indent).split('\t')
    const kind = columns[0]
    if (indent === 0 && kind === 'c' && columns[1] && columns.length <= namespaces.length + 1) classes++
    else if (indent === 1 && classes === 0) continue // tiny-v2 header properties
    else if (indent > 0 && kind === 'c') continue // comments
    else if (indent === 1 && (kind === 'm' || kind === 'f') && columns[1] && columns[2] && columns.length <= namespaces.length + 2) continue
    else if (indent === 2 && kind === 'p' && /^\d+$/.test(columns[1] ?? '') && columns.length >= 3) continue
    else if (indent === 2 && kind === 'v' && columns.slice(1, 4).length === 3 && columns.slice(1, 4).every(value => /^\d+$/.test(value)) && columns.length >= 5) continue
    else throw new Error('Yarn 映射格式无效：记录损坏或不完整')
  }
  if (!classes || !content.endsWith('\n')) throw new Error('Yarn 映射格式无效：内容为空或被截断')
}

export async function ensureYarnMappings(cacheRoot: string, minecraftVersion: string, options: { download: (request: Parameters<typeof verifiedDownload.download>[0]) => ReturnType<typeof verifiedDownload.download>; listVersions?: (base: string) => Promise<YarnVersionEntry[]> }): Promise<string> {
  const destination = yarnMappingsCachePath(cacheRoot, minecraftVersion)
  await readValidatedTextCache(destination, async () => {
    const listVersions = options.listVersions ?? defaultListYarnVersions
    const entries = await listVersions(YARN_META_BASE)
    const chosen = pickYarnBuild(entries, minecraftVersion)
    if (!chosen) throw new Error(`no yarn mappings published for Minecraft ${minecraftVersion}`)
    const staging = `${destination}.staging-${randomUUID()}`
    try {
      await fs.mkdir(path.dirname(staging), { recursive: true })
      await options.download({
        sources: YARN_DOWNLOAD_HOSTS.map((host, index) => ({ id: `yarn-${index}`, label: `yarn ${chosen.version}`, url: yarnV2MappingsUrl(chosen).replace('https://maven.fabricmc.net', host) })),
        destination: staging,
        maxBytes: 32 * 1024 * 1024,
        retriesPerSource: 1
      })
      return await extractTinyFromYarnJar(staging)
    } finally {
      await fs.rm(staging, { force: true }).catch(() => undefined)
    }
  }, validateYarnMappings)
  return destination
}

async function defaultListYarnVersions(base: string): Promise<YarnVersionEntry[]> {
  const response = await fetch(base, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`yarn meta request failed with ${response.status}`)
  const payload = await response.json() as unknown
  return Array.isArray(payload) ? payload as YarnVersionEntry[] : []
}

/** Extracts `mappings/mappings.tiny` from a yarn v2 jar using the bundled 7za helper. */
async function extractTinyFromYarnJar(jarPath: string): Promise<string> {
  const { extractSevenZipArchive } = await import('./sevenZipArchive')
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-yarn-'))
  try {
    await extractSevenZipArchive(jarPath, temporary)
    return await fs.readFile(path.join(temporary, 'mappings', 'mappings.tiny'), 'utf8')
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}
