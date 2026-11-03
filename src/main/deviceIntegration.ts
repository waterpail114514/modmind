import type { AiModelInfo, AppVersionCheckResult, DeviceKeyStatus, DeviceUsage } from '../shared/types'
import { parseReasoningCapabilities } from '../shared/modelReasoning'
import { randomUUID } from 'node:crypto'
import { decideAppUpdate } from './appUpdatePolicy'
import { parseProviderSnapshot, type ProviderSnapshot } from './providerSync'
import { networkFetch } from './networkRequest'
import { readImageServiceErrorBody, sanitizeImageServiceError } from '../shared/imageServiceErrors'
import { PROVIDER_SYNC_CAPABILITY_HEADERS } from '../shared/providerAccounts'

export const DEFAULT_DEVICE_MODEL = 'gpt-5.6-sol'
export const DEFAULT_REASONING_EFFORT = 'high' as const

export interface DeviceCodeResult {
  code: string
  authUrl: string
  expiresIn: number
}

export interface CustomApiConfig {
  version: 1
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  imageApi: { baseUrl: string; apiKey: string; model: string } | null
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ok'; baseUrl: string; apiKey: string; balanceCents: string; username: string; account?: string; group?: string | null; node?: string; sync?: ProviderSnapshot }
  | { status: 'ok'; provider: 'custom'; usageTracked: false; requiresLocalSync: true; username: string }

export class DeviceApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'DeviceApiError'
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function normalizedHttpUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`${label}无效`)
  }
  if (url.username || url.password) throw new Error(`${label}不能包含账号密码`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new Error(`${label}必须使用 HTTPS`)
  }
  return url
}

export function normalizeSiteUrl(value: string): string {
  const url = normalizedHttpUrl(value, '站点地址')
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('站点地址只能包含协议和域名')
  }
  return url.origin
}

export function normalizeRelayBaseUrl(value: string): string {
  const url = normalizedHttpUrl(value, '模型服务地址')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function openAiV1BaseUrl(value: string): string {
  const base = normalizeRelayBaseUrl(value)
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

function parseCustomApi(encoded: string): CustomApiConfig {
  if (encoded.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('自定义 API 同步数据无效')
  let value: unknown
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown }
  catch { throw new Error('自定义 API 同步数据无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自定义 API 同步数据无效')
  const data = value as Record<string, unknown>
  if (data.version !== 1) throw new Error('不支持的自定义 API 同步版本')
  const field = (record: Record<string, unknown>, name: string): string => {
    const value = record[name]
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`自定义 API ${name} 无效`)
    return value.trim()
  }
  const providerId = field(data, 'providerId')
  if (providerId.length > 256) throw new Error('自定义 API providerId 无效')
  const model = field(data, 'model')
  if (model.length > 256) throw new Error('自定义 API model 无效')
  const image = data.imageApi
  if (image === undefined || (image !== null && (typeof image !== 'object' || Array.isArray(image)))) throw new Error('自定义图片 API 无效')
  const imageData = image && typeof image === 'object' ? image as Record<string, unknown> : null
  if (imageData && field(imageData, 'model').length > 256) throw new Error('自定义图片 API model 无效')
  return {
    version: 1, providerId,
    baseUrl: normalizeRelayBaseUrl(field(data, 'baseUrl')),
    apiKey: field(data, 'apiKey'), model,
    imageApi: imageData ? {
      baseUrl: normalizeRelayBaseUrl(field(imageData, 'baseUrl')),
      apiKey: field(imageData, 'apiKey'),
      model: field(imageData, 'model')
    } : null
  }
}

export function parseDeviceDeepLink(rawUrl: string, expectedSiteUrl: string): { siteUrl: string; code: string; customApi?: CustomApiConfig } {
  const url = new URL(rawUrl)
  if (url.protocol !== 'mcdev:' || url.hostname !== 'sync') throw new Error('不支持的 ModMind 深链')
  const siteUrl = normalizeSiteUrl(url.searchParams.get('site') ?? '')
  if (siteUrl !== normalizeSiteUrl(expectedSiteUrl)) throw new Error('深链站点与应用配置不匹配')
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6,16}$/.test(code)) throw new Error('深链授权码无效')
  const customValues = url.searchParams.getAll('customApi')
  if (url.searchParams.get('version') === '2') return { siteUrl, code }
  if (customValues.length > 1) throw new Error('自定义 API 同步参数重复')
  return { siteUrl, code, ...(customValues.length ? { customApi: parseCustomApi(customValues[0]) } : {}) }
}

function apiErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string' && record.message.trim()) return record.message
  if (typeof record.error === 'string' && record.error.trim()) return record.error
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>
    if (typeof error.message === 'string' && error.message.trim()) return error.message
  }
  return fallback
}

async function requestEnvelope<T>(fetcher: FetchLike, url: string, init: RequestInit, fallback: string): Promise<T> {
  let response: Response
  try {
    response = await fetcher(url, init)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new DeviceApiError(`${fallback}：无法连接服务器`, 0)
  }
  let payload: unknown = null
  try { payload = await response.json() as unknown } catch { /* Report the HTTP error below. */ }
  if (!response.ok) throw new DeviceApiError(apiErrorMessage(payload, `${fallback}：HTTP ${response.status}`), response.status)
  if (!payload || typeof payload !== 'object') throw new DeviceApiError(`${fallback}：响应格式无效`, response.status)
  const envelope = payload as { success?: unknown; data?: unknown }
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') {
    throw new DeviceApiError(apiErrorMessage(payload, `${fallback}：响应格式无效`), response.status)
  }
  return envelope.data as T
}

export async function requestDeviceCode(siteUrl: string, signal: AbortSignal, fetcher: FetchLike = networkFetch): Promise<DeviceCodeResult> {
  const site = normalizeSiteUrl(siteUrl)
  const data = await requestEnvelope<Record<string, unknown>>(fetcher, `${site}/api/device/code`, {
    method: 'POST',
    signal
  }, '申请授权码失败')
  const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : ''
  const authUrl = typeof data.authUrl === 'string' ? data.authUrl.trim() : ''
  const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : Number(data.expiresIn)
  if (!/^[A-Z0-9]{6,16}$/.test(code) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new DeviceApiError('申请授权码失败：响应字段无效', 200)
  }
  const auth = normalizedHttpUrl(authUrl, '授权页面地址')
  if (auth.origin !== site) throw new DeviceApiError('授权页面与配置站点不一致', 200)
  return { code, authUrl: auth.toString(), expiresIn: Math.min(expiresIn, 600) }
}

export async function pollDeviceCode(siteUrl: string, code: string, signal: AbortSignal, fetcher: FetchLike = networkFetch, customLocal = false): Promise<DevicePollResult> {
  const site = normalizeSiteUrl(siteUrl)
  const data = await requestEnvelope<Record<string, unknown>>(fetcher, `${site}/api/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...PROVIDER_SYNC_CAPABILITY_HEADERS, ...(customLocal ? { 'X-ModMind-Custom-Local': '1' } : { 'X-ModMind-Sync-Version': '2' }) },
    body: JSON.stringify({ code }),
    signal
  }, '查询授权状态失败')
  if (data.status === 'pending' || data.status === 'expired') return { status: data.status }
  if (data.status !== 'ok') throw new DeviceApiError('查询授权状态失败：未知状态', 200)
  if (data.protocolVersion === 2) {
    const sync = parseProviderSnapshot(data)
    const connection = sync.connections.find(c => c.account === sync.defaultAccount)!
    if (typeof data.username !== 'string' || !data.username.trim() || typeof data.balanceCents !== 'string' || !/^\d+$/.test(data.balanceCents)) throw new DeviceApiError('多供应商授权身份无效', 200)
    return { status: 'ok', baseUrl: connection.inferenceBaseUrl, apiKey: connection.apiKey, username: data.username.trim(), balanceCents: data.balanceCents, account: connection.account, group: connection.group, ...(connection.node ? { node: connection.node } : {}), sync }
  }
  if (customLocal) {
    const username = typeof data.username === 'string' ? data.username.trim() : ''
    if (data.provider !== 'custom' || data.usageTracked !== false || data.requiresLocalSync !== true || !username) {
      throw new DeviceApiError('自定义 API 授权响应无效', 200)
    }
    return { status: 'ok', provider: 'custom', usageTracked: false, requiresLocalSync: true, username }
  }
  const baseUrl = typeof data.baseUrl === 'string' ? normalizeRelayBaseUrl(data.baseUrl) : ''
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
  const balanceCents = typeof data.balanceCents === 'string' ? data.balanceCents : ''
  const username = typeof data.username === 'string' ? data.username.trim() : ''
  if (!baseUrl || !apiKey || !/^\d+$/.test(balanceCents) || !username) {
    throw new DeviceApiError('授权成功响应缺少必要字段', 200)
  }
  return { status: 'ok', baseUrl, apiKey, balanceCents, username,
    ...(typeof data.account === 'string' ? { account: data.account } : {}),
    ...(data.group === null || typeof data.group === 'string' ? { group: data.group } : {}),
    ...(typeof data.node === 'string' ? { node: data.node } : {}) }
}

function stringInteger(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new DeviceApiError(`用量响应字段 ${key} 无效`, 200)
  return value
}

export async function queryDeviceUsage(siteUrl: string, apiKey: string, signal: AbortSignal, fetcher: FetchLike = networkFetch): Promise<DeviceUsage> {
  const site = normalizeSiteUrl(siteUrl)
  const data = await requestEnvelope<Record<string, unknown>>(fetcher, `${site}/api/device/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  }, '查询用量失败')
  const keyStatus = data.keyStatus as DeviceKeyStatus
  if (keyStatus !== 'ACTIVE' && keyStatus !== 'FROZEN') throw new DeviceApiError('用量响应中的 Key 状态无效', 200)
  return {
    keyStatus,
    frozenReason: typeof data.frozenReason === 'string' ? data.frozenReason : null,
    balanceCents: stringInteger(data, 'balanceCents'),
    usedQuota: stringInteger(data, 'usedQuota'),
    remainQuota: stringInteger(data, 'remainQuota'),
    billedCentsTotal: stringInteger(data, 'billedCentsTotal'),
    lastSeenUsedQuota: stringInteger(data, 'lastSeenUsedQuota'),
    quotaSyncedAt: typeof data.quotaSyncedAt === 'string' ? data.quotaSyncedAt : null,
    checkedAt: typeof data.checkedAt === 'string' ? data.checkedAt : new Date().toISOString()
  }
}

