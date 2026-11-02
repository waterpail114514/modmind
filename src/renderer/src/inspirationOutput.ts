import { inspirationActivityId, inspirationActivityItem, settleInspirationActivities, upsertInspirationActivity } from './inspirationActivity'
import { INSPIRATION_STAGE_PROGRESS, inspirationProgressOutput, settleInspirationProgress } from './inspirationProgress'
import { inspirationResponseId, inspirationProgressMessage, inspirationPendingMessage, inspirationFinalMessage } from './inspirationText'
import type { CodingResult, InspirationChatMessage } from '../../shared/types'
import { replayUserText } from '../../shared/aiReplay'
import { mergeContextUsage } from '../../shared/contextUsage'
import type { AiOutputEvent, ConversationEventRecord, PipelineEvent } from '../../shared/types'
import { aiNoticeDetails, presentLegacyAiNotice } from '../../shared/aiNotice'
import { isInspirationProtocol } from '../../shared/inspirationWorkflow'
import { ReplayTextBuffer } from './replayTextBuffer'
import { mergeAgentReasoning } from './agentReasoning'

type IdFactory = () => string

/** Draft artifacts share the answer row; only host finalization completes a tool-only answer. */
export function applyInspirationArtifact(messages: InspirationChatMessage[], event: AiOutputEvent): InspirationChatMessage[] {
  if (!event.inspirationArtifact) return messages
  const index = messages.findIndex(m => m.role === 'assistant' && !m.kind && m.phase !== 'commentary'
    && (event.turnId && m.turnId === event.turnId || event.sessionId && m.sessionId === event.sessionId))
  if (index < 0) return [...messages, { role: 'assistant', id: `${event.turnId}:assistant`, turnId: event.turnId,
    sessionId: event.sessionId, generation: event.generation, inspirationFeatures: event.inspirationFeatures,
    content: '', status: event.inspirationArtifact.finalized ? 'completed' : 'streaming', isFinal: event.inspirationArtifact.finalized,
    inspirationArtifact: event.inspirationArtifact, sequence: event.sequence }]
  if (messages[index].sequence !== undefined && event.sequence !== undefined && messages[index].sequence! >= event.sequence) return messages
  return messages.map((m, i) => i === index ? { ...m, inspirationArtifact: event.inspirationArtifact,
    ...(event.inspirationArtifact!.finalized ? { status: 'completed', isFinal: true } as const : {}), sequence: event.sequence ?? m.sequence } : m)
}

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
  const pending = messages.findIndex(message => !message.kind && message.status === 'streaming' && message.sessionId === event.sessionId)
  if (pending < 0) return [...messages, item]
  return [...messages.slice(0, pending), item, ...messages.slice(pending)]
}

export function inspirationStepStatus(event: Pick<AiOutputEvent, 'kind' | 'terminal'>): 'completed' | 'warning' | 'error' {
  if (event.kind === 'error') return event.terminal === true ? 'error' : 'warning'
  return event.kind === 'warning' || event.kind === 'retry' ? 'warning' : 'completed'
}

export function upsertInspirationProgress(messages: InspirationChatMessage[], event: PipelineEvent): InspirationChatMessage[] {
  const output = inspirationProgressOutput(event)
  const id = output.activity ? inspirationActivityId(output) : undefined
  const previous = id ? messages.find(message => message.id === id) : undefined
  if (previous?.sequence !== undefined && output.sequence !== undefined && previous.sequence >= output.sequence) return messages
  const settled = settleInspirationProgress(messages, output.sessionId, id)
  return output.notice ? upsertInspirationNotice(settled, output) : upsertInspirationActivity(settled, output)
}

export type InspirationTimelineRow =
  | { id: string; kind: 'tool-group'; items: InspirationChatMessage[] }
  | { id: string; kind: 'reasoning'; message: InspirationChatMessage }
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
    if (message.kind === 'reasoning') {
      flushTools()
      rows.push({ id: message.id ?? `reasoning-${index}`, kind: 'reasoning', message })
      return
    }
    if (message.kind === 'tool') {
      tools.push(message)
      return
    }
    flushTools()
    rows.push({ id: message.id ?? `${message.sessionId ?? message.role}-${index}`, kind: 'message', message, index })
  })
  flushTools()
  return rows
}

