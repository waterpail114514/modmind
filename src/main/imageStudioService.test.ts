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
