import { describe, expect, it } from 'vitest'
import registry from './modelContextRegistry.json'
import { resolveModelContextBudget } from './modelContextRegistry'
import { normalizeModelContextWindows } from '../shared/modelContext'

describe('offline model context registry', () => {
  it('covers historical and current models without assigning all of them 512K', () => {
    expect(resolveModelContextBudget('gpt-4-0314').contextWindow).toBe(8192)
    expect(resolveModelContextBudget('deepseek-v4-flash').contextWindow).toBe(1_000_000)
    expect(resolveModelContextBudget('google/gemini-2.5-pro').contextWindow).toBeGreaterThanOrEqual(1_000_000)
    expect(resolveModelContextBudget('deepseek-v4-flash').autoCompactTokenLimit).toBeGreaterThan(400_000)
  })

  it('uses endpoint-specific limits and never matches a lookalike hostname', () => {
    for (const [provider, record] of Object.entries(registry.providers)) {
      if (!('api' in record)) continue
      for (const [model, limits] of Object.entries(record.models)) {
        const budget = resolveModelContextBudget(model, { baseUrl: record.api + '/responses' })
        expect(budget.source, `${provider}/${model}`).toBe('provider')
        expect(budget.contextWindow).toBeLessThanOrEqual(limits[0]!)
      }
    }
    expect(resolveModelContextBudget('deepseek-v4-flash', { baseUrl: 'https://api.deepseek.com.evil.example' }).source).toBe('registry')
  })

  it('keeps arbitrary aliases, dated names, free suffixes and namespaces distinct', () => {
    for (const id of ['my-deepseek-v4-flash', 'deepseek-v4-flash-2099-01-01', 'private/deepseek-v4-flash', 'deepseek-v4-flash:unknown', '__proto__/model', 'constructor/model']) {
      expect(resolveModelContextBudget(id).source).toBe('fallback')
    }
    expect(resolveModelContextBudget('private/deepseek-v4-flash', { contextWindow: 65536 }).contextWindow).toBe(65536)
  })

  it('keeps compaction below input and context limits with reserved output space', () => {
    for (const provider of Object.values(registry.providers)) for (const [id, [context, input]] of Object.entries(provider.models)) {
      const result = resolveModelContextBudget(id, 'api' in provider ? { baseUrl: provider.api } : {})
      expect(Number.isSafeInteger(result.contextWindow)).toBe(true)
      expect(result.autoCompactTokenLimit).toBeLessThan(result.contextWindow)
      // Global resolution may prefer explicit context over an input-only legacy source.
      if (result.source === 'provider') expect(result.autoCompactTokenLimit).toBeLessThanOrEqual(Math.min(context!, input ?? context!))
    }
  })

  it('validates overrides and keeps them tied to exact model IDs', () => {
    expect(normalizeModelContextWindows({ a: 65536, b: -1, c: Infinity, d: '512000' })).toEqual({ a: 65536 })
    expect(normalizeModelContextWindows({ a: 512, b: 100000001 })).toBeUndefined()
    for (const contextWindow of [0, -1, NaN, Infinity, 1.5, 100000001]) expect(() => resolveModelContextBudget('a', { contextWindow })).toThrow()
  })
})
