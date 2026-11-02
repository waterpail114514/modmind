import { createWriteStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { DiagnosticArchiveCollector, type DiagnosticArchiveEntry } from './diagnosticArchive'
import type { DiagnosticAttachment, DiagnosticExportOptions } from '../shared/diagnostics'

/** Stream the ZIP to an atomic staging file; do not allocate a second full archive in memory. */
export async function writeDiagnosticArchive(target: string, entries: DiagnosticArchiveEntry[]): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  const archive = new ZipFile()
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
  const writing = pipeline(archive.outputStream, output)
  try {
    for (const entry of entries) archive.addBuffer(entry.data, entry.name)
    archive.end()
    await writing
    await fs.rename(temporary, target)
  } catch (error) {
    output.destroy()
    await writing.catch(() => undefined)
    throw error
  } finally { output.destroy(); await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

export function diagnosticExportOptions(input: unknown): DiagnosticExportOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const value = input as Record<string, unknown>
  return {
    description: typeof value.description === 'string' ? value.description.slice(0, 8000) : '',
    occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt.slice(0, 100) : '',
    includeProjectFiles: value.includeProjectFiles === true, includeScreenshot: value.includeScreenshot === true, includeCrashDumps: value.includeCrashDumps === true,
    attachmentIds: Array.isArray(value.attachmentIds) ? value.attachmentIds.filter((id): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)).slice(0, 12) : []
  }
}

/** Paths can only be registered by the native picker, never supplied by renderer/MCP input. */
export class DiagnosticAttachments {
  private files = new Map<string, { path: string; owner: number; expires: number; name: string; bytes: number; mtimeMs: number; ino: number; dev: number }>()
  async register(owner: number, files: string[]): Promise<DiagnosticAttachment[]> {
    for (const [id, file] of this.files) if (file.expires < Date.now()) this.files.delete(id)
    const result: DiagnosticAttachment[] = []
    for (const file of files.slice(0, 12)) {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('诊断附件须为不超过 32 MiB 的普通文件')
      if (this.files.size >= 100) throw new Error('诊断附件列表已满，请重新打开应用后重试')
      const id = randomUUID(), name = path.basename(file)
      this.files.set(id, { path: file, name, bytes: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, owner, expires: Date.now() + 30 * 60_000 })
      result.push({ id, name, bytes: stat.size })
    }
    return result
  }
  async collect(collector: DiagnosticArchiveCollector, owner: number, ids: string[]): Promise<void> {
    for (const [index, id] of ids.entries()) {
      const file = this.files.get(id)
      if (!file || file.owner !== owner || file.expires < Date.now()) throw new Error('诊断附件已过期或不属于当前窗口，请重新选择')
      const stat = await fs.lstat(file.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs || stat.ino !== file.ino || stat.dev !== file.dev) throw new Error('诊断附件已变化，请重新选择')
      // User-selected binary attachments are intentionally copied intact, with a bounded read.
      if (/\.(?:png|jpe?g|webp|pdf|zip|csv)$/i.test(file.name)) {
        const handle = await fs.open(file.path, 'r')
        try {
          const opened = await handle.stat()
          if (opened.ino !== file.ino || opened.dev !== file.dev || opened.size !== file.bytes || opened.mtimeMs !== file.mtimeMs) throw new Error('诊断附件已变化，请重新选择')
          const bytes = Buffer.alloc(file.bytes)
          let offset = 0
          while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
          if (offset !== file.bytes) throw new Error('诊断附件读取不完整')
          collector.addBuffer(`user-attachments/${index + 1}-${file.name}`, bytes, /\.csv$/i.test(file.name))
        } finally { await handle.close() }
      } else await collector.addFile(file.path, `user-attachments/${index + 1}-${file.name}`)
    }
  }
}

export async function exportRecoveryDiagnostics(options: { logs: string; userData: string; target: string }): Promise<string> {
  if (!path.isAbsolute(options.target) || !options.target.toLowerCase().endsWith('.zip')) throw new Error('恢复导出目标必须是 ZIP 的绝对路径')
  const collector = new DiagnosticArchiveCollector()
  await collector.addDirectory(options.logs, 'app-logs', { include: file => /\.(?:log|json|jsonl)$/i.test(file), maxEntries: 2000 })
  collector.addJson('recovery-export.json', { time: new Date().toISOString(), mode: 'without-main-window', userData: options.userData, note: '仅采集既有日志；没有创建新的应用会话标记或启动用户任务。' })
  await writeDiagnosticArchive(options.target, collector.finalize())
  return options.target
}
