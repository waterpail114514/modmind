import type { AiOutputEvent, AgentReasoningContent } from '../../shared/types'

/** Indexed native deltas and completion snapshots are shared by both chat surfaces. */
export function mergeAgentReasoning(previous: AgentReasoningContent | undefined, event: AiOutputEvent): AgentReasoningContent | undefined {
  const update = event.reasoning
  if (!update) return previous
  const reasoning = previous ?? { summary: [], text: [] }
  if (update.phase === 'completed') return { summary: update.summary, text: update.text }
  if (update.phase !== 'delta') return reasoning
  if (!Number.isSafeInteger(update.index) || update.index < 0 || update.index >= 256) return undefined
  const parts = [...reasoning[update.channel]]
  parts[update.index] = (parts[update.index] ?? '') + event.content
  return { ...reasoning, [update.channel]: parts }
}
