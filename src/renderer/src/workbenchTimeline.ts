import { normalizeAiTurnReplay, replayUserText } from '../../shared/aiReplay'
import { contextTokens, latestContextUsage, mergeContextUsage } from '../../shared/contextUsage'
import { presentLegacyAiNotice } from '../../shared/aiNotice'
import { ReplayTextBuffer } from './replayTextBuffer'
import { mergeAgentReasoning } from './agentReasoning'
import type { AiNotice, AiOutputEvent, AiTokenUsage, AiTurnReplay, ConversationEventRecord, PipelineEvent } from '../../shared/types'

export type WorkbenchTimelineDiff = { path: string; added: number; removed: number; additions: string[]; removals: string[] }

export type WorkbenchTimelineItem = {
  activity?: import('../../shared/aiActivity').AiActivity
  changedFiles?: string[]
  notice?: AiNotice
  id: string
  kind: 'user' | 'answer' | 'response' | 'thinking' | 'reasoning' | 'tool' | 'diff' | 'warning' | 'error' | 'start' | 'retry' | 'history' | 'status'
  reasoning?: { summary: string[]; text: string[] }
  content: string
  time: string
  runId?: string
  turnId?: string
  itemId?: string
  streamId?: string
  eventId?: string
  stage?: string
  connectionActivity?: string
  sequence?: number
  activityOrder?: number
  status?: 'running' | 'done' | 'warning' | 'error'
  terminal?: boolean
  recoverable?: boolean
  diff?: WorkbenchTimelineDiff[]
  usage?: AiTokenUsage
  replay?: AiTurnReplay
}

/** Latest usage in the timeline; recovers the context badge after a restart. */
export function latestWorkbenchUsage(items: WorkbenchTimelineItem[], selection?: Pick<AiTokenUsage, 'model' | 'backend'>): AiTokenUsage | undefined {
  return latestContextUsage(items, selection)
}

export type WorkbenchContextUsageState =
  | { kind: 'waiting' }
  | { kind: 'tokens' }
  | { kind: 'capacity'; ratio: number; percent: number }

export function workbenchContextUsageState(usage: AiTokenUsage | undefined): WorkbenchContextUsageState {
  if (!usage) return { kind: 'waiting' }
  const hasReportedTokens = [usage.contextTokens, usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]
    .some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  if (!hasReportedTokens) return { kind: 'waiting' }
  const used = contextTokens(usage)
  if (typeof usage.contextWindow !== 'number' || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0
    || used === undefined) {
    return { kind: 'tokens' }
  }
  const ratio = used / usage.contextWindow
  return { kind: 'capacity', ratio, percent: Math.min(100, Math.max(0, Math.round(ratio * 100))) }
}

function bounded(items: WorkbenchTimelineItem[]): WorkbenchTimelineItem[] {
  return items
}

function findLastMatchingIndex(items: WorkbenchTimelineItem[], predicate: (item: WorkbenchTimelineItem, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index
  }
  return -1
}

function eventIdentity(event: Pick<AiOutputEvent, 'runId' | 'sessionId' | 'time' | 'turnId' | 'eventId' | 'itemId'> & { sequence?: number }): string {
  return event.itemId || event.eventId || (event.sequence !== undefined ? `seq-${event.sequence}` : undefined)
    || `${event.runId || event.sessionId || event.turnId || 'event'}:${event.time}`
}

function streamIdentity(event: AiOutputEvent): string {
  return event.streamId || event.itemId || (event.turnId ? `${event.turnId}:assistant` : event.runId || event.sessionId || eventIdentity(event))
}

function sameOutputTurn(item: WorkbenchTimelineItem, event: AiOutputEvent): boolean {
  return (item.turnId ?? item.runId) === (event.turnId ?? event.runId ?? event.sessionId)
}

