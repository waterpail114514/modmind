import { expect, it } from 'vitest'
import { agentSettingsPatch, mergeAgentSettingsPatch } from './agentSettingsPatch'
import type { AgentSettings } from './types'

const defaults: AgentSettings = { codingBackend: 'quota', allowBuildScriptChanges: true, preferLocalGradle: false,
  gradleDownloadSource: 'auto', javaPreferences: { game: '', build: '', tools: '' }, darkMode: false, closeBehavior: 'ask', notificationsEnabled: true }

it('preserves unrelated concurrent dictionary entries and removes only explicitly cleared ones', () => {
  const before: AgentSettings = { ...defaults, externalAgents: { codex: { model: 'a', modelContextWindows: { a: 4096 } } } }
  const delta = agentSettingsPatch(before, { externalAgents: { codex: { model: 'a', modelContextWindows: {} } } })
  const concurrent: AgentSettings = { ...defaults, externalAgents: { codex: { model: 'b', modelContextWindows: { a: 4096, b: 8192 } } } }
  expect(mergeAgentSettingsPatch(concurrent, delta)).toMatchObject({ externalAgents: { codex: { model: 'b', modelContextWindows: { b: 8192 } } } })
})

it('replaces arrays and null and supports explicit theme removal', () => {
  const before: AgentSettings = { ...defaults, customThemeColors: { dark: { canvas: '#000000', accent: '#ffffff' } },
    background: { media: { file: 'background.png', name: 'old', kind: 'image' }, opacity: 0.5, blur: 0, fit: 'cover', paused: false },
    externalAgents: { codex: { reasoningEffortOptions: { model: ['low', 'high'] } } } }
  const update = agentSettingsPatch(before, { customThemeColors: {}, background: { ...before.background!, media: null },
    externalAgents: { codex: { reasoningEffortOptions: { model: ['low'] } } } })
  const result = mergeAgentSettingsPatch(before, update)
  expect(result.customThemeColors).toEqual({})
  expect(result.background?.media).toBeNull()
  expect(result.externalAgents?.codex?.reasoningEffortOptions?.model).toEqual(['low'])
})

it('keeps save-only credential controls even when the draft contains an empty key', () => {
  const before: AgentSettings = { ...defaults, externalAgents: { codex: { apiKey: '', model: 'a' } } }
  expect(agentSettingsPatch(before, { externalAgents: { codex: { ...before.externalAgents?.codex, apiKey: '', clearApiKey: true } } })).toEqual({ externalAgents: { codex: { apiKey: '', clearApiKey: true } } })
})

it('rejects invalid patch values, unknown fields, and prototype mutation', () => {
  const settings = {} as AgentSettings
  expect(() => mergeAgentSettingsPatch(settings, null as never)).toThrow('对象')
  expect(() => mergeAgentSettingsPatch(settings, { unknown: true } as never)).toThrow('不支持')
  expect(() => mergeAgentSettingsPatch(settings, JSON.parse('{"externalAgents":{"__proto__":{"x":1}}}'))).toThrow('无效')
})
