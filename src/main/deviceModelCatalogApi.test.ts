import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDeviceModelCatalog, modelCatalogPath, parseDeviceModelCatalog } from './deviceModelCatalogApi'
import { parseProviderSnapshot, reconcileProviderSync } from './providerSync'
import { providerFixture } from './__fixtures__/providerSync'

afterEach(() => vi.unstubAllGlobals())
const payload = () => ({ account: 'ls', group: '100084', type: 'chat', models: ['model-a', 'model-a', 'model-b'], version: 'abc', updatedAt: '2026-11-02T11:27:02.446Z', stale: false, source: 'server-cache' })

describe('website model catalog protocol', () => {
  it('uses the current website group by default and encodes explicit group values', () => {
    expect(modelCatalogPath('https://site.example')).toBe('/api/device/models')
    expect(modelCatalogPath('https://site.example', 'ls', 'https://site.example/api/device/models?account=ls')).toBe('/api/device/models?account=ls')
    const path = modelCatalogPath('https://site.example', 'ls', undefined, '中文 分组')
    expect(new URL(path, 'https://site.example').searchParams.get('group')).toBe('中文 分组')
  })

  it.each(['https://foreign.example/api/device/models?account=ls', 'https://site.example/api/device/group?account=ls', 'https://site.example/api/device/models?account=ls&group=old', 'https://site.example/api/device/models?account=ls&account=secondary'])('never sends credentials to an unsafe modelsUrl: %s', url => {
    expect(modelCatalogPath('https://site.example', 'ls', url)).toBe('/api/device/models?account=ls')
  })

  it('validates the account, group and envelope while retaining stale server lists', () => {
    expect(parseDeviceModelCatalog({ ...payload(), stale: true }, 'ls')).toMatchObject({ stale: true, models: [{ id: 'model-a' }, { id: 'model-b' }] })
    expect(() => parseDeviceModelCatalog(payload(), 'secondary')).toThrow('无效数据')
    expect(() => parseDeviceModelCatalog(payload(), 'ls', 'wrong')).toThrow('无效数据')
    expect(() => parseDeviceModelCatalog({ ...payload(), models: [{}] }, 'ls')).toThrow('无效数据')
    expect(() => parseDeviceModelCatalog({ ...payload(), type: 'image' }, 'ls')).toThrow('无效数据')
  })

  it('uses the authenticated website endpoint for legacy sessions without falling back upstream', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ success: true, data: payload() }))
    vi.stubGlobal('fetch', fetcher)
    expect((await fetchDeviceModelCatalog('https://site.example', 'fixture-key', 'ls')).models).toHaveLength(2)
    expect(String(fetcher.mock.calls[0][0])).toBe('https://site.example/api/device/models?account=ls')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer fixture-key', 'X-ModMind-Sync-Capabilities': 'provider-ls' } })
    fetcher.mockImplementation(async () => new Response('{}', { status: 503 }))
    await expect(fetchDeviceModelCatalog('https://site.example', 'fixture-key', 'ls')).rejects.toThrow('尚未就绪')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps synchronization catalog metadata and prefers embedded paid models', async () => {
    const f = providerFixture('ls'), snapshot = f.owner().sync
    f.groups.splice(0)
    const connection = { ...snapshot.connections[0], models: ['embedded-model'], modelsUrl: 'https://site.example/api/device/models?account=ls', modelsReady: true, modelsVersion: 'version-a', modelsUpdatedAt: null, modelsStale: false }
    const parsed = parseProviderSnapshot({ ...snapshot, connections: [connection] })
    expect(parsed.connections[0]).toMatchObject(connection)
    f.setOwner({ ...f.owner(), sync: parsed })
    expect((await f.service.catalog()).models.map(m => m.id)).toEqual(['embedded-model'])
    expect(f.network.some(r => r.url.includes('/api/device/models'))).toBe(false)
    const refreshed = await f.service.discoverModels()
    expect(refreshed.models.some(m => m.id === 'embedded-model')).toBe(false)
    expect(f.network.some(r => r.url === connection.modelsUrl)).toBe(true)
    expect(f.preferences().model).toBe('gpt-6-astra')
  })

  it('updates same-route synchronization models while preserving credentials and all user selections', () => {
    const f = providerFixture('ls'), previous = f.owner().sync
    const next = { ...previous, connections: previous.connections.map(c => c.kind === 'paid' ? { ...c, apiKey: 'rotated', models: ['new-model'], modelsReady: true } : c) }
    expect(reconcileProviderSync(previous, next, f.preferences()).connections[0]).toMatchObject({ apiKey: 'paid-secret', models: ['new-model'] })
    const unavailable = { ...next, connections: next.connections.map(c => ({ ...c, models: [], modelsReady: false })) }
    expect(reconcileProviderSync(previous, unavailable, f.preferences()).connections[1].models).toEqual(previous.connections[1].models)
  })

  it.each([429, 503])('honors Retry-After for HTTP %s, retains choices and makes no group changes', async status => {
    const f = providerFixture('ls'), before = structuredClone(f.preferences())
    await f.service.catalog()
    f.catalog.status = status; f.catalog.retryAfter = '120'
    expect((await f.service.discoverModels()).stale).toBe(true)
    const calls = () => f.network.filter(r => r.url.includes('/api/device/models')).length
    const count = calls()
    await f.service.discoverModels()
    expect(calls()).toBe(count)
    expect(f.preferences()).toEqual(before)
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
    f.catalog.status = 200; f.tick(121_000)
    expect((await f.service.discoverModels()).stale).toBe(false)
    expect(calls()).toBeGreaterThan(count)
  })

  it('shows stale server results as usable and preserves settings when the server has no catalog', async () => {
    const f = providerFixture('ls')
    f.catalog.stale = true
    const result = await f.service.catalog()
    expect(result.stale).toBe(true)
    expect(result.models.find(m => m.id === 'gpt-6-astra')).toMatchObject({ available: true })
    f.catalog.status = 503
    const unavailable = await f.service.discoverModels()
    expect(unavailable.message).toContain('尚未就绪')
    expect(unavailable.models.some(m => m.id === 'gpt-6-astra')).toBe(true)
    expect(f.preferences().model).toBe('gpt-6-astra')
  })

  it('excludes an unconfigured advertised group without failing the working current route', async () => {
    const f = providerFixture('ls')
    f.providers.push({ account: 'primary', label: '旧供应商', kind: 'paid', groups: [{ id: 'plus 2组' }] })
    f.catalog.unconfigured.add('primary:plus 2组')
    const catalog = await f.service.discoverModels()
    expect(catalog.stale).toBe(false)
    expect(catalog.models.some(m => m.id === 'gpt-6-astra' && m.account === 'ls')).toBe(true)
    expect(catalog.routes?.some(r => r.account === 'primary')).toBe(false)
    expect(catalog.providers?.some(p => p.account === 'primary')).toBe(false)
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
})
