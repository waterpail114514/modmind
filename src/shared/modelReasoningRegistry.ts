import { parseReasoningCapabilities } from './modelReasoning'
import type { ModelReasoningCapabilities } from './types'

export interface ReasoningRegistry {
  updatedAt: string
  sourceUrl: string
  providers: Record<string, { api?: string; models: Record<string, ModelReasoningCapabilities> }>
}

export function buildReasoningRegistry(data: unknown, updatedAt = new Date().toISOString().slice(0, 10)): ReasoningRegistry {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid reasoning metadata')
  const providers: ReasoningRegistry['providers'] = {}
  for (const [id, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as { api?: unknown; models?: Record<string, unknown> }
    const models: Record<string, ModelReasoningCapabilities> = {}
    for (const [model, raw] of Object.entries(entry.models ?? {})) {
      const capabilities = parseReasoningCapabilities(raw, 'registry')
      if (capabilities) Object.defineProperty(models, model, { value: capabilities, enumerable: true })
    }
    if (!Object.keys(models).length) continue
    Object.defineProperty(providers, id, { value: { ...(typeof entry.api === 'string' ? { api: entry.api } : {}), models }, enumerable: true })
  }
  return { updatedAt, sourceUrl: 'https://models.dev/api.json', providers }
}
