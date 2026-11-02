import type { AiModelInfo, BeginnerAiPreferences } from './types'
import { validProviderKind } from './providerAccounts'

export interface QuotaRoute { account: string; group: string | null; label?: string }
export type ModelBilling = 'quota' | 'free'
export interface QuotaModelSelection { billing?: ModelBilling; account?: string; group?: string; scope?: 'settings' | 'workspace' | 'inspiration' }
export interface QuotaModelOption extends AiModelInfo {
  name: string; family: string; description: string; recommended: boolean
  available: boolean; unavailableReason?: string
  optionKey: string; billing: ModelBilling; account?: string
  /** Present only when the chosen upstream route explicitly advertises no cache. */
  noCache?: true
  providerLabel?: string
  group?: string | null
  groupLabel?: string
  routeCurrent?: boolean
  modelEvidence?: 'verified' | 'unknown'
}
export interface QuotaModelCatalog {
  models: QuotaModelOption[]; currentModel: string; currentRoute?: QuotaRoute
  connected: boolean; canSwitch: boolean; stale: boolean; checkedAt: number | null
  billing: 'quota' | 'free' | 'custom'; message?: string; recoveryRequired: boolean; pendingModel?: string
  currentOptionKey: string; pendingSelection?: QuotaModelSelection
  protocolVersion?: 2
  bindings?: Partial<Record<'workspace' | 'inspiration', import('./aiSelection').AiModelSelection>>
  routes?: Array<QuotaRoute & { current: boolean; available: boolean; providerLabel?: string; kind?: 'free' | 'paid'; models?: string[] }>
  selectionRequired?: boolean
  providers?: Array<{ account: string; label: string; kind: 'free' | 'paid' }>
}
export interface QuotaModelSwitchResult {
  status: 'ok' | 'error'; message: string; preferences?: BeginnerAiPreferences
  catalog: QuotaModelCatalog
  selection?: import('./aiSelection').AiModelSelection
  linkedSelections?: Partial<Record<'workspace' | 'inspiration', import('./aiSelection').AiModelSelection>>
  requiresProviderSync?: boolean
}
// Account-visible snapshot probed 2026-10-02. Hints are intersected with live groups;
// a selected route must still list the exact model before the preference is saved.
// Supplier 1 is retired. Never infer routing from manufacturer metadata alone.
export const QUOTA_MODEL_METADATA = [
  {
    "id": "gemini-3.1-pro-preview",
    "name": "Gemini 3.1 Pro Preview",
    "family": "Gemini",
    "description": "擅长长文推理与多模态分析，适合阅读项目和梳理方案。",
    "recommended": false
  },
  {
    "id": "gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "family": "Gemini",
    "description": "上一版 Flash，日常开发建议优先使用 Gemini 3.8 Flash。",
    "recommended": false
  },
  {
    "id": "gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "family": "Gemini",
    "description": "高速编程模型，复杂任务建议优先使用 Gemini 3.8 Flash。",
    "recommended": false
  },
  {
    "id": "gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "family": "Gemini",
    "description": "高速多模态主力，适合写代码、分析项目和连续执行任务。",
    "recommended": true
  },
  {
    "id": "glm-5.3-flash",
    "name": "GLM 5.3 Flash",
    "family": "GLM",
    "description": "低成本多模态编程模型，适合日常开发、看图和长任务。",
    "recommended": true
  },
  {
    "id": "gpt-5.5",
    "name": "GPT-5.5",
    "family": "GPT",
    "description": "较早的通用模型，建议优先使用 GPT-6.1 Sol。",
    "recommended": false
  },
  {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "family": "GPT",
    "description": "低成本轻量模型，省额度建议优先使用 GPT-6 Luna。",
    "recommended": false
  },
  {
    "id": "gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "family": "GPT",
    "description": "上一代主力模型，建议优先使用 GPT-6.1 Sol。",
    "recommended": false
  },
  {
    "id": "gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "family": "GPT",
    "description": "上一代均衡型编程模型，建议优先使用 GPT-6.1 Terra。",
    "recommended": false
  },
  {
    "id": "gpt-6-astra",
    "name": "GPT-6 Astra",
    "family": "GPT",
    "description": "旗舰推理模型，适合高难度开发、重构和复杂建模。",
    "recommended": true
  },
  {
    "id": "gpt-6-luna",
    "name": "GPT-6 Luna",
    "family": "GPT",
    "description": "省额度的高速模型，适合明确的小任务、代码修改和讨论。",
    "recommended": true
  },
  {
    "id": "gpt-6-sol",
    "name": "GPT-6 Sol",
    "family": "GPT",
    "description": "主力编程模型，追求更强能力可选 GPT-6.1 Sol。",
    "recommended": false
  },
  {
    "id": "gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "family": "GPT",
    "description": "接近旗舰能力的全能主力，适合日常开发、写代码和排错。",
    "recommended": true
  },
  {
    "id": "gpt-6.1-terra",
    "name": "GPT-6.1 Terra",
    "family": "GPT",
    "description": "均衡型编程模型，适合日常开发、代码修改和任务讨论。",
    "recommended": false
  },
  {
    "id": "grok-4.5",
    "name": "Grok 4.5",
    "family": "Grok",
    "description": "较早的编程模型，复杂任务建议优先使用 Grok 4.7。",
    "recommended": false
  },
  {
    "id": "grok-4.6",
    "name": "Grok 4.6",
    "family": "Grok",
    "description": "上一版编程主力，复杂任务建议优先使用 Grok 4.7。",
    "recommended": false
  },
  {
    "id": "grok-4.7",
    "name": "Grok 4.7",
    "family": "Grok",
    "description": "擅长持续编程与问题分析，适合复杂开发、排错和方案执行。",
    "recommended": true
  },
  {
    "id": "kimi-k3",
    "name": "Kimi K3",
    "family": "Kimi",
    "description": "擅长长程编程与知识工作，适合大型项目分析和复杂任务。",
    "recommended": false
  }
] as const

