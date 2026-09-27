import { describe, expect, it, vi } from 'vitest'
import { ModelReasoningCatalog } from './modelReasoningCatalog'
import { parseModelPayload } from './deviceIntegration'
import { parseReasoningCapabilities, reasoningSelectionEffort } from '../shared/modelReasoning'
import { buildReasoningRegistry } from '../shared/modelReasoningRegistry'

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
