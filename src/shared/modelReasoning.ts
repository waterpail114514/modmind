import type { BeginnerReasoningLevel, ModelReasoningCapabilities, ReasoningEffort } from './types'

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export const DEFAULT_CODEX_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const MAX_SELECTABLE_REASONING_EFFORTS = 5
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

export function normalizeReasoningEffortOptions(value: unknown): Record<string, ReasoningEffort[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(([id, efforts]) => id.length > 0 && id.length <= 512 && !/[\x00-\x1f]/.test(id)
    && Array.isArray(efforts) && efforts.length > 0 && efforts.length <= MAX_SELECTABLE_REASONING_EFFORTS
    && efforts.every(isReasoningEffort) && new Set(efforts).size === efforts.length).slice(0, 500)
  return entries.length ? Object.fromEntries(entries.map(([id, efforts]) => [id, REASONING_EFFORTS.filter(effort => (efforts as ReasoningEffort[]).includes(effort))])) : undefined
}

export function selectedReasoningEfforts(model: string, configured?: Record<string, ReasoningEffort[]>): ReasoningEffort[] {
  return normalizeReasoningEffortOptions(configured)?.[model] ?? DEFAULT_CODEX_REASONING_EFFORTS
}

export function codexReasoningCapabilities(capabilities: ModelReasoningCapabilities | undefined, efforts: ReasoningEffort[]): ModelReasoningCapabilities {
  return { source: capabilities?.source ?? 'unknown', controls: ['effort'], efforts }
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Read explicit capability fields; a reasoning=true flag alone establishes no levels. */
export function parseReasoningCapabilities(value: unknown, source: ModelReasoningCapabilities['source'] = 'provider'): ModelReasoningCapabilities | undefined {
  const model = record(value)
  if (!model) return undefined
  if (model.reasoning === false) return { source, supported: false, efforts: [], controls: [] }
  const nested = record(model.reasoning)
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : []
  const effortOption = options.map(record).find(option => option?.type === 'effort')
  const levels = model.supported_reasoning_efforts ?? model.supported_reasoning_levels ?? nested?.supported_efforts ?? effortOption?.values
  const controls: ModelReasoningCapabilities['controls'] = []
  if (Array.isArray(levels)) controls.push('effort')
  if (options.some(option => record(option)?.type === 'toggle')) controls.push('toggle')
  const budget = options.map(record).find(option => option?.type === 'budget_tokens')
  if (budget) controls.push('budget_tokens')
  if (!controls.length && model.reasoning !== false) return undefined
  const values = Array.isArray(levels) ? levels.map(level => record(level)?.effort ?? level) : []
  const defaultEffort = model.default_reasoning_level ?? nested?.default_effort
  const budgetTokens = budget && typeof budget.min === 'number' && typeof budget.max === 'number'
    && Number.isSafeInteger(budget.min) && Number.isSafeInteger(budget.max) && budget.min >= 0 && budget.max >= budget.min
    ? { min: budget.min, max: budget.max } : undefined
  return {
    efforts: REASONING_EFFORTS.filter(effort => values.includes(effort)), controls, source,
    ...(typeof model.reasoning === 'boolean' ? { supported: model.reasoning } : {}),
    ...(isReasoningEffort(defaultEffort) && values.includes(defaultEffort) ? { defaultEffort } : {}),
    ...(budgetTokens ? { budgetTokens } : {})
  }
}

export function reasoningOptions(capabilities?: ModelReasoningCapabilities, allowedEfforts?: ReasoningEffort[]): BeginnerReasoningLevel[] {
  return ['auto', ...(allowedEfforts ?? capabilities?.efforts ?? [])]
}

export function reasoningSelectionEffort(level: BeginnerReasoningLevel, capabilities?: ModelReasoningCapabilities, allowedEfforts?: ReasoningEffort[]): ReasoningEffort | undefined {
  if (level === 'auto') return undefined
  if (!(allowedEfforts ?? capabilities?.efforts ?? []).includes(level)) throw new Error(allowedEfforts
    ? `当前模型未开放 ${level} 思考强度，请在设置中调整可选档位，或选择自动`
    : `当前模型或线路未确认支持 ${level} 思考强度，请刷新模型列表并重新选择，或选择自动`)
  return level
}

export function reasoningCapabilityNote(capabilities?: ModelReasoningCapabilities): string {
  if (!capabilities || capabilities.source === 'unknown') return '未获取到思考档位，使用模型默认设置'
  if (capabilities.supported === false) return '此模型不支持思考参数'
  const source = capabilities.source === 'provider' ? '上游返回' : '公开能力表'
  if (capabilities.efforts.length) return `${source} · 所选档位按原值发送`
  if (capabilities.budgetTokens) return `此模型按思考预算控制（${capabilities.budgetTokens.min.toLocaleString('zh-CN')}–${capabilities.budgetTokens.max.toLocaleString('zh-CN')} tokens），当前使用模型默认设置`
  if (capabilities.controls.includes('toggle')) return '此模型仅提供思考开关，当前使用模型默认设置'
  return '上游未提供可选思考档位，使用模型默认设置'
}
