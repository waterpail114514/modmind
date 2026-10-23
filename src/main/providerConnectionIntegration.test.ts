import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { DeviceApiError } from './deviceIntegration'
import { parseProviderSnapshot, providerOwnerKey, type ProviderSnapshot } from './providerSync'

// Exercise the shipped main-process integration without starting Electron.
const ast = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
function production(names: string[], dependencies: Record<string, unknown>): Record<string, any> {
  const source = names.map(name => {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!fn) throw new Error(`Missing production function: ${name}`)
    return fn.getText(ast)
  }).join('\n')
  const state = vm.createContext({ AbortSignal, Error, ...dependencies })
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state)
  return state
}
const legacy = { siteUrl: 'https://fixture.invalid', username: 'owner', apiKey: 'old-ls-key', baseUrl: 'https://ls.invalid/v1', account: 'ls', group: 'group-a', balanceCents: '123' }
const secondary: ProviderSnapshot = { protocolVersion: 2, selectionRevision: 8, defaultAccount: 'secondary', connections: [
  { account: 'secondary', label: 'Supplier two', kind: 'paid', apiKey: 'new-paid-key', baseUrl: 'https://paid.invalid', inferenceBaseUrl: 'https://paid.invalid/v1', group: 'group-b', node: null, model: null },
  { account: 'trial:one', label: 'Free one', kind: 'free', apiKey: 'free-key', baseUrl: 'https://free.invalid', inferenceBaseUrl: 'https://free.invalid/v1', group: null, node: null, model: 'free-model' }
] }

