import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { diagnosticJournal } from './diagnosticLog'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export async function diagnosticFileFingerprint(file: string, maxBytes = 8 * 1024 * 1024): Promise<{ bytes: number; sha256?: string; incomplete?: boolean }> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size > maxBytes) return { bytes: stat.size, incomplete: true }
    const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size)), hash = createHash('sha256')
    let offset = 0
    while (offset < stat.size) { const read = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset); if (!read.bytesRead) break; hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead }
    return { bytes: stat.size, sha256: hash.digest('hex'), incomplete: offset !== stat.size || (await handle.stat()).size !== stat.size }
  } finally { await handle.close() }
}
export async function verifiedDiagnosticWrite(projectPath: string, relativePath: string, target: string, content: string): Promise<void> {
  const before = await diagnosticFileFingerprint(target).catch(error => ({ unavailable: String(error).slice(0, 500) }))
  const expected = digest(content)
  await fs.writeFile(target, content, 'utf8')
  const after = await diagnosticFileFingerprint(target, Math.max(8 * 1024 * 1024, Buffer.byteLength(content, 'utf8')))
  const actual = after.incomplete ? undefined : after.sha256
  diagnosticJournal.recordCritical({ subsystem: 'files', operation: 'verified-write', phase: expected === actual ? 'verified' : 'mismatch', level: expected === actual ? 'info' : 'error', message: expected === actual ? 'Saved file read-back matches the submitted content' : 'Saved file changed before read-back completed', data: { projectPath, relativePath, before, expectedSha256: expected, actualSha256: actual, bytes: after.bytes } })
  if (expected !== actual) throw new Error(`文件保存后核验不一致，可能已被其他操作修改：${relativePath}`)
}
