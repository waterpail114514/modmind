import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticArchiveCollector, summarizeDiagnosticDirectory } from './diagnosticArchive'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function reportFrom(entries: Array<{ name: string; data: Buffer }>): Record<string, unknown> {
  const report = entries.find((entry) => entry.name === 'collection-report.json')
  if (!report) throw new Error('collection report missing')
  return JSON.parse(report.data.toString('utf8')) as Record<string, unknown>
}

describe('DiagnosticArchiveCollector', () => {
  it('collects newly modified logs and reports missing and partial files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-archive-'))
    temporaryRoots.push(root)
    await fs.writeFile(path.join(root, 'active.log'), 'token=super-secret\nlatest line\n', 'utf8')
    await fs.writeFile(path.join(root, 'asset.partial-123'), 'partial bytes', 'utf8')
    await fs.writeFile(path.join(root, 'artifact.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]))
    const collector = new DiagnosticArchiveCollector()

    await collector.addDirectory(root, 'runtime')
    await collector.addFile(path.join(root, 'missing.log'), 'runtime/missing.log')
    const entries = collector.finalize()

    const active = entries.find((entry) => entry.name === 'runtime/active.log')
    expect(active?.data.toString('utf8')).toContain('latest line')
    expect(active?.data.toString('utf8')).not.toContain('super-secret')
    const report = reportFrom(entries) as { items: Array<Record<string, unknown>> }
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ archiveName: 'runtime/active.log', status: 'collected' }),
      expect.objectContaining({ archiveName: 'runtime/asset.partial-123', status: 'skipped', reason: expect.stringContaining('metadata retained') }),
      expect.objectContaining({ archiveName: 'runtime/artifact.jar', status: 'skipped', reason: expect.stringContaining('binary content omitted') }),
      expect.objectContaining({ archiveName: 'runtime/missing.log', status: 'missing' })
    ]))
  })

  it('keeps the tail of oversized text logs and summarizes runtime caches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-tail-'))
    temporaryRoots.push(root)
    const target = path.join(root, 'large.log')
    await fs.writeFile(target, `${'old-line\n'.repeat(10_000)}FINAL ROOT CAUSE\n`, 'utf8')
    const collector = new DiagnosticArchiveCollector({ maxFileBytes: 64 * 1024, maxTotalBytes: 2 * 1024 * 1024 })

    await collector.addFile(target, 'logs/large.log')
    const entries = collector.finalize()
    const log = entries.find((entry) => entry.name === 'logs/large.log')?.data.toString('utf8') ?? ''
    expect(log).not.toContain('[TRUNCATED')
    expect(reportFrom(entries)).toMatchObject({ items: [expect.objectContaining({ truncated: true, startOffset: expect.any(Number) })] })
    expect(log).toContain('FINAL ROOT CAUSE')

    const summary = await summarizeDiagnosticDirectory(root)
    expect(summary).toMatchObject({ exists: true, files: 1, truncated: false })
    expect(summary.bytes).toBeGreaterThan(64 * 1024)
  })

  it('exports complete UTF-8 JSONL records and reports the exact retained source range', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-jsonl-'))
    temporaryRoots.push(root)
    const target = path.join(root, 'events.jsonl')
    const content = Array.from({ length: 2000 }, (_, id) => JSON.stringify({ id, message: '诊断证据'.repeat(10) })).join('\n') + '\n{"partial":'
    await fs.writeFile(target, content)
    const collector = new DiagnosticArchiveCollector({ maxFileBytes: 64 * 1024 })
    await collector.addFile(target, 'events.jsonl')
    const entries = collector.finalize()
    const data = entries.find(entry => entry.name === 'events.jsonl')!.data
    const records = data.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({ id: 1999, message: '诊断证据'.repeat(10) })
    expect(data.byteLength).toBeLessThanOrEqual(64 * 1024)
    const report = reportFrom(entries) as { items: Array<{ startOffset: number; endOffset: number; truncated: boolean }> }
    const item = report.items[0]
    expect(item.truncated).toBe(true)
    expect(Buffer.from(content).subarray(item.startOffset, item.endOffset)).toEqual(data)
  })
})
