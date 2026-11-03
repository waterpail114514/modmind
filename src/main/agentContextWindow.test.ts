import { describe, expect, it } from 'vitest'
import type { AgentSettings } from '../shared/types'
import {
  ExternalAgentContextWindowError,
  isContextWindowFailure,
  narrowContextWindow,
  narrowSavedContextWindow,
  narrowedAutoCompactLimit,
  parseAdvertisedContextLimit
} from './agentContextWindow'

describe('context window overflow detection', () => {
  it('trusts the protocol error code over any wording', () => {
    expect(isContextWindowFailure('', 'contextWindowExceeded')).toBe(true)
    expect(isContextWindowFailure('', { contextWindowExceeded: { maxTokens: 65_536 } })).toBe(true)
  })

  it('recognises the wordings providers use when no code is forwarded', () => {
    for (const message of [
      '400 This model\'s maximum context length is 65536 tokens. However, you requested 200000 tokens.',
      'context_length_exceeded: your prompt is too long for this model',
      'Error: input is too long for requested model',
      'The context window exceeds the limit of 128000 tokens',
      'too many tokens, please reduce the length of the messages'
    ]) expect(isContextWindowFailure(message)).toBe(true)
  })

  it('recognises the payload real Codex 0.154.0 forwards for an oversized prompt', () => {
    // Captured from the managed Codex app-server (the version ModMind pins):
    // the provider body arrives as a JSON string under error.message and the
    // protocol only labels it "other", so the wording fallback is the only path.
    const forwarded = JSON.stringify({
      error: {
        message: 'This model\'s maximum context length is 65536 tokens. However, you requested 1000000 tokens (1000000 included 0 reasoning). Please reduce the length of the messages.',
        type: 'invalid_request_error',
        code: 'context_length_exceeded'
      }
    })
    expect(isContextWindowFailure(forwarded, 'other')).toBe(true)
    expect(parseAdvertisedContextLimit(forwarded, 'other')).toBe(65_536)
    expect(narrowContextWindow(1_000_000, parseAdvertisedContextLimit(forwarded, 'other'))).toBe(65_536)
  })

  it('never mistakes an unrelated failure for an oversized prompt', () => {
    for (const message of [
      '429 rate limit exceeded, please retry later',
      'Invalid value: \'minimal\'. Supported values are: low, medium, high.',
      '400 Bad Request: messages[0].role must be user',
      'ECONNRESET while reading the response stream',
      'model_providers.thirdparty.base_url is not set',
      // A per-minute token budget, not a context capacity: shrinking is useless.
      'too many tokens per minute, please slow down'
    ]) expect(isContextWindowFailure(message)).toBe(false)
  })

  it('reads a capacity stated in structured error data first', () => {
    expect(parseAdvertisedContextLimit('whatever', { contextWindowExceeded: { maxTokens: 32_768 } })).toBe(32_768)
    expect(parseAdvertisedContextLimit('whatever', { contextWindowExceeded: { max_context_window: 65_536 } })).toBe(65_536)
  })

  it('reads a capacity stated in the message', () => {
    expect(parseAdvertisedContextLimit('This model\'s maximum context length is 65536 tokens.')).toBe(65_536)
    expect(parseAdvertisedContextLimit('context length of 32768 exceeded')).toBe(32_768)
    expect(parseAdvertisedContextLimit('limit of 1,000,000 tokens per request')).toBe(1_000_000)
    expect(parseAdvertisedContextLimit('prompt is too long: 210000 tokens > 200000 maximum')).toBe(200_000)
  })

  it('ignores numbers that are not a capacity statement', () => {
    expect(parseAdvertisedContextLimit('request id 20241103abcdef failed with status 400')).toBeUndefined()
    expect(parseAdvertisedContextLimit('maximum context length is 0 tokens')).toBeUndefined()
    expect(parseAdvertisedContextLimit('maximum context length is 1.5 tokens')).toBeUndefined()
    expect(parseAdvertisedContextLimit('maximum context length is 900000000 tokens')).toBeUndefined()
    expect(parseAdvertisedContextLimit('maximum context length is 512 tokens')).toBeUndefined()
  })
})

