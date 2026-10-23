import { session } from 'electron'
import { Agent, Dispatcher, ProxyAgent, interceptors } from 'undici'
import { resolveNetworkProxyUrl } from './networkRequest'

/** XMCL uses Undici, so resolve Electron's system/PAC proxy for each destination. */
class MinecraftDownloadAgent extends Dispatcher {
  private readonly direct = new Agent({ connections: 4, bodyTimeout: 60_000, headersTimeout: 30_000 })
  private readonly proxies = new Map<string, ProxyAgent>()
  private closed = false

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = new URL(options.path, String(options.origin)).href
    void resolveNetworkProxyUrl(url, target => session.defaultSession.resolveProxy(target)).then(proxy => {
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
