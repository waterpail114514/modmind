import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

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
