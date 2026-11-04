import { parseReasoningCapabilities } from './modelReasoning'
import type { ModelReasoningCapabilities } from './types'

/** Context ceilings published by the upstream catalog, kept separate from reasoning capabilities. */
export interface RegistryModelLimits {
  context: number
  input: number | null
  output: number | null
}

export interface ReasoningRegistry {
  updatedAt: string
  sourceUrl: string
  providers: Record<string, { api?: string; models: Record<string, ModelReasoningCapabilities>; limits?: Record<string, RegistryModelLimits> }>
}

function registryToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100_000_000 ? value : null
}

/**
 * Extract the published context ceilings. Mirrors the offline snapshot's filter: only
 * text-to-text models with a usable total context, so the live table stays interchangeable
 * with the bundled one instead of growing entries the runtime would never consult.
 */
export function parseRegistryLimits(value: unknown): RegistryModelLimits | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { modalities?: { input?: unknown; output?: unknown }; limit?: { context?: unknown; input?: unknown; output?: unknown } }
    : undefined
  const inputModalities = record?.modalities?.input
  const outputModalities = record?.modalities?.output
  if (!Array.isArray(inputModalities) || !inputModalities.includes('text')) return undefined
  if (!Array.isArray(outputModalities) || !outputModalities.includes('text')) return undefined
  const context = registryToken(record?.limit?.context)
  if (context === null) return undefined
  return { context, input: registryToken(record?.limit?.input), output: registryToken(record?.limit?.output) }
}

export function buildReasoningRegistry(data: unknown, updatedAt = new Date().toISOString().slice(0, 10)): ReasoningRegistry {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid reasoning metadata')
  const providers: ReasoningRegistry['providers'] = {}
  for (const [id, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as { api?: unknown; models?: Record<string, unknown> }
    const models: Record<string, ModelReasoningCapabilities> = {}
    const limits: Record<string, RegistryModelLimits> = {}
    for (const [model, raw] of Object.entries(entry.models ?? {})) {
      const capabilities = parseReasoningCapabilities(raw, 'registry')
      if (capabilities) Object.defineProperty(models, model, { value: capabilities, enumerable: true })
      const limit = parseRegistryLimits(raw)
      if (limit) Object.defineProperty(limits, model, { value: limit, enumerable: true })
    }
    // A provider may publish context ceilings without any reasoning metadata; both are still useful.
    if (!Object.keys(models).length && !Object.keys(limits).length) continue
    Object.defineProperty(providers, id, {
      value: {
        ...(typeof entry.api === 'string' ? { api: entry.api } : {}),
        models,
        ...(Object.keys(limits).length ? { limits } : {})
      },
      enumerable: true
    })
  }
  return { updatedAt, sourceUrl: 'https://models.dev/api.json', providers }
}
