vi.mock('./networkRequest', async (importOriginal) => ({ ...(await importOriginal<typeof import('./networkRequest')>()), networkFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init) }))
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { ImageStudioService } from '../../feature-plugins/image-studio/src/main/imageStudioService'
import { diagnosticJournal } from './diagnosticLog'
import type { ImageGenerationRequest } from '../shared/imageStudio'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Sharp may release a worker-owned file handle just after the assertion
  // completes on Windows. Let the sandbox cleanup retry that transient
  // directory race instead of turning a passing product assertion into a
  // suite failure.
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

function settings(apiKey: string, clearApiKey = false) {
  return {
    baseUrl: 'https://images.example.test/v1',
    model: 'image-model',
    apiKey,
    clearApiKey,
    allowAgentImages: false,
    autoApproveAgentImages: false,
    manualHostedConsent: false
  }
}

function generationRequest(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return { prompt: 'A cat', style: 'free', size: '1024x1024', quality: 'low', moderation: 'auto', count: 1, background: 'auto', backgroundColor: '#ffffff', removeBackground: false, source: 'manual', ...overrides }
}

it('records the full bounded image refusal and request ID before formatting the short error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-diagnostic-')); roots.push(root)
  const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: async () => ({ baseUrl: 'https://image.test/v1', apiKey: 'image-secret-fixture', jobId: 'job', model: 'image-fixture', reservedCredits: 1 }) })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ request_id: 'provider-image-id', error: { message: 'invalid size, image-secret-fixture', param: 'size' }, diagnostic_extra: 'provider-deep-cause' }), { status: 400, headers: { 'x-request-id': 'provider-header-id' } })))
  await expect(service.generate(generationRequest({model:'image-fixture'}))).rejects.toThrow('size')
  const text = JSON.stringify(diagnosticJournal.snapshot().filter(event => event.operation === 'http-response'))
  expect(text).toContain('provider-image-id'); expect(text).toContain('provider-header-id'); expect(text).toContain('provider-deep-cause')
  expect(text).not.toContain('image-secret-fixture')
})

