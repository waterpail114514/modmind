import { Readable } from 'node:stream'
import { lookup } from 'node:dns/promises'
import { request } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWebPage, searchWeb } from './webResearch'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), request: vi.fn() }))

function response(text: string | Buffer, type = 'text/html; charset=utf-8', statusCode = 200, headers: Record<string, string> = {}) {
  return { statusCode, headers: { 'content-type': type, ...headers }, body: Readable.from([text]) } as unknown as Awaited<ReturnType<typeof request>>
}

beforeEach(() => {
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
})
afterEach(() => vi.resetAllMocks())

describe('read-only web research', () => {
  it('reads HTML text and source links with continuation, without scripts or navigation', async () => {
    vi.mocked(request).mockImplementation(async () => response('<title>文档</title><nav>导航</nav><main><h1>介绍</h1><p>一二三四五六七八九十</p><script>secret()</script><a href="/guide">指南</a></main>'))
    const first = await readWebPage({ url: 'https://docs.example.org/start', maxChars: 8 })
    expect(first.title).toBe('文档')
    expect(first.content).toBe('介绍\n一二三四五')
    expect(first.nextOffset).toBe(8)
    const next = await readWebPage({ url: first.url, offset: first.nextOffset })
    expect(first.content + next.content).toBe('介绍\n一二三四五六七八九十\n指南')
    expect(next.nextOffset).toBeUndefined()
    expect(first.links).toEqual([{ title: '指南', url: 'https://docs.example.org/guide' }])
    expect(vi.mocked(request).mock.calls[0][1]).toMatchObject({ method: 'GET' })
  })

  it('returns live search sources and decodes RSS snippets', async () => {
    vi.mocked(request).mockResolvedValue(response('<rss><channel><item><title>Fabric 文档</title><link>https://docs.fabricmc.net/</link><description>&lt;b&gt;开发指南&lt;/b&gt;</description></item></channel></rss>', 'application/rss+xml'))
    expect(await searchWeb({ query: 'Fabric 开发' })).toMatchObject({ provider: 'Bing', results: [{ title: 'Fabric 文档', url: 'https://docs.fabricmc.net/', snippet: '开发指南' }] })
    expect(String(vi.mocked(request).mock.calls[0][0])).toContain('q=Fabric%20')
  })

  it('keeps all article cards when a page has no main element', async () => {
    vi.mocked(request).mockResolvedValue(response('<body><a href="/players"><article><h2>Player guides</h2></article></a><a href="/developers"><article><h2>Developer guides</h2></article></a></body>'))
    const page = await readWebPage({ url: 'https://docs.example.org/' })
    expect(page.content).toContain('Player guides')
    expect(page.content).toContain('Developer guides')
    expect(page.links).toHaveLength(2)
  })

  it('distinguishes successfully fetched dynamic pages from unavailable internet', async () => {
    vi.mocked(request).mockResolvedValue(response('<head><title>原神官网</title><meta name="description" content="开放世界冒险游戏"></head><body><div id="app"></div><script>renderApp()</script></body>'))
    const page = await readWebPage({ url: 'https://example.org/' })
    expect(page).toMatchObject({ title: '原神官网', description: '开放世界冒险游戏', content: '', totalChars: 0 })
    expect(page.warning).toContain('网页已成功获取')
    expect(page.warning).toContain('不是渲染后的正文')
  })

  it('falls back when the first search provider fails', async () => {
    vi.mocked(request).mockResolvedValueOnce(response('blocked', 'text/html', 403)).mockResolvedValueOnce(response('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.fabricmc.net%2F">Fabric</a><div class="result__snippet">Guide</div></div>'))
    expect(await searchWeb({ query: 'Fabric' })).toMatchObject({ provider: 'DuckDuckGo', results: [{ url: 'https://docs.fabricmc.net/' }] })
  })

  it.each(['http://example.org', 'file:///etc/passwd', 'https://user:pass@example.org', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://10.1.2.3', 'https://example.org:8080'])('rejects unsupported URLs: %s', async url => {
    await expect(readWebPage({ url })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('checks DNS and every redirect before making requests', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '192.168.1.2', family: 4 }] as never)
    await expect(readWebPage({ url: 'https://private.example.org' })).rejects.toThrow('内网')
    expect(request).not.toHaveBeenCalled()
    vi.mocked(request).mockResolvedValueOnce(response('', 'text/html', 302, { location: 'https://127.0.0.1/' }))
    await expect(readWebPage({ url: 'https://example.org' })).rejects.toThrow('内网')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects binaries and oversized streamed pages', async () => {
    vi.mocked(request).mockResolvedValueOnce(response('binary', 'application/octet-stream'))
    await expect(readWebPage({ url: 'https://example.org/file' })).rejects.toThrow('不是可读取的文本网页')
    vi.mocked(request).mockResolvedValueOnce(response(Buffer.alloc(2 * 1024 * 1024 + 1)))
    await expect(readWebPage({ url: 'https://example.org/large' })).rejects.toThrow('2 MiB')
  })

  it('reports provider failures and honors cancellation', async () => {
    vi.mocked(request).mockImplementation(async () => response('captcha', 'text/html', 429))
    await expect(searchWeb({ query: 'Fabric' })).rejects.toThrow('HTTP 429')
    vi.mocked(request).mockClear()
    await expect(searchWeb({ query: 'Fabric' }, AbortSignal.abort())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
