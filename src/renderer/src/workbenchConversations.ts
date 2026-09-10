import type { AiTokenUsage } from '../../shared/types'
import type { WorkbenchTimelineItem } from './workbenchTimeline'

/**
 * One named workbench conversation thread. Conversations share the project's
 * files, but each keeps an independent CLI session (via its own sessionScope),
 * timeline, and prompt history.
 */
export interface WorkbenchConversation {
  id: string
  /** The user's first message; the switcher truncates its display only. */
  title: string
  createdAt: string
  updatedAt: string
  sessionScope: string
}

export const WORKBENCH_LEGACY_SCOPE = 'workspace'

/** The migrated pre-beta thread; it reuses the legacy 'workspace' scope so its CLI session pointer keeps resuming. */
export function isLegacyWorkbenchConversation(conversation: Pick<WorkbenchConversation, 'id' | 'sessionScope'>): boolean {
  return conversation.id === WORKBENCH_LEGACY_SCOPE || conversation.sessionScope === WORKBENCH_LEGACY_SCOPE
}

function newConversationId(now = Date.now()): string {
  return `ws-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Conversation ids become path segments and localStorage key parts. */
export function isValidWorkbenchConversationId(id: string): boolean {
  return /^ws-[\w-]+$/u.test(id)
}

export function workbenchSessionScope(conversationId: string): string {
  return `workspace/${conversationId}`
}

export function workbenchPromptHistoryStorageKey(
  projectPath: string,
  conversation: Pick<WorkbenchConversation, 'id' | 'sessionScope'>
): string {
  const legacyKey = `modmind-workspace-prompts:${projectPath}`
  return isLegacyWorkbenchConversation(conversation) ? legacyKey : `${legacyKey}:${conversation.id}`
}

export function createWorkbenchConversation(existing: WorkbenchConversation[] = [], now = new Date()): { conversations: WorkbenchConversation[]; conversation: WorkbenchConversation } {
  const used = new Set(existing.map((item) => item.id))
  let id = newConversationId(now.getTime())
  while (used.has(id)) id = newConversationId(now.getTime() + Math.floor(Math.random() * 1000))
  const conversation: WorkbenchConversation = {
    id,
    title: '新的对话',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sessionScope: workbenchSessionScope(id)
  }
  return { conversations: [...existing, conversation], conversation }
}

/** Keeps the conversation's full first message; the switcher fades overflow. */
export function titleFromUserText(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim() || '新的对话'
}

/** Short relative stamp for the switcher: 刚刚 / N分钟 / N小时 / 昨天 / M月D日. */
export function formatConversationTime(updatedAt: string, now = new Date()): string {
  const time = Date.parse(updatedAt)
  if (!Number.isFinite(time)) return ''
  const elapsedMs = now.getTime() - time
  if (elapsedMs < 60_000) return '刚刚'
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}分钟前`
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}小时前`
  const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (time >= startOfDay(now) - 86_400_000) return '昨天'
  const date = new Date(time)
  const sameYear = date.getFullYear() === now.getFullYear()
  return sameYear ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** Keeps the list ordered by recency and refreshes the active entry's stamp/title. */
export function touchWorkbenchConversation(
  conversations: WorkbenchConversation[],
  conversationId: string,
  updates: { title?: string } = {},
  now = new Date()
): WorkbenchConversation[] {
  return conversations
  .map((item) => item.id === conversationId
    ? { ...item, ...updates, updatedAt: now.toISOString() }
    : item)
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function removeWorkbenchConversation(
  conversations: WorkbenchConversation[],
  conversationId: string
): WorkbenchConversation[] {
  return conversations.filter((item) => item.id !== conversationId)
}

export function normalizeWorkbenchConversations(value: unknown): WorkbenchConversation[] {
  if (!Array.isArray(value)) return []
  return value
  .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
  .filter((entry) => typeof entry.id === 'string' && isValidWorkbenchConversationId(entry.id) || entry.id === WORKBENCH_LEGACY_SCOPE)
  .map((entry) => ({
    id: String(entry.id),
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : '新的对话',
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
    sessionScope: typeof entry.sessionScope === 'string' && entry.sessionScope.trim() ? entry.sessionScope : workbenchSessionScope(String(entry.id))
  }))
}

/**
 * Legacy builds kept one anonymous workspace thread per project. It becomes
 * the original conversation, reusing the legacy scope so the existing CLI
 * session pointer keeps resuming. It can be deleted like any other
 * conversation once its history is no longer needed.
 */
export function migrateLegacyConversation(timelineLength = 0): WorkbenchConversation {
  return {
    id: WORKBENCH_LEGACY_SCOPE,
    title: timelineLength > 0 ? '原始对话' : '新的对话',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    sessionScope: WORKBENCH_LEGACY_SCOPE
  }
}

export type WorkbenchConversationSnapshot = {
  conversationId: string
  timeline: WorkbenchTimelineItem[]
  usage?: AiTokenUsage
}
