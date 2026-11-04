import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceApiError } from './deviceIntegration'
import { providerFixture } from './__fixtures__/providerSync'
import { providerOwnerKey, reconcileProviderSync } from './providerSync'
import { normalizeQuotaModelPreferences } from './quotaModelPreferences'

const source = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const codeFor = (...names: string[]): string => ts.transpileModule(names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!declaration) throw new Error(`Missing production entry point: ${name}`)
  return declaration.getText(source)
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function harness() {
  const fixture = providerFixture('ls'), initial = fixture.owner().sync
  initial.defaults = { model: 'gpt-6-astra', reasoningLevel: 'high' }
  initial.bindings = { workspace: { model: 'gpt-6-luna', reasoningLevel: 'auto' }, inspiration: { model: 'qwen3.8-flash', account: 'trial:one', billing: 'free', reasoningLevel: 'auto' } }
  let current = { version: 1, siteUrl: 'https://site.example', username: 'alice', apiKey: 'paid-secret', baseUrl: 'https://paid.example/v1', balanceCents: '10', connectedAt: 'original', sync: structuredClone(initial) }
  const next = structuredClone(initial)
  next.selectionRevision++
  const controller = new AbortController(), initializeSession = vi.fn(async () => {})
  const session = { owner: providerOwnerKey(current), token: 'saved-routing-session', pending: undefined }
  const sessions = { read: vi.fn(async () => session), clear: vi.fn(async () => {}) }
  const sandbox = {
    Date, Map, Promise, AbortController, controller, DeviceApiError, providerOwnerKey, reconcileProviderSync, normalizeQuotaModelPreferences,
    deviceAuthorizationController: controller as AbortController | null, providerCatalogRevision: 0,
    waitForDevicePoll: vi.fn(async (_ms: number, signal: AbortSignal) => signal.throwIfAborted()),
    pollDeviceCode: vi.fn(async () => ({ status: 'ok', sync: next, username: 'alice', balanceCents: '10', apiKey: next.connections[0].apiKey, baseUrl: next.connections[0].inferenceBaseUrl, account: next.defaultAccount, group: next.connections[0].group })),
    throwIfAborted: (signal: AbortSignal) => signal.throwIfAborted(),
    readDeviceCredentials: vi.fn(async () => current),
    readStoredBeginnerAiPreferences: vi.fn(async () => ({ current: fixture.preferences(), profiles: {} })),
    activeQuotaModelPreferences: (store: { current: unknown }) => store.current,
    deviceProfileKey: () => 'test-profile',
    writeDeviceCredentialsUnlocked: vi.fn(async (value: typeof current) => { current = value; return value }),
    writeStoredBeginnerAiPreferences: vi.fn(async () => {}),
    updateQuotaModelPreferences: (_store: unknown, preferences: unknown) => preferences,
    fetchAvailableModels: vi.fn(async () => [{ id: 'new-user-model' }]),
    fetchDeviceModelCatalog: vi.fn(async () => ({ models: [{ id: 'new-user-model' }] })),
    DEFAULT_BEGINNER_AI_PREFERENCES: fixture.preferences(), DEFAULT_DEVICE_MODEL: 'gpt-6.1-sol',
    activeAiRuns: new Map(), aiAbortControllers: new Map(),
    deviceStateWrites: { run: async (operation: () => Promise<unknown>) => operation() },
    quotaConfiguration: { begin: vi.fn(() => 1), finish: vi.fn() },
    quotaRouter: () => ({ reset: vi.fn() }), quotaSessionStore: () => sessions,
    providerSyncService: { invalidate: vi.fn() }, providerSync: () => ({ initializeSession }),
    emitAiPreferences: vi.fn(), updateDeviceState: vi.fn(async () => {}),
    publicDeviceState: (value: typeof current) => ({ status: 'connected', username: value.username }),
    deviceAuthorizationFailure: vi.fn(async () => {}),
    remoteClient: null, readRemoteEnabled: async () => false, stopRemoteClient: vi.fn(async () => {}),
    startRemoteClientIfPossible: vi.fn(), console,
    networkFetch: vi.fn(), startDevicePolling: undefined as unknown as (site: string, code: string, expires: number, controller: AbortController) => void
  }
  vm.runInNewContext(codeFor('startDevicePolling'), sandbox)
  return { sandbox, initial, next, current: () => current, initializeSession, sessions, async run() { sandbox.startDevicePolling('https://site.example', 'SYNC0001', 600, controller); await vi.waitFor(() => expect(sandbox.deviceAuthorizationController).toBeNull()) } }
}

