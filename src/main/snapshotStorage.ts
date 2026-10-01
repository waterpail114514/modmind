import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SnapshotStorageInfo } from '../shared/types'

const CACHE_DIRECTORY = '.gradle-cloud-storage-test'
const SNAPSHOT_WARNING_BYTES = 2 * 1024 * 1024 * 1024
const MAX_SCANNED_FILES = 1_000_000
const ignoredDirectories = new Set(['node_modules', '.git', 'build', '.gradle', '.modmind', 'run', 'logs', CACHE_DIRECTORY])

function missingDirectoryIsEmpty(error: unknown): [] {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
  throw error
}

function missingFileIsNull(error: unknown): null {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
  throw error
}

export function ignoreSnapshotDirectory(name: string): boolean {
  return ignoredDirectories.has(name)
}

interface StoredSnapshotManifest {
  id?: unknown
  projectPath?: unknown
  fileCount?: unknown
  files?: unknown
  hashes?: Record<string, string>
  fileMetadata?: Record<string, unknown>
  [key: string]: unknown
}

async function listedCacheFiles(root: string): Promise<string[] | null> {
  const pending = [root]
  const files: string[] = []
  while (pending.length) {
    const directory = pending.pop()!
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return null
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'))
      else return null
    }
  }
  return files
}

/** Removes only a known rebuildable Gradle test cache from old snapshots. */
export async function repairLegacySnapshotCaches(projectPath: string): Promise<{ repaired: number; skipped: number }> {
  const root = path.join(projectPath, '.modmind', 'snapshots')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(missingDirectoryIsEmpty)
  let repaired = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = path.join(root, entry.name)
    const manifestPath = path.join(directory, 'snapshot.json')
    const manifest = await fs.readFile(manifestPath, 'utf8').then(value => JSON.parse(value) as StoredSnapshotManifest).catch(() => null)
    if (!manifest || manifest.id !== entry.name || !Array.isArray(manifest.files)
      || (manifest.projectPath !== undefined && (typeof manifest.projectPath !== 'string' || path.resolve(manifest.projectPath) !== path.resolve(projectPath)))) continue
    const files = manifest.files
    if (!files.every(value => typeof value === 'string')) continue
    const cacheFiles = files.filter((relative): relative is string => typeof relative === 'string' && relative.split('/').includes(CACHE_DIRECTORY))
    if (!cacheFiles.length) continue
    const trackedCacheFiles = new Set(cacheFiles)
    const cachePrefixes = new Set(cacheFiles.map(relative => {
      const parts = relative.split('/')
      return parts.slice(0, parts.indexOf(CACHE_DIRECTORY) + 1).join('/')
    }))
    try {
      const cacheRoots: string[] = []
      let unsafe = false
      const filesDirectory = await fs.lstat(path.join(directory, 'files')).catch(missingFileIsNull)
      if (filesDirectory && (!filesDirectory.isDirectory() || filesDirectory.isSymbolicLink())) { skipped += 1; continue }
      for (const prefix of cachePrefixes) {
        const parts = prefix.split('/')
        if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) { unsafe = true; break }
        let cacheRoot = path.join(directory, 'files')
        let cacheStat: Awaited<ReturnType<typeof fs.lstat>> | null = null
        for (const part of parts) {
          cacheRoot = path.join(cacheRoot, part)
          cacheStat = await fs.lstat(cacheRoot).catch(missingFileIsNull)
          if (cacheStat && (!cacheStat.isDirectory() || cacheStat.isSymbolicLink())) { unsafe = true; break }
          if (!cacheStat) break
        }
        if (unsafe) break
        const actualFiles = cacheStat ? await listedCacheFiles(cacheRoot) : []
        if (!actualFiles || actualFiles.some(relative => !trackedCacheFiles.has(`${prefix}/${relative}`))) { unsafe = true; break }
        if (cacheStat) cacheRoots.push(cacheRoot)
      }
      if (unsafe) { skipped += 1; continue }
      const removed = trackedCacheFiles
      const updated: StoredSnapshotManifest = {
        ...manifest,
        files: files.filter(relative => !removed.has(relative as string)),
        fileCount: files.length - removed.size,
        ...(manifest.hashes ? { hashes: Object.fromEntries(Object.entries(manifest.hashes).filter(([relative]) => !removed.has(relative))) } : {}),
        ...(manifest.fileMetadata ? { fileMetadata: Object.fromEntries(Object.entries(manifest.fileMetadata).filter(([relative]) => !removed.has(relative))) } : {})
      }
      const temporary = `${manifestPath}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify(updated, null, 2), { flag: 'wx' })
        for (const cacheRoot of cacheRoots) await fs.rm(cacheRoot, { recursive: true, force: true })
        await fs.rename(temporary, manifestPath)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
      repaired += 1
    } catch {
      skipped += 1
    }
  }
  return { repaired, skipped }
}

export async function snapshotStorageInfo(projectPath: string): Promise<SnapshotStorageInfo> {
  const root = path.join(projectPath, '.modmind', 'snapshots')
  const directories = await fs.readdir(root, { withFileTypes: true }).catch(missingDirectoryIsEmpty)
  const pending = directories.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(root, entry.name))
  const snapshotCount = pending.length
  const identities = new Set<string>()
  let logicalBytes = 0
  let uniqueBytes = 0
  let fileCount = 0
  let incomplete = false

  while (pending.length && !incomplete) {
    const directory = pending.pop()!
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { incomplete = true; return [] }
      throw error
    })
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) { pending.push(absolute); continue }
      if (entry.isFile()) files.push(absolute)
    }
    for (let offset = 0; offset < files.length; offset += 32) {
      const batch = files.slice(offset, offset + 32)
      const stats = await Promise.all(batch.map(file => fs.stat(file, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
      })))
      for (let index = 0; index < batch.length; index += 1) {
        if (++fileCount > MAX_SCANNED_FILES) { incomplete = true; break }
        const stat = stats[index]
        if (!stat?.isFile()) { incomplete = true; continue }
        const size = Number(stat.size)
        logicalBytes += size
        const identity = stat.ino === 0n ? `${batch[index]}:${fileCount}` : `${stat.dev}:${stat.ino}`
        if (!identities.has(identity)) {
          identities.add(identity)
          uniqueBytes += size
        }
      }
      if (incomplete && fileCount > MAX_SCANNED_FILES) break
    }
  }
  return {
    projectPath,
    snapshotCount,
    logicalBytes,
    uniqueBytes,
    incomplete,
    warning: incomplete || logicalBytes >= SNAPSHOT_WARNING_BYTES || uniqueBytes >= SNAPSHOT_WARNING_BYTES
  }
}
