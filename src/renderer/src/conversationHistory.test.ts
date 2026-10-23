import { describe, expect, it, vi } from 'vitest'
import type { ConversationDocument, ConversationEventRecord } from '../../shared/types'
import { readConversationHistory } from './conversationHistory'

const document: ConversationDocument = { schemaVersion: 2, id: 'ws-test', surface: 'workspace', title: 'test', createdAt: '', updatedAt: '', generation: 2, lastSequence: 3, checkpointSequence: 0, view: {}, native: {}, nativeTurns: {}, events: [] }
const event = (sequence: number): ConversationEventRecord => ({ eventId: `e-${sequence}`, conversationId: document.id, generation: 2, sequence, turnId: 'turn', kind: 'user', time: '', payload: { prompt: 'hello' } })

describe('paged conversation restoration', () => {
  it('pins a generation and tail even when more output arrives between pages', async () => {
    const read = vi.fn()
    const eventsSince = vi.fn().mockResolvedValueOnce({ generation: 2, events: [event(1), event(2)], nextSequence: 2 }).mockResolvedValueOnce({ generation: 2, events: [event(3), event(4)], nextSequence: null })
    const result = await readConversationHistory({ read, readProjection: async () => document, eventsSince }, '/project', document.id, () => false)
    expect(result?.events.map(entry => entry.sequence)).toEqual([1, 2, 3])
    expect(read).not.toHaveBeenCalled()
    expect(eventsSince.mock.calls[1].slice(2)).toEqual([2, 2, 5000])
  })
  it('rejects obsolete/corrupt pages instead of presenting them as empty history', async () => {
    const api = { read: vi.fn(), readProjection: async () => document, eventsSince: vi.fn().mockResolvedValue({ generation: 3, events: [], nextSequence: null }) }
    await expect(readConversationHistory(api, '/project', document.id, () => false)).rejects.toThrow('对话已更新')
    api.eventsSince.mockResolvedValue({ generation: 2, events: [], nextSequence: null })
    await expect(readConversationHistory(api, '/project', document.id, () => false)).rejects.toThrow('未完整读取')
  })
  it('cancels before fetching another page and preserves the old preload fallback', async () => {
    let cancelled = false
    const api = { read: vi.fn().mockResolvedValue(document), readProjection: async () => document, eventsSince: vi.fn().mockImplementation(async () => { cancelled = true; return { generation: 2, events: [event(1)], nextSequence: 1 } }) }
    await expect(readConversationHistory(api, '/project', document.id, () => cancelled)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.eventsSince).toHaveBeenCalledTimes(1)
    expect(await readConversationHistory({ read: api.read, eventsSince: api.eventsSince }, '/project', document.id, () => false)).toBe(document)
  })
})
