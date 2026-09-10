import { describe, expect, it } from 'vitest'
import { aiConversationIdForSession, aiRecoveryMatchesSessionScope, aiRecoverySessionScope, normalizeAiSessionScope, recoveryBelongsToConversation } from './aiSession'

describe('AI recovery session scope', () => {
  it('only offers recovery in the owning conversation, including legacy checkpoints', () => {
    expect(recoveryBelongsToConversation({ pending: true, conversationId: 'ws-a' }, 'ws-a')).toBe(true)
    expect(recoveryBelongsToConversation({ pending: true, conversationId: 'ws-a' }, 'ws-b')).toBe(false)
    expect(recoveryBelongsToConversation({ pending: true }, 'ws-a')).toBe(false)
    expect(recoveryBelongsToConversation({ pending: true }, 'workspace')).toBe(true)
    expect(recoveryBelongsToConversation({ pending: false, conversationId: 'ws-a' }, 'ws-a')).toBe(false)
    expect(recoveryBelongsToConversation(null, 'ws-a')).toBe(false)
  })
  it('normalizes legacy and conversation scopes', () => {
    expect(normalizeAiSessionScope()).toBe('workspace')
    expect(normalizeAiSessionScope('/workspace\\ws-a/')).toBe('workspace/ws-a')
    expect(aiRecoverySessionScope({ conversationId: 'ws-a' })).toBe('workspace/ws-a')
    expect(aiConversationIdForSession({ sessionScope: 'workspace/ws-a' })).toBe('ws-a')
    expect(aiConversationIdForSession({ sessionScope: 'workspace' })).toBe('workspace')
  })

  it('only resumes a checkpoint in its owning conversation', () => {
    const recovery = { conversationId: 'ws-a', sessionScope: 'workspace/ws-a' }
    expect(aiRecoveryMatchesSessionScope(recovery, 'workspace/ws-a')).toBe(true)
    expect(aiRecoveryMatchesSessionScope(recovery, 'workspace/ws-b')).toBe(false)
    expect(aiRecoveryMatchesSessionScope(recovery)).toBe(false)
  })

  it('keeps legacy checkpoints in the legacy workspace scope', () => {
    expect(aiRecoveryMatchesSessionScope({}, 'workspace')).toBe(true)
    expect(aiRecoveryMatchesSessionScope({}, 'workspace/ws-new')).toBe(false)
  })

  it('rejects inconsistent checkpoint metadata', () => {
    expect(aiRecoveryMatchesSessionScope({ conversationId: 'ws-a', sessionScope: 'workspace/ws-b' }, 'workspace/ws-b')).toBe(false)
  })
})