describe('ImageStudioService hosted credential freshness', () => {
  it('aborts the real secondary image download without creating the next billed request', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-url-cancel-')); roots.push(root)
    const controller = new AbortController()
    let generations = 0
    let origin = ''
    const server = createServer((request, response) => {
      if (request.url === '/v1/images/generations') {
        generations += 1; request.resume()
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ url: `${origin}/image.png` }] }))
      } else {
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.write(Buffer.alloc(10))
        setTimeout(() => controller.abort(), 20)
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const getHostedLease = vi.fn(async () => ({ baseUrl: `${origin}/v1`, apiKey: 'fixture', jobId: 'job', model: 'image-model', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    try {
      await expect(service.generate(generationRequest({ count: 3, model: 'images' }), 'agent', controller.signal)).rejects.toThrow()
      expect(generations).toBe(1); expect(getHostedLease).toHaveBeenCalledTimes(1)
      expect(await service.history()).toEqual([])
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('cancels an active request and does not acquire another image lease', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-cancel-')); roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://image.test/v1', apiKey: 'fixture', jobId: 'job', model: 'image-model', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      queueMicrotask(() => controller.abort())
      await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    }))
    await expect(service.generate(generationRequest({ count: 3, model: 'images' }), 'agent', controller.signal)).rejects.toThrow()
    expect(getHostedLease).toHaveBeenCalledTimes(1)
    expect(await service.history()).toEqual([])
  })

  it('returns already generated image bytes if history replacement fails and preserves old history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-history-failure-')); roots.push(root)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: async () => ({ baseUrl: 'https://image.test/v1', apiKey: 'fixture', jobId: 'job', model: 'image-model', reservedCredits: 1 }) })
    const old = '[{"id":"previous"}]'; await fs.writeFile(path.join(root, 'image-studio-history.json'), old)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }))))
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk blocked'), { code: 'EACCES' }))
    const result = await service.generate(generationRequest({ count: 3, model: 'images' }))
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].dataUrl).toBe('data:image/png;base64,aW1hZ2U=')
    expect(result.error).toContain('历史记录保存失败')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(path.join(root, 'image-studio-history.json'), 'utf8')).toBe(old)
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('uses the synced image API without requesting a hosted lease', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-synced-image-'))
    roots.push(root)
    const getHostedLease = vi.fn(async () => { throw new Error('hosted lease must not be requested') })
    const service = new ImageStudioService({
      userDataDir: root, projectRoot: () => null, getHostedLease,
      getSyncedImageApi: async () => ({ customMode: true, imageApi: { baseUrl: 'https://synced.example.test/v1', apiKey: 'synced-secret', model: 'synced-model' } })
    })
    await service.saveSettings(settings('old-manual-key'))
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://synced.example.test/v1/images/generations')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer synced-secret' })
      expect(JSON.parse(String(init.body)).model).toBe('synced-model')
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    expect((await service.getSettings()).syncedFromDevice).toBe(true)
    const result = await service.generate(generationRequest())
    expect(result.hosted).toBe(false)
    expect(result.credits).toBe(0)
    expect(getHostedLease).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to a hosted image lease when custom sync has no image API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-no-synced-image-'))
    roots.push(root)
    const getHostedLease = vi.fn(async () => { throw new Error('hosted lease must not be requested') })
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease, getSyncedImageApi: async () => ({ customMode: true, imageApi: null }) })
    await expect(service.generate(generationRequest())).rejects.toThrow('请配置图片 API')
    expect(getHostedLease).not.toHaveBeenCalled()
  })

  it.each([
    { hosted: true, edit: false }, { hosted: true, edit: true },
    { hosted: false, edit: false }, { hosted: false, edit: true }
  ])('generates five images sequentially with n=1 (hosted=$hosted, edit=$edit)', async ({ hosted, edit }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-batch-'))
    roots.push(root)
    const events: string[] = []
    let completed = 0
    const getHostedLease = vi.fn(async (request?: ImageGenerationRequest) => {
      expect(request?.count).toBe(1)
      events.push(`lease:${completed + 1}`)
      return { baseUrl: `https://hosted-${completed + 1}.example.test/v1`, apiKey: `key-${completed + 1}`, jobId: `job-${completed + 1}`, model: 'image-model', reservedCredits: 1 }
    })
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(hosted ? '' : 'own-key'))
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const index = completed + 1
      events.push(`fetch:${index}`)
      expect(url).toBe(`https://${hosted ? `hosted-${index}` : 'images'}.example.test/v1/images/${edit ? 'edits' : 'generations'}`)
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${hosted ? `key-${index}` : 'own-key'}` })
      if (edit) {
        expect((init.body as FormData).get('n')).toBe('1')
        expect(await ((init.body as FormData).get('image') as Blob).text()).toBe('\0')
      } else expect(JSON.parse(String(init.body)).n).toBe(1)
      const response = new Response()
      response.json = async () => {
        await Promise.resolve()
        completed += 1
        events.push(`complete:${index}`)
        return { data: [{ b64_json: Buffer.from(`image-${index}`).toString('base64') }] }
      }
      return response
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await service.generate(generationRequest({ count: 5, ...(edit ? { referenceImage: 'data:image/png;base64,AA==' } : {}) }))
    expect(result.error).toBeUndefined()
    expect(result.assets).toHaveLength(5)
    expect(new Set(result.assets.map((asset) => asset.dataUrl)).size).toBe(5)
    expect(result.credits).toBe(hosted ? 5 : 0)
    expect(await service.history()).toHaveLength(5)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 5 : 0)
    expect(events).toEqual([1, 2, 3, 4, 5].flatMap((index) => [...(hosted ? [`lease:${index}`] : []), `fetch:${index}`, `complete:${index}`]))
  })

  it.each(['lease', 'generation'])('returns completed images and stops after a later %s failure', async (failure) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-partial-'))
    roots.push(root)
    let leases = 0
    const getHostedLease = vi.fn(async () => {
      leases += 1
      if (leases === 2 && failure === 'lease') throw new Error('lease unavailable')
      return { baseUrl: 'https://hosted.example.test/v1', apiKey: 'key', jobId: `job-${leases}`, model: 'image-model', reservedCredits: 1 }
    })
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    const fetchMock = vi.fn(async () => leases === 2
      ? new Response(JSON.stringify({ error: { message: 'generation unavailable' } }), { status: 400 })
      : new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await service.generate(generationRequest({ count: 5 }))
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].dataUrl).toBe('data:image/png;base64,AA==')
    expect(result.error).toContain('已生成 1/5 张，第 2 张失败')
    expect(result.error).toContain(`${failure} unavailable`)
    expect(result.credits).toBe(1)
    expect(await service.history()).toHaveLength(1)
    expect(getHostedLease).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(failure === 'lease' ? 1 : 2)
  })

  it.each([
    { source: 'manual' as const, edit: false },
    { source: 'manual' as const, edit: true },
    { source: 'agent' as const, edit: false },
    { source: 'agent' as const, edit: true }
  ])('awaits a new lease for every generation, including a retry ($source, edit=$edit)', async ({ source, edit }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-fresh-'))
    roots.push(root)
    const events: string[] = []
    let leaseNumber = 0
    const getHostedLease = vi.fn(async () => {
      const current = ++leaseNumber
      events.push(`lease:${current}`)
      await Promise.resolve()
      events.push(`ready:${current}`)
      return { baseUrl: `https://hosted-${current}.example.test/v1`, apiKey: `temporary-${current}`, jobId: `job-${current}`, model: 'image-model', reservedCredits: 1 }
    })
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      events.push(`fetch:${leaseNumber}`)
      expect(url).toBe(`https://hosted-${leaseNumber}.example.test/v1/images/${edit ? 'edits' : 'generations'}`)
      expect(init.headers).toMatchObject({ Authorization: `Bearer temporary-${leaseNumber}` })
      return leaseNumber === 2
        ? new Response(JSON.stringify({ error: 'expired key' }), { status: 401 })
        : new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const request = generationRequest({ source, ...(edit ? { referenceImage: 'data:image/png;base64,AA==' } : {}) })
    await expect(service.generate(request)).resolves.toMatchObject({ jobId: 'job-1', hosted: true })
    await expect(service.generate(request)).rejects.toThrow('HTTP 401')
    await expect(service.generate(request)).resolves.toMatchObject({ jobId: 'job-3', hosted: true })
    expect(getHostedLease).toHaveBeenCalledTimes(3)
    expect(getHostedLease).toHaveBeenNthCalledWith(3, request, undefined)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(events).toEqual(['lease:1', 'ready:1', 'fetch:1', 'lease:2', 'ready:2', 'fetch:2', 'lease:3', 'ready:3', 'fetch:3'])
  })

  it('reads hosted metadata without creating leases and acquires a lease only for generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-model-lease-'))
    roots.push(root)
    let leaseNumber = 0
    const getHostedLease = vi.fn(async () => {
      const current = ++leaseNumber
      return { baseUrl: `https://hosted-${current}.example.test/v1`, apiKey: `temporary-${current}`, jobId: `job-${current}`, model: 'image-model', reservedCredits: 0 }
    })
    const getHostedImageProvider = vi.fn(async () => ({ available: true, model: 'server-image-model', provider: 'ls' }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease, getHostedImageProvider })
    await service.saveSettings(settings(''))
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://hosted-${leaseNumber}.example.test/v1/images/generations`)
      expect(init.headers).toMatchObject({ Authorization: `Bearer temporary-${leaseNumber}` })
      return new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    expect((await service.capabilities()).models).toEqual(['server-image-model'])
    expect((await service.capabilities()).models).toEqual(['server-image-model'])
    expect(getHostedLease).not.toHaveBeenCalled()
    await service.generate(generationRequest())
    expect(getHostedImageProvider).toHaveBeenCalledTimes(2)
    expect(getHostedLease).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['generations', 'edits'] as const)('does not reuse a previous key when the next lease fails (%s)', async (operation) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-lease-failure-'))
    roots.push(root)
    const getHostedLease = vi.fn()
      .mockResolvedValueOnce({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'old-key', jobId: 'job', model: 'image-model', reservedCredits: 0 })
      .mockRejectedValueOnce(new Error('lease unavailable'))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'image-model', b64_json: 'AA==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const invoke = () => service.generate(generationRequest(operation === 'edits' ? { referenceImage: 'data:image/png;base64,AA==' } : {}))
    await invoke()
    await expect(invoke()).rejects.toThrow('lease unavailable')
    expect(getHostedLease).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('ImageStudioService upstream errors', () => {
  it.each([
    { payload: JSON.stringify({ error: { message: 'Unsupported size', code: 'invalid_value', param: 'size', type: 'invalid_request_error' } }), expected: 'Unsupported size；code=invalid_value；param=size；type=invalid_request_error' },
    { payload: JSON.stringify({ error: 'Invalid model' }), expected: 'Invalid model' },
    { payload: JSON.stringify({ message: 'Reference image is invalid' }), expected: 'Reference image is invalid' },
    { payload: JSON.stringify({ detail: 'Unsupported moderation' }), expected: 'Unsupported moderation' },
    { payload: JSON.stringify('Request rejected'), expected: 'Request rejected' },
    { payload: 'Upstream validation failed', expected: 'Upstream validation failed' },
    { payload: JSON.stringify({ error: { code: 'model_not_found' } }), expected: 'code=model_not_found' },
    { payload: '', expected: '上游未返回可读错误' },
    { payload: JSON.stringify({ error: { message: 'Invalid credential test-key' } }), expected: 'Invalid credential [REDACTED]' }
  ])('preserves the upstream reason across model lookup, generation and editing ($expected)', async ({ payload, expected }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-errors-'))
    roots.push(root)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: async () => { throw new Error('not used') } })
    await service.saveSettings(settings('test-key'))
    const fetchMock = vi.fn(async () => new Response(payload, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(service.capabilities()).rejects.toThrow(`无法读取图片模型列表（HTTP 400）：${expected}`)
    await expect(service.generate(generationRequest())).rejects.toThrow(`图片生成失败（HTTP 400）：${expected}`)
    await expect(service.generate(generationRequest({ referenceImage: 'data:image/png;base64,AA==' }))).rejects.toThrow(`图片生成失败（HTTP 400）：${expected}`)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await service.history()).toEqual([])
  })
})

