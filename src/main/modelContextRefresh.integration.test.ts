import { beforeAll, describe, expect, it, vi } from 'vitest'

// The runtime catalog is a module singleton, so the transport is replaced before it is built.
const transport = vi.hoisted(() => ({ payload: {} as unknown, offline: false }))
vi.mock('./networkRequest', () => ({
  networkFetch: vi.fn(async () => {
    if (transport.offline) throw new Error('offline')
    return new Response(JSON.stringify(transport.payload))
  })
}))

import builtinCatalog from './codexBuiltinModels.json'
import { buildCodexModelCatalog } from './codexModelCatalog'
import { modelReasoningCatalog } from './modelReasoningCatalog'
import { resolveModelContextBudget, UNKNOWN_MODEL_CONTEXT } from './modelContextRegistry'

function upstream(): unknown {
  const models: Record<string, unknown> = {}
  for (let i = 0; i < 1000; i++) models[`filler-${i}`] = { supported_reasoning_efforts: ['low'] }
  // A native entry whose bundled window disagrees with what the provider publishes now.
  models['gpt-6-astra'] = { supported_reasoning_efforts: ['low'], modalities: { input: ['text'], output: ['text'] }, limit: { context: 999000, input: 900000, output: 128000 } }
  // Published upstream but absent from the bundled snapshot.
  models['live-only-model'] = { modalities: { input: ['text'], output: ['text'] }, limit: { context: 409600 } }
  return { openai: { api: 'https://api.openai.com/v1', models } }
}

beforeAll(async () => {
  transport.payload = upstream()
  await modelReasoningCatalog.refresh(true)
})

describe('refreshed context ceilings', () => {
  it('prefers the refreshed limits over the bundled snapshot and labels the source', () => {
    expect(resolveModelContextBudget('gpt-6-astra', { baseUrl: 'https://api.openai.com/v1' })).toMatchObject({ source: 'catalog', contextWindow: 999000 })
    expect(resolveModelContextBudget('gpt-6-astra')).toMatchObject({ source: 'catalog', contextWindow: 999000 })
  })

  it('gives a model that only exists upstream a real window instead of the fallback', () => {
    const budget = resolveModelContextBudget('live-only-model')
    expect(budget.source).toBe('catalog')
    expect(budget.contextWindow).toBe(409600)
    expect(budget.contextWindow).not.toBe(UNKNOWN_MODEL_CONTEXT)
  })

  it('keeps an explicit override above the refreshed limits', () => {
    expect(resolveModelContextBudget('gpt-6-astra', { baseUrl: 'https://api.openai.com/v1', contextWindow: 65536 }))
      .toMatchObject({ source: 'override', contextWindow: 65536 })
  })

  it('customizes a native entry from refreshed limits instead of keeping its bundled window', () => {
    const native = builtinCatalog.models.find(model => model.slug === 'gpt-6-astra')!
    expect(native.context_window).not.toBe(999000)
    const entry = buildCodexModelCatalog('gpt-6-astra', { baseUrl: 'https://api.openai.com/v1' })!.models.at(-1)!
    expect(entry).toMatchObject({ slug: 'gpt-6-astra', context_window: 999000, max_context_window: 999000 })
    expect(entry.auto_compact_token_limit).toBeLessThan(999000)
  })
})
