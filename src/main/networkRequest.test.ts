import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchTextWithRetry, getNetworkProxyUrl, postJsonWithRetry, proxyDispatcher, setNetworkProxy, retryAfterDelay } from './networkRequest'

let server: Server
const hitCounts = new Map<string, number>()
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`
    const hits = (hitCounts.get(key) ?? 0) + 1
    hitCounts.set(key, hits)

    if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return }
    if (req.url === '/rate-limit') { res.writeHead(429); res.end('slow down'); return }

    if (req.url === '/flaky' && req.method === 'GET' && hits === 1) {
      res.writeHead(502)
      res.end('bad gateway')
      return
    }

    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ echoed: body ? JSON.parse(body) : null }))
      })
      return
    }

    res.writeHead(200)
    res.end(`fine for ${req.url}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('networkRequest helpers', () => {
  it('honors Retry-After seconds and dates with a bounded wait', () => {
    expect(retryAfterDelay('2', 100)).toBe(2000)
    expect(retryAfterDelay('900', 100)).toBe(60000)
    expect(retryAfterDelay('Wed, 01 Jan 2025 00:00:02 GMT', 100, Date.parse('2025-01-01T00:00:00Z'))).toBe(2000)
    expect(retryAfterDelay('bad', 100)).toBe(100)
  })
  it('does not retry permanent errors', async () => {
    await expect(fetchTextWithRetry(`http://127.0.0.1:${port}/missing`)).rejects.toThrow('HTTP 404')
    expect(hitCounts.get('GET /missing')).toBe(1)
  })

  it('cancels during retry backoff without another request', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 100)
    try { await expect(fetchTextWithRetry(`http://127.0.0.1:${port}/rate-limit`, { signal: controller.signal })).rejects.toThrow() }
    finally { clearTimeout(timer) }
    expect(hitCounts.get('GET /rate-limit')).toBe(1)
  })
  it('surfaces the last HTTP status after exhausting attempts', async () => {
    await expect(fetchTextWithRetry(`http://127.0.0.1:${port}/flaky`, { attempts: 1 })).rejects.toThrow(/HTTP 502/)
  })

  it('retries and succeeds on a later attempt', async () => {
    const text = await fetchTextWithRetry(`http://127.0.0.1:${port}/flaky`, { attempts: 3 })
    expect(text).toContain('/flaky')
    expect(hitCounts.get('GET /flaky')).toBeGreaterThanOrEqual(2)
  })

  it('does not retry when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchTextWithRetry(`http://127.0.0.1:${port}/aborted`, { signal: controller.signal, attempts: 3 })).rejects.toThrow()
    expect(hitCounts.has('GET /aborted')).toBe(false)
  })

  it('round-trips a JSON POST body', async () => {
    const result = await postJsonWithRetry<{ echoed?: { probe?: boolean } }>(`http://127.0.0.1:${port}/echo`, { probe: true })
    expect(result.echoed?.probe).toBe(true)
  })
})

describe('configured network proxy', () => {
  it('authenticates a proxy tunnel and releases its connection after reset', async () => {
    let authorization = ''
    const sockets = new Set<import('node:stream').Duplex>()
    const proxy = createServer()
    proxy.on('connect', (req, client, head) => {
      authorization = String(req.headers['proxy-authorization'] ?? '')
      const target = net.connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); client.pipe(target); target.pipe(client) })
      sockets.add(client); sockets.add(target)
      client.on('error', () => target.destroy()); target.on('error', () => client.destroy())
      client.on('close', () => { sockets.delete(client); target.destroy() }); target.on('close', () => sockets.delete(target))
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    try {
      setNetworkProxy(`http://probe:secret@127.0.0.1:${(proxy.address() as net.AddressInfo).port}`)
      expect(await fetchTextWithRetry('http://proxy-test.invalid/echo', { attempts: 1 })).toContain('/echo')
      expect(authorization).toBe(`Basic ${Buffer.from('probe:secret').toString('base64')}`)
    } finally { setNetworkProxy(''); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())) }
  })
  afterAll(() => {
    setNetworkProxy('')
  })

  it('activates a dispatcher for foreign hosts once configured', () => {
    expect(proxyDispatcher('https://api.curseforge.com/v1/games')).toBeUndefined()
    setNetworkProxy('http://127.0.0.1:7890')
    const dispatcher = proxyDispatcher('https://api.curseforge.com/v1/games')
    expect(dispatcher).toBeDefined()
    // Same cached instance while the configured URL stays unchanged.
    expect(proxyDispatcher('https://edge.forgecdn.net/files/1/1/mod.jar')).toBe(dispatcher)
  })

  it('keeps China-only hosts and loopback direct even with a proxy configured', () => {
    setNetworkProxy('http://127.0.0.1:7890')
    expect(proxyDispatcher('https://www.mcmod.cn/')).toBeUndefined()
    expect(proxyDispatcher('https://search.mcmod.cn/s')).toBeUndefined()
    expect(proxyDispatcher('https://gitee.com/api/v5/user')).toBeUndefined()
    expect(proxyDispatcher(`http://127.0.0.1:${port}/echo`)).toBeUndefined()
    expect(proxyDispatcher('http://localhost:8080/health')).toBeUndefined()
  })

  it('clears the override when reset to empty', () => {
    setNetworkProxy('http://127.0.0.1:7890')
    setNetworkProxy('')
    expect(proxyDispatcher('https://api.curseforge.com/v1/games')).toBeUndefined()
  })

  it('exposes the configured proxy for Java and Gradle child processes', () => {
    setNetworkProxy('http://127.0.0.1:7890')
    expect(getNetworkProxyUrl()).toBe('http://127.0.0.1:7890')
  })

  it('still bypasses China-only hosts when only the environment proxy is set', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    try {
      expect(proxyDispatcher('https://www.mcmod.cn/')).toBeUndefined()
      expect(proxyDispatcher('https://api.curseforge.com/v1/games')).toBeDefined()
    } finally {
      delete process.env.HTTPS_PROXY
    }
  })
})
