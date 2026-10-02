import { describe, expect, it } from 'vitest'
import { AgentOutputLimitRecovery, ExternalAgentOutputLimitError, isOutputLimitFailure, looksLikeCappedReply } from './agentOutputLimit'

describe('output limit recovery evidence', () => {
  const unfinished = '已检查当前代码。'.repeat(150) + '\n- 0'

  it('recognizes the actual Codex incomplete-response error without matching unrelated limits', () => {
    expect(isOutputLimitFailure('stream disconnected before completion: Incomplete response returned, reason: max_output_tokens')).toBe(true)
    for (const message of ['Invalid max_output_tokens: 8192', 'context window exceeded', 'usage limit exceeded', 'Incomplete response returned, reason: content_filter', '429 Too Many Requests']) {
      expect(isOutputLimitFailure(message)).toBe(false)
    }
  })

  it('requires both a common exact output boundary and unfinished long text', () => {
    expect(looksLikeCappedReply(unfinished, 8192)).toBe(true)
    expect(looksLikeCappedReply(unfinished, 8191)).toBe(false)
    expect(looksLikeCappedReply(unfinished, undefined)).toBe(false)
    expect(looksLikeCappedReply('简短回答', 8192)).toBe(false)
    for (const ending of ['。', '.', '！', '!', '?', '？', '\n```']) expect(looksLikeCappedReply(unfinished + ending, 8192)).toBe(false)
  })

  it('bounds continuations even when every segment changes or no text is available', () => {
    for (const empty of [false, true]) {
      const guard = new AgentOutputLimitRecovery()
      for (let i = 1; i <= 3; i++) expect(guard.next(new ExternalAgentOutputLimitError('max-output-tokens', empty ? '' : `segment ${i}`))).toBe(i)
      expect(() => guard.next(new ExternalAgentOutputLimitError('max-output-tokens', 'next'))).toThrow('自动继续未能完成任务')
    }
  })

  it('stops when the provider repeats the same truncated reply', () => {
    const guard = new AgentOutputLimitRecovery()
    guard.next(new ExternalAgentOutputLimitError('suspected-output-limit', unfinished))
    expect(() => guard.next(new ExternalAgentOutputLimitError('suspected-output-limit', unfinished))).toThrow('自动继续未能完成任务')
  })
})
