import { describe, expect, it } from 'vitest'
import {
  MAX_INSPIRATION_STORAGE_BYTES,
  boundInspirationMessages,
  inspirationConversationTitle,
  normalizeStoredInspirationMessages,
  persistInspirationHistory,
  type InspirationConversation,
  type InspirationStoragePayload
} from './inspirationStorage'

function conversation(id: string, messages: InspirationConversation['messages']): InspirationConversation {
  return { id, title: `Conversation ${id}`, updatedAt: '2026-08-30T00:00:00.000Z', messages }
}

function payload(conversations: InspirationConversation[], activeId = conversations[0]?.id ?? ''): InspirationStoragePayload {
  return { activeId, conversations }
}

describe('inspiration storage', () => {
  it('names untitled histories from the first question and preserves explicit titles', () => {
    const messages: InspirationConversation['messages'] = [
      { role: 'user', content: '旧展示文字\n\n已附 2 个文件', replay: { prompt: '设计一个\n 森林冒险' }, status: 'completed' },
      { role: 'user', content: '后续提问', status: 'completed' }
    ]
    expect(inspirationConversationTitle('新对话', messages)).toBe('设计一个 森林冒险')
    expect(inspirationConversationTitle('新想法 2', messages)).toBe('设计一个 森林冒险')
    expect(inspirationConversationTitle('我的森林主题', messages)).toBe('我的森林主题')
    expect(inspirationConversationTitle('新想法 3', [])).toBe('新想法 3')
  })
  it('keeps the active question while bounding a long retry storm', () => {
    const messages: InspirationConversation['messages'] = [
      { role: 'user', content: 'active question', status: 'completed' },
      ...Array.from({ length: 140 }, (_, index) => ({ role: 'assistant' as const, kind: 'tool' as const, content: `retry ${index}`, status: 'completed' as const })),
      { role: 'assistant', content: '', status: 'streaming', sessionId: 'active-run' }
    ]
    const bounded = boundInspirationMessages(messages)
    expect(bounded).toHaveLength(32)
    expect(bounded.some((message) => message.role === 'user' && message.content === 'active question')).toBe(true)
    expect(bounded.at(-1)).toMatchObject({ sessionId: 'active-run' })
  })

  it('turns interrupted streams into an explicit retryable history entry', () => {
    expect(normalizeStoredInspirationMessages([
      { role: 'user', content: 'question', status: 'completed' },
      { role: 'assistant', content: 'partial narration', status: 'streaming', sessionId: 'inspiration-1' }
    ])).toEqual([
      { role: 'user', content: 'question', status: 'completed' },
      { role: 'assistant', content: '上次灵感回答在完成前中断，请重新发送问题。', status: 'error', isFinal: true, sessionId: 'inspiration-1' }
    ])
  })

  it('demotes legacy retry text instead of inferring it as a final answer', () => {
    expect(normalizeStoredInspirationMessages([
      { role: 'user', content: 'question', status: 'completed' },
      { role: 'assistant', content: '模型服务暂时不可用（429），8 秒后自动重试（第 2 次，最多 4 次）', status: 'completed' }
    ])[1]).toMatchObject({ kind: 'tool', isFinal: false })
  })

  it('settles an old streaming tool step after restart', () => {
    expect(normalizeStoredInspirationMessages([
      { role: 'assistant', kind: 'tool', content: 'retrying', status: 'streaming' }
    ])[0]).toMatchObject({ kind: 'tool', status: 'completed' })
  })

  it('sanitizes structured replay metadata loaded from browser storage', () => {
    const normalized = normalizeStoredInspirationMessages([{
      role: 'user', content: '分析附件', status: 'completed',
      replay: {
        prompt: '分析附件',
        attachments: [
          { id: 'valid', name: 'api.txt', path: '.modmind/attachments/api.txt', size: 10, isImage: false },
          { id: '', name: 'broken', path: '', size: -1, isImage: false }
        ]
      }
    }])
    expect(normalized[0].replay).toEqual({
      prompt: '分析附件',
      attachments: [{ id: 'valid', name: 'api.txt', path: '.modmind/attachments/api.txt', size: 10, isImage: false }]
    })
  })

  it('keeps bounded retry/tool steps and bounds the stored history', () => {
    let stored = ''
    const conversations = Array.from({ length: 15 }, (_, index) => conversation(`c-${index}`, [
      { role: 'user', content: `question ${index}`, status: 'completed' },
      { role: 'assistant', kind: 'tool', content: 'x'.repeat(12_000), status: 'completed' },
      { role: 'assistant', content: `answer ${index}`, status: 'completed', isFinal: true }
    ]))

    const result = persistInspirationHistory({ setItem: (_key, value) => { stored = value } }, 'history', payload(conversations))
    const parsed = JSON.parse(stored) as InspirationStoragePayload

    expect(result.status).toBe('compacted')
    expect(result.storedBytes).toBeLessThanOrEqual(MAX_INSPIRATION_STORAGE_BYTES)
    expect(parsed.conversations).toHaveLength(12)
    const tool = parsed.conversations.flatMap((item) => item.messages).find((message) => message.kind === 'tool')
    expect(tool?.content).toContain('[历史内容已截断]')
    expect(tool?.content.length).toBeLessThan(2_200)
  })

  it('keeps the active conversation when it is outside the recent window', () => {
    let stored = ''
    const conversations = Array.from({ length: 20 }, (_, index) => conversation(`c-${index}`, [
      { role: 'user', content: `question ${index}`, status: 'completed' }
    ]))

    persistInspirationHistory({ setItem: (_key, value) => { stored = value } }, 'history', payload(conversations, 'c-19'))
    const parsed = JSON.parse(stored) as InspirationStoragePayload

    expect(parsed.conversations.some((item) => item.id === 'c-19')).toBe(true)
  })

  it('retries with a minimal replacement when the normal write exceeds the remaining quota', () => {
    const writes: string[] = []
    const result = persistInspirationHistory({
      setItem: (_key, value) => {
        writes.push(value)
        if (value.length > 50_000) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      }
    }, 'history', payload([conversation('active', Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: 'x'.repeat(2_000),
      status: 'completed' as const,
      isFinal: index % 2 === 1
    })))]))

    expect(writes).toHaveLength(2)
    expect(result.status).toBe('compacted')
    expect(result.storedBytes).toBeGreaterThan(0)
  })

  it('never throws when browser storage is unavailable', () => {
    const write = (): void => { throw new DOMException('Storage disabled', 'SecurityError') }
    expect(() => persistInspirationHistory({ setItem: write }, 'history', payload([conversation('active', [])])))
      .not.toThrow()
    expect(persistInspirationHistory({ setItem: write }, 'history', payload([conversation('active', [])])).status)
      .toBe('unavailable')
  })
})