export interface DeviceImageService {
  selection: 'follow' | 'primary' | 'secondary' | 'ls'
  provider: 'primary' | 'secondary' | 'ls' | null
  available: boolean
  message: string
  choices: Array<{ account: 'primary' | 'secondary' | 'ls'; label: string; available: boolean }>
  model: string | null
  leasePath: string
}

export interface DeviceImageLease {
  baseUrl: string
  apiKey: string
  model: string
  provider?: 'primary' | 'secondary' | 'ls'
  expiresAt?: string
}

export interface DeviceImageLeaseIdentity { requestId: string; timestamp: string }

export function createDeviceImageLeaseIdentity(): DeviceImageLeaseIdentity {
  return { requestId: randomUUID(), timestamp: new Date().toISOString() }
}

/** Metadata never issues an upstream key or reserves image credit. */
export async function queryDeviceImageProvider(siteUrl: string, bearer: string, signal: AbortSignal, fetcher: FetchLike = networkFetch, additionalSecrets: readonly string[] = []): Promise<DeviceImageService> {
  const secrets = [bearer, ...additionalSecrets]
  let response: Response
  try {
    response = await fetcher(`${normalizeSiteUrl(siteUrl)}/api/device/image-provider`, { headers: { Authorization: `Bearer ${bearer}`, ...PROVIDER_SYNC_CAPABILITY_HEADERS }, signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new DeviceApiError('读取生图配置失败：无法连接账号服务', 0)
  }
  const raw = await readImageServiceErrorBody(response, signal)
  let payload: unknown = null
  try { if (raw !== null) payload = JSON.parse(raw) as unknown } catch { /* Report a bounded error below. */ }
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  if (!response.ok || envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') throw new DeviceApiError(sanitizeImageServiceError(apiErrorMessage(payload, `读取生图配置失败（HTTP ${response.status}）`), secrets), response.status)
  const data = envelope.data as Record<string, unknown>
  const accounts = ['primary', 'secondary', 'ls']
  if (!['follow', ...accounts].includes(String(data.selection)) || (data.provider !== null && !accounts.includes(String(data.provider))) || typeof data.available !== 'boolean') throw new DeviceApiError('生图配置响应无效', 200)
  const model = typeof data.model === 'string' && data.model.trim() && data.model.length <= 128 ? data.model.trim() : null
  if (data.available && (!model || !data.provider)) throw new DeviceApiError('生图配置缺少模型或供应商', 200)
  const choices = (Array.isArray(data.choices) ? data.choices : []).flatMap((value) => {
    const choice = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    return accounts.includes(String(choice.account)) && typeof choice.available === 'boolean'
      ? [{ account: choice.account as DeviceImageService['choices'][number]['account'], label: typeof choice.label === 'string' ? sanitizeImageServiceError(choice.label, secrets, 128) : String(choice.account), available: choice.available }] : []
  })
  return { selection: data.selection as DeviceImageService['selection'], provider: data.provider as DeviceImageService['provider'], available: data.available, message: typeof data.message === 'string' ? sanitizeImageServiceError(data.message, secrets) : '', choices, model, leasePath: '/api/device/image-lease' }
}

/** Request fresh image credentials with a routing session or account credential, never an image key. */
export async function requestDeviceImageLease(
  credentials: { siteUrl: string; apiKey: string; username: string; routingToken?: string },
  signal: AbortSignal,
  fetcher: FetchLike = networkFetch,
  identity: DeviceImageLeaseIdentity = createDeviceImageLeaseIdentity()
): Promise<DeviceImageLease> {
  const site = normalizeSiteUrl(credentials.siteUrl)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.requestId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(identity.timestamp) || !Number.isFinite(Date.parse(identity.timestamp))) throw new Error('图片授权请求标识或时间无效')
  const bearer = credentials.routingToken || credentials.apiKey
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'Idempotency-Key': identity.requestId, ...PROVIDER_SYNC_CAPABILITY_HEADERS },
    body: JSON.stringify({ username: credentials.username, timestamp: identity.timestamp }), signal
  }
  const delay = (milliseconds: number) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    let response: Response
    try { response = await fetcher(`${site}/api/device/image-lease`, init) }
    catch (error) {
      if (signal.aborted) throw error
      if (attempt < 2) { await delay(250 * 2 ** attempt); continue }
      throw new DeviceApiError('图片授权失败：无法连接账号服务，尚未调用生图接口', 0)
    }
    const raw = await readImageServiceErrorBody(response, signal)
    let payload: unknown = null
    try { if (raw !== null) payload = JSON.parse(raw) as unknown } catch { /* Report a bounded error below. */ }
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    if (!response.ok || root.success === false) {
      const detail = sanitizeImageServiceError(apiErrorMessage(payload, '账号服务未返回可读错误'), [bearer, credentials.apiKey, credentials.routingToken ?? ''])
      const retryable = response.status === 429 || response.status >= 500 || (response.status === 409 && /处理中|processing|pending/i.test(detail))
      if (attempt < 2 && retryable) {
        const retryAfter = response.headers.get('retry-after')
        const wait = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 250 * 2 ** attempt
        await delay(Number.isFinite(wait) ? Math.max(0, wait) : 1000); continue
      }
      const recovery = response.status === 401 ? '；请重新连接 ModMind 账号，或在网页端重新同步接入凭证' : ''
      throw new DeviceApiError(`图片授权失败（HTTP ${response.status}）：${detail}${recovery}。尚未调用生图接口`, response.status)
    }
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root
    const baseUrl = typeof data.baseUrl === 'string' && data.baseUrl.trim() ? normalizeRelayBaseUrl(data.baseUrl) : ''
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
    const model = typeof data.model === 'string' ? data.model.trim() : ''
    if (!baseUrl || !apiKey || !model || model.length > 128) throw new DeviceApiError('图片授权失败：响应缺少临时 Key、Base URL 或模型，尚未调用生图接口', response.status)
    if (data.provider !== undefined && !['primary', 'secondary', 'ls'].includes(String(data.provider))) throw new DeviceApiError('图片授权失败：响应供应商无效，尚未调用生图接口', response.status)
    if (data.expiresAt !== undefined && (typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now())) throw new DeviceApiError('图片授权已失效，尚未调用生图接口', response.status)
    return { baseUrl, apiKey, model, ...(data.provider ? { provider: data.provider as DeviceImageLease['provider'] } : {}), ...(typeof data.expiresAt === 'string' ? { expiresAt: data.expiresAt } : {}) }
  }
}

