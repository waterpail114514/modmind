import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { ImageStudioService } from './imageStudioService'
import type { ImageGenerationRequest } from '../shared/imageStudio'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
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

describe('ImageStudioService hosted credential freshness', () => {
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
      return { baseUrl: `https://hosted-${completed + 1}.example.test/v1`, apiKey: `key-${completed + 1}`, jobId: `job-${completed + 1}`, reservedCredits: 1 }
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
      return { baseUrl: 'https://hosted.example.test/v1', apiKey: 'key', jobId: `job-${leases}`, reservedCredits: 1 }
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
      return { baseUrl: `https://hosted-${current}.example.test/v1`, apiKey: `temporary-${current}`, jobId: `job-${current}`, reservedCredits: 1 }
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
    expect(getHostedLease).toHaveBeenNthCalledWith(3, request)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(events).toEqual(['lease:1', 'ready:1', 'fetch:1', 'lease:2', 'ready:2', 'fetch:2', 'lease:3', 'ready:3', 'fetch:3'])
  })

  it('refreshes credentials for each model lookup and again before generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-model-lease-'))
    roots.push(root)
    let leaseNumber = 0
    const getHostedLease = vi.fn(async () => {
      const current = ++leaseNumber
      return { baseUrl: `https://hosted-${current}.example.test/v1`, apiKey: `temporary-${current}`, jobId: `job-${current}`, reservedCredits: 0 }
    })
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://hosted-${leaseNumber}.example.test/v1/${leaseNumber < 3 ? 'models' : 'images/generations'}`)
      expect(init.headers).toMatchObject({ Authorization: `Bearer temporary-${leaseNumber}` })
      return new Response(JSON.stringify({ data: leaseNumber < 3 ? [{ id: 'image-model' }] : [{ b64_json: 'AA==' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    await service.capabilities()
    await service.capabilities()
    await service.generate(generationRequest())
    expect(getHostedLease).toHaveBeenCalledTimes(3)
    expect(getHostedLease).toHaveBeenNthCalledWith(1)
    expect(getHostedLease).toHaveBeenNthCalledWith(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['models', 'generations', 'edits'] as const)('does not reuse a previous key when the next lease fails (%s)', async (operation) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-lease-failure-'))
    roots.push(root)
    const getHostedLease = vi.fn()
      .mockResolvedValueOnce({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'old-key', jobId: 'job', reservedCredits: 0 })
      .mockRejectedValueOnce(new Error('lease unavailable'))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'image-model', b64_json: 'AA==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const invoke = () => operation === 'models'
      ? service.capabilities()
      : service.generate(generationRequest(operation === 'edits' ? { referenceImage: 'data:image/png;base64,AA==' } : {}))
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

describe('ImageStudioService settings', () => {
  it.each([{ edit: false, hosted: false }, { edit: true, hosted: false }, { edit: false, hosted: true }, { edit: true, hosted: true }])('uses the saved model and falls back from empty base64 to URL ($edit, $hosted)', async ({ edit, hosted }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-request-'))
    roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'temporary-key', jobId: 'job', reservedCredits: 1 }))
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
    expect(edit ? body.get('model') : JSON.parse(body).model).toBe('custom-provider-model')
    expect(fetchMock.mock.calls[1][0]).toBe('https://images.example.test/result.png')
    expect(result.assets[0]).toMatchObject({ model: 'custom-provider-model', dataUrl: `data:image/png;base64,${png.toString('base64')}` })
  })

  it.each([false, true])('loads actual models with the appropriate credentials (hosted=%s)', async (hosted) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-models-'))
    roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1/', apiKey: 'temporary-key', jobId: 'job', reservedCredits: 0 }))
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
  it.each([
    { hosted: false, source: 'manual' as const }, { hosted: true, source: 'manual' as const },
    { hosted: false, source: 'agent' as const }, { hosted: true, source: 'agent' as const }
  ])('sends all references in each edit request (hosted=$hosted, source=$source)', async ({ hosted, source }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-references-')); roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'hosted-key', jobId: 'job', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(hosted ? '' : 'own-key'))
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'Aw==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await service.generate(generationRequest({ count: 2, referenceImages: ['data:image/png;base64,AA==', 'data:image/jpeg;base64,AQI='] }), source)
    expect(result.assets).toHaveLength(2)
    expect(result.credits).toBe(hosted ? 2 : 0)
    expect(await service.history()).toHaveLength(2)
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 2 : 0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toMatch(/\/images\/edits$/)
      const form = init.body as FormData
      expect(form.get('n')).toBe('1')
      expect(form.get('image')).toBeNull()
      const files = form.getAll('image[]') as File[]
      expect(files.map(file => [file.name, file.type])).toEqual([['reference-1.png', 'image/png'], ['reference-2.jpg', 'image/jpeg']])
      expect(await Promise.all(files.map(async file => [...new Uint8Array(await file.arrayBuffer())]))).toEqual([[0], [1, 2]])
    }
  })

  it('rejects a bad second reference before acquiring a lease or contacting the provider', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-invalid-reference-')); roots.push(root)
    const getHostedLease = vi.fn(); const fetchMock = vi.fn()
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(''))
    vi.stubGlobal('fetch', fetchMock)
    await expect(service.generate(generationRequest({ referenceImages: ['data:image/png;base64,AA==', 'invalid'] }))).rejects.toThrow('data URL')
    expect(getHostedLease).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discovers and executes multi-reference edits through the live workbench MCP bridge', async () => {
    const { ModMindBridge } = await import('./externalAgents')
    const { spawn } = await import('node:child_process')
    const { createInterface } = await import('node:readline')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-mcp-')); roots.push(root)
    const project = { name: 'Image references', path: root, loader: 'fabric' as const, minecraftVersion: '1.21.1', namespace: 'images', createdAt: '' }
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => root, getHostedLease: vi.fn() })
    await service.saveSettings(settings('local-test-key'))
    const originalFetch = globalThis.fetch
    const requests: FormData[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) !== 'https://images.example.test/v1/images/edits') return originalFetch(input, init)
      requests.push(init!.body as FormData)
      return new Response(JSON.stringify({ data: [{ b64_json: 'Aw==' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const noop = async () => ({})
    const handlers = {
      projectInfo: project, projectFiles: async () => ({ files: [], truncated: false }), setIntent: noop, applyEdits: noop, updateTodo: noop,
      mappingsSearch: noop, mappingsClass: noop, dependencySearch: noop, dependencyInstall: noop, contentValidate: noop,
      testMatrix: noop, releasePreflight: noop, build: noop, testMinecraft: noop, blockbenchActions: noop, runtimeState: noop,
      imageGenerate: (input: Record<string, unknown>) => service.generate(input, 'agent')
    }
    const references = ['data:image/png;base64,AA==', 'data:image/jpeg;base64,AQI=']
    for (const readOnly of [false, true]) {
      const bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly)
      const { mcpConfigPath } = await bridge.start()
      await bridge.writeMcpConfig(mcpConfigPath)
      const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
      const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      const lines = createInterface({ input: child.stdout })
      let requestId = 0
      const rpc = (method: string, params = {}): Promise<{ result: { isError?: boolean; tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; content?: Array<{ type: string; text?: string }> } }> => new Promise(resolve => {
        lines.once('line', line => resolve(JSON.parse(line)))
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })}\n`)
      })
      try {
        const listed = await rpc('tools/list')
        if (!readOnly) expect(listed.result.tools?.find(tool => tool.name === 'modmind_image_generate')?.inputSchema.properties.referenceImages).toMatchObject({ type: 'array', minItems: 1 })
        const result = await rpc('tools/call', { name: 'modmind_image_generate', arguments: { prompt: 'combine both', referenceImages: references } })
        if (readOnly) {
          expect(result.result.isError).toBe(true)
          expect(requests).toHaveLength(1)
        } else {
          expect(result.result.isError).not.toBe(true)
          expect(result.result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'Aw==' })
          expect(requests).toHaveLength(1)
          const files = requests[0].getAll('image[]') as File[]
          expect(await Promise.all(files.map(async file => [...new Uint8Array(await file.arrayBuffer())]))).toEqual([[0], [1, 2]])
          expect(await service.history()).toHaveLength(1)
          const invalid = await rpc('tools/call', { name: 'modmind_image_generate', arguments: { prompt: 'invalid', referenceImages: [references[0], 'bad'] } })
          expect(invalid.result.isError).toBe(true)
          expect(requests).toHaveLength(1)
        }
      } finally { lines.close(); child.kill(); await bridge.stop() }
    }
  }, 30000)

  it('takes two references through the service to one real multipart HTTP request', async () => {
    const { createServer } = await import('node:http')
    const sharp = (await import('sharp')).default
    const references = await Promise.all(['#ff0000', '#0000ff'].map(async background =>
      await sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer()))
    const received: Array<{ url?: string; form: FormData }> = []
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const request = new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': req.headers['content-type']! }, body: Buffer.concat(chunks) })
        received.push({ url: req.url, form: await request.formData() })
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: references[0].toString('base64') }] }))
      } catch (error) { res.writeHead(500); res.end(String(error)) }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-http-')); roots.push(root)
      const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: vi.fn() })
      const address = server.address() as import('node:net').AddressInfo
      await service.saveSettings({ ...settings('local-test-key'), baseUrl: `http://127.0.0.1:${address.port}/v1` })
      const result = await service.generate(generationRequest({ presetId: 'material-variant', referenceImages: references.map(buffer => `data:image/png;base64,${buffer.toString('base64')}`) }))
      expect(result.assets).toHaveLength(1)
      expect(received).toHaveLength(1)
      expect(received[0].url).toBe('/v1/images/edits')
      const files = received[0].form.getAll('image[]') as File[]
      expect(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer())))).toEqual(references)
      expect(await service.history()).toHaveLength(1)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it.each([false, true])('uses the same configuration and parameters for both sources (hosted=%s)', async hosted => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-parity-')); roots.push(root)
    const getHostedLease = vi.fn(async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'hosted-key', jobId: 'job', reservedCredits: 1 }))
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease })
    await service.saveSettings(settings(hosted ? '' : 'own-key'))
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const input = generationRequest({ model: 'override-model', size: '1536x1024', quality: 'high', moderation: 'low', count: 2, background: 'solid', backgroundColor: '#123456', referenceImage: 'data:image/png;base64,AA==' })
    for (const source of ['manual', 'agent'] as const) {
      const result = await service.generate(input, source)
      expect(result.assets).toHaveLength(2)
      expect(result.assets[0]).toMatchObject({ model: 'override-model', size: '1536x1024', quality: 'high', hosted })
    }
    expect(getHostedLease).toHaveBeenCalledTimes(hosted ? 4 : 0)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`https://${hosted ? 'hosted' : 'images'}.example.test/v1/images/edits`)
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${hosted ? 'hosted-key' : 'own-key'}`)
      const body = init.body as FormData
      expect(Object.fromEntries(['model', 'size', 'quality', 'moderation', 'n'].map(key => [key, body.get(key)]))).toEqual({ model: 'override-model', size: '1536x1024', quality: 'high', moderation: 'low', n: '1' })
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
    await expect(service.describe(true)).resolves.toMatchObject({ settings: { model: 'image-model' }, capabilitiesError: 'lease unavailable' })
    await service.saveSettings(settings('own-secret-key'))
    expect(JSON.stringify(await service.describe())).not.toContain('own-secret-key')
  })
})
