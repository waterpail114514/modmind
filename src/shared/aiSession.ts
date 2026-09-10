export interface AiRecoverySessionIdentity {
  conversationId?: string
  sessionScope?: string
}

export function recoveryBelongsToConversation(recovery: { pending: boolean; conversationId?: string } | null | undefined, conversationId: string): boolean {
  return Boolean(recovery?.pending && conversationId && (recovery.conversationId || 'workspace') === conversationId)
}

export function normalizeAiSessionScope(value?: string): string {
  return value?.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') || 'workspace'
}

export function aiRecoverySessionScope(recovery: AiRecoverySessionIdentity): string {
  const conversationId = recovery.conversationId?.trim()
  return normalizeAiSessionScope(recovery.sessionScope || (conversationId ? `workspace/${conversationId}` : undefined))
}

export function aiConversationIdForSession(identity: AiRecoverySessionIdentity): string | undefined {
  const conversationId = identity.conversationId?.trim()
  if (conversationId) return conversationId
  const sessionScope = aiRecoverySessionScope(identity)
  if (sessionScope === 'workspace') return 'workspace'
  return sessionScope.startsWith('workspace/') ? sessionScope.slice('workspace/'.length) || undefined : undefined
}

export function aiRecoveryMatchesSessionScope(
  recovery: AiRecoverySessionIdentity,
  requestedSessionScope?: string
): boolean {
  const requested = normalizeAiSessionScope(requestedSessionScope)
  if (aiRecoverySessionScope(recovery) !== requested) return false
  const conversationId = recovery.conversationId?.trim()
  return !conversationId || normalizeAiSessionScope(`workspace/${conversationId}`) === requested
}
