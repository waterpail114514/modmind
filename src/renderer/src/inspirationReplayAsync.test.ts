import { expect, it } from 'vitest'
import type { ConversationEventRecord } from '../../shared/types'
import { replayInspirationEvents, replayInspirationEventsAsync } from './inspirationOutput'

const events: ConversationEventRecord[] = Array.from({ length: 3_000 }, (_, index) => ({
  eventId: `event-${index}`, conversationId: 'idea', generation: 0, turnId: `turn-${index}`,
  sequence: index + 1, kind: 'output', time: '2026-09-24T00:00:00Z',
  payload: { kind: 'answer', content: `Answer ${index}`, sessionId: `session-${index}` }
}))

it('yields during inspiration replay and preserves all durable output', async () => {
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 0)
  try {
    const result = await replayInspirationEventsAsync([], events)
    expect(ticks).toBeGreaterThan(1)
    expect(result).toEqual(replayInspirationEvents([], events))
    expect(result).toHaveLength(events.length)
  } finally { clearInterval(timer) }
})

it('cancels a switched-away history before publishing its replay', async () => {
  let cancelled = false
  const result = replayInspirationEventsAsync([], events, () => cancelled)
  cancelled = true
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
})
