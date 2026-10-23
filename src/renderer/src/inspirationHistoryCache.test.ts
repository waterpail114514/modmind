import { describe, expect, it } from 'vitest'
import { trimInspirationHistories } from './inspirationHistoryCache'
import type { InspirationConversation } from './inspirationStorage'

describe('inspiration history memory budget', () => {
  it('drops rebuildable payloads while retaining all metadata and unsaved work', () => {
    const entries: InspirationConversation[] = Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, title: `${index}`, updatedAt: '', messages: [{ role: 'user', content: 'x'.repeat(1000) }] }))
    const durable = new WeakSet(entries.slice(0, 9).map(entry => entry.messages))
    const result = trimInspirationHistories(entries, new Set(['0']), durable, 9000, 3)
    expect(result).toHaveLength(10)
    expect(result.filter(entry => entry.messagesLoaded !== false).map(entry => entry.id)).toEqual(['0', '1', '9'])
    expect(result[2]).toMatchObject({ title: '2', messagesLoaded: false, messages: [] })
    expect(entries[2].messages[0].content).toHaveLength(1000)
  })
  it('releases hidden durable histories but preserves pending messages', () => {
    const entries: InspirationConversation[] = [{ id: 'saved', title: '', updatedAt: '', messages: [] }, { id: 'pending', title: '', updatedAt: '', messages: [] }]
    const durable = new WeakSet([entries[0].messages])
    const result = trimInspirationHistories(entries, new Set(), durable, 0, 0)
    expect(result[0].messagesLoaded).toBe(false)
    expect(result[1]).toBe(entries[1])
    expect(trimInspirationHistories(result, new Set(), durable, 0, 0)).toBe(result)
  })
})
