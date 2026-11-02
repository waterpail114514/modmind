import { describe, expect, it } from 'vitest'
import type { AiOutputEvent, ConversationEventRecord, InspirationChatMessage } from '../../shared/types'
import { inspirationActivityRows, settleInspirationActivities, upsertInspirationActivity } from './inspirationActivity'
import { buildInspirationRows, inspirationConversationHandoff, replayInspirationEvents, settleInspirationCancellation } from './inspirationOutput'
import { normalizeStoredInspirationMessages } from './inspirationStorage'

const activityEvent = (sequence: number, status: 'running' | 'completed' | 'failed' = 'running'): AiOutputEvent => ({
  kind: 'tool', content: '读取文件', sequence, eventId: `event-${sequence}`, itemId: 'read', turnId: 'turn', sessionId: 'session',
  time: '2026-10-28T00:00:00Z', activity: { kind: 'tool', title: '读取文件', startedAt: '2026-10-28T00:00:00Z', status,
    ...(status !== 'running' ? { completedAt: '2026-10-28T00:00:01Z' } : {}), output: `output-${sequence}` }
})

describe('shared inspiration process presentation', () => {
  it('renders stored intermediate replies and failure messages without requiring a final marker', () => {
    const messages: InspirationChatMessage[] = [{ id: 'progress', role: 'assistant', content: '补充说明', status: 'completed', isFinal: false },
      { id: 'failure', role: 'assistant', content: '请重试', status: 'error', isFinal: false }]
    expect(buildInspirationRows(messages).map(row => row.id)).toEqual(['progress', 'failure'])
  })
  it('updates a single owned activity before the answer and produces the same journal replay', () => {
    const base: InspirationChatMessage[] = [{ id: 'question', role: 'user', content: '检查', turnId: 'turn', sessionId: 'session' },
      { id: 'answer', role: 'assistant', content: '', status: 'streaming', turnId: 'turn', sessionId: 'session' }]
    const events = [activityEvent(1), activityEvent(2), activityEvent(3, 'completed')]
    const live = events.reduce(upsertInspirationActivity, base)
    expect(live.map(message => message.id)).toEqual(['question', 'activity:turn:read', 'answer'])
    expect(live[1].activity).toMatchObject({ status: 'completed', output: 'output-3' })
    expect(upsertInspirationActivity(live, activityEvent(2))).toBe(live)
    expect(upsertInspirationActivity(live, activityEvent(4))).toBe(live)
    const journal = events.map(event => ({ kind: 'output', payload: event, sequence: event.sequence, eventId: event.eventId, turnId: 'turn',
      conversationId: 'conversation', generation: 0, time: event.time })) as ConversationEventRecord[]
    expect(replayInspirationEvents(base, journal)).toEqual(live)
    expect(inspirationActivityRows([live[1]])[0]).toMatchObject({ kind: 'tool', status: 'done', activity: { output: 'output-3' } })
  })
  it('keeps cancelled and restored activity unconfirmed and excludes it from handoff', () => {
    const messages = upsertInspirationActivity([{ role: 'assistant', id: 'answer', content: '正文', status: 'streaming', sessionId: 'session', turnId: 'turn' }], activityEvent(1))
    for (const settled of [settleInspirationActivities(messages, 'session'), settleInspirationCancellation(messages, 'session'), normalizeStoredInspirationMessages(messages)]) {
      expect(settled.find(message => message.activity)?.activity?.status).toBe('interrupted')
      expect(inspirationConversationHandoff(settled)).not.toContain('output-1')
      expect(inspirationConversationHandoff(settled)).not.toContain('读取文件')
    }
  })
})
