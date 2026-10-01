import { describe, expect, it } from 'vitest'
import type { BeginnerAiPreferences } from '../shared/types'
import { DEFAULT_CODEX_REASONING_EFFORTS, selectedReasoningEfforts } from '../shared/modelReasoning'
import {
  activeQuotaModelPreferences,
  normalizeQuotaModelPreferences,
  parseStoredQuotaModelPreferences,
  quotaPreferenceKey,
  quotaProfileKey,
  resolveQuotaModelPreferences,
  updateQuotaModelPreferences
} from './quotaModelPreferences'

const defaults: BeginnerAiPreferences = { model: 'terra', reasoningLevel: 'medium', fastMode: false }

describe('quota model preferences', () => {
  it('migrates old labels once and retains literal choices in the new format', () => {
    const legacy = { version: 2, current: { model: 'gpt-5.6-sol', reasoningLevel: 'low', fastMode: false }, profiles: {} }
    const migrated = parseStoredQuotaModelPreferences(legacy, defaults)
    expect(migrated.current.reasoningLevel).toBe('medium')
    expect(parseStoredQuotaModelPreferences(JSON.parse(JSON.stringify(migrated)), defaults)).toEqual(migrated)
    expect(parseStoredQuotaModelPreferences(null, { ...defaults, reasoningLevel: 'auto' }).current.reasoningLevel).toBe('auto')
  })
  it('persists context overrides per model and route and supports restoring automatic limits', () => {
    const first = quotaProfileKey('https://site.example', 'alice', 'https://first.example/v1')
    const second = quotaProfileKey('https://site.example', 'alice', 'https://second.example/v1')
    const preferences = normalizeQuotaModelPreferences({ ...defaults, modelContextWindows: { terra: 1048576, sol: 524288, invalid: -1 }, modelAutoCompactTokenLimits: { terra: 800000, sol: 200000, invalid: -1 } }, defaults)
    const saved = updateQuotaModelPreferences(parseStoredQuotaModelPreferences(defaults, defaults), preferences, first)
    const reloaded = parseStoredQuotaModelPreferences(JSON.parse(JSON.stringify(saved)), defaults)
    expect(activeQuotaModelPreferences(reloaded, first).modelContextWindows).toEqual({ terra: 1048576, sol: 524288 })
    expect(activeQuotaModelPreferences(reloaded, first).modelAutoCompactTokenLimits).toEqual({ terra: 800000, sol: 200000 })
    const changed = resolveQuotaModelPreferences(reloaded, first, [{ id: 'sol' }]).preferences
    expect(changed.modelContextWindows?.[changed.model]).toBe(524288)
    expect(changed.modelAutoCompactTokenLimits?.[changed.model]).toBe(200000)
    expect(resolveQuotaModelPreferences(reloaded, second, [{ id: 'terra' }]).preferences.modelContextWindows).toBeUndefined()
    expect(resolveQuotaModelPreferences(reloaded, second, [{ id: 'terra' }]).preferences.modelAutoCompactTokenLimits).toBeUndefined()
    const automatic = normalizeQuotaModelPreferences({ ...preferences, modelContextWindows: {} }, preferences)
    expect(automatic.modelContextWindows).toBeUndefined()
    const automaticCompaction = normalizeQuotaModelPreferences({ ...preferences, modelAutoCompactTokenLimits: {} }, preferences)
    expect(automaticCompaction.modelAutoCompactTokenLimits).toBeUndefined()
    expect(automaticCompaction.modelContextWindows).toEqual(preferences.modelContextWindows)
  })

  it('keeps five selectable efforts per model and isolates them by route', () => {
    const first = quotaProfileKey('https://site.example', 'alice', 'https://first.example/v1')
    const second = quotaProfileKey('https://site.example', 'alice', 'https://second.example/v1')
    const options = { terra: ['low', 'medium', 'high', 'max', 'ultra'], sol: ['none', 'low', 'medium', 'high', 'ultra'] }
    const preference = normalizeQuotaModelPreferences({ ...defaults, reasoningEffortOptions: options }, defaults)
    const stored = updateQuotaModelPreferences(parseStoredQuotaModelPreferences(defaults, defaults), preference, first)
    const reloaded = parseStoredQuotaModelPreferences(JSON.parse(JSON.stringify(stored)), defaults)
    expect(selectedReasoningEfforts('terra', activeQuotaModelPreferences(reloaded, first).reasoningEffortOptions)).toEqual(options.terra)
    expect(selectedReasoningEfforts('sol', activeQuotaModelPreferences(reloaded, first).reasoningEffortOptions)).toEqual(options.sol)
    expect(activeQuotaModelPreferences(reloaded, second).reasoningEffortOptions).toBeUndefined()
    expect(selectedReasoningEfforts('terra', activeQuotaModelPreferences(reloaded, second).reasoningEffortOptions)).toEqual(DEFAULT_CODEX_REASONING_EFFORTS)
    expect(normalizeQuotaModelPreferences({ ...preference, reasoningLevel: 'xhigh' }, defaults).reasoningLevel).toBe('auto')
    expect(normalizeQuotaModelPreferences({ ...preference, reasoningLevel: 'max' }, defaults).reasoningLevel).toBe('max')
  })

  it('migrates the legacy global preference format', () => {
    const store = parseStoredQuotaModelPreferences({ model: 'legacy', reasoningLevel: 'high', fastMode: true }, defaults)
    expect(store).toEqual({
      version: 3,
      current: { model: 'legacy', reasoningLevel: 'max', fastMode: true },
      profiles: {}
    })
  })

  it('restores an existing preference when a known key becomes active again', () => {
    const key = quotaPreferenceKey('https://relay.example/v1', 'key-a')
    const stored = parseStoredQuotaModelPreferences({
      version: 3,
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
    const next = { model: 'manual', reasoningLevel: 'max', fastMode: true } as const
    const updated = updateQuotaModelPreferences(stored, next, key)
    expect(updated.current).toEqual(next)
    expect(updated.profiles[key]).toEqual(next)
  })
})
