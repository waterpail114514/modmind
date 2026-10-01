import { isReasoningEffort } from './modelReasoning'
import type { AgentSettings, BeginnerAiPreferences, BeginnerReasoningLevel, CodingBackend } from './types'

export interface AiModelSelection { model: string; reasoningLevel: BeginnerReasoningLevel }
export interface SurfaceAiSelection extends AiModelSelection { backend: CodingBackend }

export function normalizeAiModelSelection(value: unknown): AiModelSelection | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') throw new Error('AI 选择无效')
  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (!model || model.length > 256 || /[\x00-\x1f]/.test(model)) throw new Error('请选择模型')
  if (record.reasoningLevel !== 'auto' && !isReasoningEffort(record.reasoningLevel)) throw new Error('思考强度无效')
  return { model, reasoningLevel: record.reasoningLevel }
}

export function readSurfaceAiSelection(value: string | null): SurfaceAiSelection | undefined {
  try {
    const record = JSON.parse(value ?? 'null')
    const selection = normalizeAiModelSelection(record)
    return selection && ['quota', 'codex'].includes(record.backend) ? { ...selection, backend: record.backend } : undefined
  } catch { return undefined }
}

export function defaultAiSelection(backend: CodingBackend, preferences: BeginnerAiPreferences, agents?: AgentSettings['externalAgents']): SurfaceAiSelection {
  const external = backend === 'quota' ? undefined : agents?.[backend]
  return { backend, model: backend === 'quota' ? preferences.model : external?.model ?? '', reasoningLevel: backend === 'quota' ? preferences.reasoningLevel : external?.reasoningEffort ?? 'auto' }
}

/** Per-run overrides never write the user's defaults. */
export function settingsForAiSelection(settings: AgentSettings, backend: CodingBackend, selection?: AiModelSelection): AgentSettings {
  if (!selection || backend === 'quota') return settings
  return { ...settings, externalAgents: { ...settings.externalAgents, [backend]: {
    ...settings.externalAgents?.[backend], model: selection.model,
    reasoningEffort: selection.reasoningLevel === 'auto' ? undefined : selection.reasoningLevel
  } } }
}
