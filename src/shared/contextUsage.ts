import type { AiTokenUsage } from './types'

const validCount = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function contextTokens(usage: AiTokenUsage | undefined): number | undefined {
  if (!usage) return undefined
  if (validCount(usage.contextTokens)) return usage.contextTokens
  return !usage.cumulative && validCount(usage.inputTokens) ? usage.inputTokens : undefined
}

/** Configuration and billing events must not erase the last measured context. */
export function mergeContextUsage(previous: AiTokenUsage | undefined, incoming: AiTokenUsage | undefined): AiTokenUsage | undefined {
  if (!incoming) return previous
  if (previous && ((incoming.model && previous.model && incoming.model !== previous.model)
    || (incoming.backend && previous.backend && incoming.backend !== previous.backend))) previous = undefined
  const next = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (typeof value === 'number' && (!validCount(value) || key === 'contextWindow' && value === 0)) continue
    Object.assign(next, { [key]: value })
  }
  const used = contextTokens(incoming) ?? contextTokens(previous)
  if (used !== undefined) next.contextTokens = used
  if (previous && Object.keys(next).every(key => next[key as keyof AiTokenUsage] === previous[key as keyof AiTokenUsage])) return previous
  return next
}

/** Read the locally persisted projection, including older partial usage records. */
export function latestContextUsage(items: readonly { usage?: AiTokenUsage }[], selection?: Pick<AiTokenUsage, 'model' | 'backend'>): AiTokenUsage | undefined {
  let usage: AiTokenUsage | undefined
  for (const item of items) if (item.usage) usage = mergeContextUsage(usage, item.usage)
  if (selection && ((selection.model && usage?.model && selection.model !== usage.model)
    || (selection.backend && usage?.backend && selection.backend !== usage.backend))) return undefined
  return usage
}
