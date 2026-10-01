import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeFeatureResourcePath } from '../../../sdk/nativeResources'
import type {
  DecompileEngineId,
  DecompileFileEntry,
  DecompileObfuscationHint,
  DecompileProvenance
} from "../../../../src/shared/decompile"

/** Pinned Vineflower release bundled with ModMind (see resources/decompile-tools/UPSTREAM.md). */
export const VINEFLOWER_VERSION = '1.11.1'
export const VINEFLOWER_SHA256 = 'a615d07ddbbcd489369674f40e42df639c32be95410890b38f173d5c1e2ea39c'
export const DECOMPILE_TOOLS_RESOURCE_DIRECTORY = 'decompile-tools'
export const VINEFLOWER_FILE_NAME = `vineflower-${VINEFLOWER_VERSION}.jar`
/** Vineflower needs Java 17+; we already require 21 for the rest of the pipeline. */
export const DECOMPILE_MIN_JAVA = 21

const ERROR_MARKER = '/* error */'

export interface DecompileJarOptions {
  /** Input jar (possibly a remapped copy). */
  inputJar: string
  outputDirectory: string
  javaPath: string
  /** Class count of the input jar, used to estimate progress from Vineflower log lines. */
  totalClasses?: number
  signal?: AbortSignal
  onProgress?: (message: string, ratio?: number) => void
  onOutput?: (output: string) => void
}

export interface DecompileJarResult {
  engine: Extract<DecompileEngineId, 'vineflower'>
  engineVersion: string
  files: DecompileFileEntry[]
  errorFileCount: number
}

function resolvedInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  return path.resolve(target).startsWith(`${resolvedRoot}${path.sep}`)
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

export function vineflowerBundledJarCandidates(
  appPath = process.cwd(),
  packagedResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
): string[] {
  const candidates = [
    nativeFeatureResourcePath(DECOMPILE_TOOLS_RESOURCE_DIRECTORY, VINEFLOWER_FILE_NAME),
    packagedResourcesPath && path.join(packagedResourcesPath, 'feature-plugins', 'decompile', 'assets', DECOMPILE_TOOLS_RESOURCE_DIRECTORY, VINEFLOWER_FILE_NAME),
    path.join(appPath, 'feature-plugins', 'decompile', 'assets', DECOMPILE_TOOLS_RESOURCE_DIRECTORY, VINEFLOWER_FILE_NAME)
  ].filter((candidate): candidate is string => Boolean(candidate))
  return [...new Set(candidates)]
}

/** Locates the pinned bundled Vineflower jar and verifies its SHA-256 before use. */
export async function ensureBundledVineflower(): Promise<string> {
  const candidates = vineflowerBundledJarCandidates()
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null)
    if (stat?.isFile() && stat.size > 1_000_000 && (await sha256(candidate)) === VINEFLOWER_SHA256) return candidate
  }
  throw new Error(`bundled Vineflower ${VINEFLOWER_VERSION} is missing or failed SHA-256 verification; checked ${candidates.join(', ')}`)
}

/**
 * Builds the Vineflower CLI argument list. Options are pinned so cached results stay
 * reproducible across ModMind versions: readable names off (mod jars are already named),
 * errors kept inline as error markers, and decompiled sources written as `.java`.
 */
export function vineflowerCommand(jarPath: string, inputJar: string, outputDirectory: string): string[] {
  return [
    '-jar', jarPath,
    '-dgs=1',        // decompile generic signatures
    '-hdc=0',        // keep the original line order instead of compacting declarations
    '-asc=1',        // encode non-ASCII escapes in strings
    '-udv=0',        // keep original variable names when debug info exists
    '-rsy=1',        // render synthetic bridge methods instead of hiding them
    '-ind=', String('    '), // indentation via spaces
    inputJar,
    outputDirectory
  ]
}

interface RunOutcome {
  exitCode: number
  output: string
}

