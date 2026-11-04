import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelReasoningCatalog, retryDelayMs } from './modelReasoningCatalog'
import { parseModelPayload } from './deviceIntegration'
import { parseReasoningCapabilities, reasoningSelectionEffort } from '../shared/modelReasoning'
import { buildReasoningRegistry } from '../shared/modelReasoningRegistry'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('reasoning capability discovery', () => {
  it('exposes the exact supported levels for current models without inheriting future efforts', () => {
    const catalog = new ModelReasoningCatalog()
    expect(catalog.resolve('gpt-6-sol').efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(catalog.resolve('gpt-6-luna').efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(catalog.resolve('gpt-6-astra').efforts).not.toContain('ultra')
    expect(catalog.resolve('gpt-7-sol').source).toBe('unknown')
    expect(catalog.resolve('my-gpt-6-sol').source).toBe('unknown')
  })

  it('retains explicit upstream capabilities and does not overwrite a disabled model', () => {
    const catalog = new ModelReasoningCatalog()
    const scanned = parseModelPayload({ data: [
      { id: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }, { effort: 'ultra' }] },
      { id: 'gpt-6-luna', reasoning: false }
    ] })
    const models = catalog.enrich(scanned, 'https://private.example/v1')
    expect(models.find(m => m.id === 'gpt-6-sol')?.reasoning).toMatchObject({ source: 'provider', efforts: ['none', 'high', 'ultra'] })
    expect(reasoningSelectionEffort('ultra', models.find(m => m.id === 'gpt-6-sol')?.reasoning)).toBe('ultra')
    expect(models.find(m => m.id === 'gpt-6-luna')?.reasoning).toMatchObject({ supported: false, efforts: [] })
  })

  it('distinguishes budgets and toggles from discrete effort levels', () => {
    expect(parseReasoningCapabilities({ reasoning: true })).toBeUndefined()
    const capabilities = parseReasoningCapabilities({ reasoning_options: [{ type: 'budget_tokens', min: 128, max: 32768 }, { type: 'toggle' }] })
    expect(capabilities).toMatchObject({ efforts: [], controls: ['toggle', 'budget_tokens'], budgetTokens: { min: 128, max: 32768 } })
    expect(() => reasoningSelectionEffort('high', capabilities)).toThrow('未确认支持')
    expect(reasoningSelectionEffort('auto', capabilities)).toBeUndefined()
    expect(reasoningSelectionEffort('none', parseReasoningCapabilities({ supported_reasoning_efforts: ['none', 'low'] }))).toBe('none')
  })

  it('prefers an exact provider endpoint and does not trust a lookalike host', () => {
    const registry = buildReasoningRegistry({
      openai: { api: 'https://api.openai.com/v1', models: { 'gpt-6-sol': { supported_reasoning_efforts: ['none', 'low', 'high'] } } },
      reseller: { api: 'https://relay.example/v1', models: { 'gpt-6-sol': { supported_reasoning_efforts: ['high'] } } }
    })
    const catalog = new ModelReasoningCatalog(registry)
    expect(catalog.resolve('gpt-6-sol', 'https://relay.example/v1').efforts).toEqual(['high'])
    expect(catalog.resolve('gpt-6-sol', 'https://relay.example.evil/v1').efforts).toEqual(['none', 'low', 'high'])
  })

  it('refreshes public capabilities without model requests, shares scans, and keeps the last good data offline', async () => {
    const models = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`new-${i}`, { supported_reasoning_efforts: ['low', 'max'] }]))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ test: { models } })))
      .mockRejectedValueOnce(new Error('offline'))
    const catalog = new ModelReasoningCatalog(buildReasoningRegistry({}), fetcher)
    await Promise.all([catalog.refresh(), catalog.refresh()])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(catalog.resolve('new-1').efforts).toEqual(['low', 'max'])
    await catalog.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await catalog.refresh(true)
    expect(catalog.resolve('new-1').efforts).toEqual(['low', 'max'])
    expect(fetcher.mock.calls.every(([url]) => url === 'https://models.dev/api.json')).toBe(true)
  })
})

