import { createHash } from 'node:crypto'
import { normalizeRelayBaseUrl, normalizeSiteUrl } from './deviceIntegration'
import { isSelectableQuotaModel, QUOTA_MODEL_METADATA, QUOTA_ROUTE_HINTS, FREE_ROUTE_HINTS, quotaModelMetadata, quotaModelOptionKey, validateQuotaModelSelection } from '../shared/quotaModels'
import type { QuotaModelCatalog, QuotaModelSwitchResult, QuotaRoute, QuotaModelOption, QuotaModelSelection } from '../shared/quotaModels'
import type { AiModelInfo, BeginnerAiPreferences } from '../shared/types'

export interface RoutingCredentials { siteUrl: string; baseUrl: string; apiKey: string; username: string; balanceCents: string; provider?: 'custom'; account?: string; group?: string | null; node?: string }
export interface RoutingSession {
  owner: string; token: string; expiresAt: number
  pending?: { model: string; route: QuotaRoute }
}
interface Provider { account: string; label: string; kind: string; groups: { id: string; label: string }[] }
interface RoutingState extends QuotaRoute { providers: Provider[]; keyStatus: string; canSwitch: boolean; canSwitchProvider: boolean }
export interface QuotaRoutingDependencies {
  readCredentials: () => Promise<RoutingCredentials | null>
  writeCredentials: (value: RoutingCredentials) => Promise<void>
  readSession: () => Promise<RoutingSession | null>
  writeSession: (value: RoutingSession) => Promise<void>
  clearSession: () => Promise<void>
  listModels: (credentials: RoutingCredentials) => Promise<AiModelInfo[]>
  readPreferences: () => Promise<BeginnerAiPreferences>
  applyModel: (model: string) => Promise<BeginnerAiPreferences>
  fetcher?: typeof fetch
  now?: () => number
  upgradeConnections?: (credentials: RoutingCredentials, session: RoutingSession) => Promise<boolean>
}
class RouteError extends Error {
  constructor(message: string, readonly status = 0, readonly retryAfter = 0) { super(message) }
}
class MultiProviderSyncRequired extends RouteError {
  constructor() { super('请在官网勾选需要的供应商并同步连接', 409) }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const owner = (c: RoutingCredentials): string => createHash('sha256').update(`${c.siteUrl}\0${c.username}`).digest('hex')
const sameRoute = (a: QuotaRoute, b: QuotaRoute): boolean => a.account === b.account && a.group === b.group
const noCacheMark = (label: string | undefined): { noCache?: true } => label && /无缓存|\bno[\s-]+cache\b/i.test(label) ? { noCache: true } : {}
const messages: Record<number, string> = {
  400: '线路选项已变化，请刷新模型列表', 401: '账号授权已失效，请重新连接账号',
  402: '余额不足，请充值后重试', 403: '当前账号暂时不能使用这条线路',
  409: '线路状态发生变化，请刷新后重试', 429: '切换过于频繁，请稍后重试',
  502: '模型服务暂时不可用，请稍后重试', 503: '模型服务暂时不可用，请稍后重试'
}
/** One active account cache, bounded lists, no credentials in public results. */
export class QuotaModelRouting {
  private cache?: { owner: string; key: string; state: RoutingState; models: AiModelInfo[]; at: number }
  private switching = false
  private cooldownUntil = 0
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  constructor(private readonly deps: QuotaRoutingDependencies) { this.now = deps.now ?? Date.now; this.fetcher = deps.fetcher ?? fetch }
  get busy(): boolean { return this.switching }
  invalidate(): void { this.cache = undefined }
  async reset(): Promise<void> { this.invalidate(); this.cooldownUntil = 0; await this.deps.clearSession() }
  private async session(c: RoutingCredentials): Promise<RoutingSession | null> {
    const saved = await this.deps.readSession()
    return saved?.owner === owner(c) ? saved : null
  }
  async recoveryRequired(): Promise<boolean> {
    const c = await this.deps.readCredentials()
    return Boolean(c && !c.provider && (await this.session(c))?.pending)
  }
  private async request(c: RoutingCredentials, endpoint: string, bearer: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response
    try { response = await this.fetcher(`${normalizeSiteUrl(c.siteUrl)}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }) } catch { throw new RouteError('无法连接模型服务，请检查网络后重试') }
    const seconds = Number(response.headers.get('Retry-After'))
    const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : 30_000
    // Do not propagate upstream error bodies: they may contain reflected credentials.
    const envelope = record(await response.json().catch(() => null))
    if (response.status === 409 && (envelope.multiProviderSyncRequired === true || record(envelope.data).multiProviderSyncRequired === true)) throw new MultiProviderSyncRequired()
    if (!response.ok) throw new RouteError(messages[response.status] ?? `模型服务请求失败（${response.status}）`, response.status, retryAfter)
    if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') throw new RouteError('模型服务返回了无效数据')
    return record(envelope.data)
  }
  private parseState(data: Record<string, unknown>): RoutingState {
    const account = str(data.account) || str(data.provider)
    if (!account) throw new RouteError('线路状态缺少供应商')
    const providers: Provider[] = (Array.isArray(data.providers) ? data.providers : []).slice(0, 32).map(raw => {
      const p = record(raw)
      return { account: str(p.account), label: str(p.label), kind: str(p.kind), groups: (Array.isArray(p.groups) ? p.groups : []).slice(0, 100).map(rawGroup => {
        const g = record(rawGroup); return { id: str(g.id), label: str(g.label) }
      }).filter(g => g.id && g.id.length < 512) }
    }).filter(p => p.account && p.account !== 'primary')
    const group = str(data.current ?? data.group) || null
    return { account, group, providers, keyStatus: str(data.keyStatus), canSwitch: data.canSwitch === true,
      canSwitchProvider: data.canSwitchProvider === true, label: group ? providers.find(p => p.account === account)?.groups.find(g => g.id === group)?.label : providers.find(p => p.account === account)?.label }
  }
  private async readState(c: RoutingCredentials, session: RoutingSession | null): Promise<RoutingState> {
    try { return this.parseState(await this.request(c, '/api/device/group', session && session.expiresAt > this.now() ? session.token : c.apiKey)) }
    catch (error) {
      if (!(error instanceof RouteError) || error.status !== 401 || !session) throw error
      session.expiresAt = 0
      await this.deps.writeSession(session)
      return this.parseState(await this.request(c, '/api/device/group', c.apiKey))
    }
  }
  private async ensureSession(c: RoutingCredentials, existing: RoutingSession | null): Promise<RoutingSession> {
    if (existing && existing.expiresAt > this.now() + 24 * 60 * 60_000) return existing
    const data = await this.request(c, '/api/device/session', c.apiKey, {})
    const token = str(data.routingToken), expiresAt = Date.parse(str(data.routingTokenExpiresAt))
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new RouteError('无法建立模型切换会话')
    const saved = { owner: owner(c), token, expiresAt, ...(existing?.pending ? { pending: existing.pending } : {}) }
    await this.deps.writeSession(saved) // Must succeed before any provider mutation.
    return saved
  }
  private async persistCredentials(previous: RoutingCredentials, data: Record<string, unknown>): Promise<RoutingCredentials> {
    const apiKey = str(data.apiKey), username = str(data.username), balanceCents = str(data.balanceCents)
    if (!apiKey || username !== previous.username || !/^\d+$/.test(balanceCents)) throw new RouteError('线路凭据尚未就绪，请重试恢复连接')
    const baseUrl = normalizeRelayBaseUrl(str(data.baseUrl))
    const account = str(data.account) || str(data.provider)
    if (!account) throw new RouteError('线路凭据缺少供应商信息')
    const c = { siteUrl: previous.siteUrl, baseUrl, apiKey, username, balanceCents, account, group: str(data.group) || null, node: str(data.node) }
    await this.deps.writeCredentials(c)
    this.invalidate()
    return c
  }
  private async recovered(c: RoutingCredentials, session: RoutingSession): Promise<{ credentials: RoutingCredentials; state: RoutingState }> {
    let data: Record<string, unknown>
    try { data = await this.request(c, '/api/device/group?credentials=1', session.token) }
    catch (error) {
      if (!(error instanceof RouteError) || error.status !== 401) throw error
      Object.assign(session, await this.ensureSession(c, { ...session, expiresAt: 0 }))
      data = await this.request(c, '/api/device/group?credentials=1', session.token)
    }
    const credentials = await this.persistCredentials(c, record(data.credentials))
    const state = this.parseState(data)
    if (state.keyStatus !== 'ACTIVE') throw new RouteError('线路凭据尚未就绪，请稍后恢复连接')
    return { credentials, state }
  }
  private async scan(c: RoutingCredentials, state: RoutingState): Promise<AiModelInfo[]> {
    const models = (await this.deps.listModels(c)).filter(m => isSelectableQuotaModel(m.id)).slice(0, 512)
    this.cache = { owner: owner(c), key: c.apiKey, state, models, at: this.now() }
    return models
  }
  private async snapshot(c: RoutingCredentials | null, stale: boolean, message?: string): Promise<QuotaModelCatalog> {
    const cached = c && this.cache?.owner === owner(c) && this.cache.key === c.apiKey ? this.cache : undefined
    const state = cached?.state
    const groups = state?.providers.find(p => p.account === 'secondary' && p.kind === 'paid')?.groups ?? []
    const currentModels = state?.account === 'secondary' ? cached?.models ?? [] : []
    const ids = [...new Set([...QUOTA_MODEL_METADATA.map(m => m.id), ...currentModels.map(m => m.id)])]
    const pending = c ? (await this.session(c))?.pending : undefined
    const recoveryRequired = Boolean(pending)
    const models: QuotaModelOption[] = ids.map(id => {
      const current = currentModels.find(m => m.id === id)
      const hint = QUOTA_ROUTE_HINTS.find(r => r.models.some(m => m === id) && groups.some(g => g.id === r.group))
      const hinted = (state?.account === 'secondary' ? state.canSwitch : state?.canSwitchProvider) && Boolean(hint)
      // Mirror select(): a verified current route takes precedence over route hints.
      const label = current ? state?.label : groups.find(g => g.id === hint?.group)?.label
      const available = Boolean(c && !c.provider && !stale && (state?.keyStatus === 'ACTIVE' || state?.account.startsWith('trial:')) && (current || hinted))
      return { ...current, ...quotaModelMetadata(id), ...noCacheMark(label), optionKey: quotaModelOptionKey(id, 'quota'), billing: 'quota', available, ...(!available ? { unavailableReason: !c ? '请先连接账号' : stale ? '请联网刷新模型列表' : '当前账号暂无可用线路' } : {}) }
    })
    for (const hint of FREE_ROUTE_HINTS) {
      const provider = state?.providers.find(p => p.account === hint.account && p.kind === 'free')
      const actual = state?.account === hint.account ? cached?.models : undefined
      const freeIds = actual ? actual.map(m => m.id) : [...hint.models]
      for (const id of freeIds) {
        const current = actual?.find(m => m.id === id)
        const available = Boolean(c && !c.provider && !stale && provider && (state?.account === hint.account || state?.canSwitchProvider))
        models.push({ ...current, ...quotaModelMetadata(id), ...noCacheMark(provider?.label), billing: 'free', account: hint.account, optionKey: quotaModelOptionKey(id, 'free', hint.account), available,
          ...(!available ? { unavailableReason: !c ? '请先连接账号' : stale ? '请联网刷新模型列表' : '当前账号暂无可用免费套餐' } : {}) })
      }
    }
    const currentModel = (await this.deps.readPreferences()).model
    const account = state?.account ?? c?.account
    const billing = c?.provider ? 'custom' : account?.startsWith('trial:') ? 'free' : 'quota'
    return { models, currentModel, currentOptionKey: quotaModelOptionKey(currentModel, billing === 'free' ? 'free' : 'quota', account), ...(state ? { currentRoute: { account: state.account, group: state.group, label: state.label } } : {}),
      connected: Boolean(c), canSwitch: Boolean(c && !c.provider && !this.switching && !stale && this.now() >= this.cooldownUntil), stale,
      checkedAt: cached?.at ?? null, billing,
      recoveryRequired, ...(pending ? { pendingModel: pending.model, pendingSelection: pending.route.account.startsWith('trial:') ? { billing: 'free', account: pending.route.account } : { billing: 'quota' } } : {}), ...(message ? { message } : recoveryRequired ? { message: '上次切换尚未完成，请恢复连接或重新选择模型' } : {}) }
  }
  async catalog(force = false): Promise<QuotaModelCatalog> {
    const c = await this.deps.readCredentials()
    if (!c || c.provider) return this.snapshot(c, true, c?.provider ? '自定义 API 使用自己的模型列表' : '请先连接 ModMind 账号')
    if (this.switching) return this.snapshot(c, false, '正在切换模型…')
    if (!force && this.cache?.owner === owner(c) && this.cache.key === c.apiKey && this.now() - this.cache.at < 60_000) return this.snapshot(c, false)
    let state: RoutingState
    try { state = await this.readState(c, await this.session(c)) }
    catch (error) { return this.snapshot(c, true, error instanceof RouteError ? error.message : '无法刷新模型列表，请重试') }
    try { await this.scan(c, state); return this.snapshot(c, false) }
    catch {
      this.cache = { owner: owner(c), key: c.apiKey, state, models: [], at: this.now() }
      return this.snapshot(c, false, '当前线路的模型列表暂不可用，可选择其他模型自动切线')
    }
  }
  /** Called before starting a quota request after a crash/ambiguous response. */
  async resume(): Promise<void> {
    const c = await this.deps.readCredentials()
    const session = c && !c.provider ? await this.session(c) : null
    if (!c || !session?.pending) return
    const recovered = await this.recovered(c, session)
    const models = await this.scan(recovered.credentials, recovered.state)
    if (!sameRoute(recovered.state, session.pending.route) || !models.some(m => m.id === session.pending!.model)) throw new RouteError('上次切换尚未完成，请在设置中重新选择模型')
    await this.deps.applyModel(session.pending.model)
    await this.deps.writeSession({ ...session, pending: undefined })
  }
  async select(model: string, selection?: QuotaModelSelection): Promise<QuotaModelSwitchResult> {
    if (!isSelectableQuotaModel(model)) throw new Error('请选择有效的工作台模型')
    const version = validateQuotaModelSelection(selection), billing = version.billing ?? 'quota'
    if (this.switching) throw new Error('正在切换模型，请稍候')
    if (this.now() < this.cooldownUntil) throw new Error('模型服务正在恢复，请稍后重试')
    this.switching = true
    let session: RoutingSession | null = null, c: RoutingCredentials | null = null
    try {
      c = await this.deps.readCredentials()
      if (!c || c.provider) throw new RouteError('请先连接 ModMind 额度账号')
      session = await this.session(c)
      if (session?.pending) c = (await this.recovered(c, session)).credentials
      let state = await this.readState(c, session)
      if (state.keyStatus !== 'ACTIVE' && !(billing === 'free' && state.keyStatus === 'FROZEN') && !state.account.startsWith('trial:')) throw new RouteError('当前账号不可用，请检查余额或账号状态')
      // The current list can be broken/frozen while a different route is usable.
      // Route discovery comes from /group, not success of the current /models.
      let models: AiModelInfo[] = []
      try { models = await this.scan(c, state) } catch { /* Verify the chosen target after switching. */ }
      let target: QuotaRoute = state
      const currentMatches = billing === 'free' ? state.account.startsWith('trial:') && (!version.account || version.account === state.account) : state.account === 'secondary'
      if (!currentMatches || !models.some(m => m.id === model)) {
        if (billing === 'free') {
          const hint = FREE_ROUTE_HINTS.find(r => (!version.account || r.account === version.account) && r.models.some(id => id === model) && state.providers.some(p => p.account === r.account && p.kind === 'free'))
          if (!hint) throw new RouteError('当前账号没有支持这个模型的免费套餐')
          if (state.account !== hint.account && !state.canSwitchProvider) throw new RouteError('当前账号暂时不能切换套餐')
          target = { account: hint.account, group: null }
        } else {
          const provider = state.providers.find(p => p.account === 'secondary' && p.kind === 'paid')
          const hint = QUOTA_ROUTE_HINTS.find(r => r.models.some(id => id === model) && provider?.groups.some(g => g.id === r.group))
          if (!hint) throw new RouteError('当前账号没有支持这个模型的线路，请刷新后重新选择')
          if (state.account === 'secondary' ? !state.canSwitch : !state.canSwitchProvider) throw new RouteError('当前账号暂时不能切换线路')
          target = { account: 'secondary', group: hint.group }
        }
        session = await this.ensureSession(c, session)
        session = { ...session, pending: { model, route: target } }
        await this.deps.writeSession(session)
        try {
          const data = await this.request(c, '/api/device/group', session.token, { account: target.account, ...(target.group ? { group: target.group } : {}),
            expectedAccount: state.account, expectedGroup: state.group })
          c = await this.persistCredentials(c, data)
        } catch (error) {
          if (error instanceof MultiProviderSyncRequired) {
            await this.deps.writeSession({ ...session, pending: undefined })
            if (this.deps.upgradeConnections && await this.deps.upgradeConnections(c, session)) {
              this.invalidate(); this.switching = false
              return { status: 'error', message: '供应商同步协议已更新，请重新选择模型', requiresProviderSync: true, catalog: await this.snapshot(c, true) }
            }
            throw error
          }
          if (error instanceof RouteError && error.status === 429) this.cooldownUntil = this.now() + error.retryAfter
          const recovery = await this.recovered(c, session)
          c = recovery.credentials; state = recovery.state
          if (!sameRoute(state, target)) throw error
        }
        state = await this.readState(c, session)
        if (!sameRoute(state, target)) throw new RouteError('线路已被其他客户端修改，请刷新后重试')
        models = await this.scan(c, state)
        if (!models.some(m => m.id === model)) throw new RouteError('目标线路没有返回所选模型，请重新选择模型')
      }
      const preferences = await this.deps.applyModel(model)
      if (session?.pending) await this.deps.writeSession({ ...session, pending: undefined })
      this.switching = false
      return { status: 'ok', message: `已切换到 ${quotaModelMetadata(model).name}${billing === 'free' ? '（免费版）' : ''}`, preferences, catalog: await this.snapshot(c, false) }
    } catch (error) {
      if (!(error instanceof MultiProviderSyncRequired)) this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + 3000)
      this.switching = false
      c = await this.deps.readCredentials()
      const message = error instanceof RouteError ? error.message : '模型切换未完成，请重试恢复连接'
      return { status: 'error', message, catalog: await this.snapshot(c, !this.cache, message) }
    } finally { this.switching = false }
  }
}
