import { describe, expect, it } from 'vitest'
import { parseProviderGroups, parseProviderModels, providerModelGroups } from './providerRoutes'

describe('upstream provider routes', () => {
  it('accepts exact upstream group IDs and new models, deduplicating and excluding non-chat IDs', () => {
    expect(parseProviderGroups([{ id: '25', label: '稳定组', models: ['future-chat-2030', { id: 'future-chat-2030' }, 'gpt-image-2', 'codex-auto-review'] }, { id: '25', label: 'duplicate' }, { id: '\ninvalid' }]))
      .toEqual([{ id: '25', label: '稳定组', models: ['future-chat-2030'] }])
    expect(parseProviderModels(undefined)).toBeUndefined()
    expect(parseProviderGroups([{ id: '75' }])).toEqual([{ id: '75', label: '75' }])
  })
  it('gives server model declarations priority over legacy mappings, including an empty list', () => {
    const groups = parseProviderGroups([{ id: 'Gemini', models: [] }, { id: '74', label: 'Grok', models: ['new-model'] }])
    expect(providerModelGroups('secondary', groups).map(g => g.models)).toEqual([[], ['new-model']])
  })
  it('only applies the old supplier-two mapping to supplier two', () => {
    const groups = parseProviderGroups([{ id: 'Gemini' }, { id: '75', label: 'Kimi' }])
    expect(providerModelGroups('secondary', groups)[0].models).toContain('gemini-3.8-flash')
    expect(providerModelGroups('secondary', groups)[1].models).toContain('kimi-k3')
    expect(providerModelGroups('ls', groups).map(g => g.models)).toEqual([[], []])
    expect(providerModelGroups('primary', groups).map(g => g.models)).toEqual([[], []])
  })
  it('bounds groups and models without allowing control characters in IDs', () => {
    expect(parseProviderGroups(Array.from({ length: 120 }, (_, i) => ({ id: String(i) })))).toHaveLength(100)
    expect(parseProviderModels(Array.from({ length: 600 }, (_, i) => `new-model-${i}`))).toHaveLength(512)
  })
})