function reasoningId(event: AiOutputEvent): string {
  return `reasoning:${JSON.stringify([event.turnId ?? event.runId ?? event.sessionId, event.streamId ?? event.itemId ?? 'reasoning'])}`
}

function inspirationReasoningItem(previous: InspirationChatMessage | undefined, event: AiOutputEvent): InspirationChatMessage | undefined {
  if (!event.reasoning || previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return previous
  if (previous?.status === 'completed' && previous.reasoningCompleted !== false && event.reasoning.phase !== 'completed') return previous
  const reasoning = mergeAgentReasoning(previous?.reasoning, event)
  if (!reasoning) return previous
  return { ...previous, id: reasoningId(event), role: 'assistant', kind: 'reasoning', isFinal: false, reasoning, reasoningCompleted: event.reasoning.phase === 'completed',
    content: [...reasoning.summary, ...reasoning.text].filter(Boolean).join('\n\n'),
    status: event.reasoning.phase === 'completed' ? 'completed' : 'streaming', time: previous?.time ?? event.time,
    turnId: event.turnId, sessionId: event.sessionId, sequence: event.sequence }
}

/** Reasoning is a separate row, never the answer placeholder or a handoff prompt. */
export function upsertInspirationReasoning(messages: InspirationChatMessage[], event: AiOutputEvent): InspirationChatMessage[] {
  const id = reasoningId(event)
  const index = messages.findIndex(message => message.kind === 'reasoning' && message.id === id)
  const previous = index < 0 ? undefined : messages[index]
  const next = inspirationReasoningItem(previous, event)
  if (!next || next === previous) return messages
  if (index >= 0) return messages.map((message, i) => i === index ? next : message)
  const pending = messages.findIndex(message => !message.kind && message.role === 'assistant' && message.status === 'streaming'
    && (event.turnId ? message.turnId === event.turnId : message.sessionId === event.sessionId))
  return pending < 0 ? [...messages, next] : [...messages.slice(0, pending), next, ...messages.slice(pending)]
}

export function settleInspirationReasoning(messages: InspirationChatMessage[], sessionId: string): InspirationChatMessage[] {
  return messages.map(message => message.kind === 'reasoning' && message.sessionId === sessionId && message.status === 'streaming'
    ? { ...message, status: 'completed', reasoningCompleted: true } : message)
}

/** Rebuilds a stale view from events that were durably committed before a crash. */
export function replayInspirationEvents(messages: InspirationChatMessage[], events: ConversationEventRecord[]): InspirationChatMessage[] {
  const replay = replayInspirationSteps(messages, events)
  let step = replay.next()
  while (!step.done) step = replay.next()
  return step.value
}

/** Yield between replay batches so opening a long history leaves the UI usable. */
export async function replayInspirationEventsAsync(
  messages: InspirationChatMessage[],
  events: ConversationEventRecord[],
  isCancelled: () => boolean = () => false
): Promise<InspirationChatMessage[]> {
  const yieldToUi = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  await yieldToUi()
  const replay = replayInspirationSteps(messages, events)
  let sliceStarted = performance.now()
  while (true) {
    if (isCancelled()) throw new DOMException('History loading cancelled', 'AbortError')
    const step = replay.next()
    if (step.done) return step.value
    if (performance.now() - sliceStarted >= 8) {
      await yieldToUi()
      sliceStarted = performance.now()
    }
  }
}

type InspirationReplayNode = { message: InspirationChatMessage; next?: InspirationReplayNode; previous?: InspirationReplayNode }

/** Tool steps insert before an answer without shifting every later message. */
class InspirationReplayList {
  private head?: InspirationReplayNode
  private tail?: InspirationReplayNode
  private historyCursor?: InspirationReplayNode
  private historyCursorStarted = false
  private readonly textResponses = new Map<string, InspirationReplayNode>()
  private readonly lastTextResponse = new Map<string | undefined, InspirationReplayNode>()
  private readonly assistants = new Map<string | undefined, InspirationReplayNode>()
  private readonly activities = new Map<string, InspirationReplayNode>()
  private readonly runningActivities = new Map<string | undefined, Set<InspirationReplayNode>>()
  private readonly thoughts = new Map<string, InspirationReplayNode>()
  private readonly runningThoughts = new Map<string | undefined, Set<InspirationReplayNode>>()
  private readonly ids = new Map<string, number>()
  private readonly notices = new Map<string, Set<InspirationReplayNode>>()
  private readonly streaming = new Map<string | undefined, Set<InspirationReplayNode>>()
  private readonly pendingText = new WeakMap<InspirationReplayNode, ReplayTextBuffer>()
  private usage: InspirationChatMessage['usage']
  private beforeUsageTail: InspirationChatMessage['usage']
  private usageTail?: InspirationReplayNode
  private usageDirty = false

  assistant(turnId: string): InspirationReplayNode | undefined { return this.assistants.get(turnId) }
  hasId(id: string | undefined): boolean { return id !== undefined && this.ids.has(id) }
  textClosed(event: AiOutputEvent): boolean {
    if (!event.streamId && !event.itemId) return false
    if (this.textResponses.has(inspirationResponseId(event))) return true
    const final = this.assistants.get(event.turnId)?.message
    return Boolean(final?.status === 'completed' && (event.streamId ? final.streamId === event.streamId : final.itemId === event.itemId))
  }
  delta(node: InspirationReplayNode, content: string, sequence: number): void {
    let text = this.pendingText.get(node)
    if (!text) { text = new ReplayTextBuffer(node.message.content); this.pendingText.set(node, text) }
    text.append(content)
    this.replace(node, { ...node.message, content: '', sequence })
  }
  flush(node: InspirationReplayNode): void {
    const text = this.pendingText.get(node)
    if (!text) return
    this.pendingText.delete(node)
    this.replace(node, { ...node.message, content: text.value() })
  }
  private noticeKey(message: InspirationChatMessage): string | undefined {
    return message.kind === 'tool' && message.notice ? JSON.stringify([message.turnId ?? message.sessionId, message.notice.key]) : undefined
  }
  private index(node: InspirationReplayNode, previous?: InspirationChatMessage): void {
    const message = node.message
    if (previous?.id !== message.id) {
      if (previous?.id) {
        const count = this.ids.get(previous.id)! - 1
        if (count) this.ids.set(previous.id, count)
        else this.ids.delete(previous.id)
      }
      if (message.id) this.ids.set(message.id, (this.ids.get(message.id) ?? 0) + 1)
    }
    if (message.role === 'assistant' && !message.kind && message.phase !== 'commentary' && !this.assistants.has(message.turnId)) this.assistants.set(message.turnId, node)
    if (message.phase === 'commentary' && message.id) { this.textResponses.set(message.id, node); this.lastTextResponse.set(message.turnId, node) }
    if (message.activity && message.id) this.activities.set(message.id, node)
    if (previous?.activity?.status === 'running') this.runningActivities.get(previous.turnId)?.delete(node)
    if (message.activity?.status === 'running') {
      let nodes = this.runningActivities.get(message.turnId)
      if (!nodes) { nodes = new Set(); this.runningActivities.set(message.turnId, nodes) }
      nodes.add(node)
    }
    if (message.kind === 'reasoning' && message.id) this.thoughts.set(message.id, node)
    if (previous?.kind === 'reasoning' && previous.status === 'streaming') this.runningThoughts.get(previous.turnId)?.delete(node)
    if (message.kind === 'reasoning' && message.status === 'streaming') {
      let nodes = this.runningThoughts.get(message.turnId)
      if (!nodes) { nodes = new Set(); this.runningThoughts.set(message.turnId, nodes) }
      nodes.add(node)
    }
    const oldNotice = previous && this.noticeKey(previous)
    const notice = this.noticeKey(message)
    if (oldNotice !== notice) {
      if (oldNotice) this.notices.get(oldNotice)?.delete(node)
      if (notice) { let rows = this.notices.get(notice); if (!rows) { rows = new Set(); this.notices.set(notice, rows) }; rows.add(node) }
    }
    const oldStreaming = !previous?.kind && previous?.status === 'streaming'
    const nowStreaming = !message.kind && message.status === 'streaming'
    if (oldStreaming !== nowStreaming || previous?.sessionId !== message.sessionId) {
      if (oldStreaming) this.streaming.get(previous?.sessionId)?.delete(node)
      if (nowStreaming) { let rows = this.streaming.get(message.sessionId); if (!rows) { rows = new Set(); this.streaming.set(message.sessionId, rows) }; rows.add(node) }
    }
  }
  push(message: InspirationChatMessage): InspirationReplayNode {
    const node = { message, previous: this.tail }
    if (this.tail) this.tail.next = node
    else this.head = node
    this.tail = node
    this.index(node)
    if (message.usage && !this.usageDirty) { this.beforeUsageTail = this.usage; this.usage = mergeContextUsage(this.usage, message.usage); this.usageTail = node }
    return node
  }
  insertBefore(anchor: InspirationReplayNode, message: InspirationChatMessage): void {
    const node = { message, next: anchor, previous: anchor.previous }
    if (anchor.previous) anchor.previous.next = node
    else this.head = node
    anchor.previous = node
    this.index(node)
    if (message.usage) this.usageDirty = true
  }
  private insertHistorical(message: InspirationChatMessage): void {
    let anchor = this.historyCursorStarted ? this.historyCursor : this.head
    this.historyCursorStarted = true
    while (anchor && (anchor.message.sequence === undefined || anchor.message.sequence <= (message.sequence ?? 0))) anchor = anchor.next
    this.historyCursor = anchor
    if (anchor) this.insertBefore(anchor, message)
    else this.push(message)
  }
  replace(node: InspirationReplayNode, message: InspirationChatMessage): void {
    const previous = node.message
    node.message = message
    this.index(node, previous)
    if (previous.usage !== message.usage) {
      if (!this.usageDirty && this.usageTail === node && message.usage) this.usage = mergeContextUsage(this.beforeUsageTail, message.usage)
      else if (!this.usageDirty && !previous.usage && message.usage && node === this.tail) {
        this.beforeUsageTail = this.usage; this.usage = mergeContextUsage(this.usage, message.usage); this.usageTail = node
      } else this.usageDirty = true
    }
  }
  latestUsage(): InspirationChatMessage['usage'] {
    if (this.usageDirty) {
      this.usage = undefined; this.usageTail = undefined; this.beforeUsageTail = undefined
      for (let node = this.head; node; node = node.next) if (node.message.usage) {
        this.beforeUsageTail = this.usage; this.usage = mergeContextUsage(this.usage, node.message.usage); this.usageTail = node
      }
      this.usageDirty = false
    }
    return this.usage
  }
  notice(event: AiOutputEvent, historical = false): void {
    const key = JSON.stringify([event.turnId ?? event.sessionId, event.notice!.key])
    const rows = this.notices.get(key)
    const previous = rows?.values().next().value?.message
    if (previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return
    const message: InspirationChatMessage = { role: 'assistant', kind: 'tool', id: previous?.id ?? event.eventId ?? `notice:${event.turnId ?? event.sessionId}:${event.notice!.key}`, turnId: event.turnId, sessionId: event.sessionId, sequence: event.sequence, time: event.time, content: event.content, status: inspirationStepStatus(event), isFinal: false, notice: event.notice }
    if (rows?.size) { for (const node of rows) this.replace(node, message); return }
    if (historical) { this.insertHistorical(message); return }
    const pending = this.streaming.get(event.sessionId)?.values().next().value
    if (pending) this.insertBefore(pending, message)
    else this.push(message)
  }
  response(event: AiOutputEvent): void {
    if (!event.content.trim()) return
    const id = inspirationResponseId(event), previous = this.textResponses.get(id), pending = this.assistant(event.turnId ?? '')
    if (previous?.message.isFinal || previous?.message.sequence !== undefined && event.sequence !== undefined && previous.message.sequence >= event.sequence) return
    if (pending?.message.isFinal && (event.streamId && pending.message.streamId === event.streamId || event.itemId && pending.message.itemId === event.itemId)) return
    const progress = inspirationProgressMessage(pending?.message, event)
    if (previous) { this.replace(previous, progress); return }
    if (pending) {
      this.insertBefore(pending, progress)
      this.replace(pending, inspirationPendingMessage(pending.message, event))
    } else {
      this.push(progress)
      this.push(inspirationPendingMessage(undefined, event))
    }
  }
  answer(event: AiOutputEvent): void {
    const pending = this.assistant(event.turnId ?? '')
    if (pending?.message.isFinal && pending.message.content.trim() === event.content.trim()) return
    const exact = this.textResponses.get(inspirationResponseId(event)), last = this.lastTextResponse.get(event.turnId)
    const previous = exact ?? (last?.message.content.trim() === event.content.trim() ? last : undefined)
    const completed = inspirationFinalMessage(pending?.message, previous?.message, event)
    if (previous) {
      this.replace(previous, completed)
      if (pending && pending !== previous) this.remove(pending)
      this.assistants.set(event.turnId, previous)
    } else if (pending) this.replace(pending, completed)
    else this.push(completed)
  }
  private remove(node: InspirationReplayNode): void {
    if (node.previous) node.previous.next = node.next; else this.head = node.next
    if (node.next) node.next.previous = node.previous; else this.tail = node.previous
    if (this.assistants.get(node.message.turnId) === node) this.assistants.delete(node.message.turnId)
    if (node.message.id) {
      const count = (this.ids.get(node.message.id) ?? 1) - 1
      if (count) this.ids.set(node.message.id, count); else this.ids.delete(node.message.id)
    }
    this.streaming.get(node.message.sessionId)?.delete(node)
    this.pendingText.delete(node)
    this.usageDirty = true
  }
  activity(event: AiOutputEvent, historical = false): void {
    const node = this.activities.get(inspirationActivityId(event))
    const message = inspirationActivityItem(node?.message, event)
    if (!message || message === node?.message) return
    if (node) this.replace(node, message)
    else if (historical) this.insertHistorical(message)
    else { const answer = this.assistant(event.turnId ?? ''); if (answer) this.insertBefore(answer, message); else this.push(message) }
  }
  settleProgress(turnId: string, exceptId?: string): void {
    for (const node of [...this.runningActivities.get(turnId) ?? []]) {
      if (node.message.id !== exceptId && node.message.activity?.tool === INSPIRATION_STAGE_PROGRESS) {
        this.replace(node, { ...node.message, status: 'completed', activity: { ...node.message.activity, status: 'completed' } })
      }
    }
  }
  progress(event: PipelineEvent, historical = false): void {
    const output = inspirationProgressOutput(event)
    const id = output.activity ? inspirationActivityId(output) : undefined
    const previous = id ? this.activities.get(id)?.message : undefined
    if (previous?.sequence !== undefined && output.sequence !== undefined && previous.sequence >= output.sequence) return
    if (!historical) this.settleProgress(event.turnId ?? '', id)
    else if (output.activity?.status === 'running') output.activity = { ...output.activity, status: 'completed', completedAt: event.time }
    if (output.notice) this.notice(output, historical)
    else this.activity(output, historical)
  }
  reasoning(event: AiOutputEvent): void {
    const node = this.thoughts.get(reasoningId(event))
    const message = inspirationReasoningItem(node?.message, event)
    if (!message || message === node?.message) return
    if (node) this.replace(node, message)
    else {
      const answer = this.assistant(event.turnId ?? '')
      if (answer) this.insertBefore(answer, message)
      else this.push(message)
    }
  }
  settleReasoning(turnId: string): void {
    for (const node of [...this.runningActivities.get(turnId) ?? []]) if (node.message.activity?.status === 'running') {
      this.replace(node, { ...node.message, status: 'warning', activity: { ...node.message.activity, status: 'interrupted' } })
    }
    for (const node of [...this.runningThoughts.get(turnId) ?? []]) {
      this.replace(node, { ...node.message, status: 'completed', reasoningCompleted: true })
    }
  }
  toArray(): InspirationChatMessage[] {
    const result: InspirationChatMessage[] = []
    for (let node = this.head; node; node = node.next) { this.flush(node); result.push(node.message) }
    return result
  }
}

function* replayInspirationSteps(messages: InspirationChatMessage[], events: ConversationEventRecord[]): Generator<void, InspirationChatMessage[], void> {
  const result = new InspirationReplayList()
  let lastViewSequence = 0
  for (const message of messages) {
    yield
    result.push(message)
    lastViewSequence = Math.max(lastViewSequence, message.sequence ?? 0)
  }
  // Older projections omitted this whole channel. Backfill its durable records
  // without replaying already-saved text/artifacts or overwriting user edits.
  for (const record of events.filter(event => event.kind === 'progress' && event.sequence <= lastViewSequence).sort((a, b) => a.sequence - b.sequence)) {
    yield
    if (record.payload && typeof record.payload === 'object') result.progress({ ...record.payload as PipelineEvent,
      turnId: record.turnId, sequence: record.sequence, eventId: record.eventId, runId: record.runId ?? (record.payload as PipelineEvent).runId }, true)
  }
  for (const record of events.filter((event) => (event.kind === 'output' || event.kind === 'progress') && event.sequence > lastViewSequence).sort((left, right) => left.sequence - right.sequence)) {
    yield
    if (!record.payload || typeof record.payload !== 'object') continue
    if (record.kind === 'progress') {
      result.progress({ ...record.payload as PipelineEvent, turnId: record.turnId, sequence: record.sequence,
        eventId: record.eventId, runId: record.runId ?? (record.payload as PipelineEvent).runId })
      continue
    }
    const raw = record.payload as AiOutputEvent
    let event = raw.kind === 'warning' || raw.kind === 'error' ? { ...raw, content: presentLegacyAiNotice(raw.content, raw.kind === 'warning') } : raw
    if (event.usage) event = { ...event, usage: mergeContextUsage(result.latestUsage(), event.usage) }
    const turnId = event.turnId ?? record.turnId
    if (event.kind !== 'usage' && event.kind !== 'reasoning') result.settleProgress(turnId)
    if (event.activity) { result.activity({ ...event, turnId, sequence: record.sequence }); continue }
    if (event.kind === 'reasoning') {
      result.reasoning({ ...event, turnId, eventId: record.eventId, sequence: record.sequence })
      continue
    }
    if (event.kind === 'answer' || (event.kind === 'error' || event.kind === 'warning') && event.terminal === true) result.settleReasoning(turnId)
    if (event.notice && event.terminal !== true && (event.kind === 'retry' || event.kind === 'warning')) {
      result.notice({ ...event, turnId, eventId: record.eventId, sequence: record.sequence })
      continue
    }
    const node = result.assistant(turnId)
    if (event.inspirationArtifact) {
      if (node) result.replace(node, { ...node.message, inspirationArtifact: event.inspirationArtifact, sequence: record.sequence,
        ...(event.inspirationArtifact.finalized ? { status: 'completed', isFinal: true } as const : {}) })
      else result.push({ role: 'assistant', inspirationFeatures: event.inspirationFeatures, generation: event.generation,
        id: `${turnId}:assistant`, turnId, content: '', status: event.inspirationArtifact.finalized ? 'completed' : 'streaming', isFinal: event.inspirationArtifact.finalized,
        sessionId: event.sessionId, sequence: record.sequence, inspirationArtifact: event.inspirationArtifact })
      continue
    }
    if (node && event.kind !== 'delta' && event.kind !== 'usage') result.flush(node)
    if (event.kind === 'usage') {
      if (node) result.replace(node!, { ...node!.message, usage: event.usage })
      else if (event.usage) result.push({ role: 'assistant', id: `${turnId}:assistant`, turnId, content: '', status: 'streaming', isFinal: false, sessionId: event.sessionId, usage: event.usage })
      continue
    }
    if (event.kind === 'response') { result.response({ ...event, turnId, sequence: record.sequence }); continue }
    if (event.kind === 'delta') {
      if (result.textClosed({ ...event, turnId })) continue
      if (!node) result.push({ role: 'assistant', inspirationFeatures: event.inspirationFeatures, generation: event.generation, id: `${turnId}:assistant`, turnId, content: event.content, status: 'streaming', isFinal: false, sessionId: event.sessionId, sequence: record.sequence })
      else result.delta(node, event.content, record.sequence)
      continue
    }
    if (event.kind === 'answer') { result.answer({ ...event, turnId, sequence: record.sequence }); continue }
    if ((event.kind === 'error' || event.kind === 'warning') && event.terminal === true) {
      const status = event.kind === 'warning' ? event.notice?.key === 'context-stall' ? 'warning' as const : 'cancelled' as const : 'error' as const
      const failed: InspirationChatMessage = {
        ...(node ? node!.message : { role: 'assistant' as const, id: `${turnId}:assistant`, turnId }),
        content: event.content, notice: event.notice, status, isFinal: true, sessionId: event.sessionId, time: event.time, sequence: record.sequence
      }
      if (!node) result.push(failed)
      else {
        const provisional = node!.message
        const progress = provisional.content.trim() && provisional.content.trim() !== event.content.trim()
          ? { ...provisional, kind: undefined, phase: 'commentary' as const, id: `${record.eventId}:partial`, status: 'completed' as const, isFinal: false, sequence: record.sequence }
          : null
        if (progress) result.insertBefore(node!, progress)
        result.replace(node!, failed)
      }
      continue
    }
    if (!event.content.trim()) continue
    const step: InspirationChatMessage = { role: 'assistant', kind: 'tool', id: record.eventId, turnId, content: event.content, time: event.time, status: inspirationStepStatus(event), isFinal: false, sessionId: event.sessionId, sequence: record.sequence }
    if (!result.hasId(step.id)) {
      if (!node) result.push(step)
      else result.insertBefore(node, step)
    }
  }
  return result.toArray()
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
  if (!message.content.trim() || isInspirationProtocol(message.content)) return null
  return {
    role: 'assistant', phase: 'commentary', id: createId(), content: message.content,
    status: 'completed', isFinal: false, sessionId
  }
}

export function finalInspirationReply(result: Pick<CodingResult, 'finalResponse' | 'summary'>): string {
  // The main process selects the final item. Do not reclassify its wording or
  // require edits: an explanation, a plan, or a quoted status can be an answer.
  return result.finalResponse?.trim() ?? ''
}

export function shouldResumeInspirationSession(messages: InspirationChatMessage[]): boolean {
  return messages.some((message) => message.role === 'user')
}

export function inspirationConversationHandoff(messages: InspirationChatMessage[], maxChars = 120_000): string {
  const transcript = messages
    .filter((message) => !message.kind && (message.role === 'user' || message.isFinal))
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
  return settleInspirationActivities(messages, sessionId).flatMap((message) => {
    if (message.kind === 'reasoning' && message.sessionId === sessionId && message.status === 'streaming') return [{ ...message, status: 'completed', reasoningCompleted: true }]
    if (message.kind || message.role !== 'assistant' || message.status !== 'streaming' || message.sessionId !== sessionId) return [message]
    const progress = message.content.trim() && message.content.trim() !== reply.trim() ? progressStep(message, sessionId, createId) : null
    const valid = Boolean(reply.trim())
    return [
      ...(progress ? [progress] : []),
      {
        ...message,
        id: message.id,
        ...(message.usage ? { usage: message.usage } : {}),
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
  return settleInspirationActivities(messages, sessionId).flatMap((message) => {
    if (message.kind === 'reasoning' && message.sessionId === sessionId && message.status === 'streaming') return [{ ...message, status: 'completed', reasoningCompleted: true }]
    if (message.kind || message.role !== 'assistant' || message.status !== 'streaming' || message.sessionId !== sessionId) return [message]
    const progress = message.content.trim() && message.content !== '正在停止任务…' ? progressStep(message, sessionId, createId) : null
    return [
      ...(progress ? [progress] : []),
      { ...message, role: 'assistant' as const, content: isInspirationProtocol(message.content) ? message.content : '请求已暂停', status: 'cancelled' as const, isFinal: true, sessionId, time: new Date().toISOString() }
    ]
  })
}
