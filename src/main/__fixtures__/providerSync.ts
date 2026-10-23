import { vi } from 'vitest'
import { parseProviderSnapshot, ProviderSyncService, providerOwnerKey, type ProviderOwner, type ProviderSnapshot, type ProviderConnection, type ProviderModelDiscovery } from '../providerSync'
import type { RoutingSession } from '../quotaModelRouting'
import type { AiModelInfo, BeginnerAiPreferences } from '../../shared/types'

export function providerFixture(paidAccount = 'secondary') {
  const snapshot: ProviderSnapshot = parseProviderSnapshot({ protocolVersion: 2, selectionRevision: 4, defaultAccount: paidAccount, connections: [
    { account: paidAccount, label: '付费', kind: 'paid', baseUrl: 'https://paid.example', inferenceBaseUrl: 'https://paid.example/v1', apiKey: 'paid-secret', model: null, group: 'gpt-pro（混池）' },
    ...['one','two'].map(id => ({ account: `trial:${id}`, label: id, kind: 'free', baseUrl: 'https://site.example/api/trial/v1', inferenceBaseUrl: 'https://site.example/api/trial/v1', apiKey: `free-secret-${id}`, models: ['deepseek-v4.1-flash','qwen3.8-flash'], group: null }))
  ] })
  let owner: ProviderOwner = { siteUrl: 'https://site.example', username: 'alice', sync: snapshot }
  let preferences: BeginnerAiPreferences = { model: 'gpt-6-astra', account: paidAccount, billing: 'quota', reasoningLevel: 'high', fastMode: false }
  let session: RoutingSession | null = null
  let discovery: ProviderModelDiscovery | null = null
  let now = Date.now()
  const network: Array<{ url: string; init?: RequestInit }> = []
  const flags = { busy: false, busyAccounts: [] as string[], offline: false, failWrite: false, next: snapshot, listFail: false, groupPostStatus: 200, groupPostAppliedOn409: false, crossProviderRequired: false, canSwitchProvider: true, failRecovery: false, changeUserOnRefresh: false, sessionDefaultFree: false, discoveryWriteFail: false, rotatePaidKeys: false, onGroupPost: undefined as ((group: string) => void) | undefined, sessionGate: undefined as Promise<void> | undefined, sessionWriteGate: undefined as Promise<void> | undefined, remoteRoute: undefined as { account: string; group: string | null } | undefined }
  const groups: Array<Record<string, unknown>> = [{ id: 'Gemini', models: ['gemini-3.8-flash'] }]
  const providers: Array<Record<string, unknown>> = [{ account: paidAccount, label: '付费', kind: 'paid', groups }]
  const modelsByGroup: Record<string, AiModelInfo[]> = {}
  const modelsByRoute: Record<string, AiModelInfo[]> = {}
  const listModels = vi.fn(async (c: ProviderConnection): Promise<AiModelInfo[]> => { if (flags.listFail) throw new Error('offline'); return c.kind === 'paid' && (modelsByRoute[`${c.account}:${c.group}`] ?? modelsByGroup[c.group ?? '']) ? modelsByRoute[`${c.account}:${c.group}`] ?? modelsByGroup[c.group ?? ''] : (c.kind === 'free' ? c.models ?? [] : c.group === 'Gemini' ? ['gemini-3.8-flash'] : ['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']).map(id => ({ id })) })
  const writeSession = vi.fn(async (s: RoutingSession) => { if (flags.sessionWriteGate) await flags.sessionWriteGate; session = s })
  const writes = vi.fn(async (previous: ProviderOwner, next: ProviderSnapshot) => {
    if (flags.failWrite || providerOwnerKey(previous) !== providerOwnerKey(owner) || JSON.stringify(owner.sync) !== JSON.stringify(previous.sync)) throw new Error('账号已切换或写入失败')
    owner = { ...owner, sync: structuredClone(next) }
  })
  const writeDiscovery = vi.fn(async (value: ProviderModelDiscovery) => { if (flags.discoveryWriteFail) throw new Error('disk full'); discovery = structuredClone(value) })
  const deps = { read: async () => owner, write: writes, readSession: async () => session, writeSession, now: () => now,
    authorizationBusy: () => authorization.busy,
    readDiscovery: async () => discovery, writeDiscovery,
    readPreferences: async () => preferences, applyDefaults: async selection => { preferences = { ...preferences, ...selection }; return preferences }, paidBusy: account => flags.busy || flags.busyAccounts.includes(account),
    listModels,
    fetcher: (async (url, init) => {
      network.push({ url: String(url), init }); if (flags.offline) throw new Error('offline')
      let data: unknown = {}
      if (String(url).endsWith('/session')) { if (flags.sessionGate) await flags.sessionGate; data = { routingToken: 'session-secret', routingTokenExpiresAt: new Date(Date.now()+86400000).toISOString() } }
      else if (String(url).includes('/providers')) {
        if (flags.failRecovery) return new Response('{}',{status:503})
        if (flags.changeUserOnRefresh) owner = { ...owner, username:'bob' }
        data = flags.next
      }
      else if (String(url).includes('/group')) {
        if (init?.method !== 'POST' && flags.sessionDefaultFree && new Headers(init?.headers).get('Authorization') === 'Bearer session-secret') {
          return new Response(JSON.stringify({success:true,data:{account:'trial:one',current:null,canSwitch:false,providers:[]}}))
        }
        if (init?.method === 'POST') {
          const body=JSON.parse(String(init.body))
          if (body.account && flags.crossProviderRequired) return new Response(JSON.stringify({ success: false, multiProviderSyncRequired: true }), { status: 409 })
          if (flags.groupPostStatus >= 400 && flags.groupPostStatus < 500 && !(flags.groupPostStatus === 409 && flags.groupPostAppliedOn409)) return new Response('{}', { status: flags.groupPostStatus })
          flags.next={...owner.sync,defaultAccount:body.account??owner.sync.defaultAccount,connections:owner.sync.connections.map(c=>c.kind==='paid'?{...c,...(body.account?{account:body.account,apiKey:'target-paid-secret'}:{}),...(flags.rotatePaidKeys?{apiKey:`paid-group-secret-${body.group}`} : {}),group:body.group,models:undefined}:c)}
          flags.onGroupPost?.(body.group)
          if (flags.groupPostStatus!==200) return new Response('{}',{status:flags.groupPostStatus})
        }
        const paid = flags.next.connections.find(c => c.kind === 'paid')!
        data = { account: flags.remoteRoute?.account ?? paid.account, current: flags.remoteRoute ? flags.remoteRoute.group : paid.group, canSwitch: true, canSwitchProvider: flags.canSwitchProvider, providers }
      }
      return new Response(JSON.stringify({ success: true, data }))
    }) as typeof fetch
  } satisfies ConstructorParameters<typeof ProviderSyncService>[0]
  const authorization = { busy: false }
  const service = new ProviderSyncService(deps)
  return { service, restart: () => new ProviderSyncService(deps), authorization, flags, groups, providers, modelsByGroup, modelsByRoute, listModels, writeSession, writeDiscovery, network, writes, owner: () => owner, preferences: () => preferences, setOwner: (value: ProviderOwner) => { owner = value; flags.next = value.sync }, session: () => session, setSession: (value: RoutingSession) => { session = value }, discovery: () => discovery, setDiscovery: (value: ProviderModelDiscovery) => { discovery = value }, tick: (ms: number) => { now += ms } }
}
