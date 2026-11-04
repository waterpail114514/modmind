import { readModelDataOrEmpty } from './modelData'
import { buildReasoningRegistry, type ReasoningRegistry } from '../shared/modelReasoningRegistry'
import { parseModelFamily } from './modelFamily'
import type { AiModelInfo, ModelReasoningCapabilities } from '../shared/types'

const BUNDLED_PATH = 'src/main/modelReasoningRegistry.json'
const EMPTY_REGISTRY: ReasoningRegistry = { updatedAt: '', sourceUrl: '', providers: {} }

const unknown = (): ModelReasoningCapabilities => ({ source: 'unknown', controls: [], efforts: [] })

interface ProviderEndpoint { provider: string; prefix: string; models: Record<string, ModelReasoningCapabilities> }

interface ReasoningIndex {
  providers: ReasoningRegistry['providers']
  byModel: Map<string, ModelReasoningCapabilities[]>
  byOrigin: Map<string, ProviderEndpoint[]>
}

function buildIndex(registry: ReasoningRegistry): ReasoningIndex {
  const byModel = new Map<string, ModelReasoningCapabilities[]>()
  const byOrigin = new Map<string, ProviderEndpoint[]>()
  for (const [provider, record] of Object.entries(registry.providers)) {
    for (const [model, capabilities] of Object.entries(record.models)) {
      const entries = byModel.get(model) ?? []
      entries.push(capabilities)
      byModel.set(model, entries)
    }
    if (!record.api) continue
    try {
      const api = new URL(record.api)
      const prefix = api.pathname.replace(/\/$/, '')
      const endpoints = byOrigin.get(api.origin) ?? []
      endpoints.push({ provider, prefix, models: record.models })
      byOrigin.set(api.origin, endpoints)
    } catch { /* Providers without a usable endpoint stay out of endpoint matching. */ }
  }
  return { providers: registry.providers, byModel, byOrigin }
}

export class ModelReasoningCatalog {
  private registry: ReasoningRegistry | null = null
  private index: ReasoningIndex | null = null
  private checkedAt = 0
  private retryAt = 0
  private pending?: Promise<void>
  constructor(registry?: ReasoningRegistry, private fetcher: typeof fetch = fetch) {
    this.registry = registry ?? null
  }

  private currentRegistry(): ReasoningRegistry {
    if (!this.registry) this.registry = readModelDataOrEmpty<ReasoningRegistry>(BUNDLED_PATH, '模型推理能力注册表', EMPTY_REGISTRY)
    return this.registry
  }

  private currentIndex(): ReasoningIndex {
    if (!this.index) this.index = buildIndex(this.currentRegistry())
    return this.index
  }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    if (Date.now() < this.retryAt || !force && Date.now() - this.checkedAt < 6 * 60 * 60_000) return
    this.pending = (async () => {
      try {
        const response = await this.fetcher('https://models.dev/api.json', { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = buildReasoningRegistry(await response.json())
        if (Object.values(next.providers).reduce((sum, p) => sum + Object.keys(p.models).length, 0) < 1000) throw new Error('Incomplete reasoning catalog')
        this.registry = next
        this.index = null
        this.checkedAt = Date.now()
      } catch { this.retryAt = Date.now() + 60_000 } // Offline scans retain the bundled/last good catalog.
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  resolve(model: string, baseUrl?: string): ModelReasoningCapabilities {
    const own = (models: Record<string, ModelReasoningCapabilities>, id: string) => Object.hasOwn(models, id) ? models[id] : undefined
    const { providers, byModel, byOrigin } = this.currentIndex()
    const matches: ModelReasoningCapabilities[] = []
    let specificity = -1
    if (baseUrl) {
      let url: URL | undefined
      try { url = new URL(baseUrl) } catch { /* Unknown endpoints use exact catalog IDs. */ }
      if (url) {
        for (const endpoint of byOrigin.get(url.origin) ?? []) {
          const capabilities = own(endpoint.models, model)
          if (!capabilities) continue
          if (!(url.pathname === endpoint.prefix || url.pathname.startsWith(endpoint.prefix + '/'))) continue
          if (endpoint.prefix.length > specificity) { specificity = endpoint.prefix.length; matches.length = 0 }
          if (endpoint.prefix.length === specificity) matches.push(capabilities)
        }
      }
    }
    if (!matches.length) {
      // Manufacturer identification is only for an EXACT lookup, never series inheritance.
      const manufacturer = parseModelFamily(model)?.provider
      const provider = manufacturer && Object.hasOwn(providers, manufacturer) ? providers[manufacturer] : undefined
      const exact = provider && own(provider.models, model.includes('/') ? model.slice(model.indexOf('/') + 1) : model)
      if (exact) matches.push(exact)
      else matches.push(...(byModel.get(model) ?? []))
    }
    if (!matches.length) return unknown()
    // Resellers may restrict levels. Without a matched endpoint expose only agreement.
    const first = matches[0]
    const efforts = first.efforts.filter(effort => matches.every(item => item.efforts.includes(effort)))
    return { ...first, source: 'registry', efforts, controls: first.controls.filter(control => matches.every(item => item.controls.includes(control))) }
  }

  enrich(models: AiModelInfo[], baseUrl: string): AiModelInfo[] {
    return models.map(model => ({ ...model, reasoning: model.reasoning ?? this.resolve(model.id, baseUrl) }))
  }
}

export const modelReasoningCatalog = new ModelReasoningCatalog()
