import { describe, expect, it } from 'vitest'
import { buildInspirationRows, deleteInspirationTimelineItem, finalInspirationReply, inspirationConversationHandoff, replayInspirationEvents, rewindInspirationTimelineTo, settleInspirationCancellation, settleInspirationFailure, shouldResumeInspirationSession } from './inspirationOutput'

describe('inspiration output settlement', () => {
  it('replays a durable cumulative delta and terminal answer after a crash', () => {
    const pending = [{ role: 'assistant' as const, turnId: 'turn-a', content: '', status: 'streaming' as const }]
    const restored = replayInspirationEvents(pending, [
      { eventId: 'e1', conversationId: 'idea-a', generation: 0, turnId: 'turn-a', sequence: 2, kind: 'output', time: 'T1', payload: { kind: 'delta', content: 'partial', time: 'T1', turnId: 'turn-a' } },
      { eventId: 'e2', conversationId: 'idea-a', generation: 0, turnId: 'turn-a', sequence: 3, kind: 'output', time: 'T2', payload: { kind: 'answer', content: 'complete', time: 'T2', turnId: 'turn-a' } }
    ])
    expect(restored).toEqual([expect.objectContaining({ turnId: 'turn-a', content: 'complete', status: 'completed', isFinal: true, sequence: 3 })])
  })

  it('settles a durable terminal failure after a crash instead of restoring an endless stream', () => {
    const pending = [{ role: 'assistant' as const, turnId: 'turn-a', content: '', status: 'streaming' as const, sessionId: 'run-a' }]
    const restored = replayInspirationEvents(pending, [
      { eventId: 'e1', conversationId: 'idea-a', generation: 0, turnId: 'turn-a', sequence: 2, kind: 'output', time: 'T1', payload: { kind: 'delta', content: 'partial', time: 'T1', turnId: 'turn-a', sessionId: 'run-a' } },
      { eventId: 'e2', conversationId: 'idea-a', generation: 0, turnId: 'turn-a', sequence: 3, kind: 'output', time: 'T2', payload: { kind: 'error', content: 'network unavailable', time: 'T2', turnId: 'turn-a', sessionId: 'run-a', terminal: false, recoverable: true } }
    ])
    expect(restored.at(-1)).toMatchObject({ turnId: 'turn-a', content: 'network unavailable', status: 'error', isFinal: true, sequence: 3 })
    expect(restored.some((message) => message.status === 'streaming')).toBe(false)
  })
  it('renders retry/tool steps in order between the question and provisional answer', () => {
    const rows = buildInspirationRows([
      { role: 'user', content: 'question', status: 'completed' },
      { role: 'assistant', kind: 'tool', id: 'retry-1', content: 'retrying', status: 'completed' },
      { role: 'assistant', content: '', status: 'streaming', sessionId: 'run-1' }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['message', 'tool-group', 'message'])
  })

  it('deletes whole turns without leaving tool-step artifacts', () => {
    const messages = [
      { role: 'user' as const, content: 'first', status: 'completed' as const },
      { role: 'assistant' as const, kind: 'tool' as const, content: 'step', status: 'completed' as const },
      { role: 'assistant' as const, content: 'answer', status: 'completed' as const, isFinal: true },
      { role: 'user' as const, content: 'second', status: 'completed' as const }
    ]
    expect(deleteInspirationTimelineItem(messages, 0).map((message) => message.content)).toEqual(['second'])
    expect(deleteInspirationTimelineItem(messages, 2).map((message) => message.content)).toEqual(['first', 'second'])
    expect(deleteInspirationTimelineItem(messages, 99)).toBe(messages)
  })

  it('drops a selected user turn but retains a selected assistant boundary', () => {
    const messages = [
      { role: 'user' as const, content: 'first', status: 'completed' as const },
      { role: 'assistant' as const, content: 'answer', status: 'completed' as const, isFinal: true },
      { role: 'user' as const, content: 'second', status: 'completed' as const }
    ]
    expect(rewindInspirationTimelineTo(messages, 2).map((message) => message.content)).toEqual(['first', 'answer'])
    expect(rewindInspirationTimelineTo(messages, 1).map((message) => message.content)).toEqual(['first', 'answer'])
    expect(rewindInspirationTimelineTo(messages, 99)).toBe(messages)
  })

  it('never promotes summary or retry status to the final answer', () => {
    expect(finalInspirationReply({ summary: '模型服务暂时不可用，8 秒后自动重试（第 2 次，最多 4 次）' })).toBe('')
    expect(finalInspirationReply({ summary: 'fallback summary', finalResponse: 'Codex is reconnecting and will retry' })).toBe('')
    expect(finalInspirationReply({ summary: 'short', finalResponse: '这是完整且可展示的灵感回答。' })).toBe('这是完整且可展示的灵感回答。')
  })

  it('demotes provisional narration when a run fails', () => {
    const result = settleInspirationFailure([
      { role: 'assistant', content: '我正在读取项目', status: 'streaming', isFinal: false, sessionId: 'run-1' }
    ], 'run-1', '线路仍不可用', () => 'step-1')
    expect(result).toEqual([
      { role: 'assistant', kind: 'tool', id: 'step-1', content: '我正在读取项目', status: 'completed', isFinal: false, sessionId: 'run-1' },
      expect.objectContaining({ role: 'assistant', content: '线路仍不可用', status: 'error', isFinal: true, sessionId: 'run-1' })
    ])
  })

  it('keeps provisional text as a step when cancellation is confirmed', () => {
    const result = settleInspirationCancellation([
      { role: 'assistant', content: '正在检查 API', status: 'streaming', isFinal: false, sessionId: 'run-1' }
    ], 'run-1', () => 'step-1')
    expect(result[0]).toMatchObject({ kind: 'tool', isFinal: false })
    expect(result[1]).toMatchObject({ content: '请求已暂停', status: 'cancelled', isFinal: true })
  })

  it('rotates long native sessions while carrying bounded recent context', () => {
    const messages = Array.from({ length: 8 }, (_value, index) => ([
      { role: 'user' as const, content: `question-${index}`, status: 'completed' as const },
      { role: 'assistant' as const, content: `answer-${index}`, status: 'completed' as const, isFinal: true }
    ])).flat()
    expect(shouldResumeInspirationSession(messages.slice(0, 2))).toBe(true)
    expect(shouldResumeInspirationSession(messages)).toBe(true)
    const handoff = inspirationConversationHandoff(messages, 120)
    expect(handoff.length).toBeLessThanOrEqual(120)
    expect(handoff).toContain('answer-7')
  })

  it('carries structured attachment paths and falls back to legacy visible text', () => {
    const handoff = inspirationConversationHandoff([
      {
        role: 'user', content: '分析附件\n\n已附 1 个文件', status: 'completed',
        replay: { prompt: '分析附件', attachments: [{ id: 'a1', name: 'api.txt', path: '.modmind/attachments/a1-api.txt', size: 10, isImage: false }] }
      },
      { role: 'assistant', content: '收到', status: 'completed', isFinal: true },
      { role: 'user', content: '旧记录', status: 'completed' }
    ])
    expect(handoff).toContain('.modmind/attachments/a1-api.txt')
    expect(handoff).toContain('User: 旧记录')
  })
})
