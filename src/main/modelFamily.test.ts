import { describe, expect, it } from 'vitest'
import { compareModelVersions, parseModelFamily } from './modelFamily'

describe('model series boundaries', () => {
  it('orders minor versions numerically and understands both Claude name formats', () => {
    expect(compareModelVersions([5, 10], [5, 9])).toBeGreaterThan(0)
    expect(compareModelVersions([6, 0], [5, 99])).toBeGreaterThan(0)
    expect(parseModelFamily('anthropic/claude-opus-5-5')).toEqual(parseModelFamily('claude-5.5-opus'))
    expect(parseModelFamily('OpenAI/GPT-7-Sol')).toEqual(parseModelFamily('gpt-7-sol'))
  })
  it.each([
    ['gpt-7-sol', 'gpt-7-luna'], ['gpt-7-sol', 'gpt-7-sol-pro'], ['gpt-7', 'gpt-7-mini'],
    ['claude-opus-6', 'claude-sonnet-6'], ['gemini-4-pro', 'gemini-4-flash'],
    ['gemini-4-pro', 'gemini-4-pro-preview'], ['qwen4-max', 'qwen4-max-prime'],
    ['deepseek-v5-pro', 'deepseek-v5-flash'], ['mimo-v3-pro', 'mimo-v3-pro-ultraspeed']
  ])('keeps %s separate from %s', (a, b) => {
    expect(parseModelFamily(a)).toBeDefined()
    expect(parseModelFamily(b)).toBeDefined()
    expect(parseModelFamily(a)?.key).not.toBe(parseModelFamily(b)?.key)
  })
})
