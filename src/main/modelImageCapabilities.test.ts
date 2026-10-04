import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { explicitlyRejectsImageInput, ModelImageCapabilities } from './modelImageCapabilities'
import { parseModelPayload } from './deviceIntegration'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const observation = { baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'private-alias', protocol: 'responses' as const, status: 200, completed: true }

describe('image capability evidence', () => {
  it('keeps exact endpoint/account/model evidence isolated, persists without credentials and expires', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-capabilities-')); roots.push(root)
    const file = () => path.join(root, 'cache.json')
    let now = 1000
    const store = new ModelImageCapabilities(file, () => now)
    expect(store.resolve(observation.baseUrl, observation.apiKey, observation.model).status).toBe('unknown')
    await store.observe(observation)
    const restored = new ModelImageCapabilities(file, () => now)
    await restored.load()
    expect(restored.resolve(observation.baseUrl + '/', 'secret', 'private-alias')).toMatchObject({ status: 'supported', source: 'request' })
    for (const [baseUrl, apiKey, model] of [
      ['https://relay.example/v2', 'secret', 'private-alias'], ['https://other.example/v1', 'secret', 'private-alias'],
      ['https://relay.example/v1?deployment=other', 'secret', 'private-alias'], [observation.baseUrl, 'other-key', 'private-alias'],
      [observation.baseUrl, 'secret', 'private-alias-new']
    ]) expect(restored.resolve(baseUrl, apiKey, model).status).toBe('unknown')
    const saved = await fs.readFile(file(), 'utf8')
    expect(saved).not.toContain('secret'); expect(saved).not.toContain('relay.example')
    now += 24 * 60 * 60_000
    expect(restored.resolve(observation.baseUrl, 'secret', 'private-alias').status).toBe('unknown')
  })
  it('lets actual image requests supersede provider declarations and supports later recovery', async () => {
    const store = new ModelImageCapabilities()
    const models = parseModelPayload({ data: [{ id: observation.model, input_modalities: ['text'] }, { id: 'opaque' }] })
    expect((await store.enrich(models, observation.baseUrl, 'secret'))[0].imageInput?.status).toBe('unknown') // sorted opaque first
    expect(store.resolve(observation.baseUrl, 'secret', observation.model).source).toBe('provider')
    await store.observe(observation)
    expect((await store.enrich(models, observation.baseUrl, 'secret')).find(model => model.id === observation.model)?.imageInput).toMatchObject({ status: 'supported', source: 'request' })
    await store.observe({ ...observation, status: 400, completed: false, errorBody: JSON.stringify({ error: { message: 'This model does not support image input' } }) })
    expect(store.resolve(observation.baseUrl, 'secret', observation.model).status).toBe('unsupported')
    await store.observe(observation)
    expect(store.resolve(observation.baseUrl, 'secret', observation.model).status).toBe('supported')
  })
  it('clears old provider metadata when the latest scan has no image declaration', async () => {
    const store = new ModelImageCapabilities()
    await store.enrich([{ id: 'alias', imageInput: { status: 'supported', source: 'provider' } }], observation.baseUrl, 'secret')
    await store.enrich([{ id: 'alias' }], observation.baseUrl, 'secret')
    expect(store.resolve(observation.baseUrl, 'secret', 'alias').status).toBe('unknown')
  })
  it('never converts authentication, quota, malformed images or incomplete responses into no-vision evidence', async () => {
    const store = new ModelImageCapabilities()
    for (const error of [
      { status: 401, message: 'model does not support image input' }, { status: 429, message: 'image quota exhausted' },
      { status: 500, message: 'model does not support image input' }, { status: 404, message: 'model not found' },
      { status: 400, message: 'unsupported image format' }, { status: 400, message: 'image_detail original is not supported' },
      { status: 400, message: 'Invalid image URL' }, { status: 400, message: 'unsupported parameter: temperature' },
      { status: 400, message: 'This endpoint only supports text/plain' }
    ]) await store.observe({ ...observation, status: error.status, completed: false, errorBody: JSON.stringify({ error: { message: error.message } }) })
    await store.observe({ ...observation, completed: false })
    expect(store.resolve(observation.baseUrl, 'secret', observation.model).status).toBe('unknown')
  })
  it.each(['This model does not support image input', 'Image input is not supported', 'Unsupported image input', '模型不支持图片输入'])('recognizes explicit lack of image support: %s', message => {
    expect(explicitlyRejectsImageInput(400, JSON.stringify({ error: { message } }))).toBe(true)
  })
  it('bounds the cache and discards corrupt records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-capabilities-')); roots.push(root)
    const file = () => path.join(root, 'cache.json')
    await fs.writeFile(file(), '{broken')
    const store = new ModelImageCapabilities(file)
    await store.load()
    await store.enrich(Array.from({ length: 510 }, (_, i) => ({ id: `model-${i}`, imageInput: { status: 'supported' as const, source: 'provider' as const } })), observation.baseUrl, 'secret')
    expect(store.resolve(observation.baseUrl, 'secret', 'model-0').status).toBe('unknown')
    expect(store.resolve(observation.baseUrl, 'secret', 'model-509').status).toBe('supported')
    expect((await fs.stat(file())).size).toBeLessThan(128 * 1024)
    expect(JSON.parse(await fs.readFile(file(), 'utf8')).entries).toHaveLength(500)
  })
})
