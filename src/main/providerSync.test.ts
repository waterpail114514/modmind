import { describe, expect, it, vi } from 'vitest'
import { parseProviderSnapshot, providerOwnerKey, reconcileProviderSync } from './providerSync'
import { providerFixture } from './__fixtures__/providerSync'

describe('provider sync v2', () => {
  it('replaces server inventories including removals and persists route labels', async () => {
    const f = providerFixture('ls'), group = f.owner().sync.connections[0].group!
    f.groups.splice(0, f.groups.length, { id: group, label: '完整主线路' }, { id: '74', label: '另一条线路' })
    f.modelsByGroup[group] = [{ id: 'main-model', name: '主模型' }, { id: 'hidden-model', description: '完整刷新发现的模型' }]
    f.modelsByGroup['74'] = [{ id: 'other-route-model' }]
    await f.service.discoverModels()
    f.modelsByGroup[group] = [{ id: 'main-model', name: 'Key 扫描不应覆盖原名称' }, { id: 'new-key-model' }]
    const catalog = await f.service.catalog(true)
    expect(catalog.models.map(m => m.id)).toEqual(expect.arrayContaining(['main-model', 'new-key-model', 'other-route-model']))
    expect(catalog.models.some(m => m.id === 'hidden-model')).toBe(false)
    expect(f.discovery()!.entries.find(e => e.group === group)!.models.map(m => m.id)).toEqual(['main-model', 'new-key-model'])
    const calls = f.listModels.mock.calls.length, requests = f.network.length
    const saved = await f.restart().catalog(false, true)
    expect(saved.models.find(m => m.id === 'other-route-model')).toMatchObject({ group: '74', groupLabel: '另一条线路' })
    expect(saved.models.some(m => m.id === 'new-key-model')).toBe(true)
    expect(f.listModels).toHaveBeenCalledTimes(calls)
    expect(f.network).toHaveLength(requests)
  })

  it('replaces the saved inventory only after a complete refresh, including removals', async () => {
    const f = providerFixture('ls'), group = f.owner().sync.connections[0].group!
    f.groups.splice(0, f.groups.length, { id: group }, { id: '74' })
    f.modelsByGroup[group] = [{ id: 'previous-model' }]; f.modelsByGroup['74'] = [{ id: 'previous-route-model' }]
    await f.service.discoverModels()
    f.tick(16_000)
    f.groups.splice(0, f.groups.length, { id: group })
    f.modelsByGroup[group] = [{ id: 'replacement-model' }]
    const refreshed = await f.service.discoverModels()
    expect(refreshed.models.map(m => m.id)).toContain('replacement-model')
    expect(refreshed.models.some(m => m.id.startsWith('previous-'))).toBe(false)
    expect((await f.restart().catalog(false, true)).models.some(m => m.id.startsWith('previous-'))).toBe(false)
  })

  it("retains the last successful catalog when a server group is not ready and reopens offline", async () => {
    const f = providerFixture('ls'), group = f.owner().sync.connections[0].group!
    f.groups.splice(0, f.groups.length, { id: group }, { id: '74' })
    f.modelsByGroup[group] = [{ id: 'complete-model' }]; f.modelsByGroup['74'] = [{ id: 'complete-route-model' }]
    await f.service.discoverModels()
    f.catalog.unavailable.add('ls:74')
    const result = await f.service.discoverModels()
    expect(result.stale).toBe(true)
    expect(result.models.map(m => m.id)).toEqual(expect.arrayContaining(['complete-model', 'complete-route-model']))
    f.flags.offline = true
    expect((await f.restart().catalog(false, true)).models.map(m => m.id)).toEqual(expect.arrayContaining(['complete-model', 'complete-route-model']))
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })

  it('never shows another account inventory', async () => {
    const f = providerFixture('ls')
    await f.service.discoverModels()
    f.setOwner({ ...f.owner(), username: 'another-user' })
    const catalog = await f.restart().catalog(false, true)
    expect(catalog.models.some(m => m.billing === 'quota')).toBe(false)
    expect(catalog.providers?.some(p => p.account === 'ls')).toBe(true)
  })

  it('reads the complete inventory from older cache files without needing network directory labels', async () => {
    const f = providerFixture('ls')
    await f.service.discoverModels()
    const { directory: _directory, ...legacy } = f.discovery()!
    f.setDiscovery(legacy)
    const calls = f.listModels.mock.calls.length, requests = f.network.length
    const cached = await f.restart().catalog(false, true)
    expect(cached.models.find(m => m.id === 'gemini-3.8-flash')).toMatchObject({ group: 'Gemini' })
    expect(f.listModels).toHaveBeenCalledTimes(calls)
    expect(f.network).toHaveLength(requests)
  })

  it('does not let a delayed catalog response cross an account change', async () => {
    const f = providerFixture('ls')
    f.listModels.mockImplementationOnce(async () => { f.setOwner({ ...f.owner(), username: 'another-user' }); return [{ id: 'previous-user-model' }] })
    await expect(f.service.catalog()).rejects.toThrow('账号已切换')
    expect(f.discovery()).toBeNull()
    expect((await f.service.catalog(false, true)).models.some(m => m.id === 'previous-user-model')).toBe(false)
  })

  it('persists models scanned from a free Key when its connection has no embedded model list', async () => {
    const f = providerFixture('ls'), owner = f.owner(), free = owner.sync.connections[1]
    const { models: _models, ...connection } = free
    f.setOwner({ ...owner, sync: { ...owner.sync, connections: [owner.sync.connections[0], connection] } })
    f.listModels.mockImplementation(async c => [{ id: c.kind === 'free' ? 'free-key-model' : 'paid-key-model' }])
    await f.service.catalog()
    f.listModels.mockClear()
    expect((await f.restart().catalog(false, true)).models.find(m => m.id === 'free-key-model')).toMatchObject({ account: free.account, billing: 'free' })
    expect(f.listModels).not.toHaveBeenCalled()
  })

  it('ignores website route replacements during same-user reauthorization', () => {
    const f = providerFixture('ls'), old = structuredClone(f.owner().sync)
    const implicit = { model: 'gpt-6-astra', reasoningLevel: 'high' as const }
    old.defaults = implicit
    old.bindings = { workspace: implicit, inspiration: { model: 'qwen3.8-flash', account: 'trial:one', billing: 'free', reasoningLevel: 'auto' } }
    const next = { ...old, selectionRevision: old.selectionRevision + 1, defaultAccount: 'secondary', connections: old.connections.map(c => c.kind === 'paid' ? { ...c, account: 'secondary', group: 'new-group', apiKey: 'new-key' } : c) }
    const merged = reconcileProviderSync(old, next, f.preferences())
    expect(merged).toBe(old)
    expect(merged.defaults).toEqual(implicit)
    expect(merged.bindings?.workspace).toEqual(merged.defaults)
    expect(merged.bindings?.inspiration).toEqual(old.bindings.inspiration)
    expect(merged.connections).toEqual(old.connections)
    expect(old.defaults).toEqual(implicit)
  })

  it('keeps the local free default independent of the website default', () => {
    const f = providerFixture(), old = { ...f.owner().sync, defaultAccount: 'trial:one' }
    const next = { ...old, defaultAccount: 'trial:two', selectionRevision: old.selectionRevision + 1 }
    expect(reconcileProviderSync(old, next, { model: 'qwen3.8-flash', reasoningLevel: 'auto', fastMode: false })).toBe(old)
  })

  it('does not import older or reduced website route sets into the local catalog', () => {
    const f = providerFixture(), old = structuredClone(f.owner().sync)
    old.bindings = { inspiration: { model: 'qwen3.8-flash', account: 'trial:one', billing: 'free', reasoningLevel: 'auto' } }
    expect(reconcileProviderSync(old, { ...old, selectionRevision: old.selectionRevision - 1 }, f.preferences())).toBe(old)
    const merged = reconcileProviderSync(old, { ...old, selectionRevision: old.selectionRevision + 1, connections: old.connections.filter(c => c.account !== 'trial:one') }, f.preferences())
    expect(merged.bindings?.inspiration).toEqual(old.bindings.inspiration)
    expect(merged.connections.some(c => c.account === 'trial:one')).toBe(true)
  })

  it('never imports website selections during ordinary catalog reads, even after cache expiry or restart', async () => {
    const f = providerFixture('ls')
    await f.service.discoverModels()
    const original = structuredClone(f.owner().sync)
    await f.service.catalog()
    f.flags.next = { ...original, selectionRevision: original.selectionRevision + 1, defaultAccount: 'trial:two', connections: original.connections.filter(c => c.account !== 'trial:one').map(c => c.kind === 'paid' ? { ...c, group: 'changed-on-website' } : c) }
    const writes = f.writes.mock.calls.length, imports = f.network.filter(request => request.url.includes('credentials=1')).length
    f.tick(120_000)
    expect((await f.service.catalog()).stale).toBe(true)
    await f.restart().catalog()
    expect(f.owner().sync).toEqual(original)
    expect(f.writes).toHaveBeenCalledTimes(writes)
    expect(f.network.filter(request => request.url.includes('credentials=1'))).toHaveLength(imports)
    await f.service.refresh()
    expect(f.owner().sync.selectionRevision).toBe(f.flags.next.selectionRevision)
    expect(f.owner().sync.connections.some(c => c.account === 'trial:one')).toBe(false)
  })

  it('uses a new authorization Key to renew a session without importing or rescanning the client routes', async () => {
    const f = providerFixture('ls'), original = f.owner()
    f.setOwner({ ...original, authorizationKey: 'new-auth-key', refreshBeforeSelection: true })
    await f.service.initializeSession()
    expect(new Headers(f.network.find(request => request.url.endsWith('/session'))?.init?.headers).get('Authorization')).toBe('Bearer new-auth-key')
    expect(f.owner().sync).toEqual(original.sync)
    expect(f.network.some(request => request.url.includes('/providers') || request.url.endsWith('/group'))).toBe(false)
  })

  it('repairs a rotated free Key only when the user explicitly activates that model', async () => {
    const f = providerFixture('ls')
    f.setOwner({ ...f.owner(), authorizationKey: 'new-auth-key', refreshBeforeSelection: true })
    f.flags.next = { ...f.owner().sync, selectionRevision: f.owner().sync.selectionRevision + 1,
      connections: f.owner().sync.connections.map(c => c.account === 'trial:one' ? { ...c, apiKey: 'rotated-free-key' } : c) }
    await f.service.catalog()
    expect(f.owner().sync.connections.find(c => c.account === 'trial:one')?.apiKey).toBe('free-secret-one')
    await expect(f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free', scope: 'inspiration' })).resolves.toMatchObject({ status: 'ok' })
    expect(f.owner().sync.connections.find(c => c.account === 'trial:one')?.apiKey).toBe('rotated-free-key')
    expect(f.listModels).toHaveBeenCalledWith(expect.objectContaining({ account: 'trial:one', apiKey: 'rotated-free-key' }))
    expect(f.owner().sync.bindings?.inspiration).toMatchObject({ model: 'qwen3.8-flash', account: 'trial:one', billing: 'free' })
  })

  it('keeps catalog reads local and blocks new mutations while website authorization is pending', async () => {
    const f = providerFixture()
    await f.service.catalog()
    const writes = f.writes.mock.calls.length, network = f.network.length
    f.authorization.busy = true
    await expect(f.service.refresh()).rejects.toThrow('正在同步')
    await expect(f.service.discoverModels()).rejects.toThrow('正在同步')
    await expect(f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free' })).rejects.toThrow('正在同步')
    await expect(f.service.catalog()).resolves.toMatchObject({ stale: true })
    expect(f.writes.mock.calls).toHaveLength(writes)
    expect(f.network).toHaveLength(network)
    f.authorization.busy = false
    await expect(f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free', scope: 'workspace' })).resolves.toMatchObject({ status: 'ok' })
  })

  it('finishes and restores an already-running scan when website sync starts waiting', async () => {
    const f = providerFixture('ls')
    f.flags.onGroupPost = () => { f.authorization.busy = true }
    await expect(f.service.discoverModels()).resolves.toMatchObject({ recoveryRequired: false })
    expect(f.owner().sync.connections[0]).toMatchObject({ account: 'ls', group: 'gpt-pro（混池）' })
    expect(f.session()?.pending).toBeUndefined()
  })
  it('reads exact same-provider group memberships without changing credentials or selections', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '74', label: 'GPT 标准' }, { id: '75', label: '共享模型 无缓存' })
    f.modelsByGroup['74'] = [{ id: 'group-only-model', name: '真实模型' }, { id: 'same-model' }]
    f.modelsByGroup['75'] = [{ id: 'same-model' }]
    await f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free', scope: 'inspiration' })
    const before = structuredClone(f.owner().sync), preferences = structuredClone(f.preferences())
    const catalog = await f.service.discoverModels()
    expect(f.owner().sync).toEqual(before)
    expect(f.preferences()).toEqual(preferences)
    expect(f.session()?.pending).toBeUndefined()
    expect(catalog.models.filter(m => m.id === 'same-model')).toHaveLength(2)
    expect(catalog.models.find(m => m.id === 'group-only-model')).toMatchObject({ group: '74', modelEvidence: 'verified', available: true })
    const posts = f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')
    expect(posts).toHaveLength(0)
    expect(posts.every(r => !('account' in JSON.parse(String(r.init?.body))))).toBe(true)
    const persisted = f.discovery()!
    expect(persisted.entries.filter(e => e.group !== null).every(e => e.account === 'ls')).toBe(true)
    expect(JSON.stringify(persisted)).not.toMatch(/paid-secret|free-secret|session-secret|alice/)
    const resumed = await f.restart().catalog()
    expect(resumed.models.find(m => m.id === 'group-only-model')).toMatchObject({ group: '74', modelEvidence: 'verified' })
    await f.service.select('group-only-model', { account: 'ls', group: '74', billing: 'quota', scope: 'workspace' })
    expect(f.owner().sync.bindings?.workspace?.model).toBe('group-only-model')
  })
  it("never creates a recovery marker while reading unavailable server catalogs", async () => {
    const f = providerFixture('ls'), before = structuredClone(f.owner().sync), preferences = structuredClone(f.preferences())
    f.catalog.status = 503
    const result = await f.service.discoverModels()
    expect(result).toMatchObject({ stale: true, recoveryRequired: false })
    expect(result.message).toContain('尚未就绪')
    expect(f.owner().sync).toEqual(before)
    expect(f.preferences()).toEqual(preferences)
    expect(f.session()?.pending).toBeUndefined()
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('keeps discovered memberships across verified same-provider Key rotations and restarts', async () => {
    const f = providerFixture('ls'); f.flags.rotatePaidKeys = true
    f.groups.splice(0, f.groups.length, { id: 'gpt-pro（混池）' }, { id: '74' }, { id: '75' })
    f.modelsByGroup['74'] = [{ id: 'model-74' }]; f.modelsByGroup['75'] = [{ id: 'model-75' }]
    await f.service.discoverModels()
    await f.service.select('model-74', { account: 'ls', billing: 'quota', group: '74', scope: 'workspace' })
    const restarted = f.restart()
    expect((await restarted.catalog()).models.find(m => m.id === 'model-75')).toMatchObject({ group: '75', modelEvidence: 'verified' })
    await restarted.select('model-75', { account: 'ls', billing: 'quota', group: '75', scope: 'workspace' })
    await restarted.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: 'gpt-pro（混池）', scope: 'workspace' })
    expect(f.owner().sync.connections[0].group).toBe('gpt-pro（混池）')
  })
  it('preserves an unresolved old model intent while refreshing server catalogs', async () => {
    const f = providerFixture('ls')
    await f.service.routingToken()
    f.setSession({ ...f.session()!, pending: { model: 'removed-model', route: { account: 'ls', group: 'gpt-pro（混池）' } } })
    const preferences = structuredClone(f.preferences())
    await f.service.discoverModels()
    expect(f.session()?.pending?.model).toBe('removed-model')
    expect(f.preferences()).toEqual(preferences)
  })
  it("reports disk cache failure without losing the fetched server catalog", async () => {
    const f = providerFixture('ls')
    f.flags.busy = true; f.flags.discoveryWriteFail = true
    const result = await f.service.discoverModels()
    expect(result.models.length).toBeGreaterThan(0)
    expect(result.message).toContain('未能保存')
    expect(f.owner().sync.connections[0].group).toBe('gpt-pro（混池）')
    expect(f.session()?.pending).toBeUndefined()
  })
  it("allows server catalog refresh during paid work without switching any route", async () => {
    const f = providerFixture('ls')
    f.flags.busy = true
    await expect(f.service.discoverModels()).resolves.toMatchObject({ recoveryRequired: false })
    await f.service.catalog(true)
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(0)
    expect(f.network.filter(r => new URL(r.url).pathname === '/api/device/models').length).toBeGreaterThan(0)
  })
  it('retains the saved inventory beyond a day without granting a replacement Key routing authority', async () => {
    const f = providerFixture('ls')
    await f.service.discoverModels()
    expect((await f.restart().catalog()).models.find(m => m.group === 'Gemini')).toBeDefined()
    f.groups.splice(0, f.groups.length, { id: 'Gemini' })
    f.tick(24 * 3600_000)
    expect((await f.restart().catalog()).models.some(m => m.group === 'Gemini')).toBe(true)
    f.tick(-24 * 3600_000)
    const owner = f.owner(); f.setOwner({ ...owner, sync: { ...owner.sync, connections: owner.sync.connections.map(c => c.kind === 'paid' ? { ...c, apiKey: 'different-key' } : c) } })
    const restarted = f.restart()
    expect((await restarted.catalog()).models.some(m => m.group === 'Gemini')).toBe(true)
    await expect(restarted.select('gemini-3.8-flash', { account: 'ls', group: 'Gemini', billing: 'quota' })).resolves.toMatchObject({ status: 'ok' })
  })
  it('retains every connected free supplier including empty lists and rejects over-cap snapshots', async () => {
    const f = providerFixture('ls'), original = f.owner(), template = original.sync.connections[1]
    const free = Array.from({ length: 100 }, (_, i) => ({ ...template, account: `trial:source-${i}`, models: i === 0 ? [] : [`free-model-${i}`] }))
    f.setOwner({ ...original, sync: { ...original.sync, connections: [original.sync.connections[0], ...free] } })
    const catalog = await f.service.catalog()
    expect(catalog.providers).toHaveLength(101)
    expect(new Set(catalog.models.filter(m => m.billing === 'free').map(m => m.account)).size).toBe(99)
    expect(f.listModels).toHaveBeenCalledTimes(1)
    expect(() => parseProviderSnapshot({ ...original.sync, connections: [original.sync.connections[0], ...Array.from({ length: 256 }, (_, i) => ({ ...template, account: `trial:source-${i}` }))] })).toThrow()
  })
  it('pins an implicit paid identity even with no group before a website supplier replacement', async () => {
    const f = providerFixture('ls'), original = f.owner()
    const implicit = { model: 'gpt-6-astra', reasoningLevel: 'auto' as const }
    f.setOwner({ ...original, sync: { ...original.sync, defaults: implicit, bindings: { workspace: implicit }, connections: original.sync.connections.map(c => c.kind === 'paid' ? { ...c, group: null } : c) } })
    f.flags.next = { ...f.owner().sync, defaultAccount: 'secondary', selectionRevision: 5, connections: f.owner().sync.connections.map(c => c.kind === 'paid' ? { ...c, account: 'secondary', group: 'Kimi' } : c) }
    await f.service.refresh()
    const catalog = await f.service.catalog()
    expect(catalog.providers?.filter(p => p.kind === 'paid')).toEqual(expect.arrayContaining([{ account: 'secondary', label: '付费', kind: 'paid' }]))
    expect(f.owner().sync.defaults).toEqual({ ...implicit, account: 'ls', billing: 'quota' })
    expect(f.owner().sync.bindings?.workspace).toEqual({ ...implicit, account: 'ls', billing: 'quota' })
    await expect(f.service.resolve()).rejects.toThrow('已移除')
    await expect(f.service.resolve(f.owner().sync.bindings?.workspace)).rejects.toThrow('已移除')
  })
  it('never reuses a connected free supplier model as a paid group candidate', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '74', label: '未知组' })
    f.modelsByGroup['74'] = []
    const catalog = await f.service.catalog()
    expect(catalog.models.some(m => m.id === 'qwen3.8-flash' && m.billing === 'free')).toBe(true)
    expect(catalog.models.some(m => m.account === 'ls' && m.group === '74')).toBe(false)
    await expect(f.service.select('qwen3.8-flash', { account: 'ls', billing: 'quota', group: '74' })).rejects.toThrow('尚未验证')
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  const crossProviderFixture = (advertised = false) => {
    const f = providerFixture('ls')
    f.providers.push({ account: 'secondary', label: '供应商二', kind: 'paid', groups: [{ id: '74', label: '稳定组', ...(advertised ? { models: ['gpt-6-astra', 'new-provider-model'] } : {}) }] })
    f.modelsByGroup['74'] = [{ id: 'gpt-6-astra' }, { id: 'new-provider-model' }]
    return f
  }
  it('reads both paid suppliers with overlapping group IDs and preserves bindings across explicit selections and restart', async () => {
    const f = crossProviderFixture()
    f.flags.rotatePaidKeys = true
    f.groups.splice(0, f.groups.length, { id: 'gpt-pro（混池）' }, { id: '74', label: 'LS 线路' })
    f.modelsByRoute['ls:74'] = [{ id: 'ls-only-model' }, { id: 'shared-model' }]
    f.modelsByRoute['secondary:74'] = [{ id: 'secondary-only-model' }, { id: 'shared-model' }]
    await f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free', scope: 'inspiration' })
    const bindings = structuredClone(f.owner().sync.bindings), preferences = structuredClone(f.preferences())
    const catalog = await f.service.discoverModels()
    expect(f.owner().sync.connections.filter(c => c.kind === 'paid')).toEqual([expect.objectContaining({ account: 'ls', group: 'gpt-pro（混池）' })])
    expect(f.owner().sync.bindings).toEqual(bindings)
    expect(f.preferences()).toEqual(preferences)
    expect(f.session()?.pending).toBeUndefined()
    expect(catalog.models.filter(m => m.id === 'shared-model')).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: 'ls', group: '74', available: true, modelEvidence: 'verified' }),
      expect.objectContaining({ account: 'secondary', group: '74', available: true, modelEvidence: 'verified' })
    ]))
    expect(catalog.models.some(m => m.id === 'ls-only-model' && m.account === 'secondary')).toBe(false)
    expect(catalog.models.some(m => m.id === 'secondary-only-model' && m.account === 'ls')).toBe(false)
    expect(f.discovery()?.entries.some(e => e.account === 'secondary')).toBe(true)
    expect(JSON.stringify(f.discovery())).not.toMatch(/paid-secret|target-paid-secret|paid-group-secret|session-secret|free-secret/)
    let restarted = f.restart()
    expect((await restarted.catalog()).models.find(m => m.id === 'secondary-only-model')).toMatchObject({ account: 'secondary', group: '74' })
    await restarted.select('secondary-only-model', { account: 'secondary', group: '74', billing: 'quota', scope: 'workspace' })
    restarted = f.restart()
    expect((await restarted.catalog()).models.find(m => m.id === 'ls-only-model')).toMatchObject({ account: 'ls', group: '74' })
    await restarted.select('ls-only-model', { account: 'ls', group: '74', billing: 'quota', scope: 'workspace' })
    expect(f.owner().sync.bindings?.inspiration).toEqual(bindings?.inspiration)
    const crossPosts = f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST' && JSON.parse(String(r.init.body)).account)
    expect(crossPosts).toHaveLength(2)
    expect(crossPosts.every(r => new Headers(r.init?.headers).get('Authorization') === 'Bearer session-secret')).toBe(true)
  })
  it("reads another paid supplier catalog without replacing or acquiring its inference key", async () => {
    const f = crossProviderFixture(), before = structuredClone(f.owner().sync)
    const result = await f.service.discoverModels()
    expect(result.models.some(m => m.account === 'secondary' && m.group === '74')).toBe(true)
    expect(f.owner().sync).toEqual(before)
    expect(f.owner().sync.connections.filter(c => c.kind === 'paid')).toHaveLength(1)
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(0)
    const read = f.network.find(r => r.url.includes('/api/device/models?account=secondary'))!
    expect(new Headers(read.init?.headers).get('Authorization')).toBe('Bearer session-secret')
  })
  it("keeps the selected supplier and preferences when another server catalog fails", async () => {
    const f = crossProviderFixture(), before = structuredClone(f.owner().sync), preferences = structuredClone(f.preferences())
    f.catalog.unavailable.add('secondary:74')
    expect((await f.service.discoverModels()).stale).toBe(true)
    expect(f.owner().sync).toEqual(before)
    expect(f.preferences()).toEqual(preferences)
    expect(f.session()?.pending).toBeUndefined()
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(0)
  })
  it('does not switch an unverified other supplier or an unsynchronized free supplier', async () => {
    const f = crossProviderFixture()
    await expect(f.service.select('new-provider-model', { account: 'secondary', billing: 'quota', group: '74' })).rejects.toThrow('尚未验证')
    await expect(f.service.select('qwen3.8-flash', { account: 'trial:missing', billing: 'free' })).rejects.toThrow('尚未同步')
    expect(f.session()).toBeNull()
    expect(f.network.some(r => r.init?.method === 'POST')).toBe(false)
  })
  it('honors disabled provider switching and busy work belonging to a detached supplier', async () => {
    const f = crossProviderFixture(true)
    f.flags.canSwitchProvider = false
    expect((await f.service.catalog()).models.find(m => m.account === 'secondary')).toMatchObject({ available: false })
    await expect(f.service.select('gpt-6-astra', { account: 'secondary', billing: 'quota', group: '74' })).rejects.toThrow('不能切换')
    f.flags.canSwitchProvider = true; f.flags.busyAccounts = ['secondary']
    await expect(f.service.discoverModels()).resolves.toMatchObject({ recoveryRequired: false })
    await expect(f.service.select('gpt-6-astra', { account: 'secondary', billing: 'quota', group: '74' })).rejects.toThrow('正在运行')
    await expect(f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free', scope: 'inspiration' })).resolves.toMatchObject({ status: 'ok' })
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('does not apply a cross-supplier model when the actual target model directory disagrees', async () => {
    const f = crossProviderFixture(true)
    f.modelsByGroup['74'] = [{ id: 'different-model' }]
    await expect(f.service.select('gpt-6-astra', { account: 'secondary', billing: 'quota', group: '74', scope: 'workspace' })).rejects.toThrow('请选择本组模型')
    expect(f.owner().sync.bindings?.workspace).toBeUndefined()
    expect(f.preferences().account).toBe('ls')
    expect(f.session()?.pending).toMatchObject({ route: { account: 'secondary', group: '74' } })
  })
  it('shows advertised paid routes but never invents unknown group membership or missing free suppliers', async () => {
    const f = crossProviderFixture()
    const owner = f.owner(); f.setOwner({ ...owner, sync: { ...owner.sync, connections: owner.sync.connections.filter(c => c.kind === 'paid') } })
    const catalog = await f.service.catalog(true)
    expect(catalog.models.some(m => m.account === 'secondary')).toBe(true)
    expect(catalog.routes?.find(r => r.account === 'secondary')).toMatchObject({ group: '74', available: true })
    expect(catalog.models.some(m => m.billing === 'free')).toBe(false)
    expect(catalog.models.some(m => m.id === 'new-provider-model')).toBe(true)
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('switches an advertised paid supplier with the routing token and verifies the exact live target', async () => {
    const f = crossProviderFixture(true)
    await expect(f.service.select('gpt-6-astra', { account: 'secondary', billing: 'quota', group: '74', scope: 'workspace' })).resolves.toMatchObject({ status: 'ok', selection: { account: 'secondary', group: '74' } })
    const posts = f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(new Headers(posts[0].init?.headers).get('Authorization')).toBe('Bearer session-secret')
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ account: 'secondary', group: '74', expectedAccount: 'ls', expectedGroup: 'gpt-pro（混池）' })
    expect(f.session()?.pending).toBeUndefined()
    expect(f.owner().sync.connections.filter(c => c.kind === 'paid')).toHaveLength(1)
    expect(f.owner().sync.bindings?.workspace).toMatchObject({ account: 'secondary', group: '74' })
    await expect(f.service.resolve(f.owner().sync.bindings?.workspace)).resolves.toMatchObject({ connection: { account: 'secondary', group: '74' } })
  })
  it('honors an upstream synchronization-required rejection without leaving recovery or changing a binding', async () => {
    const f = crossProviderFixture(true); f.flags.crossProviderRequired = true
    const option = { account: 'secondary', billing: 'quota' as const, group: '74' }
    await expect(f.service.select('gpt-6-astra', option)).resolves.toMatchObject({ status: 'error', requiresProviderSync: true })
    expect(f.owner().sync.connections[0].account).toBe('ls')
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.resolve()).resolves.toMatchObject({ connection: { account: 'ls' } })
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(1)
  })
  it('recovers an ambiguous cross-provider response through authoritative readback without posting twice', async () => {
    const f = crossProviderFixture(true); f.flags.groupPostStatus = 502; f.flags.failRecovery = true
    const option = { account: 'secondary', billing: 'quota' as const, group: '74' }
    await expect(f.service.select('gpt-6-astra', option)).rejects.toThrow()
    expect(f.session()?.pending).toMatchObject({ route: { account: 'secondary', group: '74' } })
    await expect(f.service.resolve()).rejects.toThrow('尚未确认')
    f.flags.failRecovery = false
    await f.service.refresh()
    await expect(f.service.select('gpt-6-astra', option)).resolves.toMatchObject({ status: 'ok' })
    expect(f.session()?.pending).toBeUndefined()
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(1)
  })
  it('protects the in-use paid supplier while allowing an independent free choice', async () => {
    const f = crossProviderFixture(); f.flags.busy = true
    await expect(f.service.select('gpt-6-astra', { account: 'secondary', billing: 'quota', group: '74' })).rejects.toThrow('正在运行')
    await expect(f.service.select('qwen3.8-flash', { account: 'trial:one', billing: 'free', scope: 'inspiration' })).resolves.toMatchObject({ status: 'ok' })
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
    await expect(f.service.select('gpt-6-astra', { account: 'secondary', billing: 'free', group: '74' })).rejects.toThrow()
  })
  it('remembers verified membership after changing groups and deduplicates concurrent read-only queries', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: 'gpt-pro（混池）', label: '原组' }, { id: '74', label: '新组', models: ['gpt-6-astra'] })
    f.modelsByGroup['74'] = [{ id: 'gpt-6-astra' }]
    await Promise.all([f.service.catalog(), f.service.catalog()])
    expect(f.network.filter(r => r.url.endsWith('/group'))).toHaveLength(1)
    await f.service.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: '74' })
    const catalog = await f.service.catalog()
    expect(catalog.models.find(m => m.group === 'gpt-pro（混池）' && m.id === 'gpt-6-astra')).toMatchObject({ modelEvidence: 'verified' })
  })
  it('invalidates learned authority when a key rotates and preserves group pins for model-only overrides', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: 'gpt-pro（混池）' }, { id: '74', models: ['gpt-6-astra'] })
    f.modelsByGroup['74'] = [{ id: 'gpt-6-astra' }]
    await f.service.catalog()
    await f.service.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: '74', scope: 'workspace' })
    await expect(f.service.resolve({ model: 'gpt-6-astra', reasoningLevel: 'auto' })).rejects.toThrow('分组已变化')
    f.flags.next = { ...f.owner().sync, connections: f.owner().sync.connections.map(c => c.kind === 'paid' ? { ...c, apiKey: 'rotated-secret' } : c) }
    await f.service.refresh()
    expect((await f.service.catalog()).models.some(m => m.group === 'gpt-pro（混池）' && m.id === 'gpt-6-astra')).toBe(true)
    await expect(f.service.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: 'gpt-pro（混池）' })).resolves.toMatchObject({ status: 'ok' })
  })
  it('rejects a model lookup that finishes after the account has changed', async () => {
    const f = providerFixture('ls')
    f.listModels.mockImplementationOnce(async () => { f.setOwner({ ...f.owner(), username: 'other-user' }); return [{ id: 'gpt-6-astra' }] })
    await expect(f.service.resolve()).rejects.toThrow('连接已变化')
  })
  it('shares image and routing session initialization without losing a pending switch', async () => {
    const f = providerFixture('ls')
    let release!: () => void
    f.flags.sessionGate = new Promise<void>(resolve => { release = resolve })
    f.flags.groupPostStatus = 502; f.flags.failRecovery = true
    const imageToken = f.service.routingToken()
    const switchResult = f.service.select('gemini-3.8-flash', { account: 'ls', billing: 'quota', group: 'Gemini' }).then(() => 'unexpected-success', () => 'recovery-required')
    await Promise.resolve(); release()
    expect(await imageToken).toBe('session-secret')
    expect(await switchResult).toBe('recovery-required')
    expect(f.network.filter(r => r.url.endsWith('/session'))).toHaveLength(1)
    expect(f.session()?.pending?.route.group).toBe('Gemini')
  })
  it('merges token renewal after a queued pending write instead of clearing recovery', async () => {
    const f = providerFixture('ls')
    await f.service.routingToken()
    let release!: () => void
    f.flags.sessionWriteGate = new Promise<void>(resolve => { release = resolve })
    f.flags.groupPostStatus = 502; f.flags.failRecovery = true
    const selection = f.service.select('gemini-3.8-flash', { account: 'ls', billing: 'quota', group: 'Gemini' }).then(() => 'unexpected-success', () => 'recovery-required')
    await vi.waitFor(() => expect(f.writeSession).toHaveBeenCalledTimes(2))
    f.setSession({ ...f.session()!, expiresAt: 0 })
    const token = f.service.routingToken()
    await vi.waitFor(() => expect(f.network.filter(r => r.url.endsWith('/session'))).toHaveLength(2))
    release()
    await token
    expect(await selection).toBe('recovery-required')
    expect(f.session()?.pending).toMatchObject({ model: 'gemini-3.8-flash', route: { account: 'ls', group: 'Gemini' } })
    expect(f.session()!.expiresAt).toBeGreaterThan(Date.now())
  })
  it('bounds a large directory while preserving current options first', async () => {
    const f = providerFixture('ls')
    f.modelsByGroup['gpt-pro（混池）'] = Array.from({ length: 512 }, (_, i) => ({ id: `model-${i}` }))
    f.groups.splice(0, f.groups.length, ...Array.from({ length: 100 }, (_, i) => ({ id: `group-${i}` })))
    const catalog = await f.service.catalog()
    expect(catalog.models.length).toBeLessThanOrEqual(4096)
    expect(catalog.models.filter(m => m.routeCurrent)).toHaveLength(512)
  })
  it('requires an exact group instead of choosing the first of two advertised routes', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '74', models: ['other-model'] }, { id: '75', models: ['other-model'] })
    await expect(f.service.select('other-model', { account: 'ls', billing: 'quota' })).rejects.toThrow('具体线路')
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('detects a same-key upstream group change after a warm catalogue and preserves the original binding', async () => {
    const f = providerFixture('ls')
    await f.service.catalog()
    await f.service.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: 'gpt-pro（混池）', scope: 'workspace' })
    const binding = f.owner().sync.bindings!.workspace!
    f.flags.remoteRoute = { account: 'ls', group: '74' }
    f.flags.next = { ...f.owner().sync, connections: f.owner().sync.connections.map(c => c.kind === 'paid' ? { ...c, group: '74' } : c) }
    f.modelsByGroup['74'] = [{ id: 'gpt-6-astra' }]
    await expect(f.service.resolve(binding)).rejects.toThrow('上游付费线路已变化')
    expect(f.owner().sync.connections[0]).toMatchObject({ account: 'ls', group: '74', apiKey: 'paid-secret' })
    expect(f.owner().sync.bindings?.workspace).toEqual(binding)
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('pins implicit legacy defaults and bindings before accepting a changed upstream tuple', async () => {
    const f = providerFixture('ls'), original = f.owner()
    const implicit = { model: 'gpt-6-astra', account: 'ls', billing: 'quota' as const, reasoningLevel: 'auto' as const }
    f.setOwner({ ...original, sync: { ...original.sync, bindings: { workspace: implicit } } })
    await f.service.catalog()
    f.flags.remoteRoute = { account: 'ls', group: '74' }
    f.flags.next = { ...f.owner().sync, connections: f.owner().sync.connections.map(c => c.kind === 'paid' ? { ...c, group: '74' } : c) }
    f.modelsByGroup['74'] = [{ id: 'gpt-6-astra' }]
    await expect(f.service.resolve()).rejects.toThrow('上游付费线路已变化')
    expect(f.owner().sync.defaults).toMatchObject({ account: 'ls', group: 'gpt-pro（混池）' })
    expect(f.owner().sync.bindings?.workspace).toMatchObject({ group: 'gpt-pro（混池）' })
    await expect(f.service.resolve()).rejects.toThrow('分组已变化')
    await expect(f.service.resolve(f.owner().sync.bindings?.workspace)).rejects.toThrow('分组已变化')
    await f.service.select('gpt-6-astra', { account: 'ls', billing: 'quota', group: '74', scope: 'settings' })
    await expect(f.service.resolve()).resolves.toMatchObject({ connection: { group: '74' } })
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('rejects a model removed from the unchanged paid group instead of using a warm model cache', async () => {
    const f = providerFixture('ls')
    await f.service.catalog()
    f.modelsByGroup['gpt-pro（混池）'] = [{ id: 'remaining-model' }]
    await expect(f.service.resolve()).rejects.toThrow('不支持这个模型')
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('fails closed when the live paid directory is unavailable even with a warm model cache', async () => {
    const f = providerFixture('ls')
    await f.service.catalog(); f.flags.offline = true
    await expect(f.service.resolve()).rejects.toThrow('无法连接模型服务')
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('rechecks a free model before inference without selecting a paid fallback', async () => {
    const f = providerFixture('ls')
    await f.service.catalog()
    f.listModels.mockImplementationOnce(async () => [{ id: 'different-free-model' }])
    await expect(f.service.resolve({ account: 'trial:one', billing: 'free', model: 'qwen3.8-flash', reasoningLevel: 'auto' })).rejects.toThrow('不支持这个模型')
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it.each(['ls', 'trial:one'])('accepts native LS with a paid or free default (%s) and nullable models', defaultAccount => {
    const snapshot = providerFixture('ls').owner().sync
    const parsed = parseProviderSnapshot({ ...snapshot, defaultAccount })
    expect(parsed.defaultAccount).toBe(defaultAccount)
    expect(parsed.connections[0]).toMatchObject({ account: 'ls', kind: 'paid', model: null, inferenceBaseUrl: 'https://paid.example/v1' })
    expect(parsed.connections[0].models).toBeUndefined()
    expect(parseProviderSnapshot({ ...snapshot, connections: [snapshot.connections[0]] }).connections).toHaveLength(1)
  })
  it('rejects invalid identities, billing, defaults and whole connection sets', () => {
    const snapshot = providerFixture('ls').owner().sync, paid = snapshot.connections[0]
    for (const invalid of [
      { ...snapshot, connections: [{ ...paid, kind: 'free' }] },
      { ...snapshot, connections: [{ ...paid, account: 'trial:xxx', kind: 'paid' }] },
      { ...snapshot, connections: [{ ...paid, account: 'unknown' }] },
      { ...snapshot, connections: [{ ...paid, account: 'trial:Upper', kind: 'free' }] },
      { ...snapshot, connections: [paid, paid] },
      { ...snapshot, connections: [paid, { ...paid, account: 'secondary' }] },
      { ...snapshot, connections: [{ ...paid, apiKey: ' ' }] },
      { ...snapshot, defaultAccount: 'secondary' },
      { ...snapshot, connections: [] }
    ]) expect(() => parseProviderSnapshot(invalid)).toThrow()
  })
  it('keeps LS identity, credentials, bindings and routing authorization across refresh', async () => {
    const f = providerFixture('ls')
    await f.service.select('gpt-6.1-sol', { scope: 'workspace', billing: 'quota', account: 'ls' })
    await f.service.select('qwen3.8-flash', { scope: 'inspiration', billing: 'free', account: 'trial:one' })
    expect(await f.service.routingToken()).toBe('session-secret')
    await f.service.refresh()
    expect((await f.service.resolve(f.owner().sync.bindings?.workspace)).connection).toMatchObject({ account: 'ls', apiKey: 'paid-secret', inferenceBaseUrl: 'https://paid.example/v1' })
    expect((await f.service.resolve(f.owner().sync.bindings?.inspiration)).connection.account).toBe('trial:one')
    expect(f.network.every(r => new Headers(r.init?.headers).get('X-ModMind-Sync-Capabilities') === 'provider-ls')).toBe(true)
    expect(new Headers(f.network.find(r => r.url.includes('credentials=1'))!.init?.headers).get('Authorization')).toBe('Bearer session-secret')
    const before = structuredClone(f.owner().sync)
    f.flags.next = { ...before, connections: [{ ...before.connections[0], kind: 'free' }] }
    await expect(f.service.refresh()).rejects.toThrow('供应商标识')
    expect(f.owner().sync).toEqual(before)
  })
  it('uses live numeric groups for new LS models and verifies the model after switching', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '25', label: 'LS 新模型', models: [{ id: 'upstream-new-model' }] })
    f.modelsByGroup['25'] = [{ id: 'upstream-new-model', name: '上游新模型', family: 'New' }]
    const catalog = await f.service.catalog()
    expect(catalog.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'upstream-new-model', account: 'ls' })]))
    expect(catalog.routes).toEqual(expect.arrayContaining([expect.objectContaining({ account: 'ls', group: '25', label: 'LS 新模型', current: false, available: true })]))
    const result = await f.service.select('upstream-new-model', { account: 'ls', billing: 'quota', scope: 'workspace' })
    expect(result.selection?.model).toBe('upstream-new-model')
    expect(result.linkedSelections).toBeUndefined()
    const post = f.network.find(r => r.init?.method === 'POST' && r.url.endsWith('/group'))!
    expect(JSON.parse(String(post.init?.body))).toEqual({ group: '25', expectedAccount: 'ls', expectedGroup: 'gpt-pro（混池）' })
    expect(result.catalog.models.find(m => m.id === 'upstream-new-model')).toMatchObject({ id: 'upstream-new-model', group: '25' })
    expect(f.owner().sync.connections[0].account).toBe('ls')
  })
  it("reads exact LS group membership from the server before an explicit selection", async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '74', label: '新线路' })
    f.modelsByGroup['74'] = [{ id: 'actual-only-model' }]
    const result = await f.service.catalog()
    expect(result.models.find(m => m.id === 'actual-only-model')).toMatchObject({ group: '74', modelEvidence: 'verified' })
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
    await expect(f.service.select('actual-only-model', { account: 'ls', billing: 'quota', group: '74' })).resolves.toMatchObject({ status: 'ok' })
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(1)
  })
  it("uses the LS server directory for a group with the same ID as another supplier", async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: 'Gemini' })
    f.modelsByRoute['ls:Gemini'] = [{ id: 'ls-only-model' }]
    const result = await f.service.catalog()
    expect(result.models.find(m => m.id === 'ls-only-model')).toMatchObject({ account: 'ls', group: 'Gemini' })
    expect(result.models.some(m => m.id === 'gemini-3.8-flash')).toBe(false)
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('preserves another paid surface when actual models support both families', async () => {
    const f = providerFixture('ls')
    f.modelsByGroup['gpt-pro（混池）'] = [{ id: 'gpt-6-astra' }, { id: 'gemini-3.8-flash' }]
    const result = await f.service.select('gemini-3.8-flash', { account: 'ls', billing: 'quota', scope: 'workspace' })
    expect(result.linkedSelections).toBeUndefined()
    expect(f.owner().sync.bindings?.inspiration).toBeUndefined()
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
  })
  it('retains two options for the same model in different groups and selects the exact group', async () => {
    const f = providerFixture('ls'), model = 'gpt-6-astra'
    f.groups.splice(0, f.groups.length,
      { id: 'gpt-pro（混池）', label: '经济组', models: [model] },
      { id: '74', label: '稳定无缓存', models: [model] })
    f.modelsByGroup['74'] = [{ id: model }]
    const catalog = await f.service.catalog(), options = catalog.models.filter(m => m.id === model)
    expect(options).toHaveLength(2)
    expect(new Set(options.map(m => m.optionKey)).size).toBe(2)
    expect(options.find(m => m.group === '74')).toMatchObject({ noCache: true })
    expect(options.find(m => m.group === 'gpt-pro（混池）')?.noCache).toBeUndefined()
    expect(catalog.currentOptionKey).toBe(options.find(m => m.group === 'gpt-pro（混池）')?.optionKey)
    await f.service.select(model, { account: 'ls', billing: 'quota', scope: 'workspace' })
    expect(f.network.some(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toBe(false)
    const result = await f.service.select(model, { account: 'ls', billing: 'quota', group: '74', scope: 'workspace' })
    expect(f.owner().sync.connections[0].group).toBe('74')
    expect(result.selection?.group).toBe('74')
    expect(result.catalog.currentRoute?.group).toBe('74')
    expect(result.catalog.selectionRequired).toBe(true)
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(1)
  })
  it('shows only connected providers when no free group is supplied', async () => {
    const f = providerFixture('ls'), owner = f.owner()
    f.setOwner({ ...owner, sync: { ...owner.sync, connections: owner.sync.connections.filter(c => c.kind === 'paid') } })
    const catalog = await f.service.catalog()
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.models.every(m => m.billing === 'quota' && m.account === 'ls')).toBe(true)
    await expect(f.service.select('qwen3.8-flash', { billing: 'free' })).rejects.toThrow('官网勾选')
  })
  it('allows advertised target models while the current model endpoint is unavailable', async () => {
    const f = providerFixture('ls')
    f.flags.listFail = true
    const catalog = await f.service.catalog()
    expect(catalog.stale).toBe(true)
    expect(catalog.models.find(m => m.id === 'gemini-3.8-flash')).toMatchObject({ available: true, group: 'Gemini' })
  })
  it('keeps an exact model unavailable instead of silently replacing it after group drift', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '25', models: ['advertised-model'] })
    f.modelsByGroup['25'] = [{ id: 'different-actual-model' }]
    await expect(f.service.select('advertised-model', { account: 'ls', billing: 'quota', group: '25' })).rejects.toThrow('请选择本组模型')
    expect(f.preferences().model).toBe('gpt-6-astra')
    expect(f.session()?.pending).toMatchObject({ model: 'advertised-model', route: { group: '25' } })
    expect((await f.service.catalog()).pendingSelection).toMatchObject({ account: 'ls', group: '25' })
    await expect(f.service.resolve()).rejects.toThrow('尚未确认')
  })
  it('keeps 409 recovery until a read confirms the state and never repeats the mutation', async () => {
    const f = providerFixture('ls')
    f.flags.groupPostStatus = 409; f.flags.groupPostAppliedOn409 = true; f.flags.failRecovery = true
    await expect(f.service.select('gemini-3.8-flash', { account: 'ls', billing: 'quota', group: 'Gemini' })).rejects.toThrow()
    expect(f.session()?.pending?.route.group).toBe('Gemini')
    await expect(f.service.resolve()).rejects.toThrow('尚未确认')
    f.flags.failRecovery = false
    await f.service.refresh()
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('gemini-3.8-flash', { account: 'ls', billing: 'quota', group: 'Gemini' })).resolves.toMatchObject({ status: 'ok' })
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(1)
  })
  it('requires an exact model after group drift and does not post the group twice', async () => {
    const f = providerFixture('ls')
    f.groups.splice(0, f.groups.length, { id: '25', label: '新线路', models: ['gpt-6-astra'] })
    f.modelsByGroup['25'] = [{ id: 'actual-model' }]
    f.flags.groupPostStatus = 502; f.flags.failRecovery = true
    const option = { account: 'ls', billing: 'quota' as const, group: '25' }
    await expect(f.service.select('gpt-6-astra', option)).rejects.toThrow()
    expect(f.session()?.pending).toMatchObject({ route: { group: '25' } })
    expect((await f.service.catalog()).pendingSelection).toMatchObject({ group: '25' })
    f.flags.failRecovery = false
    const result = await f.service.select('actual-model', option)
    expect(result.selection?.model).toBe('actual-model')
    expect(f.network.filter(r => r.url.endsWith('/group') && r.init?.method === 'POST')).toHaveLength(1)
  })
  it('changes the paid group using its own key when the session default is free',async()=>{
    const f=providerFixture();f.flags.sessionDefaultFree=true
    await f.service.select('qwen3.8-flash',{scope:'settings',billing:'free',account:'trial:one'})
    await expect(f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok'})
    const requests=f.network.filter(r=>r.url.includes('/group'))
    expect(requests.every(r=>new Headers(r.init?.headers).get('Authorization')==='Bearer paid-secret')).toBe(true)
    expect(f.session()?.pending).toBeUndefined()
  })
  it('does not retain recovery after a rejected group mutation',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=409
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('gpt-6.1-sol',{scope:'settings',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok',catalog:{recoveryRequired:false}})
    await expect(f.service.resolve()).resolves.toMatchObject({model:'gpt-6.1-sol'})
  })
  it('clears a leftover pending record before selecting an already active model',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    expect(f.session()?.pending).toBeDefined()
    f.flags.failRecovery=false
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok',catalog:{recoveryRequired:false}})
    await expect(f.service.resolve()).resolves.toMatchObject({model:'gemini-3.8-flash'})
    expect(f.network.filter(r=>r.url.includes('/group')&&r.init?.method==='POST')).toHaveLength(1)
  })
  it('refreshes cancelled paid connections and clears their pending record without charging another provider',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    f.flags.failRecovery=false;f.flags.next={...f.owner().sync,selectionRevision:5,defaultAccount:'trial:one',connections:f.owner().sync.connections.filter(c=>c.kind==='free')}
    const catalog=await f.service.catalog(true)
    expect(catalog.recoveryRequired).toBe(false);expect(catalog.models.every(m=>m.billing==='free')).toBe(true)
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('qwen3.8-flash',{scope:'settings',billing:'free',account:'trial:one'})).resolves.toMatchObject({status:'ok'})
    await expect(f.service.resolve()).resolves.toMatchObject({model:'qwen3.8-flash',connection:{kind:'free'}})
  })
  it('recovers a completed paid group change after an ambiguous response without sending account or posting twice',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502
    const result=await f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})
    expect(result.status).toBe('ok');expect(f.session()?.pending).toBeUndefined()
    const posts=f.network.filter(r=>r.url.includes('/group')&&r.init?.method==='POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({group:'Gemini',expectedAccount:'secondary',expectedGroup:'gpt-pro（混池）'})
    expect(f.owner().sync.connections[0].apiKey).toBe('paid-secret')
  })
  it('retains pending recovery and blocks paid execution until refresh verifies the group',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    await expect(f.service.resolve()).rejects.toThrow('尚未确认')
    expect((await f.service.catalog()).recoveryRequired).toBe(true)
    f.flags.failRecovery=false;await f.service.refresh()
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok'})
    expect(f.network.filter(r=>r.url.includes('/group')&&r.init?.method==='POST')).toHaveLength(1)
  })
  it('rejects a refresh that returns after the user has changed and resets only the requested surface',async()=>{
    const f=providerFixture()
    await f.service.select('gpt-6-astra',{scope:'workspace',billing:'quota',account:'secondary'})
    await f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    await f.service.resetBinding('inspiration')
    expect(f.owner().sync.bindings?.inspiration).toBeUndefined();expect(f.owner().sync.bindings?.workspace?.model).toBe('gpt-6-astra')
    const before=structuredClone(f.owner().sync)
    f.flags.changeUserOnRefresh=true;await expect(f.service.refresh()).rejects.toThrow('账号已切换')
    expect(f.owner().username).toBe('bob');expect(f.owner().sync).toEqual(before)
  })
  it('keeps different keys at the same URL and rejects invalid whole collections', () => {
    const f=providerFixture(),sync=f.owner().sync
    expect(sync.connections).toHaveLength(3)
    expect(sync.connections[1].apiKey).not.toBe(sync.connections[2].apiKey)
    expect(()=>parseProviderSnapshot({...sync,defaultAccount:'missing'})).toThrow()
    expect(()=>parseProviderSnapshot({...sync,connections:[sync.connections[0],sync.connections[0]]})).toThrow()
    expect(()=>parseProviderSnapshot({...sync,connections:[{...sync.connections[0],inferenceBaseUrl:'javascript:bad'}]})).toThrow()
  })
  it('independently binds surfaces, uses the right key, and never mutates upstream for free selection',async()=>{
    const f=providerFixture()
    await f.service.select('gpt-6-astra',{scope:'workspace',billing:'quota',account:'secondary'})
    await f.service.select('deepseek-v4.1-flash',{scope:'inspiration',billing:'free',account:'trial:two'})
    const bindings=f.owner().sync.bindings!
    const selected=await Promise.all([f.service.resolve(bindings.workspace),f.service.resolve(bindings.inspiration)])
    expect(selected[0].connection.apiKey).toBe('paid-secret')
    expect(selected[1].connection.apiKey).toBe('free-secret-two')
    expect(f.network.some(r=>r.url.endsWith('/group')&&r.init?.method==='POST')).toBe(false)
    expect(f.preferences().model).toBe('gpt-6-astra')
    expect(JSON.stringify(await f.service.catalog())).not.toMatch(/paid-secret|free-secret|session-secret/)
  })
  it('settings clears both bindings and updates the account as well as the model',async()=>{
    const f=providerFixture()
    await f.service.select('deepseek-v4.1-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    await f.service.select('qwen3.8-flash',{scope:'settings',billing:'free',account:'trial:two'})
    expect(f.owner().sync.bindings).toEqual({})
    expect(f.preferences()).toMatchObject({model:'qwen3.8-flash',account:'trial:two',billing:'free'})
  })
  it('refresh removes cancelled providers, preserves bindings and stops requests instead of billing paid',async()=>{
    const f=providerFixture()
    await f.service.select('deepseek-v4.1-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    f.flags.next={...f.owner().sync,selectionRevision:5,connections:f.owner().sync.connections.filter(c=>c.account!=='trial:one')}
    await f.service.refresh()
    expect(f.owner().sync.bindings?.inspiration?.account).toBe('trial:one')
    await expect(f.service.resolve(f.owner().sync.bindings?.inspiration)).rejects.toThrow('已移除')
    expect(f.session()?.owner).toBe(providerOwnerKey(f.owner()))
    const refresh=f.network.find(r=>r.url.includes('credentials=1'))!
    expect(new Headers(refresh.init?.headers).get('Authorization')).toBe('Bearer session-secret')
  })
  it('preserves explicit bindings when defaults change and keys rotate',async()=>{
    const f=providerFixture()
    await f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    f.flags.next={...f.owner().sync,defaultAccount:'trial:two',selectionRevision:5,connections:f.owner().sync.connections.map(c=>c.account==='trial:one'?{...c,apiKey:'rotated-secret'}:c)}
    await f.service.refresh()
    expect((await f.service.resolve(f.owner().sync.bindings?.inspiration)).connection.apiKey).toBe('rotated-secret')
    expect(f.preferences().account).toBe('secondary')
  })
  it('protects paid groups and allows a free binding while paid is busy',async()=>{
    const f=providerFixture();f.flags.busy=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow('正在运行')
    await expect(f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:one'})).resolves.toMatchObject({status:'ok'})
    f.flags.busy=false
    const result=await f.service.select('gemini-3.8-flash',{scope:'inspiration',billing:'quota',account:'secondary'})
    expect(result.linkedSelections).toBeUndefined()
    expect(f.owner().sync.defaults?.group).toBe('gpt-pro（混池）')
    expect(f.owner().sync.bindings?.inspiration?.model).toBe('gemini-3.8-flash')
  })
  it.each(['workspace','inspiration'] as const)('pins the other paid surface on a group change from %s without changing settings defaults',async scope=>{
    const f=providerFixture(),other=scope==='workspace'?'inspiration':'workspace'
    await f.service.select('gpt-6-luna',{scope:other,billing:'quota',account:'secondary'})
    const result=await f.service.select('gemini-3.8-flash',{scope,billing:'quota',account:'secondary'})
    expect(result.linkedSelections).toBeUndefined()
    expect(f.owner().sync.bindings?.[other]).toMatchObject({model:'gpt-6-luna',group:'gpt-pro（混池）'})
    expect(f.preferences().model).toBe('gpt-6-astra')
    await expect(f.service.resolve(f.owner().sync.bindings?.[other])).rejects.toThrow('分组已变化')
  })
  it('preserves a free surface and same-family paid choices',async()=>{
    const f=providerFixture()
    await f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:two'})
    const result=await f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})
    expect(result.linkedSelections).toBeUndefined()
    expect(f.owner().sync.bindings?.inspiration).toMatchObject({model:'qwen3.8-flash',account:'trial:two',billing:'free'})
    const g=providerFixture()
    await g.service.select('gpt-6-luna',{scope:'inspiration',billing:'quota',account:'secondary'})
    expect((await g.service.select('gpt-6.1-sol',{scope:'workspace',billing:'quota',account:'secondary'})).linkedSelections).toBeUndefined()
    expect(g.owner().sync.bindings?.inspiration?.model).toBe('gpt-6-luna')
  })
  it('keeps both paid choices when a family switch is busy or fails before validation',async()=>{
    const f=providerFixture()
    await f.service.select('gpt-6-luna',{scope:'inspiration',billing:'quota',account:'secondary'})
    const before=structuredClone(f.owner().sync.bindings)
    f.flags.busy=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})).rejects.toThrow('正在运行')
    expect(f.owner().sync.bindings).toEqual(before)
    f.flags.busy=false;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})).rejects.toThrow()
    expect(f.owner().sync.bindings).toEqual(before)
  })
  it('rejects stale revisions and retains saved configuration on persistence failure',async()=>{
    const f=providerFixture(),before=structuredClone(f.owner().sync)
    f.flags.next={...before,selectionRevision:3}
    await expect(f.service.refresh()).rejects.toThrow('旧')
    expect(f.owner().sync).toEqual(before)
    f.flags.next={...before,selectionRevision:5};f.flags.failWrite=true
    await expect(f.service.refresh()).rejects.toThrow()
    expect(f.owner().sync).toEqual(before)
  })
})
