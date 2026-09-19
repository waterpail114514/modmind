import type { AiModelInfo, AppVersionCheckResult, DeviceKeyStatus, DeviceUsage } from '../shared/types'
import { randomUUID } from 'node:crypto'
import { decideAppUpdate } from './appUpdatePolicy'

export const DEFAULT_DEVICE_MODEL = 'gpt-5.6-sol'
export const DEFAULT_REASONING_EFFORT = 'high' as const

export interface DeviceCodeResult {
  code: string
  authUrl: string
  expiresIn: number
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ok'; baseUrl: string; apiKey: string; balanceCents: string; username: string }

export class DeviceApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'DeviceApiError'
  }
}

type FetchLike = typeof fetch

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

export function parseDeviceDeepLink(rawUrl: string, expectedSiteUrl: string): { siteUrl: string; code: string } {
  const url = new URL(rawUrl)
  if (url.protocol !== 'mcdev:' || url.hostname !== 'sync') throw new Error('不支持的 ModMind 深链')
  const siteUrl = normalizeSiteUrl(url.searchParams.get('site') ?? '')
  if (siteUrl !== normalizeSiteUrl(expectedSiteUrl)) throw new Error('深链站点与应用配置不匹配')
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6,16}$/.test(code)) throw new Error('深链授权码无效')
  return { siteUrl, code }
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

export async function requestDeviceCode(siteUrl: string, signal: AbortSignal, fetcher: FetchLike = fetch): Promise<DeviceCodeResult> {
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

export async function pollDeviceCode(siteUrl: string, code: string, signal: AbortSignal, fetcher: FetchLike = fetch): Promise<DevicePollResult> {
  const site = normalizeSiteUrl(siteUrl)
  const data = await requestEnvelope<Record<string, unknown>>(fetcher, `${site}/api/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal
  }, '查询授权状态失败')
  if (data.status === 'pending' || data.status === 'expired') return { status: data.status }
  if (data.status !== 'ok') throw new DeviceApiError('查询授权状态失败：未知状态', 200)
  const baseUrl = typeof data.baseUrl === 'string' ? normalizeRelayBaseUrl(data.baseUrl) : ''
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
  const balanceCents = typeof data.balanceCents === 'string' ? data.balanceCents : ''
  const username = typeof data.username === 'string' ? data.username.trim() : ''
  if (!baseUrl || !apiKey || !/^\d+$/.test(balanceCents) || !username) {
    throw new DeviceApiError('授权成功响应缺少必要字段', 200)
  }
  return { status: 'ok', baseUrl, apiKey, balanceCents, username }
}

function stringInteger(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new DeviceApiError(`用量响应字段 ${key} 无效`, 200)
  return value
}

export async function queryDeviceUsage(siteUrl: string, apiKey: string, signal: AbortSignal, fetcher: FetchLike = fetch): Promise<DeviceUsage> {
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

/** Request fresh image credentials with the account credential, never an image key. */
export async function requestDeviceImageLease(
  credentials: { siteUrl: string; apiKey: string; username: string },
  signal: AbortSignal,
  fetcher: FetchLike = fetch
): Promise<{ baseUrl: string; apiKey: string }> {
  const site = normalizeSiteUrl(credentials.siteUrl)
  let response: Response
  try {
    response = await fetcher(`${site}/api/device/image-lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ username: credentials.username, timestamp: new Date().toISOString() }),
      signal
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new DeviceApiError('图片授权失败：无法连接账号服务，尚未调用生图接口', 0)
  }
  const payload: unknown = await response.json().catch(() => null)
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  if (!response.ok || root.success === false) {
    const detail = apiErrorMessage(payload, '账号服务未返回可读错误')
    const recovery = response.status === 401 ? '；请重新连接 ModMind 账号，或在网页端重新同步接入凭证' : ''
    throw new DeviceApiError(`图片授权失败（HTTP ${response.status}）：${detail}${recovery}。尚未调用生图接口`, response.status)
  }
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root
  const baseUrl = typeof data.baseUrl === 'string' && data.baseUrl.trim() ? normalizeRelayBaseUrl(data.baseUrl) : ''
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
  if (!baseUrl || !apiKey) throw new DeviceApiError('图片授权失败：响应缺少临时 Key 或 Base URL，尚未调用生图接口', response.status)
  return { baseUrl, apiKey }
}

export async function sendDeviceFastMode(
  siteUrl: string,
  apiKey: string,
  enabled: boolean,
  signal: AbortSignal,
  fetcher: FetchLike = fetch
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

export async function checkAppVersion(siteUrl: string, currentVersion: string, signal: AbortSignal, fetcher: FetchLike = fetch): Promise<AppVersionCheckResult> {
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
  const models = entries.map((entry): AiModelInfo | null => {
    if (typeof entry === 'string' && entry.trim()) return { id: entry.trim() }
    if (!entry || typeof entry !== 'object') return null
    const record = entry as { id?: unknown; name?: unknown; model?: unknown; owned_by?: unknown; ownedBy?: unknown }
    const id = [record.id, record.name, record.model].find((value) => typeof value === 'string' && value.trim())
    if (typeof id !== 'string' || id.length > 256) return null
    const ownedBy = typeof record.owned_by === 'string' ? record.owned_by : typeof record.ownedBy === 'string' ? record.ownedBy : undefined
    return { id: id.trim(), ...(ownedBy ? { ownedBy } : {}) }
  }).filter((entry): entry is AiModelInfo => Boolean(entry))
  return [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
}
