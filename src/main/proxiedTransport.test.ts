import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every website/reasoning call used to fall back to the global fetch, which
// ignores the proxy chosen in settings. Production wiring injects no fetcher
// (see index.ts), so the default parameter is what actually runs. These tests
// pin that default to the proxied transport and fail if a call site regresses.
const networkFetchMock = vi.hoisted(() => vi.fn())

vi.mock('./networkRequest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./networkRequest')>()
  return { ...actual, networkFetch: networkFetchMock }
})

import { fetchDeviceModelCatalog } from './deviceModelCatalogApi'
import { ModelReasoningCatalog } from './modelReasoningCatalog'
import { parseProviderSnapshot, ProviderSyncService, type ProviderOwner } from './providerSync'
import { QuotaModelRouting, type RoutingCredentials } from './quotaModelRouting'

const sessionEnvelope = () => ({
  success: true,
  data: { routingToken: 'fixture-routing-token', routingTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }
})

beforeEach(() => {
  networkFetchMock.mockReset()
  // If a call site regresses to the global fetch, fail here rather than reach
  // the network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('global fetch must not be used') }))
})
afterEach(() => vi.unstubAllGlobals())

describe('default transport for website calls', () => {
  it('reads the website model catalog through the proxied transport', async () => {
    networkFetchMock.mockResolvedValueOnce(Response.json({
      success: true,
      data: { account: 'ls', group: '100084', type: 'chat', models: ['model-a', 'model-a', 'model-b'], version: 'abc', updatedAt: null, stale: false, source: 'server-cache' }
    }))
    expect((await fetchDeviceModelCatalog('https://site.example', 'fixture-key', 'ls')).models).toHaveLength(2)
    expect(networkFetchMock).toHaveBeenCalledTimes(1)
    expect(String(networkFetchMock.mock.calls[0][0])).toBe('https://site.example/api/device/models?account=ls')
  })

  it('refreshes the reasoning catalog through the proxied transport', async () => {
    networkFetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await new ModelReasoningCatalog().refresh(true)
    expect(networkFetchMock).toHaveBeenCalledTimes(1)
    expect(networkFetchMock.mock.calls[0][0]).toBe('https://models.dev/api.json')
  })

  it('opens a provider sync session through the proxied transport', async () => {
    networkFetchMock.mockResolvedValueOnce(Response.json(sessionEnvelope()))
    const owner: ProviderOwner = {
      siteUrl: 'https://site.example', username: 'alice',
      sync: parseProviderSnapshot({
        protocolVersion: 2, selectionRevision: 1, defaultAccount: 'ls',
        connections: [{ account: 'ls', label: 'LS', kind: 'paid', baseUrl: 'https://paid.example', inferenceBaseUrl: 'https://paid.example/v1', apiKey: 'paid-key', model: null, group: 'g' }]
      })
    }
    const service = new ProviderSyncService({
      read: async () => owner,
      write: vi.fn(async () => {}),
      readSession: async () => null,
      writeSession: vi.fn(async () => {}),
      readPreferences: async () => ({ model: 'gpt-6-astra', reasoningLevel: 'high' as const, fastMode: false }),
      applyDefaults: vi.fn(async () => ({ model: 'gpt-6-astra', reasoningLevel: 'high' as const, fastMode: false })),
      paidBusy: () => false
    })
    await service.initializeSession()
    expect(networkFetchMock).toHaveBeenCalledTimes(1)
    expect(String(networkFetchMock.mock.calls[0][0])).toBe('https://site.example/api/device/session')
  })

  it('opens a quota routing session through the proxied transport', async () => {
    networkFetchMock.mockResolvedValueOnce(Response.json(sessionEnvelope()))
    const credentials: RoutingCredentials = { siteUrl: 'https://site.example', baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key', username: 'alice', balanceCents: '100' }
    const router = new QuotaModelRouting({
      readCredentials: async () => credentials,
      writeCredentials: vi.fn(async () => {}),
      readSession: async () => null,
      writeSession: vi.fn(async () => {}),
      clearSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      readPreferences: async () => ({ model: 'gpt-6-astra', reasoningLevel: 'high' as const, fastMode: false }),
      applyModel: vi.fn(async () => ({ model: 'gpt-6-astra', reasoningLevel: 'high' as const, fastMode: false }))
    })
    await router.routingToken()
    expect(networkFetchMock).toHaveBeenCalledTimes(1)
    expect(String(networkFetchMock.mock.calls[0][0])).toBe('https://site.example/api/device/session')
  })
})
