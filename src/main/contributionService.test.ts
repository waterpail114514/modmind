import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ContributionService, contributionFolder, parseContributionTicket } from './contributionService'
import { CONTRIBUTION_TERMS_VERSION, CONTRIBUTION_TICKET_URL, CONTRIBUTION_UPLOAD_URL } from '../shared/contributions'
import { DiagnosticOperations } from './diagnosticOperations'
import { DiagnosticJournal } from './diagnosticLog'

let directory: string
let clock = Date.parse('2026-11-01T09:00:00Z')
let monotonic = 0
const instances: ContributionService[] = []
const ticket = () => {
  const expiresAt = new Date(clock + 7 * 86400_000).toISOString()
  return { format: 'modmind-contribution-upload', schemaVersion: 1, expiresAt, url: CONTRIBUTION_UPLOAD_URL, maxBytes: 65536,
    fields: { key: '${filename}', bucket: 'contribute', 'Content-Type': 'application/json', 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': 'EXAMPLEACCESS1234/20261101/rainyun/s3/aws4_request', 'X-Amz-Date': '20261101T000000Z', 'X-Amz-Signature': '0'.repeat(64),
      Policy: Buffer.from(JSON.stringify({ expiration: expiresAt, conditions: [{ bucket: 'contribute' }, ['starts-with', '$key', ''], ['content-length-range', 1, 65536]] })).toString('base64') } }
}
const make = (fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline')), file = path.join(directory, 'state.json')): ContributionService => {
  const service = new ContributionService(file, { appVersion: '2.0.0-preview.1', platform: 'win32', arch: 'x64', now: () => clock, fetch })
  instances.push(service)
  return service
}
const enable = async (service: ContributionService): Promise<void> => {
  const c = service.challenge(7)
  monotonic += 3000
  await service.enable(7, c.token, c.termsVersion)
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-contribution-'))
  clock = Date.parse('2026-11-01T09:00:00Z'); monotonic = 0
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
})
afterEach(async () => {
  for (const service of instances.splice(0)) await service.shutdown()
  vi.restoreAllMocks()
  if (!directory.startsWith(path.join(os.tmpdir(), 'modmind-contribution-'))) throw new Error('Unexpected test directory')
  await rm(directory, { recursive: true, force: true })
})

