import { describe, expect, it } from 'vitest'
import type { BeginnerAiPreferences } from '../shared/types'
import {
  activeQuotaModelPreferences,
  parseStoredQuotaModelPreferences,
  quotaPreferenceKey,
  quotaProfileKey,
  resolveQuotaModelPreferences,
  updateQuotaModelPreferences
} from './quotaModelPreferences'

const defaults: BeginnerAiPreferences = { model: 'terra', reasoningLevel: 'medium', fastMode: false }

describe('quota model preferences', () => {
  it('migrates the legacy global preference format', () => {
    const store = parseStoredQuotaModelPreferences({ model: 'legacy', reasoningLevel: 'high', fastMode: true }, defaults)
    expect(store).toEqual({
      version: 2,
      current: { model: 'legacy', reasoningLevel: 'high', fastMode: true },
      profiles: {}
    })
  })

  it('restores an existing preference when a known key becomes active again', () => {
    const key = quotaPreferenceKey('https://relay.example/v1', 'key-a')
    const stored = parseStoredQuotaModelPreferences({
      version: 2,
      current: defaults,
      profiles: { [key]: { model: 'glm-4.7', reasoningLevel: 'high', fastMode: true } }
    }, defaults)
    const resolved = resolveQuotaModelPreferences(stored, key, [{ id: 'glm-4.7' }, { id: 'terra' }])
    expect(resolved.restored).toBe(true)
    expect(resolved.preferences).toEqual({ model: 'glm-4.7', reasoningLevel: 'high', fastMode: true })
  })

  it('uses a deterministic fallback without overwriting the preferred model', () => {
    const key = quotaPreferenceKey('https://relay.example/v1', 'key-b')
    const stored = parseStoredQuotaModelPreferences(defaults, defaults)
    const resolved = resolveQuotaModelPreferences(stored, key, [{ id: 'deepseek' }, { id: 'glm' }])
    expect(resolved.modelChanged).toBe(true)
    expect(resolved.preferences.model).toBe('deepseek')
    expect(activeQuotaModelPreferences(resolved.store, key).model).toBe('terra')
  })

  it('restores the paid model after a free route and key rotation without mixing accounts', () => {
    const paid = quotaProfileKey('https://site.example', 'alice', 'https://paid.example/v1')
    const free = quotaProfileKey('https://site.example', 'alice', 'https://site.example/trial/v1')
    const saved = updateQuotaModelPreferences(parseStoredQuotaModelPreferences(defaults, defaults), { ...defaults, model: 'gpt-5.6-terra' }, paid)
    const trial = resolveQuotaModelPreferences(saved, free, [{ id: 'qwen3.8-flash' }])
    const restored = resolveQuotaModelPreferences(trial.store, paid, [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-terra' }])
    expect(trial.preferences.model).toBe('qwen3.8-flash')
    expect(restored.preferences.model).toBe('gpt-5.6-terra')
    expect(paid).not.toBe(quotaProfileKey('https://site.example', 'bob', 'https://paid.example/v1'))
    expect(paid).not.toBe(quotaProfileKey('https://other.example', 'alice', 'https://paid.example/v1'))
  })

  it('does not choose an approval-only model as a fallback', () => {
    const stored = parseStoredQuotaModelPreferences(defaults, defaults)
    expect(resolveQuotaModelPreferences(stored, 'route', [{ id: 'codex-auto-review' }, { id: 'qwen' }]).preferences.model).toBe('qwen')
    expect(() => resolveQuotaModelPreferences(stored, 'route', [{ id: 'codex-auto-review' }])).toThrow('没有可用于任务')
  })

  it('updates the active key profile after a manual preference change', () => {
    const key = quotaPreferenceKey('https://relay.example/v1', 'key-c')
    const stored = parseStoredQuotaModelPreferences(defaults, defaults)
    const next = { model: 'manual', reasoningLevel: 'extreme', fastMode: true } as const
    const updated = updateQuotaModelPreferences(stored, next, key)
    expect(updated.current).toEqual(next)
    expect(updated.profiles[key]).toEqual(next)
  })
})
