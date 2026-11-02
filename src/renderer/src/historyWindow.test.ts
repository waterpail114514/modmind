import { describe, expect, it } from 'vitest'
import { joinHistorySegments, shiftedHistoryIndex, type HistorySegment } from './historyWindow'
import type { ConversationHistoryPage } from '../../shared/types'
const segment = (start: number, end: number): HistorySegment<{ id: string }> => ({ page: { start, end, nextBefore: start || null, total: 1000 } as ConversationHistoryPage, timeline: Array.from({ length: end - start }, (_, i) => ({ id: `row-${start + i}` })) })
describe('bounded scrolling history', () => {
  it('prepends adjacent history, retaining at most three complete segments', () => {
    let current = { ...segment(900, 1000), segments: [segment(900, 1000)] }
    for (let start = 800; start >= 0; start -= 100) {
      current = joinHistorySegments(current.segments, segment(start, start + 100), 'older')
      expect(current.timeline).toHaveLength(Math.min(300, 1000 - start))
      expect(current.page.start).toBe(start)
      expect(current.timeline[0].id).toBe(`row-${start}`)
    }
    expect(current.page.end).toBe(300)
    expect(current.page.nextBefore).toBeNull()
  })
  it('advances without gaps when pages have different sizes', () => {
    const joined = joinHistorySegments([segment(20, 27), segment(27, 31), segment(31, 40)], segment(40, 43), 'newer')
    expect(joined.page.start).toBe(27); expect(joined.page.end).toBe(43)
    expect(joined.timeline.map(row => row.id)).toEqual(segment(27, 43).timeline.map(row => row.id))
  })
  it('keeps the same virtual anchor after prepend and eviction, including regrouped boundary rows', () => {
    expect(shiftedHistoryIndex(segment(100, 200).timeline, segment(0, 200).timeline, 1000)).toBe(900)
    expect(shiftedHistoryIndex(segment(0, 300).timeline, segment(100, 400).timeline, 1000)).toBe(1100)
    expect(shiftedHistoryIndex([{ id: 'old-group' }, { id: 'user' }], [{ id: 'older' }, { id: 'new-group' }, { id: 'user' }], 1000)).toBe(999)
  })
})