describe('provider discovery main integration', () => {
  function migration(preferences: Record<string, unknown> = { model: 'chosen-model', reasoningLevel: 'high' }) {
    const write = vi.fn(async value => value)
    const notify = vi.fn()
    const state = production(['upgradeQuotaConnections'], {
      readDeviceCredentials: async () => legacy,
      fetch: vi.fn(async () => Response.json({ success: true, data: secondary })),
      PROVIDER_SYNC_CAPABILITY_HEADERS: {}, parseProviderSnapshot,
      readBeginnerAiPreferences: async () => preferences,
      writeDeviceCredentialsUnlocked: write, emitProviderConnectionsChanged: notify,
      providerSyncService: undefined, quotaModelAvailabilityCache: new Map(), scannedModelCapabilities: new Map()
    })
    return { state, write, notify }
  }

  it('discovers a replacement paid connection while retaining the old provider, group and model choice', async () => {
    const h = migration()
    await expect(h.state.upgradeQuotaConnections(legacy, 'routing-token')).resolves.toBe(true)
    const saved = h.write.mock.calls[0][0]
    expect(saved).toMatchObject({ account: 'secondary', apiKey: 'new-paid-key', sync: { connections: secondary.connections, defaults: { model: 'chosen-model', account: 'ls', billing: 'quota', group: 'group-a', reasoningLevel: 'high' } } })
    expect(h.notify).toHaveBeenCalledWith(saved)
  })

  it('preserves an explicit free preference instead of binding it to the new paid default', async () => {
    const h = migration({ model: 'free-model', account: 'trial:one', billing: 'free', reasoningLevel: 'auto' })
    await h.state.upgradeQuotaConnections(legacy, 'routing-token')
    expect(h.write.mock.calls[0][0].sync.defaults).toEqual({ model: 'free-model', account: 'trial:one', billing: 'free', reasoningLevel: 'auto' })
  })

  it('refuses an unidentifiable legacy selection instead of inheriting the replacement provider', async () => {
    const h = migration()
    h.state.readDeviceCredentials = async () => ({ ...legacy, account: undefined })
    await expect(h.state.upgradeQuotaConnections({ ...legacy, account: undefined }, 'routing-token')).rejects.toThrow('无法确认原来的供应商')
    expect(h.write).not.toHaveBeenCalled()
  })

  function usage() {
    let current: any = { ...legacy, usage: { checkedAt: new Date(0).toISOString(), balanceCents: '123', keyStatus: 'ACTIVE' }, sync: { ...secondary, defaultAccount: 'ls', connections: [{ ...secondary.connections[0], account: 'ls', apiKey: legacy.apiKey, group: 'group-a' }, secondary.connections[1]], defaults: { model: 'chosen-model', account: 'ls', billing: 'quota', group: 'group-a', reasoningLevel: 'high' } } }
    const refresh = vi.fn(async () => {})
    const remove = vi.fn()
    const readState = vi.fn(async () => ({ status: 'connected', username: current?.username }))
    const update = vi.fn(async value => value)
    const query = vi.fn(async () => { throw new DeviceApiError('unauthorized', 401) })
    const state = production(['refreshDeviceUsage', 'publicDeviceState', 'isFreeDeviceAccount', 'sameDeviceCredentials'], {
      DeviceApiError, providerOwnerKey, quotaModelSwitchInProgress: false, quotaRouter: () => ({ recoveryRequired: async () => false }),
      readDeviceCredentials: async () => current, QUOTA_USAGE_MAX_AGE_MS: 120_000,
      queryDeviceUsage: query, updateCurrentDeviceUsage: vi.fn(), removeCurrentDeviceCredentials: remove,
      providerSync: () => ({ refresh }), updateDeviceState: update, readDeviceState: readState,
      disconnectedDeviceState: (message: string) => ({ status: 'disconnected', message })
    })
    return { state, refresh, remove, query, update, readState, current: () => current, replace: (value: any) => { current = value } }
  }

  it('refreshes connections on a v2 usage 401 and retains the original selection and last usage', async () => {
    const h = usage(), previous = h.current()
    h.refresh.mockImplementation(async () => h.replace({ ...previous, account: 'secondary', apiKey: 'new-paid-key', baseUrl: 'https://paid.invalid/v1', sync: { ...secondary, defaults: previous.sync.defaults } }))
    const result = await h.state.refreshDeviceUsage()
    expect(result).toMatchObject({ status: 'connected', account: 'ls', balanceCents: '123', message: '连接已刷新，用量暂不可用' })
    expect(h.current().sync.defaults).toEqual(previous.sync.defaults)
    expect(h.current().sync.connections).toHaveLength(2)
    expect(h.current().usage).toEqual(previous.usage)
    expect(h.refresh).toHaveBeenCalledOnce(); expect(h.query).toHaveBeenCalledOnce(); expect(h.remove).not.toHaveBeenCalled()
  })

  it('retains every connection and usage snapshot when v2 discovery also fails', async () => {
    const h = usage(), previous = h.current()
    h.refresh.mockRejectedValueOnce(new Error('offline'))
    expect(await h.state.refreshDeviceUsage()).toMatchObject({ status: 'connected', balanceCents: '123', message: expect.stringContaining('已保留现有连接') })
    expect(h.current()).toBe(previous); expect(h.remove).not.toHaveBeenCalled()
  })

  it('does not refresh or remove the new account after an old usage response arrives late', async () => {
    const h = usage(), previous = h.current()
    h.query.mockImplementationOnce(async () => { h.replace({ ...previous, username: 'other-owner' }); throw new DeviceApiError('unauthorized', 401) })
    await expect(h.state.refreshDeviceUsage()).resolves.toMatchObject({ username: 'other-owner' })
    expect(h.refresh).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled()
  })

  it('notifies live renderers after a durable discovery write without resetting AI preferences', async () => {
    const notifications: string[] = []
    const previous = { ...legacy, sync: { ...secondary, selectionRevision: 7 } }
    let dependencies: any
    const state = production(['providerSync'], {
      ProviderSyncService: class { constructor(value: unknown) { dependencies = value } }, providerSyncService: undefined,
      readDeviceCredentials: async () => previous, providerOwnerKey, deviceStateWrites: { run: (call: () => unknown) => call() },
      writeDeviceCredentialsUnlocked: vi.fn(async value => { notifications.push('saved'); return value }),
      emitProviderConnectionsChanged: () => notifications.push('device:state'), emitAiSelection: vi.fn(), emitAiPreferences: () => notifications.push('device:aiPreferences'),
      quotaModelAvailabilityCache: new Map(), scannedModelCapabilities: new Map(), readBeginnerAiPreferences: vi.fn(), activeAiRuns: new Map()
    })
    state.providerSync()
    await dependencies.write(previous, secondary)
    expect(notifications).toEqual(['saved', 'device:state'])
  })

  it('broadcasts a newly pinned binding without clearing another surface or defaults', async () => {
    const emitted = vi.fn(), previous = { ...legacy, sync: { ...secondary, bindings: { workspace: { model: 'chosen-model', account: 'secondary', billing: 'quota', reasoningLevel: 'auto' } } } }
    let dependencies: any
    const state = production(['providerSync'], {
      ProviderSyncService: class { constructor(value: unknown) { dependencies = value } }, providerSyncService: undefined,
      readDeviceCredentials: async () => previous, providerOwnerKey, deviceStateWrites: { run: (call: () => unknown) => call() },
      writeDeviceCredentialsUnlocked: async (value: unknown) => value, emitProviderConnectionsChanged: vi.fn(), emitAiSelection: emitted,
      quotaModelAvailabilityCache: new Map(), scannedModelCapabilities: new Map(), readBeginnerAiPreferences: vi.fn(), activeAiRuns: new Map()
    })
    state.providerSync()
    const pinned = { ...previous.sync.bindings.workspace, group: 'group-b' }
    await dependencies.write(previous, { ...previous.sync, bindings: { workspace: pinned } })
    expect(emitted).toHaveBeenCalledExactlyOnceWith('workspace', pinned)
  })
})