describe('ImageStudioService independent official image context', () => {
  it.each(['json', 'sse'])('redacts and bounds temporary credentials in upstream errors (%s)', async format => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-reflected-error-')); roots.push(root)
    const key = 'opaque-image-key', unknownKey = 'sk-other-image-secret', session = 'mdr_other-session-secret'
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://ls.example.test/v1', apiKey: key, model: 'gpt-image-2', provider: 'ls' as const, jobId: 'job', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    const payload = JSON.stringify({ error: { message: `${key} ${unknownKey} ${session} ${'detail '.repeat(2000)}` } })
    const fetcher = vi.fn(async () => new Response(format === 'sse' ? `event: error\ndata: ${payload}\n\n` : payload, { status: format === 'sse' ? 200 : 400, headers: { 'Content-Type': format === 'sse' ? 'text/event-stream' : 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const error = await service.generate({ prompt: 'generate', count: 3 }).catch(error => error as Error)
    const message = (error as Error).message
    for (const secret of [key, unknownKey, session]) expect(message).not.toContain(secret)
    expect(message).toContain('[REDACTED]')
    expect(message.length).toBeLessThan(2100)
    expect(fetcher).toHaveBeenCalledOnce(); expect(getHostedLease).toHaveBeenCalledOnce()
  })

  it('bounds oversized upstream error reads and cancels the body without another generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-large-error-')); roots.push(root)
    let reads = 0
    const cancelled = vi.fn()
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://ls.example.test/v1', apiKey: 'secret', model: 'gpt-image-2', jobId: 'job', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new TextEncoder().encode('secret'.repeat(4096))) },
      cancel: cancelled
    }), { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(service.generate({ prompt: 'generate', count: 3 })).rejects.toThrow('上游错误信息过大或无法读取，已省略')
    expect(reads).toBeLessThan(6); expect(cancelled).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce(); expect(getHostedLease).toHaveBeenCalledOnce()
  })

  it.each(['\n', '\r\n', '\r'])('parses byte-split SSE frames and the final event at EOF (%j)', async newline => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-sse-chunks-')); roots.push(root)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: async () => ({ baseUrl: 'https://ls.example.test/v1', apiKey: 'key', model: 'model', provider: 'ls', jobId: 'job', reservedCredits: 1 }) })
    const bytes = new TextEncoder().encode([': ping', 'event: image_generation.partial_image', 'data: {"b64_json":"AA=="}', '', 'event: image_generation.completed', `data: ${JSON.stringify({ b64_json: 'AQ==', output_format: 'webp', revised_prompt: '完整图片' })}`, ''].join(newline))
    let offset = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset)); else controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })))
    const result = await service.generate({ prompt: 'stream test' })
    expect(result.assets[0].dataUrl).toBe('data:image/webp;base64,AQ==')
    expect(result.revisedPrompt).toBe('完整图片')
  })

  it.each([
    { provider: 'ls' as const, references: 0 }, { provider: 'ls' as const, references: 1 },
    { provider: 'ls' as const, references: 2 }, { provider: 'secondary' as const, references: 0 },
    { provider: 'primary' as const, references: 0 }
  ])('uses lease model, URL and key through a real HTTP request ($provider, refs=$references)', async ({ provider, references }) => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const received: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Buffer }> = []
    const streamed = provider !== 'primary'
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      if (!streamed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return }
      res.setHeader('Content-Type', 'text/event-stream')
      const type = references ? 'image_edit' : 'image_generation'
      const sse = `: connected\r\nevent: ${type}.partial_image\r\ndata: ${JSON.stringify({ type: `${type}.partial_image`, b64_json: 'AA==', partial_image_index: 0 })}\r\n\r\nevent: ${type}.completed\r\ndata: ${JSON.stringify({ type: `${type}.completed`, b64_json: png.toString('base64'), revised_prompt: '完整图片' })}\r\n\r\ndata: [DONE]\r\n\r\n`
      // Break every line and UTF-8 sequence across arbitrary stream chunks.
      const bytes = Buffer.from(sse)
      for (let index = 0; index < bytes.length; index += 7) res.write(bytes.subarray(index, index + 7))
      res.end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-independent-image-')); roots.push(root)
      const context = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`, apiKey: 'lease-image-key', model: 'lease-image-model', provider, jobId: 'lease-job', reservedCredits: 1 }
      const getHostedLease = vi.fn(async () => context)
      const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
      await service.saveSettings({ ...settings(''), model: '' })
      const result = await service.generate({ prompt: 'one output', model: 'stale-chat-model', referenceImages: Array.from({ length: references }, () => `data:image/png;base64,${png.toString('base64')}`) }, 'agent')
      expect(getHostedLease).toHaveBeenCalledTimes(1)
      expect(received).toHaveLength(1)
      expect(received[0].url).toBe(`/v1/images/${references ? 'edits' : 'generations'}`)
      expect(received[0].headers.authorization).toBe('Bearer lease-image-key')
      if (references) {
        expect(received[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
        const form = await new Response(new Uint8Array(received[0].body), { headers: { 'Content-Type': received[0].headers['content-type']! } }).formData()
        expect(form.get('model')).toBe('lease-image-model')
        expect(form.get('stream')).toBe('true'); expect(form.get('partial_images')).toBe('3')
        const files = form.getAll(references === 1 ? 'image' : 'image[]') as File[]
        expect(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer())))).toEqual(Array.from({ length: references }, () => png))
      } else {
        expect(JSON.parse(received[0].body.toString())).toMatchObject({ model: 'lease-image-model', n: 1, ...(streamed ? { stream: true, partial_images: 3 } : {}) })
        if (!streamed) expect(JSON.parse(received[0].body.toString())).not.toHaveProperty('stream')
      }
      expect(result.assets).toHaveLength(1)
      expect(result.assets[0]).toMatchObject({ model: 'lease-image-model', dataUrl: `data:image/png;base64,${png.toString('base64')}` })
      expect((await service.getSettings()).model).toBe('')
      expect((await fs.readFile(path.join(root, 'image-studio-settings.json'), 'utf8'))).not.toContain('lease-image-key')
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it.each(['partial', 'error', 'upstream-503', 'invalid'])('keeps failed streamed edits from creating a new lease or a text-only fallback (%s)', async failure => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-no-rebill-')); roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://ls.example.test/v1', apiKey: 'lease-key', model: 'leased-model', provider: 'ls' as const, jobId: 'job', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    const bodies = {
      partial: 'event: image_edit.partial_image\ndata: {"b64_json":"AA=="}\n\n',
      error: 'event: error\ndata: {"error":{"message":"quota failed lease-key"}}\n\n',
      'upstream-503': '{"error":{"message":"upstream unavailable"}}', invalid: 'data: not-json\n\n'
    }
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(bodies[failure as keyof typeof bodies], { status: failure === 'upstream-503' ? 503 : 200, headers: { 'Content-Type': failure === 'upstream-503' ? 'application/json' : 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const invocation = service.generate({ prompt: 'edit this', referenceImage: 'data:image/png;base64,AA==', count: 3 })
    await expect(invocation).rejects.toThrow(failure === 'partial' ? '未返回最终完整图片' : failure === 'error' ? 'quota failed [REDACTED]' : failure === 'invalid' ? '无效数据' : 'HTTP 503')
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(getHostedLease).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/images/edits')
    expect(await service.history()).toEqual([])
  })

  it('accepts a direct binary image response and refreshes the image selection for the next generation', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-binary-')); roots.push(root)
    let lease = 0
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: async () => ({ baseUrl: `https://image-${++lease}.example.test/v1`, apiKey: `image-key-${lease}`, model: `model-${lease}`, jobId: `job-${lease}`, reservedCredits: 1 }) })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    for (const index of [1, 2]) {
      const result = await service.generate({ prompt: 'new task' })
      expect(result.assets[0]).toMatchObject({ model: `model-${index}`, dataUrl: `data:image/png;base64,${png.toString('base64')}` })
      expect(fetchMock.mock.calls[index - 1][0]).toBe(`https://image-${index}.example.test/v1/images/generations`)
    }
  })
})

