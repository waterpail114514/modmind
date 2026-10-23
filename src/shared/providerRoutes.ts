import { isSelectableQuotaModel, QUOTA_ROUTE_HINTS } from './quotaModels'

export interface ProviderGroup { id: string; label: string; models?: string[] }
export interface ProviderModelGroup extends ProviderGroup { models: string[] }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Read only advertised IDs; an absent model list differs from an explicit empty list. */
export function parseProviderModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return [...new Set(value.slice(0, 512).map(item => typeof item === 'string' ? item : object(item).id)
    .filter((id): id is string => typeof id === 'string' && isSelectableQuotaModel(id))) ]
}

export function parseProviderGroups(value: unknown): ProviderGroup[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.slice(0, 100).flatMap(raw => {
    const group = object(raw)
    if (typeof group.id !== 'string' || !group.id.trim() || group.id.length > 512 || /[\x00-\x1f\x7f]/.test(group.id) || seen.has(group.id)) return []
    seen.add(group.id)
    const models = parseProviderModels(group.models)
    return [{ id: group.id, label: typeof group.label === 'string' && group.label.trim() ? group.label.slice(0, 256) : group.id, ...(models !== undefined ? { models } : {}) }]
  })
}

/** Legacy hints belong to supplier two, never to another provider with a matching group ID. */
export function providerModelGroups(account: string, groups: ProviderGroup[]): ProviderModelGroup[] {
  return groups.map(group => {
    const hint = account === 'secondary' ? QUOTA_ROUTE_HINTS.find(route => route.group === group.id || route.group === group.label) : undefined
    return { ...group, models: group.models ?? (hint ? [...hint.models] : []) }
  })
}
