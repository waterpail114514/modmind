import { describe, expect, it } from 'vitest'
import { deviceModelCatalogKey } from './deviceModelCatalog'
import type { DeviceConnectionState } from './types'

const connected: DeviceConnectionState = { status: 'connected', configured: true, siteUrl: 'https://site.example', username: 'alice', modelCatalogRevision: 3 }
describe('client catalog identity', () => {
  it('ignores website route, usage, balance and authorization messages', () => {
    expect(deviceModelCatalogKey({ ...connected, account: 'secondary', balanceCents: '123', checkedAt: new Date().toISOString(), message: '已同步账号' })).toBe(deviceModelCatalogKey(connected))
    expect(deviceModelCatalogKey({ ...connected, account: 'trial:one', billing: 'free' })).toBe(deviceModelCatalogKey(connected))
  })
  it('reloads only for client catalog changes, a new account or custom API configuration', () => {
    for (const value of [{ ...connected, username: 'bob' }, { ...connected, siteUrl: 'https://other.example' }, { ...connected, modelCatalogRevision: 4 }, { ...connected, provider: 'custom' as const, providerId: 'custom-one' }]) expect(deviceModelCatalogKey(value)).not.toBe(deviceModelCatalogKey(connected))
    expect(deviceModelCatalogKey({ ...connected, provider: 'custom', model: 'model-one' })).not.toBe(deviceModelCatalogKey({ ...connected, provider: 'custom', model: 'model-two' }))
    expect(deviceModelCatalogKey({ ...connected, provider: 'custom', modelCatalogRevision: 4 })).not.toBe(deviceModelCatalogKey({ ...connected, provider: 'custom' }))
  })
  it('does not request a catalog while disconnected, authorizing or failed', () => {
    for (const status of ['disconnected', 'authorizing', 'error'] as const) expect(deviceModelCatalogKey({ ...connected, status })).toBeUndefined()
  })
})
