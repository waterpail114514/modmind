import type { ConversationHistoryPage } from '../../shared/types'

export type HistorySegment<T> = { page: ConversationHistoryPage; timeline: T[] }
export function joinHistorySegments<T extends { id: string }>(segments: HistorySegment<T>[], incoming: HistorySegment<T>, direction: 'older' | 'newer'): HistorySegment<T> & { segments: HistorySegment<T>[] } {
  const retained = direction === 'older' ? [incoming, ...segments].slice(0, 3) : [...segments, incoming].slice(-3)
  const items = new Map<string, T>()
  for (const segment of retained) for (const item of segment.timeline) items.set(item.id, item)
  const start = retained[0].page.start, end = retained.at(-1)!.page.end
  return { segments: retained, timeline: [...items.values()], page: { ...incoming.page, start, end, nextBefore: start > 0 ? start : null } }
}

/** Virtuoso's inverse-list index follows the first common row, including regrouped tool boundaries. */
export function shiftedHistoryIndex(previous: { id: string }[], next: { id: string }[], firstIndex: number): number {
  const oldPositions = new Map(previous.map((row, index) => [row.id, index]))
  for (let index = 0; index < next.length; index++) {
    const old = oldPositions.get(next[index].id)
    if (old !== undefined) return firstIndex + old - index
  }
  return firstIndex
}
