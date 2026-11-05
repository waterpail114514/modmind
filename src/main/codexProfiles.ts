import { sameApiBaseUrl } from '../shared/apiConnection'
import { normalizeModelAutoCompactTokenLimits, normalizeModelContextWindows } from '../shared/modelContext'
import { isReasoningEffort, normalizeReasoningEffortOptions, selectedReasoningEfforts } from '../shared/modelReasoning'
import type { AgentSettings, CodexProfile, CodexProfileInput, ExternalAgentConfiguration } from '../shared/types'
import { validateCodexAutoCompactTokenLimit } from './codexModelCatalog'

interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export function normalizeCodexProfile(input: CodexProfileInput, strict = true): CodexProfile {
  if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) throw new Error('连接档案 id 无效')
  if (typeof input.name !== 'string' || typeof input.baseUrl !== 'string' || typeof input.model !== 'string') throw new Error('连接档案字段无效')
  let baseUrl = input.baseUrl.trim()
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址必须为不含账号密码的 HTTP(S) 地址')
      baseUrl = url.toString().replace(/\/$/, '')
    } catch (error) { if (strict) throw error }
  }
  const options = normalizeReasoningEffortOptions(input.reasoningEffortOptions)
  return {
    id: input.id, name: input.name.trim().slice(0, 256) || '未命名连接',
    mode: input.mode === 'local' ? 'local' : 'hosted', baseUrl, model: input.model.trim().slice(0, 512),
    modelContextWindows: normalizeModelContextWindows(input.modelContextWindows),
    declaredModelContextWindows: normalizeModelContextWindows(input.declaredModelContextWindows),
    declaredModelContextInputTokens: normalizeModelContextWindows(input.declaredModelContextInputTokens),
    declaredModelContextOutputTokens: normalizeModelContextWindows(input.declaredModelContextOutputTokens),
    modelAutoCompactTokenLimits: normalizeModelAutoCompactTokenLimits(input.modelAutoCompactTokenLimits),
    reasoningEffortOptions: options,
    reasoningEffort: isReasoningEffort(input.reasoningEffort) && selectedReasoningEfforts(input.model, options).includes(input.reasoningEffort) ? input.reasoningEffort : undefined
  }
}

export function codexProfileConfiguration(profile: CodexProfile): ExternalAgentConfiguration {
  const { id: _id, name: _name, ...configuration } = normalizeCodexProfile(profile)
  return configuration
}

