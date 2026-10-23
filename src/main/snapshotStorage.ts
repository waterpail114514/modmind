import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SnapshotStorageInfo } from '../shared/types'
import { invalidateSnapshotCatalog, legacySnapshotCacheIds } from './snapshotStore'

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
  const candidates = new Set(await legacySnapshotCacheIds(projectPath))
  let repaired = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !candidates.has(entry.name)) continue
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
      invalidateSnapshotCatalog(projectPath, entry.name)
      invalidateSnapshotStorage(projectPath, entry.name)
    } catch {
      skipped += 1
    }
  }
  return { repaired, skipped }
}

type StorageFile = { identity: string; size: number }
type StorageCache = {
  rootSignature: string; checkedAt: number; snapshots: Map<string, StorageFile[]> | null
  result: SnapshotStorageInfo; bytes: number; dirty: Set<string>
}
const storageCaches = new Map<string, StorageCache>()
const storageJobs = new Map<string, Promise<SnapshotStorageInfo>>()
const storageInvalidations = new Map<string, Set<string>>()
const STORAGE_RECHECK_MS = 60_000
const STORAGE_CACHE_BYTES = 16 * 1024 * 1024

function storageKey(projectPath: string): string {
  const root = path.resolve(projectPath)
  return process.platform === 'win32' ? root.toLowerCase() : root
}

/** Background notifications may refresh a hot estimate, but never start a cold full scan. */
export function canRefreshSnapshotStorageIncrementally(projectPath: string): boolean {
  const cached = storageCaches.get(storageKey(projectPath))
  return Boolean(cached && Date.now() - cached.checkedAt < STORAGE_RECHECK_MS && cached.snapshots)
}

/** Known application writes refresh only the changed snapshot, including inode references. */
export function invalidateSnapshotStorage(projectPath: string, id?: string): void {
  const key = storageKey(projectPath)
  if (storageJobs.has(key)) {
    const pending = storageInvalidations.get(key) ?? new Set<string>()
    pending.add(id ?? '')
    storageInvalidations.set(key, pending)
  }
  const cached = storageCaches.get(key)
  if (!cached) return
  cached.rootSignature = ''
  if (id && cached.snapshots) cached.dirty.add(id)
  else cached.checkedAt = 0
}

/** Merged, bounded and incremental disk estimate. Out-of-process edits expire within one minute. */
export async function snapshotStorageInfo(projectPath: string): Promise<SnapshotStorageInfo> {
  const key = storageKey(projectPath)
  const running = storageJobs.get(key)
  if (running) { await running; return snapshotStorageInfo(projectPath) }
  const job = (async () => {
    const root = path.join(projectPath, '.modmind', 'snapshots')
    const rootStat = await fs.lstat(root).catch(missingFileIsNull)
    const rootSignature = !rootStat || rootStat.isSymbolicLink() ? '' : `${rootStat.ino}:${rootStat.mtimeMs}:${rootStat.ctimeMs}`
    const previous = storageCaches.get(key)
    const fresh = previous && Date.now() - previous.checkedAt < STORAGE_RECHECK_MS
    if (fresh && previous.rootSignature === rootSignature && !previous.dirty.size) {
      storageCaches.delete(key); storageCaches.set(key, previous)
      return { ...previous.result, projectPath }
    }
    const directories = rootStat && !rootStat.isSymbolicLink() ? await fs.readdir(root, { withFileTypes: true }).catch(missingDirectoryIsEmpty) : []
    const ids = directories.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name)
    const snapshots = fresh && previous.snapshots ? new Map(previous.snapshots) : new Map<string, StorageFile[]>()
    const present = new Set(ids)
    for (const id of snapshots.keys()) if (!present.has(id) || previous?.dirty.has(id)) snapshots.delete(id)
    previous?.dirty.clear()
    const missing = ids.filter(id => !snapshots.has(id))
    let cursor = 0, scannedFiles = 0, incomplete = false, bytes = 0
    for (const files of snapshots.values()) scannedFiles += files.length
    await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
      while (cursor < missing.length && scannedFiles < MAX_SCANNED_FILES) {
        const id = missing[cursor++]
        const pending = [path.join(root, id)]
        const files: StorageFile[] = []
        while (pending.length && scannedFiles < MAX_SCANNED_FILES) {
          const directory = pending.pop()!
          const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { incomplete = true; return [] }
            throw error
          })
          const paths: string[] = []
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue
            const target = path.join(directory, entry.name)
            if (entry.isDirectory()) pending.push(target)
            else if (entry.isFile()) paths.push(target)
          }
          for (let offset = 0; offset < paths.length && scannedFiles < MAX_SCANNED_FILES; offset += 4) {
            const batch = paths.slice(offset, offset + Math.min(4, MAX_SCANNED_FILES - scannedFiles))
            scannedFiles += batch.length
            const stats = await Promise.all(batch.map(target => fs.lstat(target, { bigint: true }).catch(error => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
              throw error
            })))
            for (let index = 0; index < batch.length; index += 1) {
              const stat = stats[index]
              if (!stat?.isFile()) { incomplete = true; continue }
              files.push({ identity: stat.ino === 0n ? batch[index] : `${stat.dev}:${stat.ino}`, size: Number(stat.size) })
            }
            await new Promise<void>(resolve => setImmediate(resolve))
          }
        }
        snapshots.set(id, files)
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }))
    if (scannedFiles >= MAX_SCANNED_FILES) incomplete = true
    const identities = new Map<string, number>()
    let logicalBytes = 0, uniqueBytes = 0
    for (const [id, files] of snapshots) {
      bytes += id.length * 2 + 64
      for (const file of files) {
        logicalBytes += file.size
        bytes += file.identity.length * 2 + 40
        const counted = identities.get(file.identity)
        if (counted === undefined) { identities.set(file.identity, file.size); uniqueBytes += file.size }
        else if (counted !== file.size) { incomplete = true; uniqueBytes += Math.max(0, file.size - counted); identities.set(file.identity, Math.max(file.size, counted)) }
      }
    }
    const result: SnapshotStorageInfo = {
      projectPath, snapshotCount: ids.length, logicalBytes, uniqueBytes, incomplete,
      warning: incomplete || logicalBytes >= SNAPSHOT_WARNING_BYTES || uniqueBytes >= SNAPSHOT_WARNING_BYTES
    }
    const dirty = previous?.dirty ?? new Set<string>()
    const changedWhileReading = storageInvalidations.get(key)
    for (const id of changedWhileReading ?? []) dirty.add(id)
    storageInvalidations.delete(key)
    const cached: StorageCache = { rootSignature: dirty.size ? '' : rootSignature, checkedAt: incomplete ? 0 : fresh ? previous.checkedAt : Date.now(), snapshots: bytes <= STORAGE_CACHE_BYTES ? snapshots : null, result, bytes: bytes <= STORAGE_CACHE_BYTES ? bytes : 256, dirty }
    if (dirty.has('')) { cached.checkedAt = 0; dirty.delete('') }
    storageCaches.delete(key); storageCaches.set(key, cached)
    let totalBytes = [...storageCaches.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [cachedKey, entry] of storageCaches) {
      if (totalBytes <= STORAGE_CACHE_BYTES && storageCaches.size <= 4) break
      storageCaches.delete(cachedKey); totalBytes -= entry.bytes
    }
    return { ...result }
  })()
  storageJobs.set(key, job)
  let result: SnapshotStorageInfo
  try { result = await job } finally { if (storageJobs.get(key) === job) storageJobs.delete(key) }
  return storageCaches.get(key)?.dirty.size ? snapshotStorageInfo(projectPath) : result
}