export async function sendDeviceFastMode(
  siteUrl: string,
  apiKey: string,
  enabled: boolean,
  signal: AbortSignal,
  fetcher: FetchLike = networkFetch
): Promise<void> {
  const site = normalizeSiteUrl(siteUrl)
  let response: Response
  try {
    response = await fetcher(`${site}/api/device/fastmode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ enabled: Boolean(enabled) }),
      signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new DeviceApiError('同步 Fast 模式失败：无法连接服务器', 0)
  }
  let payload: unknown = null
  try { payload = await response.json() as unknown } catch { /* A successful acknowledgement does not require a JSON body. */ }
  if (!response.ok) throw new DeviceApiError(apiErrorMessage(payload, `同步 Fast 模式失败：HTTP ${response.status}`), response.status)
  if (payload && typeof payload === 'object' && (payload as { success?: unknown }).success === false) {
    throw new DeviceApiError(apiErrorMessage(payload, '同步 Fast 模式失败'), response.status)
  }
}

export async function checkAppVersion(siteUrl: string, currentVersion: string, signal: AbortSignal, fetcher: FetchLike = networkFetch): Promise<AppVersionCheckResult> {
  const site = normalizeSiteUrl(siteUrl)
  let response: Response
  try {
    response = await fetcher(`${site}/api/version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: currentVersion }),
      signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new DeviceApiError('检查更新失败：无法连接服务器', 0)
  }
  let payload: unknown = null
  try {
    const body = (await response.text()).trim()
    if (body) {
      try { payload = JSON.parse(body) as unknown } catch { payload = body }
    }
  } catch { /* The response is validated below. */ }
  if (!response.ok) throw new DeviceApiError(apiErrorMessage(payload, `检查更新失败：HTTP ${response.status}`), response.status)
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root
  const latestVersion = typeof payload === 'string'
    ? payload.trim()
    : [data.latestVersion, data.latest_version, data.latest, data.version].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() ?? ''
  if (!latestVersion) throw new DeviceApiError('检查更新失败：服务器未返回最新版本号', response.status)
  const decision = decideAppUpdate(currentVersion, latestVersion)
  if (!decision) throw new DeviceApiError('检查更新失败：服务器返回的版本号无效', response.status)
  const downloadUrl = typeof data.downloadUrl === 'string' && data.downloadUrl.trim() ? data.downloadUrl.trim() : undefined
  return { ...decision, ...(downloadUrl ? { downloadUrl } : {}) }
}

