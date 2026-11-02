import type { AiOutputEvent, InspirationChatMessage } from '../../shared/types'
import type { WorkbenchTimelineItem } from './workbenchTimeline'
import { INSPIRATION_STAGE_PROGRESS } from './inspirationProgress'

export const inspirationActivityId = (event: AiOutputEvent): string => `activity:${event.turnId ?? event.sessionId}:${event.itemId ?? event.streamId}`

export function inspirationActivityItem(previous: InspirationChatMessage | undefined, event: AiOutputEvent): InspirationChatMessage | undefined {
  if (!event.activity || previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return previous
  if (previous?.activity?.completedAt && previous.activity.status !== 'running' && event.activity.status === 'running' && event.activity.tool !== INSPIRATION_STAGE_PROGRESS) return previous
  return { ...previous, role: 'assistant', kind: 'tool', id: inspirationActivityId(event), content: event.activity.title,
    time: previous?.time ?? event.time, turnId: event.turnId, sessionId: event.sessionId, sequence: event.sequence, isFinal: false,
    activity: event.activity, status: event.activity.status === 'running' ? 'streaming' : event.activity.status === 'failed' ? 'error' : ['cancelled', 'interrupted'].includes(event.activity.status) ? 'warning' : 'completed' }
}

export function upsertInspirationActivity(messages: InspirationChatMessage[], event: AiOutputEvent): InspirationChatMessage[] {
  const id = inspirationActivityId(event)
  const index = messages.findIndex(message => message.id === id)
  const next = inspirationActivityItem(index < 0 ? undefined : messages[index], event)
  if (!next || next === messages[index]) return messages
  if (index >= 0) return messages.map((message, i) => i === index ? next : message)
  const pending = messages.findIndex(message => !message.kind && message.role === 'assistant' && message.status === 'streaming'
    && (event.turnId ? message.turnId === event.turnId : message.sessionId === event.sessionId))
  return pending < 0 ? [...messages, next] : [...messages.slice(0, pending), next, ...messages.slice(pending)]
}

export function settleInspirationActivities(messages: InspirationChatMessage[], sessionId: string): InspirationChatMessage[] {
  return messages.map(message => message.activity?.status === 'running' && message.sessionId === sessionId
    ? { ...message, status: 'warning', activity: { ...message.activity, status: 'interrupted' } } : message)
}

/** Reuse the workbench presentation while preserving inspiration's durable model. */
export function inspirationActivityRows(messages: InspirationChatMessage[]): WorkbenchTimelineItem[] {
  return messages.map((message, index) => ({ id: message.id ?? `legacy-${index}`, kind: message.status === 'error' ? 'error' : 'tool',
    content: message.content, time: message.time ?? '', activity: message.activity, notice: message.notice,
    status: message.status === 'streaming' ? 'running' : message.status === 'error' ? 'error' : ['warning', 'cancelled'].includes(message.status ?? '') ? 'warning' : 'done' }))
}
