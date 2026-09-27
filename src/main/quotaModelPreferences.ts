import { createHash } from 'node:crypto'
import { beginnerReasoningLevelFor, migrateLegacyReasoningLevel } from '../shared/aiPreferences'
import { isReasoningEffort, normalizeReasoningEffortOptions, selectedReasoningEfforts } from '../shared/modelReasoning'
import { normalizeModelAutoCompactTokenLimits, normalizeModelContextWindows } from '../shared/modelContext'
import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel } from '../shared/types'

export interface StoredQuotaModelPreferences {
  version: 3
  current: BeginnerAiPreferences
  profiles: Record<string, BeginnerAiPreferences>
}

type LegacyPreferences = Partial<BeginnerAiPreferences> & { reasoningEffort?: unknown }

function reasoningLevel(value: unknown, model: string, legacyEffort: unknown, fallback: BeginnerReasoningLevel): BeginnerReasoningLevel {
  if (value === 'auto' || isReasoningEffort(value)) return value
  if (legacyEffort !== undefined) return beginnerReasoningLevelFor(model, legacyEffort)
  return fallback
}

export function normalizeQuotaModelPreferences(value: unknown, fallback: BeginnerAiPreferences): BeginnerAiPreferences {
  const record = value && typeof value === 'object' ? value as LegacyPreferences : {}
  const model = typeof record.model === 'string' && record.model.trim()
    ? record.model.trim().slice(0, 256)
    : fallback.model
  const modelContextWindows = normalizeModelContextWindows(record.modelContextWindows)
  const modelAutoCompactTokenLimits = normalizeModelAutoCompactTokenLimits(record.modelAutoCompactTokenLimits)
  const reasoningEffortOptions = normalizeReasoningEffortOptions(record.reasoningEffortOptions)
  const selectedLevel = reasoningLevel(record.reasoningLevel, model, record.reasoningEffort, fallback.reasoningLevel)
  return {
    model,
    reasoningLevel: selectedLevel === 'auto' || selectedReasoningEfforts(model, reasoningEffortOptions).includes(selectedLevel) ? selectedLevel : 'auto',
    fastMode: typeof record.fastMode === 'boolean' ? record.fastMode : fallback.fastMode,
    ...(modelContextWindows ? { modelContextWindows } : {}),
    ...(modelAutoCompactTokenLimits ? { modelAutoCompactTokenLimits } : {}),
    ...(reasoningEffortOptions ? { reasoningEffortOptions } : {})
  }
}

export function parseStoredQuotaModelPreferences(value: unknown, defaults: BeginnerAiPreferences): StoredQuotaModelPreferences {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const read = (value: unknown): BeginnerAiPreferences => {
    const normalized = normalizeQuotaModelPreferences(value, defaults)
    if (record.version === 3) return normalized
    const old = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const migrated = old.reasoningEffort !== undefined
      ? beginnerReasoningLevelFor(normalized.model, old.reasoningEffort)
      : migrateLegacyReasoningLevel(normalized.model, old.reasoningLevel)
    return { ...normalized, reasoningLevel: migrated === 'auto' || selectedReasoningEfforts(normalized.model, normalized.reasoningEffortOptions).includes(migrated) ? migrated : 'auto' }
  }
  if ((record.version === 2 || record.version === 3) && record.current && typeof record.current === 'object') {
    const current = read(record.current)
    const profiles: Record<string, BeginnerAiPreferences> = {}
    if (record.profiles && typeof record.profiles === 'object') {
      for (const [key, profile] of Object.entries(record.profiles as Record<string, unknown>)) {
        if (/^[a-f0-9]{24}$/.test(key)) profiles[key] = read(profile)
      }
    }
    return { version: 3, current, profiles }
  }
  return { version: 3, current: read(value), profiles: {} }
}

export function quotaPreferenceKey(baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(`${baseUrl.trim()}\n${apiKey.trim()}`).digest('hex').slice(0, 24)
}

export function quotaProfileKey(siteUrl: string, username: string, baseUrl: string): string {
  return createHash('sha256').update(JSON.stringify([siteUrl, username, baseUrl])).digest('hex').slice(0, 24)
}

export function activeQuotaModelPreferences(store: StoredQuotaModelPreferences, preferenceKey?: string): BeginnerAiPreferences {
  if (!preferenceKey) return store.current
  if (store.profiles[preferenceKey]) return store.profiles[preferenceKey]
  // A new route can reuse model choices, but not another deployment's limits.
  const { modelContextWindows: _windows, modelAutoCompactTokenLimits: _compactLimits, reasoningEffortOptions: _reasoningOptions, ...preferences } = store.current
  return preferences
}

export function resolveQuotaModelPreferences(
  store: StoredQuotaModelPreferences,
  preferenceKey: string,
  models: AiModelInfo[]
): { store: StoredQuotaModelPreferences; preferences: BeginnerAiPreferences; modelChanged: boolean; restored: boolean } {
  const restored = Boolean(store.profiles[preferenceKey])
  const preferred = activeQuotaModelPreferences(store, preferenceKey)
  const ids = models.map((model) => model.id).filter(id => !/auto[-_]?review/i.test(id))
  if (models.length && !ids.length) throw new Error('当前线路没有可用于任务的模型')
  const defaultModel = ['gpt-5.6-terra', 'gpt-5.6-sol'].find(id => ids.includes(id)) ?? ids[0]
  const model = ids.length && !ids.includes(preferred.model) ? defaultModel! : preferred.model
  const preferences = { ...preferred, model, ...(model !== preferred.model ? { reasoningLevel: 'auto' as const } : {}) }
  return {
    store: { version: 3, current: preferences, profiles: { ...store.profiles, [preferenceKey]: preferred } },
    preferences,
    modelChanged: model !== preferred.model,
    restored
  }
}

export function updateQuotaModelPreferences(
  store: StoredQuotaModelPreferences,
  preferences: BeginnerAiPreferences,
  preferenceKey?: string
): StoredQuotaModelPreferences {
  return {
    version: 3,
    current: preferences,
    profiles: preferenceKey ? { ...store.profiles, [preferenceKey]: preferences } : store.profiles
  }
}
