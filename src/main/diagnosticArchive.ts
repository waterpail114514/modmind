import { promises as fs } from 'node:fs'
import path from 'node:path'
import { redactDiagnosticText } from './diagnosticLog'

export interface DiagnosticArchiveEntry {
  name: string
  data: Buffer
}

export interface DiagnosticCollectionItem {
  archiveName: string
  status: 'collected' | 'missing' | 'skipped' | 'error'
  size?: number
  modifiedAt?: string
  reason?: string
  capturedAt?: string
  startOffset?: number
  endOffset?: number
  truncated?: boolean
}

interface DiagnosticArchiveCollectorOptions {
  maxFileBytes?: number
  maxTotalBytes?: number
  maxFiles?: number
}

interface AddDirectoryOptions {
  include?: (relativePath: string) => boolean
  includePartialMetadata?: boolean
}

export interface DiagnosticDirectorySummary {
  exists: boolean
  files: number
  directories: number
  bytes: number
  newestModifiedAt?: string
  partialFiles: Array<{ path: string; size: number; modifiedAt: string }>
  truncated: boolean
  error?: string
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 160 * 1024 * 1024
const DEFAULT_MAX_FILES = 2_000

export async function summarizeDiagnosticDirectory(root: string, maxEntries = 50_000): Promise<DiagnosticDirectorySummary> {
  const summary: DiagnosticDirectorySummary = { exists: false, files: 0, directories: 0, bytes: 0, partialFiles: [], truncated: false }
  const queue: Array<{ directory: string; relative: string }> = [{ directory: root, relative: '' }]
  let visited = 0
  try {
    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory()) return { ...summary, error: 'path is not a directory' }
    summary.exists = true
    while (queue.length && visited < maxEntries) {
      const current = queue.shift()!
      const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch((error) => {
        summary.error = redactDiagnosticText(`Unable to read ${current.relative || '.'}: ${String(error)}`)
        return []
      })
      for (const entry of entries) {
        visited += 1
        if (visited > maxEntries) break
        if (entry.isSymbolicLink()) continue
        const relative = path.posix.join(current.relative, entry.name)
        const target = path.join(current.directory, entry.name)
        if (entry.isDirectory()) {
          summary.directories += 1
          queue.push({ directory: target, relative })
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.stat(target).catch((error) => {
          summary.error = redactDiagnosticText(`Unable to stat ${relative}: ${String(error)}`)
          return null
        })
        if (!stat) continue
        summary.files += 1
        summary.bytes += stat.size
        if (!summary.newestModifiedAt || stat.mtime.toISOString() > summary.newestModifiedAt) summary.newestModifiedAt = stat.mtime.toISOString()
        if ((/\.partial(?:-|$)/i.test(entry.name) || entry.name.endsWith('.download')) && summary.partialFiles.length < 100) {
          summary.partialFiles.push({ path: relative, size: stat.size, modifiedAt: stat.mtime.toISOString() })
        }
      }
    }
    summary.truncated = Boolean(queue.length || visited >= maxEntries)
    return summary
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
    return { ...summary, error: code === 'ENOENT' ? 'directory does not exist' : redactDiagnosticText(error instanceof Error ? error.message : String(error)) }
  }
}

function isBinaryDiagnostic(filePath: string, archiveName: string): boolean {
  return /\.(?:gz|dmp)$/i.test(filePath) || /\.(?:gz|dmp)$/i.test(archiveName)
}

function looksLikeUnknownBinary(data: Buffer): boolean {
  const sample = data.subarray(0, Math.min(data.byteLength, 8 * 1024))
  if (sample.includes(0)) return true
  let controlBytes = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) controlBytes += 1
  }
  return sample.byteLength > 0 && controlBytes / sample.byteLength > 0.1
}

function archivePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid diagnostic archive path: ${value}`)
  return normalized
}

async function readFileSnapshot(filePath: string, maxBytes: number, binary: boolean): Promise<{ data: Buffer; truncated: boolean; originalSize: number; startOffset: number; endOffset: number; capturedAt: string }> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const capturedAt = new Date().toISOString()
    if (binary && stat.size > maxBytes) throw new Error(`binary file exceeds ${maxBytes} bytes`)
    const length = Math.min(maxBytes, stat.size)
    let startOffset = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, startOffset + bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    let data = buffer.subarray(0, bytesRead)
    let endOffset = startOffset + bytesRead
    if (!binary && startOffset > 0) {
      const before = Buffer.alloc(1)
      await handle.read(before, 0, 1, startOffset - 1)
      if (before[0] !== 10) {
        const newline = data.indexOf(10)
        const skip = newline < 0 ? data.length : newline + 1
        data = data.subarray(skip)
        startOffset += skip
      }
    }
    if (!binary && /\.jsonl$/i.test(filePath) && data.length && data[data.length - 1] !== 10) {
      // A writer may still be appending the final record; export complete records only.
      const lastNewline = data.lastIndexOf(10)
      data = data.subarray(0, lastNewline + 1)
      endOffset = startOffset + data.length
    }
    return { data, truncated: startOffset > 0 || endOffset < stat.size, originalSize: stat.size, startOffset, endOffset, capturedAt }
  } finally {
    await handle.close()
  }
}

export class DiagnosticArchiveCollector {
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly maxFiles: number
  private readonly archiveEntries: DiagnosticArchiveEntry[] = []
  private readonly names = new Set<string>()
  private readonly collectionItems: DiagnosticCollectionItem[] = []
  private totalBytes = 0
  private readonly collectionStartedAt = new Date().toISOString()

  constructor(options: DiagnosticArchiveCollectorOptions = {}) {
    this.maxFileBytes = Math.max(64 * 1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    this.maxTotalBytes = Math.max(this.maxFileBytes, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)
    this.maxFiles = Math.max(10, options.maxFiles ?? DEFAULT_MAX_FILES)
  }

  addBuffer(name: string, data: Buffer, redact = false): void {
    const safeName = archivePath(name)
    if (this.names.has(safeName)) {
      this.collectionItems.push({ archiveName: safeName, status: 'skipped', reason: 'duplicate archive name' })
      return
    }
    const output = redact ? Buffer.from(redactDiagnosticText(data.toString('utf8')), 'utf8') : data
    if (!this.canAdd(safeName, output.byteLength)) return
    this.names.add(safeName)
    this.archiveEntries.push({ name: safeName, data: output })
    this.totalBytes += output.byteLength
    this.collectionItems.push({ archiveName: safeName, status: 'collected', size: output.byteLength })
  }

  addJson(name: string, value: unknown): void {
    this.addBuffer(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), true)
  }

  async addFile(filePath: string, name: string): Promise<void> {
    const safeName = archivePath(name)
    if (this.names.has(safeName)) {
      this.collectionItems.push({ archiveName: safeName, status: 'skipped', reason: 'duplicate archive name' })
      return
    }
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
      this.collectionItems.push({ archiveName: safeName, status: code === 'ENOENT' ? 'missing' : 'error', reason: code === 'ENOENT' ? 'file does not exist' : redactDiagnosticText(error instanceof Error ? error.message : String(error)) })
      return
    }
    if (!stat.isFile()) {
      this.collectionItems.push({ archiveName: safeName, status: 'skipped', reason: 'not a regular file' })
      return
    }
    if (!stat.size) {
      this.collectionItems.push({ archiveName: safeName, status: 'skipped', size: 0, modifiedAt: stat.mtime.toISOString(), reason: 'empty file' })
      return
    }
    const binary = isBinaryDiagnostic(filePath, safeName)
    try {
      const snapshot = await readFileSnapshot(filePath, this.maxFileBytes, binary)
      if (!binary && looksLikeUnknownBinary(snapshot.data)) {
        this.collectionItems.push({ archiveName: safeName, status: 'skipped', size: snapshot.originalSize, modifiedAt: stat.mtime.toISOString(), reason: 'unknown binary content omitted' })
        return
      }
      const output = binary ? snapshot.data : Buffer.from(redactDiagnosticText(snapshot.data.toString('utf8')), 'utf8')
      if (!this.canAdd(safeName, output.byteLength)) return
      this.names.add(safeName)
      this.archiveEntries.push({ name: safeName, data: output })
      this.totalBytes += output.byteLength
      this.collectionItems.push({
        archiveName: safeName,
        status: 'collected',
        size: snapshot.originalSize,
        modifiedAt: stat.mtime.toISOString(),
        capturedAt: snapshot.capturedAt,
        startOffset: snapshot.startOffset,
        endOffset: snapshot.endOffset,
        truncated: snapshot.truncated,
        ...(snapshot.truncated ? { reason: `included complete records within ${this.maxFileBytes} bytes; omitted bytes are described by startOffset/endOffset` } : {})
      })
    } catch (error) {
      this.collectionItems.push({ archiveName: safeName, status: 'error', size: stat.size, modifiedAt: stat.mtime.toISOString(), reason: redactDiagnosticText(error instanceof Error ? error.message : String(error)) })
    }
  }

  async addDirectory(directory: string, prefix: string, options: AddDirectoryOptions = {}): Promise<void> {
    const queue: Array<{ directory: string; relative: string }> = [{ directory, relative: '' }]
    let rootSeen = false
    while (queue.length) {
      const current = queue.shift()!
      let children
      try {
        children = await fs.readdir(current.directory, { withFileTypes: true })
        rootSeen = true
      } catch (error) {
        {
          const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
          this.collectionItems.push({ archiveName: archivePath(path.posix.join(prefix, current.relative)), status: code === 'ENOENT' ? 'missing' : 'error', reason: code === 'ENOENT' ? 'directory does not exist' : redactDiagnosticText(error instanceof Error ? error.message : String(error)) })
        }
        continue
      }
      for (const child of children) {
        if (child.isSymbolicLink()) continue
        const relative = path.posix.join(current.relative, child.name)
        const childPath = path.join(current.directory, child.name)
        if (child.isDirectory()) {
          queue.push({ directory: childPath, relative })
          continue
        }
        if (!child.isFile() || options.include?.(relative) === false) continue
        if (/\.partial(?:-|$)/i.test(child.name) || child.name.endsWith('.download')) {
          if (options.includePartialMetadata !== false) {
            const stat = await fs.stat(childPath).catch(() => null)
            this.collectionItems.push({ archiveName: archivePath(path.posix.join(prefix, relative)), status: 'skipped', ...(stat ? { size: stat.size, modifiedAt: stat.mtime.toISOString() } : {}), reason: 'partial download content omitted; metadata retained' })
          }
          continue
        }
        await this.addFile(childPath, path.posix.join(prefix, relative))
      }
    }
    if (!rootSeen && !this.collectionItems.some((item) => item.archiveName === archivePath(prefix))) {
      this.collectionItems.push({ archiveName: archivePath(prefix), status: 'missing', reason: 'directory does not exist' })
    }
  }

  finalize(metadata: Record<string, unknown> = {}): DiagnosticArchiveEntry[] {
    const report = {
      generatedAt: new Date().toISOString(),
      collectionStartedAt: this.collectionStartedAt,
      consistency: 'per-file snapshots; timestamps may differ; offsets refer to source bytes before redaction',
      limits: { maxFileBytes: this.maxFileBytes, maxTotalBytes: this.maxTotalBytes, maxFiles: this.maxFiles },
      totals: {
        collected: this.collectionItems.filter((item) => item.status === 'collected').length,
        missing: this.collectionItems.filter((item) => item.status === 'missing').length,
        skipped: this.collectionItems.filter((item) => item.status === 'skipped').length,
        errors: this.collectionItems.filter((item) => item.status === 'error').length,
        archiveBytes: this.totalBytes
      },
      ...metadata,
      items: this.collectionItems
    }
    const reportData = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    if (!this.names.has('collection-report.json')) {
      this.names.add('collection-report.json')
      this.archiveEntries.push({ name: 'collection-report.json', data: reportData })
    }
    return [...this.archiveEntries].sort((left, right) => left.name.localeCompare(right.name))
  }

  private canAdd(name: string, bytes: number): boolean {
    if (this.archiveEntries.length >= this.maxFiles) {
      this.collectionItems.push({ archiveName: name, status: 'skipped', size: bytes, reason: 'archive file-count limit reached' })
      return false
    }
    if (this.totalBytes + bytes > this.maxTotalBytes) {
      this.collectionItems.push({ archiveName: name, status: 'skipped', size: bytes, reason: 'archive byte limit reached' })
      return false
    }
    return true
  }
}