describe('ImageStudioService settings', () => {
  it.each([{ edit: false, hosted: false }, { edit: true, hosted: false }, { edit: false, hosted: true }, { edit: true, hosted: true }])('uses the saved model and falls back from empty base64 to URL ($edit, $hosted)', async ({ edit, hosted }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-request-'))
    roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'temporary-key', jobId: 'job', model: 'image-model', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings({ ...settings(hosted ? '' : 'test-key'), model: 'custom-provider-model' })
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: '', url: 'https://images.example.test/result.png' }] })))
      .mockResolvedValueOnce(new Response(new Uint8Array(png)))
    vi.stubGlobal('fetch', fetchMock)
    const request: ImageGenerationRequest = { prompt: 'A cat', style: 'free', size: '1024x1024', quality: 'low', moderation: 'auto', count: 1, background: 'auto', backgroundColor: '#ffffff', removeBackground: false, source: 'manual', ...(edit ? { referenceImage: `data:image/png;base64,${png.toString('base64')}` } : {}) }
    const result = await service.generate(request)
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 1 : 0)
    expect(fetchMock.mock.calls[0][0]).toBe(`https://${hosted ? 'hosted' : 'images'}.example.test/v1/images/${edit ? 'edits' : 'generations'}`)
    const body = fetchMock.mock.calls[0][1].body
    expect(edit ? body.get('model') : JSON.parse(body).model).toBe(hosted ? 'image-model' : 'custom-provider-model')
    expect(fetchMock.mock.calls[1][0]).toBe('https://images.example.test/result.png')
    expect(result.assets[0]).toMatchObject({ model: hosted ? 'image-model' : 'custom-provider-model', dataUrl: `data:image/png;base64,${png.toString('base64')}` })
  })

  it('loads custom models with the user credentials', async () => {
    const hosted = false
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-models-'))
    roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1/', apiKey: 'temporary-key', jobId: 'job', model: 'image-model', reservedCredits: 0 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(hosted ? '' : 'own-key'))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'flux-pro' }, { id: 'gpt-image-2' }, { id: '' }, {}] })))
    vi.stubGlobal('fetch', fetchMock)
    expect((await service.capabilities()).models).toEqual(['gpt-image-2', 'flux-pro'])
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 1 : 0)
    expect(fetchMock).toHaveBeenCalledWith(`https://${hosted ? 'hosted' : 'images'}.example.test/v1/models`, expect.objectContaining({ headers: { Authorization: `Bearer ${hosted ? 'temporary-key' : 'own-key'}` } }))
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await expect(service.capabilities()).rejects.toThrow('HTTP 401')
    fetchMock.mockResolvedValueOnce(new Response('{"data":[]}'))
    expect((await service.capabilities()).models).toEqual([])
  })

  it('keeps a blank API key by default and clears it only when explicitly requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-settings-'))
    roots.push(root)
    const service = new ImageStudioService({
      userDataDir: root,
      projectRoot: () => null,
      getHostedLease: async () => { throw new Error('not used') }
    })

    await expect(service.saveSettings(settings('secret-key'))).resolves.toMatchObject({
      hasStoredKey: true,
      allowAgentImages: true,
      autoApproveAgentImages: true,
      manualHostedConsent: true
    })
    await expect(service.saveSettings(settings(''))).resolves.toMatchObject({ hasStoredKey: true })
    await expect(service.getSettings()).resolves.not.toHaveProperty('apiKey')
    await expect(service.revealApiKey()).resolves.toBe('secret-key')
    await expect(service.saveSettings(settings('', true))).resolves.toMatchObject({ hasStoredKey: false })
    await expect(service.revealApiKey()).resolves.toBe('')

    const stored = JSON.parse(await fs.readFile(path.join(root, 'image-studio-settings.json'), 'utf8')) as Record<string, unknown>
    expect(stored).not.toHaveProperty('encryptedKey')
  })
})


