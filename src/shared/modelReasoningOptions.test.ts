import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_REASONING_EFFORTS, normalizeReasoningEffortOptions, reasoningOptions, reasoningSelectionEffort, selectedReasoningEfforts } from './modelReasoning'

describe('configured Codex reasoning choices', () => {
  it('defaults to five manual levels plus auto and accepts an exact-model override', () => {
    expect(DEFAULT_CODEX_REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoningOptions(undefined, selectedReasoningEfforts('unknown'))).toEqual(['auto', ...DEFAULT_CODEX_REASONING_EFFORTS])
    const configured = normalizeReasoningEffortOptions({ 'deepseek-v4.1-flash': ['ultra', 'high', 'medium', 'low', 'none'] })
    const efforts = selectedReasoningEfforts('deepseek-v4.1-flash', configured)
    expect(efforts).toEqual(['none', 'low', 'medium', 'high', 'ultra'])
    expect(reasoningSelectionEffort('ultra', { source: 'registry', controls: ['effort'], efforts: ['high'] }, efforts)).toBe('ultra')
    expect(() => reasoningSelectionEffort('xhigh', undefined, efforts)).toThrow('未开放')
    expect(selectedReasoningEfforts('another', configured)).toEqual(DEFAULT_CODEX_REASONING_EFFORTS)
  })

  it('rejects duplicate, empty, unknown, and sixth choices', () => {
    expect(normalizeReasoningEffortOptions({ duplicate: ['high', 'high'], empty: [], unknown: ['fast'], six: ['none', 'low', 'medium', 'high', 'xhigh', 'ultra'] })).toBeUndefined()
    expect(normalizeReasoningEffortOptions({ valid: ['low'], invalid: ['low', 'low'] })).toEqual({ valid: ['low'] })
  })
})
