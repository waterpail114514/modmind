import snapshot from './modelContextRegistry.json'
import { validModelContext } from '../shared/modelContext'

type Limit = [context: number, input: number | null, output: number | null, source: number]
interface Provider { api?: string; docs?: string; models: Record<string, Limit> }
const providers = snapshot.providers as unknown as Record<string, Provider>
const byModel = new Map<string, Limit[]>()
for (const provider of Object.values(providers)) for (const [id, limit] of Object.entries(provider.models)) {
  const entries = byModel.get(id) ?? []
  entries.push(limit)
  byModel.set(id, entries)
}

export interface ModelBudgetOptions { baseUrl?: string; contextWindow?: number }
export interface ModelContextBudget {
  contextWindow: number
  autoCompactTokenLimit: number
  source: 'override' | 'provider' | 'registry' | 'fallback'
}

export const UNKNOWN_MODEL_CONTEXT = 32_768

function limitsForProvider(model: string, baseUrl?: string): Limit[] {
  if (!baseUrl) return []
  let url: URL
  try { url = new URL(baseUrl) } catch { return [] }
  let specificity = -1
  let matches: Limit[] = []
  for (const provider of Object.values(providers)) {
    if (!provider.api || !Object.hasOwn(provider.models, model)) continue
    const api = new URL(provider.api)
    const prefix = api.pathname.replace(/\/$/, '')
    if (url.origin !== api.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) continue
    if (prefix.length > specificity) { specificity = prefix.length; matches = [] }
    if (prefix.length === specificity) matches.push(provider.models[model])
  }
  return matches
}

export function resolveModelContextBudget(model: string, options: ModelBudgetOptions = {}): ModelContextBudget {
  if (options.contextWindow !== undefined && !validModelContext(options.contextWindow)) throw new Error('上下文窗口必须是 1,024–100,000,000 之间的整数')
  const providerLimits = limitsForProvider(model, options.baseUrl)
  let limits = providerLimits.length ? providerLimits : byModel.get(model) ?? []
  // Exact provider-qualified aliases only; never infer capabilities from a family prefix.
  if (!limits.length && model.includes('/')) {
    const slash = model.indexOf('/')
    const providerId = model.slice(0, slash)
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined
    const id = model.slice(slash + 1)
    if (provider && Object.hasOwn(provider.models, id)) limits = [provider.models[id]]
  }
  // Prefer explicit total-context metadata; legacy input-only records fill gaps.
  if (limits.some(limit => limit[3] === 0)) limits = limits.filter(limit => limit[3] === 0)
  const contextWindow = options.contextWindow ?? (limits.length ? Math.min(...limits.map(limit => limit[0])) : UNKNOWN_MODEL_CONTEXT)
  // Reserve the documented maximum output (up to half the window), plus 5% safety
  // below the runtime's effective window. Separate input ceilings are also respected.
  const output = limits.length ? Math.max(...limits.map(limit => limit[2] ?? 8192)) : 8192
  const reserve = Math.min(output, Math.floor(contextWindow / 2))
  const input = options.contextWindow !== undefined ? contextWindow : Math.min(contextWindow, ...limits.map(limit => limit[1] ?? limit[0]))
  const autoCompactTokenLimit = Math.max(1, Math.floor(Math.min(contextWindow * 0.9, input * 0.9, contextWindow - reserve) * 0.95))
  return { contextWindow, autoCompactTokenLimit, source: options.contextWindow !== undefined ? 'override' : providerLimits.length ? 'provider' : limits.length ? 'registry' : 'fallback' }
}