/** Endpoint families that a catalog publishes next to chat models but that an agent backend cannot drive. */
const NON_CHAT_MODEL = /(?:^|[/_.:-])(?:embed(?:ding)?s?|rerank|tts|text-to-speech|whisper|transcri(?:be|ption)|moderation|bge)(?:$|[/_.:-])/i

/** Read only explicit capability statements; an absent field stays unknown instead of guessing. */
function parseModelCapabilities(id: string, record: Record<string, unknown>): { toolCalling?: boolean; nonChat?: boolean } {
  const parameters = Array.isArray(record.supported_parameters)
    ? record.supported_parameters.filter((value): value is string => typeof value === 'string')
    : undefined
  const capabilities = record.capabilities && typeof record.capabilities === 'object' && !Array.isArray(record.capabilities)
    ? record.capabilities as Record<string, unknown> : undefined
  const toolCalling = parameters ? parameters.includes('tools') : typeof capabilities?.tools === 'boolean' ? capabilities.tools : undefined
  return {
    ...(toolCalling === undefined ? {} : { toolCalling }),
    ...(NON_CHAT_MODEL.test(id) ? { nonChat: true } : {})
  }
}

export function parseModelPayload(payload: unknown): AiModelInfo[] {
  let entries: unknown[] = []
  if (Array.isArray(payload)) entries = payload
  else if (payload && typeof payload === 'object') {
    const record = payload as { data?: unknown; models?: unknown; model?: unknown; id?: unknown }
    if (Array.isArray(record.data)) entries = record.data
    else if (Array.isArray(record.models)) entries = record.models
    else if (record.model !== undefined) entries = [record.model]
    else if (record.id !== undefined) entries = [record]
  }
  const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.trim().length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined
  const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
  const models = entries.map((entry): AiModelInfo | null => {
    if (typeof entry === 'string') { const id = identifier(entry); return id ? { id, ...parseModelCapabilities(id, {}) } : null }
    if (!entry || typeof entry !== 'object') return null
    const record = entry as Record<string, unknown>
    const id = identifier([record.id, record.name, record.model].find(value => typeof value === 'string' && value.trim()))
    if (!id) return null
    const ownedBy = typeof record.owned_by === 'string' ? record.owned_by : typeof record.ownedBy === 'string' ? record.ownedBy : undefined
    const name = text(record.display_name, 256) ?? text(record.displayName, 256) ?? text(record.name, 256)
    const family = text(record.family, 128), description = text(record.description, 1000)
    const reasoning = parseReasoningCapabilities(entry)
    return { id, ...(name && name !== id ? { name } : {}), ...(family ? { family } : {}), ...(description ? { description } : {}),
      ...(typeof record.recommended === 'boolean' ? { recommended: record.recommended } : {}), ...(ownedBy ? { ownedBy } : {}), ...(reasoning ? { reasoning } : {}),
      ...parseModelCapabilities(id, record) }
  }).filter((entry): entry is AiModelInfo => Boolean(entry))
  return [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
}

/**
 * An agent backend always needs a chat model that can call tools. Catalog text order is alphabetical,
 * so a gateway that lists an embedding endpoint early would otherwise become the default selection.
 * Entries the provider did not describe keep their original position.
 */
export function orderModelsForAgent(models: AiModelInfo[]): AiModelInfo[] {
  const rank = (model: AiModelInfo) => model.nonChat ? 2 : model.toolCalling === false ? 1 : 0
  return [...models].sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id, undefined, { numeric: true }))
}
