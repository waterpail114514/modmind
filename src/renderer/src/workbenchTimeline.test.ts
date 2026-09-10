import { describe, expect, it } from 'vitest'
import { appendUserTurn, isWorkbenchInternalPrompt, normalizeStoredWorkbenchTimeline, normalizeWorkbenchTimeline, reduceWorkbenchOutput, reduceWorkbenchProgress, replayWorkbenchEvents, workbenchContextUsageState, workbenchDeleteTimelineItem, workbenchDialogueToText, workbenchFinalDialogue, workbenchRewindTimelineTo, type WorkbenchTimelineItem } from './workbenchTimeline'
import type { AiOutputEvent, ConversationEventRecord } from '../../shared/types'

describe('workbench timeline adapter', () => {
  const output = (kind: AiOutputEvent['kind'], content: string, sequence: number, extra: Partial<AiOutputEvent> = {}): AiOutputEvent => ({
    kind, content, sequence, eventId: `event-${sequence}`, time: `2026-09-10T12:30:${String(sequence).padStart(2, '0')}Z`,
    runId: 'run-1', turnId: 'turn-1', ...extra
  })
  const projectOutputs = (events: AiOutputEvent[]): WorkbenchTimelineItem[] => events.reduce((items, event) => reduceWorkbenchOutput(items, event), [] as WorkbenchTimelineItem[])

  it.each([{}, { itemId: 'reply', streamId: 'native-turn:reply' }])('ends a message before the next response starts (%j)', (identity) => {
    const nextIdentity = identity.itemId ? { itemId: 'reply-2', streamId: 'native-turn:reply-2' } : {}
    const items = projectOutputs([
      output('delta', 'First message', 1, identity), output('response', 'First message', 2, identity),
      output('tool', 'Read file', 3),
      output('delta', 'Second message', 4, nextIdentity), output('response', 'Second message', 5, nextIdentity)
    ])
    expect(items.filter(item => item.kind === 'response').map(item => item.content)).toEqual(['First message', 'Second message'])
    expect(items.every(item => item.status === 'done')).toBe(true)
    expect(new Set(items.map(item => item.id)).size).toBe(items.length)
  })

  it('replaces partial stream text with the authoritative completed response', () => {
    const items = projectOutputs([output('delta', 'Part', 1), output('response', 'Complete response', 2)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ content: 'Complete response', status: 'done' })
  })

  it('finishes a stream when the final answer arrives without a response event', () => {
    const items = projectOutputs([output('delta', 'Part', 1), output('answer', 'Complete answer', 2)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'answer', content: 'Complete answer', status: 'done' })
  })

  it('keeps identical but distinct provider messages and isolates interleaved streams', () => {
    const items = projectOutputs([
      output('delta', 'Same', 1, { itemId: 'a' }), output('delta', 'Same', 2, { itemId: 'b' }),
      output('response', 'Same', 3, { itemId: 'b' }), output('response', 'Same', 4, { itemId: 'a' })
    ])
    expect(items.map(item => item.content)).toEqual(['Same', 'Same'])
    expect(new Set(items.map(item => item.id)).size).toBe(2)
  })

  it('does not reopen completed provider messages on repeated completion or late deltas', () => {
    const items = projectOutputs([
      output('delta', 'Hello', 1, { itemId: 'a' }), output('response', 'Hello', 2, { itemId: 'a' }),
      output('response', 'Hello', 3, { itemId: 'a' }), output('delta', 'Hello', 4, { itemId: 'a' })
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ content: 'Hello', status: 'done' })
  })

  it('allocates unique rows after retrying an anonymous stream in the same turn', () => {
    const items = projectOutputs([
      output('delta', 'Interrupted', 1), output('retry', 'Retrying', 2),
      output('delta', 'Resumed', 3), output('response', 'Resumed', 4)
    ])
    expect(items.filter(item => item.kind === 'response').map(item => item.content)).toEqual(['Interrupted', 'Resumed'])
    expect(new Set(items.map(item => item.id)).size).toBe(items.length)
  })

  it('scopes reused provider ids to their user turn', () => {
    const items = projectOutputs([
      output('response', 'Hello', 1, { itemId: 'a' }),
      output('delta', 'Hello', 2, { itemId: 'a', turnId: 'turn-2', runId: 'run-2' }),
      output('response', 'Hello', 3, { itemId: 'a', turnId: 'turn-2', runId: 'run-2' })
    ])
    expect(items.map(item => item.content)).toEqual(['Hello', 'Hello'])
    expect(new Set(items.map(item => item.id)).size).toBe(2)
  })

  it('ignores duplicate delivery by event identity without dropping distinct equal text', () => {
    const response = output('response', 'Same', 1)
    const items = projectOutputs([response, response, output('response', 'Same', 2)])
    expect(items.map(item => item.content)).toEqual(['Same', 'Same'])
  })

  it('does not recreate anonymous streams from old deltas after completion', () => {
    const delta = output('delta', 'Hello', 1)
    const items = projectOutputs([delta, output('response', 'Hello', 2), delta])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ content: 'Hello', status: 'done' })
  })

  it('does not demote a final answer when the provider repeats its completed message', () => {
    const items = projectOutputs([
      output('delta', 'Hello', 1, { itemId: 'a' }), output('answer', 'Hello', 2, { itemId: 'a' }),
      output('response', 'Hello', 3, { itemId: 'a' })
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'answer', content: 'Hello', status: 'done' })
  })

  it('rebuilds corrupted saved messages from the journal and preserves view-only older turns', () => {
    const outputs = [output('delta', 'First', 1), output('response', 'First', 2), output('delta', 'Second', 3), output('response', 'Second', 4)]
    const events: ConversationEventRecord[] = outputs.map(event => ({
      eventId: event.eventId!, conversationId: 'ws-1', generation: 0, turnId: event.turnId!, runId: event.runId,
      sequence: event.sequence!, kind: 'output', time: event.time, payload: event
    }))
    const view: WorkbenchTimelineItem[] = [
      { id: 'older', kind: 'answer', content: 'Previous answer', time: '2026-09-09T00:00:00Z', turnId: 'turn-0' },
      { id: 'broken', kind: 'response', content: 'FirstSecond', time: outputs[0].time, turnId: 'turn-1' },
      { id: 'duplicate', kind: 'response', content: 'Second', time: outputs[2].time, turnId: 'turn-1' }
    ]
    const replayed = replayWorkbenchEvents(view, [...events, events[0]])
    expect(replayed.map(item => item.content)).toEqual(['Previous answer', 'First', 'Second'])
    expect(replayWorkbenchEvents(replayed, events)).toEqual(replayed)
  })

  it('merges streaming deltas into one assistant message', () => {
    const started = reduceWorkbenchOutput([], { kind: 'stream-start', content: '', time: '2026-01-01T00:00:00Z', runId: 'r1' })
    const first = reduceWorkbenchOutput(started, { kind: 'delta', content: '你好', time: '2026-01-01T00:00:01Z', runId: 'r1' })
    const second = reduceWorkbenchOutput(first, { kind: 'delta', content: '，世界', time: '2026-01-01T00:00:02Z', runId: 'r1' })
    expect(second).toHaveLength(1)
    expect(second[0].content).toBe('你好，世界')
  })

  it('deduplicates the terminal answer for a run', () => {
    const response = reduceWorkbenchOutput([], { kind: 'response', content: '完成', time: '2026-01-01T00:00:00Z', runId: 'r1' })
    const answer = reduceWorkbenchOutput(response, { kind: 'answer', content: '完成', time: '2026-01-01T00:00:01Z', runId: 'r1' })
    expect(answer).toHaveLength(1)
    expect(answer[0]).toMatchObject({ kind: 'answer', status: 'done', content: '完成' })
  })

  it('keeps identical answers from separate user turns', () => {
    const first = reduceWorkbenchOutput([], { kind: 'answer', content: '完成', time: '2026-01-01T00:00:00Z', runId: 'r1' })
    const withUser = appendUserTurn(first, '再执行一次', 'r2', '2026-01-01T00:00:01Z')
    const second = reduceWorkbenchOutput(withUser, { kind: 'answer', content: '完成', time: '2026-01-01T00:00:02Z', runId: 'r2' })
    expect(second.filter((item) => item.kind === 'answer')).toHaveLength(2)
  })

  it('keeps interim assistant text visible instead of hiding it as a tool step', () => {
    const items = reduceWorkbenchOutput([], {
      kind: 'response',
      content: '我先检查当前项目状态。',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1'
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'response', status: 'done', content: '我先检查当前项目状态。' })
  })

  it('parses code diff payloads into structured timeline items', () => {
    const diff = [{ path: 'src/Main.java', added: 2, removed: 1, additions: ['new'], removals: ['old'] }]
    const items = reduceWorkbenchOutput([], {
      kind: 'tool',
      content: `__CODE_DIFF__${JSON.stringify(diff)}`,
      time: '2026-01-01T00:00:00Z',
      runId: 'r1'
    })
    expect(items[0]).toMatchObject({ kind: 'diff', diff })
  })

  it('turns progress updates into one live thinking step', () => {
    const running = reduceWorkbenchProgress([], { id: '1', runId: 'r1', stage: 'checking', title: '检查', detail: '读取文件', status: 'running', time: '2026-01-01T00:00:00Z' })
    const done = reduceWorkbenchProgress(running, { id: '2', runId: 'r1', stage: 'checking', title: '检查完成', detail: '通过', status: 'success', time: '2026-01-01T00:00:01Z' })
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ kind: 'tool', status: 'done', content: '检查完成\n通过' })
  })

  it('keeps the user request as a conversation turn', () => {
    expect(appendUserTurn([], '制作矿石', 'r1')[0]).toMatchObject({ kind: 'user', content: '制作矿石' })
  })

  it('restores mixed legacy and sequenced records by event time', () => {
    const mixed: WorkbenchTimelineItem[] = [
      { id: 'new-answer', kind: 'answer', content: '完成', time: '2026-09-05T15:43:48.758Z', sequence: 1252 },
      { id: 'old-user', kind: 'user', content: '制作整合包', time: '2026-09-05T15:28:06.359Z' },
      { id: 'old-tool', kind: 'tool', content: '读取文件', time: '2026-09-05T15:28:16.903Z' },
      { id: 'new-complete', kind: 'tool', content: '任务完成', time: '2026-09-05T15:43:48.758Z', sequence: 1253 }
    ]
    expect(normalizeWorkbenchTimeline(mixed).map((item) => item.id)).toEqual(['old-user', 'old-tool', 'new-answer', 'new-complete'])
  })

  it('does not expose internal workflow prompts as user history', () => {
    const internal = 'SYSTEM WORKFLOW INSTRUCTIONS:\nMANAGED DOWNLOAD POLICY.'
    expect(isWorkbenchInternalPrompt(internal)).toBe(true)
    expect(normalizeWorkbenchTimeline([
      { id: 'system', kind: 'user', content: internal, time: '2026-08-26T06:28:46.223Z' },
      { id: 'visible', kind: 'user', content: '制作整合包', time: '2026-08-26T06:29:00.000Z' }
    ]).map((item) => item.id)).toEqual(['visible'])
  })

  it('groups durable event ids by turn instead of splitting every delta', () => {
    const first = reduceWorkbenchOutput([], { kind: 'delta', content: '你', time: 'T1', turnId: 'turn-1', eventId: 'event-1', sequence: 1 })
    const second = reduceWorkbenchOutput(first, { kind: 'delta', content: '好', time: 'T2', turnId: 'turn-1', eventId: 'event-2', sequence: 2 })
    const completed = reduceWorkbenchOutput(second, { kind: 'response', content: '你好', time: 'T3', turnId: 'turn-1', eventId: 'event-3', sequence: 3 })
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ id: first[0].id, content: '你好', sequence: 3, status: 'done' })
  })

  it('prefers structured replay data while legacy text remains a fallback', () => {
    const item = appendUserTurn([], '制作矿石\n\n附件：设计.png', 'r1', 'T01', {
      prompt: '制作矿石',
      attachments: [{ id: 'a1', name: '设计.png', path: '.modmind/attachments/a1-design.png', size: 12, isImage: true }]
    })[0]
    expect(item.replay?.prompt).toBe('制作矿石')
    expect(workbenchDialogueToText([item])).toContain('.modmind/attachments/a1-design.png')
    expect(workbenchDialogueToText([{ id: 'legacy', kind: 'user', content: '旧消息', time: 'T00' }])).toBe('用户：旧消息')
  })

  it('keeps context status available before usage and with an unknown window', () => {
    expect(workbenchContextUsageState(undefined)).toEqual({ kind: 'waiting' })
    expect(workbenchContextUsageState({ inputTokens: 24_763, outputTokens: 122 })).toEqual({ kind: 'tokens' })
    expect(workbenchContextUsageState({ inputTokens: 80_000, contextWindow: 100_000 })).toEqual({ kind: 'capacity', ratio: 0.8, percent: 80 })
  })

  it('keeps the final answer after retries and tools even when response arrived first', () => {
    let items = reduceWorkbenchOutput([], { kind: 'response', content: '先说明进度', time: 'T1', runId: 'r1', turnId: 'turn-1', sequence: 2 })
    items = reduceWorkbenchOutput(items, { kind: 'retry', content: '上游暂时不可用', time: 'T2', runId: 'r1', turnId: 'turn-1', sequence: 3 })
    items = reduceWorkbenchOutput(items, { kind: 'tool', content: '读取文件', time: 'T3', runId: 'r1', turnId: 'turn-1', sequence: 4 })
    items = reduceWorkbenchOutput(items, { kind: 'answer', content: '最终答案', time: 'T4', runId: 'r1', turnId: 'turn-1', sequence: 5 })
    expect(items.map((item) => item.kind)).toEqual(['response', 'retry', 'tool', 'answer'])
    expect(items.at(-1)).toMatchObject({ kind: 'answer', content: '最终答案', sequence: 5 })
  })

  it('preserves repeated stages as separate historical items', () => {
    let items = reduceWorkbenchProgress([], { id: 'p1', runId: 'r1', turnId: 'turn-1', stage: 'planning', title: '规划 1', detail: '', status: 'success', time: 'T1', sequence: 1 })
    items = reduceWorkbenchProgress(items, { id: 'p2', runId: 'r1', turnId: 'turn-1', stage: 'planning', title: '规划 2', detail: '', status: 'success', time: 'T2', sequence: 2 })
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.content.split('\n')[0])).toEqual(['规划 1', '规划 2'])
  })

  it('replays the complete durable journal without dropping tool history', () => {
    const events: ConversationEventRecord[] = [
      { eventId: 'u1', conversationId: 'ws-1', generation: 0, turnId: 'turn-1', sequence: 1, kind: 'user', time: 'T1', payload: { prompt: '做一个整合包' } },
      { eventId: 'p1', conversationId: 'ws-1', generation: 0, turnId: 'turn-1', sequence: 2, kind: 'progress', time: 'T2', payload: { id: 'p1', runId: 'r1', turnId: 'turn-1', stage: 'planning', title: '规划', detail: '', status: 'success', time: 'T2' } },
      { eventId: 't1', conversationId: 'ws-1', generation: 0, turnId: 'turn-1', sequence: 3, kind: 'output', time: 'T3', payload: { kind: 'tool', content: '读取文件', time: 'T3', runId: 'r1', turnId: 'turn-1' } },
      { eventId: 'a1', conversationId: 'ws-1', generation: 0, turnId: 'turn-1', sequence: 4, kind: 'output', time: 'T4', payload: { kind: 'answer', content: '完成', time: 'T4', runId: 'r1', turnId: 'turn-1' } }
    ]
    const replayed = replayWorkbenchEvents([], events)
    expect(replayed.map((item) => item.kind)).toEqual(['user', 'tool', 'tool', 'answer'])
    expect(replayed.map((item) => item.sequence)).toEqual([1, 2, 3, 4])
  })

  it('preserves recoverable errors as step metadata instead of terminal failures', () => {
    const items = reduceWorkbenchOutput([], {
      kind: 'error',
      content: '审查服务暂时不可用，正在重试',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1',
      terminal: false,
      recoverable: true
    })
    expect(items[0]).toMatchObject({ kind: 'error', status: 'error', terminal: false, recoverable: true })
  })

  it('keeps terminal errors distinguishable from recoverable progress', () => {
    const items = reduceWorkbenchOutput([], {
      kind: 'error',
      content: 'Agent 已退出且无法继续',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1',
      terminal: true
    })
    expect(items[0]).toMatchObject({ kind: 'error', terminal: true })
  })

  it('keeps warnings and retries yellow inside the steps group', () => {
    const warning = reduceWorkbenchOutput([], { kind: 'warning', content: '正在改用备用路径', time: '2026-01-01T00:00:00Z', runId: 'r1' })
    const retry = reduceWorkbenchOutput(warning, { kind: 'retry', content: '继续', time: '2026-01-01T00:00:01Z', runId: 'r1' })
    expect(retry).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'warning', status: 'warning', terminal: false }),
      expect.objectContaining({ kind: 'retry', status: 'warning', terminal: false })
    ]))
  })

  it('treats legacy unmarked errors as recoverable steps', () => {
    expect(normalizeStoredWorkbenchTimeline({
      id: 'legacy-error',
      kind: 'error',
      content: '命令执行失败（退出码 1）',
      time: '2026-01-01T00:00:00Z',
      status: 'error'
    })).toMatchObject({ kind: 'error', status: 'error', terminal: false, recoverable: true })
  })

  it('migrates old guessed terminal tool errors but preserves explicit terminal failures', () => {
    const legacy = normalizeStoredWorkbenchTimeline({
      id: 'legacy-terminal', kind: 'error', content: 'fatal: not a git repository',
      time: '2026-01-01T00:00:00Z', status: 'error', terminal: true
    })
    const explicit = normalizeStoredWorkbenchTimeline({
      id: 'explicit-terminal', kind: 'error', content: 'Agent 已退出且无法继续',
      time: '2026-01-01T00:00:01Z', status: 'error', terminal: true, recoverable: false
    })
    expect(legacy).toMatchObject({ terminal: false, recoverable: true })
    expect(explicit).toMatchObject({ terminal: true, recoverable: false })
  })

  it('settles restored thinking when a new stage or final answer arrives', () => {
    const restored = reduceWorkbenchProgress([], { id: '1', runId: 'r1', stage: 'planning', title: 'Codex 已恢复会话', detail: '继续任务', status: 'running', time: '2026-01-01T00:00:00Z' })
    const checking = reduceWorkbenchProgress(restored, { id: '2', runId: 'r1', stage: 'checking', title: '正在检查', detail: '读取结果', status: 'running', time: '2026-01-01T00:00:01Z' })
    expect(checking.find((item) => item.content.startsWith('Codex 已恢复会话'))).toMatchObject({ status: 'done' })
    const answered = reduceWorkbenchOutput(checking, { kind: 'answer', content: '完成', time: '2026-01-01T00:00:02Z', runId: 'r1' })
    expect(answered.some((item) => item.status === 'running')).toBe(false)
  })

  it('rewinds to only user turns and final answers, dropping interim artifacts', () => {
    const items: WorkbenchTimelineItem[] = [
      { id: 'u1', kind: 'user', content: '做一个火把', time: 'T01' },
      { id: 'd1', kind: 'diff', content: '代码修改已应用', time: 'T02', status: 'done' },
      { id: 'a1', kind: 'answer', content: '已完成火把', time: 'T03', status: 'done' },
      { id: 'p1', kind: 'thinking', content: '思考中', time: 'T04', status: 'running' },
      { id: 't1', kind: 'tool', content: '写入文件', time: 'T05', status: 'done' },
      { id: 's1', kind: 'start', content: '任务开始', time: 'T06', status: 'done' },
      { id: 'r1', kind: 'retry', content: '重试', time: 'T07', status: 'warning' },
      { id: 'h1', kind: 'history', content: '已恢复上下文', time: 'T08' },
      { id: 'st1', kind: 'status', content: '状态', time: 'T09', status: 'done' },
      { id: 'rs1', kind: 'response', content: '流式残留', time: 'T10', status: 'running' },
      { id: 'w1', kind: 'warning', content: '警告', time: 'T11', status: 'warning' },
      { id: 'e1', kind: 'error', content: '错误', time: 'T12', status: 'error' },
      { id: 'u2', kind: 'user', content: '改成金色', time: 'T13' }
    ]
    expect(workbenchFinalDialogue(items).map((item) => item.kind)).toEqual(['user', 'answer', 'user'])
  })

  it('returns an empty list when there is no user turn or final answer', () => {
    const items: WorkbenchTimelineItem[] = [
      { id: 'p1', kind: 'thinking', content: '思考', time: 'T01', status: 'running' },
      { id: 't1', kind: 'tool', content: '工具', time: 'T02', status: 'done' },
      { id: 'e1', kind: 'error', content: '错误', time: 'T03', status: 'error' }
    ]
    expect(workbenchFinalDialogue(items)).toEqual([])
  })

  it('deleting a user turn removes its steps and answer but keeps later turns', () => {
    const items: WorkbenchTimelineItem[] = [
      { id: 'u1', kind: 'user', content: '做火把', time: 'T01' },
      { id: 's1', kind: 'start', content: '任务开始', time: 'T02', status: 'done' },
      { id: 't1', kind: 'tool', content: '写入文件', time: 'T03', status: 'done' },
      { id: 'e1', kind: 'error', content: '上游拒绝 400', time: 'T04', status: 'error' },
      { id: 'a1', kind: 'answer', content: '已完成', time: 'T05', status: 'done' },
      { id: 'u2', kind: 'user', content: '改成金色', time: 'T06' }
    ]
    expect(workbenchDeleteTimelineItem(items, 'u1').map((item) => item.id)).toEqual(['u2'])
  })

  it('deleting an answer removes its own turn artifacts but keeps the user prompt', () => {
    const items: WorkbenchTimelineItem[] = [
      { id: 'u1', kind: 'user', content: '做火把', time: 'T01' },
      { id: 's1', kind: 'start', content: '任务开始', time: 'T02', status: 'done' },
      { id: 't1', kind: 'tool', content: '写入文件', time: 'T03', status: 'done' },
      { id: 'a1', kind: 'answer', content: '已完成', time: 'T04', status: 'done' },
      { id: 'u2', kind: 'user', content: '改成金色', time: 'T05' }
    ]
    expect(workbenchDeleteTimelineItem(items, 'a1').map((item) => item.id)).toEqual(['u1', 'u2'])
  })

  it('deleting an unknown id leaves the timeline unchanged', () => {
    const items: WorkbenchTimelineItem[] = [
      { id: 'u1', kind: 'user', content: '做火把', time: 'T01' }
    ]
    expect(workbenchDeleteTimelineItem(items, 'missing')).toEqual(items)
  })

  it('rewinds before a selected user turn and after a selected assistant answer', () => {
    const items: WorkbenchTimelineItem[] = [
      { id: 'u1', kind: 'user', content: '做火把', time: 'T01' },
      { id: 't1', kind: 'tool', content: '写入文件', time: 'T02', status: 'done' },
      { id: 'a1', kind: 'answer', content: '已完成', time: 'T03', status: 'done' },
      { id: 'u2', kind: 'user', content: '改成金色', time: 'T04' }
    ]
    expect(workbenchRewindTimelineTo(items, 'u2').map((item) => item.id)).toEqual(['u1', 't1', 'a1'])
    expect(workbenchRewindTimelineTo(items, 'a1').map((item) => item.id)).toEqual(['u1', 't1', 'a1'])
    expect(workbenchRewindTimelineTo(items, 'missing')).toBe(items)
  })
})