describe('Image Studio workbench and UI parity', () => {
  it.each([false, true])('keeps every reference in each multipart request for both sources (hosted=%s)', async hosted => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-multiref-')); roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'key', jobId: 'job', model: 'image-model', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(hosted ? '' : 'own-key'))
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData
      expect(form.get('n')).toBe('1')
      expect(form.get('image')).toBeNull()
      const references = form.getAll('image[]') as File[]
      expect(references.map(file => file.type)).toEqual(['image/png', 'image/jpeg'])
      expect(references.map(file => file.name)).toEqual(['reference-1.png', 'reference-2.jpg'])
      expect(await Promise.all(references.map(async file => [...new Uint8Array(await file.arrayBuffer())]))).toEqual([[0], [1]])
      return new Response(JSON.stringify({ data: [{ b64_json: 'Ag==' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    for (const source of ['manual', 'agent'] as const) {
      const result = await service.generate({ prompt: 'combine', referenceImages: ['data:image/png;base64,AA==', 'data:image/jpeg;base64,AQ=='], count: 2 }, source)
      expect(result.assets).toHaveLength(2)
      expect(result.error).toBeUndefined()
      expect(result.credits).toBe(hosted ? 2 : 0)
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 4 : 0)
  })

  it('sends two references as one real HTTP edit request with both image payloads', async () => {
    const sharp = (await import('sharp')).default
    const pixels = await Promise.all(['#ff0000', '#0000ff'].map(background => sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer()))
    const received: Array<{ url?: string; type?: string; body: Buffer }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({ url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ b64_json: pixels[0].toString('base64') }] }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-http-')); roots.push(root)
      const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: vi.fn() })
      await service.saveSettings({ ...settings('local-test'), baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })
      const result = await service.generate({ prompt: 'combine red and blue', count: 1, referenceImages: pixels.map(pixel => `data:image/png;base64,${pixel.toString('base64')}`) })
      expect(result.assets).toHaveLength(1)
      expect(received).toHaveLength(1)
      expect(received[0].url).toBe('/v1/images/edits')
      const form = await new Response(new Uint8Array(received[0].body), { headers: { 'Content-Type': received[0].type! } }).formData()
      const references = form.getAll('image[]') as File[]
      expect(await Promise.all(references.map(async file => Buffer.from(await file.arrayBuffer())))).toEqual(pixels)
      expect(form.get('n')).toBe('1')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('rejects invalid later references before obtaining hosted credit or calling the provider', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-invalid-ref-')); roots.push(root)
    const getHostedLease = vi.fn(); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    await expect(service.generate({ prompt: 'cat', referenceImages: ['data:image/png;base64,AA==', 'invalid'] })).rejects.toThrow('参考图必须')
    expect(getHostedLease).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([false, true])('uses the same configuration and parameters for both sources (hosted=%s)', async hosted => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-parity-')); roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'hosted-key', jobId: 'job', model: 'image-model', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(hosted ? '' : 'own-key'))
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const input = generationRequest({ model: 'override-model', size: '1536x1024', quality: 'high', moderation: 'low', count: 2, background: 'solid', backgroundColor: '#123456', referenceImage: 'data:image/png;base64,AA==' })
    for (const source of ['manual', 'agent'] as const) {
      const result = await service.generate(input, source)
      expect(result.assets).toHaveLength(2)
      expect(result.assets[0]).toMatchObject({ model: hosted ? 'image-model' : 'override-model', size: '1536x1024', quality: 'high', hosted })
    }
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 4 : 0)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`https://${hosted ? 'hosted' : 'images'}.example.test/v1/images/edits`)
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${hosted ? 'hosted-key' : 'own-key'}`)
      const body = init.body as FormData
      expect(Object.fromEntries(['model', 'size', 'quality', 'moderation', 'n'].map(key => [key, body.get(key)]))).toEqual({ model: hosted ? 'image-model' : 'override-model', size: '1536x1024', quality: 'high', moderation: 'low', n: '1' })
      expect(body.get('prompt')).toBe('Flat solid #123456 background. A cat')
    }
    expect((await service.getSettings()).model).toBe('image-model')
  })

  it('workbench presets match the UI workflow request at the actual provider boundary', async () => {
    const { imageWorkflowPrompt } = await import('../shared/imageStudioPresets')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-preset-parity-')); roots.push(root)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: vi.fn() })
    await service.saveSettings(settings('own-key'))
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const data = { kind: 'generate' as const, title: '生成', subtitle: '', presetId: 'creature-views', presetPrompt: '三视图红色机器人', count: 1 }
    await service.generate(generationRequest({ prompt: imageWorkflowPrompt(data), quality: 'medium' }), 'manual')
    await service.generate({ prompt: '', presetId: data.presetId, presetPrompt: data.presetPrompt }, 'agent')
    const comparable = ([url, init]: [string, RequestInit]) => ({ url, method: init.method, headers: init.headers, body: init.body })
    expect(comparable(fetchMock.mock.calls[0])).toEqual(comparable(fetchMock.mock.calls[1]))
  })

  it('performs real local background removal and keeps the original when processing fails', async () => {
    const sharp = (await import('sharp')).default
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-remove-')); roots.push(root)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: vi.fn() })
    await service.saveSettings(settings('own-key'))
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await service.generate({ prompt: 'cat', removeBackground: true }, 'agent')
    const { data, info } = await sharp(Buffer.from(result.assets[0].dataUrl.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    expect(data[3]).toBe(0)
    vi.spyOn(service, 'process').mockRejectedValueOnce(new Error('processing failed'))
    const partial = await service.generate({ prompt: 'cat', count: 3, removeBackground: true }, 'agent')
    expect(partial.error).toContain('已保留原图')
    expect(partial.assets).toHaveLength(1)
    expect(partial.assets[0].dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not fall back to hosted billing when a saved custom key is unreadable', async () => {
    const { safeStorage } = await import('electron')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-key-')); roots.push(root)
    const getHostedLease = vi.fn()
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings('own-key'))
    vi.spyOn(safeStorage, 'decryptString').mockImplementation(() => { throw new Error('cannot decrypt') })
    for (const source of ['manual', 'agent'] as const) await expect(service.generate({ prompt: 'cat' }, source)).rejects.toThrow('无法解密')
    expect(getHostedLease).not.toHaveBeenCalled()
  })

  it('describes saved settings without network or secrets and preserves them after model lookup failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-info-')); roots.push(root)
    const getHostedLease = vi.fn(async () => { throw new Error('lease unavailable') })
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    await expect(service.describe()).resolves.toMatchObject({ credentialSource: 'hosted', settings: { model: 'image-model' }, presets: expect.any(Array) })
    expect(getHostedLease).not.toHaveBeenCalled()
    await expect(service.describe(true)).resolves.toMatchObject({ settings: { model: 'image-model' }, capabilitiesError: '请刷新账号连接后读取生图配置' })
    await service.saveSettings(settings('own-secret-key'))
    expect(JSON.stringify(await service.describe())).not.toContain('own-secret-key')
  })
})
