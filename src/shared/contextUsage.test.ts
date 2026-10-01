import { describe, expect, it } from 'vitest'
import { contextTokens, latestContextUsage, mergeContextUsage } from './contextUsage'

describe('persisted context usage', () => {
  const measured = { model: 'gpt-6-sol', backend: 'quota' as const, inputTokens: 105000, contextWindow: 1050000 }

  it('retains measured usage when the next turn only reports its configuration', () => {
    const saved = JSON.parse(JSON.stringify([{ usage: measured }]))
    saved.push({ usage: { model: 'gpt-6-sol', backend: 'quota', contextWindow: 1050000 } })
    expect(latestContextUsage(saved)).toMatchObject({ contextTokens: 105000, contextWindow: 1050000 })
  })

  it('updates a changed window without discarding usage, and accepts compaction and zero', () => {
    const changedWindow = mergeContextUsage(measured, { contextWindow: 512000 })
    expect(changedWindow).toMatchObject({ contextTokens: 105000, contextWindow: 512000 })
    const compacted = mergeContextUsage(changedWindow, { inputTokens: 20000 })
    expect(contextTokens(compacted)).toBe(20000)
    expect(contextTokens(mergeContextUsage(compacted, { contextTokens: 0 }))).toBe(0)
  })

  it('preserves context when a terminal event reports cumulative billing', () => {
    const measuredUsage = { model: 'gpt-6-sol', backend: 'codex' as const, contextTokens: 100000, contextWindow: 1000000 }
    const terminal = mergeContextUsage(measuredUsage, { cumulative: true, inputTokens: 5000000, contextTokens: undefined })
    expect(contextTokens(terminal)).toBe(100000)
    expect(contextTokens(mergeContextUsage(terminal, { cumulative: true, contextTokens: 30000 }))).toBe(30000)
    expect(contextTokens({ cumulative: true, inputTokens: 5000000 })).toBeUndefined()
  })

  it('isolates model and backend changes, empty conversations and selected models', () => {
    expect(mergeContextUsage(measured, { model: 'gpt-6-luna', contextWindow: 512000 })).toEqual({ model: 'gpt-6-luna', contextWindow: 512000 })
    expect(mergeContextUsage(measured, { model: measured.model, backend: 'codex' })).toEqual({ model: measured.model, backend: 'codex' })
    expect(latestContextUsage([])).toBeUndefined()
    expect(latestContextUsage([{ usage: measured }], { model: 'gpt-6-luna' })).toBeUndefined()
    expect(latestContextUsage([{ usage: measured }], { backend: 'codex' })).toBeUndefined()
  })

  it('ignores invalid measurements and reuses an unchanged snapshot', () => {
    const previous = mergeContextUsage(undefined, measured)!
    expect(mergeContextUsage(previous, { contextWindow: 1050000 })).toBe(previous)
    expect(mergeContextUsage(previous, { contextTokens: NaN, inputTokens: -1, contextWindow: 0 })).toBe(previous)
  })
})
