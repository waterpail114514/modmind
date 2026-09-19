import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticJournal, redactDiagnosticText } from './diagnosticLog'
import { isExpectedCancellation } from '../shared/diagnostics'
import { DiagnosticArchiveCollector } from './diagnosticArchive'
import { describeClientFailure } from '../shared/clientFailure'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('DiagnosticJournal', () => {
  it('exports original error bodies and metadata while presenting a short error and redacting secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-error-export-'))
    temporaryRoots.push(root)
    const journal = new DiagnosticJournal()
    journal.configure(root)
    const originalBody = JSON.stringify({ error: { code: 'invalid_request_error', message: 'Unsupported field tools[0].strict', param: 'tools[0].strict' }, request_id: 'req-original-123', api_key: 'private-value' })
    const error = Object.assign(new Error(`HTTP 400 Bad Request: ${originalBody}`, { cause: { message: 'provider rejected payload', request_id: 'req-original-123' } }), { status: 400, responseBody: originalBody, headers: { 'x-request-id': 'req-original-123', authorization: 'Bearer secret-value' } })
    journal.record({ subsystem: 'ipc', operation: 'test', level: 'error', message: 'Request failed', error })
    expect(describeClientFailure(error)).toBe('请求未被接受，请检查配置或稍后重试。')
    await journal.flush()
    const archive = new DiagnosticArchiveCollector()
    await archive.addDirectory(root, 'app-logs')
    const entries = archive.finalize()
    for (const file of ['diagnostic-events.jsonl', 'diagnostic-critical.jsonl']) {
      const text = entries.find(entry => entry.name === `app-logs/${file}`)!.data.toString('utf8')
      const record = JSON.parse(text.trim())
      expect(record.error.message).toContain('Unsupported field tools[0].strict')
      expect(record.error.details).toMatchObject({ status: 400, headers: { 'x-request-id': 'req-original-123' } })
      expect(record.error.details.responseBody).toContain('invalid_request_error')
      expect(record.error.cause.message).toBe('provider rejected payload')
      expect(text).not.toContain('private-value')
      expect(text).not.toContain('secret-value')
    }
  })
  it('distinguishes expected cancellation from operational failures', () => {
    expect(isExpectedCancellation(Object.assign(new Error('request aborted'), { name: 'AbortError' }))).toBe(true)
    expect(isExpectedCancellation(new Error('外部代理任务已停止；已保留当前修改'))).toBe(true)
    expect(isExpectedCancellation(new Error('Gradle build daemon disappeared unexpectedly'))).toBe(false)
  })

  it('persists structured events with recursive secret redaction and error causes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-log-'))
    temporaryRoots.push(root)
    const journal = new DiagnosticJournal()
    journal.configure(root, () => ({ name: 'Test Project', loader: 'fabric', minecraftVersion: '1.21.1' }))
    const cause = new Error('request failed for https://example.test/file?token=very-secret-token')
    const error = new AggregateError([cause, new Error('mirror returned HTTP 502')], 'download failed', { cause })

    journal.record({
      subsystem: 'download',
      operation: 'test',
      phase: 'error',
      message: 'Authorization: Bearer hidden-bearer-value',
      data: { apiKey: 'hidden-api-key', nested: { password: 'hidden-password', safe: 'visible' } },
      error
    })
    await journal.flush()

    const content = await fs.readFile(path.join(root, 'diagnostic-events.jsonl'), 'utf8')
    expect(content).not.toContain('hidden-bearer-value')
    expect(content).not.toContain('hidden-api-key')
    expect(content).not.toContain('hidden-password')
    expect(content).not.toContain('very-secret-token')
    const event = JSON.parse(content.trim()) as Record<string, unknown>
    expect(event).toMatchObject({ subsystem: 'download', operation: 'test', phase: 'error' })
    expect(event.project).toMatchObject({ name: 'Test Project', loader: 'fabric' })
    expect(event.data).toMatchObject({ apiKey: '[REDACTED]', nested: { password: '[REDACTED]', safe: 'visible' } })
    expect(event.error).toMatchObject({ message: 'download failed', cause: { name: 'Error' }, errors: [{ name: 'Error' }, { message: 'mirror returned HTTP 502' }] })
    expect(journal.snapshot()).toHaveLength(1)
  })

  it('redacts credentials in headers, assignments, and URL queries', () => {
    const input = [
      'authorization=Basic abc',
      'cookie=session-secret',
      'token=xyz',
      'https://user:pass@x.test/a?api_key=123&code=456',
      'password="pw"',
      'sk-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz123456'
    ].join('\n')
    const output = redactDiagnosticText(input)
    expect(output).not.toContain('abc')
    expect(output).not.toContain('xyz')
    expect(output).not.toContain('123')
    expect(output).not.toContain('456')
    expect(output).not.toContain('"pw"')
    expect(output).not.toContain('sk-abcdefghijklmnop')
    expect(output).not.toContain('session-secret')
    expect(output).not.toContain('user:pass')
    expect(output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456')
  })

  it('writes critical events synchronously before process shutdown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-critical-'))
    temporaryRoots.push(root)
    const journal = new DiagnosticJournal()
    journal.configure(root)

    journal.recordCritical({ subsystem: 'process', operation: 'fatal', phase: 'error', message: 'fatal marker', error: new Error('boom') })

    const content = await fs.readFile(path.join(root, 'diagnostic-critical.jsonl'), 'utf8')
    expect(content).toContain('fatal marker')
    expect(content).toContain('boom')
  })

  it('keeps critical evidence through ordinary rotation and reports bounded queue loss', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-pressure-'))
    temporaryRoots.push(root)
    const journal = new DiagnosticJournal({ maxFileBytes: 256 * 1024, maxPendingBytes: 64 * 1024 })
    journal.configure(root)
    journal.recordCritical({ subsystem: 'app', operation: 'fatal', message: 'preserved evidence' })
    for (let batch = 0; batch < 15; batch += 1) {
      for (let i = 0; i < 10; i += 1) journal.record({ subsystem: 'noise', operation: 'output', message: 'x'.repeat(30_000) })
      expect(journal.status().pendingBytes).toBeLessThanOrEqual(64 * 1024)
      await journal.flush()
    }
    expect(journal.status()).toMatchObject({ pendingEvents: 0, pendingBytes: 0, writeFailures: 0 })
    expect(journal.status().droppedEvents).toBeGreaterThan(0)
    expect(journal.status().rotations).toBeGreaterThan(1)
    expect(await fs.readFile(path.join(root, 'diagnostic-critical.jsonl'), 'utf8')).toContain('preserved evidence')
  })

  it('retains write failure evidence after recovery', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-diagnostic-recovery-'))
    temporaryRoots.push(root)
    const directory = path.join(root, 'logs')
    await fs.writeFile(directory, 'not a directory')
    const journal = new DiagnosticJournal()
    journal.configure(directory)
    journal.record({ subsystem: 'app', operation: 'test', message: 'cannot persist' })
    await journal.flush()
    expect(journal.status().writeFailures).toBe(1)
    await fs.unlink(directory)
    journal.record({ subsystem: 'app', operation: 'test', message: 'recovered' })
    await journal.flush()
    expect(journal.status()).toMatchObject({ writeFailures: 1, lastWriteError: expect.any(String), lastSuccessfulWriteAt: expect.any(String) })
    expect(await fs.readFile(path.join(directory, 'diagnostic-events.jsonl'), 'utf8')).toContain('recovered')
  })
})
