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

describe('ImageStudioService settings', () => {
  it.each([{ edit: false, hosted: false }, { edit: true, hosted: false }, { edit: false, hosted: true }, { edit: true, hosted: true }])('uses the saved model and falls back from empty base64 to URL ($edit, $hosted)', async ({ edit, hosted }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-request-'))
    roots.push(root)
    const service = new ImageStudioService({ userDataDir: root, projectRoot: () => null, getHostedLease: async () => ({ baseUrl: 'https://hosted.example.test/v1', apiKey: 'temporary-key', jobId: 'job', reservedCredits: 1 }) })
    await service.saveSettings({ ...settings(hosted ? '' : 'test-key'), model: 'custom-provider-model' })
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: '', url: 'https://images.example.test/result.png' }] })))
      .mockResolvedValueOnce(new Response(new Uint8Array(png)))
    vi.stubGlobal('fetch', fetchMock)
    const request: ImageGenerationRequest = { prompt: 'A cat', style: 'free', size: '1024x1024', quality: 'low', moderation: 'auto', count: 1, background: 'auto', backgroundColor: '#ffffff', removeBackground: false, source: 'manual', ...(edit ? { referenceImage: `data:image/png;base64,${png.toString('base64')}` } : {}) }
    const result = await service.generate(request)
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
