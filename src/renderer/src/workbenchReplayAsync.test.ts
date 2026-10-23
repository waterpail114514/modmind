import { describe, expect, it, vi } from 'vitest'
import type { ConversationEventRecord } from '../../shared/types'
import { isWorkbenchInternalPrompt, normalizeWorkbenchTimeline, reduceWorkbenchOutput, reduceWorkbenchProgress, replayWorkbenchEvents, replayWorkbenchEventsAsync, settleWorkbenchActivity, type WorkbenchTimelineItem } from './workbenchTimeline'

const events: ConversationEventRecord[] = Array.from({ length: 120 }, (_, index) => ({
  eventId: `event-${index}`, conversationId: 'workspace', generation: 0,
  turnId: `turn-${Math.floor(index / 3)}`, sequence: index + 1, time: '2026-09-20T14:01:00Z',
  kind: index % 3 === 0 ? 'user' : 'output',
  payload: index % 3 === 0 ? { prompt: `Question ${index}` } : {
    kind: index % 3 === 1 ? 'tool' : 'answer', content: `Result ${index}`,
    turnId: `turn-${Math.floor(index / 3)}`, time: '2026-09-20T14:01:00Z'
  }
}))

describe('interruptible history loading', () => {
  it('yields to UI tasks during replay and preserves the synchronous result', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 0)
    let elapsed = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed += 2)
    try {
      const result = await replayWorkbenchEventsAsync([], events)
      expect(result).toEqual(replayWorkbenchEvents([], events))
      expect(ticks).toBeGreaterThan(2)
    } finally {
      clearInterval(timer)
      clock.mockRestore()
    }
  })

  it('stops obsolete history restoration when the project changes', async () => {
    let cancelled = false
    let processed = 0
    const restore = replayWorkbenchEventsAsync([], events, undefined, value => {
      processed++
      cancelled = true
      return value
    }, () => cancelled)
    await expect(restore).rejects.toMatchObject({ name: 'AbortError' })
    expect(processed).toBeGreaterThan(0)
    expect(processed).toBeLessThan(events.length / 2)
  })

  it('loads 150,000 retained rows plus new output without a function argument limit', async () => {
    const view: WorkbenchTimelineItem[] = Array.from({ length: 150_000 }, (_, index) => ({
      id: `retained-${index}`, kind: 'answer', content: `Retained ${index}`, turnId: `old-${index}`,
      time: '2026-09-20T14:00:00Z', status: 'done'
    }))
    const result = await replayWorkbenchEventsAsync(view, [events[1]])
    expect(result).toHaveLength(150_001)
    expect(result[0]).toEqual(view[0])
    expect(result[149_999]).toEqual(view[149_999])
    expect(result.at(-1)?.content).toBe('Result 1')
    expect(view[0]).toBe(view[0])
  }, 20_000)

  it('preserves the live reducer semantics for mixed turns, streams, retries, progress and usage', () => {
    for (let seed = 1; seed <= 30; seed++) {
      let random = seed
      const next = (max: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % max }
      const journal: ConversationEventRecord[] = []
      for (let index = 0; index < 150; index++) {
        const turnId = `turn-${next(5)}`
        const runId = `run-${turnId}`
        const sequence = index + 1
        const time = new Date(Date.UTC(2026, 8, 20, 14, 0, next(8))).toISOString()
        const base = { time, turnId, runId }
        const common = { eventId: `event-${index}`, conversationId: 'workspace', generation: 0, sequence, time, turnId, runId }
        if (next(4) === 0) {
          journal.push({ ...common, kind: 'progress', payload: { ...base, id: `progress-${next(4)}`, stage: 'writing', title: ['正在准备工具', 'Codex 已恢复会话', '读取文件'][next(3)], detail: `Detail ${next(4)}`, status: ['running', 'success', 'warning', 'error'][next(4)] } })
        } else {
          const kind = (['stream-start', 'delta', 'response', 'answer', 'tool', 'start', 'retry', 'warning', 'error', 'usage'] as const)[next(10)]
          journal.push({ ...common, kind: 'output', payload: { ...base, kind, content: next(25) === 0 ? '__CODE_DIFF__broken' : `Text ${next(4)}`, ...(next(3) ? { streamId: `stream-${next(3)}` } : {}), ...(kind === 'warning' || kind === 'retry' ? { notice: { key: `notice-${next(2)}`, occurrences: next(10) } } : {}), ...(kind === 'error' ? { terminal: next(2) === 0 } : {}), ...(kind === 'usage' || next(5) === 0 ? { usage: { inputTokens: next(1000), model: `model-${next(2)}` } } : {}) } })
        }
      }
      expect(replayWorkbenchEvents([], journal), `seed ${seed}`).toEqual(referenceReplay([], journal))
    }
  })

  it('preserves migrated users, internal prompt filtering, duplicate events and reversed arrival order', () => {
    const view: WorkbenchTimelineItem[] = [
      { id: 'old-answer', kind: 'answer', turnId: 'old-turn', content: 'Old retained answer', time: '2026-09-19T00:00:00Z', status: 'done', usage: { inputTokens: 50 } },
      { id: 'known-user', kind: 'user', turnId: 'turn-0', content: 'Retained user', time: '2026-09-20T14:00:00Z', status: 'done' },
      { id: 'internal', kind: 'user', turnId: 'internal', content: 'SYSTEM WORKFLOW INSTRUCTIONS: private', time: '2026-09-20T14:00:00Z' }
    ]
    const duplicate = { ...events[1], sequence: 500 }
    const journal = [...events, duplicate, { ...events[0], eventId: 'system', turnId: 'system', sequence: 501, payload: { prompt: 'SYSTEM WORKFLOW INSTRUCTIONS: private' } }].reverse()
    expect(replayWorkbenchEvents(view, journal)).toEqual(referenceReplay(view, journal))
    expect(view[1].sequence).toBeUndefined()
  })

  it('hydrates sparse durable payloads from their authoritative journal envelopes', () => {
    const records: ConversationEventRecord[] = [1, 2, 3].map(sequence => ({ eventId: `sparse-${sequence}`, conversationId: 'c', generation: 0, sequence, turnId: 'sparse-turn', runId: 'sparse-run', time: '2026-10-17T00:00:00Z', kind: 'output', payload: { kind: 'delta', content: `Fragment ${sequence}. ` } }))
    const normalized = records.map(record => ({ ...record, payload: { ...(record.payload as object), time: record.time, turnId: record.turnId, runId: record.runId } }))
    expect(replayWorkbenchEvents([], records)).toEqual(referenceReplay([], normalized))
    expect(replayWorkbenchEvents([], records)[0]).toMatchObject({ time: records[0].time, turnId: records[0].turnId, content: 'Fragment 1. Fragment 2. Fragment 3. ' })
  })
})