function uniqueTimelineId(items: WorkbenchTimelineItem[], base: string): string {
  const ids = new Set(items.map((item) => item.id))
  let id = base
  for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}:${suffix}`
  return id
}

/** Sequence is authoritative for replay. The index fallback keeps legacy items stable. */
function orderTimeline(items: WorkbenchTimelineItem[]): WorkbenchTimelineItem[] {
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = left.item.activityOrder ?? (Number.isSafeInteger(left.item.sequence) ? left.item.sequence! : Number.MAX_SAFE_INTEGER)
    const b = right.item.activityOrder ?? (Number.isSafeInteger(right.item.sequence) ? right.item.sequence! : Number.MAX_SAFE_INTEGER)
    const at = Date.parse(left.item.time)
    const bt = Date.parse(right.item.time)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
    if (a !== b && a !== Number.MAX_SAFE_INTEGER && b !== Number.MAX_SAFE_INTEGER) return a - b
    if (a !== b) return a === Number.MAX_SAFE_INTEGER ? -1 : 1
    return left.index - right.index
  }).map(({ item }) => item)
}

export function isWorkbenchInternalPrompt(content: string): boolean {
  return /^\s*SYSTEM WORKFLOW INSTRUCTIONS:/iu.test(content)
    || /(?:READ-ONLY TURN RULES:|This is a trusted local-agent session\.|Project context and workflows are available at )/iu.test(content)
}

export function normalizeWorkbenchTimeline(items: WorkbenchTimelineItem[]): WorkbenchTimelineItem[] {
  const result: WorkbenchTimelineItem[] = []
  const connections = new Map<string, number>()
  for (const item of orderTimeline(items.filter((item) => !(item.kind === 'user' && isWorkbenchInternalPrompt(item.content))))) {
    const key = connectionActivityIdentity(item)
    const index = key ? connections.get(key) : undefined
    if (index !== undefined) result[index] = mergeConnectionActivity(result[index], item)
    else {
      if (key) connections.set(key, result.length)
      result.push(item)
    }
  }
  return result
}

// Reconnects repeat these host lifecycle messages; domain steps remain separate.
function connectionActivity(item: Pick<WorkbenchTimelineItem, 'kind' | 'content' | 'connectionActivity'>): string | undefined {
  if (item.connectionActivity) return item.connectionActivity
  if (item.kind === 'start') return `start:${item.content}`
  if (item.kind !== 'thinking' && item.kind !== 'tool') return undefined
  const title = item.content.split('\n')[0]
  return ['正在准备工具', 'Codex 已恢复会话', 'Codex 正在分析项目'].includes(title) ? title : undefined
}

function connectionActivityIdentity(item: WorkbenchTimelineItem): string | undefined {
  const activity = connectionActivity(item)
  const turn = item.turnId ?? item.runId
  return activity && turn ? JSON.stringify([turn, activity]) : undefined
}

function mergeConnectionActivity(previous: WorkbenchTimelineItem, incoming: WorkbenchTimelineItem): WorkbenchTimelineItem {
  if (previous.sequence !== undefined && incoming.sequence !== undefined && previous.sequence >= incoming.sequence) return previous
  return { ...previous, ...incoming, id: previous.id, time: previous.time }
}

export function mergeStreamingText(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current || incoming.startsWith(current)) return incoming
  if (current.endsWith(incoming)) return current
  return `${current}${incoming}`
}

export function settleWorkbenchActivity(items: WorkbenchTimelineItem[], thinkingOnly = false): WorkbenchTimelineItem[] {
  let changed = false
  const next = items.map((item) => {
    if (item.status !== 'running' || (thinkingOnly && item.kind !== 'thinking')) return item
    changed = true
    return item.activity?.status === 'running'
      ? { ...item, status: 'warning' as const, activity: { ...item.activity, status: 'interrupted' as const } }
      : { ...item, status: 'done' as const }
  })
  return changed ? next : items
}

export function appendUserTurn(items: WorkbenchTimelineItem[], text: string, runId: string, time = new Date().toISOString(), replay?: AiTurnReplay): WorkbenchTimelineItem[] {
  return bounded([...items, { id: `${runId}:user`, kind: 'user', content: text, time, runId, turnId: `turn-${runId}`, status: 'done', ...(replay ? { replay } : {}) }])
}

/** IPC can fail before the backend emits any output. Keep that failure in the conversation. */
export function appendWorkbenchFailure(items: WorkbenchTimelineItem[], content: string, sessionId: string, time = new Date().toISOString()): WorkbenchTimelineItem[] {
  const turnId = `turn-${sessionId}`
  if (items.some(item => item.kind === 'error' && item.terminal === true && (item.turnId === turnId || item.runId === sessionId))) return settleWorkbenchActivity(items)
  return reduceWorkbenchOutput(items, { kind: 'error', content, sessionId, runId: sessionId, turnId, eventId: `failure-${sessionId}`, time, terminal: true })
}

function legacyReduceWorkbenchOutput(
  items: WorkbenchTimelineItem[],
  event: AiOutputEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  const content = normalize(event.content)
  const identity = eventIdentity(event)
  const assistantId = `${identity}:assistant`
  const currentItems = event.kind === 'answer' || (event.kind === 'error' || event.kind === 'warning') && event.terminal === true
    ? settleWorkbenchActivity(items)
    : items
  if (event.kind === 'delta') {
    const index = currentItems.findIndex((item) => item.id === assistantId)
    if (index < 0) return bounded([...currentItems, { id: assistantId, kind: 'response', content, time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: 'running' }])
    const next = [...currentItems]
    next[index] = { ...next[index], content: mergeStreamingText(next[index].content, content), sequence: event.sequence ?? next[index].sequence, status: 'running' }
    return next
  }
  if (content.startsWith('__CODE_DIFF__')) {
    try {
      const diff = JSON.parse(content.slice('__CODE_DIFF__'.length)) as WorkbenchTimelineDiff[]
      return bounded([...currentItems, { id: `${identity}:diff:${event.time}`, kind: 'diff', content: '代码修改已应用', time: event.time, runId: event.runId, status: 'done', diff }])
    } catch {
      return bounded([...currentItems, { id: `${identity}:warning:${event.time}`, kind: 'warning', content: '代码修改已应用，但 Diff 详情无法解析', time: event.time, runId: event.runId, status: 'warning', terminal: false, recoverable: true }])
    }
  }
  if (event.kind === 'stream-start') {
    return bounded([...currentItems, { id: assistantId, kind: 'response', content: '', time: event.time, runId: event.runId, status: 'running' }])
  }
  if (event.kind === 'response' || event.kind === 'answer') {
    const matchingIndex = currentItems.findIndex((item) => item.id === assistantId)
    if (matchingIndex >= 0) {
      const next = [...currentItems]
      next[matchingIndex] = { ...next[matchingIndex], kind: event.kind, content: content || next[matchingIndex].content, time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: event.kind === 'answer' ? 'done' : 'running', ...(event.usage ? { usage: event.usage } : {}) }
      return next
    }
    const lastUserIndex = findLastMatchingIndex(currentItems, (item) => item.kind === 'user')
    const lastResponseIndex = findLastMatchingIndex(currentItems, (item, itemIndex) => (
      itemIndex > lastUserIndex
      && item.kind === 'response'
      && (event.kind === 'answer' || item.status === 'running')
    ))
    if (event.kind === 'answer' && lastResponseIndex >= 0 && currentItems[lastResponseIndex].content.trim() === content.trim()) {
      const next = [...currentItems]
      next[lastResponseIndex] = { ...next[lastResponseIndex], id: assistantId, kind: event.kind, content: content || next[lastResponseIndex].content, time: event.time, runId: event.runId, status: 'done', ...(event.usage ? { usage: event.usage } : {}) }
      return next
    }
    return bounded([...currentItems, { id: assistantId, kind: event.kind, content, time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: event.kind === 'answer' ? 'done' : 'running', ...(event.usage ? { usage: event.usage } : {}) }])
  }
  if (event.kind === 'start') return bounded([...currentItems, { id: `${identity}:start:${event.time}`, kind: 'start', content, time: event.time, runId: event.runId, status: 'done' }])
  if (event.kind === 'retry') return bounded([...currentItems, { id: `${identity}:retry:${event.time}`, kind: 'retry', content, time: event.time, runId: event.runId, status: 'warning', terminal: false, recoverable: true }])
  const kind = event.kind === 'tool' ? 'tool' : event.kind === 'warning' ? 'warning' : event.kind === 'error' ? 'error' : 'status'
  const errorLike = event.kind === 'error' || event.kind === 'warning'
  const terminal = errorLike ? event.terminal === true : event.terminal
  const recoverable = errorLike ? event.recoverable ?? !terminal : event.recoverable
  return bounded([...currentItems, {
    id: `${identity}:${kind}:${event.time}`,
    kind,
    content,
    time: event.time,
    runId: event.runId,
    status: event.kind === 'error' ? 'error' : event.kind === 'warning' ? 'warning' : 'done',
    ...(terminal !== undefined ? { terminal } : {}),
    ...(recoverable !== undefined ? { recoverable } : {})
  }])
}

function reasoningIdentity(event: AiOutputEvent): string {
  return `reasoning:${JSON.stringify([event.turnId ?? event.runId ?? event.sessionId, streamIdentity(event)])}`
}

function activityIdentity(event: AiOutputEvent): string {
  return `activity:${JSON.stringify([event.turnId ?? event.runId ?? event.sessionId, streamIdentity(event)])}`
}

function activityItem(previous: WorkbenchTimelineItem | undefined, event: AiOutputEvent): WorkbenchTimelineItem | undefined {
  if (!event.activity || previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return previous
  if (previous?.activity?.status !== 'running' && previous?.activity?.completedAt && event.activity.status === 'running') return previous
  const activity = event.activity
  return { ...previous, id: activityIdentity(event), kind: 'tool', activity, content: activity.title,
    activityOrder: previous?.activityOrder ?? event.sequence,
    time: previous?.time ?? event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, itemId: event.itemId, streamId: event.streamId,
    sequence: event.sequence, eventId: event.eventId, status: activity.status === 'running' ? 'running' : activity.status === 'failed' ? 'error' : activity.status === 'cancelled' || activity.status === 'interrupted' ? 'warning' : 'done' }
}

/** Native completion snapshots are authoritative; summary and raw text never mix with the answer. */
function reasoningItem(previous: WorkbenchTimelineItem | undefined, event: AiOutputEvent): WorkbenchTimelineItem | undefined {
  const update = event.reasoning
  if (!update || previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return previous
  if (previous?.status === 'done' && update.phase !== 'completed') return previous
  const reasoning = mergeAgentReasoning(previous?.reasoning, event)
  if (!reasoning) return previous
  return { ...previous, id: previous?.id ?? reasoningIdentity(event), kind: 'reasoning', reasoning,
    content: [...reasoning.summary, ...reasoning.text].filter(Boolean).join('\n\n'), time: previous?.time ?? event.time,
    runId: event.runId ?? event.sessionId, turnId: event.turnId, itemId: event.itemId, streamId: event.streamId,
    sequence: event.sequence, eventId: event.eventId, status: update.phase === 'completed' ? 'done' : 'running' }
}

export function reduceWorkbenchOutput(
  items: WorkbenchTimelineItem[],
  event: AiOutputEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  if (event.usage) event = { ...event, usage: mergeContextUsage(latestWorkbenchUsage(items), event.usage) }
  if (event.kind === 'usage') {
    if (!event.usage) return items
    const index = findLastMatchingIndex(items, item => sameOutputTurn(item, event))
    if (index < 0) return items
    return items.map((item, i) => i === index ? { ...item, usage: event.usage } : item)
  }
  if (event.kind === 'warning' || event.kind === 'error') event = { ...event, content: presentLegacyAiNotice(event.content, event.kind === 'warning') }
  if (items.some((item) => sameOutputTurn(item, event) && (
    event.eventId && item.eventId === event.eventId
    || event.sequence !== undefined && item.sequence === event.sequence
  ))) return items
  if (event.kind === 'reasoning') {
    const index = items.findIndex(item => item.id === reasoningIdentity(event))
    const previous = index < 0 ? undefined : items[index]
    const item = reasoningItem(previous, event)
    if (!item || item === previous) return items
    return index < 0 ? [...items, item] : items.map((row, i) => i === index ? item : row)
  }
  if (event.activity) {
    const index = items.findIndex(item => item.id === activityIdentity(event))
    const previous = index < 0 ? undefined : items[index]
    const item = activityItem(previous, event)
    if (!item || item === previous) return items
    return index < 0 ? bounded([...items, item]) : items.map((row, i) => i === index ? item : row)
  }
  const content = normalize(event.content)
  const current = event.kind === 'answer' || ((event.kind === 'error' || event.kind === 'warning') && event.terminal === true)
    ? settleWorkbenchActivity(items)
    : items
  const identity = eventIdentity(event)
  if (event.notice && event.terminal !== true && ['warning', 'retry'].includes(event.kind)) {
    const notice = event.notice
    const index = current.findIndex(item => sameOutputTurn(item, event) && item.notice?.key === notice.key && item.terminal !== true)
    const previous = index >= 0 ? current[index] : undefined
    if (previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return current
    const item: WorkbenchTimelineItem = {
      id: previous?.id ?? `notice:${event.turnId ?? event.runId ?? event.sessionId}:${notice.key}`,
      kind: event.kind as 'warning' | 'retry', content, time: event.time, runId: event.runId ?? event.sessionId,
      turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, status: 'warning', terminal: false, recoverable: true,
      notice: { ...notice, occurrences: notice.occurrences ?? previous?.notice?.occurrences }
    }
    const next = current.map(row => event.kind === 'retry' && row.kind === 'response' && row.status === 'running' && sameOutputTurn(row, event)
      ? { ...row, status: 'done' as const } : row)
    if (index >= 0) next[index] = item
    else next.push(item)
    return orderTimeline(next)
  }
  if (event.kind === 'delta' || event.kind === 'stream-start') {
    const streamId = streamIdentity(event)
    if (event.sequence !== undefined && current.some((item) => sameOutputTurn(item, event) && item.streamId === streamId
      && item.sequence !== undefined && item.sequence >= event.sequence!)) return current
    const index = findLastMatchingIndex(current, (item) => item.kind === 'response' && item.status === 'running' && sameOutputTurn(item, event) && item.streamId === streamId)
    // Provider item ids identify a completed message even if a delayed delta arrives.
    if (index < 0 && (event.streamId || event.itemId) && current.some((item) => (item.kind === 'response' || item.kind === 'answer')
      && item.status === 'done' && sameOutputTurn(item, event) && item.streamId === streamId)) return current
    if (index >= 0) {
      if (event.kind === 'stream-start') return current
      const next = [...current]
      next[index] = {
        ...next[index],
        content: mergeStreamingText(next[index].content, content),
        sequence: event.sequence ?? next[index].sequence,
        eventId: event.eventId,
        status: 'running'
      }
      return orderTimeline(next)
    }
    const id = uniqueTimelineId(current, `stream:${event.turnId ?? event.runId ?? event.sessionId ?? 'legacy'}:${streamId}:${eventIdentity(event)}`)
    return orderTimeline([...current, { id, kind: 'response', content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, itemId: event.itemId, streamId, sequence: event.sequence, eventId: event.eventId, status: 'running' }])
  }
  if (content.startsWith('__CODE_DIFF__')) {
    try {
      const diff = JSON.parse(content.slice('__CODE_DIFF__'.length)) as WorkbenchTimelineDiff[]
      return orderTimeline([...current, { id: `diff:${identity}`, kind: 'diff', content: '代码修改已应用', time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: 'done', diff }])
    } catch {
      return orderTimeline([...current, { id: `warning:${identity}`, kind: 'warning', content: '代码修改已应用，但 Diff 详情无法解析', time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: 'warning', terminal: false, recoverable: true }])
    }
  }
  if (event.kind === 'response' || event.kind === 'answer') {
    const streamId = streamIdentity(event)
    const streamIndex = findLastMatchingIndex(current, (item, index) => (item.kind === 'response' || item.kind === 'answer')
      && sameOutputTurn(item, event) && item.streamId === streamId
      && (event.streamId || event.itemId ? true : item.kind === 'response' && items[index].status === 'running'))
    if (streamIndex >= 0) {
      if (current[streamIndex].kind === 'answer' && event.kind === 'response') return current
      if (event.sequence !== undefined && current[streamIndex].sequence !== undefined && event.sequence < current[streamIndex].sequence!) return current
      const next = [...current]
      next[streamIndex] = { ...next[streamIndex], kind: event.kind, content: content || next[streamIndex].content,
        status: 'done', sequence: event.sequence ?? next[streamIndex].sequence, eventId: event.eventId,
        ...(event.kind === 'answer' ? { terminal: true } : {}), ...(event.usage ? { usage: event.usage } : {}) }
      return orderTimeline(next)
    }
    const answerTurnKey = event.turnId ?? event.runId ?? event.sessionId ?? event.time
    const duplicate = event.kind === 'answer' && current.some((item) => item.kind === 'answer'
      && (item.turnId ?? item.runId ?? item.time) === answerTurnKey
      && item.content.trim() === content.trim())
    if (duplicate) return current
    if (event.kind === 'answer') {
      const turnKey = event.turnId ?? event.runId ?? event.sessionId
      const responseIndex = findLastMatchingIndex(current, (item) => item.kind === 'response'
        && (item.status === 'running' || item.status === 'done')
        && (item.turnId ?? item.runId) === turnKey
        && item.content.trim() === content.trim())
      if (responseIndex >= 0) {
        const next = [...current]
        next[responseIndex] = { ...next[responseIndex], kind: 'answer', content: content || next[responseIndex].content, time: event.time, sequence: event.sequence ?? next[responseIndex].sequence, eventId: event.eventId, status: 'done', terminal: true, ...(event.usage ? { usage: event.usage } : {}) }
        return orderTimeline(next)
      }
      const legacyResponse = findLastMatchingIndex(current, (item) => item.kind === 'response' && item.status === 'running' && !event.turnId && !item.turnId && item.runId === event.runId && item.content.trim() === content.trim())
      if (legacyResponse >= 0) {
        const next = [...current]
        next[legacyResponse] = { ...next[legacyResponse], id: `answer:${identity}`, kind: 'answer', content, time: event.time, sequence: event.sequence ?? next[legacyResponse].sequence, status: 'done', terminal: true, ...(event.usage ? { usage: event.usage } : {}) }
        return orderTimeline(next)
      }
    }
    const id = `${event.kind}:${event.turnId ?? event.runId ?? event.sessionId ?? 'legacy'}:${streamId}:${identity}`
    if (current.some((item) => item.id === id)) return current
    return orderTimeline([...current, { id, kind: event.kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, itemId: event.itemId, streamId, sequence: event.sequence, eventId: event.eventId, status: 'done', ...(event.usage ? { usage: event.usage } : {}) }])
  }
  if (event.kind === 'start' || event.kind === 'retry') {
    const settled = event.kind === 'retry'
      ? current.map((item) => item.kind === 'response' && item.status === 'running' && sameOutputTurn(item, event) ? { ...item, status: 'done' as const } : item)
      : current
    if (event.kind === 'start' && (event.turnId || event.runId || event.sessionId)
      && settled.some(item => item.kind === 'start' && sameOutputTurn(item, event) && item.content === content)) return settled
    return orderTimeline([...settled, { id: `${event.kind}:${identity}`, kind: event.kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, status: event.kind === 'retry' ? 'warning' : 'done', ...(event.kind === 'retry' ? { terminal: false, recoverable: true } : {}) }])
  }
  const kind: WorkbenchTimelineItem['kind'] = event.kind === 'tool' ? 'tool' : event.kind === 'warning' ? 'warning' : event.kind === 'error' ? 'error' : 'status'
  const errorLike = event.kind === 'error' || event.kind === 'warning'
  const terminal = errorLike ? event.terminal === true : event.terminal
  const recoverable = errorLike ? event.recoverable ?? !terminal : event.recoverable
  return orderTimeline([...current, {
    id: `${kind}:${identity}`, kind, content, notice: event.notice, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, stage: event.kind,
    status: event.kind === 'error' ? 'error' : event.kind === 'warning' ? 'warning' : 'done',
    ...(terminal !== undefined ? { terminal } : {}), ...(recoverable !== undefined ? { recoverable } : {})
  }])
}

export function reduceWorkbenchProgress(
  items: WorkbenchTimelineItem[],
  event: PipelineEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  if (event.notice) return reduceWorkbenchOutput(items, {
    ...event, kind: 'retry', content: event.detail, notice: event.notice, terminal: false, recoverable: true
  }, normalize)
  const currentItems = settleWorkbenchActivity(items, true)
  const liveItems = items
  const identity = event.eventId || event.id || (event.sequence !== undefined ? `seq-${event.sequence}` : undefined) || event.runId || event.sessionId || event.time
  const id = `${identity}:progress`
  const content = [normalize(event.title), normalize(event.detail)].filter(Boolean).join('\n')
  const index = currentItems.findIndex((item) => item.id === id)
  const status = event.status === 'running' ? 'running' : event.status === 'error' ? 'error' : event.status === 'warning' ? 'warning' : 'done'
  const kind: WorkbenchTimelineItem['kind'] = event.status === 'error' ? 'error' : event.status === 'warning' ? 'warning' : event.status === 'running' ? 'thinking' : 'tool'
  const item: WorkbenchTimelineItem = {
    id,
    kind,
    content,
    time: event.time,
    runId: event.runId ?? event.sessionId,
    turnId: event.turnId,
    sequence: event.sequence,
    eventId: event.eventId,
    connectionActivity: connectionActivity({ kind, content: event.title }),
    stage: event.stage,
    ...(event.changedFiles ? { changedFiles: event.changedFiles } : {}),
    status,
    ...(event.terminal !== undefined ? { terminal: event.terminal } : {}),
    ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {})
  }
  const connectionKey = connectionActivityIdentity(item)
  const connectionIndex = connectionKey ? currentItems.findIndex(candidate => connectionActivityIdentity(candidate) === connectionKey) : -1
  if (connectionIndex >= 0) {
    const previous = items[connectionIndex]
    if (previous.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return items
    const next = [...currentItems]
    next[connectionIndex] = mergeConnectionActivity(previous, item)
    return orderTimeline(next)
  }
  if (index < 0) {
    // A running stage followed by its terminal update is one lifecycle item;
    // distinct completed stages still remain separate records.
    const lifecycleIndex = liveItems.findIndex((candidate) => candidate.kind === 'thinking'
      && candidate.status === 'running' && candidate.runId === item.runId && candidate.turnId === item.turnId
      && candidate.stage === item.stage && status !== 'running')
    if (lifecycleIndex >= 0) {
      const next = [...currentItems]
      next[lifecycleIndex] = item
      return orderTimeline(next)
    }
    return orderTimeline(bounded([...currentItems, item]))
  }
  const next = [...currentItems]
  next[index] = item
  return orderTimeline(next)
}

/**
 * Rebuilds the visible timeline from the complete durable journal. Matching
 * streams and host connection activities update existing projection
 * items; domain steps retain their order.
 */
export function replayWorkbenchEvents(
  view: WorkbenchTimelineItem[],
  events: ConversationEventRecord[],
  normalizeActivity: (value: string) => string = (value) => value,
  normalizeOutput: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  const replay = replayWorkbenchSteps(view, events, normalizeActivity, normalizeOutput)
  let step = replay.next()
  while (!step.done) step = replay.next()
  return step.value
}

/** Polling clients can replay the durable journal while its latest turn is live. */
export function replayLiveWorkbenchEvents(view: WorkbenchTimelineItem[], events: ConversationEventRecord[]): WorkbenchTimelineItem[] {
  const replay = replayWorkbenchSteps(view, events, value => value, value => value, true)
  let step = replay.next()
  while (!step.done) step = replay.next()
  return step.value
}

/** Apply only events newer than a durable projection without discarding its earlier rows. */
export function replayWorkbenchTail(view: WorkbenchTimelineItem[], events: ConversationEventRecord[], normalizeActivity: (value: string) => string = value => value, normalizeOutput: (value: string) => string = value => value): WorkbenchTimelineItem[] {
  const replay = replayWorkbenchSteps(view, events, normalizeActivity, normalizeOutput, false, true)
  let step = replay.next()
  while (!step.done) step = replay.next()
  return step.value
}

/** Restore long histories without monopolizing the renderer's event loop. */
export async function replayWorkbenchEventsAsync(
  view: WorkbenchTimelineItem[],
  events: ConversationEventRecord[],
  normalizeActivity: (value: string) => string = (value) => value,
  normalizeOutput: (value: string) => string = (value) => value,
  isCancelled: () => boolean = () => false
): Promise<WorkbenchTimelineItem[]> {
  const yieldToUi = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  await yieldToUi()
  const replay = replayWorkbenchSteps(view, events, normalizeActivity, normalizeOutput)
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

// Replay keeps mutable row handles behind indexes. Live reducers above remain
// immutable; rebuilding a journal must not copy and sort its whole prefix for
// every token or tool event.
type ReplayRow = { item: WorkbenchTimelineItem; time: number; ordinal: number; keys: string[] }
type ReplayGroup = { rows: Set<ReplayRow>; first?: ReplayRow; last?: ReplayRow; dirty?: boolean }
const replayKey = (kind: string, ...parts: unknown[]): string => JSON.stringify([kind, ...parts])
const replayTurn = (item: WorkbenchTimelineItem): string | undefined => item.turnId ?? item.runId
function compareReplayRows(left: ReplayRow, right: ReplayRow): number {
  const a = left.item
  const b = right.item
  const at = left.time
  const bt = right.time
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
  const as = Number.isSafeInteger(a.sequence) ? a.sequence! : Number.MAX_SAFE_INTEGER
  const bs = Number.isSafeInteger(b.sequence) ? b.sequence! : Number.MAX_SAFE_INTEGER
  if (as !== bs && as !== Number.MAX_SAFE_INTEGER && bs !== Number.MAX_SAFE_INTEGER) return as - bs
  if (as !== bs) return as === Number.MAX_SAFE_INTEGER ? -1 : 1
  return left.ordinal - right.ordinal
}

class WorkbenchReplayProjection {
  readonly rows: ReplayRow[] = []
  private readonly groups = new Map<string, ReplayGroup>()
  private readonly running = new Set<ReplayRow>()
  private readonly thinking = new Set<ReplayRow>()
  private readonly usageRows = new Set<ReplayRow>()
  private readonly streamSequences = new Map<string, number>()
  private readonly pendingText = new WeakMap<ReplayRow, ReplayTextBuffer>()
  private usageDirty = true
  private usage: AiTokenUsage | undefined
  private usageTail?: ReplayRow

  private keys(item: WorkbenchTimelineItem, row: ReplayRow): string[] {
    const turn = replayTurn(item)
    const keys = [replayKey('id', item.id), replayKey('turn', turn)]
    if (item.eventId) keys.push(replayKey('event', turn, item.eventId))
    if (item.sequence !== undefined) keys.push(replayKey('sequence', turn, item.sequence))
    if (item.notice && item.terminal !== true) keys.push(replayKey('notice', turn, item.notice.key))
    const connection = connectionActivityIdentity(item)
    if (connection) keys.push(replayKey('connection', connection))
    if (item.kind === 'start') keys.push(replayKey('start', turn, item.content))
    if (item.kind === 'thinking' && item.status === 'running') keys.push(replayKey('lifecycle', item.runId, item.turnId, item.stage))
    if (item.kind === 'response' || item.kind === 'answer') {
      keys.push(replayKey('stream', turn, item.streamId))
      if (item.sequence !== undefined) keys.push(replayKey('streamSequence', turn, item.streamId))
      if (item.status === 'done') keys.push(replayKey('streamDone', turn, item.streamId))
      if (item.kind === 'answer') keys.push(replayKey('answerText', item.turnId ?? item.runId ?? item.time, item.content.trim()))
      if (item.kind === 'response') {
        if (!this.pendingText.has(row) && (item.status === 'running' || item.status === 'done')) keys.push(replayKey('responseText', turn, item.content.trim()))
        if (item.status === 'running') keys.push(replayKey('streamRunning', turn, item.streamId), replayKey('runningResponseTurn', turn))
      }
    }
    return keys
  }

  add(item: WorkbenchTimelineItem): ReplayRow {
    const row = { item, time: Date.parse(item.time), ordinal: this.rows.length, keys: [] as string[] }
    this.rows.push(row)
    this.replace(row, item)
    return row
  }

  replace(row: ReplayRow, item: WorkbenchTimelineItem): void {
    const previous = row.item
    const orderChanged = previous.time !== item.time || previous.sequence !== item.sequence
    const keys = this.keys(item, row)
    for (const key of row.keys) {
      if (keys.includes(key)) continue
      const group = this.groups.get(key)!
      group.rows.delete(row)
      if (!group.rows.size) this.groups.delete(key)
      else if (group.first === row || group.last === row) group.dirty = true
    }
    if (previous.usage !== item.usage || orderChanged && item.usage) this.usageDirty = true
    row.item = item
    if (orderChanged) row.time = Date.parse(item.time)
    for (const key of keys) {
      let group = this.groups.get(key)
      if (!group) { group = { rows: new Set() }; this.groups.set(key, group) }
      const existing = group.rows.has(row)
      group.rows.add(row)
      if (existing && orderChanged && (group.first === row || group.last === row)) group.dirty = true
      if (!group.first || compareReplayRows(row, group.first) < 0) group.first = row
      if (!group.last || compareReplayRows(row, group.last) > 0) group.last = row
    }
    row.keys = keys
    if ((item.kind === 'response' || item.kind === 'answer') && item.sequence !== undefined) {
      const stream = replayKey('stream', replayTurn(item), item.streamId)
      this.streamSequences.set(stream, Math.max(this.streamSequences.get(stream) ?? -Infinity, item.sequence))
    }
    if (item.status === 'running') this.running.add(row)
    else this.running.delete(row)
    if (item.kind === 'thinking' && item.status === 'running') this.thinking.add(row)
    else this.thinking.delete(row)
    if (item.usage) {
      const newUsage = !this.usageRows.has(row)
      this.usageRows.add(row)
      if (newUsage && !this.usageDirty && (!this.usageTail || compareReplayRows(row, this.usageTail) >= 0)) {
        this.usage = mergeContextUsage(this.usage, item.usage)
        this.usageTail = row
      } else if (newUsage) this.usageDirty = true
    } else this.usageRows.delete(row)
  }

  get(kind: string, parts: unknown[], last = false): ReplayRow | undefined {
    const group = this.groups.get(replayKey(kind, ...parts))
    if (!group) return undefined
    if (group.dirty) {
      group.first = undefined; group.last = undefined
      for (const row of group.rows) {
        if (!group.first || compareReplayRows(row, group.first) < 0) group.first = row
        if (!group.last || compareReplayRows(row, group.last) > 0) group.last = row
      }
      group.dirty = false
    }
    return last ? group.last : group.first
  }

  settle(thinkingOnly = false, turn?: { key: string | undefined }): void {
    const rows = turn ? this.groups.get(replayKey('runningResponseTurn', turn.key))?.rows : thinkingOnly ? this.thinking : this.running
    if (!rows) return
    // Replacement deletes the current handle from this Set. Set iteration
    // remains stable, and each running activity is settled only once.
    for (const row of rows) { this.flushText(row); this.replace(row, { ...row.item, status: 'done' }) }
  }

  private flushText(row: ReplayRow): void {
    const text = this.pendingText.get(row)
    if (!text) return
    this.pendingText.delete(row)
    this.replace(row, { ...row.item, content: text.value() })
  }

  flushStreamingText(): void {
    for (const row of this.rows) this.flushText(row)
  }

  latestUsage(): AiTokenUsage | undefined {
    if (this.usageDirty) {
      const rows = [...this.usageRows].sort(compareReplayRows)
      this.usage = latestWorkbenchUsage(rows.map(row => row.item))
      this.usageTail = rows.at(-1)
      this.usageDirty = false
    }
    return this.usage
  }

  output(incoming: AiOutputEvent, normalize: (value: string) => string): void {
    let event = incoming.usage ? { ...incoming, usage: mergeContextUsage(this.latestUsage(), incoming.usage) } : incoming
    const turn = event.turnId ?? event.runId ?? event.sessionId
    if (event.kind === 'usage') {
      const row = event.usage ? this.get('turn', [turn], true) : undefined
      if (row) this.replace(row, { ...row.item, usage: event.usage })
      return
    }
    if (event.kind === 'warning' || event.kind === 'error') event = { ...event, content: presentLegacyAiNotice(event.content, event.kind === 'warning') }
    if (event.eventId && this.get('event', [turn, event.eventId]) || event.sequence !== undefined && this.get('sequence', [turn, event.sequence])) return
    if (event.kind === 'reasoning') {
      const row = this.get('id', [reasoningIdentity(event)])
      const item = reasoningItem(row?.item, event)
      if (item && item !== row?.item) {
        if (row) this.replace(row, item)
        else this.add(item)
      }
      return
    }
    if (event.activity) {
      const row = this.get('id', [activityIdentity(event)])
      const item = activityItem(row?.item, event)
      if (item && item !== row?.item) {
        if (row) this.replace(row, item)
        else this.add(item)
      }
      return
    }
    const content = normalize(event.content)
    // An unkeyed final answer matches the response that was running before
    // settling; this is the same pre-settlement check as the live reducer.
    const streamId = streamIdentity(event)
    const runningStream = this.get('streamRunning', [turn, streamId], true)
    if (event.kind === 'answer' || (event.kind === 'error' || event.kind === 'warning') && event.terminal === true) this.settle()
    const identity = eventIdentity(event)
    if (event.notice && event.terminal !== true && ['warning', 'retry'].includes(event.kind)) {
      const row = this.get('notice', [turn, event.notice.key])
      const previous = row?.item
      if (previous?.sequence !== undefined && event.sequence !== undefined && previous.sequence >= event.sequence) return
      const item: WorkbenchTimelineItem = {
        id: previous?.id ?? `notice:${turn}:${event.notice.key}`, kind: event.kind as 'warning' | 'retry', content, time: event.time,
        runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId,
        status: 'warning', terminal: false, recoverable: true,
        notice: { ...event.notice, occurrences: event.notice.occurrences ?? previous?.notice?.occurrences }
      }
      if (event.kind === 'retry') this.settle(false, { key: turn })
      if (row) this.replace(row, item)
      else this.add(item)
      return
    }
    if (event.kind === 'delta' || event.kind === 'stream-start') {
      // Sequence values in a valid journal are unique and processed in order;
      // restored rows can nevertheless contain a newer stream checkpoint.
      if (event.sequence !== undefined && (this.streamSequences.get(replayKey('stream', turn, streamId)) ?? -Infinity) >= event.sequence) return
      if (!runningStream && (event.streamId || event.itemId) && this.get('streamDone', [turn, streamId])) return
      if (runningStream) {
        if (event.kind !== 'stream-start') {
          let text = this.pendingText.get(runningStream)
          if (!text) { text = new ReplayTextBuffer(runningStream.item.content); this.pendingText.set(runningStream, text) }
          text.append(content)
          this.replace(runningStream, { ...runningStream.item, content: '', sequence: event.sequence ?? runningStream.item.sequence, eventId: event.eventId, status: 'running' })
        }
        return
      }
      const base = `stream:${turn ?? 'legacy'}:${streamId}:${identity}`
      let id = base
      for (let suffix = 2; this.get('id', [id]); suffix++) id = `${base}:${suffix}`
      this.add({ id, kind: 'response', content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, itemId: event.itemId, streamId, sequence: event.sequence, eventId: event.eventId, status: 'running' })
      return
    }
    if (content.startsWith('__CODE_DIFF__')) {
      try {
        const diff = JSON.parse(content.slice('__CODE_DIFF__'.length)) as WorkbenchTimelineDiff[]
        this.add({ id: `diff:${identity}`, kind: 'diff', content: '代码修改已应用', time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: 'done', diff })
      } catch {
        this.add({ id: `warning:${identity}`, kind: 'warning', content: '代码修改已应用，但 Diff 详情无法解析', time: event.time, runId: event.runId, turnId: event.turnId, sequence: event.sequence, status: 'warning', terminal: false, recoverable: true })
      }
      return
    }
    if (event.kind === 'response' || event.kind === 'answer') {
      const stream = event.streamId || event.itemId ? this.get('stream', [turn, streamId], true) : runningStream
      if (stream) {
        this.flushText(stream)
        if (stream.item.kind === 'answer' && event.kind === 'response') return
        if (event.sequence !== undefined && stream.item.sequence !== undefined && event.sequence < stream.item.sequence) return
        this.replace(stream, { ...stream.item, kind: event.kind, content: content || stream.item.content, status: 'done', sequence: event.sequence ?? stream.item.sequence, eventId: event.eventId, ...(event.kind === 'answer' ? { terminal: true } : {}), ...(event.usage ? { usage: event.usage } : {}) })
        return
      }
      if (event.kind === 'answer') {
        if (this.get('answerText', [turn ?? event.time, content.trim()])) return
        const response = this.get('responseText', [turn, content.trim()], true)
        if (response) {
          this.replace(response, { ...response.item, kind: 'answer', content: content || response.item.content, time: event.time, sequence: event.sequence ?? response.item.sequence, eventId: event.eventId, status: 'done', terminal: true, ...(event.usage ? { usage: event.usage } : {}) })
          return
        }
      }
      const id = `${event.kind}:${turn ?? 'legacy'}:${streamId}:${identity}`
      if (!this.get('id', [id])) this.add({ id, kind: event.kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, itemId: event.itemId, streamId, sequence: event.sequence, eventId: event.eventId, status: 'done', ...(event.usage ? { usage: event.usage } : {}) })
      return
    }
    if (event.kind === 'start' || event.kind === 'retry') {
      if (event.kind === 'retry') this.settle(false, { key: turn })
      if (event.kind === 'start' && turn && this.get('start', [turn, content])) return
      this.add({ id: `${event.kind}:${identity}`, kind: event.kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, status: event.kind === 'retry' ? 'warning' : 'done', ...(event.kind === 'retry' ? { terminal: false, recoverable: true } : {}) })
      return
    }
    const kind: WorkbenchTimelineItem['kind'] = event.kind === 'tool' ? 'tool' : event.kind === 'warning' ? 'warning' : event.kind === 'error' ? 'error' : 'status'
    const errorLike = event.kind === 'error' || event.kind === 'warning'
    const terminal = errorLike ? event.terminal === true : event.terminal
    const recoverable = errorLike ? event.recoverable ?? !terminal : event.recoverable
    this.add({ id: `${kind}:${identity}`, kind, content, notice: event.notice, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, stage: event.kind,
      status: event.kind === 'error' ? 'error' : event.kind === 'warning' ? 'warning' : 'done', ...(terminal !== undefined ? { terminal } : {}), ...(recoverable !== undefined ? { recoverable } : {}) })
  }

  progress(event: PipelineEvent, normalize: (value: string) => string): void {
    if (event.notice) { this.output({ ...event, kind: 'retry', content: event.detail, notice: event.notice, terminal: false, recoverable: true }, normalize); return }
    const identity = event.eventId || event.id || (event.sequence !== undefined ? `seq-${event.sequence}` : undefined) || event.runId || event.sessionId || event.time
    const id = `${identity}:progress`
    const content = [normalize(event.title), normalize(event.detail)].filter(Boolean).join('\n')
    const status = event.status === 'running' ? 'running' : event.status === 'error' ? 'error' : event.status === 'warning' ? 'warning' : 'done'
    const kind: WorkbenchTimelineItem['kind'] = event.status === 'error' ? 'error' : event.status === 'warning' ? 'warning' : event.status === 'running' ? 'thinking' : 'tool'
    const item: WorkbenchTimelineItem = { id, kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, connectionActivity: connectionActivity({ kind, content: event.title }), stage: event.stage,
      ...(event.changedFiles ? { changedFiles: event.changedFiles } : {}), status, ...(event.terminal !== undefined ? { terminal: event.terminal } : {}), ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}) }
    const connection = connectionActivityIdentity(item)
    const connectionRow = connection ? this.get('connection', [connection]) : undefined
    if (connectionRow?.item.sequence !== undefined && event.sequence !== undefined && connectionRow.item.sequence >= event.sequence) return
    const idRow = this.get('id', [id])
    const lifecycle = !idRow && status !== 'running' ? this.get('lifecycle', [item.runId, item.turnId, item.stage]) : undefined
    this.settle(true)
    if (connectionRow) this.replace(connectionRow, mergeConnectionActivity(connectionRow.item, item))
    else if (idRow || lifecycle) this.replace((idRow || lifecycle)!, item)
    else this.add(item)
  }
}


function* replayWorkbenchLegacySteps(
  view: WorkbenchTimelineItem[],
  events: ConversationEventRecord[],
  normalizeActivity: (value: string) => string = (value) => value,
  normalizeOutput: (value: string) => string = (value) => value,
  preserveRunning = false
): Generator<void, WorkbenchTimelineItem[], void> {
  if (!events.length) return normalizeWorkbenchTimeline(view)
  const replayedTurns = new Set(events.filter((event) => event.kind === 'output' || event.kind === 'progress').map((event) => event.turnId))
  // Forks and migrated conversations can have older turns only in the saved view.
  let result = view.filter((item) => item.kind === 'user' ? !isWorkbenchInternalPrompt(item.content)
    : !replayedTurns.has(item.turnId ?? `turn-${item.runId}`)).map((item) => ({ ...item }))
  const knownUsers = new Map(result.filter((item) => item.kind === 'user' && item.turnId).map((item) => [item.turnId!, item]))
  const seenEvents = new Set<string>()
  for (const record of [...events].sort((left, right) => left.sequence - right.sequence)) {
    yield
    if (seenEvents.has(record.eventId)) continue
    seenEvents.add(record.eventId)
    if (record.kind === 'user') {
      const payload = record.payload && typeof record.payload === 'object' ? record.payload as { prompt?: unknown } : undefined
      if (typeof payload?.prompt === 'string' && isWorkbenchInternalPrompt(payload.prompt)) continue
      const existing = knownUsers.get(record.turnId)
      if (existing) {
        existing.sequence = record.sequence
        continue
      }
      const content = typeof payload?.prompt === 'string' ? payload.prompt : ''
      const item: WorkbenchTimelineItem = { id: `user:${record.eventId}`, kind: 'user', content, time: record.time, runId: record.runId, turnId: record.turnId, sequence: record.sequence, status: 'done' }
      result.push(item)
      knownUsers.set(record.turnId, item)
      continue
    }
    if (record.kind === 'progress' && record.payload && typeof record.payload === 'object') {
      result = reduceWorkbenchProgress(result, workbenchRecordPayload<PipelineEvent>(record), normalizeActivity)
      continue
    }
    if (record.kind === 'output' && record.payload && typeof record.payload === 'object') {
      result = reduceWorkbenchOutput(result, workbenchRecordPayload<AiOutputEvent>(record), normalizeOutput)
    }
  }
  const ordered = orderTimeline(result)
  return preserveRunning ? ordered : settleWorkbenchActivity(ordered)
}

/** Journal envelopes are authoritative fallbacks for older sparse payloads. */
function workbenchRecordPayload<T extends AiOutputEvent | PipelineEvent>(record: ConversationEventRecord): T {
  const payload = record.payload as T
  return { ...payload, time: payload.time ?? record.time, runId: payload.runId ?? record.runId,
    turnId: payload.turnId ?? record.turnId, sequence: record.sequence, eventId: record.eventId }
}

function* replayWorkbenchSteps(
  view: WorkbenchTimelineItem[],
  events: ConversationEventRecord[],
  normalizeActivity: (value: string) => string,
  normalizeOutput: (value: string) => string,
  preserveRunning = false,
  incremental = false
): Generator<void, WorkbenchTimelineItem[], void> {
  if (!events.length) return normalizeWorkbenchTimeline(view)
  // The historical comparator deliberately preserves invalid legacy dates.
  // Its mixed valid/invalid ordering is not transitive, so retain the original
  // reducer path for those malformed records instead of guessing their order.
  const sequences = new Set<number>()
  const turns = new Set<string>()
  for (const record of events) {
    yield
    const time = record.kind === 'output' || record.kind === 'progress'
      ? (record.payload as { time?: string } | undefined)?.time ?? record.time : record.time
    if (!Number.isFinite(Date.parse(time ?? '')) || sequences.has(record.sequence)) {
      return yield* replayWorkbenchLegacySteps(view, events, normalizeActivity, normalizeOutput, preserveRunning)
    }
    sequences.add(record.sequence)
    if (record.kind === 'output' || record.kind === 'progress') turns.add(record.turnId)
  }
  const projection = new WorkbenchReplayProjection()
  const knownUsers = new Map<string, ReplayRow>()
  for (const item of view) {
    yield
    if (!Number.isFinite(Date.parse(item.time))) return yield* replayWorkbenchLegacySteps(view, events, normalizeActivity, normalizeOutput, preserveRunning)
    if (item.kind === 'user' ? isWorkbenchInternalPrompt(item.content) : !incremental && turns.has(item.turnId ?? `turn-${item.runId}`)) continue
    const continues = incremental && item.kind === 'response' && events.some(record => record.kind === 'output' && record.turnId === item.turnId && (record.payload as AiOutputEvent)?.kind === 'delta' && ((record.payload as AiOutputEvent)?.streamId ?? (record.payload as AiOutputEvent)?.itemId) === (item.streamId ?? item.itemId) && record.sequence > (item.sequence ?? 0))
    const row = projection.add({ ...item, ...(continues ? { status: 'running' as const } : {}) })
    if (item.kind === 'user' && item.turnId) knownUsers.set(item.turnId, row)
  }
  const seen = new Set<string>()
  for (const record of [...events].sort((a, b) => a.sequence - b.sequence)) {
    yield
    if (seen.has(record.eventId)) continue
    seen.add(record.eventId)
    if (record.kind === 'user') {
      const prompt = (record.payload as { prompt?: unknown } | undefined)?.prompt
      if (typeof prompt === 'string' && isWorkbenchInternalPrompt(prompt)) continue
      const previous = knownUsers.get(record.turnId)
      if (previous) projection.replace(previous, { ...previous.item, sequence: record.sequence })
      else knownUsers.set(record.turnId, projection.add({ id: `user:${record.eventId}`, kind: 'user', content: typeof prompt === 'string' ? prompt : '', time: record.time, runId: record.runId, turnId: record.turnId, sequence: record.sequence, status: 'done' }))
    } else if (record.payload && typeof record.payload === 'object') {
      if (record.kind === 'output') projection.output(workbenchRecordPayload<AiOutputEvent>(record), normalizeOutput)
      else if (record.kind === 'progress') projection.progress(workbenchRecordPayload<PipelineEvent>(record), normalizeActivity)
    }
  }
  if (!preserveRunning) projection.settle()
  else projection.flushStreamingText()
  return projection.rows.sort(compareReplayRows).map(row => row.item)
}

export function normalizeStoredWorkbenchTimeline(item: WorkbenchTimelineItem): WorkbenchTimelineItem {
  if (item.kind === 'reasoning') {
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : []
    return { ...item, reasoning: { summary: strings(item.reasoning?.summary), text: strings(item.reasoning?.text) }, status: 'done' }
  }
  if (item.kind === 'warning' || item.kind === 'error') item = { ...item, content: presentLegacyAiNotice(item.content, item.kind === 'warning') }
  const replay = normalizeAiTurnReplay(item.replay)
  const normalized = replay ? { ...item, replay } : item.replay ? { ...item, replay: undefined } : item
  if (normalized.kind === 'warning' || normalized.kind === 'retry') return { ...normalized, status: 'warning', terminal: false, recoverable: true }
  if (normalized.kind !== 'error') return normalized
  // Earlier builds guessed terminal=true from error text and persisted that
  // guess. Only the new explicit pair is authoritative across restarts.
  if (normalized.terminal === true && normalized.recoverable === false) return normalized
  if (/(?:warning|warn|deprecated|deprecation|警告|重试|重新连接)/i.test(normalized.content)) return { ...normalized, kind: 'warning', status: 'warning', terminal: false, recoverable: true }
  if (/(?:error|fatal|exception|failed|forbidden|unauthori[sz]ed|timed out|timeout|错误|失败|异常|无法|超时|退出码|拒绝)/i.test(normalized.content)) return { ...normalized, terminal: false, recoverable: true }
  return { ...normalized, kind: 'tool', status: 'done', terminal: false, recoverable: true }
}

export function timelineToPlainText(items: WorkbenchTimelineItem[]): string {
  const labels: Partial<Record<WorkbenchTimelineItem['kind'], string>> = { history: '已恢复上下文', start: '任务开始', retry: '重试', tool: '工具结果', warning: '警告', error: '错误', diff: '代码修改', status: '状态', user: '你', reasoning: '思考' }
  return items.map((item) => `${labels[item.kind] ? `[${labels[item.kind]}]\n` : ''}${item.content}`).join('\n\n')
}

/** 回退/编辑重发时，只保留「用户提问 + AI 最终回答」，清掉思考步骤、工具调用、停止残留等半处理中间态。 */
export function workbenchFinalDialogue(items: WorkbenchTimelineItem[]): WorkbenchTimelineItem[] {
  return items.filter((item) => item.kind === 'user' || item.kind === 'answer')
}

/** 删除某条消息时按「轮」整体删除：删除用户提问会连带其后的中间态步骤与回答，删除回答则连带其同轮的中间态步骤，避免留下「查看步骤」等半处理残留。 */
export function workbenchDeleteTimelineItem(items: WorkbenchTimelineItem[], id: string): WorkbenchTimelineItem[] {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return items
  if (items[index].kind === 'user') {
    let end = index + 1
    while (end < items.length && items[end].kind !== 'user') end += 1
    return [...items.slice(0, index), ...items.slice(end)]
  }
  let start = index
  while (start > 0 && items[start - 1].kind !== 'user') start -= 1
  return [...items.slice(0, start), ...items.slice(index + 1)]
}

/** User turns are removed so they can be replaced; assistant turns remain as the retained boundary. */
export function workbenchRewindTimelineTo(items: WorkbenchTimelineItem[], id: string): WorkbenchTimelineItem[] {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return items
  return items.slice(0, items[index].kind === 'user' ? index : index + 1)
}

/** 提取用户提问与 AI 最终回答，用于在「回退重发」时把前文作为文字上下文重新注入。 */
export function workbenchDialogueToText(items: WorkbenchTimelineItem[], maxTurns = 1_000, maxChars = 120_000): string {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind === 'user') lines.push(`用户：${replayUserText(item.content, item.replay)}`)
    else if (item.kind === 'answer') lines.push(`AI：${item.content}`)
  }
  const text = lines.slice(-maxTurns * 2).join('\n')
  return text.length <= maxChars ? text : text.slice(-maxChars)
}
