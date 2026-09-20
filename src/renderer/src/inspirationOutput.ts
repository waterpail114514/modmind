import type { CodingResult, InspirationChatMessage } from '../../shared/types'
import { replayUserText } from '../../shared/aiReplay'
import { isUsableAiAnswer } from '../../shared/aiOutput'
import type { AiOutputEvent, ConversationEventRecord } from '../../shared/types'
import { aiNoticeDetails, presentLegacyAiNotice } from '../../shared/aiNotice'

type IdFactory = () => string

/** Shared by live events and replay so retry attempts update a single row. */
export function upsertInspirationNotice(messages: InspirationChatMessage[], event: AiOutputEvent): InspirationChatMessage[] {
  if (!event.notice) return messages
  const matches = (message: InspirationChatMessage): boolean => message.kind === 'tool'
    && (message.turnId ?? message.sessionId) === (event.turnId ?? event.sessionId)
    && message.notice?.key === event.notice?.key
  const previous = messages.find(matches)
  if (previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return messages
  const item: InspirationChatMessage = {
    role: 'assistant', kind: 'tool', id: previous?.id ?? event.eventId ?? `notice:${event.turnId ?? event.sessionId}:${event.notice.key}`,
    turnId: event.turnId, sessionId: event.sessionId, sequence: event.sequence, time: event.time, content: event.content,
    status: inspirationStepStatus(event), isFinal: false, notice: event.notice
  }
  if (previous) return messages.map(message => matches(message) ? item : message)
  const pending = messages.findIndex(message => message.status === 'streaming' && message.sessionId === event.sessionId)
  if (pending < 0) return [...messages, item]
  return [...messages.slice(0, pending), item, ...messages.slice(pending)]
}

export function inspirationStepStatus(event: Pick<AiOutputEvent, 'kind' | 'terminal'>): 'completed' | 'warning' | 'error' {
  if (event.kind === 'error') return event.terminal === true ? 'error' : 'warning'
  return event.kind === 'warning' ? 'warning' : 'completed'
}

export type InspirationTimelineRow =
  | { id: string; kind: 'tool-group'; items: InspirationChatMessage[] }
  | { id: string; kind: 'message'; message: InspirationChatMessage; index: number }

export function buildInspirationRows(messages: InspirationChatMessage[]): InspirationTimelineRow[] {
  const rows: InspirationTimelineRow[] = []
  let tools: InspirationChatMessage[] = []
  const flushTools = (): void => {
    if (!tools.length) return
    rows.push({ id: `steps-${tools[0].id ?? rows.length}`, kind: 'tool-group', items: tools })
    tools = []
  }
  messages.forEach((message, index) => {
    if (message.kind === 'tool') {
      tools.push(message)
      return
    }
    flushTools()
    if (message.role === 'user' || (message.role === 'assistant' && (message.isFinal || message.status === 'streaming'))) {
      rows.push({ id: `${message.sessionId ?? message.role}-${index}`, kind: 'message', message, index })
    }
  })
  flushTools()
  return rows
}

function mergeOutputText(current: string, incoming: string): string {
  if (!current || incoming.startsWith(current)) return incoming
  if (!incoming || current.endsWith(incoming)) return current
  return `${current}${incoming}`
}

/** Rebuilds a stale view from events that were durably committed before a crash. */
export function replayInspirationEvents(messages: InspirationChatMessage[], events: ConversationEventRecord[]): InspirationChatMessage[] {
  let result = [...messages]
  const lastViewSequence = Math.max(0, ...messages.map((message) => message.sequence ?? 0))
  for (const record of events.filter((event) => event.kind === 'output' && event.sequence > lastViewSequence).sort((left, right) => left.sequence - right.sequence)) {
    if (!record.payload || typeof record.payload !== 'object') continue
    const raw = record.payload as AiOutputEvent
    const event = raw.kind === 'warning' || raw.kind === 'error' ? { ...raw, content: presentLegacyAiNotice(raw.content, raw.kind === 'warning') } : raw
    const turnId = event.turnId ?? record.turnId
    if (event.notice && event.terminal !== true && (event.kind === 'retry' || event.kind === 'warning')) {
      result = upsertInspirationNotice(result, { ...event, turnId, eventId: record.eventId, sequence: record.sequence })
      continue
    }
    let index = result.findIndex((message) => message.role === 'assistant' && message.turnId === turnId && message.kind !== 'tool')
    if (event.kind === 'delta' || event.kind === 'response') {
      if (index < 0) result.push({ role: 'assistant', id: `${turnId}:assistant`, turnId, content: event.content, status: 'streaming', isFinal: false, sessionId: event.sessionId, sequence: record.sequence })
      else {
        const message = result[index]
        result[index] = { ...message, content: event.kind === 'delta' ? mergeOutputText(message.content, event.content) : event.content || message.content, sequence: record.sequence }
      }
      continue
    }
    if (event.kind === 'answer') {
      const completed: InspirationChatMessage = { role: 'assistant', id: `${turnId}:assistant`, turnId, content: event.content, status: 'completed', isFinal: true, sessionId: event.sessionId, time: event.time, sequence: record.sequence }
      if (index < 0) result.push(completed)
      else result[index] = completed
      continue
    }
    if ((event.kind === 'error' || event.kind === 'warning') && event.terminal === true) {
      const status = event.kind === 'warning' ? event.notice?.key === 'context-stall' ? 'warning' as const : 'cancelled' as const : 'error' as const
      const failed: InspirationChatMessage = {
        ...(index >= 0 ? result[index] : { role: 'assistant' as const, id: `${turnId}:assistant`, turnId }),
        content: event.content, notice: event.notice, status, isFinal: true, sessionId: event.sessionId, time: event.time, sequence: record.sequence
      }
      if (index < 0) result.push(failed)
      else {
        const provisional = result[index]
        const progress = provisional.content.trim() && provisional.content.trim() !== event.content.trim()
          ? { ...provisional, kind: 'tool' as const, id: `${record.eventId}:partial`, status: 'completed' as const, isFinal: false, sequence: record.sequence }
          : null
        result.splice(index, 1, ...(progress ? [progress] : []), failed)
      }
      continue
    }
    if (!event.content.trim()) continue
    const step: InspirationChatMessage = { role: 'assistant', kind: 'tool', id: record.eventId, turnId, content: event.content, time: event.time, status: inspirationStepStatus(event), isFinal: false, sessionId: event.sessionId, sequence: record.sequence }
    if (!result.some((message) => message.id === step.id)) {
      index = result.findIndex((message) => message.role === 'assistant' && message.turnId === turnId && message.kind !== 'tool')
      if (index < 0) result.push(step)
      else result.splice(index, 0, step)
    }
  }
  return result
}

export function deleteInspirationTimelineItem(messages: InspirationChatMessage[], messageIndex: number): InspirationChatMessage[] {
  if (messageIndex < 0 || messageIndex >= messages.length) return messages
  let start = messageIndex
  while (start > 0 && messages[start].role !== 'user') start -= 1
  let end = messageIndex + 1
  while (end < messages.length && messages[end].role !== 'user') end += 1
  return [...messages.slice(0, start), ...messages.slice(end)]
}

export function rewindInspirationTimelineTo(messages: InspirationChatMessage[], messageIndex: number): InspirationChatMessage[] {
  const selected = messages[messageIndex]
  if (!selected) return messages
  return messages.slice(0, selected.role === 'user' ? messageIndex : messageIndex + 1)
}

function defaultId(): string {
  return `inspiration-step-${Date.now()}-${crypto.randomUUID()}`
}

function progressStep(message: InspirationChatMessage, sessionId: string, createId: IdFactory): InspirationChatMessage | null {
  if (!message.content.trim()) return null
  return {
    role: 'assistant', kind: 'tool', id: createId(), content: message.content,
    status: 'completed', isFinal: false, sessionId
  }
}

export function finalInspirationReply(result: Pick<CodingResult, 'finalResponse' | 'summary'>): string {
  return isUsableAiAnswer(result.finalResponse) ? result.finalResponse.trim() : ''
}

export function shouldResumeInspirationSession(messages: InspirationChatMessage[]): boolean {
  return messages.some((message) => message.role === 'user')
}

export function inspirationConversationHandoff(messages: InspirationChatMessage[], maxChars = 120_000): string {
  const transcript = messages
    .filter((message) => message.kind !== 'tool' && (message.role === 'user' || message.isFinal))
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.role === 'user' ? replayUserText(message.content, message.replay) : message.content.trim()}`)
    .filter((line) => !line.endsWith(':'))
    .join('\n\n')
  if (!transcript) return ''
  return transcript.length <= maxChars ? transcript : transcript.slice(-maxChars)
}

export function settleInspirationReply(
  messages: InspirationChatMessage[],
  sessionId: string,
  reply: string,
  invalidMessage: string,
  createId: IdFactory = defaultId
): InspirationChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant' || message.status !== 'streaming' || message.sessionId !== sessionId) return [message]
    const progress = message.content.trim() && message.content.trim() !== reply.trim() ? progressStep(message, sessionId, createId) : null
    const valid = isUsableAiAnswer(reply)
    return [
      ...(progress ? [progress] : []),
      {
        id: message.id,
        turnId: message.turnId,
        role: 'assistant' as const,
        content: valid ? reply.trim() : invalidMessage,
        status: valid ? 'completed' as const : 'error' as const,
        isFinal: true,
        sessionId,
        time: new Date().toISOString()
      }
    ]
  })
}

export function settleInspirationFailure(
  messages: InspirationChatMessage[],
  sessionId: string,
  failure: string,
  createId: IdFactory = defaultId
): InspirationChatMessage[] {
  return settleInspirationReply(messages, sessionId, '', failure, createId).map(message =>
    message.sessionId === sessionId && message.isFinal && message.content === failure
      ? { ...message, notice: aiNoticeDetails('error', failure), ...(/连续整理上下文/.test(failure) ? { status: 'warning' as const } : {}) }
      : message)
}

export function settleInspirationCancellation(
  messages: InspirationChatMessage[],
  sessionId: string,
  createId: IdFactory = defaultId
): InspirationChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant' || message.status !== 'streaming' || message.sessionId !== sessionId) return [message]
    const progress = message.content.trim() && message.content !== '正在停止任务…' ? progressStep(message, sessionId, createId) : null
    return [
      ...(progress ? [progress] : []),
      { role: 'assistant' as const, content: '请求已暂停', status: 'cancelled' as const, isFinal: true, sessionId, time: new Date().toISOString() }
    ]
  })
}