describe('contribution privacy, consent and delivery', () => {
  it('remains off without consent, never fetches or imports historical logs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const service = make(fetch)
    await service.initialize()
    service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 10 })
    await service.flush()
    expect(service.state().enabled).toBe(false)
    expect(service.preview().reports).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('enforces the 3 second delay, sender, terms version, one use and expiry in main', async () => {
    const service = make(); await service.initialize()
    const c = service.challenge(7)
    await expect(service.enable(7, c.token, c.termsVersion)).rejects.toThrow('3 秒')
    monotonic = 3000
    await expect(service.enable(8, c.token, c.termsVersion)).rejects.toThrow()
    await expect(service.enable(7, c.token, 'old')).rejects.toThrow()
    await service.enable(7, c.token, c.termsVersion)
    await expect(service.enable(7, c.token, c.termsVersion)).rejects.toThrow()
    await service.disable()
    const expired = service.challenge(7); monotonic += 300001
    await expect(service.enable(7, expired.token, expired.termsVersion)).rejects.toThrow()
  })

  it('uses safe stable user_hash folders and independent guest/install identities', () => {
    expect(contributionFolder('水桶', 'a')).toMatch(/^水桶_[a-f0-9]{10}$/)
    expect(contributionFolder('水桶', 'a')).toBe(contributionFolder('水桶', 'a'))
    expect(contributionFolder('水桶', 'b')).not.toBe(contributionFolder('水桶', 'a'))
    expect(contributionFolder(undefined, 'a')).toMatch(/^guest_[a-f0-9]{10}$/)
    expect(contributionFolder('guest', 'a')).not.toBe(contributionFolder(undefined, 'a'))
    expect(contributionFolder('../a\\b\u0000', 'a')).not.toMatch(/[/.\\\p{C}]/u)
    expect(contributionFolder('a/b', 'a')).not.toBe(contributionFolder('a\\b', 'a'))
  })

  it('projects real operation completion to counts without input, result, paths or error text', async () => {
    const service = make(); service.setUsername('Example'); await service.initialize(); await enable(service)
    const operations = new DiagnosticOperations(new DiagnosticJournal())
    operations.subscribeMetrics(m => service.recordOperation(m))
    await operations.run('ipc', 'project:writeFile', { path: 'C:/private-name', content: 'private-source' }, () => ({ secret: 'private-result' }))
    await expect(operations.run('ipc', 'minecraft:buildProject', {}, () => { throw new Error('private-token') })).rejects.toThrow()
    await operations.run('ipc', 'arbitrary:private-name', {}, () => true)
    const report = service.preview().reports[0]
    expect(report.metrics).toHaveLength(2)
    expect(report.metrics.map(m => m.outcome)).toEqual(['returned', 'failed'])
    expect(JSON.stringify(report)).not.toMatch(/private|Example|token|path|content|secret/)
  })

  it('uploads a whitelisted report with the correct user directory and recovers after restart', async () => {
    const calls: Array<{ url: string; options?: RequestInit }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      calls.push({ url: String(input), options })
      return String(input) === CONTRIBUTION_TICKET_URL ? Response.json(ticket()) : new Response(null, { status: 204 })
    })
    const service = make(fetch); service.setUsername('TestUser'); await service.initialize(); await enable(service)
    service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 500 })
    const folder = service.state().folder
    await service.flush()
    expect(calls).toHaveLength(2)
    const body = calls[1].options!.body as FormData
    expect(body.get('key')).toMatch(new RegExp(`^${folder}/2026-11-01/[a-f0-9-]+\\.json$`))
    expect(JSON.parse(await (body.get('file') as File).text()).metrics[0]).toEqual({ feature: 'file.save', outcome: 'returned', duration: '<1s', count: 1 })
    expect(service.state().pendingReports).toBe(0)
    await service.shutdown()
    const restarted = make(fetch); restarted.setUsername('TestUser'); await restarted.initialize()
    expect(restarted.state().enabled).toBe(true)
    expect(restarted.state().folder).toBe(folder)
  })

  it('keeps account A reports in A directory when the current user changes', async () => {
    const keys: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      if (String(input) === CONTRIBUTION_TICKET_URL) return Response.json(ticket())
      keys.push(String((options!.body as FormData).get('key')))
      return new Response(null, { status: 204 })
    })
    const service = make(fetch); service.setUsername('Alice'); await service.initialize(); await enable(service)
    service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 1 })
    const alice = service.state().folder
    service.setUsername('Bob')
    service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 1 })
    await service.flush()
    expect(keys[0].startsWith(alice + '/')).toBe(true)
    expect(keys[1].startsWith(service.state().folder + '/')).toBe(true)
  })

  it('rejects redirected, expired, oversized and malicious ticket configurations', () => {
    expect(parseContributionTicket(ticket(), clock)).toBeTruthy()
    for (const t of [{ ...ticket(), url: 'https://evil.example' }, { ...ticket(), expiresAt: new Date(clock - 1).toISOString() }, { ...ticket(), maxBytes: 1e9 }, { ...ticket(), fields: { ...ticket().fields, secretAccessKey: 'never' } }]) expect(() => parseContributionTicket(t, clock)).toThrow()
    const t = ticket(); t.fields.Policy = Buffer.from(JSON.stringify({ expiration: t.expiresAt, conditions: [] })).toString('base64')
    expect(() => parseContributionTicket(t, clock)).toThrow()
  })

  it('backs off when offline and drops expired reports within bounded storage', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'))
    const service = make(fetch); await service.initialize(); await enable(service)
    for (let i = 0; i < 130; i++) { service.setUsername('user' + i); service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 10 }) }
    expect(service.state().pendingReports).toBeLessThanOrEqual(101)
    expect(service.state().pendingBytes).toBeLessThan(2 * 1024 * 1024)
    await service.flush(); await service.flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(service.state().phase).toBe('waiting')
    clock += 8 * 86400_000
    await service.flush()
    expect(service.state().pendingReports).toBe(0)
    expect(service.state().droppedReports).toBeGreaterThan(0)
  })

  it('aborts an upload and persists an empty disabled queue without resurrecting it', async () => {
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      if (String(input) === CONTRIBUTION_TICKET_URL) return Response.json(ticket())
      began()
      return new Promise<Response>((_, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    const service = make(fetch); await service.initialize(); await enable(service)
    service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 1 })
    const sending = service.flush(); await started
    await service.disable(); await sending
    const stored = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))
    expect(stored.enabled).toBe(false); expect(stored.entries).toEqual([])
    expect(service.state()).toMatchObject({ enabled: false, phase: 'disabled', pendingReports: 0 })
  })

  it('does not upload tampered persisted reports or keep consent across a terms version change', async () => {
    const service = make(); await service.initialize(); await enable(service)
    service.recordOperation({ operation: 'project:writeFile', outcome: 'returned', durationMs: 1 }); await service.shutdown()
    const file = path.join(directory, 'state.json'), stored = JSON.parse(await readFile(file, 'utf8'))
    stored.entries[0].report.metrics[0].feature = 'private-source'; await writeFile(file, JSON.stringify(stored))
    const restarted = make(); await restarted.initialize()
    expect(JSON.stringify(restarted.preview())).not.toContain('private-source')
    stored.termsVersion = 'old'; await writeFile(file, JSON.stringify(stored))
    const changed = make(); await changed.initialize()
    expect(changed.state().enabled).toBe(false)
    expect(changed.state().termsVersion).toBe(CONTRIBUTION_TERMS_VERSION)
  })
})
