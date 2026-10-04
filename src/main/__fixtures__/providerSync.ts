import { vi } from 'vitest'
import { parseProviderSnapshot, ProviderSyncService, providerOwnerKey, type ProviderOwner, type ProviderSnapshot } from '../providerSync'
import type { RoutingSession } from '../quotaModelRouting'
import type { BeginnerAiPreferences } from '../../shared/types'

export function providerFixture() {
  const snapshot: ProviderSnapshot = parseProviderSnapshot({ protocolVersion: 2, selectionRevision: 4, defaultAccount: 'secondary', connections: [
    { account: 'secondary', label: '付费', kind: 'paid', baseUrl: 'https://paid.example', inferenceBaseUrl: 'https://paid.example/v1', apiKey: 'paid-secret', model: null, group: 'gpt-pro（混池）' },
    ...['one','two'].map(id => ({ account: `trial:${id}`, label: id, kind: 'free', baseUrl: 'https://site.example/api/trial/v1', inferenceBaseUrl: 'https://site.example/api/trial/v1', apiKey: `free-secret-${id}`, models: ['deepseek-v4.1-flash','qwen3.8-flash'], group: null }))
  ] })
  let owner: ProviderOwner = { siteUrl: 'https://site.example', username: 'alice', sync: snapshot }
  let preferences: BeginnerAiPreferences = { model: 'gpt-6-astra', account: 'secondary', billing: 'quota', reasoningLevel: 'high', fastMode: false }
  let session: RoutingSession | null = null
  const network: Array<{ url: string; init?: RequestInit }> = []
  const flags = { busy: false, offline: false, failWrite: false, next: snapshot, listFail: false, groupPostStatus: 200, failRecovery: false, changeUserOnRefresh: false, sessionDefaultFree: false }
  const writes = vi.fn(async (previous: ProviderOwner, next: ProviderSnapshot) => {
    if (flags.failWrite || providerOwnerKey(previous) !== providerOwnerKey(owner) || JSON.stringify(owner.sync) !== JSON.stringify(previous.sync)) throw new Error('账号已切换或写入失败')
    owner = { ...owner, sync: structuredClone(next) }
  })
  const service = new ProviderSyncService({ read: async () => owner, write: writes, readSession: async () => session, writeSession: async s => { session = s },
    readPreferences: async () => preferences, applyDefaults: async selection => { preferences = { ...preferences, ...selection }; return preferences }, paidBusy: () => flags.busy,
    listModels: async c => { if (flags.listFail) throw new Error('offline'); return (c.kind === 'free' ? c.models ?? [] : c.group === 'Gemini' ? ['gemini-3.8-flash'] : ['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']).map(id => ({ id })) },
    fetcher: (async (url, init) => {
      network.push({ url: String(url), init }); if (flags.offline) throw new Error('offline')
      let data: unknown = {}
      if (String(url).endsWith('/session')) data = { routingToken: 'session-secret', routingTokenExpiresAt: new Date(Date.now()+86400000).toISOString() }
      else if (String(url).includes('/providers')) {
        if (flags.failRecovery) return new Response('{}',{status:503})
        if (flags.changeUserOnRefresh) owner = { ...owner, username:'bob' }
        data = flags.next
      }
      else if (String(url).includes('/group')) {
        if (flags.sessionDefaultFree && new Headers(init?.headers).get('Authorization') === 'Bearer session-secret') {
          return new Response(JSON.stringify({success:true,data:{account:'trial:one',current:null,canSwitch:false,providers:[]}}))
        }
        if (init?.method === 'POST') {
          const body=JSON.parse(String(init.body))
          flags.next={...owner.sync,connections:owner.sync.connections.map(c=>c.kind==='paid'?{...c,group:body.group,models:undefined}:c)}
          if (flags.groupPostStatus!==200) return new Response('{}',{status:flags.groupPostStatus})
        }
        data = { account: 'secondary', current: 'gpt-pro（混池）', canSwitch: true, providers: [{ account: 'secondary', groups: [{ id: 'Gemini' }] }] }
      }
      return new Response(JSON.stringify({ success: true, data }))
    }) as typeof fetch
  })
  return { service, flags, network, writes, owner: () => owner, preferences: () => preferences, setOwner: (value: ProviderOwner) => { owner = value }, session: () => session }
}
