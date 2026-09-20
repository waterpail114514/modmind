import { describe, expect, it, vi } from 'vitest'
import type { ConversationEventRecord } from '../../shared/types'
import { replayWorkbenchEvents, replayWorkbenchEventsAsync } from './workbenchTimeline'

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
})
