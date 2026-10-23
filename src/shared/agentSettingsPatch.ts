import type { AgentSettings } from './types'

type Patch<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends readonly unknown[] ? T[K]
    : NonNullable<T[K]> extends object ? Patch<NonNullable<T[K]>> | Extract<T[K], null | undefined> : T[K]
}

export type AgentSettingsPatch = Patch<AgentSettings>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge(current: unknown, patch: unknown): unknown {
  if (!record(patch)) return patch
  const result = record(current) ? { ...current } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('配置字段无效')
    if (value === undefined) delete result[key]
    else result[key] = merge(result[key], value)
  }
  return result
}

/** Undefined deletes a field; arrays and null replace it; objects update only named entries. */
export function mergeAgentSettingsPatch(current: AgentSettings, patch: AgentSettingsPatch): AgentSettings {
  if (!record(patch)) throw new Error('配置修改需要对象值')
  const allowed = new Set(['codingBackend', 'allowLongerContext', 'codexApprovalMode', 'externalAgents',
    'allowBuildScriptChanges', 'preferLocalGradle', 'gradleExecutable', 'gradleDownloadSource', 'networkProxyUrl',
    'javaPreferences', 'darkMode', 'themePreset', 'customThemeColors', 'background', 'closeBehavior', 'notificationsEnabled'])
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`不支持的配置字段：${key}`)
  return merge(current, patch) as AgentSettings
}

function difference(previous: unknown, next: unknown): unknown {
  if (!record(next)) return next
  const before = record(previous) ? previous : {}
  const result: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) result[key] = undefined
    else if (JSON.stringify(before[key]) !== JSON.stringify(next[key]) || key === 'apiKey' || key === 'clearApiKey') {
      result[key] = difference(before[key], next[key])
    }
  }
  return result
}

/** Derive changed leaves from a UI draft without sending unrelated snapshot fields. */
export function agentSettingsPatch(previous: AgentSettings, requested: Partial<AgentSettings>): AgentSettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(requested)) patch[key] = difference(previous[key as keyof AgentSettings], value)
  return patch as AgentSettingsPatch
}
