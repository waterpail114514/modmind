import { describe, expect, it } from 'vitest'
import { reduceWorkbenchOutput, replayWorkbenchEvents, settleWorkbenchActivity, type WorkbenchTimelineItem } from './workbenchTimeline'
import type { AiOutputEvent, ConversationEventRecord } from '../../shared/types'

describe('workbench activity projection', () => {
  it('keeps an unconfirmed action distinct from success and accepts its late receipt', () => {
    const started: AiOutputEvent = { kind: 'tool', content: '构建项目', time: '2026-10-25T12:00:00Z', turnId: 'turn', streamId: 'build', sequence: 1, activity: { kind: 'build', title: '构建项目', status: 'running', startedAt: '2026-10-25T12:00:00Z' } }
    const settled = settleWorkbenchActivity(reduceWorkbenchOutput([], started))
    expect(settled[0]).toMatchObject({ status: 'warning', activity: { status: 'interrupted' } })
    const completed = reduceWorkbenchOutput(settled, { ...started, sequence: 2, activity: { ...started.activity!, status: 'completed', completedAt: '2026-10-25T12:01:00Z' } })
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ status: 'done', activity: { status: 'completed' } })
  })

  it('updates a process in place, preserves its position, ignores stale updates and replays the same history', () => {
    const activity = { kind: 'build' as const, title: '构建项目', status: 'running' as const, startedAt: '2026-10-25T12:00:00Z' }
    const events: AiOutputEvent[] = [
      { kind: 'tool', activity, content: '构建项目', itemId: 'build', streamId: 'stream', sequence: 1 },
      { kind: 'response', content: '正在准备运行环境', itemId: 'message', streamId: 'message', sequence: 2 },
      { kind: 'tool', activity: { ...activity, detail: '编译 5364 个源文件', output: 'compile\n' }, content: '构建项目', itemId: 'build', streamId: 'stream', sequence: 3 },
      { kind: 'tool', activity: { ...activity, status: 'completed', completedAt: '2026-10-25T12:00:04Z' }, content: '构建项目', itemId: 'build', streamId: 'stream', sequence: 4 }
    ].map((event, index) => ({ ...event, runId: 'run', turnId: 'turn', time: `2026-10-25T12:00:0${index}Z`, eventId: `e${index}` })) as AiOutputEvent[]
    let timeline: WorkbenchTimelineItem[] = []
    for (const event of events) timeline = reduceWorkbenchOutput(timeline, event)
    expect(timeline).toHaveLength(2)
    expect(timeline[0].activity?.status).toBe('completed')
    expect(timeline[1].content).toBe('正在准备运行环境')
    expect(reduceWorkbenchOutput(timeline, events[2])).toBe(timeline)
    const journal = events.map(event => ({ eventId: event.eventId, time: event.time, conversationId: 'c', generation: 0, turnId: 'turn', sequence: event.sequence, kind: 'output', payload: event })) as ConversationEventRecord[]
    expect(replayWorkbenchEvents([], journal)).toEqual(timeline)
    const otherTurn = reduceWorkbenchOutput(timeline, { ...events[0], turnId: 'next', sequence: 5, eventId: 'next' })
    expect(otherTurn).toHaveLength(3)
  })
})