describe('website device sync production polling', () => {
  it('preserves both exact surface selections and the original default during same-user sync', async () => {
    const h = harness()
    h.next.defaultAccount = 'secondary'
    Object.assign(h.next.connections[0], { account: 'secondary', group: 'another-group', apiKey: 'new-paid-key' })
    await h.run()
    expect(h.current().sync).toEqual(h.initial)
    expect(h.current().sync.bindings?.inspiration).toEqual(h.initial.bindings?.inspiration)
    expect(h.current().sync.connections[0]).toMatchObject({ account: 'ls', apiKey: 'paid-secret' })
    expect(h.current()).toMatchObject({ apiKey: 'new-paid-key', refreshBeforeSelection: true })
    expect(h.sandbox.providerSyncService.invalidate).not.toHaveBeenCalled()
    expect(h.sandbox.fetchAvailableModels).not.toHaveBeenCalled()
    expect(h.sandbox.fetchDeviceModelCatalog).not.toHaveBeenCalled()
    expect(h.sandbox.writeStoredBeginnerAiPreferences).not.toHaveBeenCalled()
    expect(h.sandbox.emitAiPreferences).not.toHaveBeenCalled()
    expect(h.sessions.clear).not.toHaveBeenCalled()
    expect(h.sandbox.pollDeviceCode).toHaveBeenCalledTimes(1)
    expect(h.sandbox.deviceAuthorizationFailure).not.toHaveBeenCalled()
    expect(h.initializeSession).toHaveBeenCalledTimes(1)
  })

  it('accepts reauthorization without comparing unrelated website and client route revisions', async () => {
    const h = harness(), original = structuredClone(h.current().sync)
    h.next.selectionRevision = h.initial.selectionRevision - 1
    await h.run()
    expect(h.current().sync).toEqual(original)
    expect(h.sandbox.writeDeviceCredentialsUnlocked).toHaveBeenCalledOnce()
    expect(h.sandbox.deviceAuthorizationFailure).not.toHaveBeenCalled()
    expect(h.sandbox.providerSyncService.invalidate).not.toHaveBeenCalled()
    expect(h.sandbox.pollDeviceCode).toHaveBeenCalledTimes(1)
  })

  it('does not shrink a client free catalog when website authorization supplies fewer free platforms', async () => {
    const h = harness()
    h.next.connections = h.next.connections.filter(connection => connection.kind === 'paid')
    await h.run()
    expect(h.current().sync).toEqual(h.initial)
    expect(h.current().sync.connections.filter(connection => connection.kind === 'free')).toHaveLength(2)
    expect(h.sandbox.providerSyncService.invalidate).not.toHaveBeenCalled()
  })

  it('does not carry the old users bindings or routing session into a new login', async () => {
    const h = harness()
    h.sandbox.pollDeviceCode.mockImplementation(async () => ({ status: 'ok', sync: h.next, username: 'bob', balanceCents: '10', apiKey: h.next.connections[0].apiKey, baseUrl: h.next.connections[0].inferenceBaseUrl, account: h.next.defaultAccount, group: h.next.connections[0].group }))
    delete h.next.defaults; delete h.next.bindings
    await h.run()
    expect(h.current().username).toBe('bob')
    expect(h.sandbox.fetchDeviceModelCatalog).toHaveBeenCalledTimes(1)
    expect(h.current().sync.bindings).toBeUndefined()
    expect(h.sessions.clear).toHaveBeenCalledTimes(1)
    expect(h.sandbox.writeStoredBeginnerAiPreferences).toHaveBeenCalledTimes(1)
    expect(h.sandbox.deviceAuthorizationFailure).not.toHaveBeenCalled()
  })
})

describe('website sync waits for an existing route operation', () => {
  it('waits until the operation finishes and releases abort listeners after each wait', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const add = vi.spyOn(signal, 'addEventListener'), remove = vi.spyOn(signal, 'removeEventListener')
    const sandbox = { Date, Promise, DOMException, setTimeout, clearTimeout, throwIfAborted: (value: AbortSignal) => value.throwIfAborted(), providerSyncService: { busy: true }, quotaModelSwitchInProgress: false, waitForDeviceSyncIdle: undefined as unknown as (signal: AbortSignal) => Promise<void> }
    vm.runInNewContext(codeFor('waitForDevicePoll', 'waitForDeviceSyncIdle'), sandbox)
    let completed = false
    const waiting = sandbox.waitForDeviceSyncIdle(signal).then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(250); expect(completed).toBe(false)
    sandbox.providerSyncService.busy = false
    await vi.advanceTimersByTimeAsync(100); await waiting
    expect(completed).toBe(true)
    expect(add.mock.calls.length).toBe(remove.mock.calls.length)
  })

  it('cancels a waiting sync without starting another route operation', async () => {
    const controller = new AbortController()
    const sandbox = { Date, Promise, DOMException, setTimeout, clearTimeout, throwIfAborted: (value: AbortSignal) => value.throwIfAborted(), providerSyncService: { busy: true }, quotaModelSwitchInProgress: false, waitForDeviceSyncIdle: undefined as unknown as (signal: AbortSignal) => Promise<void> }
    vm.runInNewContext(codeFor('waitForDevicePoll', 'waitForDeviceSyncIdle'), sandbox)
    const waiting = sandbox.waitForDeviceSyncIdle(controller.signal)
    const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await assertion
    expect(sandbox.providerSyncService.busy).toBe(true)
  })
})