describe('context window narrowing', () => {
  it('adopts the capacity the provider named', () => {
    expect(narrowContextWindow(256_000, 65_536)).toBe(65_536)
    expect(narrowContextWindow(undefined, 32_768)).toBe(32_768)
  })

  it('halves only when the provider named nothing', () => {
    expect(narrowContextWindow(262_144)).toBe(131_072)
    expect(narrowContextWindow(100_000)).toBe(50_000)
  })

  it('refuses to shrink when the rejection was not caused by the setting', () => {
    expect(narrowContextWindow(65_536, 200_000)).toBeUndefined()
    expect(narrowContextWindow(65_536, 65_536)).toBeUndefined()
  })

  it('stops at the usable minimum instead of collapsing', () => {
    expect(narrowContextWindow(1024)).toBeUndefined()
    expect(narrowContextWindow(2048)).toBe(1024)
    expect(narrowContextWindow(undefined)).toBeUndefined()
  })

  it('keeps the compaction threshold inside the narrowed window', () => {
    expect(narrowedAutoCompactLimit(230_000, 65_536)).toBe(58_982)
    expect(narrowedAutoCompactLimit(40_000, 65_536)).toBe(40_000)
    expect(narrowedAutoCompactLimit(undefined, 65_536)).toBe(58_982)
    expect(narrowedAutoCompactLimit(0, 65_536)).toBe(58_982)
  })
})

describe('narrowing the saved configuration', () => {
  const settings = (windows: Record<string, number>, compact: Record<string, number>) => ({
    codingBackend: 'codex',
    allowBuildScriptChanges: true,
    preferLocalGradle: false,
    gradleDownloadSource: 'auto',
    javaPreferences: {},
    darkMode: false,
    externalAgents: { codex: { model: 'm', modelContextWindows: windows, modelAutoCompactTokenLimits: compact } }
  }) as unknown as AgentSettings

  it('writes both the window and a compaction limit that fits inside it', () => {
    const next = narrowSavedContextWindow(settings({ m: 256_000 }, { m: 230_000 }), 'm', 65_536)
    expect(next.externalAgents?.codex?.modelContextWindows).toEqual({ m: 65_536 })
    expect(next.externalAgents?.codex?.modelAutoCompactTokenLimits).toEqual({ m: 58_982 })
  })

  it('leaves other models and unrelated settings untouched', () => {
    const next = narrowSavedContextWindow(settings({ m: 256_000, other: 32_768 }, { m: 230_000 }), 'm', 65_536)
    expect(next.externalAgents?.codex?.modelContextWindows).toEqual({ m: 65_536, other: 32_768 })
    expect(next.codingBackend).toBe('codex')
  })

  it('creates the entry when the model had no saved window', () => {
    expect(narrowSavedContextWindow(settings({}, {}), 'm', 32_768).externalAgents?.codex?.modelContextWindows).toEqual({ m: 32_768 })
  })

  it('returns the settings unchanged when the agent has no saved configuration', () => {
    const empty = { codingBackend: 'quota', allowBuildScriptChanges: true, preferLocalGradle: false, gradleDownloadSource: 'auto', javaPreferences: {}, darkMode: false } as unknown as AgentSettings
    expect(narrowSavedContextWindow(empty, 'm', 32_768)).toBe(empty)
  })
})

describe('context window error', () => {
  it('states what the user can act on', () => {
    const error = new ExternalAgentContextWindowError('cohere/north-mini-code:free', 262_144, 65_536, 'raw')
    expect(error.name).toBe('ExternalAgentContextWindowError')
    expect(error.message).toContain('65,536')
    expect(error.message).toContain('262,144')
    expect(error.model).toBe('cohere/north-mini-code:free')
  })

  it('stays readable when the provider named no capacity', () => {
    const error = new ExternalAgentContextWindowError('m', 100_000, undefined, 'raw')
    expect(error.message).toContain('100,000')
    expect(error.message).not.toContain('undefined')
  })
})
