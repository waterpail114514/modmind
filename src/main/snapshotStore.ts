import { createReadStream, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SnapshotInfo } from '../shared/types'

export interface SnapshotCopyBaseline {
  root: string
  hashes: Record<string, string>
  metadata?: Record<string, SnapshotFileMetadata>
}

export interface SnapshotCopyResult {
  fileCount: number
  hashes: Record<string, string>
  metadata: Record<string, SnapshotFileMetadata>
}

export interface SnapshotFileMetadata {
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256: string
}

export async function snapshotFileHash(filePath: string): Promise<{ size: number; sha256: string }> {
  const stat = await fs.stat(filePath)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return { size: stat.size, sha256: hash.digest('hex') }
}

function managedDestination(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...relative.split('/'))
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Invalid snapshot path: ${relative}`)
  return target
}

/**
 * Copies a project tree into a new snapshot while reusing unchanged files from
 * the previous snapshot. Snapshot files are hard-linked only to the previous
 * snapshot, never to the live project, so later project edits cannot mutate a
 * snapshot. The copy fallback keeps this working across volumes/filesystems
 * that do not support hard links.
 */
export async function copySnapshotFilesIncremental(
  sourceRoot: string,
  destinationRoot: string,
  ignoreDirectory: (name: string) => boolean,
  baseline?: SnapshotCopyBaseline
): Promise<SnapshotCopyResult> {
  const hashes: Record<string, string> = {}
  const metadata: Record<string, SnapshotFileMetadata> = {}
  let fileCount = 0

  const visit = async (sourceDirectory: string, relativeDirectory = ''): Promise<void> => {
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignoreDirectory(entry.name)) continue
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const source = path.join(sourceDirectory, entry.name)
      const destination = managedDestination(destinationRoot, relative)
      if (entry.isDirectory()) {
        await fs.mkdir(destination, { recursive: true })
        await visit(source, relative)
        continue
      }
      if (!entry.isFile()) continue

      const sourceStat = await fs.stat(source)
      const baselineMetadata = baseline?.metadata?.[relative]
      const unchangedByMetadata = Boolean(
        baselineMetadata
        && baselineMetadata.size === sourceStat.size
        && baselineMetadata.mtimeMs === sourceStat.mtimeMs
        && baselineMetadata.ctimeMs === sourceStat.ctimeMs
        && /^[a-f0-9]{64}$/i.test(baselineMetadata.sha256)
      )
      const sourceInfo = unchangedByMetadata
        ? { size: sourceStat.size, sha256: baselineMetadata!.sha256 }
        : await snapshotFileHash(source)
      hashes[relative] = sourceInfo.sha256
      metadata[relative] = { size: sourceInfo.size, mtimeMs: sourceStat.mtimeMs, ctimeMs: sourceStat.ctimeMs, sha256: sourceInfo.sha256 }
      const baselineHash = baseline?.hashes[relative]
      const baselineFile = baseline && baselineHash === sourceInfo.sha256
        ? managedDestination(baseline.root, relative)
        : ''
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const baselineValid = baselineFile && await fs.lstat(baselineFile)
        .then(async stat => stat.isFile() && !stat.isSymbolicLink() && stat.size === sourceInfo.size
          && (await snapshotFileHash(baselineFile)).sha256 === sourceInfo.sha256).catch(() => false)
      if (baselineValid) {
        try {
          await fs.link(baselineFile, destination)
        } catch {
          await fs.copyFile(baselineFile, destination)
        }
      } else {
        await fs.copyFile(source, destination)
      }
      fileCount += 1
    }
  }

  await fs.mkdir(destinationRoot, { recursive: true })
  await visit(sourceRoot)
  return { fileCount, hashes, metadata }
}

type SnapshotCatalogEntry = { signature: string; info: SnapshotInfo | null; legacyCache: boolean }
type SnapshotCatalog = { rootSignature: string; checkedAt: number; entries: Record<string, SnapshotCatalogEntry>; sorted: SnapshotInfo[]; bytes: number; stale?: boolean }
const snapshotCatalogs = new Map<string, SnapshotCatalog>()
const snapshotCatalogJobs = new Map<string, Promise<SnapshotCatalog>>()
const snapshotCatalogInvalidations = new Map<string, Set<string>>()
const CATALOG_RECHECK_MS = 5_000
const CATALOG_BUDGET_BYTES = 16 * 1024 * 1024

function catalogKey(projectPath: string): string {
  const root = path.resolve(projectPath)
  return process.platform === 'win32' ? root.toLowerCase() : root
}

async function catalogSignature(target: string): Promise<string> {
  const stat = await fs.lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  return !stat || stat.isSymbolicLink() ? '' : `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

async function readCatalogEntry(projectPath: string, id: string, signature: string): Promise<SnapshotCatalogEntry> {
  const manifest = signature ? await fs.readFile(path.join(projectPath, '.modmind', 'snapshots', id, 'snapshot.json'), 'utf8')
    .then(value => JSON.parse(value) as Record<string, unknown>).catch(() => null) : null
  const valid = manifest?.id === id && typeof manifest.label === 'string' && typeof manifest.createdAt === 'string'
    && typeof manifest.fileCount === 'number' && Number.isSafeInteger(manifest.fileCount) && manifest.fileCount >= 0
  return {
    signature,
    info: valid ? { id, label: manifest!.label as string, createdAt: manifest!.createdAt as string, fileCount: manifest!.fileCount as number } : null,
    legacyCache: Boolean(manifest?.id === id && Array.isArray(manifest.files) && manifest.files.some(file => typeof file === 'string' && file.split('/').includes('.gradle-cloud-storage-test')))
  }
}

