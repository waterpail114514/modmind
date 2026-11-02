import { describe, expect, it } from 'vitest'
import type { AiOutputEvent, AiReasoningUpdate, ConversationEventRecord, InspirationChatMessage } from '../../shared/types'
import { buildInspirationRows, inspirationConversationHandoff, replayInspirationEvents, settleInspirationCancellation, settleInspirationFailure, settleInspirationReasoning, settleInspirationReply, upsertInspirationReasoning } from './inspirationOutput'
import { normalizeStoredInspirationMessages } from './inspirationStorage'

const event = (sequence: number, reasoning: AiReasoningUpdate, content = '', turnId = 'turn'): AiOutputEvent => ({
  kind: 'reasoning', reasoning, content, sequence, eventId: `event-${sequence}`, itemId: 'thought', streamId: `${turnId}:thought`,
  turnId, sessionId: 'session', runId: 'run', time: 'T'
})
const initial: InspirationChatMessage[] = [
  { role: 'user', content: '只讨论方案', turnId: 'turn' },
  { role: 'assistant', content: '', status: 'streaming', turnId: 'turn', sessionId: 'session', isFinal: false }
]

describe('inspiration reasoning', () => {
  it('keeps summary and text separate from the answer and preserves genuine repeated deltas', () => {
    let messages = upsertInspirationReasoning(initial, event(1, { phase: 'start' }))
    messages = upsertInspirationReasoning(messages, event(2, { phase: 'delta', channel: 'summary', index: 1 }, '检查'))
    messages = upsertInspirationReasoning(messages, event(3, { phase: 'delta', channel: 'summary', index: 1 }, '检查'))
    messages = upsertInspirationReasoning(messages, event(4, { phase: 'delta', channel: 'text', index: 0 }, 'actual reasoning'))
    expect(messages.map(message => message.kind)).toEqual([undefined, 'reasoning', undefined])
    expect(messages[1].reasoning).toEqual({ summary: [undefined, '检查检查'], text: ['actual reasoning'] })
    expect(messages[2].content).toBe('')
    expect(buildInspirationRows(messages).map(row => row.kind)).toEqual(['message', 'reasoning', 'message'])
    expect(inspirationConversationHandoff(messages)).toBe('User: 只讨论方案')
    expect(upsertInspirationReasoning(messages, event(5, { phase: 'delta', channel: 'summary', index: 9999 }, 'invalid'))).toBe(messages)
    const complete = event(6, { phase: 'completed', summary: ['最终概要'], text: ['完整过程'] })
    messages = upsertInspirationReasoning(messages, complete)
    expect(messages[1]).toMatchObject({ status: 'completed', isFinal: false, reasoning: { summary: ['最终概要'], text: ['完整过程'] } })
    expect(upsertInspirationReasoning(messages, complete)).toBe(messages)
    expect(upsertInspirationReasoning(messages, event(7, { phase: 'delta', channel: 'summary', index: 0 }, 'late'))).toBe(messages)
  })

  it('restores identical reasoning from the journal and keeps subsequent answer deltas in the answer', () => {
    const events = [event(1, { phase: 'start' }), event(2, { phase: 'delta', channel: 'summary', index: 0 }, '概要'),
      event(3, { phase: 'delta', channel: 'text', index: 0 }, '过程'), event(4, { phase: 'completed', summary: ['概要'], text: ['过程'] })]
    const journal: ConversationEventRecord[] = events.map(update => ({ eventId: update.eventId!, conversationId: 'conversation', generation: 0,
      turnId: 'turn', sequence: update.sequence!, kind: 'output', payload: update, time: update.time }))
    const live = events.reduce(upsertInspirationReasoning, initial)
    expect(replayInspirationEvents(initial, journal)).toEqual(live)
    expect(replayInspirationEvents(live, journal)).toEqual(live)
    const answerEvent = { ...event(5, { phase: 'start' }), kind: 'delta' as const, reasoning: undefined, content: '最终回答' }
    const replay = replayInspirationEvents(initial, [...journal, { ...journal[0], sequence: 5, eventId: 'answer', payload: answerEvent }])
    expect(replay.at(-1)?.content).toBe('最终回答')
    expect(replay.at(-1)?.kind).toBeUndefined()
    expect(replay[1].reasoning?.text).toEqual(['过程'])
  })

  it('settles unfinished reasoning on success, failure, cancellation and restore without promoting it to an answer', () => {
    const running = upsertInspirationReasoning(initial, event(1, { phase: 'delta', channel: 'summary', index: 0 }, '部分概要'))
    for (const settled of [settleInspirationReply(running, 'session', '回答', '失败'), settleInspirationFailure(running, 'session', '失败'),
      settleInspirationCancellation(running, 'session'), settleInspirationReasoning(running, 'session'), normalizeStoredInspirationMessages(running)]) {
      expect(settled[1]).toMatchObject({ kind: 'reasoning', isFinal: false, status: 'completed', content: '部分概要' })
    }
    const otherTurn = upsertInspirationReasoning(running, event(2, { phase: 'delta', channel: 'summary', index: 0 }, '另一轮', 'other'))
    expect(otherTurn.filter(message => message.kind === 'reasoning')).toHaveLength(2)
  })

  it('replays newer deltas over a restored incomplete snapshot and normalizes sparse JSON sections', () => {
    const original = upsertInspirationReasoning(initial, event(1, { phase: 'delta', channel: 'summary', index: 1 }, '第一部分'))
    const restored = normalizeStoredInspirationMessages(JSON.parse(JSON.stringify(original)))
    expect(restored[1].reasoning?.summary).toEqual(['', '第一部分'])
    const update = event(2, { phase: 'delta', channel: 'summary', index: 1 }, '，第二部分')
    const replayed = replayInspirationEvents(restored, [{ eventId: 'second', conversationId: 'c', turnId: 'turn', generation: 0, sequence: 2, kind: 'output', payload: update, time: 'T' }])
    expect(replayed[1].reasoning?.summary[1]).toBe('第一部分，第二部分')
    const answer: ConversationEventRecord = { eventId: 'answer', conversationId: 'c', turnId: 'turn', generation: 0, sequence: 3, kind: 'output', payload: { kind: 'answer', content: '回答', sessionId: 'session' }, time: 'T' }
    expect(replayInspirationEvents(replayed, [answer])[1]).toMatchObject({ status: 'completed', reasoningCompleted: true, isFinal: false })
  })
})
