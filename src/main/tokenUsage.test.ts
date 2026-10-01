import { describe, expect, it } from 'vitest'
import { extractCodexTokenUsage } from './externalAgents'

describe('extractCodexTokenUsage', () => {
  it('reads totals and the context window from token_count events', () => {
    const usage = extractCodexTokenUsage({
      type: 'token_count',
      payload: {
        info: {
          total_token_usage: { input_tokens: 12_345, cached_input_tokens: 9_000, output_tokens: 678 },
          model_context_window: 272_000.4
        }
      }
    })
    expect(usage).toEqual({ inputTokens: 12_345, cachedInputTokens: 9_000, outputTokens: 678, contextWindow: 272_000 })
  })

  it('falls back to per-model usage when total_token_usage is absent', () => {
    const usage = extractCodexTokenUsage({
      type: 'token_count',
      payload: {
        info: {
          model_usage: {
            'gpt-5': { input_tokens: 100, output_tokens: 20 },
            other: { input_tokens: 1 }
          },
          model_context_window: 400_000
        }
      }
    })
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, contextWindow: 400_000 })
  })

  it('reads the current codex exec turn.completed usage shape without inventing a context window', () => {
    const usage = extractCodexTokenUsage({
      type: 'turn.completed',
      usage: { input_tokens: 24_763, cached_input_tokens: 24_448, output_tokens: 122, reasoning_output_tokens: 0 }
    })
    expect(usage).toEqual({ inputTokens: 24_763, cachedInputTokens: 24_448, outputTokens: 122 })
  })

  it('ignores non-token_count events and malformed payloads', () => {
    expect(extractCodexTokenUsage({ type: 'response_item', payload: {} })).toBeUndefined()
    expect(extractCodexTokenUsage(null)).toBeUndefined()
    expect(extractCodexTokenUsage({ type: 'token_count' })).toBeUndefined()
    expect(extractCodexTokenUsage({
      type: 'token_count',
      payload: { info: { total_token_usage: 'oops' } }
    })).toBeUndefined()
  })
})