async function saveCatalog(projectPath: string, catalog: SnapshotCatalog): Promise<void> {
  const target = path.join(projectPath, '.modmind', 'snapshot-index.json')
  const temporary = `${target}.${randomUUID()}.tmp`
  const content = JSON.stringify({ version: 1, projectPath: path.resolve(projectPath), entries: catalog.entries })
  catalog.bytes = Buffer.byteLength(content)
  // This is a rebuildable accelerator. Failure to persist it cannot invalidate a backup.
  if (catalog.bytes <= CATALOG_BUDGET_BYTES) {
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(temporary, content, { flag: 'wx' })
      await fs.rename(temporary, target)
    } catch { /* read-only projects can still list their backups */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }
}

async function readSnapshotCatalog(projectPath: string): Promise<SnapshotCatalog> {
  const key = catalogKey(projectPath)
  const running = snapshotCatalogJobs.get(key)
  if (running) {
    const catalog = await running
    return catalog.stale ? readSnapshotCatalog(projectPath) : catalog
  }
  const job = (async () => {
    const root = path.join(projectPath, '.modmind', 'snapshots')
    const rootSignature = await catalogSignature(root)
    let previous = snapshotCatalogs.get(key)
    if (previous && !previous.stale && previous.rootSignature === rootSignature && Date.now() - previous.checkedAt < CATALOG_RECHECK_MS) {
      snapshotCatalogs.delete(key); snapshotCatalogs.set(key, previous)
      return previous
    }
    if (!previous) {
      const stored = await fs.readFile(path.join(projectPath, '.modmind', 'snapshot-index.json'), 'utf8')
        .then(value => JSON.parse(value) as Record<string, unknown>).catch(() => null)
      if (stored?.version === 1 && stored.projectPath === path.resolve(projectPath) && stored.entries && typeof stored.entries === 'object') {
        previous = { rootSignature: '', checkedAt: 0, entries: stored.entries as Record<string, SnapshotCatalogEntry>, sorted: [], bytes: 0 }
      }
    }
    const directories = rootSignature ? await fs.readdir(root, { withFileTypes: true }) : []
    const verifyExisting = !previous || Date.now() - previous.checkedAt >= CATALOG_RECHECK_MS
    const ids = directories.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9A-Za-z._-]{1,120}$/.test(entry.name)).map(entry => entry.name)
    const entries: Record<string, SnapshotCatalogEntry> = Object.create(null)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(16, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]
        const old = previous?.entries[id]
        if (old && !verifyExisting) { entries[id] = old; continue }
        const signature = await catalogSignature(path.join(root, id, 'snapshot.json'))
        // Validate cached summaries as well as the file signature; the index is not authoritative.
        entries[id] = old?.signature === signature && (!old.info || (old.info.id === id && typeof old.info.label === 'string' && typeof old.info.createdAt === 'string' && Number.isSafeInteger(old.info.fileCount)))
          ? old : await readCatalogEntry(projectPath, id, signature)
      }
    }))
    const catalog: SnapshotCatalog = {
      rootSignature, entries, checkedAt: verifyExisting ? Date.now() : previous!.checkedAt, bytes: 0,
      sorted: Object.values(entries).flatMap(entry => entry.info ? [entry.info] : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    }
    await saveCatalog(projectPath, catalog)
    const changedWhileReading = snapshotCatalogInvalidations.get(key)
    if (changedWhileReading?.size) {
      catalog.stale = true
      catalog.rootSignature = ''
      if (changedWhileReading.has('')) catalog.checkedAt = 0
      for (const id of changedWhileReading) if (id) delete catalog.entries[id]
    }
    snapshotCatalogInvalidations.delete(key)
    snapshotCatalogs.delete(key); snapshotCatalogs.set(key, catalog)
    let bytes = [...snapshotCatalogs.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [cachedKey, entry] of snapshotCatalogs) {
      if (bytes <= CATALOG_BUDGET_BYTES && snapshotCatalogs.size <= 8) break
      snapshotCatalogs.delete(cachedKey); bytes -= entry.bytes
    }
    return catalog
  })()
  snapshotCatalogJobs.set(key, job)
  let catalog: SnapshotCatalog
  try { catalog = await job } finally { if (snapshotCatalogJobs.get(key) === job) snapshotCatalogJobs.delete(key) }
  return catalog.stale ? readSnapshotCatalog(projectPath) : catalog
}

/** List summaries only; complete manifests remain on disk until selected. */
export async function listSnapshotSummaries(projectPath: string): Promise<SnapshotInfo[]> {
  return (await readSnapshotCatalog(projectPath)).sorted.map(info => ({ ...info }))
}

export async function legacySnapshotCacheIds(projectPath: string): Promise<string[]> {
  return Object.entries((await readSnapshotCatalog(projectPath)).entries).filter(([, entry]) => entry.legacyCache).map(([id]) => id)
}

/** Invalidate a changed manifest without discarding all other summaries. */
export function invalidateSnapshotCatalog(projectPath: string, id?: string): void {
  const key = catalogKey(projectPath)
  if (snapshotCatalogJobs.has(key)) {
    const pending = snapshotCatalogInvalidations.get(key) ?? new Set<string>()
    pending.add(id ?? '')
    snapshotCatalogInvalidations.set(key, pending)
  }
  const catalog = snapshotCatalogs.get(key)
  if (!catalog) return
  if (id) delete catalog.entries[id]
  else for (const entry of Object.values(catalog.entries)) entry.signature = ''
  catalog.rootSignature = ''
  if (!id) catalog.checkedAt = 0
}
