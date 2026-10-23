import type { InspirationChatMessage } from '../../shared/types'
import type { InspirationConversation } from './inspirationStorage'

const weights = new WeakMap<InspirationChatMessage[], number>()
function historyBytes(messages: InspirationChatMessage[]): number {
  const cached = weights.get(messages)
  if (cached !== undefined) return cached
  let bytes = 0
  for (const message of messages) bytes += 512 + message.content.length * 2 + (message.replay?.prompt.length ?? 0) * 2 + (message.replay?.attachments?.length ?? 0) * 2048
  weights.set(messages, bytes)
  return bytes
}

/** Only durable inactive histories may be evicted; drafts and running replies stay. */
export function trimInspirationHistories(conversations: InspirationConversation[], protectedIds: Set<string>, durable: WeakSet<InspirationChatMessage[]>, maxBytes = 16 * 1024 * 1024, maxLoaded = 3): InspirationConversation[] {
  let bytes = 0
  let count = 0
  const keep = new Set<string>()
  for (const entry of conversations) {
    if (entry.messagesLoaded === false || (!protectedIds.has(entry.id) && durable.has(entry.messages))) continue
    keep.add(entry.id); bytes += historyBytes(entry.messages); count++
  }
  // The list already places recently updated conversations first.
  for (const entry of conversations) {
    if (entry.messagesLoaded === false || keep.has(entry.id)) continue
    const weight = historyBytes(entry.messages)
    if (count < maxLoaded && bytes + weight <= maxBytes) { keep.add(entry.id); bytes += weight; count++ }
  }
  let changed = false
  const next = conversations.map(entry => {
    if (entry.messagesLoaded === false || keep.has(entry.id)) return entry
    changed = true
    return { ...entry, messages: [], messagesLoaded: false }
  })
  return changed ? next : conversations
}
