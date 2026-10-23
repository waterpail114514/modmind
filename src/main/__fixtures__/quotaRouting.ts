import { expect } from 'vitest'
import { QuotaModelRouting, type RoutingCredentials, type RoutingSession } from '../quotaModelRouting'
import { QUOTA_ROUTE_HINTS, FREE_ROUTE_HINTS } from '../../shared/quotaModels'
import type { BeginnerAiPreferences } from '../../shared/types'
import type { ProviderGroup } from '../../shared/providerRoutes'

export function routingFixture() {
  let credentials: RoutingCredentials | null = { siteUrl: 'https://site.example.com', baseUrl: 'https://relay.example.com', apiKey: 'key-before', username: 'test', balanceCents: '1000' }
  let session: RoutingSession | null = null
  let serverKey = 'key-before'
  let preferences: BeginnerAiPreferences = { model: 'gpt-5.6-sol', reasoningLevel: 'high', fastMode: true }
  let current = { account: 'secondary', group: QUOTA_ROUTE_HINTS[0].group as string | null }
  let now = 100_000
  const log: string[] = [], requests: { url: string; body?: Record<string, unknown>; capability?: string | null }[] = []
  const options = { postStatus: 200, switchBeforeError: false, keyPending: false, frozen: false, failRecovery: false, saveSessionFails: false, saveCredentialsFails: false, omitModel: '', failNetwork: false, failPaidModels: false, missingFree: false, rejectSession: false, multiProviderSyncRequired: false, upgradeV2: false, extraModels: [] as string[],
    groupLabels: { Kimi: 'Kimi系列（200%标准价格）无缓存 K', Gemini: 'Gemini系列（标准价格）无缓存 M' } as Record<string, string>, freeLabel: '免费套餐',
    paidAccount: 'secondary', paidGroups: undefined as ProviderGroup[] | undefined, paidModels: {} as Record<string, string[]>, freeProviders: [] as Array<{account: string; label: string; models: string[]}> }
  const isFree = () => current.account.startsWith('trial:')
  const state = () => ({ ...current, current: current.group, keyStatus: options.keyPending ? 'PENDING' : options.frozen && !isFree() ? 'FROZEN' : 'ACTIVE', canSwitch: true, canSwitchProvider: true,
    providers: [{ account: 'primary', kind: 'paid', label: 'Supplier 1', groups: [{ id: 'old', label: 'old' }] }, { account: options.paidAccount, kind: 'paid', label: 'Supplier 2', groups: options.paidGroups ?? QUOTA_ROUTE_HINTS.map(r => ({ id: r.group, label: options.groupLabels[r.group] ?? r.group, models: [...r.models] })) },
      ...(!options.missingFree ? FREE_ROUTE_HINTS.map(r => ({ account: r.account, kind: 'free', label: options.freeLabel, groups: [] })) : []), ...options.freeProviders.map(p => ({ ...p, kind: 'free', groups: [] })), {account:'trial:openrouter',kind:'free',label:'login only',groups:[]} ] })
  const connection = () => ({ ...credentials!, apiKey: serverKey, ...current, balanceCents: isFree() ? '0' : '1000', baseUrl: isFree() ? 'https://site.example.com/api/trial/v1' : 'https://relay.example.com', keyStatus: options.keyPending ? 'PENDING' : 'ACTIVE' })
  const router = new QuotaModelRouting({
    readCredentials: async () => credentials,
    writeCredentials: async c => { if(options.saveCredentialsFails)throw new Error('disk unavailable'); log.push('credentials-saved'); credentials = c },
    readSession: async () => session,
    writeSession: async s => { if (options.saveSessionFails) throw new Error('disk unavailable'); log.push(s.pending ? 'pending-saved' : 'session-saved'); session = structuredClone(s) },
    clearSession: async () => { session = null },
    upgradeConnections: async () => { log.push('v2-connections-read'); return options.upgradeV2 },
    readPreferences: async () => preferences,
    applyModel: async (model, route) => { log.push('model-applied'); preferences = { ...preferences, model, reasoningLevel: 'auto', ...(route ? { account: route.account, billing: route.account.startsWith('trial:') ? 'free' : 'quota', group: route.group ?? undefined } : {}) }; return preferences },
    listModels: async c => { log.push('models-read'); if (options.failNetwork || options.failPaidModels && !isFree() || c.apiKey !== serverKey) throw new Error('unavailable'); return [...(isFree() ? options.freeProviders.find(p => p.account === current.account)?.models ?? FREE_ROUTE_HINTS.find(r => r.account === current.account)?.models ?? [] : options.paidModels[current.group ?? ''] ?? QUOTA_ROUTE_HINTS.find(r => r.group === current.group)?.models ?? []), 'codex-auto-review', 'gpt-image-2', ...options.extraModels].filter(id => id !== options.omitModel).map(id => ({ id })) },
    now: () => now,
    fetcher: (async (url, init) => {
      const endpoint = String(url), body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      requests.push({ url: endpoint, body, capability: new Headers(init?.headers).get('X-ModMind-Sync-Capabilities') })
      if (options.failNetwork) throw new Error('offline')
      const respond = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { success: true, data } : { success: false, message: 'key-before SHOULD NOT LEAK', ...(options.multiProviderSyncRequired ? { multiProviderSyncRequired:true } : {}) }), { status, headers: { 'Retry-After': '10' } })
      if (endpoint.endsWith('/session')) { log.push('session-created'); options.rejectSession = false; return respond({ routingToken: 'routing-secret', routingTokenExpiresAt: new Date(now + 30 * 24 * 3600_000).toISOString() }) }
      if (options.rejectSession && new Headers(init?.headers).get('Authorization') === 'Bearer routing-secret') return respond({}, 401)
      if (endpoint.includes('credentials=1')) { log.push('recovered'); if (options.failRecovery) return respond({}, 503); return respond({ ...state(), credentials: connection() }) }
      if (body) {
        log.push('route-post')
        expect(session?.pending).toBeTruthy()
        expect(body.expectedAccount).toBe(current.account)
        expect(body.expectedGroup).toBe(current.group)
        if (options.postStatus === 200 || options.switchBeforeError) { current = { account: typeof body.account === 'string' ? body.account : current.account, group: typeof body.group === 'string' ? body.group : null }; serverKey = 'key-after' }
        return respond(connection(), options.postStatus)
      }
      return respond(state())
    }) as typeof fetch
  })
  return { router, options, log, requests, current: () => current, preferences: () => preferences, session: () => session,
    tick: (ms: number) => { now += ms }, disconnect: () => { credentials = null },
    changeAccount: () => { credentials = { ...credentials!, username: 'another-user', apiKey: 'another-key' } },
    selectGroup: (group: string) => { current = { account: options.paidAccount, group } },
    selectFree: (account: string) => { current = { account, group: null }; credentials = { ...credentials!, account, group: null } } }
}

