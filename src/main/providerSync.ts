import { createHash } from 'node:crypto'
import { modelCatalogFields, modelCatalogPath, parseDeviceModelCatalog, type DeviceModelCatalogFields } from './deviceModelCatalogApi'
import { normalizeRelayBaseUrl, normalizeSiteUrl } from './deviceIntegration'
import { networkFetch } from './networkRequest'
import { isSelectableQuotaModel, quotaModelMetadata, quotaModelDisplayMetadata, quotaModelOptionKey, validateQuotaModelSelection } from '../shared/quotaModels'
import type { QuotaModelCatalog, QuotaModelSelection, QuotaModelSwitchResult } from '../shared/quotaModels'
import type { AiModelSelection } from '../shared/aiSelection'
import type { AiModelInfo, BeginnerAiPreferences } from '../shared/types'
import type { RoutingSession } from './quotaModelRouting'
import { validProviderAccount, validProviderKind, PROVIDER_SYNC_CAPABILITY_HEADERS, PAID_PROVIDER_ACCOUNTS } from '../shared/providerAccounts'
import { parseProviderGroups, type ProviderGroup } from '../shared/providerRoutes'

export interface ProviderConnection extends DeviceModelCatalogFields {
  account: string; label: string; kind: 'free' | 'paid'; baseUrl: string; inferenceBaseUrl: string
  apiKey: string; model: string | null; models?: string[]; group: string | null; node: string | null
}
export interface ProviderSnapshot {
  protocolVersion: 2; selectionRevision: number; defaultAccount: string; connections: ProviderConnection[]
  bindings?: Partial<Record<'workspace' | 'inspiration', AiModelSelection>>
  defaults?: AiModelSelection
}
export { validProviderAccount } from '../shared/providerAccounts'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
class ProviderRequestError extends Error { constructor(message: string, readonly status: number, readonly requiresProviderSync = false, readonly code?: string) { super(message) } }
interface DirectoryProvider { account: string; label: string; kind: 'free' | 'paid'; groups: ProviderGroup[] }
interface DirectoryState { account: string; group: string | null; canSwitch: boolean; canSwitchProvider: boolean; providers: DirectoryProvider[] }
export function parseProviderSnapshot(value: unknown): ProviderSnapshot {
  const data = object(value)
  if (data.protocolVersion !== 2 || !Number.isSafeInteger(data.selectionRevision) || Number(data.selectionRevision) < 0 || !Array.isArray(data.connections) || !data.connections.length || data.connections.length > 256) throw new Error('多供应商同步响应无效')
  const accounts = new Set<string>()
  const connections = data.connections.map(raw => {
    const c = object(raw)
    if (!validProviderAccount(c.account) || accounts.has(c.account) || !validProviderKind(c.account, c.kind)) throw new Error('供应商标识或计费类型无效')
    accounts.add(c.account)
    if (typeof c.apiKey !== 'string' || !c.apiKey.trim() || c.apiKey.length > 4096 || /[\r\n\0]/.test(c.apiKey)) throw new Error('供应商凭据无效')
    if (c.models !== undefined && (!Array.isArray(c.models) || c.models.length > 16_384 || c.models.some(id => typeof id !== 'string'))) throw new Error('供应商模型列表无效')
    if (c.model !== null && c.model !== undefined && (typeof c.model !== 'string' || !isSelectableQuotaModel(c.model))) throw new Error('供应商默认模型无效')
    if ((c.group != null && typeof c.group !== 'string') || (c.node != null && typeof c.node !== 'string')) throw new Error('供应商线路无效')
    const baseUrl = normalizeRelayBaseUrl(typeof c.baseUrl === 'string' ? c.baseUrl : '')
    const inferenceBaseUrl = normalizeRelayBaseUrl(typeof c.inferenceBaseUrl === 'string' ? c.inferenceBaseUrl : `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}`)
    return { account: c.account, label: typeof c.label === 'string' ? c.label.slice(0, 256) : c.account, kind: c.kind, baseUrl, inferenceBaseUrl, apiKey: c.apiKey.trim(), model: typeof c.model === 'string' ? c.model : null,
      ...modelCatalogFields(c), ...(Array.isArray(c.models) ? { models: [...new Set((c.models as string[]).filter(isSelectableQuotaModel))].slice(0, 512) } : {}), group: typeof c.group === 'string' ? c.group : null, node: typeof c.node === 'string' ? c.node : null } as ProviderConnection
  })
  if (connections.filter(c => c.kind === 'paid').length > 1 || typeof data.defaultAccount !== 'string' || !accounts.has(data.defaultAccount)) throw new Error('供应商默认选择或付费组合无效')
  return { protocolVersion: 2, selectionRevision: Number(data.selectionRevision), defaultAccount: data.defaultAccount, connections }
}
export function preserveProviderBindings(previous: ProviderSnapshot, next: ProviderSnapshot): ProviderSnapshot {
  // Keep removed bindings visible so execution fails instead of silently billing another provider.
  return { ...next, ...(previous.bindings ? { bindings: previous.bindings } : {}), ...(previous.defaults ? { defaults: previous.defaults } : {}) }
}
export function pinProviderSelections(snapshot: ProviderSnapshot, preferences: BeginnerAiPreferences | AiModelSelection): ProviderSnapshot {
  const fallbackAccount = preferences.account ?? snapshot.defaultAccount
  const pin = (selection: AiModelSelection): AiModelSelection => {
    const c = snapshot.connections.find(c => c.account === (selection.account ?? fallbackAccount))
    if (!c) return selection
    if (c.kind === 'free') {
      const { group: _group, ...rest } = selection
      return { ...rest, account: c.account, billing: 'free' }
    }
    return selection.billing !== 'free' ? { ...selection, account: c.account, billing: 'quota', ...(selection.group === undefined && c.group ? { group: c.group } : {}) } : selection
  }
  return { ...snapshot, defaults: pin(snapshot.defaults ?? preferences), bindings: Object.fromEntries(Object.entries(snapshot.bindings ?? {}).map(([scope, value]) => [scope, pin(value!)])) }
}
/** Reauthorization is not a client route refresh. Only explicit client actions import routes. */
export function reconcileProviderSync(previous: ProviderSnapshot, next: ProviderSnapshot, _preferences: BeginnerAiPreferences | AiModelSelection): ProviderSnapshot {
  if (next.selectionRevision < previous.selectionRevision) return previous
  const connections = previous.connections.map(connection => {
    const incoming = next.connections.find(c => c.account === connection.account && c.kind === connection.kind && c.group === connection.group)
    if (!incoming || incoming.models === undefined) return connection
    return { ...connection, ...modelCatalogFields(incoming as unknown as Record<string, unknown>),
      ...(incoming.modelsReady !== false ? { models: incoming.models } : {}) }
  })
  return JSON.stringify(connections) === JSON.stringify(previous.connections) ? previous : { ...previous, connections }
}
export interface ProviderOwner { siteUrl: string; username: string; sync: ProviderSnapshot; authorizationKey?: string; refreshBeforeSelection?: boolean }
export const providerOwnerKey = (c: Pick<ProviderOwner, 'siteUrl' | 'username'>): string => createHash('sha256').update(`${normalizeSiteUrl(c.siteUrl)}\0${c.username}`).digest('hex')
export interface ProviderModelDiscovery {
  version: 1
  owner: string
  entries: Array<{ account: string; group: string | null; credential: string; at: number; models: AiModelInfo[] }>
  directory?: DirectoryState
}
const parseDirectoryProviders = (value: unknown): DirectoryProvider[] => (Array.isArray(value) ? value : []).slice(0, 32).flatMap(raw => {
  const p = object(raw)
  return validProviderAccount(p.account) && validProviderKind(p.account, p.kind)
    ? [{ account: p.account, label: typeof p.label === 'string' ? p.label.slice(0, 256) : p.account, kind: p.kind as 'free' | 'paid', groups: parseProviderGroups(p.groups) }] : []
})
const cleanModel = (value: unknown): AiModelInfo | undefined => {
  const m = object(value)
  if (typeof m.id !== 'string' || !isSelectableQuotaModel(m.id)) return undefined
  return { id: m.id, ...Object.fromEntries(['name', 'family', 'description', 'ownedBy'].flatMap(key => typeof m[key] === 'string' ? [[key, m[key].slice(0, key === 'description' ? 2048 : 256)]] : [])), ...(typeof m.recommended === 'boolean' ? { recommended: m.recommended } : {}) }
}
interface Dependencies {
  read: () => Promise<ProviderOwner | null>
  write: (previous: ProviderOwner, next: ProviderSnapshot) => Promise<void>
  readSession: () => Promise<RoutingSession | null>; writeSession: (value: RoutingSession) => Promise<void>
  readPreferences: () => Promise<BeginnerAiPreferences>
  applyDefaults: (selection: AiModelSelection, owner: ProviderOwner) => Promise<BeginnerAiPreferences>
  paidBusy: (account: string) => boolean
  authorizationBusy?: () => boolean
  readDiscovery?: () => Promise<ProviderModelDiscovery | null>
  writeDiscovery?: (value: ProviderModelDiscovery) => Promise<void>
  fetcher?: typeof fetch; now?: () => number
}
export class ProviderSyncService {
  private cache = new Map<string, { at: number; models: AiModelInfo[] }>()
  private routes = new Map<string, { at: number; state: DirectoryState }>()
  private learned = new Map<string, { at: number; models: AiModelInfo[]; credential: string }>()
  private discoveryOwner?: string
  private discoveryTask?: Promise<void>
  private discoveryWrites: Promise<unknown> = Promise.resolve()
  private catalogDirectory?: DirectoryState
  private savedDiscovery?: string
  private modelWarnings = new Map<string, string>()
  private catalogRetries = new Map<string, number>()
  private modelTasks = new Map<string, Promise<AiModelInfo[]>>()
  private directoryTasks = new Map<string, Promise<DirectoryState>>()
  private sessionTasks = new Map<string, Promise<RoutingSession>>()
  private sessionWrites: Promise<unknown> = Promise.resolve()
  private refreshTask?: Promise<void>
  private mutation = false
  get busy(): boolean { return this.mutation || Boolean(this.refreshTask) }
  private cooldownUntil = 0
  private readonly now: () => number
  constructor(private deps: Dependencies) { this.now = deps.now ?? Date.now }
  private paidBusy(): boolean { return PAID_PROVIDER_ACCOUNTS.some(account => this.deps.paidBusy(account)) }
  invalidate(): void { this.cache.clear(); this.routes.clear(); this.modelWarnings.clear() }
  async initializeSession(): Promise<void> { const owner = await this.deps.read(); if (owner) await this.session(owner) }
  async routingToken(): Promise<string> {
    const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
    return (await this.session(owner)).token
  }
  private async request(owner: ProviderOwner, path: string, bearer: string, body?: unknown): Promise<Record<string, unknown>> {
    const retryKey = providerOwnerKey(owner) + path
    if (path.startsWith('/api/device/models') && this.now() < (this.catalogRetries.get(retryKey) ?? 0)) throw new Error('官网模型列表暂不可用，请稍后刷新；已保留当前设置')
    let response: Response
    try { response = await (this.deps.fetcher ?? networkFetch)(`${normalizeSiteUrl(owner.siteUrl)}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000), headers: { ...PROVIDER_SYNC_CAPABILITY_HEADERS, Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { throw new Error('无法连接模型服务，请稍后重试') }
    if (response.status === 429) { this.cooldownUntil = this.now() + Math.min(300, Math.max(1, Number(response.headers.get('Retry-After')) || 30)) * 1000 }
    if (path.startsWith('/api/device/models') && [429, 503].includes(response.status)) {
      const retry = response.headers.get('Retry-After')
      const seconds = retry && Number.isFinite(Number(retry)) ? Number(retry) : retry ? (Date.parse(retry) - this.now()) / 1000 : response.status === 503 ? 60 : 30
      if (this.catalogRetries.size >= 256) this.catalogRetries.delete(this.catalogRetries.keys().next().value!)
      this.catalogRetries.set(retryKey, this.now() + Math.min(3600, Math.max(1, seconds || 60)) * 1000)
    }
    const envelope = object(await response.json().catch(() => null))
    if (!response.ok) {
      const code = envelope.code ?? object(envelope.error).code ?? object(envelope.data).code
      if (path.startsWith('/api/device/models') && response.status === 400 && code === 'MODEL_GROUP_NOT_CONFIGURED') {
        throw new ProviderRequestError('这个分组尚未配置模型目录，请在官网检查节点与分组', 400, false, code)
      }
      const requiresSync = envelope.multiProviderSyncRequired === true || object(envelope.data).multiProviderSyncRequired === true || object(envelope.error).multiProviderSyncRequired === true
      throw new ProviderRequestError(requiresSync ? '请在官网勾选所需供应商后重新同步；原线路未切换' : response.status === 400 ? '所选线路已变化或不再开放，请刷新后重新选择' : response.status === 402 ? '付费额度不足，请充值后重试；已连接的免费模型仍可选择' : response.status === 409 ? '供应商选择已变化或凭据未就绪，请刷新连接' : response.status === 401 || response.status === 403 ? '供应商授权已失效，请刷新连接或重新授权' : response.status === 429 ? '操作过于频繁，请稍后重试' : response.status === 503 ? (path.startsWith('/api/device/models') ? '官网模型列表尚未就绪，请稍后刷新；已保留当前模型设置' : '上游线路暂不可用，请稍后刷新重试') : `模型服务暂不可用（${response.status}）`, response.status, requiresSync)
    }
    if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') throw new Error('模型服务返回无效数据')
    return object(envelope.data)
  }
  private session(owner: ProviderOwner, force = false): Promise<RoutingSession> {
    const key = providerOwnerKey(owner), running = this.sessionTasks.get(key)
    if (running) return running
    const task = this.openSession(owner, force).finally(() => this.sessionTasks.delete(key))
    this.sessionTasks.set(key, task); return task
  }
  private storeSession(value: RoutingSession, preservePending = false): Promise<RoutingSession> {
    const write = async () => {
      const owner = await this.deps.read()
      if (!owner || providerOwnerKey(owner) !== value.owner) throw new Error('账号已切换，请重新操作')
      const latest = await this.deps.readSession()
      const sameOwner = latest?.owner === value.owner
      const next = preservePending
        ? { ...value, ...(sameOwner && latest.pending ? { pending: latest.pending } : { pending: undefined }) }
        : { ...value, ...(sameOwner ? { token: latest.token, expiresAt: latest.expiresAt } : {}) }
      await this.deps.writeSession(next)
      return next
    }
    const task = this.sessionWrites.then(write, write)
    this.sessionWrites = task.then(() => undefined, () => undefined)
    return task
  }
  private async openSession(owner: ProviderOwner, force: boolean): Promise<RoutingSession> {
    const existing = await this.deps.readSession()
    if (!force && existing?.owner === providerOwnerKey(owner) && existing.expiresAt > this.now()) return existing
    let data: Record<string, unknown> | undefined
    const keys = [...new Set([owner.authorizationKey, ...[...owner.sync.connections].sort((a,b)=>Number(b.kind==='paid')-Number(a.kind==='paid')).map(c => c.apiKey)].filter((key): key is string => Boolean(key)))]
    for (const key of keys) {
      try { data = await this.request(owner, '/api/device/session', key, {}); break }
      catch (error) { if (!(error instanceof ProviderRequestError) || ![401,403].includes(error.status)) throw error }
    }
    if (!data) throw new Error('现有连接均已失效，请重新同步账号')
    const expiresAt = Date.parse(String(data.routingTokenExpiresAt))
    if (typeof data.routingToken !== 'string' || !data.routingToken || data.routingToken.length > 4096 || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('无法建立连接刷新会话')
    const session = { owner: providerOwnerKey(owner), token: data.routingToken, expiresAt }
    const current = await this.deps.read()
    if (!current || providerOwnerKey(current) !== session.owner) throw new Error('账号已切换，请重新操作')
    return this.storeSession(session, true)
  }
  async refresh(): Promise<void> {
    if (this.deps.authorizationBusy?.()) throw new Error('账号正在同步，请完成后再刷新连接')
    if (this.refreshTask) return this.refreshTask
    if (this.mutation || this.now() < this.cooldownUntil) throw new Error('连接正在更新，请稍后刷新')
    this.refreshTask = (async () => {
      const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
      await this.syncConnections(owner)
    })().finally(() => { this.refreshTask = undefined })
    return this.refreshTask
  }
  private pinPreviousSelections(owner: ProviderOwner, preferences: BeginnerAiPreferences | AiModelSelection): ProviderSnapshot {
    return pinProviderSelections(owner.sync, preferences)
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
    const changedPaidRoute = owner.sync.connections.some(c => c.kind === 'paid' && next.connections.find(next => next.account === c.account)?.group !== c.group)
    const previous = changedPaidRoute ? this.pinPreviousSelections(owner, owner.sync.defaults ?? await this.deps.readPreferences()) : owner.sync
    await this.deps.write(owner, preserveProviderBindings(previous, next))
    this.invalidate()
    const current = await this.deps.read()
    if (!current || providerOwnerKey(current) !== providerOwnerKey(owner)) throw new Error('账号已切换，请重新操作')
    // Keep the previous inventory for display after a Key refresh. Routing still
    // requires learnedModels' matching credential and fresh membership checks.
    if (session.pending && !session.pending.scan) {
      const c = current.sync.connections.find(c => c.account === session.pending!.route.account)
      const actual = c ?? current.sync.connections.find(c => c.kind === 'paid')
      const models = actual ? await this.models(current, actual, true) : []
      if (!actual || (models.length && (!c || c.group !== session.pending.route.group || models.some(m => m.id === session.pending!.model)))) {
        await this.storeSession({ ...session, pending: undefined })
      }
    }
    return current
  }
  private async ensureFreshConnections(force: boolean): Promise<boolean> {
    if (this.mutation || this.deps.authorizationBusy?.()) return false
    // Opening a picker (or an account/usage notification) must never replace the
    // client's connections with the website's currently checked subset.
    if (!force) return true
    try { await this.refresh(); return true } catch { return false }
  }
  private cacheKey(owner: ProviderOwner, c: ProviderConnection): string { return createHash('sha256').update(JSON.stringify([providerOwnerKey(owner), c.account, c.apiKey, c.inferenceBaseUrl, c.group, owner.sync.selectionRevision])).digest('hex') }
  private async loadDiscovery(owner: ProviderOwner): Promise<void> {
    const key = providerOwnerKey(owner)
    if (this.discoveryOwner === key) return
    if (this.discoveryTask) { await this.discoveryTask; if (this.discoveryOwner === key) return }
    this.discoveryTask = (async () => {
      const value = await this.deps.readDiscovery?.().catch(() => null)
      this.learned.clear()
      this.modelWarnings.clear()
      this.catalogDirectory = undefined
      this.savedDiscovery = undefined
      if (value?.version === 1 && value.owner === key && Array.isArray(value.entries)) {
        const directory = object(value.directory)
        if (validProviderAccount(directory.account) && (directory.group === null || typeof directory.group === 'string')) this.catalogDirectory = {
          account: directory.account, group: directory.group as string | null, canSwitch: directory.canSwitch === true, canSwitchProvider: directory.canSwitchProvider === true, providers: parseDirectoryProviders(directory.providers)
        }
        let total = 0
        for (const entry of value.entries.slice(-256)) {
          if (!entry || !validProviderAccount(entry.account) || !(entry.group === null || typeof entry.group === 'string' && entry.group.length > 0 && entry.group.length <= 512) || !/^[a-f0-9]{64}$/.test(entry.credential) || !Number.isFinite(entry.at) || entry.at > this.now() || !Array.isArray(entry.models)) continue
          const c = owner.sync.connections.find(c => c.account === entry.account)
          // Keep old inventories visible; credential matching remains a routing check.
          if (c ? !validProviderKind(entry.account, c.kind) || c.kind === 'free' && entry.group !== null : !validProviderKind(entry.account, 'paid')) continue
          const models = entry.models.slice(0, 512).flatMap(m => { const clean = cleanModel(m); return clean ? [clean] : [] })
          total += models.length; if (total > 51_200) break
          this.learned.set(this.learnedKey(owner, entry.account, entry.group), { at: entry.at, credential: entry.credential, models })
        }
      }
      // Older cache files stored exact route memberships without a directory.
      // Rebuild their groups locally so upgrading does not hide those models.
      if (!this.catalogDirectory && this.learned.size) {
        const providers = new Map<string, DirectoryProvider>()
        for (const [route, entry] of this.learned) {
          const [, account, group] = JSON.parse(route) as [string, string, string | null]
          if (!validProviderKind(account, 'paid') || group === null) continue
          const provider = providers.get(account) ?? { account, label: owner.sync.connections.find(c => c.account === account)?.label ?? account, kind: 'paid' as const, groups: [] }
          provider.groups.push({ id: group, label: group, models: entry.models.map(model => model.id) })
          providers.set(account, provider)
        }
        const connection = owner.sync.connections.find(c => c.kind === 'paid')
        if (providers.size && connection) this.catalogDirectory = { account: connection.account, group: connection.group, canSwitch: false, canSwitchProvider: false, providers: [...providers.values()] }
      }
      this.discoveryOwner = key
    })().finally(() => { this.discoveryTask = undefined })
    return this.discoveryTask
  }
  private async saveDiscovery(owner: ProviderOwner): Promise<void> {
    if (!this.deps.writeDiscovery) return
    const write = async () => {
      const current = await this.deps.read()
      if (!current || providerOwnerKey(current) !== providerOwnerKey(owner)) throw new Error('账号已切换，未保存线路目录')
      const entries: ProviderModelDiscovery['entries'] = []
      let total = 0
      for (const [key, value] of [...this.learned].reverse()) {
        const [savedOwner, account, group] = JSON.parse(key) as [string, string, string | null]
        if (savedOwner !== providerOwnerKey(current)) continue
        const c = current.sync.connections.find(c => c.account === account)
        if (c ? !validProviderKind(account, c.kind) : !validProviderKind(account, 'paid')) continue
        const models = value.models.flatMap(m => { const clean = cleanModel(m); return clean ? [clean] : [] }).slice(0, 512)
        if (entries.length >= 256 || total + models.length > 51_200) throw new Error('线路模型目录超过缓存容量，请减少目录范围后重试')
        total += models.length; entries.push({ account, group, credential: value.credential, at: value.at, models })
      }
      const discovery: ProviderModelDiscovery = { version: 1, owner: providerOwnerKey(current), entries, ...(this.catalogDirectory ? { directory: this.catalogDirectory } : {}) }
      const serialized = JSON.stringify(discovery)
      if (serialized === this.savedDiscovery) return
      await this.deps.writeDiscovery!(discovery)
      this.savedDiscovery = serialized
    }
    const task = this.discoveryWrites.then(write, write)
    this.discoveryWrites = task.then(() => undefined, () => undefined)
    await task
  }
  private async models(owner: ProviderOwner, c: ProviderConnection, force = false, remember = true, explicitGroup = false): Promise<AiModelInfo[]> {
    const key = this.cacheKey(owner, c), saved = this.cache.get(key)
    if (!force && saved && this.now() - saved.at < 60_000) return saved.models
    const running = this.modelTasks.get(key); if (running) return running
    const task = (async () => {
      if (this.now() < this.cooldownUntil) throw new Error('操作过于频繁，请稍后刷新模型列表')
      const embedded = !force && !saved && !this.learnedModels(owner, c.account, c.group) && c.models !== undefined && c.modelsReady !== false
      let models: AiModelInfo[]
      if (embedded) {
        models = c.models!.map(id => ({ id }))
        if (c.modelsStale) this.modelWarnings.set(key, '官网暂未更新模型列表，正在显示最近成功的列表')
      } else {
        const path = modelCatalogPath(owner.siteUrl, c.account, c.modelsUrl, explicitGroup && c.group !== null ? c.group : undefined)
        const active = owner.sync.connections.find(connection => connection.account === c.account)
        let bearer = active?.apiKey ?? (await this.session(owner)).token
        let data: Record<string, unknown>
        try { data = await this.request(owner, path, bearer) }
        catch (error) {
          if (!(error instanceof ProviderRequestError) || error.status !== 401) throw error
          bearer = (await this.session(owner, true)).token
          data = await this.request(owner, path, bearer)
        }
        const catalog = parseDeviceModelCatalog(data, c.account, explicitGroup && c.group !== null ? c.group : undefined)
        if (catalog.group !== c.group) throw new Error('官网分组已变化，请刷新连接后重新选择模型；已保留当前设置')
        models = catalog.models
        if (catalog.stale) this.modelWarnings.set(key, '官网暂未更新模型列表，正在显示最近成功的列表')
        else this.modelWarnings.delete(key)
      }
      const filtered = [...new Map(models.filter(m => isSelectableQuotaModel(m.id)).map(m => [m.id, m])).values()].slice(0, 512)
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: this.now(), models: filtered })
      if (remember) {
        const route = this.learnedKey(owner, c.account, c.group)
        if (!this.learned.has(route) && this.learned.size >= 256) this.learned.delete(this.learned.keys().next().value!)
        this.learned.set(route, { at: this.now(), models: filtered, credential: this.credentialKey(c) })
      }
      return filtered
    })().finally(() => this.modelTasks.delete(key))
    this.modelTasks.set(key, task); return task
  }
  private learnedKey(owner: ProviderOwner, account: string, group: string | null): string { return JSON.stringify([providerOwnerKey(owner), account, group]) }
  private credentialKey(c: ProviderConnection): string { return createHash('sha256').update(JSON.stringify([c.apiKey, c.inferenceBaseUrl])).digest('hex') }
  private learnedModels(owner: ProviderOwner, account: string, group: string | null, display = false): AiModelInfo[] | undefined {
    const saved = this.learned.get(this.learnedKey(owner, account, group))
    const connection = owner.sync.connections.find(c => c.account === account)
    return saved && (display || !connection || saved.credential === this.credentialKey(connection)) ? saved.models : undefined
  }
  private rebindDiscovery(owner: ProviderOwner, account: string, previousCredential?: string): void {
    const connection = owner.sync.connections.find(c => c.account === account && c.kind === 'paid')
    if (!connection) return
    for (const [key, value] of this.learned) {
      const [savedOwner, savedAccount] = JSON.parse(key) as [string, string]
      if (savedOwner === providerOwnerKey(owner) && savedAccount === account && (previousCredential === undefined || value.credential === previousCredential)) this.learned.set(key, { ...value, credential: this.credentialKey(connection) })
    }
  }
  private async directory(owner: ProviderOwner, force = false): Promise<DirectoryState> {
    const c = owner.sync.connections.find(c => c.kind === 'paid') ?? owner.sync.connections[0]
    const key = this.cacheKey(owner, c), saved = this.routes.get(key)
    if (!force && saved && this.now() - saved.at < 60_000) return saved.state
    const running = this.directoryTasks.get(key); if (running) return running
    const task = (async () => {
      const data = await this.request(owner, '/api/device/group', c.apiKey)
      const providers = parseDirectoryProviders(data.providers)
      if (c.kind === 'paid' && !providers.some(p => p.account === c.account)) providers.push({ account: c.account, label: c.label, kind: 'paid', groups: parseProviderGroups(data.groups) })
      const state: DirectoryState = { account: validProviderAccount(data.account ?? data.provider) ? String(data.account ?? data.provider) : c.account, group: typeof (data.current ?? data.group) === 'string' ? String(data.current ?? data.group) : null, canSwitch: data.canSwitch === true, canSwitchProvider: data.canSwitchProvider === true, providers }
      if (this.routes.size >= 32) this.routes.delete(this.routes.keys().next().value!)
      this.routes.set(key, { at: this.now(), state }); return state
    })().finally(() => this.directoryTasks.delete(key))
    this.directoryTasks.set(key, task); return task
  }
  /** Compatibility entry point: refresh server catalogs without switching any route. */
  async discoverModels(): Promise<QuotaModelCatalog> {
    if (this.deps.authorizationBusy?.()) throw new Error('账号正在同步，请完成后再刷新模型')
    return this.catalog(true)
  }
  async catalog(force = false, cached = false): Promise<QuotaModelCatalog> {
    if (force && this.busy) return this.catalog(false)
    if (force) this.invalidate()
    const fresh = cached || await this.ensureFreshConnections(force)
    const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
    await this.loadDiscovery(owner)
    const preferences = owner.sync.defaults ?? await this.deps.readPreferences()
    const currentAccount = preferences.account ?? owner.sync.defaultAccount
    const c = owner.sync.connections.find(c => c.account === currentAccount)
    const billing = c?.kind === 'free' ? 'free' : 'quota'
    let stale = !fresh, directory: DirectoryState | undefined
    let catalogWarning: string | undefined
    const current = new Map<string, { models: AiModelInfo[]; available: boolean }>()
    const loadConnection = async (connection: ProviderConnection) => {
      const previous = this.learnedModels(owner, connection.account, connection.group, true) ?? (connection.models ?? []).map(id => ({ id }))
      if (cached) { current.set(connection.account, { models: previous, available: true }); return }
      try { current.set(connection.account, { models: await this.models(owner, connection, force), available: true }) }
      catch (error) { stale = true; catalogWarning = error instanceof Error ? error.message : '无法读取官网模型列表'; current.set(connection.account, { models: previous, available: false }) }
    }
    for (let offset = 0; offset < owner.sync.connections.length; offset += 8) await Promise.all(owner.sync.connections.slice(offset, offset + 8).map(loadConnection))
    if (!cached) try { directory = await this.directory(owner, force) } catch { stale = true }
    directory = directory ?? this.catalogDirectory
    if (directory && !cached) {
      // These are read-only website cache requests. They never change groups or contact inference providers.
      let reads = 0
      for (const provider of directory.providers) {
        if (provider.kind !== 'paid') continue
        const unconfigured = new Set<string>()
        for (const group of provider.groups) {
          const active = owner.sync.connections.find(c => c.account === provider.account)
          if (active?.group === group.id) { group.models = current.get(active.account)?.models.map(m => m.id) ?? []; continue }
          if (!force && group.models !== undefined) continue
          if (++reads > 100) { stale = true; continue }
          const connection: ProviderConnection = { ...(active ?? owner.sync.connections[0]), account: provider.account, label: provider.label, kind: 'paid', group: group.id, models: undefined, modelsReady: undefined, modelsUrl: undefined }
          try { group.models = (await this.models(owner, connection, force, true, true)).map(m => m.id) }
          catch (error) {
            if (error instanceof ProviderRequestError && error.code === 'MODEL_GROUP_NOT_CONFIGURED') {
              unconfigured.add(group.id)
              this.learned.delete(this.learnedKey(owner, provider.account, group.id))
            } else { stale = true; catalogWarning ??= error instanceof Error ? error.message : '部分官网模型列表暂不可用' }
          }
        }
        provider.groups = provider.groups.filter(group => !unconfigured.has(group.id))
      }
      directory.providers = directory.providers.filter(p => p.groups.length || owner.sync.connections.some(c => c.account === p.account))
    }
    if (!cached && this.modelWarnings.size) { stale = true; catalogWarning ??= this.modelWarnings.values().next().value }
    if (!cached && directory) {
      const allowed = new Set(directory.providers.flatMap(p => p.groups.map(g => this.learnedKey(owner, p.account, g.id))))
      for (const key of this.learned.keys()) {
        const [, account, group] = JSON.parse(key)
        if (group !== null && !allowed.has(key) && !owner.sync.connections.some(c => c.account === account && c.group === group)) this.learned.delete(key)
      }
    }
    if (!cached && !this.mutation && directory) this.catalogDirectory = directory
    const actualPaid = owner.sync.connections.find(c => c.kind === 'paid')
    const known = actualPaid ? current.get(actualPaid.account)?.models ?? [] : []
    const routes: NonNullable<QuotaModelCatalog['routes']> = []
    const models: QuotaModelCatalog['models'] = []
    const optionKeys = new Set<string>()
    const add = (model: AiModelInfo, account: string, group: string | null, label: string, groupLabel: string | undefined, kind: 'free' | 'paid', available: boolean, verified: boolean, routeCurrent: boolean, reason?: string, candidate = false) => {
      const billing = kind === 'free' ? 'free' as const : 'quota' as const
      const key = quotaModelOptionKey(model.id, billing, account, kind === 'paid' ? group : undefined)
      if (optionKeys.has(key) || models.length >= 4096) return
      optionKeys.add(key)
      models.push({ ...model, ...quotaModelDisplayMetadata(model), account, billing, providerLabel: label, ...(kind === 'paid' ? { group, groupLabel, routeCurrent } : {}), optionKey: key, modelEvidence: verified ? 'verified' : 'unknown', available,
        ...(groupLabel && /无缓存|\bno[\s-]+cache\b/i.test(groupLabel) ? { noCache: true as const } : {}), ...(!available ? { unavailableReason: reason ?? '模型列表暂不可用，请刷新重试' } : {}) })
    }
    for (const connection of [...owner.sync.connections].sort((a, b) => Number(b.account === currentAccount) - Number(a.account === currentAccount))) {
      const result = current.get(connection.account)!
      const provider = directory?.providers.find(p => p.account === connection.account)
      const groupLabel = provider?.groups.find(g => g.id === connection.group)?.label ?? connection.group ?? undefined
      for (const model of result.models) add(model, connection.account, connection.group, connection.label, groupLabel, connection.kind, result.available, true, true)
      if (connection.kind === 'free') routes.push({ account: connection.account, group: null, label: connection.label, providerLabel: connection.label, kind: 'free', current: true, available: result.available, models: result.models.map(m => m.id) })
    }
    for (const provider of [...(directory?.providers ?? [])].sort((a, b) => Number(b.account === actualPaid?.account) - Number(a.account === actualPaid?.account))) {
      if (provider.kind !== 'paid') continue
      for (const group of provider.groups) {
        const isCurrent = actualPaid?.account === provider.account && actualPaid.group === group.id
        const available = isCurrent || (this.now() >= this.cooldownUntil && !this.paidBusy() && (provider.account === actualPaid?.account ? directory!.canSwitch : directory!.canSwitchProvider))
        const learned = this.learnedModels(owner, provider.account, group.id, true)
        const candidates = (group.models !== undefined ? group.models.map(id => known.find(m => m.id === id) ?? { id }) : learned ?? [])
        routes.push({ account: provider.account, group: group.id, label: group.label, providerLabel: provider.label, kind: 'paid', current: isCurrent, available, ...(group.models || learned ? { models: candidates.map(m => m.id) } : {}) })
        if (isCurrent) {
          for (const model of candidates) add(model, provider.account, group.id, provider.label, group.label, 'paid', current.get(provider.account)?.available ?? false, true, true)
          continue
        }
        for (const model of candidates) add(model, provider.account, group.id, provider.label, group.label, 'paid', available, Boolean(group.models?.includes(model.id) || learned?.some(m => m.id === model.id)), false, '当前线路暂不可切换', true)
      }
    }
    const saved = await this.deps.readSession(), pending = saved?.owner === providerOwnerKey(owner) ? saved.pending : undefined
    const selectionRequired = !c || (preferences.group !== undefined && c.group !== preferences.group) || !current.get(currentAccount)?.models.some(m => m.id === preferences.model)
    const providers = [...new Map([...owner.sync.connections.map(c => ({ account: c.account, label: c.label, kind: c.kind })), ...(directory?.providers.filter(p => p.kind === 'paid').map(p => ({ account: p.account, label: p.label, kind: p.kind })) ?? [])].map(p => [p.account, p])).values()]
    const activeOwner = await this.deps.read()
    if (!activeOwner || providerOwnerKey(activeOwner) !== providerOwnerKey(owner)) throw new Error('账号已切换，请重新读取模型列表')
    let cacheWarning: string | undefined
    if (!cached && !this.mutation) try { await this.saveDiscovery(owner) } catch { cacheWarning = '模型列表已更新，但未能保存到本地；下次启动将使用上次保存的列表' }
    return { models, routes, providers, currentModel: preferences.model, currentOptionKey: quotaModelOptionKey(preferences.model, billing, currentAccount, billing === 'quota' ? preferences.group ?? c?.group : undefined), billing, connected: true, canSwitch: !this.busy && this.now() >= this.cooldownUntil, stale, checkedAt: this.now(), protocolVersion: 2, bindings: owner.sync.bindings, recoveryRequired: Boolean(pending), selectionRequired,
      ...(c ? { currentRoute: { account: c.account, group: c.group, label: c.label } } : {}),
      ...(cacheWarning ? { message: cacheWarning } : stale ? { message: catalogWarning ?? '模型列表更新失败，已保留上次列表，请刷新重试' } : {}),
      ...(selectionRequired && !stale ? { message: '所选线路或模型已变化，请重新选择；消息已保留' } : {}),
      ...(pending ? { pendingModel: pending.model, pendingSelection: { billing: 'quota' as const, account: pending.route.account, ...(pending.route.group !== null ? { group: pending.route.group } : {}) }, message: '付费线路结果尚未确认，请刷新连接后选择模型' } : {}) }
  }
  async resolve(selection?: AiModelSelection): Promise<{ owner: ProviderOwner; connection: ProviderConnection; model: string }> {
    if (this.mutation) throw new Error('连接正在更新，请稍候再发送')
    const owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
    const preferences = owner.sync.defaults ?? await this.deps.readPreferences()
    const selected = selection ?? preferences
    const account = selected.account ?? preferences.account ?? owner.sync.defaultAccount
    const connection = owner.sync.connections.find(c => c.account === account)
    if (!connection) throw new Error('所选供应商已移除，请重新选择；消息已保留')
    const session = await this.deps.readSession()
    if (connection.kind === 'paid' && session?.owner === providerOwnerKey(owner) && session.pending) throw new Error('付费线路切换结果尚未确认，请刷新连接后重试')
    if (selected.billing && (selected.billing === 'free') !== (connection.kind === 'free')) throw new Error('模型计费版本与供应商不匹配，请重新选择')
    const expectedGroup = selected.group ?? ((selected.account === undefined || selected.account === preferences.account) && selected.billing !== 'free' ? preferences.group : undefined)
    if (expectedGroup !== undefined && expectedGroup !== connection.group) throw new Error('所选付费分组已变化，请重新选择线路；消息已保留')
    const model = selected.model
    if (connection.kind === 'paid') {
      // The website can move a Key to another group without rotating the Key.
      // Check the paid route live before returning any inference credentials.
      const actual = await this.directory(owner, true)
      if (actual.account !== connection.account || actual.group !== connection.group) {
        await this.syncConnections(owner)
        throw new Error('上游付费线路已变化，请重新选择线路；消息已保留')
      }
    }
    if (!(await this.models(owner, connection, true)).some(m => m.id === model)) throw new Error('所选线路不支持这个模型，请重新选择；消息已保留')
    const current = await this.deps.read()
    if (!current || providerOwnerKey(current) !== providerOwnerKey(owner) || JSON.stringify(current.sync) !== JSON.stringify(owner.sync)) throw new Error('连接已变化，请重新选择模型；消息已保留')
    return { owner, connection, model }
  }
  async select(model: string, option: QuotaModelSelection): Promise<QuotaModelSwitchResult> {
    if (this.deps.authorizationBusy?.()) throw new Error('账号正在同步，请完成后再选择模型')
    if (this.mutation || this.refreshTask) throw new Error('连接正在更新，请稍后选择')
    if (!isSelectableQuotaModel(model)) throw new Error('请选择有效模型')
    option = validateQuotaModelSelection(option)
    this.mutation = true
    try {
      let owner = await this.deps.read(); if (!owner) throw new Error('请先同步供应商连接')
      // An explicit activation may need new credentials after website authorization.
      // The read-only catalog and local route preparation never take this path.
      if (owner.refreshBeforeSelection) owner = await this.syncConnections(owner)
      await this.loadDiscovery(owner)
      if (option.billing === 'free' && option.account !== undefined && !owner.sync.connections.some(c => c.account === option.account && c.kind === 'free')) throw new Error('这个免费供应商尚未同步，请重新同步连接')
      const saved = await this.deps.readSession()
      if (option.billing !== 'free' && saved?.owner === providerOwnerKey(owner) && saved.pending?.scan) throw new Error('原付费线路尚未恢复，请在官网恢复原线路后刷新连接')
      if (option.billing !== 'free' && saved?.owner === providerOwnerKey(owner) && saved.pending) owner = await this.syncConnections(owner)
      const preferences = owner.sync.defaults ?? await this.deps.readPreferences()
      const kind = option.billing === 'free' ? 'free' : 'paid'
      let discoveryChanged = false
      const targetAccount = option.account ?? owner.sync.connections.find(c => c.account === preferences.account && c.kind === kind)?.account ?? owner.sync.connections.find(c => c.kind === kind)?.account
      if (!targetAccount) throw new Error('请在官网勾选所需供应商并同步连接')
      let connection = owner.sync.connections.find(c => c.account === targetAccount)
      if (connection && connection.kind !== kind) throw new Error('模型计费版本与供应商不匹配')
      let list: AiModelInfo[] = []
      if (connection) { try { list = await this.models(owner, connection, kind === 'free') } catch (error) { if (!option.group || option.group === connection.group) throw error } }
      if (kind === 'free') {
        if (!connection || !list.some(m => m.id === model)) throw new Error('这个免费供应商不支持所选模型')
      } else if (!connection || (option.group !== undefined && option.group !== connection.group) || !list.some(m => m.id === model)) {
        const oldPaid = owner.sync.connections.find(c => c.kind === 'paid')
        if (this.paidBusy()) throw new Error('付费任务正在运行，完成后才能切换付费线路；可以选择已连接的免费模型')
        if (this.now() < this.cooldownUntil) throw new Error('切换过于频繁，请稍后重试')
        const state = await this.directory(owner, true)
        const provider = state.providers.find(p => p.account === targetAccount && p.kind === 'paid')
        const matchingGroups = provider?.groups.filter(g => g.models?.includes(model) || this.learnedModels(owner!, targetAccount, g.id)?.some(m => m.id === model)) ?? []
        const target = option.group !== undefined ? provider?.groups.find(g => g.id === option.group) : matchingGroups.length === 1 ? matchingGroups[0] : undefined
        if (!target) throw new Error('请选择该模型的具体线路；上游尚未提供完整分组模型目录')
        const knownModels = target.models ?? this.learnedModels(owner, targetAccount, target.id)?.map(m => m.id)
        if (!knownModels || !knownModels.includes(model)) throw new Error('这条线路尚未验证支持所选模型，请刷新后选择有模型目录的线路')
        if (!oldPaid || state.account !== oldPaid.account || state.group !== oldPaid.group) throw new Error('付费线路已变化，请刷新连接后重新选择')
        const crossProvider = oldPaid.account !== targetAccount
        if (crossProvider ? !state.canSwitchProvider : !state.canSwitch) throw new Error('当前账号暂时不能切换这条线路')
        if (connection?.group === target.id) throw new Error('当前分组没有返回所选模型，请选择本组实际模型')
        // Pin old paid bindings before a shared credential changes its group.
        await this.deps.write(owner, this.pinPreviousSelections(owner, preferences))
        const pinned = await this.deps.read()
        if (!pinned || providerOwnerKey(pinned) !== providerOwnerKey(owner)) throw new Error('账号已切换，请重新选择线路')
        owner = pinned
        let session = await this.session(owner)
        if (this.paidBusy()) throw new Error('付费任务已经开始，请在任务结束后切换线路')
        session = await this.storeSession({ ...session, pending: { model, route: { account: targetAccount, group: target.id } } })
        let failure: unknown
        try { await this.request(owner, '/api/device/group', crossProvider ? session.token : oldPaid.apiKey, { ...(crossProvider ? { account: targetAccount } : {}), group: target.id, expectedAccount: state.account, expectedGroup: state.group }) }
        catch (error) { failure = error }
        if (failure instanceof ProviderRequestError && failure.requiresProviderSync) {
          await this.storeSession({ ...session, pending: undefined })
          await this.syncConnections(owner)
          this.mutation = false
          return { status: 'error', message: failure.message, requiresProviderSync: true, catalog: await this.catalog() }
        }
        owner = await this.syncConnections(owner)
        connection = owner.sync.connections.find(c => c.account === targetAccount)
        if (!connection || connection.group !== target.id) throw failure ?? new Error('目标线路尚未确认，请刷新后重试')
        const actual = await this.directory(owner, true)
        if (actual.account !== targetAccount || actual.group !== target.id) throw new Error('目标线路尚未确认，请刷新后重试')
        list = await this.models(owner, connection, true)
        if (!list.some(m => m.id === model)) throw new Error('已切换线路，但本组不支持所选模型；请选择本组模型')
        // Only our verified mutation can carry learned membership over a Key rotation.
        // An unrelated website refresh or replacement Key continues to invalidate that evidence.
        this.rebindDiscovery(owner, targetAccount, crossProvider ? undefined : this.credentialKey(oldPaid))
        discoveryChanged = true
      }
      if (!connection) throw new Error('所选供应商已移除，请重新选择')
      const pending = await this.deps.readSession()
      if (kind === 'paid' && pending?.owner === providerOwnerKey(owner) && pending.pending) {
        if (!(await this.models(owner, connection, true)).some(m => m.id === model)) throw new Error('所选模型尚未就绪，请刷新后重试')
        await this.storeSession({ ...pending, pending: undefined })
      }
      const selection: AiModelSelection = { model, account: connection.account, billing: kind === 'free' ? 'free' : 'quota', reasoningLevel: 'auto', ...(kind === 'paid' && connection.group ? { group: connection.group } : {}) }
      let applied: BeginnerAiPreferences | undefined
      if (option.scope === 'workspace' || option.scope === 'inspiration') await this.deps.write(owner, { ...owner.sync, bindings: { ...owner.sync.bindings, [option.scope]: selection } })
      else { applied = await this.deps.applyDefaults(selection, owner); await this.deps.write(owner, { ...owner.sync, defaults: selection, bindings: {} }) }
      let cacheWarning = ''
      if (discoveryChanged) try { await this.saveDiscovery(owner) } catch { cacheWarning = '；线路目录未保存，下次启动请刷新模型列表' }
      this.mutation = false
      return { status: 'ok', message: '已选择 ' + quotaModelMetadata(model).name + cacheWarning, selection, ...(applied ? { preferences: applied } : {}), catalog: await this.catalog() }
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
