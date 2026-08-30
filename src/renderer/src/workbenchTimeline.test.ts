import { describe, expect, it } from 'vitest'
import { appendUserTurn, normalizeStoredWorkbenchTimeline, reduceWorkbenchOutput, reduceWorkbenchProgress, workbenchDeleteTimelineItem, workbenchFinalDialogue, type WorkbenchTimelineItem } from './workbenchTimeline'

describe('workbench timeline adapter', () => {
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
    expect(items[0]).toMatchObject({ kind: 'response', status: 'running', content: '我先检查当前项目状态。' })
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
})