describe('published context ceilings', () => {
  const registry = buildReasoningRegistry({
    openai: { api: 'https://api.openai.com/v1', models: {
      'gpt-6-sol': { supported_reasoning_efforts: ['low'], modalities: { input: ['text'], output: ['text'] }, limit: { context: 1050000, input: 922000, output: 128000 } },
      'image-only': { modalities: { input: ['image'], output: ['text'] }, limit: { context: 999999 } },
      'no-context': { modalities: { input: ['text'], output: ['text'] } }
    } },
    reseller: { api: 'https://relay.example/v1', models: {
      'gpt-6-sol': { modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64000 } }
    } }
  })

  it('keeps only text-to-text models that publish a total context', () => {
    const catalog = new ModelReasoningCatalog(registry)
    expect(catalog.resolveContextLimits('image-only')).toEqual([])
    expect(catalog.resolveContextLimits('no-context')).toEqual([])
    expect(catalog.resolveContextLimits('missing')).toEqual([])
  })

  it('prefers the serving endpoint and never matches a lookalike host', () => {
    const catalog = new ModelReasoningCatalog(registry)
    expect(catalog.resolveContextLimits('gpt-6-sol', 'https://relay.example/v1')).toEqual([[200000, null, 64000, 0]])
    expect(catalog.resolveContextLimits('gpt-6-sol', 'https://api.openai.com/v1')).toEqual([[1050000, 922000, 128000, 0]])
    expect(catalog.resolveContextLimits('gpt-6-sol', 'https://api.openai.com.evil.example/v1')).toHaveLength(2)
  })

  it('falls back to every publisher when no endpoint matches', () => {
    const catalog = new ModelReasoningCatalog(registry)
    expect(catalog.resolveContextLimits('gpt-6-sol')).toEqual([[1050000, 922000, 128000, 0], [200000, null, 64000, 0]])
    expect(catalog.resolveContextLimits('gpt-6-sol', 'https://unrelated.example/v1')).toHaveLength(2)
  })

  it('does not resolve inherited or absent keys', () => {
    const catalog = new ModelReasoningCatalog(registry)
    expect(catalog.resolveContextLimits('__proto__')).toEqual([])
    expect(catalog.resolveContextLimits('constructor')).toEqual([])
    expect(catalog.resolveContextLimits('toString')).toEqual([])
  })

  it('reports no ceilings at all until a refresh has published them', () => {
    expect(new ModelReasoningCatalog().resolveContextLimits('gpt-6-sol')).toEqual([])
  })
})

describe('refresh scheduling', () => {
  it('retries a forced refresh after a failure instead of swallowing it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const catalog = new ModelReasoningCatalog(buildReasoningRegistry({}), fetcher)
    await catalog.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await catalog.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await catalog.refresh(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially and caps the wait', () => {
    expect(retryDelayMs(0)).toBe(60_000)
    expect(retryDelayMs(1)).toBe(120_000)
    expect(retryDelayMs(2)).toBe(240_000)
    expect(retryDelayMs(3)).toBe(480_000)
    expect(retryDelayMs(20)).toBe(6 * 60 * 60_000)
  })

  it('reuses the persisted payload across instances and keeps the last good data when offline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-reasoning-cache-'))
    roots.push(root)
    const models = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`new-${i}`, { supported_reasoning_efforts: ['low', 'max'] }]))
    const online = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ test: { models } })))
    const first = new ModelReasoningCatalog(buildReasoningRegistry({}), online)
    first.configureCachePath(root)
    await first.refresh(true)
    expect(await fs.readdir(root)).toEqual(['models-dev-api.json'])

    // A fresh instance adopts the cached payload without any network access.
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const second = new ModelReasoningCatalog(buildReasoningRegistry({}), offline)
    second.configureCachePath(root)
    await second.refresh()
    expect(offline).not.toHaveBeenCalled()
    expect(second.resolve('new-1').efforts).toEqual(['low', 'max'])

    // Past the TTL a failed refresh still adopts the stale payload rather than losing the catalog.
    const stale = path.join(root, 'models-dev-api.json')
    const past = new Date(Date.now() - 7 * 60 * 60 * 1000)
    await fs.utimes(stale, past, past)
    const third = new ModelReasoningCatalog(buildReasoningRegistry({}), offline)
    third.configureCachePath(root)
    await third.refresh(true)
    expect(offline).toHaveBeenCalledTimes(1)
    expect(third.resolve('new-1').efforts).toEqual(['low', 'max'])
  })

  it('does not touch the disk when no cache path was configured', async () => {
    const models = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`new-${i}`, { supported_reasoning_efforts: ['low'] }]))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ test: { models } })))
    const catalog = new ModelReasoningCatalog(buildReasoningRegistry({}), fetcher)
    await catalog.refresh(true)
    expect(catalog.resolve('new-1').efforts).toEqual(['low'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
