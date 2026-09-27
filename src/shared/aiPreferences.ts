import { isReasoningEffort } from './modelReasoning'
import type { BeginnerReasoningLevel, ReasoningEffort } from './types'

/** Values mean exactly what is sent upstream; auto omits the override. */
export function beginnerReasoningEffort(_model: string, level: BeginnerReasoningLevel): ReasoningEffort | undefined {
  return isReasoningEffort(level) ? level : undefined
}

export function beginnerReasoningLevelFor(_model: string, effort: unknown): BeginnerReasoningLevel {
  return isReasoningEffort(effort) ? effort : 'auto'
}

/** Only used once when reading the old four-label preference format. */
export function migrateLegacyReasoningLevel(model: string, level: unknown): BeginnerReasoningLevel {
  const index = ['low', 'medium', 'high', 'extreme'].indexOf(String(level))
  if (index < 0) return 'auto'
  const efforts: ReasoningEffort[] = /gpt-5\.6-sol/i.test(model) ? ['medium', 'high', 'xhigh', 'max'] : ['high', 'xhigh', 'max', 'ultra']
  return efforts[index]
}