async function runVineflower(javaPath: string, args: string[], workingDirectory: string, signal?: AbortSignal, onOutput?: (output: string) => void): Promise<RunOutcome> {
  const child = spawn(javaPath, args, { cwd: workingDirectory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let output = ''
  const append = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output = `${output}${text}`.slice(-160_000)
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
    return { exitCode, output }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

async function javaMajorVersion(javaPath: string): Promise<number> {
  const outcome = await runVineflower(javaPath, ['-version'], os.tmpdir())
  const match = outcome.output.match(/version\s+"(?:1\.)?(\d+)/i)
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN
  if (!Number.isInteger(major)) throw new Error(`unable to determine Java version from ${javaPath}`)
  return major
}

export async function assertDecompileJava(javaPath: string): Promise<void> {
  const major = await javaMajorVersion(javaPath)
  if (major < DECOMPILE_MIN_JAVA) throw new Error(`Vineflower ${VINEFLOWER_VERSION} requires Java ${DECOMPILE_MIN_JAVA}+, but ${javaPath} is Java ${major}`)
}

async function listJavaFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const queue = [root]
  while (queue.length) {
    const directory = queue.shift()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.java')) files.push(path.relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

/** Estimates progress from Vineflower's per-class log lines (`Decompiling class ...`). */
function decompilingRatio(output: string, totalClasses: number | undefined): number | undefined {
  const done = [...output.matchAll(/Decompiling class ([^\s]+)/gi)].length
  if (!done || !totalClasses) return undefined
  return Math.min(0.99, done / totalClasses)
}

/**
 * Runs bundled Vineflower over one jar into `outputDirectory`. The directory must be
 * empty or absent and stays inside the caller-provided root (never the project tree).
 */
export async function decompileJarWithVineflower(options: DecompileJarOptions): Promise<DecompileJarResult> {
  if (!(await fs.stat(options.javaPath).then((stat) => stat.isFile()).catch(() => false))) throw new Error('a valid Java executable is required for decompilation')
  await assertDecompileJava(options.javaPath)
  const inputStat = await fs.stat(options.inputJar).catch(() => null)
  if (!inputStat?.isFile()) throw new Error(`input jar does not exist: ${options.inputJar}`)
  if (!(await fs.stat(options.inputJar.replace(/\.jar$/i, '')).then((stat) => stat.isDirectory()).catch(() => false)) && options.inputJar === options.outputDirectory) throw new Error('input and output must differ')
  await fs.mkdir(options.outputDirectory, { recursive: true })
  const existing = await fs.readdir(options.outputDirectory)
  if (existing.length && !existing.every((name) => name.startsWith('.'))) throw new Error('decompile output directory must start empty')
  const jarPath = await ensureBundledVineflower()
  options.onProgress?.('正在启动 Vineflower 反编译引擎', 0.02)
  const args = vineflowerCommand(jarPath, path.resolve(options.inputJar), path.resolve(options.outputDirectory))
  let output = ''
  let ratioReported = 0
  const outcome = await runVineflower(options.javaPath, args, os.tmpdir(), options.signal, (text) => {
    output = `${output}${text}`
    const ratio = decompilingRatio(output, options.totalClasses)
    if (ratio !== undefined && ratio - ratioReported >= 0.05) {
      ratioReported = ratio
      options.onProgress?.(`正在反编译（约 ${Math.round(ratio * 100)}%）`, 0.05 + ratio * 0.9)
    }
    options.onOutput?.(text)
  })
  if (options.signal?.aborted) throw Object.assign(new Error('decompilation cancelled'), { name: 'AbortError' })
  const files = await listJavaFiles(options.outputDirectory)
  if (outcome.exitCode !== 0 || !files.length) {
    throw new Error(`Vineflower exited with ${outcome.exitCode}: ${(outcome.output || '(no output)').slice(-8_000)}`)
  }
  // Detect classes where recovery failed so the UI can flag them honestly.
  const errorFiles: string[] = []
  for (const relative of files.slice(0, 20_000)) {
    const text = await fs.readFile(path.join(options.outputDirectory, relative), 'utf8').catch(() => '')
    if (text.includes(ERROR_MARKER)) errorFiles.push(relative)
  }
  options.onProgress?.('反编译完成，正在整理结果', 0.98)
  return {
    engine: 'vineflower',
    engineVersion: VINEFLOWER_VERSION,
    files: files.map((relativePath) => ({ relativePath, size: 0, hasErrors: false })),
    errorFileCount: errorFiles.length
  }
}

export function buildDecompileProvenance(input: Omit<DecompileProvenance, 'schemaVersion' | 'readOnly' | 'createdAt'> & { createdAt?: string }): DecompileProvenance {
  return { schemaVersion: 1, readOnly: true, createdAt: new Date().toISOString(), ...input }
}

export function classifyObfuscation(classNames: readonly string[]): { obfuscationRatio: number; hint: DecompileObfuscationHint } {
  if (!classNames.length) return { obfuscationRatio: 0, hint: 'unknown' }
  // Count top-level simple names that carry no semantic information.
  const suspicious = classNames.filter((className) => {
    const simple = className.split('.').pop() ?? className
    return /^[a-z]$|^[a-zA-Z]{1,2}\$?\d*$/.test(simple)
  }).length
  const ratio = Number((suspicious / classNames.length).toFixed(4))
  return { obfuscationRatio: ratio, hint: ratio > 0.5 ? 'obfuscated' : 'clear' }
}

/** Convenience wrapper used by IPC: verifies the finished tree and returns provenance-ready metadata. */
export async function summarizeDecompiledTree(outputDirectory: string, resolvedInsideRoot: string): Promise<DecompileFileEntry[]> {
  if (!resolvedInside(resolvedInsideRoot, outputDirectory)) throw new Error('decompiled output escaped its cache root')
  const entries = await listJavaFiles(outputDirectory)
  const result: DecompileFileEntry[] = []
  for (const relativePath of entries) {
    const text = await fs.readFile(path.join(outputDirectory, relativePath), 'utf8').catch(() => '')
    result.push({ relativePath, size: Buffer.byteLength(text, 'utf8'), hasErrors: text.includes(ERROR_MARKER) })
  }
  return result
}
