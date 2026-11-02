import { describe, expect, it } from 'vitest'
import capture from './__fixtures__/inspirationNativeProgress.json'
import type { AiOutputEvent, ConversationEventRecord, InspirationChatMessage } from '../../shared/types'
import { reduceInspirationText } from './inspirationText'
import { applyInspirationArtifact, inspirationConversationHandoff, replayInspirationEvents, settleInspirationCancellation, upsertInspirationReasoning } from './inspirationOutput'
import { upsertInspirationActivity } from './inspirationActivity'
import { normalizeStoredInspirationMessages } from './inspirationStorage'

const base = (): InspirationChatMessage[] => [{ role: 'user', id: 'user', content: '检查传输', turnId: 'turn', sessionId: 'session' },
  { role: 'assistant', id: 'turn:assistant', turnId: 'turn', sessionId: 'session', content: '', status: 'streaming', isFinal: false }]
const event = (sequence: number, kind: AiOutputEvent['kind'], content: string, streamId = 'progress'): AiOutputEvent => ({
  sequence, kind, content, streamId, itemId: streamId, time: '2026-10-28T00:00:00Z', turnId: 'turn', sessionId: 'session'
})
const paragraphs = (messages: InspirationChatMessage[]) => messages.filter(m => m.role === 'assistant' && !m.kind).map(m => ({ content: m.content, phase: m.phase, final: m.isFinal }))

describe('inspiration native text boundaries', () => {
  it('retains both real captured model commentaries through final output, reload and journal replay', () => {
    const events = capture.events as unknown as AiOutputEvent[]
    let live = base()
    for (const e of events) live = e.activity ? upsertInspirationActivity(live, e) : e.reasoning ? upsertInspirationReasoning(live, e) : reduceInspirationText(live, e)
    const expected = [{ content: '我先核对约束\n', phase: 'commentary', final: false }, { content: '我已经读到测试知识。\n', phase: 'commentary', final: false }, { content: 'LIVE-RENDER-7319', phase: 'final_answer', final: true }]
    expect(paragraphs(live)).toEqual(expected)
    expect(paragraphs(normalizeStoredInspirationMessages(JSON.parse(JSON.stringify(live))))).toEqual(expected)
    const journal = events.map(e => ({ eventId: e.eventId!, sequence: e.sequence!, time: e.time, kind: 'output', payload: e, turnId: 'turn', conversationId: 'conversation', generation: 0 })) as ConversationEventRecord[]
    expect(paragraphs(replayInspirationEvents(base(), journal))).toEqual(expected)
    expect(inspirationConversationHandoff(live)).toContain('LIVE-RENDER-7319')
    expect(inspirationConversationHandoff(live)).not.toContain('我先核对约束')
  })

  it('keeps normal first-person progress out of collapsed tool rows and ignores late chunks', () => {
    const progress = event(1, 'response', '我先读取项目知识，检查约束。')
    const messages = reduceInspirationText(base(), progress)
    const visible = normalizeStoredInspirationMessages(messages.filter(m => m.content))
    expect(visible[1]).toMatchObject({ phase: 'commentary', content: progress.content, isFinal: false })
    expect(visible[1].kind).toBeUndefined()
    expect(reduceInspirationText(messages, event(2, 'delta', '迟到内容'))).toBe(messages)
    expect(reduceInspirationText(messages, progress)).toBe(messages)
    expect(paragraphs(settleInspirationCancellation(messages, 'session'))[0].content).toBe(progress.content)
    const events = [progress, event(2, 'delta', '迟到内容'), event(3, 'answer', '完成', 'final'), event(4, 'delta', '最终回答后迟到内容', 'final')]
    const journal = events.map(e => ({ eventId: `event-${e.sequence}`, sequence: e.sequence!, time: e.time, kind: 'output', payload: e, turnId: 'turn', conversationId: 'conversation', generation: 0 })) as ConversationEventRecord[]
    expect(paragraphs(replayInspirationEvents(base(), journal))).toEqual(paragraphs(events.reduce(reduceInspirationText, base())))
  })

  it('keeps workflow artifacts on the final answer and promotes its matching snapshot without duplication', () => {
    const workflow = { version: 1 as const, reply: '完成', questions: [], suggestions: [], knowledgeCandidates: [], prompt: { state: 'ready' as const, text: '提示词', blockingQuestionIds: [] } }
    const artifact = { workflow, finalized: false }
    let messages = applyInspirationArtifact(base(), { ...event(1, 'tool', ''), inspirationArtifact: artifact })
    messages = reduceInspirationText(messages, event(2, 'response', '我先检查要求。', 'first'))
    expect(messages.find(m => m.phase === 'commentary')?.inspirationArtifact).toBeUndefined()
    messages = reduceInspirationText(messages, event(3, 'response', '完成', 'final'))
    messages = reduceInspirationText(messages, event(4, 'answer', '完成', 'final'))
    expect(messages.filter(m => m.isFinal)).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ content: '完成', inspirationArtifact: artifact, phase: 'final_answer' })
    const finalized = applyInspirationArtifact(messages, { ...event(5, 'tool', ''), inspirationArtifact: { ...artifact, finalized: true } })
    expect(finalized.at(-1)?.inspirationArtifact?.finalized).toBe(true)
    expect(finalized.find(m => m.phase === 'commentary')?.inspirationArtifact).toBeUndefined()
    expect(reduceInspirationText(finalized, event(6, 'answer', '完成', 'final'))).toBe(finalized)
    const answer = reduceInspirationText(base(), event(7, 'answer', '我先检查当前设置。', 'wording'))
    expect(normalizeStoredInspirationMessages(answer).at(-1)).toMatchObject({ phase: 'final_answer', isFinal: true })
    expect(normalizeStoredInspirationMessages(answer).at(-1)?.kind).toBeUndefined()
  })
})
