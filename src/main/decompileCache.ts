import { promises as fs, createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DecompileProvenance } from '../shared/decompile'

export const DECOMPILE_CACHE_SCHEMA_VERSION = 1
export const DECOMPILE_PROVENANCE_FILE = 'provenance.json'
export const DECOMPILE_OUTPUT_DIRECTORY = 'sources'
export const DEFAULT_DECOMPILE_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
const OUTPUT_MANIFEST = 'output-manifest.json'

interface OutputFile { path: string; size: number; sha256: string }

async function outputHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function outputFiles(directory: string): Promise<OutputFile[]> {
  const files: OutputFile[] = []
  const walk = async (relative: string): Promise<void> => {
    const absolute = path.join(directory, relative)
    const stat = await fs.lstat(absolute)
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(absolute)) await walk(`${relative}/${name}`)
    } else if (stat.isFile()) {
      files.push({ path: relative, size: stat.size, sha256: await outputHash(absolute) })
    } else throw new Error('反编译缓存包含非普通文件')
  }
  await walk('sources')
  if (await fs.lstat(path.join(directory, 'resources')).catch(() => null)) await walk('resources')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function validOutputs(directory: string, sourceSha256: string, onlyFile?: string): Promise<boolean> {
  try {
    const manifestPath = path.join(directory, OUTPUT_MANIFEST)
    if ((await fs.lstat(manifestPath)).size > 32 * 1024 * 1024) return false
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: number; sourceSha256?: string; files?: OutputFile[] }
    if (manifest.version !== 1 || manifest.sourceSha256 !== sourceSha256.toLowerCase() || !Array.isArray(manifest.files) || !manifest.files.some(file => file.path?.startsWith('sources/'))) return false
    if (manifest.files.some(file => !/^(sources|resources)\//.test(file.path) || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) return false
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) return false
    if (onlyFile) {
      const file = manifest.files.find(file => file.path === onlyFile)
      if (!file) return false
      // Check every path component to avoid following substituted symlinks.
      let target = directory
      for (const part of file.path.split('/')) {
        target = path.join(target, part)
        if ((await fs.lstat(target)).isSymbolicLink()) return false
      }
      const stat = await fs.lstat(target)
      return stat.isFile() && stat.size === file.size && await outputHash(target) === file.sha256
    }
    const actual = await outputFiles(directory)
    const expected = new Map(manifest.files.map(file => [file.path, file]))
    return actual.length === expected.size && actual.every(file => file.size === expected.get(file.path)?.size && file.sha256 === expected.get(file.path)?.sha256)
  } catch { return false }
}

export interface DecompileCacheEntry {
  directory: string
  provenance: DecompileProvenance | null
}

function entryDirectory(cacheRoot: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('invalid decompile cache key')
  return path.join(cacheRoot, 'jars', sha256.toLowerCase())
}

/** Returns the existing cache entry for a jar hash, or null when nothing usable is cached. */
export async function readDecompileCacheEntry(cacheRoot: string, sourceSha256: string, onlyFile?: string): Promise<DecompileCacheEntry | null> {
  const directory = entryDirectory(cacheRoot, sourceSha256)
  const sources = path.join(directory, DECOMPILE_OUTPUT_DIRECTORY)
  if (!(await fs.lstat(directory).catch(() => null))?.isDirectory()) return null
  const stat = await fs.lstat(sources).catch(() => null)
  if (!stat?.isDirectory()) return null
  const rawProvenance = await fs.readFile(path.join(directory, DECOMPILE_PROVENANCE_FILE), 'utf8').catch(() => null)
  let provenance: DecompileProvenance | null = null
  if (rawProvenance) {
    try {
      const parsed = JSON.parse(rawProvenance) as DecompileProvenance
      if (parsed?.schemaVersion === DECOMPILE_CACHE_SCHEMA_VERSION && parsed.readOnly === true && parsed.sourceSha256 === sourceSha256.toLowerCase() && await validOutputs(directory, sourceSha256, onlyFile)) provenance = parsed
    } catch {
      provenance = null
    }
  }
  // Touch the access stamp so LRU cleanup can rank entries by last use.
  await fs.writeFile(path.join(directory, 'last-access'), new Date().toISOString(), 'utf8').catch(() => undefined)
  return { directory, provenance }
}

