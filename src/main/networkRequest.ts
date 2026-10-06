import { Agent, ProxyAgent, request } from 'undici'
import { setTimeout as delay } from 'node:timers/promises'

export interface FetchTextOptions {
  timeoutMs?: number
  attempts?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  method?: 'GET' | 'POST'
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_ATTEMPTS = 3

export function retryAfterDelay(value: string | null, fallback: number, now = Date.now()): number {
  if (!value) return fallback
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(milliseconds) ? Math.min(60_000, Math.max(0, milliseconds)) : fallback
}

/**
 * Metadata endpoints (Modrinth, CurseForge, mappings.dev, GitHub API) are hit
 * constantly with tiny JSON requests and are frequently reset by hostile or
 * congested networks. A single attempt makes the whole feature fail; short
 * backoff retries recover most of those failures.
 */
export async function fetchJsonWithRetry<T>(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; attempts?: number }): Promise<T> {
  const text = await fetchTextWithRetry(url, init)
  return JSON.parse(text) as T
}

export async function postJsonWithRetry<T>(url: string, body: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
  const text = await fetchTextWithRetry(url, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  }, JSON.stringify(body))
  return JSON.parse(text) as T
}

export async function fetchTextWithRetry(url: string, options: FetchTextOptions = {}, body?: string): Promise<string> {
  const attempts = Math.min(Math.max(options.attempts ?? DEFAULT_ATTEMPTS, 1), 5)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryable = true
    let retryDelay = attempt * 350
    try {
      options.signal?.throwIfAborted()
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
      const response = await proxiedUndiciRequest(url, {
        method: options.method ?? 'GET',
        headers: { 'User-Agent': 'ModMind/1.4 (network-request)', ...(options.headers ?? {}) },
        signal,
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(body !== undefined ? { body } : {})
      })
      try {
        if (!response.ok) {
          retryDelay = retryAfterDelay(response.headers.get('retry-after'), retryDelay)
          retryable = response.statusCode >= 500 || [408, 425, 429].includes(response.statusCode)
          throw new Error(`${url} returned HTTP ${response.statusCode}`)
        }
        return await response.body.text()
      } finally { disposeResponseBody(response) }
    } catch (error) {
      lastError = error
      if (options.signal?.aborted || !retryable || attempt >= attempts) break
      await delay(retryDelay, undefined, { signal: options.signal })
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * The global fetch ignores HTTP(S)_PROXY environment variables, so users who
 * need a proxy to reach Mojang/GitHub/Modrinth hosts would always download
 * directly. Route requests through undici with a ProxyAgent when configured.
 */
let proxyOverrideUrl = ''
let proxyOverrideAgent: ProxyAgent | undefined
let environmentProxyUrl = ''
let environmentProxyAgent: ProxyAgent | undefined
const directAgent = new Agent({ connections: 8, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 })
const systemAgents = new Map<string, ProxyAgent>()
const systemRoutes = new Map<string, { expires: number; route: Promise<string> }>()

export const systemProxyTransport = {
  async resolveProxy(url: string): Promise<string> {
    if (!process.versions.electron) return 'DIRECT'
    const { session } = await import('electron')
    return session.defaultSession.resolveProxy(url)
  }
}

export async function shutdownNetwork(): Promise<void> {
  await Promise.allSettled([directAgent.destroy(), proxyOverrideAgent?.destroy(), environmentProxyAgent?.destroy(), ...[...systemAgents.values()].map(agent => agent.destroy())])
  systemAgents.clear()
  systemRoutes.clear()
  proxyOverrideAgent = undefined
  environmentProxyAgent = undefined
}

function newProxyAgent(proxyUrl: string): ProxyAgent | undefined {
  try {
    return new ProxyAgent({ uri: /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`, connections: 8, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 })
  } catch {
    return undefined
  }
}

/**
 * Application-configured proxy (设置→网络). Takes precedence over the
 * HTTPS_PROXY environment variables; pass an empty string to clear it.
 */
export function setNetworkProxy(url: string): void {
  systemRoutes.clear()
  const trimmed = url.trim()
  if (trimmed === proxyOverrideUrl) return
  void proxyOverrideAgent?.close().catch(() => undefined)
  proxyOverrideUrl = trimmed
  proxyOverrideAgent = trimmed ? newProxyAgent(trimmed) : undefined
}

/** Returns the proxy currently selected by the app or the process environment. */
export function getNetworkProxyUrl(): string {
  return proxyOverrideUrl || (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? '').trim()
}

/**
 * Hosts that must never be routed through the configured proxy: MC百科 and
 * Gitee are China-only services whose anti-abuse defenses may reject foreign
 * exit IPs, and loopback targets are always local.
 */
const DIRECT_HOST_SUFFIXES = ['mcmod.cn', 'gitee.com', 'localhost']
const DIRECT_HOST_PREFIXES = ['127.']

function shouldBypassProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === '[::1]' || DIRECT_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))
      || DIRECT_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

/** Shared route selection for XMCL, metadata and verified downloads. */
export async function resolveNetworkProxyUrl(url: string, resolver = systemProxyTransport.resolveProxy): Promise<string> {
  if (shouldBypassProxy(url)) return ''
  const configured = getNetworkProxyUrl()
  if (configured) return /^[a-z][a-z0-9+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`
  const cached = systemRoutes.get(url)
  if (cached && cached.expires > Date.now()) return cached.route
  const route = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        resolver(url),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('读取系统代理超时，请在设置中配置下载代理')), 10_000) })
      ])
      const first = result.split(';')[0].trim()
      if (!first || first === 'DIRECT') return ''
      const match = first.match(/^(PROXY|HTTPS)\s+(\S+)$/i)
      if (!match) throw new Error('系统代理类型不支持，请在设置中配置 HTTP 下载代理')
      return `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
    } finally { clearTimeout(timer) }
  })()
  systemRoutes.set(url, { expires: Date.now() + 15_000, route })
  if (systemRoutes.size > 64) systemRoutes.delete(systemRoutes.keys().next().value!)
  void route.catch(() => { if (systemRoutes.get(url)?.route === route) systemRoutes.delete(url) })
  return route
}

async function requestRoute(url: string): Promise<{ dispatcher: Agent | ProxyAgent; proxyMode: string }> {
  const proxy = await resolveNetworkProxyUrl(url)
  if (!proxy) return { dispatcher: directAgent, proxyMode: 'direct' }
  const configured = proxyDispatcher(url)
  if (configured) return { dispatcher: configured, proxyMode: proxyOverrideUrl ? 'application' : 'environment' }
  let agent = systemAgents.get(proxy)
  if (!agent) {
    agent = newProxyAgent(proxy)
    if (!agent) throw new Error('系统代理地址无效，请检查网络设置')
    if (systemAgents.size >= 16) {
      const oldest = systemAgents.keys().next().value!
      void systemAgents.get(oldest)?.close().catch(() => undefined)
      systemAgents.delete(oldest)
    }
    systemAgents.set(proxy, agent)
  }
  return { dispatcher: agent, proxyMode: 'system' }
}

export function proxyDispatcher(url?: string): ProxyAgent | undefined {
  if (proxyOverrideUrl) {
    if (url && shouldBypassProxy(url)) return undefined
    if (proxyOverrideAgent) return proxyOverrideAgent
  }
  if (url && (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy) && shouldBypassProxy(url)) return undefined
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  const trimmed = proxyUrl?.trim()
  if (trimmed !== environmentProxyUrl) {
    void environmentProxyAgent?.close().catch(() => undefined)
    environmentProxyUrl = trimmed ?? ''
    environmentProxyAgent = trimmed ? newProxyAgent(trimmed) : undefined
  }
  return environmentProxyAgent
}

export interface ProxiedRequestOptions {
  method?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  bodyTimeout?: number
  headersTimeout?: number
  body?: string
  requireHttpsRedirects?: boolean
}

export interface ProxiedResponse {
  ok: boolean
  statusCode: number
  finalUrl?: string
  proxyMode?: string
  headers: { get(name: string): string | null }
  /** undici's body is already a Node readable; it also exposes .text(). */
  body: NodeJS.ReadableStream & { text(): Promise<string>; destroy?(): void }
}

/** Undici emits an AbortError when destroying an unread error response. */
export function disposeResponseBody(response: ProxiedResponse): void {
  if (!response.body.destroy) return
  response.body.once('error', () => undefined)
  response.body.destroy()
}

/**
 * Indirection point so tests can intercept transport without real sockets
 * (mirrors how the global fetch used to be stubbed).
 */
export const httpTransport = {
  request: actualProxiedRequest
}

export async function proxiedUndiciRequest(url: string, options: ProxiedRequestOptions): Promise<ProxiedResponse> {
  return await httpTransport.request(url, options)
}

async function actualProxiedRequest(url: string, options: ProxiedRequestOptions): Promise<ProxiedResponse> {
  let current = new URL(url)
  let headers = { ...options.headers }
  let method = options.method ?? 'GET'
  let body = options.body
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    options.signal?.throwIfAborted()
    const route = await requestRoute(current.href)
    const response = await request(current, {
      method, headers, body, signal: options.signal, bodyTimeout: options.bodyTimeout,
      headersTimeout: options.headersTimeout, dispatcher: route.dispatcher
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.body.on('error', () => undefined)
      response.body.destroy()
      if (redirects === 5) throw new Error('download exceeds redirect limit')
      const next = new URL(String(response.headers.location), current)
      if (options.requireHttpsRedirects && next.protocol !== 'https:') throw new Error('download redirected to a non-HTTPS URL')
      if (next.origin !== current.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie', 'proxy-authorization', 'host'].includes(key.toLowerCase())))
      if ((response.statusCode === 303 && method !== 'HEAD') || ([301, 302].includes(response.statusCode) && method === 'POST')) {
        method = 'GET'
        body = undefined
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['content-length', 'content-type', 'transfer-encoding'].includes(key.toLowerCase())))
      }
      current = next
      continue
    }
    return { ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, finalUrl: current.href, proxyMode: route.proxyMode, headers: { get: name => response.headers[name.toLowerCase()]?.toString() ?? null }, body: response.body as unknown as ProxiedResponse['body'] }
  }
  throw new Error('download exceeds redirect limit')
}
