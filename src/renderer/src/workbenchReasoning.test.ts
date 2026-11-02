import { describe, expect, it } from 'vitest'
import { normalizeStoredWorkbenchTimeline, reduceWorkbenchOutput, replayWorkbenchEvents, settleWorkbenchActivity, type WorkbenchTimelineItem } from './workbenchTimeline'
import type { AiOutputEvent, AiReasoningUpdate, ConversationEventRecord } from '../../shared/types'

const event = (sequence: number, reasoning: AiReasoningUpdate, content = '', turnId = 'turn'): AiOutputEvent => ({
  kind: 'reasoning', reasoning, content, sequence, eventId: `event-${sequence}`, itemId: 'thought', streamId: `${turnId}:thought`, turnId, runId: 'run',
  time: new Date(1_700_000_000_000 + sequence * 100).toISOString()
})
const delta = (index = 0, channel: 'summary' | 'text' = 'summary'): AiReasoningUpdate => ({ phase: 'delta', index, channel })

describe('workbench reasoning projection', () => {
  it('preserves indexed summary and raw text separately, without humanizing or deduplicating real repeated words', () => {
    let items = reduceWorkbenchOutput([], event(1, { phase: 'start' }))
    for (const update of [event(2, delta(), '先检查'), event(3, delta(), '检查'), event(4, delta(1), '再验证'), event(5, delta(0, 'text'), 'actual tool reasoning')]) {
      items = reduceWorkbenchOutput(items, update, () => '替换后的活动标题')
    }
    expect(items).toHaveLength(1)
    expect(items[0].reasoning).toEqual({ summary: ['先检查检查', '再验证'], text: ['actual tool reasoning'] })
    expect(items[0].kind).toBe('reasoning')
    const complete = event(6, { phase: 'completed', summary: ['修订后的概要'], text: ['完整过程'] })
    items = reduceWorkbenchOutput(items, complete)
    expect(items[0]).toMatchObject({ status: 'done', reasoning: { summary: ['修订后的概要'], text: ['完整过程'] } })
    expect(reduceWorkbenchOutput(items, complete)).toEqual(items)
    expect(reduceWorkbenchOutput(items, event(7, delta(), '迟到的字'))).toEqual(items)
  })

  it('keeps reasoning out of the answer, isolates turns, and settles interrupted work', () => {
    let items = reduceWorkbenchOutput([], event(1, delta(), 'A'))
    items = reduceWorkbenchOutput(items, event(2, delta(), 'B', 'other'))
    expect(items.map(item => item.content)).toEqual(['A', 'B'])
    items = reduceWorkbenchOutput(items, { kind: 'answer', content: '最终回答', time: event(3, delta()).time, sequence: 3, turnId: 'turn', streamId: 'answer' })
    expect(items.filter(item => item.kind === 'answer').map(item => item.content)).toEqual(['最终回答'])
    expect(items.filter(item => item.kind === 'reasoning').every(item => item.status === 'done')).toBe(true)
    const interrupted = settleWorkbenchActivity(reduceWorkbenchOutput([], event(1, delta(), '部分内容')))
    expect(normalizeStoredWorkbenchTimeline(interrupted[0])).toMatchObject({ status: 'done', reasoning: { summary: ['部分内容'], text: [] } })
  })

  it('produces identical live and journal projections, including sparse sections and completion snapshots', () => {
    const events = [event(1, { phase: 'start' }), event(2, delta(1), '第二节'), event(3, delta(0, 'text'), '过程'),
      event(4, { phase: 'completed', summary: ['第一节', '第二节'], text: ['过程'] })]
    const live = events.reduce((items, update) => reduceWorkbenchOutput(items, update), [] as WorkbenchTimelineItem[])
    const journal: ConversationEventRecord[] = events.map(update => ({ eventId: update.eventId!, conversationId: 'conversation', generation: 0, turnId: 'turn', sequence: update.sequence!, kind: 'output', payload: update, time: update.time, runId: 'run' }))
    expect(replayWorkbenchEvents([], journal)).toEqual(live)
    expect(replayWorkbenchEvents(live, journal)).toEqual(live)
    const partial = events.slice(0, 3).reduce((items, update) => reduceWorkbenchOutput(items, update), [] as WorkbenchTimelineItem[])
    expect(partial[0].reasoning?.summary[1]).toBe('第二节')
    expect(reduceWorkbenchOutput(partial, event(5, delta(999999), 'invalid'))).toEqual(partial)
  })
})
