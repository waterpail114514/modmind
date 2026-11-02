import type { AiOutputEvent, InspirationChatMessage, PipelineEvent } from '../../shared/types'

/** Host stages use the same activity presentation as native tools, with their own identity. */
export const INSPIRATION_STAGE_PROGRESS = 'modmind_stage_progress'

export function inspirationProgressOutput(event: PipelineEvent): AiOutputEvent {
  const identity = { time: event.time, sessionId: event.sessionId, projectPath: event.projectPath, runId: event.runId,
    conversationId: event.conversationId, generation: event.generation, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId }
  if (event.notice) return { ...identity, kind: 'retry', content: event.detail || event.title, notice: event.notice }
  return { ...identity, kind: 'tool', content: event.title,
    itemId: `progress:${JSON.stringify([event.stage, event.title])}`,
    activity: { kind: 'tool', tool: INSPIRATION_STAGE_PROGRESS, title: event.title, detail: event.detail,
      status: event.status === 'running' ? 'running' : event.status === 'error' ? 'failed' : event.status === 'warning' ? 'interrupted' : 'completed',
      startedAt: event.time, ...(event.status === 'running' ? {} : { completedAt: event.time }) } }
}

/** A later stage or model action ends the previous host stage, without settling native tools. */
export function settleInspirationProgress(messages: InspirationChatMessage[], sessionId: string | undefined,
  exceptId?: string): InspirationChatMessage[] {
  let changed = false
  const next = messages.map(message => {
    if (message.sessionId !== sessionId || message.id === exceptId || message.activity?.tool !== INSPIRATION_STAGE_PROGRESS || message.activity.status !== 'running') return message
    changed = true
    return { ...message, status: 'completed' as const, activity: { ...message.activity, status: 'completed' as const } }
  })
  return changed ? next : messages
}
