import { describe, expect, it, vi } from 'vitest'
import { readWorkbenchHistoryWindow } from './conversationHistory'
import { replayWorkbenchTail, type WorkbenchTimelineItem } from './workbenchTimeline'
import type { ConversationHistoryPage } from '../../shared/types'

const user: WorkbenchTimelineItem = { id: 'user-1', kind: 'user', turnId: 'turn', content: 'hello', time: '2026-01-01T00:00:00Z', sequence: 1 }
const page: ConversationHistoryPage = { document: { id: 'ws-test', surface: 'workspace', title: '', createdAt: '', updatedAt: '', schemaVersion: 2, generation: 0, lastSequence: 101, checkpointSequence: 100, native: {}, nativeTurns: {}, events: [], view: {} }, items: [user], start: 900, end: 1000, total: 1000, token: 'token', nextBefore: 900 }
const parse = (value: unknown) => value as WorkbenchTimelineItem[]
const identity = (value: string) => value
describe('workbench history windows', () => {
  it('reads only checkpoint suffix events and retains checkpoint rows', async () => {
    const eventsSince = vi.fn().mockResolvedValue({ generation: 0, events: [{ eventId: 'answer', conversationId: 'ws-test', generation: 0, turnId: 'turn', sequence: 101, kind: 'output', time: '2026-01-01T00:01:00Z', payload: { kind: 'answer', content: 'world' } }], nextSequence: null })
    const read = vi.fn(), result = await readWorkbenchHistoryWindow({ read, historyPage: async () => page, eventsSince }, '/project', 'ws-test', {}, () => false, parse, identity, identity)
    expect(eventsSince.mock.calls[0].slice(2)).toEqual([0, 100, 100]); expect(read).not.toHaveBeenCalled()
    expect(result?.timeline.map(r => r.content)).toEqual(['hello', 'world'])
  })
  it('does not fetch current tail while browsing an older segment', async () => {
    const eventsSince = vi.fn(), older = { ...page, end: 900, start: 800 }
    const result = await readWorkbenchHistoryWindow({ read: vi.fn(), historyPage: async () => older, eventsSince }, '/project', 'ws-test', { before: 900 }, () => false, parse, identity, identity)
    expect(result?.timeline).toEqual([user]); expect(eventsSince).not.toHaveBeenCalled()
  })
  it('cancels stale navigation and does not hide a missing suffix as success', async () => {
    const api = { read: vi.fn(), historyPage: async () => page, eventsSince: vi.fn().mockResolvedValue({ generation: 0, events: [], nextSequence: null }) }
    await expect(readWorkbenchHistoryWindow(api, '/project', 'ws-test', {}, () => true, parse, identity, identity)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readWorkbenchHistoryWindow(api, '/project', 'ws-test', {}, () => false, parse, identity, identity)).rejects.toThrow('未完整读取')
  })
  it('extends a checkpointed streaming reply without losing its prior text or duplicating a user turn', () => {
    const reply: WorkbenchTimelineItem = { id: 'reply', kind: 'response', content: 'abc', turnId: 'turn', streamId: 'stream', time: '2026-01-01T00:00:01Z', sequence: 100, status: 'done' }
    const result = replayWorkbenchTail([user, reply], [{ eventId: 'delta', conversationId: 'ws-test', generation: 0, turnId: 'turn', sequence: 101, kind: 'output', time: '2026-01-01T00:00:02Z', payload: { kind: 'delta', content: 'def', streamId: 'stream' } }])
    expect(result.map(r => r.content)).toEqual(['hello', 'abcdef'])
  })
})
