import { describe, expect, it } from 'vitest'
import { defaultAiSelection, normalizeAiModelSelection, readSurfaceAiSelection, settingsForAiSelection } from './aiSelection'
import type { AgentSettings } from './types'

describe('independent surface AI choices', () => {
  it('uses saved defaults on reset and never overwrites another surface or provider', () => {
    const settings = { codingBackend: 'codex', externalAgents: { codex: { model: 'default-codex', reasoningEffort: 'high', apiKey: 'fixture', modelContextWindows: { 'default-codex': 524288 } }, claude: { model: 'default-claude', reasoningEffort: 'max' } } } as unknown as AgentSettings
    const original = structuredClone(settings)
    const inspiration = settingsForAiSelection(settings, 'codex', { model: 'inspiration', reasoningLevel: 'ultra' })
    expect(inspiration.externalAgents?.codex).toMatchObject({ model: 'inspiration', reasoningEffort: 'ultra', apiKey: 'fixture' })
    expect(settings).toEqual(original)
    expect(inspiration.externalAgents?.claude).toBe(settings.externalAgents?.claude)
    expect(settingsForAiSelection(settings, 'codex')).toBe(settings)
    expect(defaultAiSelection('codex', { model: 'quota', reasoningLevel: 'low', fastMode: false }, settings.externalAgents)).toEqual({ backend: 'codex', model: 'default-codex', reasoningLevel: 'high' })
    expect(settingsForAiSelection(settings, 'codex', { model: 'other', reasoningLevel: 'auto' }).externalAgents?.codex?.reasoningEffort).toBeUndefined()
  })

  it('validates per-run choices and safely ignores invalid local preferences', () => {
    expect(normalizeAiModelSelection({ model: ' gpt-6-sol ', reasoningLevel: 'none' })).toEqual({ model: 'gpt-6-sol', reasoningLevel: 'none' })
    expect(() => normalizeAiModelSelection({ model: 'test', reasoningLevel: 'extreme' })).toThrow()
    expect(readSurfaceAiSelection('{bad')).toBeUndefined()
    expect(readSurfaceAiSelection(JSON.stringify({ backend: 'claude', model: 'claude-opus-5-5', reasoningLevel: 'max' }))).toMatchObject({ backend: 'claude', reasoningLevel: 'max' })
  })
})
