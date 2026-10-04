import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceUsage } from '../shared/types'
import { DeviceApiError, queryDeviceUsage } from './deviceIntegration'

// Exercise the production preflight without starting Electron or registering IPC.
const source = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const functions = ['ensureQuotaAccountReady', 'publicDeviceState'].map(name => {
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!fn) throw new Error(`Missing entrypoint function: ${name}`)
  return fn.getText(source)
}).join('\n')
const preflightCode = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

interface Credentials {
  siteUrl: string
  baseUrl: string
  apiKey: string
  username: string
  balanceCents: string
  provider?: 'custom'
  usage?: DeviceUsage
}

function zeroUsage(keyStatus: DeviceUsage['keyStatus'] = 'ACTIVE', stale = false): DeviceUsage {
  return {
    keyStatus, frozenReason: keyStatus === 'FROZEN' ? '余额不足' : null,
    balanceCents: '0', usedQuota: '100', remainQuota: '0', billedCentsTotal: '1',
    lastSeenUsedQuota: '100', quotaSyncedAt: null,
    checkedAt: new Date(Date.now() - (stale ? 180_000 : 0)).toISOString()
  }
}

function harness(usage?: DeviceUsage) {
  const credentials: Credentials = {
    siteUrl: 'https://account.example', baseUrl: 'https://relay.example/v1',
    apiKey: 'fixture-key', username: 'fixture-user', balanceCents: '0', usage
  }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ success: true, data: usage ?? zeroUsage() })))
  const sandbox = {
    AbortSignal, DeviceApiError, QUOTA_USAGE_MAX_AGE_MS: 120_000,
    readDeviceCredentials: vi.fn(async (): Promise<Credentials | null> => credentials),
    queryDeviceUsage: vi.fn((site: string, key: string, signal: AbortSignal) => queryDeviceUsage(site, key, signal, fetcher)),
    updateCurrentDeviceUsage: vi.fn(async (current: Credentials, next: DeviceUsage): Promise<Credentials | null> => ({ ...current, usage: next })),
    removeCurrentDeviceCredentials: vi.fn(async () => true),
    updateDeviceState: vi.fn(async (state: unknown) => state),
    disconnectedDeviceState: (message: string) => ({ status: 'disconnected', message }),
    quotaModelsForCredentials: vi.fn(async (_current: Credentials) => [{ id: 'free-model' }]),
    reconcileQuotaModelPreferences: vi.fn(async () => undefined),
    ensureQuotaAccountReady: undefined as unknown as () => Promise<void>
  }
  vm.runInNewContext(preflightCode, sandbox)
  return { ...sandbox, credentials, fetcher }
}

describe('quota account readiness for free upstream routes', () => {
  it.each(['ACTIVE', 'FROZEN'] as const)('allows zero balance and quota with cached %s status', async status => {
    const h = harness(zeroUsage(status))
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.reconcileQuotaModelPreferences).toHaveBeenCalledWith(h.credentials, false, [{ id: 'free-model' }])
  })

  it.each(['ACTIVE', 'FROZEN'] as const)('refreshes usage for display without blocking on %s status', async status => {
    const h = harness()
    const usage = zeroUsage(status)
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: usage })))
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected', keyStatus: status, balanceCents: '0' }))
    expect(h.quotaModelsForCredentials).toHaveBeenCalledWith(expect.objectContaining({ usage }))
  })

  it.each([402, 429, 502, 503])('does not infer model access from a usage endpoint HTTP %s failure', async status => {
    const h = harness()
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'usage unavailable' }), { status }))
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.quotaModelsForCredentials).toHaveBeenCalled()
    expect(h.removeCurrentDeviceCredentials).not.toHaveBeenCalled()
  })

  it('allows retry with a stale frozen snapshot when the usage endpoint is offline', async () => {
    const h = harness(zeroUsage('FROZEN', true))
    h.fetcher.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.quotaModelsForCredentials).toHaveBeenCalled()
  })

  it('still rejects a missing account', async () => {
    const h = harness()
    h.readDeviceCredentials.mockResolvedValueOnce(null)
    await expect(h.ensureQuotaAccountReady()).rejects.toThrow('请先连接 ModMind 账号')
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it('still removes credentials explicitly rejected by the account endpoint', async () => {
    const h = harness()
    h.fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await expect(h.ensureQuotaAccountReady()).rejects.toThrow('接入 Key 已失效')
    expect(h.removeCurrentDeviceCredentials).toHaveBeenCalledWith(h.credentials)
    expect(h.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ status: 'disconnected' }))
    expect(h.quotaModelsForCredentials).not.toHaveBeenCalled()
  })

  it.each(['usage', '401'] as const)('rechecks the current account after a route switch during %s', async result => {
    const h = harness()
    const replacement = { ...h.credentials, apiKey: 'replacement-key', usage: zeroUsage('FROZEN') }
    h.readDeviceCredentials.mockResolvedValueOnce(h.credentials).mockResolvedValue(replacement)
    if (result === '401') {
      h.fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }))
      h.removeCurrentDeviceCredentials.mockResolvedValueOnce(false)
    } else h.updateCurrentDeviceUsage.mockResolvedValueOnce(null)
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.quotaModelsForCredentials).toHaveBeenCalledWith(replacement)
    expect(h.updateDeviceState).not.toHaveBeenCalled()
  })

  it('leaves model access to the actual request when model discovery is unavailable', async () => {
    const h = harness(zeroUsage())
    h.quotaModelsForCredentials.mockRejectedValueOnce(new Error('404 Not Found'))
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.reconcileQuotaModelPreferences).not.toHaveBeenCalled()
  })

  it('keeps custom API accounts independent of hosted usage', async () => {
    const h = harness()
    h.credentials.provider = 'custom'
    await expect(h.ensureQuotaAccountReady()).resolves.toBeUndefined()
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.quotaModelsForCredentials).not.toHaveBeenCalled()
  })
})
