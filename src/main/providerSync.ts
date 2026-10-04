import { createHash } from 'node:crypto'
import { normalizeRelayBaseUrl, normalizeSiteUrl } from './deviceIntegration'
import { isSelectableQuotaModel, quotaModelMetadata, quotaModelOptionKey, QUOTA_ROUTE_HINTS } from '../shared/quotaModels'
import type { QuotaModelCatalog, QuotaModelSelection, QuotaModelSwitchResult } from '../shared/quotaModels'
import type { AiModelSelection } from '../shared/aiSelection'
import type { AiModelInfo, BeginnerAiPreferences } from '../shared/types'
import type { RoutingSession } from './quotaModelRouting'

export interface ProviderConnection {
  account: string; label: string; kind: 'free' | 'paid'; baseUrl: string; inferenceBaseUrl: string
  apiKey: string; model: string | null; models?: string[]; group: string | null; node: string | null
}
export interface ProviderSnapshot {
  protocolVersion: 2; selectionRevision: number; defaultAccount: string; connections: ProviderConnection[]
  bindings?: Partial<Record<'workspace' | 'inspiration', AiModelSelection>>
  defaults?: AiModelSelection
}
export const validProviderAccount = (value: unknown): value is string => typeof value === 'string' && /^(primary|secondary|deepseek|trial:[a-zA-Z0-9._-]{1,128})$/.test(value)
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
class ProviderRequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }
export function parseProviderSnapshot(value: unknown): ProviderSnapshot {
  const data = object(value)
  if (data.protocolVersion !== 2 || !Number.isSafeInteger(data.selectionRevision) || Number(data.selectionRevision) < 0 || !Array.isArray(data.connections) || !data.connections.length || data.connections.length > 32) throw new Error('多供应商同步响应无效')
  const accounts = new Set<string>()
  const connections = data.connections.map(raw => {
    const c = object(raw)
    if (!validProviderAccount(c.account) || accounts.has(c.account) || (c.kind !== 'free' && c.kind !== 'paid') || (c.kind === 'free') !== c.account.startsWith('trial:')) throw new Error('供应商标识或计费类型无效')
    accounts.add(c.account)
    if (typeof c.apiKey !== 'string' || !c.apiKey.trim() || c.apiKey.length > 4096 || /[\r\n\0]/.test(c.apiKey)) throw new Error('供应商凭据无效')
    if (c.models !== undefined && (!Array.isArray(c.models) || c.models.length > 512 || c.models.some(id => typeof id !== 'string' || !isSelectableQuotaModel(id)))) throw new Error('供应商模型列表无效')
    if (c.model !== null && c.model !== undefined && (typeof c.model !== 'string' || !isSelectableQuotaModel(c.model))) throw new Error('供应商默认模型无效')
    if ((c.group != null && typeof c.group !== 'string') || (c.node != null && typeof c.node !== 'string')) throw new Error('供应商线路无效')
    const baseUrl = normalizeRelayBaseUrl(typeof c.baseUrl === 'string' ? c.baseUrl : '')
    const inferenceBaseUrl = normalizeRelayBaseUrl(typeof c.inferenceBaseUrl === 'string' ? c.inferenceBaseUrl : `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}`)
    return { account: c.account, label: typeof c.label === 'string' ? c.label.slice(0, 256) : c.account, kind: c.kind, baseUrl, inferenceBaseUrl, apiKey: c.apiKey.trim(), model: typeof c.model === 'string' ? c.model : null,
      ...(Array.isArray(c.models) ? { models: [...new Set(c.models as string[])] } : {}), group: typeof c.group === 'string' ? c.group : null, node: typeof c.node === 'string' ? c.node : null } as ProviderConnection
  })
  if (connections.filter(c => c.kind === 'paid').length > 1 || typeof data.defaultAccount !== 'string' || !accounts.has(data.defaultAccount)) throw new Error('供应商默认选择或付费组合无效')
  return { protocolVersion: 2, selectionRevision: Number(data.selectionRevision), defaultAccount: data.defaultAccount, connections }
}
export function preserveProviderBindings(previous: ProviderSnapshot, next: ProviderSnapshot): ProviderSnapshot {
  // Keep removed bindings visible so execution fails instead of silently billing another provider.
  return { ...next, ...(previous.bindings ? { bindings: previous.bindings } : {}), ...(previous.defaults ? { defaults: previous.defaults } : {}) }
}
export interface ProviderOwner { siteUrl: string; username: string; sync: ProviderSnapshot }
export const providerOwnerKey = (c: Pick<ProviderOwner, 'siteUrl' | 'username'>): string => createHash('sha256').update(`${normalizeSiteUrl(c.siteUrl)}\0${c.username}`).digest('hex')
interface Dependencies {
  read: () => Promise<ProviderOwner | null>
  write: (previous: ProviderOwner, next: ProviderSnapshot) => Promise<void>
  readSession: () => Promise<RoutingSession | null>; writeSession: (value: RoutingSession) => Promise<void>
  listModels: (connection: ProviderConnection) => Promise<AiModelInfo[]>
  readPreferences: () => Promise<BeginnerAiPreferences>
  applyDefaults: (selection: AiModelSelection, owner: ProviderOwner) => Promise<BeginnerAiPreferences>
  paidBusy: (account: string) => boolean
  fetcher?: typeof fetch; now?: () => number
}
export class ProviderSyncService {
  private cache = new Map<string, { at: number; models: AiModelInfo[] }>()
  private routes = new Map<string, { at: number; groups: Array<Record<string, unknown>> }>()
  private refreshTask?: Promise<void>
  private mutation = false
  get busy(): boolean { return this.mutation || Boolean(this.refreshTask) }
  private cooldownUntil = 0
  private readonly now: () => number
  constructor(private deps: Dependencies) { this.now = deps.now ?? Date.now }
  invalidate(): void { this.cache.clear(); this.routes.clear() }
  async initializeSession(): Promise<void> { const owner = await this.deps.read(); if (owner) await this.session(owner) }
  private async request(owner: ProviderOwner, path: string, bearer: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response
    try { response = await (this.deps.fetcher ?? fetch)(`${normalizeSiteUrl(owner.siteUrl)}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { throw new Error('无法连接模型服务，请稍后重试') }
    if (response.status === 429) { this.cooldownUntil = this.now() + Math.min(300, Math.max(1, Number(response.headers.get('Retry-After')) || 30)) * 1000 }
    if (!response.ok) throw new ProviderRequestError(response.status === 409 ? '供应商选择已变化或凭据未就绪，请刷新连接' : response.status === 401 || response.status === 403 ? '供应商授权已失效，请刷新连接或重新授权' : response.status === 429 ? '操作过于频繁，请稍后重试' : `模型服务暂不可用（${response.status}）`, response.status)
    const envelope = object(await response.json().catch(() => null))
    if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') throw new Error('模型服务返回无效数据')
    return object(envelope.data)
  }
  private async session(owner: ProviderOwner, force = false): Promise<RoutingSession> {
    const existing = await this.deps.readSession()
    if (!force && existing?.owner === providerOwnerKey(owner) && existing.expiresAt > this.now()) return existing
    let data: Record<string, unknown> | undefined
    for (const c of [...owner.sync.connections].sort((a,b)=>Number(b.kind==='paid')-Number(a.kind==='paid'))) {
      try { data = await this.request(owner, '/api/device/session', c.apiKey, {}); break }
      catch (error) { if (!(error instanceof ProviderRequestError) || ![401,403].includes(error.status)) throw error }
    }
    if (!data) throw new Error('现有连接均已失效，请重新同步账号')
    const expiresAt = Date.parse(String(data.routingTokenExpiresAt))
    if (typeof data.routingToken !== 'string' || !data.routingToken || data.routingToken.length > 4096 || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('无法建立连接刷新会话')
    const session = { owner: providerOwnerKey(owner), token: data.routingToken, expiresAt, ...(existing?.owner === providerOwnerKey(owner) && existing.pending ? { pending: existing.pending } : {}) }
    const current = await this.deps.read()
    if (!current || providerOwnerKey(current) !== session.owner) throw new Error('账号已切换，请重新操作')
    await this.deps.writeSession(session)
    return session
  }
  async refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask
    if (this.mutation || this.now() < this.cooldownUntil) throw new Error('连接正在更新，请稍后刷新')
    this.refreshTask = (async () => {
      const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
      await this.syncConnections(owner)
    })().finally(() => { this.refreshTask = undefined })
    return this.refreshTask
  }
  private async syncConnections(owner: ProviderOwner): Promise<ProviderOwner> {
    let session = await this.session(owner)
    let data: Record<string, unknown>
    try { data = await this.request(owner, '/api/device/providers?credentials=1', session.token) }
    catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 401) throw error
      session = await this.session(owner, true)
      data = await this.request(owner, '/api/device/providers?credentials=1', session.token)
    }
    if (data.username !== undefined && data.username !== owner.username) throw new Error('刷新返回了不同用户，已拒绝保存')
    const next = parseProviderSnapshot(data)
    if (next.selectionRevision < owner.sync.selectionRevision) throw new Error('收到旧的供应商选择，请重新刷新')
    await this.deps.write(owner, preserveProviderBindings(owner.sync, next))
    this.invalidate()
    const current = await this.deps.read()
    if (!current || providerOwnerKey(current) !== providerOwnerKey(owner)) throw new Error('账号已切换，请重新操作')
    if (session.pending) {
      const c = current.sync.connections.find(c => c.account === session.pending!.route.account)
      const models = c ? await this.models(current, c, true) : []
      if (!c || models.some(m => m.id === session.pending!.model) || (c.group !== session.pending.route.group && models.length)) {
        await this.deps.writeSession({ ...session, pending: undefined })
      }
    }
    return current
  }
  private cacheKey(owner: ProviderOwner, c: ProviderConnection): string { return createHash('sha256').update(JSON.stringify([providerOwnerKey(owner), c.account, c.apiKey, c.inferenceBaseUrl, c.group, owner.sync.selectionRevision])).digest('hex') }
  private async models(owner: ProviderOwner, c: ProviderConnection, force = false): Promise<AiModelInfo[]> {
    const key = this.cacheKey(owner, c), saved = this.cache.get(key)
    if (!force && saved && this.now() - saved.at < 60_000) return saved.models
    const models = c.models && !force && !saved ? c.models.map(id => ({ id })) : await this.deps.listModels(c)
    const filtered = models.filter(m => isSelectableQuotaModel(m.id)).slice(0, 512)
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, { at: this.now(), models: filtered })
    return filtered
  }
  async catalog(force = false): Promise<QuotaModelCatalog> {
    if (force) await this.refresh()
    const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
    const preferences = await this.deps.readPreferences()
    const currentAccount = preferences.account ?? owner.sync.defaultAccount
    let stale = false
    const models = (await Promise.all(owner.sync.connections.map(async c => {
      let list: AiModelInfo[] = [], available = true
      try { list = [...await this.models(owner, c, force)] } catch { available = false; stale = true; list = (c.models ?? []).map(id => ({ id })) }
      const billing = c.kind === 'free' ? 'free' as const : 'quota' as const
      let groupLabels: Array<Record<string, unknown>> = []
      if (c.kind === 'paid') {
        try {
          const key = this.cacheKey(owner, c)
          let cached = this.routes.get(key)
          if (force || !cached || this.now() - cached.at >= 60_000) {
            const state = await this.request(owner, '/api/device/group', c.apiKey)
            const providers = Array.isArray(state.providers) ? state.providers.map(object) : []
            const groups = providers.find(p => p.account === c.account)?.groups
            const labels = Array.isArray(groups) ? groups.map(object) : []
            cached = { at: this.now(), groups: state.canSwitch === true ? labels : [] }
            if (this.routes.size >= 32) this.routes.clear()
            this.routes.set(key, cached)
          }
          groupLabels = cached.groups
          for (const route of QUOTA_ROUTE_HINTS.filter(r => cached.groups.some(g=>g.id===r.group))) for (const id of route.models) if (!list.some(m => m.id === id)) list.push({ id })
        } catch { /* The verified current model list remains usable. */ }
      }
      return list.map(m => {
        const currentModels = this.cache.get(this.cacheKey(owner,c))?.models
        const route = currentModels?.some(x=>x.id===m.id) ? c.group : QUOTA_ROUTE_HINTS.find(r=>r.models.some(id=>id===m.id)&&groupLabels.some(g=>g.id===r.group))?.group
        const label = c.kind==='free' ? c.label : groupLabels.find(g=>g.id===route)?.label
        return { ...m, ...quotaModelMetadata(m.id), account: c.account, providerLabel: c.label, optionKey: quotaModelOptionKey(m.id, billing, c.account), billing, available, ...(typeof label==='string'&&/无缓存|\bno[\s-]+cache\b/i.test(label)?{noCache:true as const}:{}), ...(!available ? { unavailableReason: '模型列表暂不可用，请刷新重试' } : {}) }
      })
    }))).flat()
    const c = owner.sync.connections.find(c => c.account === currentAccount)
    const billing = c?.kind === 'free' ? 'free' : 'quota'
    const session = await this.deps.readSession()
    const pending = session?.owner === providerOwnerKey(owner) ? session.pending : undefined
    return { models, currentModel: preferences.model, currentOptionKey: quotaModelOptionKey(preferences.model, billing, currentAccount), billing, connected: true, canSwitch: !this.mutation, stale, checkedAt: this.now(), recoveryRequired: false, protocolVersion: 2,
      bindings: owner.sync.bindings, ...(c ? { currentRoute: { account: c.account, group: c.group, label: c.label } } : { message: '默认供应商已移除，请重新选择模型' }), ...(pending ? { recoveryRequired: true, pendingModel: pending.model, pendingSelection: { billing: 'quota' as const, account: pending.route.account }, message: '付费分组结果尚未确认，请刷新连接' } : {}) }
  }
  async resolve(selection?: AiModelSelection): Promise<{ owner: ProviderOwner; connection: ProviderConnection; model: string }> {
    if (this.mutation) throw new Error('连接正在更新，请稍候再发送')
    const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
    const preferences = await this.deps.readPreferences()
    const account = selection?.account ?? preferences.account ?? owner.sync.defaultAccount
    const connection = owner.sync.connections.find(c => c.account === account)
    if (!connection) throw new Error('所选供应商已移除，请重新选择；消息已保留')
    const session = await this.deps.readSession()
    if (connection.kind === 'paid' && session?.owner === providerOwnerKey(owner) && session.pending?.route.account === connection.account) throw new Error('付费分组切换结果尚未确认，请刷新连接后重试')
    if (selection?.billing && (selection.billing === 'free') !== (connection.kind === 'free')) throw new Error('模型计费版本与供应商不匹配，请重新选择')
    const model = selection?.model ?? preferences.model
    if (!(await this.models(owner, connection)).some(m => m.id === model)) throw new Error(`所选供应商当前分组不支持 ${model}，请重新选择模型`)
    return { owner, connection, model }
  }
  async select(model: string, option: QuotaModelSelection): Promise<QuotaModelSwitchResult> {
    if (this.mutation || this.refreshTask) throw new Error('连接正在更新，请稍后选择')
    if (!isSelectableQuotaModel(model)) throw new Error('请选择有效模型')
    this.mutation = true
    try {
      let owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
      const saved = await this.deps.readSession()
      if (saved?.owner === providerOwnerKey(owner) && saved.pending) owner = await this.syncConnections(owner)
      const preferences = await this.deps.readPreferences()
      const c = option.account ? owner.sync.connections.find(c => c.account === option.account) : owner.sync.connections.find(c => c.account === preferences.account && (c.kind === 'free') === (option.billing === 'free')) ?? owner.sync.connections.find(c => (c.kind === 'free') === (option.billing === 'free'))
      if (!c || (c.kind === 'free') !== (option.billing === 'free')) throw new Error('请在官网勾选所需供应商并同步连接')
      const otherSurface = option.scope === 'workspace' ? 'inspiration' : option.scope === 'inspiration' ? 'workspace' : undefined
      const other = otherSurface ? owner.sync.bindings?.[otherSurface] ?? preferences : undefined
      const sharesPaidConnection = c.kind === 'paid' && other && (other.account ?? owner.sync.defaultAccount) === c.account
      let linkOther = false
      if (sharesPaidConnection && other) {
        const family = quotaModelMetadata(model).family, otherFamily = quotaModelMetadata(other.model).family
        linkOther = family !== '其他' && otherFamily !== '其他' && family !== otherFamily
        if (linkOther && this.deps.paidBusy(c.account)) throw new Error('付费任务正在运行，完成后才能同时切换两个台的模型')
      }
      const list = await this.models(owner, c)
      if (!list.some(m => m.id === model)) {
        if (c.kind === 'free') throw new Error('这个免费供应商不支持所选模型')
        if (this.deps.paidBusy(c.account)) throw new Error('付费任务正在运行，完成后才能切换付费分组；可以选择已连接的免费模型')
        if (this.now() < this.cooldownUntil) throw new Error('切换过于频繁，请稍后重试')
        const state = await this.request(owner, '/api/device/group', c.apiKey)
        const providers = Array.isArray(state.providers) ? state.providers.map(object) : []
        const groups = providers.find(p => p.account === c.account)?.groups
        const groupIds = Array.isArray(groups) ? groups.map(g => object(g).id) : []
        const target = QUOTA_ROUTE_HINTS.find(r => r.models.some(id => id === model) && groupIds.includes(r.group))
        if (!target || state.canSwitch !== true) throw new Error('当前付费分组不支持所选模型，请在官网选择分组并刷新连接')
        if (sharesPaidConnection && other && !target.models.some(id => id === other.model)) linkOther = true
        const session = await this.session(owner)
        if (this.deps.paidBusy(c.account)) throw new Error('付费任务已经开始，请在任务结束后切换分组')
        await this.deps.writeSession({ ...session, pending: { model, route: { account: c.account, group: target.group } } })
        // v2 only changes the existing paid group; including account invokes the retired cross-provider path.
        let failure: unknown
        try { await this.request(owner, '/api/device/group', c.apiKey, { group: target.group, expectedAccount: state.account ?? state.provider, expectedGroup: state.current ?? state.group ?? null }) }
        catch (error) {
          if (error instanceof ProviderRequestError && error.status >= 400 && error.status < 500) {
            await this.deps.writeSession({ ...session, pending: undefined })
            throw error
          }
          failure = error
        }
        const next = parseProviderSnapshot(await this.request(owner, '/api/device/providers?credentials=1', session.token))
        await this.deps.write(owner, preserveProviderBindings(owner.sync, next)); this.invalidate()
        owner = (await this.deps.read())!
        const updated = owner?.sync.connections.find(x => x.account === c.account)
        if (!updated || updated.group !== target.group || !(await this.models(owner, updated, true)).some(m => m.id === model)) throw failure ?? new Error('目标分组尚未就绪，请刷新连接后重试')
        await this.deps.writeSession({ ...session, pending: undefined })
      }
      const pending = await this.deps.readSession()
      if (c.kind === 'paid' && pending?.owner === providerOwnerKey(owner) && pending.pending?.route.account === c.account) {
        // A new choice must be verified before releasing an unresolved paid binding.
        if (!(await this.models(owner, c, true)).some(m => m.id === model)) throw new Error('所选模型尚未就绪，请刷新后重试')
        await this.deps.writeSession({ ...pending, pending: undefined })
      }
      const selection: AiModelSelection = { model, account: c.account, billing: c.kind === 'free' ? 'free' : 'quota', reasoningLevel: 'auto' }
      let applied: BeginnerAiPreferences | undefined
      const linkedSelections = linkOther && otherSurface ? { [otherSurface]: selection } : undefined
      if (option.scope === 'workspace' || option.scope === 'inspiration') {
        await this.deps.write(owner, { ...owner.sync, bindings: { ...owner.sync.bindings, ...linkedSelections, [option.scope]: selection } })
      } else {
        applied = await this.deps.applyDefaults(selection, owner)
        await this.deps.write(owner, { ...owner.sync, defaults: selection, bindings: {} })
      }
      this.mutation = false
      return { status: 'ok', message: `已选择 ${quotaModelMetadata(model).name}${linkedSelections ? '，两个台已同步' : ''}`, selection, ...(linkedSelections ? { linkedSelections } : {}), ...(applied ? { preferences: applied } : {}), catalog: await this.catalog() }
    } finally { this.mutation = false }
  }
  async resetBinding(surface: 'workspace' | 'inspiration'): Promise<void> {
    if (this.busy) throw new Error('连接正在更新，请稍候再恢复默认')
    this.mutation = true
    try {
      const owner = await this.deps.read(); if (!owner) return
      const bindings = { ...owner.sync.bindings }; delete bindings[surface]
      await this.deps.write(owner, { ...owner.sync, bindings })
    } finally { this.mutation = false }
  }
}
