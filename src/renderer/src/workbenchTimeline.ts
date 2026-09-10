import { normalizeAiTurnReplay, replayUserText } from '../../shared/aiReplay'
import type { AiOutputEvent, AiTokenUsage, AiTurnReplay, ConversationEventRecord, PipelineEvent } from '../../shared/types'

export type WorkbenchTimelineDiff = { path: string; added: number; removed: number; additions: string[]; removals: string[] }

export type WorkbenchTimelineItem = {
  id: string
  kind: 'user' | 'answer' | 'response' | 'thinking' | 'tool' | 'diff' | 'warning' | 'error' | 'start' | 'retry' | 'history' | 'status'
  content: string
  time: string
  runId?: string
  turnId?: string
  itemId?: string
  streamId?: string
  eventId?: string
  stage?: string
  sequence?: number
  status?: 'running' | 'done' | 'warning' | 'error'
  terminal?: boolean
  recoverable?: boolean
  diff?: WorkbenchTimelineDiff[]
  usage?: AiTokenUsage
  replay?: AiTurnReplay
}

/** Latest usage in the timeline; recovers the context badge after a restart. */
export function latestWorkbenchUsage(items: WorkbenchTimelineItem[]): AiTokenUsage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const usage = items[index]?.usage
    if (usage) return usage
  }
  return undefined
}

export type WorkbenchContextUsageState =
  | { kind: 'waiting' }
  | { kind: 'tokens' }
  | { kind: 'capacity'; ratio: number; percent: number }

export function workbenchContextUsageState(usage: AiTokenUsage | undefined): WorkbenchContextUsageState {
  if (!usage) return { kind: 'waiting' }
  const hasReportedTokens = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]
    .some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  if (!hasReportedTokens) return { kind: 'waiting' }
  if (typeof usage.contextWindow !== 'number' || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0
    || typeof usage.inputTokens !== 'number' || !Number.isFinite(usage.inputTokens) || usage.inputTokens < 0) {
    return { kind: 'tokens' }
  }
  const ratio = usage.inputTokens / usage.contextWindow
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
    const a = Number.isSafeInteger(left.item.sequence) ? left.item.sequence! : Number.MAX_SAFE_INTEGER
    const b = Number.isSafeInteger(right.item.sequence) ? right.item.sequence! : Number.MAX_SAFE_INTEGER
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
  return orderTimeline(items.filter((item) => !(item.kind === 'user' && isWorkbenchInternalPrompt(item.content))))
}

function mergeStreamingText(current: string, incoming: string): string {
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
    return { ...item, status: 'done' as const }
  })
  return changed ? next : items
}

export function appendUserTurn(items: WorkbenchTimelineItem[], text: string, runId: string, time = new Date().toISOString(), replay?: AiTurnReplay): WorkbenchTimelineItem[] {
  return bounded([...items, { id: `${runId}:user`, kind: 'user', content: text, time, runId, turnId: `turn-${runId}`, status: 'done', ...(replay ? { replay } : {}) }])
}

function legacyReduceWorkbenchOutput(
  items: WorkbenchTimelineItem[],
  event: AiOutputEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  const content = normalize(event.content)
  const identity = eventIdentity(event)
  const assistantId = `${identity}:assistant`
  const currentItems = event.kind === 'answer' || event.kind === 'error' && event.terminal === true
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

export function reduceWorkbenchOutput(
  items: WorkbenchTimelineItem[],
  event: AiOutputEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  if (items.some((item) => sameOutputTurn(item, event) && (
    event.eventId && item.eventId === event.eventId
    || event.sequence !== undefined && item.sequence === event.sequence
  ))) return items
  const content = normalize(event.content)
  const current = event.kind === 'answer' || (event.kind === 'error' && event.terminal === true)
    ? settleWorkbenchActivity(items)
    : items
  const identity = eventIdentity(event)
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
    return orderTimeline([...settled, { id: `${event.kind}:${identity}`, kind: event.kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, status: event.kind === 'retry' ? 'warning' : 'done', ...(event.kind === 'retry' ? { terminal: false, recoverable: true } : {}) }])
  }
  const kind: WorkbenchTimelineItem['kind'] = event.kind === 'tool' ? 'tool' : event.kind === 'warning' ? 'warning' : event.kind === 'error' ? 'error' : 'status'
  const errorLike = event.kind === 'error' || event.kind === 'warning'
  const terminal = errorLike ? event.terminal === true : event.terminal
  const recoverable = errorLike ? event.recoverable ?? !terminal : event.recoverable
  return orderTimeline([...current, {
    id: `${kind}:${identity}`, kind, content, time: event.time, runId: event.runId ?? event.sessionId, turnId: event.turnId, sequence: event.sequence, eventId: event.eventId, stage: event.kind,
    status: event.kind === 'error' ? 'error' : event.kind === 'warning' ? 'warning' : 'done',
    ...(terminal !== undefined ? { terminal } : {}), ...(recoverable !== undefined ? { recoverable } : {})
  }])
}