// The immutable live reducers provide an independent oracle for the indexed
// restoration path, including the original sort after every journal record.
function referenceReplay(view: WorkbenchTimelineItem[], journal: ConversationEventRecord[]): WorkbenchTimelineItem[] {
  if (!journal.length) return normalizeWorkbenchTimeline(view)
  const turns = new Set(journal.filter(record => record.kind === 'output' || record.kind === 'progress').map(record => record.turnId))
  let result = view.filter(item => item.kind === 'user' ? !isWorkbenchInternalPrompt(item.content) : !turns.has(item.turnId ?? `turn-${item.runId}`)).map(item => ({ ...item }))
  const users = new Map(result.filter(item => item.kind === 'user' && item.turnId).map(item => [item.turnId!, item]))
  const seen = new Set<string>()
  for (const record of [...journal].sort((a, b) => a.sequence - b.sequence)) {
    if (seen.has(record.eventId)) continue
    seen.add(record.eventId)
    if (record.kind === 'user') {
      const prompt = (record.payload as { prompt?: unknown })?.prompt
      if (typeof prompt === 'string' && isWorkbenchInternalPrompt(prompt)) continue
      const existing = users.get(record.turnId)
      if (existing) existing.sequence = record.sequence
      else {
        const item: WorkbenchTimelineItem = { id: `user:${record.eventId}`, kind: 'user', content: typeof prompt === 'string' ? prompt : '', time: record.time, runId: record.runId, turnId: record.turnId, sequence: record.sequence, status: 'done' }
        result.push(item); users.set(record.turnId, item)
      }
    } else if (record.kind === 'output') result = reduceWorkbenchOutput(result, { ...(record.payload as Parameters<typeof reduceWorkbenchOutput>[1]), sequence: record.sequence, eventId: record.eventId })
    else if (record.kind === 'progress') result = reduceWorkbenchProgress(result, { ...(record.payload as Parameters<typeof reduceWorkbenchProgress>[1]), sequence: record.sequence, eventId: record.eventId })
  }
  return settleWorkbenchActivity(result.map((item, index) => ({ item, index })).sort((left, right) => {
    const at = Date.parse(left.item.time); const bt = Date.parse(right.item.time)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
    const a = left.item.sequence ?? Number.MAX_SAFE_INTEGER; const b = right.item.sequence ?? Number.MAX_SAFE_INTEGER
    if (a !== b && a !== Number.MAX_SAFE_INTEGER && b !== Number.MAX_SAFE_INTEGER) return a - b
    if (a !== b) return a === Number.MAX_SAFE_INTEGER ? -1 : 1
    return left.index - right.index
  }).map(row => row.item))
}
