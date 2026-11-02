import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { diagnosticJournal } from './diagnosticLog'
import { diagnosticValue } from './diagnosticContext'

/** A failed replacement must leave the previous file in place. Never unlink it to retry. */
export async function writeSettingsFile(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    const content = JSON.stringify(value, null, 2)
    const expected = Buffer.from(content, 'utf8')
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, target)
    const handle = await fs.open(target, 'r')
    try {
      const actual = Buffer.alloc(expected.length)
      let offset = 0
      while (offset < actual.length) { const read = await handle.read(actual, offset, actual.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
      if ((await handle.stat()).size !== expected.length || offset !== expected.length || !expected.equals(actual)) throw new Error('设置写入后回读不一致，请重试保存')
      diagnosticJournal.recordCritical({ subsystem: 'settings', operation: 'verified-write', phase: 'verified', message: 'Settings persisted and read back', data: { path: target, sha256: createHash('sha256').update(actual).digest('hex'), bytes: actual.length, settings: diagnosticValue(value) } })
    } finally { await handle.close() }
  } catch (error) {
    diagnosticJournal.record({ subsystem: 'settings', operation: 'verified-write', phase: 'error', level: 'error', message: 'Settings persistence failed', data: { path: target }, error })
    throw error
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}