export function reduceWorkbenchProgress(
  items: WorkbenchTimelineItem[],
  event: PipelineEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
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
    runId: event.runId,
    turnId: event.turnId,
    sequence: event.sequence,
    stage: event.stage,
    status,
    ...(event.terminal !== undefined ? { terminal: event.terminal } : {}),
    ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {})
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
 * Rebuilds the visible timeline from the complete durable journal. This follows
 * the same item-reconciliation rule as Codex/OpenCode: only a matching stream
 * updates an existing projection item; all other records retain their order.
 */
export function replayWorkbenchEvents(
  view: WorkbenchTimelineItem[],
  events: ConversationEventRecord[],
  normalizeActivity: (value: string) => string = (value) => value,
  normalizeOutput: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  if (!events.length) return normalizeWorkbenchTimeline(view)
  const replayedTurns = new Set(events.filter((event) => event.kind === 'output' || event.kind === 'progress').map((event) => event.turnId))
  // Forks and migrated conversations can have older turns only in the saved view.
  const result = view.filter((item) => item.kind === 'user' ? !isWorkbenchInternalPrompt(item.content)
    : !replayedTurns.has(item.turnId ?? `turn-${item.runId}`)).map((item) => ({ ...item }))
  const knownUsers = new Map(result.filter((item) => item.kind === 'user' && item.turnId).map((item) => [item.turnId!, item]))
  const seenEvents = new Set<string>()
  for (const record of [...events].sort((left, right) => left.sequence - right.sequence)) {
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
      result.splice(0, result.length, ...reduceWorkbenchProgress(result, { ...(record.payload as PipelineEvent), sequence: record.sequence, eventId: record.eventId }, normalizeActivity))
      continue
    }
    if (record.kind === 'output' && record.payload && typeof record.payload === 'object') {
      result.splice(0, result.length, ...reduceWorkbenchOutput(result, { ...(record.payload as AiOutputEvent), sequence: record.sequence, eventId: record.eventId }, normalizeOutput))
    }
  }
  return settleWorkbenchActivity(orderTimeline(result))
}

export function normalizeStoredWorkbenchTimeline(item: WorkbenchTimelineItem): WorkbenchTimelineItem {
  const replay = normalizeAiTurnReplay(item.replay)
  const normalized = replay ? { ...item, replay } : item.replay ? { ...item, replay: undefined } : item
  if (normalized.kind === 'warning' || normalized.kind === 'retry') return { ...normalized, status: 'warning', terminal: false, recoverable: true }
  if (normalized.kind !== 'error') return normalized
  if (/(?:warning|warn|deprecated|deprecation|警告|重试|重新连接)/i.test(normalized.content)) return { ...normalized, kind: 'warning', status: 'warning', terminal: false, recoverable: true }
  // Earlier builds guessed terminal=true from error text and persisted that
  // guess. Only the new explicit pair is authoritative across restarts.
  if (normalized.terminal === true && normalized.recoverable === false) return normalized
  if (/(?:error|fatal|exception|failed|forbidden|unauthori[sz]ed|timed out|timeout|错误|失败|异常|无法|超时|退出码|拒绝)/i.test(normalized.content)) return { ...normalized, terminal: false, recoverable: true }
  return { ...normalized, kind: 'tool', status: 'done', terminal: false, recoverable: true }
}

export function timelineToPlainText(items: WorkbenchTimelineItem[]): string {
  const labels: Partial<Record<WorkbenchTimelineItem['kind'], string>> = { history: '已恢复上下文', start: '任务开始', retry: '重试', tool: '工具结果', warning: '警告', error: '错误', diff: '代码修改', status: '状态', user: '你' }
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