/** Resolve all profile/mirror/key changes before the existing atomic settings write. */
export function synchronizeCodexProfiles(value: AgentSettings, current: AgentSettings, keys: Record<string, string>, secrets: SecretStorage): AgentSettings {
  if (!Array.isArray(value.codexProfiles)) return value
  if (value.codexProfiles.length > 50) throw new Error('最多保存 50 个 API 连接')
  const raws = value.codexProfiles as CodexProfileInput[]
  let profiles = raws.map(profile => normalizeCodexProfile(profile, false))
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('连接档案 id 重复')
  let activeId = value.activeCodexProfileId ?? null
  const previous = current.externalAgents?.codex
  let configuration = value.externalAgents?.codex
  const readKey = (id: string): string => {
    const encrypted = keys[`codex:${id}`] ?? (id === 'legacy-codex' ? keys.codex : undefined)
    if (!encrypted || !secrets.isEncryptionAvailable()) return ''
    try { return secrets.decryptString(Buffer.from(encrypted, 'base64')) } catch { return '' }
  }
  const writeKey = (id: string, input: ExternalAgentConfiguration, oldUrl?: string): void => {
    const key = input.apiKey?.trim()
    if (input.clearApiKey || !sameApiBaseUrl(input.baseUrl, oldUrl) && !key) delete keys[`codex:${id}`]
    else if (key) {
      if (!secrets.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法保存 API Key')
      keys[`codex:${id}`] = secrets.encryptString(key).toString('base64')
    } else if (id === 'legacy-codex' && !keys[`codex:${id}`] && keys.codex) keys[`codex:${id}`] = keys.codex
  }
  for (const [index, profile] of profiles.entries()) {
    const old = current.codexProfiles?.find(entry => entry.id === profile.id)
    const input = raws[index]
    if (old && (!sameApiBaseUrl(profile.baseUrl, old.baseUrl) || input.apiKey || input.clearApiKey)) {
      profile.declaredModelContextWindows = undefined
      profile.declaredModelContextInputTokens = undefined
      profile.declaredModelContextOutputTokens = undefined
    }
    if (!old || JSON.stringify(profile) !== JSON.stringify(normalizeCodexProfile(old, false)) || input.apiKey || input.clearApiKey) {
      for (const [model, limit] of Object.entries(profile.modelAutoCompactTokenLimits ?? {})) {
        validateCodexAutoCompactTokenLimit(model, { baseUrl: profile.baseUrl, contextWindow: profile.modelContextWindows?.[model], declaredContextWindow: profile.declaredModelContextWindows?.[model], declaredMaxOutputTokens: profile.declaredModelContextOutputTokens?.[model], declaredMaxInputTokens: profile.declaredModelContextInputTokens?.[model] }, limit)
      }
      writeKey(profile.id, input, old?.baseUrl ?? (profile.id === 'legacy-codex' ? previous?.baseUrl : undefined))
    }
  }
  const mirrorChanged = JSON.stringify(configuration) !== JSON.stringify(previous)
  if (!profiles.length && configuration?.mode === 'hosted' && mirrorChanged) {
    profiles = [normalizeCodexProfile({ ...configuration, id: 'legacy-codex', name: '默认连接', mode: 'hosted', baseUrl: configuration.baseUrl ?? '', model: configuration.model ?? '' })]
    activeId = 'legacy-codex'
    writeKey(activeId, configuration, previous?.baseUrl)
  }
  if (activeId && !profiles.some(profile => profile.id === activeId)) throw new Error('连接档案不存在')
  if (!activeId && profiles.length) activeId = profiles[0].id
  const active = profiles.find(profile => profile.id === activeId)
  const profileChanged = active && JSON.stringify(active) !== JSON.stringify(current.codexProfiles?.find(profile => profile.id === activeId) && normalizeCodexProfile(current.codexProfiles.find(profile => profile.id === activeId)!, false))
  const switching = activeId !== (current.activeCodexProfileId ?? null)
  const reactivating = active && previous?.mode !== 'hosted' && configuration?.mode === 'hosted' && sameApiBaseUrl(active.baseUrl, configuration.baseUrl) && !configuration.apiKey
  if (active && mirrorChanged && !switching && !profileChanged && !reactivating && configuration?.mode === 'hosted') {
    writeKey(active.id, configuration, previous?.baseUrl)
    const updated = normalizeCodexProfile({ ...active, ...configuration })
    profiles = profiles.map(profile => profile.id === active.id ? updated : profile)
    configuration = { ...configuration, ...codexProfileConfiguration(updated) }
  } else if (active && (switching || profileChanged || reactivating)) {
    const apiKey = readKey(active.id)
    if (active.mode === 'hosted' && switching && !apiKey) throw new Error('该连接缺少 API Key，请先保存密钥')
    configuration = { ...codexProfileConfiguration(active), apiKey, clearApiKey: !apiKey }
  } else if (!active && (current.codexProfiles?.length ?? 0) > 0) {
    configuration = { mode: 'local', clearApiKey: true, apiKey: '' }
  }
  for (const key of Object.keys(keys)) if (key.startsWith('codex:') && !profiles.some(profile => key === `codex:${profile.id}`)) delete keys[key]
  if (configuration?.mode === 'hosted' && activeId) {
    if (configuration.clearApiKey) delete keys[`codex:${activeId}`]
    const apiKey = readKey(activeId)
    if (!keys[`codex:${activeId}`] && activeId === 'legacy-codex' && keys.codex && !configuration.clearApiKey) keys[`codex:${activeId}`] = keys.codex
    if (keys[`codex:${activeId}`]) keys.codex = keys[`codex:${activeId}`]
    else delete keys.codex
    configuration = { ...configuration, apiKey, clearApiKey: !apiKey }
  } else delete keys.codex
  return { ...value, codexProfiles: profiles, activeCodexProfileId: activeId, externalAgents: { ...value.externalAgents, codex: configuration } }
}
