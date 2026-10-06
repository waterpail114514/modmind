import { session } from 'electron'
import { Agent, Dispatcher, ProxyAgent, interceptors } from 'undici'
import { getNetworkProxyUrl } from './networkRequest'

/** XMCL uses Undici, so resolve Electron's system/PAC proxy for each destination. */
class MinecraftDownloadAgent extends Dispatcher {
  private readonly direct = new Agent({ connections: 4, bodyTimeout: 60_000, headersTimeout: 30_000 })
  private readonly proxies = new Map<string, ProxyAgent>()
  private readonly routes = new Map<string, { expires: number; route: Promise<string> }>()
  private closed = false

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = new URL(options.path, String(options.origin)).href
    void this.route(url).then(proxy => {
      if (this.closed) throw new Error('Minecraft 下载连接已关闭')
      const clean = { ...options }
      delete (clean as typeof clean & { throwOnError?: boolean }).throwOnError
      if (!proxy) { this.direct.dispatch(clean, handler); return }
      let agent = this.proxies.get(proxy)
      if (!agent) {
        if (this.proxies.size >= 16) throw new Error('Minecraft 下载代理数量超过上限，请检查系统代理配置')
        agent = new ProxyAgent({ uri: proxy, connections: 4, bodyTimeout: 60_000, headersTimeout: 30_000 })
        this.proxies.set(proxy, agent)
      }
      agent.dispatch(clean, handler)
    }).catch(error => handler.onError?.(error))
    return true
  }

  private async route(url: string): Promise<string> {
    const host = new URL(url).hostname
    if (host === 'localhost' || host === '[::1]' || host.startsWith('127.')) return ''
    const configured = getNetworkProxyUrl()
    if (configured) return /^[a-z][a-z0-9+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`
    const cached = this.routes.get(url)
    if (cached && cached.expires > Date.now()) return cached.route
    const route = this.resolveSystemProxy(url)
    this.routes.set(url, { expires: Date.now() + 15_000, route })
    if (this.routes.size > 64) this.routes.delete(this.routes.keys().next().value!)
    void route.catch(() => { if (this.routes.get(url)?.route === route) this.routes.delete(url) })
    return route
  }

  private async resolveSystemProxy(url: string): Promise<string> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        session.defaultSession.resolveProxy(url),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('读取系统代理超时，请在设置中配置下载代理')), 10_000) })
      ])
      const first = result.split(';')[0].trim()
      if (!first || first === 'DIRECT') return ''
      const match = first.match(/^(PROXY|HTTPS)\s+(\S+)$/i)
      if (!match) throw new Error('系统代理类型不支持，请在设置中配置 HTTP 下载代理')
      return `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
    } finally { clearTimeout(timeout) }
  }

  close(): Promise<void>
  close(callback: () => void): void
  close(callback?: () => void): Promise<void> | void {
    const completion = this.finish(false)
    if (callback) { void completion.then(callback, callback); return }
    return completion
  }

  destroy(): Promise<void>
  destroy(error: Error | null): Promise<void>
  destroy(callback: () => void): void
  destroy(error: Error | null, callback: () => void): void
  destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const completion = this.finish(true, typeof errorOrCallback === 'function' ? undefined : errorOrCallback)
    const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback
    if (done) { void completion.then(done, done); return }
    return completion
  }

  private async finish(destroy: boolean, error?: Error | null): Promise<void> {
    this.closed = true
    this.routes.clear()
    const agents = [this.direct, ...this.proxies.values()]
    await Promise.all(agents.map(agent => destroy ? agent.destroy(error ?? null) : agent.close()))
    this.proxies.clear()
  }
}

export function minecraftDownloadDispatcher(): Dispatcher.ComposedDispatcher {
  return new MinecraftDownloadAgent().compose(
    interceptors.retry({ maxRetries: 3 }),
    interceptors.redirect({ maxRedirections: 5 })
  )
}
