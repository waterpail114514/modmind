import type { AiOutputEvent, InspirationChatMessage } from '../../shared/types'
import { mergeStreamingText } from './workbenchTimeline'

const belongs = (message: InspirationChatMessage, event: AiOutputEvent): boolean => message.role === 'assistant' && !message.kind
  && (event.turnId ? message.turnId === event.turnId : message.sessionId === event.sessionId)

export function inspirationResponseId(event: AiOutputEvent): string {
  return `response:${JSON.stringify([event.turnId ?? event.sessionId, event.streamId ?? event.itemId ?? event.eventId ?? event.sequence ?? event.content])}`
}

export function inspirationProgressMessage(pending: InspirationChatMessage | undefined, event: AiOutputEvent): InspirationChatMessage {
  return { role: 'assistant', id: inspirationResponseId(event), phase: 'commentary', content: event.content, status: 'completed', isFinal: false,
    turnId: event.turnId ?? pending?.turnId, sessionId: event.sessionId ?? pending?.sessionId, time: event.time,
    generation: event.generation ?? pending?.generation, inspirationFeatures: event.inspirationFeatures ?? pending?.inspirationFeatures,
    itemId: event.itemId, streamId: event.streamId, sequence: event.sequence }
}

export function inspirationPendingMessage(pending: InspirationChatMessage | undefined, event: AiOutputEvent): InspirationChatMessage {
  return { ...pending, role: 'assistant', id: pending?.id ?? `${event.turnId ?? event.sessionId}:assistant`, phase: undefined,
    content: '', status: 'streaming', isFinal: false, turnId: event.turnId ?? pending?.turnId, sessionId: event.sessionId ?? pending?.sessionId,
    generation: event.generation ?? pending?.generation, inspirationFeatures: event.inspirationFeatures ?? pending?.inspirationFeatures,
    itemId: undefined, streamId: undefined, sequence: event.sequence }
}

export function inspirationFinalMessage(pending: InspirationChatMessage | undefined, progress: InspirationChatMessage | undefined, event: AiOutputEvent): InspirationChatMessage {
  return { ...pending, ...progress, role: 'assistant', id: progress?.id ?? pending?.id ?? `${event.turnId}:assistant`, phase: 'final_answer',
    content: event.content, status: 'completed', isFinal: true, turnId: event.turnId ?? pending?.turnId, sessionId: event.sessionId ?? pending?.sessionId,
    time: event.time, generation: event.generation ?? pending?.generation,
    inspirationFeatures: event.inspirationFeatures ?? pending?.inspirationFeatures ?? progress?.inspirationFeatures,
    inspirationArtifact: pending?.inspirationArtifact ?? progress?.inspirationArtifact, promptEdit: pending?.promptEdit ?? progress?.promptEdit,
    usage: event.usage ?? pending?.usage ?? progress?.usage, itemId: event.itemId, streamId: event.streamId, sequence: event.sequence }
}

/** Model paragraphs stay model paragraphs; lifecycle/tool events use their own rows. */
export function reduceInspirationText(messages: InspirationChatMessage[], event: AiOutputEvent): InspirationChatMessage[] {
  const pendingIndex = messages.findIndex(message => belongs(message, event) && message.status === 'streaming' && message.phase !== 'commentary')
  const pending = pendingIndex < 0 ? undefined : messages[pendingIndex]
  const responseId = inspirationResponseId(event)
  const responseIndex = messages.findIndex(message => belongs(message, event) && message.id === responseId)
  const sealed = messages.some(message => belongs(message, event) && message.status === 'completed'
    && (event.streamId ? message.streamId === event.streamId : event.itemId ? message.itemId === event.itemId : false))
  if (event.kind === 'delta') {
    if (sealed) return messages
    const base = pending ?? inspirationPendingMessage(undefined, event)
    const next = { ...base, content: mergeStreamingText(base.content, event.content), itemId: event.itemId, streamId: event.streamId, sequence: event.sequence }
    return pendingIndex < 0 ? [...messages, next] : messages.map((message, index) => index === pendingIndex ? next : message)
  }
  if (event.kind === 'response') {
    if (!event.content.trim()) return messages
    if (messages.some(message => belongs(message, event) && message.isFinal && (event.streamId ? message.streamId === event.streamId : event.itemId ? message.itemId === event.itemId : false))) return messages
    if (responseIndex >= 0) {
      const previous = messages[responseIndex]
      if (previous.isFinal || previous.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return messages
      return messages.map((message, index) => index === responseIndex ? inspirationProgressMessage(previous, event) : message)
    }
    const progress = inspirationProgressMessage(pending, event)
    const blank = inspirationPendingMessage(pending, event)
    if (pendingIndex < 0) return [...messages, progress, blank]
    return [...messages.slice(0, pendingIndex), progress, blank, ...messages.slice(pendingIndex + 1)]
  }
  if (event.kind === 'answer') {
    if (messages.some(message => belongs(message, event) && message.isFinal && message.content.trim() === event.content.trim())) return messages
    // A legacy provider may have no item ID. Its last completed snapshot can
    // still be promoted in place when it is exactly this final answer.
    let finalIndex = responseIndex
    if (finalIndex < 0) for (let i = messages.length - 1; i >= 0; i--) {
      if (belongs(messages[i], event) && messages[i].phase === 'commentary' && messages[i].content.trim() === event.content.trim()) { finalIndex = i; break }
    }
    const final = inspirationFinalMessage(pending, finalIndex < 0 ? undefined : messages[finalIndex], event)
    if (finalIndex >= 0) return messages.flatMap((message, index) => index === finalIndex ? [final] : index === pendingIndex ? [] : [message])
    return pendingIndex < 0 ? [...messages, final] : messages.map((message, index) => index === pendingIndex ? final : message)
  }
  return messages
}
