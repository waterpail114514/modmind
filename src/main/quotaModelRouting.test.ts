import { describe, expect, it } from 'vitest'
import { routingFixture } from './__fixtures__/quotaRouting'
import { FREE_ROUTE_HINTS, QUOTA_ROUTE_HINTS, quotaModelOptionKey } from '../shared/quotaModels'
import { createHash } from 'node:crypto'
import { QuotaModelRouting, type RoutingCredentials, type RoutingSession } from './quotaModelRouting'
import type { BeginnerAiPreferences } from '../shared/types'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function concurrentLegacyFixture() {
  let credentials: RoutingCredentials = { siteUrl: 'https://site.example', username: 'alice', apiKey: 'account-key', baseUrl: 'https://relay.example/v1', balanceCents: '1000', account: 'ls', group: '25' }
  let saved: RoutingSession | null = null
  let group = '25'
  let preferences: BeginnerAiPreferences = { model: 'future-a', reasoningLevel: 'auto', fastMode: false }
  const requests: Array<{ url: string; init: RequestInit }> = []
  const writes: RoutingSession[] = []
  const controls = { canSwitch: true, canSwitchProvider: true, ambiguousPost: false, failRecovery: false, onRequest: undefined as ((url: string, init: RequestInit) => Promise<Response | undefined>) | undefined }
  const accountOwner = () => createHash('sha256').update(`${credentials.siteUrl}\0${credentials.username}`).digest('hex')
  const session = (token = 'old-session'): RoutingSession => ({ owner: accountOwner(), token, expiresAt: 100_000 + 30 * 86400_000 })
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, data }), { status })
  const state = () => ({ account: 'ls', current: group, keyStatus: 'ACTIVE', canSwitch: controls.canSwitch, canSwitchProvider: controls.canSwitchProvider, providers: [
    { account: 'ls', kind: 'paid', label: 'LS', groups: [{ id: '25', label: 'Current', models: ['future-a'] }, { id: '99', label: 'Other', models: ['future-b'] }] },
    { account: 'primary', kind: 'paid', label: 'Other supplier', groups: [{ id: '77', label: 'Paid', models: ['future-b'] }] }
  ] })
  const router = new QuotaModelRouting({
    readCredentials: async () => structuredClone(credentials), writeCredentials: async value => { credentials = structuredClone(value) },
    readSession: async () => structuredClone(saved), writeSession: async value => { writes.push(structuredClone(value)); saved = structuredClone(value) }, clearSession: async () => { saved = null },
    listModels: async () => [{ id: group === '25' ? 'future-a' : 'future-b' }], readPreferences: async () => preferences,
    applyModel: async model => { preferences = { ...preferences, model }; return preferences }, now: () => 100_000,
    fetcher: (async (input, init = {}) => {
      const url = String(input); requests.push({ url, init })
      const intercepted = await controls.onRequest?.(url, init)
      if (intercepted) return intercepted
      if (url.endsWith('/session')) return json({ routingToken: 'fresh-session', routingTokenExpiresAt: new Date(session().expiresAt).toISOString() })
      if (url.includes('credentials=1')) return controls.failRecovery ? json({}, 503) : json({ ...state(), credentials: { ...credentials, account: 'ls', group } })
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)); group = body.group
        return json({ ...credentials, account: 'ls', group }, controls.ambiguousPost ? 502 : 200)
      }
      return json(state())
    }) as typeof fetch
  })
  return { router, controls, requests, writes, session, json, saved: () => structuredClone(saved), setSession: (value: RoutingSession | null) => { saved = structuredClone(value) }, changeOwner: () => { credentials = { ...credentials, username: 'bob', apiKey: 'bob-key' } } }
}

