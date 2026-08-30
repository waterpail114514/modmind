import type { AiOutputEvent, AiTokenUsage, PipelineEvent } from '../../shared/types'

export type WorkbenchTimelineDiff = { path: string; added: number; removed: number; additions: string[]; removals: string[] }

export type WorkbenchTimelineItem = {
  id: string
  kind: 'user' | 'answer' | 'response' | 'thinking' | 'tool' | 'diff' | 'warning' | 'error' | 'start' | 'retry' | 'history' | 'status'
  content: string
  time: string
  runId?: string
  status?: 'running' | 'done' | 'warning' | 'error'
  terminal?: boolean
  recoverable?: boolean
  diff?: WorkbenchTimelineDiff[]
  usage?: AiTokenUsage
}

/** Latest usage in the timeline; recovers the context badge after a restart. */
export function latestWorkbenchUsage(items: WorkbenchTimelineItem[]): AiTokenUsage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const usage = items[index]?.usage
    if (usage) return usage
  }
  return undefined
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

function eventIdentity(event: Pick<AiOutputEvent, 'runId' | 'sessionId' | 'time'>): string {
  return event.runId || event.sessionId || event.time
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

export function appendUserTurn(items: WorkbenchTimelineItem[], text: string, runId: string, time = new Date().toISOString()): WorkbenchTimelineItem[] {
  return bounded([...items, { id: `${runId}:user`, kind: 'user', content: text, time, runId, status: 'done' }])
}

export function reduceWorkbenchOutput(
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
    if (index < 0) return bounded([...currentItems, { id: `${identity}:assistant:${event.time}`, kind: 'response', content, time: event.time, runId: event.runId, status: 'running' }])
    const next = [...currentItems]
    next[index] = { ...next[index], content: mergeStreamingText(next[index].content, content), status: 'running' }
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
    return bounded([...currentItems, { id: assistantId, kind: event.kind, content, time: event.time, runId: event.runId, status: event.kind === 'answer' ? 'done' : 'running', ...(event.usage ? { usage: event.usage } : {}) }])
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

export function reduceWorkbenchProgress(
  items: WorkbenchTimelineItem[],
  event: PipelineEvent,
  normalize: (value: string) => string = (value) => value
): WorkbenchTimelineItem[] {
  const currentItems = settleWorkbenchActivity(items, true)
  const identity = event.runId || event.sessionId || event.time
  const id = `${identity}:progress:${event.stage}`
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
    status,
    ...(event.terminal !== undefined ? { terminal: event.terminal } : {}),
    ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {})
  }
  if (index < 0) return bounded([...currentItems, item])
  const next = [...currentItems]
  next[index] = item
  return next
}

export function normalizeStoredWorkbenchTimeline(item: WorkbenchTimelineItem): WorkbenchTimelineItem {
  if (item.kind === 'warning' || item.kind === 'retry') return { ...item, status: 'warning', terminal: false, recoverable: true }
  if (item.kind !== 'error') return item
  if (/(?:warning|warn|deprecated|deprecation|警告|重试|重新连接)/i.test(item.content)) return { ...item, kind: 'warning', status: 'warning', terminal: false, recoverable: true }
  // Earlier builds guessed terminal=true from error text and persisted that
  // guess. Only the new explicit pair is authoritative across restarts.
  if (item.terminal === true && item.recoverable === false) return item
  if (/(?:error|fatal|exception|failed|forbidden|unauthori[sz]ed|timed out|timeout|错误|失败|异常|无法|超时|退出码|拒绝)/i.test(item.content)) return { ...item, terminal: false, recoverable: true }
  return { ...item, kind: 'tool', status: 'done', terminal: false, recoverable: true }
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

/** 提取用户提问与 AI 最终回答，用于在「回退重发」时把前文作为文字上下文重新注入。 */
export function workbenchDialogueToText(items: WorkbenchTimelineItem[], maxTurns = 8): string {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind === 'user') lines.push(`用户：${item.content}`)
    else if (item.kind === 'answer') lines.push(`AI：${item.content}`)
  }
  return lines.slice(-maxTurns * 2).join('\n')
}
