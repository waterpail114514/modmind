import { describe, expect, it } from 'vitest'
import { routingFixture } from './__fixtures__/quotaRouting'
import { FREE_ROUTE_HINTS, quotaModelOptionKey } from '../shared/quotaModels'

describe('quota model routing', () => {
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
  it('lists paid families without mutation, credentials, image models or retired supplier', async () => {
    const f = routingFixture(), result = await f.router.catalog()
    expect(result.models.filter(m => m.billing === 'quota')).toHaveLength(17)
    expect(result.models.filter(m => m.billing === 'free')).toHaveLength(4)
    expect(result.models.find(m => m.id === 'kimi-k3')?.available).toBe(true)
    expect(f.log).not.toContain('route-post')
    expect(JSON.stringify(result)).not.toMatch(/key-before|routing-secret|primary|codex-auto-review|gpt-image/)
  })
  it('keeps the current route when it already contains the model', async () => {
    const f = routingFixture(), result = await f.router.select('gpt-6-astra')
    expect(result.status).toBe('ok'); expect(f.session()).toBeNull()
    expect(f.log).not.toContain('route-post'); expect(f.preferences().fastMode).toBe(true)
  })
  it('marks only routes explicitly advertised as no-cache and updates on refresh', async () => {
    const f = routingFixture(), catalog = await f.router.catalog()
    expect(catalog.models.filter(m => m.noCache).map(m => m.family)).toEqual(['Gemini', 'Gemini', 'Gemini', 'Gemini', 'Kimi'])
    expect(catalog.models.find(m => m.id === 'glm-5.3-flash')).not.toHaveProperty('noCache')
    f.options.groupLabels.Kimi = 'Kimi系列'
    expect((await f.router.catalog(true)).models.find(m => m.id === 'kimi-k3')).not.toHaveProperty('noCache')
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
    expect(catalog.models.find(m => m.id === 'glm-5.3' && m.billing === 'free')).not.toHaveProperty('noCache')
    f.options.freeLabel = '免费套餐 无缓存'
    expect((await f.router.catalog(true)).models.filter(m => m.billing === 'free').every(m => m.noCache)).toBe(true)
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
    const f = routingFixture(); await f.router.catalog(); f.options.failNetwork = true
    const offline = await f.router.catalog(true)
    expect(offline.stale).toBe(true); expect(offline.models).toHaveLength(21); expect(offline.canSwitch).toBe(false)
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
    expect((await f.router.select('gpt-6-astra')).status).toBe('ok')
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
  it('explicitly switches to a free model with no group, then back to a paid route', async () => {
    const f = routingFixture(), account = FREE_ROUTE_HINTS[0].account
    const initial = await f.router.catalog()
    expect(initial.models.find(m => m.id === 'deepseek-v4.1-flash')).toMatchObject({ billing: 'free', account, available: true })
    const free = await f.router.select('deepseek-v4.1-flash', { billing: 'free', account })
    expect(free.status).toBe('ok')
    expect(free.catalog).toMatchObject({ billing: 'free', currentRoute: { account, group: null }, currentOptionKey: quotaModelOptionKey('deepseek-v4.1-flash', 'free', account) })
    const request = f.requests.find(r => r.body?.account === account)
    expect(request?.body).not.toHaveProperty('group')
    expect(free.catalog.models.find(m => m.id === 'kimi-k3')?.available).toBe(true)
    const paid = await f.router.select('gpt-6.1-sol')
    expect(paid.status).toBe('ok'); expect(paid.catalog.billing).toBe('quota')
    expect(f.requests.filter(r => r.body?.account === 'secondary').at(-1)?.body).toMatchObject({expectedAccount:account,expectedGroup:null})
  })
  it('never silently converts a paid selection to a free version', async () => {
    const f = routingFixture()
    expect((await f.router.select('deepseek-v4.1-flash')).status).toBe('error')
    expect(f.log).not.toContain('route-post')
    await expect(f.router.select('deepseek-v4.1-flash', { billing: 'free', account: 'primary' })).rejects.toThrow('免费')
  })
  it('lists other route hints and switches even if the current route model list fails', async () => {
    const f = routingFixture(); f.options.failPaidModels = true
    const initial = await f.router.catalog()
    expect(initial.stale).toBe(false)
    expect(initial.models.find(m => m.id === 'deepseek-v4.1-flash')?.available).toBe(true)
    const result = await f.router.select('deepseek-v4.1-flash', { billing: 'free' })
    expect(result.status).toBe('ok')
    expect(result.catalog.billing).toBe('free')
  })
  it('permits an explicit free selection for a balance-frozen paid key and excludes the login-only provider', async () => {
    const f = routingFixture(); f.options.frozen = true; f.options.failPaidModels = true
    const catalog = await f.router.catalog()
    expect(catalog.models.find(m => m.id === 'gpt-6-astra')?.available).toBe(false)
    expect(catalog.models.find(m => m.id === 'deepseek-v4.1-flash')?.available).toBe(true)
    expect(catalog.models.some(m => m.account === 'trial:openrouter')).toBe(false)
    expect((await f.router.select('deepseek-v4.1-flash',{billing:'free'})).status).toBe('ok')
  })
  it('rejects free routes that the account does not expose', async () => {
    const f = routingFixture(); f.options.missingFree = true
    expect((await f.router.catalog()).models.find(m => m.id === 'deepseek-v4.1-flash')?.available).toBe(false)
    expect((await f.router.select('deepseek-v4.1-flash',{billing:'free'})).status).toBe('error')
    expect(f.log).not.toContain('route-post')
  })
  it('recovers and resumes the free edition after an ambiguous response', async () => {
    const f = routingFixture(); f.options.postStatus = 502; f.options.switchBeforeError = true; f.options.failRecovery = true
    const result = await f.router.select('deepseek-v4.1-flash',{billing:'free'})
    expect(result.status).toBe('error')
    expect(result.catalog.pendingSelection).toEqual({billing:'free',account:FREE_ROUTE_HINTS[0].account})
    f.options.failRecovery = false
    await f.router.resume()
    expect(f.preferences().model).toBe('deepseek-v4.1-flash')
    expect(f.log.filter(s => s === 'route-post')).toHaveLength(1)
  })
  it('keeps separate edition identities when the same exact ID is listed on a paid and free route', async () => {
    const f = routingFixture(); f.options.extraModels = ['glm-5.3']
    const initial = await f.router.catalog()
    expect(initial.models.filter(m => m.id === 'glm-5.3').map(m => m.billing).sort()).toEqual(['free','quota'])
    await f.router.select('glm-5.3',{billing:'free'})
    const free = await f.router.catalog()
    expect(free.currentOptionKey).not.toBe(quotaModelOptionKey('glm-5.3','quota'))
  })
})