describe('quota model routing', () => {
  it.each([undefined, 'ls'])('requires an explicit group for ambiguous paid models without choosing a price tier (account=%s)', async account => {
    const f = routingFixture()
    f.options.paidAccount = 'ls'
    f.options.paidGroups = [{ id: '25', label: '当前', models: ['future-a'] }, { id: '99', label: '标准价格', models: ['future-b'] }, { id: '100', label: '较高价格', models: ['future-b'] }]
    f.options.paidModels = { '25': ['future-a'], '99': ['future-b'], '100': ['future-b'] }; f.selectGroup('25')
    const result = await f.router.select('future-b', { billing: 'quota', ...(account ? { account } : {}) })
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('明确选择') })
    expect(result.catalog.canSwitch).toBe(true)
    expect(f.current()).toEqual({ account: 'ls', group: '25' })
    expect(f.log).not.toContain('route-post'); expect(f.session()).toBeNull()
    // Choosing an exact row immediately after clarification must not hit a recovery cooldown.
    expect((await f.router.select('future-b', { billing: 'quota', account: 'ls', group: '99' })).status).toBe('ok')
    expect(f.current()).toEqual({ account: 'ls', group: '99' })
  })

  it('keeps verified non-current groups unavailable when switching is forbidden', async () => {
    const f = concurrentLegacyFixture(); f.controls.canSwitch = false; f.controls.canSwitchProvider = false
    const catalog = await f.router.catalog()
    expect(catalog.models.find(model => model.id === 'future-a' && model.account === 'ls' && model.group === '25')).toMatchObject({ modelEvidence: 'verified', available: true })
    expect(catalog.models.find(model => model.id === 'future-b' && model.account === 'ls')).toMatchObject({ modelEvidence: 'verified', available: false })
    expect(catalog.models.some(model => model.account === 'primary')).toBe(false)
    expect((await f.router.select('future-b', { account: 'ls', group: '99' })).status).toBe('error')
    expect(f.requests.some(request => request.init.method === 'POST')).toBe(false)
  })

  it('shares image session issuance with a paid switch and keeps an ambiguous switch pending', async () => {
    const f = concurrentLegacyFixture(), started = gate(), release = gate()
    f.controls.ambiguousPost = true; f.controls.failRecovery = true
    f.controls.onRequest = async url => { if (url.endsWith('/session')) { started.release(); await release.promise }; return undefined }
    const imageSession = f.router.routingToken(); await started.promise
    const selected = f.router.select('future-b', { account: 'ls', group: '99' })
    release.release()
    expect(await imageSession).toBe('fresh-session')
    expect((await selected).status).toBe('error')
    expect(f.requests.filter(request => request.url.endsWith('/session'))).toHaveLength(1)
    expect(f.saved()?.pending).toEqual({ model: 'future-b', route: { account: 'ls', group: '99' } })
  })

  it.each([false, true])('does not lose newer pending state after a delayed old-session 401 (replacement=%s)', async replacement => {
    const f = concurrentLegacyFixture(), started = gate(), release = gate()
    f.setSession(f.session())
    f.controls.onRequest = async (url, init) => {
      if (url.endsWith('/api/device/group') && new Headers(init.headers).get('Authorization') === 'Bearer old-session') { started.release(); await release.promise; return f.json({}, 401) }
      return undefined
    }
    const catalog = f.router.catalog(true); await started.promise
    const latest = { ...f.session(replacement ? 'replacement-session' : 'old-session'), pending: { model: 'future-b', route: { account: 'ls', group: '99' } } }
    f.setSession(latest); release.release(); await catalog
    expect(f.saved()?.pending).toEqual(latest.pending)
    expect(f.saved()?.token).toBe(latest.token)
    expect(f.saved()?.expiresAt).toBe(replacement ? latest.expiresAt : 0)
  })

  it('uses an already replaced session instead of overwriting it with a delayed issuance result', async () => {
    const f = concurrentLegacyFixture(), started = gate(), release = gate()
    f.controls.onRequest = async url => { if (url.endsWith('/session')) { started.release(); await release.promise }; return undefined }
    const token = f.router.routingToken(); await started.promise
    const latest = { ...f.session('replacement-session'), pending: { model: 'future-b', route: { account: 'ls', group: '99' } } }
    f.setSession(latest); release.release()
    expect(await token).toBe('replacement-session')
    expect(f.saved()).toEqual(latest)
    expect(f.writes).toHaveLength(0)
  })

  it('does not save a late routing session after the user changed accounts', async () => {
    const f = concurrentLegacyFixture(), started = gate(), release = gate()
    f.controls.onRequest = async url => { if (url.endsWith('/session')) { started.release(); await release.promise }; return undefined }
    const token = f.router.routingToken(); await started.promise
    f.changeOwner(); release.release()
    await expect(token).rejects.toThrow('账号已切换')
    expect(f.saved()).toBeNull(); expect(f.writes).toHaveLength(0)
  })

  it('discovers LS numeric groups and future model IDs without borrowing another suppliers hints', async () => {
    const f = routingFixture()
    f.options.paidAccount = 'ls'
    f.options.paidGroups = [{ id: '25', label: '默认组', models: ['new-chat-a'] }, { id: '26', label: '稳定组', models: ['new-chat-b'] }, { id: 'Gemini', label: 'Gemini' }]
    f.options.paidModels = { '25': ['new-chat-a'], '26': ['new-chat-b'] }
    f.selectGroup('25')
    const catalog = await f.router.catalog()
    expect([...new Set(catalog.models.filter(m => m.account === 'ls').map(m => m.id))]).toEqual(['new-chat-a', 'new-chat-b'])
    expect(catalog.routes?.find(r => r.account === 'ls' && r.group === '26')).toMatchObject({ label: '稳定组', available: true })
    expect((await f.router.select('new-chat-b', { account: 'ls', billing: 'quota' })).status).toBe('ok')
    expect(f.current()).toEqual({ account: 'ls', group: '26' })
    expect(f.requests.every(r => r.capability === 'provider-ls')).toBe(true)
  })
  it('distinguishes one model on two groups and stays on the current group unless a group is selected', async () => {
    const f = routingFixture()
    f.options.paidAccount = 'ls'
    f.options.paidGroups = [{ id: '25', label: '标准组', models: ['same-model'] }, { id: '99', label: '优选组 无缓存', models: ['same-model'] }]
    f.options.paidModels = { '25': ['same-model'], '99': ['same-model'] }; f.selectGroup('25')
    const catalog = await f.router.catalog()
    const options = catalog.models.filter(m => m.id === 'same-model' && m.account === 'ls')
    expect(options).toHaveLength(2)
    expect(new Set(options.map(m => m.optionKey)).size).toBe(2)
    expect(options.find(m => m.group === '25')).not.toHaveProperty('noCache')
    expect(options.find(m => m.group === '99')).toMatchObject({ noCache: true, groupLabel: '优选组 无缓存' })
    expect(catalog.models.some(m => m.account === 'primary')).toBe(false)
    await f.router.select('same-model', { account: 'ls', billing: 'quota' })
    expect(f.log).not.toContain('route-post')
    const result = await f.router.select('same-model', { account: 'ls', billing: 'quota', group: '99' })
    expect(result.catalog.currentOptionKey).toBe(options.find(m => m.group === '99')?.optionKey)
    expect(f.current()).toEqual({ account: 'ls', group: '99' })
  })
  it('rejects an unverified group before switching and leaves preferences unchanged', async () => {
    const f = routingFixture()
    f.options.paidAccount = 'ls'
    f.options.paidGroups = [{ id: '25', label: '当前' }, { id: '99', label: '新组' }]
    f.options.paidModels = { '25': ['gpt-6-astra'], '99': ['upstream-new-model'] }
    f.selectGroup('25')
    const result = await f.router.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: '99' })
    expect(result.status).toBe('error')
    expect(f.preferences().model).toBe('gpt-5.6-sol')
    expect(result.message).toContain('尚未验证')
    expect(f.log).not.toContain('route-post')
    expect(f.session()?.pending).toBeUndefined()
  })
  it('shows a newly synchronized free provider without using a baked-in provider ID', async () => {
    const f = routingFixture()
    f.options.freeProviders = [{ account: 'trial:new-provider', label: '新增免费', models: ['future-free-model'] }]
    f.selectFree('trial:new-provider')
    expect((await f.router.catalog()).models.find(m => m.id === 'future-free-model')).toMatchObject({ account: 'trial:new-provider', billing: 'free', available: true })
    expect((await f.router.select('future-free-model', { account: 'trial:new-provider', billing: 'free' })).status).toBe('ok')
    expect(f.current()).toEqual({ account: 'trial:new-provider', group: null })
  })
  it('keeps an ambiguous exact choice pending rather than substituting another model', async () => {
    const f = routingFixture()
    f.options.paidAccount = 'ls'; f.options.paidGroups = [{ id: '25', label: '当前' }, { id: '99', label: '新组', models: ['gpt-6-astra'] }]
    f.options.paidModels = { '25': ['gpt-6-astra'], '99': ['future-model'] }; f.selectGroup('25')
    f.options.postStatus = 502; f.options.switchBeforeError = true; f.options.failRecovery = true
    expect((await f.router.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: '99' })).status).toBe('error')
    f.options.failRecovery = false
    await expect(f.router.resume()).rejects.toThrow('尚未完成')
    expect(f.preferences().model).toBe('gpt-5.6-sol')
    expect(f.log.filter(s => s === 'route-post')).toHaveLength(1)
  })
  it('recognizes v2-required 409 without leaving false pending recovery or a recovery cooldown',async()=>{
    const f=routingFixture();f.options.postStatus=409;f.options.multiProviderSyncRequired=true
    const result=await f.router.select('kimi-k3')
    expect(result.status).toBe('error');expect(result.message).toContain('官网')
    expect(f.session()?.pending).toBeUndefined()
    expect(f.log).not.toContain('recovered')
    await expect(f.router.select('gpt-6-astra')).resolves.toMatchObject({status:'ok'})
    expect(JSON.stringify(result)).not.toContain('key-before')
  })
  it('signals a successful v2 connection upgrade so the caller can refresh the catalog rather than replay the old POST',async()=>{
    const f=routingFixture();f.options.postStatus=409;f.options.multiProviderSyncRequired=true;f.options.upgradeV2=true
    const result=await f.router.select('kimi-k3')
    expect(result.requiresProviderSync).toBe(true)
    expect(f.log.filter(x=>x==='route-post')).toHaveLength(1)
    expect(f.log).toContain('v2-connections-read')
    expect(f.session()?.pending).toBeUndefined()
  })
  it('lists paid families without mutation, credentials or image models', async () => {
    const f = routingFixture(), result = await f.router.catalog()
    expect(new Set(result.models.filter(m => m.billing === 'quota').map(m => m.id)).size).toBe(17)
    expect(new Set(result.models.map(m => m.optionKey)).size).toBe(result.models.length)
    expect(result.models.filter(m => m.billing === 'free')).toHaveLength(0)
    expect(result.models.find(m => m.id === 'kimi-k3')?.available).toBe(true)
    expect(f.log).not.toContain('route-post')
    expect(JSON.stringify(result)).not.toMatch(/key-before|routing-secret|codex-auto-review|gpt-image/)
    expect(result.routes?.some(r => r.account === 'primary')).toBe(false)
  })
  it('keeps the current route when it already contains the model', async () => {
    const f = routingFixture(), result = await f.router.select('gpt-6-astra')
    expect(result.status).toBe('ok'); expect(f.session()).toBeNull()
    expect(f.log).not.toContain('route-post'); expect(f.preferences().fastMode).toBe(true)
  })
  it('marks only routes explicitly advertised as no-cache and updates on refresh', async () => {
    const f = routingFixture(), catalog = await f.router.catalog()
    expect(catalog.models.filter(m => m.noCache).every(m => m.group === 'Gemini' || m.group === 'Kimi')).toBe(true)
    expect(catalog.models.find(m => m.id === 'glm-5.3-flash' && m.group === 'GLM')).not.toHaveProperty('noCache')
    f.options.groupLabels.Kimi = 'Kimi系列'
    expect((await f.router.catalog(true)).models.find(m => m.id === 'kimi-k3' && m.group === 'Kimi')).not.toHaveProperty('noCache')
  })
  it('uses the actual current route rather than a different hinted route for the cache mark', async () => {
    const f = routingFixture()
    f.options.extraModels = ['kimi-k3']
    expect((await f.router.catalog()).models.find(m => m.id === 'kimi-k3')).not.toHaveProperty('noCache')
    await f.router.select('kimi-k3')
    expect(f.log).not.toContain('route-post')
    f.options.extraModels = []
    const switched = await f.router.select('kimi-k3')
    expect(switched.catalog.models.find(m => m.id === 'kimi-k3')).toMatchObject({ noCache: true })
  })
  it('keeps free and paid cache declarations separate even for the same model ID', async () => {
    const f = routingFixture()
    f.options.extraModels = ['glm-5.3']
    f.options.groupLabels['gpt-pro（混池）'] = '测试线路 无缓存'
    const catalog = await f.router.catalog()
    expect(catalog.models.find(m => m.id === 'glm-5.3' && m.billing === 'quota')).toMatchObject({ noCache: true })
    expect(catalog.models.some(m => m.billing === 'free')).toBe(false)
    const free = routingFixture(); free.selectFree(FREE_ROUTE_HINTS[0].account)
    expect((await free.router.catalog()).models.find(m => m.id === 'glm-5.3' && m.billing === 'free')).not.toHaveProperty('noCache')
    free.options.freeLabel = '免费套餐 无缓存'
    expect((await free.router.catalog(true)).models.filter(m => m.billing === 'free').every(m => m.noCache)).toBe(true)
  })
  it('durably saves recovery session before switch, then verifies exact ID before preferences', async () => {
    const f = routingFixture(), result = await f.router.select('kimi-k3')
    expect(result.status).toBe('ok'); expect(f.preferences().model).toBe('kimi-k3')
    expect(f.current()).toEqual({ account: 'secondary', group: 'Kimi' })
    expect(f.log.indexOf('pending-saved')).toBeLessThan(f.log.indexOf('route-post'))
    expect(f.log.indexOf('credentials-saved')).toBeLessThan(f.log.lastIndexOf('models-read'))
    expect(f.log.lastIndexOf('models-read')).toBeLessThan(f.log.indexOf('model-applied'))
    expect(f.session()?.pending).toBeUndefined()
  })
  it('does not switch when secure session persistence fails', async () => {
    const f = routingFixture(); f.options.saveSessionFails = true
    expect((await f.router.select('kimi-k3')).status).toBe('error'); expect(f.log).not.toContain('route-post')
  })
  it('recovers a successful remote switch after a 502 without posting twice', async () => {
    const f = routingFixture(); f.options.postStatus = 502; f.options.switchBeforeError = true
    expect((await f.router.select('kimi-k3')).status).toBe('ok')
    expect(f.log.filter(s => s === 'route-post')).toHaveLength(1); expect(f.log).toContain('recovered')
  })
  it('retains pending recovery and blocks resume when target credentials are unconfirmed', async () => {
    const f = routingFixture(); f.options.postStatus = 502; f.options.failRecovery = true
    expect((await f.router.select('kimi-k3')).status).toBe('error')
    expect(await f.router.recoveryRequired()).toBe(true)
    await expect(f.router.resume()).rejects.toThrow()
    expect(f.preferences().model).toBe('gpt-5.6-sol')
  })
  it('rejects stale hinted model availability instead of saving an unsupported model', async () => {
    const f = routingFixture(); f.options.omitModel = 'kimi-k3'
    const result = await f.router.select('kimi-k3')
    expect(result.status).toBe('error'); expect(result.message).toContain('没有返回')
    expect(f.preferences().model).toBe('gpt-5.6-sol'); expect(await f.router.recoveryRequired()).toBe(true)
    f.options.omitModel = ''; await f.router.resume(); expect(f.preferences().model).toBe('kimi-k3')
  })
  it('honors rate-limit cooldown and never leaks reflected upstream error text', async () => {
    const f = routingFixture(); f.options.postStatus = 429
    const result = await f.router.select('kimi-k3')
    expect(result.status).toBe('error'); expect(JSON.stringify(result)).not.toContain('key-before')
    f.tick(5000); await expect(f.router.select('kimi-k3')).rejects.toThrow('稍后')
    f.tick(6000); f.options.postStatus = 200; expect((await f.router.select('kimi-k3')).status).toBe('ok')
  })
  it('invalidates catalogue across accounts and preserves usable offline display', async () => {
    const f = routingFixture(); const initial = await f.router.catalog(); f.options.failNetwork = true
    const offline = await f.router.catalog(true)
    expect(offline.stale).toBe(true); expect(offline.models).toHaveLength(initial.models.length); expect(offline.canSwitch).toBe(false)
    f.changeAccount(); expect((await f.router.catalog()).checkedAt).toBeNull()
    f.disconnect(); expect((await f.router.catalog()).connected).toBe(false)
  })
  it('rejects helper IDs and concurrent switches', async () => {
    const f = routingFixture()
    await expect(f.router.select('codex-auto-review')).rejects.toThrow('有效')
    const first = f.router.select('kimi-k3')
    await expect(f.router.select('gpt-6-astra')).rejects.toThrow('正在切换')
    expect((await first).status).toBe('ok')
  })
  it('renews a revoked routing session with the still-valid model key', async () => {
    const f = routingFixture(); await f.router.select('kimi-k3'); f.options.rejectSession = true
    expect((await f.router.select('gpt-6-astra', { account: 'secondary', group: QUOTA_ROUTE_HINTS[0].group })).status).toBe('ok')
    expect(f.log.filter(s => s === 'session-created')).toHaveLength(2)
  })
  it('exposes a recoverable pending selection when local key persistence fails after a remote switch', async () => {
    const f = routingFixture(); f.options.saveCredentialsFails = true
    expect((await f.router.select('kimi-k3')).status).toBe('error')
    const catalog = await f.router.catalog(true)
    expect(catalog).toMatchObject({ recoveryRequired: true, pendingModel: 'kimi-k3' })
    f.options.saveCredentialsFails = false; f.tick(4000)
    expect((await f.router.select(catalog.pendingModel!)).status).toBe('ok')
    expect(f.log.filter(s => s === 'route-post')).toHaveLength(1)
    expect(f.preferences().model).toBe('kimi-k3')
  })
  it('selects an already synchronized free tuple and rejects unsynchronized supplier changes', async () => {
    const f = routingFixture(), account = FREE_ROUTE_HINTS[0].account
    expect((await f.router.catalog()).models.some(m => m.billing === 'free')).toBe(false)
    expect((await f.router.select('deepseek-v4.1-flash', { billing: 'free', account })).status).toBe('error')
    expect(f.log).not.toContain('route-post')
    f.tick(4000); f.selectFree(account)
    const initial = await f.router.catalog(true)
    expect(initial.models.find(m => m.id === 'deepseek-v4.1-flash')).toMatchObject({ billing: 'free', account, available: true })
    const free = await f.router.select('deepseek-v4.1-flash', { billing: 'free', account })
    expect(free.status).toBe('ok')
    expect(free.catalog).toMatchObject({ billing: 'free', currentRoute: { account, group: null }, currentOptionKey: quotaModelOptionKey('deepseek-v4.1-flash', 'free', account) })
    expect(free.catalog.models.some(m => m.billing === 'quota')).toBe(false)
    const paid = await f.router.select('gpt-6.1-sol', { account: 'secondary', group: QUOTA_ROUTE_HINTS[1].group })
    expect(paid.status).toBe('error')
    expect(f.log).not.toContain('route-post')
  })
  it('never silently converts a paid selection to a free version', async () => {
    const f = routingFixture()
    expect((await f.router.select('deepseek-v4.1-flash')).status).toBe('error')
    expect(f.log).not.toContain('route-post')
    await expect(f.router.select('deepseek-v4.1-flash', { billing: 'free', account: 'primary' })).rejects.toThrow('免费')
  })
  it('does not offer disconnected free fallback when the paid model endpoint fails', async () => {
    const f = routingFixture(); f.options.failPaidModels = true
    const initial = await f.router.catalog()
    expect(initial.stale).toBe(false)
    expect(initial.models.some(m => m.billing === 'free')).toBe(false)
    const result = await f.router.select('deepseek-v4.1-flash', { billing: 'free' })
    expect(result.status).toBe('error')
    expect(f.log).not.toContain('route-post')
  })
  it('excludes unconnected free suppliers for a frozen paid tuple', async () => {
    const f = routingFixture(); f.options.frozen = true; f.options.failPaidModels = true
    const catalog = await f.router.catalog()
    expect(catalog.models.find(m => m.id === 'gpt-6-astra')?.available).toBe(false)
    expect(catalog.models.some(m => m.billing === 'free')).toBe(false)
    expect(catalog.models.some(m => m.account === 'trial:openrouter')).toBe(false)
    expect((await f.router.select('deepseek-v4.1-flash',{billing:'free'})).status).toBe('error')
    expect(f.log).not.toContain('route-post')
  })
  it('rejects free routes that the account does not expose', async () => {
    const f = routingFixture(); f.options.missingFree = true
    expect((await f.router.catalog()).models.some(m => m.billing === 'free')).toBe(false)
    expect((await f.router.select('deepseek-v4.1-flash',{billing:'free'})).status).toBe('error')
    expect(f.log).not.toContain('route-post')
  })
  it('rejects an unconnected free edition without opening recovery state', async () => {
    const f = routingFixture(); f.options.postStatus = 502; f.options.switchBeforeError = true; f.options.failRecovery = true
    const result = await f.router.select('deepseek-v4.1-flash',{billing:'free'})
    expect(result.status).toBe('error')
    expect(result.catalog.pendingSelection).toBeUndefined()
    expect(f.preferences().model).toBe('gpt-5.6-sol')
    expect(f.log).not.toContain('route-post')
  })
  it('keeps separate edition identities when the same exact ID is listed on a paid and free route', async () => {
    const f = routingFixture(); f.options.extraModels = ['glm-5.3']
    const initial = await f.router.catalog()
    expect([...new Set(initial.models.filter(m => m.id === 'glm-5.3').map(m => m.billing))]).toEqual(['quota'])
    f.selectFree(FREE_ROUTE_HINTS[0].account)
    await f.router.select('glm-5.3',{billing:'free',account:FREE_ROUTE_HINTS[0].account})
    const free = await f.router.catalog()
    expect(free.currentOptionKey).not.toBe(quotaModelOptionKey('glm-5.3','quota'))
  })
})