export const QUOTA_ROUTE_HINTS = [
  {
    "group": "gpt-pro（混池）",
    "models": [
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-sol"
    ]
  },
  {
    "group": "GPT-MAX（纯血pro池）禁止逆向 触发多次cyber封号",
    "models": [
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol"
    ]
  },
  {
    "group": "GPT6 Astra不降智分组",
    "models": [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6.1-sol"
    ]
  },
  {
    "group": "GPT 企业专用",
    "models": [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6.1-sol"
    ]
  },
  {
    "group": "Kimi",
    "models": [
      "kimi-k3"
    ]
  },
  {
    "group": "GLM",
    "models": [
      "glm-5.3-flash"
    ]
  },
  {
    "group": "Gemini",
    "models": [
      "gemini-3.1-pro-preview",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash"
    ]
  },
  {
    "group": "Grok",
    "models": [
      "grok-4.5",
      "grok-4.6",
      "grok-4.7"
    ]
  }
] as const

// Only the usable free provider from the same account-visible probe is included.
// The OpenRouter login-only provider has no allowance and is not a model option.
export const FREE_ROUTE_HINTS = [{ account: 'trial:free-mtjzrt3s-l9afs', models: [
  'deepseek-v4-pro-0813', 'deepseek-v4.1-flash', 'glm-5.3', 'qwen3.8-flash'
] }] as const
export const FREE_MODEL_METADATA = [
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', family: 'DeepSeek', description: '较早的推理模型，建议优先使用 DeepSeek V4.1 Flash。', recommended: false },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', family: 'DeepSeek', description: '高性价比的主力模型，适合复杂开发、代码分析和排错。', recommended: true },
  { id: 'glm-5.3', name: 'GLM 5.3', family: 'GLM', description: '复杂编程与推理主力，适合大型代码修改和长程任务。', recommended: false },
  { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash', family: 'Qwen', description: '高性价比多模态模型，适合写代码、分析文档和看图。', recommended: false }
] as const
export function quotaModelOptionKey(model: string, billing: ModelBilling, account?: string, group?: string | null): string {
  if (billing === 'quota' && group != null) return `quota-route:${JSON.stringify([account ?? 'secondary', group, model])}`
  return billing === 'free' ? `free:${account ?? ''}:${model}` : account && account !== 'secondary' ? `quota:${account}:${model}` : `quota:${model}`
}
export function validateQuotaModelSelection(value: unknown): QuotaModelSelection {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型版本选项无效')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['billing', 'account', 'group', 'scope'].includes(k)) || (v.billing !== undefined && v.billing !== 'quota' && v.billing !== 'free') || (v.scope !== undefined && !['settings', 'workspace', 'inspiration'].includes(String(v.scope)))) throw new Error('模型版本选项无效')
  if (v.group !== undefined && (v.billing === 'free' || typeof v.group !== 'string' || !v.group.trim() || v.group.length > 512 || /[\x00-\x1f\x7f]/.test(v.group))) throw new Error('付费分组选项无效')
  if (v.account !== undefined && !validProviderKind(v.account, v.billing === 'free' ? 'free' : 'paid')) throw new Error('免费或付费供应商选项无效')
  return { ...(v.billing ? { billing: v.billing as ModelBilling } : {}), ...(v.account ? { account: v.account as string } : {}), ...(v.group !== undefined ? { group: v.group as string } : {}), ...(v.scope ? { scope: v.scope as QuotaModelSelection['scope'] } : {}) }
}

export function quotaModelMetadata(id: string): { id: string; name: string; family: string; description: string; recommended: boolean } {
  return [...QUOTA_MODEL_METADATA, ...FREE_MODEL_METADATA].find(model => model.id === id) ?? { id, name: id,
    family: /^gpt-/i.test(id) ? 'GPT' : /^gemini-/i.test(id) ? 'Gemini' : /^grok-/i.test(id) ? 'Grok' : /^kimi-/i.test(id) ? 'Kimi' : /^glm-/i.test(id) ? 'GLM' : /^deepseek-/i.test(id) ? 'DeepSeek' : /^qwen/i.test(id) ? 'Qwen' : '其他',
    description: '', recommended: false }
}
export function isSelectableQuotaModel(id: string): boolean {
  return Boolean(id && id.length <= 256 && !/[\r\n\u0000-\u001f]/.test(id) && !/^(?:codex-auto-review|gpt-image|text-embedding|whisper|tts-|sora)/i.test(id))
}

/** Keep live provider labels for newly released models; bundled labels are hints. */
export function quotaModelDisplayMetadata(model: AiModelInfo): ReturnType<typeof quotaModelMetadata> {
  const fallback = quotaModelMetadata(model.id)
  const text = (value: unknown, defaultValue: string): string => typeof value === 'string' && value.trim() ? value.trim() : defaultValue
  return { id: model.id, name: text(model.name, fallback.name), family: text(model.family, fallback.family),
    description: typeof model.description === 'string' ? model.description : fallback.description,
    recommended: typeof model.recommended === 'boolean' ? model.recommended : fallback.recommended }
}
