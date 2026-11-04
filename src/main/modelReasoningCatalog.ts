import path from 'node:path'
import bundled from './modelReasoningRegistry.json'
import { buildReasoningRegistry, type RegistryModelLimits, type ReasoningRegistry } from '../shared/modelReasoningRegistry'
import { parseModelFamily } from './modelFamily'
import { networkFetch } from './networkRequest'
import { readValidatedTextCache } from './validatedTextCache'
import type { AiModelInfo, ModelReasoningCapabilities } from '../shared/types'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const REFRESH_INTERVAL = 6 * 60 * 60_000
const MIN_RETRY_DELAY = 60_000
const MAX_RETRY_DELAY = 6 * 60 * 60_000
const RETRY_JITTER = 30_000
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const CACHE_FILE_NAME = 'models-dev-api.json'

/** Same tuple layout as the offline context registry, so both can feed one resolver. */
export type CatalogLimit = [context: number, input: number | null, output: number | null, source: number]
type CatalogFetcher = (url: string, init?: RequestInit) => Promise<Response>
interface IndexedLimit { api?: string; limit: RegistryModelLimits }

const unknown = (): ModelReasoningCapabilities => ({ source: 'unknown', controls: [], efforts: [] })

/** Deterministic half of the retry wait; the caller adds jitter so clients cannot synchronize. */
export function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY, MIN_RETRY_DELAY * 2 ** Math.max(0, attempt))
}

export class ModelReasoningCatalog {
  private registry: ReasoningRegistry
  private cachePath?: string
  private limitIndex = new Map<string, IndexedLimit[]>()
  private limitsAvailable = false
  private checkedAt = 0
  private retryAt = 0
  private attempts = 0
  private pending?: Promise<void>
  constructor(registry: ReasoningRegistry = bundled as ReasoningRegistry, private fetcher: CatalogFetcher = networkFetch) {
    this.registry = registry
    this.indexLimits(registry)
  }

  /** Keep the last good payload on disk so a cold start no longer depends on the network. */
  configureCachePath(directory: string): void {
    this.cachePath = directory
  }

  private indexLimits(registry: ReasoningRegistry): void {
    const index = new Map<string, IndexedLimit[]>()
    for (const provider of Object.values(registry.providers)) {
      if (!provider.limits) continue
      for (const [model, limit] of Object.entries(provider.limits)) {
        const entries = index.get(model) ?? []
        entries.push({ ...(provider.api ? { api: provider.api } : {}), limit })
        index.set(model, entries)
      }
    }
    this.limitIndex = index
    this.limitsAvailable = index.size > 0
  }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    // A forced refresh is an explicit user action; a recent failure must not swallow it.
    if (!force && (Date.now() < this.retryAt || Date.now() - this.checkedAt < REFRESH_INTERVAL)) return
    this.pending = (async () => {
      const build = (content: string): ReasoningRegistry => {
        const next = buildReasoningRegistry(JSON.parse(content))
        if (Object.values(next.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0) < 1000) throw new Error('Incomplete reasoning catalog')
        return next
      }
      const download = async (): Promise<string> => {
        const response = await this.fetcher(MODELS_DEV_URL, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.text()
      }
      try {
        let built!: ReasoningRegistry
        // The validator is the single parse point for both the cached and the downloaded payload.
        const validate = (content: string): void => { built = build(content) }
        if (this.cachePath) {
          await readValidatedTextCache(path.join(this.cachePath, CACHE_FILE_NAME), download, validate, MAX_CACHE_BYTES, REFRESH_INTERVAL)
        } else {
          validate(await download())
        }
        this.registry = built
        this.indexLimits(built)
        this.checkedAt = Date.now()
        this.retryAt = 0
        this.attempts = 0
      } catch {
        // Exponential backoff with jitter: an offline client must not hammer the endpoint.
        const delay = retryDelayMs(this.attempts) + Math.random() * RETRY_JITTER
        this.attempts += 1
        this.retryAt = Date.now() + delay // Offline scans retain the bundled/last good catalog.
      }
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  /** Context ceilings from the latest successful refresh; empty until one has succeeded. */
  resolveContextLimits(model: string, baseUrl?: string): CatalogLimit[] {
    const entries = this.limitIndex.get(model)
    if (!entries?.length) return []
    let url: URL | undefined
    if (baseUrl) { try { url = new URL(baseUrl) } catch { url = undefined } }
    const global: CatalogLimit[] = []
    let matched: CatalogLimit[] = []
    let specificity = -1
    for (const { api, limit } of entries) {
      const entry: CatalogLimit = [limit.context, limit.input, limit.output, 0]
      global.push(entry)
      if (!url || !api) continue
      let endpoint: URL
      try { endpoint = new URL(api) } catch { continue }
      const prefix = endpoint.pathname.replace(/\/$/, '')
      if (url.origin !== endpoint.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) continue
      if (prefix.length > specificity) { specificity = prefix.length; matched = [] }
      if (prefix.length === specificity) matched.push(entry)
    }
    // Prefer the deployment that actually serves this endpoint, then any publisher's figure.
    return matched.length ? matched : global
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
