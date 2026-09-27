import bundled from './modelReasoningRegistry.json'
import { buildReasoningRegistry, type ReasoningRegistry } from '../shared/modelReasoningRegistry'
import { parseModelFamily } from './modelFamily'
import type { AiModelInfo, ModelReasoningCapabilities } from '../shared/types'

const unknown = (): ModelReasoningCapabilities => ({ source: 'unknown', controls: [], efforts: [] })

export class ModelReasoningCatalog {
  private registry: ReasoningRegistry
  private checkedAt = 0
  private retryAt = 0
  private pending?: Promise<void>
  constructor(registry: ReasoningRegistry = bundled as ReasoningRegistry, private fetcher: typeof fetch = fetch) { this.registry = registry }

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
        this.checkedAt = Date.now()
      } catch { this.retryAt = Date.now() + 60_000 } // Offline scans retain the bundled/last good catalog.
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  resolve(model: string, baseUrl?: string): ModelReasoningCapabilities {
    const own = (models: Record<string, ModelReasoningCapabilities>, id: string) => Object.hasOwn(models, id) ? models[id] : undefined
    const matches: ModelReasoningCapabilities[] = []
    let specificity = -1
    for (const provider of Object.values(this.registry.providers)) {
      const capabilities = own(provider.models, model)
      if (!capabilities || !baseUrl || !provider.api) continue
      try {
        const url = new URL(baseUrl), api = new URL(provider.api), prefix = api.pathname.replace(/\/$/, '')
        if (url.origin !== api.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) continue
        if (prefix.length > specificity) { specificity = prefix.length; matches.length = 0 }
        if (prefix.length === specificity) matches.push(capabilities)
      } catch { /* Unknown endpoints use exact catalog IDs. */ }
    }
    if (!matches.length) {
      // Manufacturer identification is only for an EXACT lookup, never series inheritance.
      const manufacturer = parseModelFamily(model)?.provider
      const provider = manufacturer && Object.hasOwn(this.registry.providers, manufacturer) ? this.registry.providers[manufacturer] : undefined
      const exact = provider && own(provider.models, model.includes('/') ? model.slice(model.indexOf('/') + 1) : model)
      if (exact) matches.push(exact)
      else for (const entry of Object.values(this.registry.providers)) {
        const capabilities = own(entry.models, model)
        if (capabilities) matches.push(capabilities)
      }
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
