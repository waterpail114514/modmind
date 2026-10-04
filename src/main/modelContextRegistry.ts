import snapshot from './modelContextRegistry.json'
import { validModelContext } from '../shared/modelContext'
import { compareModelVersions, parseModelFamily, type ModelFamily } from './modelFamily'

type Limit = [context: number, input: number | null, output: number | null, source: number]
interface Provider { api?: string; docs?: string; models: Record<string, Limit> }
const providers = snapshot.providers as unknown as Record<string, Provider>
const byModel = new Map<string, Limit[]>()
for (const provider of Object.values(providers)) for (const [id, limit] of Object.entries(provider.models)) {
  const entries = byModel.get(id) ?? []
  entries.push(limit)
  byModel.set(id, entries)
}

export interface ModelBudgetOptions { baseUrl?: string; contextWindow?: number; allowLongerContext?: boolean }
export interface ModelContextBudget {
  contextWindow: number
  autoCompactTokenLimit: number
  source: 'override' | 'provider' | 'registry' | 'inferred' | 'fallback'
  /** Present only for a same-family estimate, never an advertised capacity. */
  inferredFrom?: string
  inferredProvider?: string
}

export const UNKNOWN_MODEL_CONTEXT = 524_288
// Leave room for the next turn before providers' 272K input pricing boundary.
export const STANDARD_AUTO_COMPACT_LIMIT = 256_000

interface FamilyCandidate { model: string; provider: string; family: ModelFamily; limit: Limit }
const familyCandidates = new Map<string, FamilyCandidate[]>()
for (const [provider, record] of Object.entries(providers)) for (const [model, limit] of Object.entries(record.models)) {
  const family = parseModelFamily(model)
  // Input-only historical records cannot establish a total context to inherit.
  if (!family || limit[3] !== 0) continue
  const candidates = familyCandidates.get(family.key) ?? []
  candidates.push({ model, provider, family, limit })
  familyCandidates.set(family.key, candidates)
}

function inferFamilyLimit(model: string, baseUrl?: string): FamilyCandidate | undefined {
  const family = parseModelFamily(model)
  if (!family) return undefined
  const candidates = (familyCandidates.get(family.key) ?? [])
    .filter(entry => compareModelVersions(entry.family.version, family.version) <= 0)
  let matchedProviders: string[] = [], specificity = -1
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      for (const [id, record] of Object.entries(providers)) {
        if (!record.api) continue
        const api = new URL(record.api), prefix = api.pathname.replace(/\/$/, '')
        if (url.origin !== api.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) continue
        if (prefix.length > specificity) { specificity = prefix.length; matchedProviders = [] }
        if (prefix.length === specificity) matchedProviders.push(id)
      }
    } catch { /* An unrecognized endpoint uses manufacturer metadata. */ }
  }
  const local = candidates.filter(entry => matchedProviders.includes(entry.provider))
  const manufacturer = candidates.filter(entry => entry.provider === family.provider)
  const eligible = local.length ? local : manufacturer.length ? manufacturer : candidates
  // Numeric versions, not lexicographic order; retain a smaller limit on ties.
  return eligible.sort((a, b) => compareModelVersions(b.family.version, a.family.version)
    || a.limit[0] - b.limit[0] || (a.limit[1] ?? a.limit[0]) - (b.limit[1] ?? b.limit[0])
    || (b.limit[2] ?? 8192) - (a.limit[2] ?? 8192) || a.model.localeCompare(b.model))[0]
}

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
  // Resolve exact provider-qualified aliases before attempting family inference.
  if (!limits.length && model.includes('/')) {
    const slash = model.indexOf('/')
    const providerId = model.slice(0, slash)
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined
    const id = model.slice(slash + 1)
    if (provider && Object.hasOwn(provider.models, id)) limits = [provider.models[id]]
  }
  // Prefer explicit total-context metadata; legacy input-only records fill gaps.
  if (limits.some(limit => limit[3] === 0)) limits = limits.filter(limit => limit[3] === 0)
  const inferred = !limits.length && options.contextWindow === undefined ? inferFamilyLimit(model, options.baseUrl) : undefined
  if (inferred) limits = [inferred.limit]
  const contextWindow = options.contextWindow ?? (limits.length ? Math.min(...limits.map(limit => limit[0])) : UNKNOWN_MODEL_CONTEXT)
  // Reserve the documented maximum output (up to half the window), plus 5% safety
  // below the runtime's effective window. Separate input ceilings are also respected.
  const output = limits.length ? Math.max(...limits.map(limit => limit[2] ?? 8192)) : 8192
  const reserve = Math.min(output, Math.floor(contextWindow / 2))
  const input = options.contextWindow !== undefined ? contextWindow : Math.min(contextWindow, ...limits.map(limit => limit[1] ?? limit[0]))
  const calculatedLimit = Math.max(1, Math.floor(Math.min(contextWindow * 0.9, input * 0.9, contextWindow - reserve) * 0.95))
  const autoCompactTokenLimit = options.allowLongerContext ? calculatedLimit : Math.min(calculatedLimit, STANDARD_AUTO_COMPACT_LIMIT)
  return {
    contextWindow, autoCompactTokenLimit,
    source: options.contextWindow !== undefined ? 'override' : providerLimits.length ? 'provider' : inferred ? 'inferred' : limits.length ? 'registry' : 'fallback',
    ...(inferred ? { inferredFrom: inferred.model, inferredProvider: inferred.provider } : {})
  }
}
