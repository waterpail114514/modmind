import { describe, expect, it } from 'vitest'
import { beginnerReasoningEffort, beginnerReasoningLevelFor, migrateLegacyReasoningLevel } from './aiPreferences'

describe('beginner AI preferences', () => {
  it('sends the literal choice for every model and leaves auto unset', () => {
    expect(beginnerReasoningEffort('gpt-6-sol', 'low')).toBe('low')
    expect(beginnerReasoningEffort('gpt-6-luna', 'max')).toBe('max')
    expect(beginnerReasoningEffort('gpt-5.6-terra', 'none')).toBe('none')
    expect(beginnerReasoningEffort('unknown', 'auto')).toBeUndefined()
  })

  it('migrates legacy effort values into the closest visible label', () => {
    expect(beginnerReasoningLevelFor('gpt-5.6-sol', 'xhigh')).toBe('xhigh')
    expect(beginnerReasoningLevelFor('gpt-5.6-terra', 'high')).toBe('high')
    expect(beginnerReasoningLevelFor('gpt-5.6-terra', 'unknown')).toBe('auto')
    expect(migrateLegacyReasoningLevel('gpt-5.6-sol', 'low')).toBe('medium')
    expect(migrateLegacyReasoningLevel('gpt-6-sol', 'extreme')).toBe('ultra')
  })
})