interface StagingHandle {
  staging: string
  finalize: (provenance: DecompileProvenance) => Promise<DecompileCacheEntry>
  abandon: () => Promise<void>
}

/**
 * Prepares a private staging directory for a new cache entry. The caller writes the
 * decompiled tree into `<staging>/sources`, then calls `finalize`, which stamps
 * provenance and atomically moves the entry into place. On failure `abandon` removes
 * all traces so partial output never looks like a valid cache hit.
 */
export async function createDecompileCacheStaging(cacheRoot: string, sourceSha256: string): Promise<StagingHandle> {
  const directory = entryDirectory(cacheRoot, sourceSha256)
  const staging = `${directory}.staging-${randomUUID()}`
  await fs.mkdir(path.join(staging, DECOMPILE_OUTPUT_DIRECTORY), { recursive: true })
  return {
    staging,
    finalize: async (provenance: DecompileProvenance): Promise<DecompileCacheEntry> => {
      const files = await outputFiles(staging)
      if (!files.some(file => file.path.startsWith('sources/'))) throw new Error('反编译缓存没有输出文件')
      if (provenance.sourceSha256 !== sourceSha256.toLowerCase()) throw new Error('反编译来源哈希不匹配')
      await fs.writeFile(path.join(staging, OUTPUT_MANIFEST), JSON.stringify({ version: 1, sourceSha256: sourceSha256.toLowerCase(), files }), 'utf8')
      await fs.writeFile(path.join(staging, DECOMPILE_PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
      await fs.writeFile(path.join(staging, 'last-access'), provenance.createdAt, 'utf8')
      await fs.rm(directory, { recursive: true, force: true })
      await fs.mkdir(path.dirname(directory), { recursive: true })
      await fs.rename(staging, directory)
      return { directory, provenance }
    },
    abandon: async (): Promise<void> => {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

interface CacheSweepItem {
  directory: string
  lastAccess: number
  size: number
}

async function directorySize(root: string): Promise<number> {
  let total = 0
  const queue = [root]
  while (queue.length) {
    const current = queue.shift()!
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile()) total += (await fs.stat(absolute).catch(() => null))?.size ?? 0
    }
  }
  return total
}

/** Enforces an LRU byte budget across cached decompilation entries. Never touches active stagings. */
export async function enforceDecompileCacheLimit(
  cacheRoot: string,
  limitBytes = DEFAULT_DECOMPILE_CACHE_LIMIT_BYTES,
  keepSha256?: string
): Promise<string[]> {
  const jarsRoot = path.join(cacheRoot, 'jars')
  const items: CacheSweepItem[] = []
  for (const entry of await fs.readdir(jarsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/i.test(entry.name)) continue
    const directory = path.join(jarsRoot, entry.name)
    const lastAccess = Date.parse((await fs.readFile(path.join(directory, 'last-access'), 'utf8').catch(() => ''))) || 0
    items.push({ directory, lastAccess, size: await directorySize(directory) })
  }
  const removed: string[] = []
  let total = items.reduce((sum, item) => sum + item.size, 0)
  const ordered = items.sort((left, right) => left.lastAccess - right.lastAccess || left.directory.localeCompare(right.directory))
  for (const item of ordered) {
    if (total <= limitBytes) break
    if (keepSha256 && path.basename(item.directory).toLowerCase() === keepSha256.toLowerCase()) continue
    try {
      await fs.rm(item.directory, { recursive: true, force: true })
      total -= item.size
      removed.push(path.basename(item.directory))
    } catch { /* Locked entries remain in the budget; try the next inactive entry. */ }
  }
  return removed
}
