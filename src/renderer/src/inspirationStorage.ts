import type { InspirationChatMessage } from '../../shared/types'
import { normalizeAiTurnReplay } from '../../shared/aiReplay'
import { isAiOperationalStatusText } from '../../shared/aiOutput'

export interface InspirationConversation {
  id: string
  title: string
  updatedAt: string
  messages: InspirationChatMessage[]
}

export interface InspirationStoragePayload {
  activeId: string
  conversations: InspirationConversation[]
}

export interface InspirationStorageResult {
  status: 'saved' | 'compacted' | 'unavailable'
  storedBytes: number
  error?: string
}

interface StorageWriter {
  setItem: (key: string, value: string) => void
}

// localStorage is a compatibility fallback only. The ConversationStore is the
// authoritative local journal; these caps protect the legacy browser fallback.
const MAX_CONVERSATIONS = 12
const MAX_MESSAGES_PER_CONVERSATION = 100
const MAX_MESSAGE_CONTENT_CHARS = 32 * 1024
const MAX_TOOL_CONTENT_CHARS = 2 * 1024
export const MAX_INSPIRATION_STORAGE_BYTES = 512 * 1024

export function boundInspirationMessages(messages: InspirationChatMessage[], maxMessages = MAX_MESSAGES_PER_CONVERSATION): InspirationChatMessage[] {
  if (messages.length <= maxMessages) return messages
  const maxTools = Math.min(30, Math.floor(maxMessages / 2))
  const toolIndexes = messages.map((message, index) => message.kind === 'tool' ? index : -1).filter((index) => index >= 0).slice(-maxTools)
  const nonToolIndexes = messages.map((message, index) => message.kind !== 'tool' ? index : -1).filter((index) => index >= 0).slice(-(maxMessages - toolIndexes.length))
  const selected = new Set([...toolIndexes, ...nonToolIndexes])
  return messages.filter((_message, index) => selected.has(index))
}

export function normalizeStoredInspirationMessages(messages: InspirationChatMessage[]): InspirationChatMessage[] {
  return messages.map((message, index, allMessages) => {
    if (message.role !== 'assistant') {
      const replay = normalizeAiTurnReplay(message.replay)
      return replay ? { ...message, replay } : message.replay ? { ...message, replay: undefined } : message
    }
    if (message.kind === 'tool') return message.status === 'streaming' ? { ...message, status: 'completed' } : message
    if (message.status === 'streaming') {
      return {
        role: 'assistant',
        content: '上次灵感回答在完成前中断，请重新发送问题。',
        status: 'error',
        isFinal: true,
        ...(message.sessionId ? { sessionId: message.sessionId } : {})
      }
    }
    if (isAiOperationalStatusText(message.content)) {
      return { ...message, kind: 'tool', status: 'completed', isFinal: false }
    }
    if (message.isFinal !== undefined) return message
    const nextUser = allMessages.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.role === 'user')
    const nextAssistant = allMessages.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.role === 'assistant' && candidate.kind !== 'tool')
    const isLastAssistantInTurn = nextAssistant < 0 || (nextUser >= 0 && nextAssistant > nextUser)
    return { ...message, isFinal: isLastAssistantInTurn && message.status === 'completed' }
  })
}

function estimatedStorageBytes(value: string): number {
  // Chromium's localStorage quota is measured against UTF-16 storage.
  return value.length * 2
}

function compactMessage(message: InspirationChatMessage, contentLimit = MAX_MESSAGE_CONTENT_CHARS): InspirationChatMessage | null {
  const content = typeof message.content === 'string' ? message.content : ''
  const limit = message.kind === 'tool' ? Math.min(contentLimit, MAX_TOOL_CONTENT_CHARS) : contentLimit
  return {
    ...message,
    content: content.length > limit ? `${content.slice(0, limit)}\n\n[历史内容已截断]` : content
  }
}

function selectConversations(payload: InspirationStoragePayload): InspirationConversation[] {
  const selected = payload.conversations.slice(0, MAX_CONVERSATIONS)
  const active = payload.conversations.find((conversation) => conversation.id === payload.activeId)
  if (active && !selected.some((conversation) => conversation.id === active.id)) {
    if (selected.length >= MAX_CONVERSATIONS) selected[selected.length - 1] = active
    else selected.push(active)
  }
  return selected.map((conversation) => ({
    ...conversation,
    messages: boundInspirationMessages(conversation.messages
      .map((message) => compactMessage(message))
      .filter((message): message is InspirationChatMessage => message !== null))
  }))
}

function serializeWithinBudget(payload: InspirationStoragePayload): { value: string; compacted: boolean } {
  const conversations = selectConversations(payload)
  let compacted = conversations.length !== payload.conversations.length
    || conversations.some((conversation) => {
      const original = payload.conversations.find((candidate) => candidate.id === conversation.id)
      return !original || original.messages.length !== conversation.messages.length
        || original.messages.some((message, index) => message.content !== conversation.messages[index]?.content)
    })
  const next: InspirationStoragePayload = { activeId: payload.activeId, conversations }
  let value = JSON.stringify(next)

  while (estimatedStorageBytes(value) > MAX_INSPIRATION_STORAGE_BYTES) {
    let removableIndex = -1
    for (let index = next.conversations.length - 1; index >= 0; index -= 1) {
      if (next.conversations[index].id === next.activeId) continue
      removableIndex = index
      break
    }
    if (removableIndex >= 0) {
      next.conversations.splice(removableIndex, 1)
      compacted = true
      value = JSON.stringify(next)
      continue
    }

    const active = next.conversations.find((conversation) => conversation.id === next.activeId) ?? next.conversations[0]
    if (!active || active.messages.length <= 2) break
    const removeCount = Math.max(1, Math.ceil(active.messages.length / 4))
    active.messages = active.messages.slice(removeCount)
    compacted = true
    value = JSON.stringify(next)
  }

  return { value, compacted }
}

function minimalPayload(payload: InspirationStoragePayload): string {
  const active = payload.conversations.find((conversation) => conversation.id === payload.activeId)
  if (!active) return JSON.stringify({ activeId: payload.activeId, conversations: [] } satisfies InspirationStoragePayload)
  const messages = active.messages
    .map((message) => compactMessage(message, 4 * 1024))
    .filter((message): message is InspirationChatMessage => message !== null)
    .slice(-10)
  return JSON.stringify({
    activeId: payload.activeId,
    conversations: [{ ...active, messages }]
  } satisfies InspirationStoragePayload)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Persists inspiration history without allowing browser storage failures to escape into React. */
export function persistInspirationHistory(
  storage: StorageWriter,
  key: string,
  payload: InspirationStoragePayload
): InspirationStorageResult {
  try {
    const prepared = serializeWithinBudget(payload)
    try {
      storage.setItem(key, prepared.value)
      return {
        status: prepared.compacted ? 'compacted' : 'saved',
        storedBytes: estimatedStorageBytes(prepared.value)
      }
    } catch (error) {
      const fallback = minimalPayload(payload)
      try {
        storage.setItem(key, fallback)
        return { status: 'compacted', storedBytes: estimatedStorageBytes(fallback) }
      } catch (fallbackError) {
        return { status: 'unavailable', storedBytes: 0, error: errorMessage(fallbackError || error) }
      }
    }
  } catch (error) {
    return { status: 'unavailable', storedBytes: 0, error: errorMessage(error) }
  }
}
