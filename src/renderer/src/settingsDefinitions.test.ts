import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findSettingsSections, settingsCategories, settingsSections } from './settingsDefinitions'

// Search results and metadata were captured from SettingsSections.tsx at
// checkpoint 6002438becc683a5126b36fd9ce4fd4d8b0aaaca before extraction.
// The two model sections now include the independent compaction-setting keywords.
const baseline = JSON.parse(readFileSync(new URL('./__fixtures__/extensionDefinitions.baseline.json', import.meta.url), 'utf8')) as {
  settings: { categories: unknown; sections: unknown }
  searchCases: Array<{
    activeCategory: string
    query: string
    availableIds: string[]
    searching: boolean
    visibleIds: string[]
  }>
}

describe('settings definition compatibility', () => {
  it.each(['压缩 阈值', 'compaction'])('finds both compaction settings from %s', query => {
    const result = findSettingsSections(new Set(settingsSections.map(section => section.id)), 'general', query)
    expect(result.visibleSections.map(section => section.id)).toEqual(['settings-ai'])
  })
  it.each(['更长上下文', '超长上下文', '272K'])('finds the long-context option from %s', query => {
    const result = findSettingsSections(new Set(settingsSections.map(section => section.id)), 'general', query)
    expect(result.visibleSections.map(section => section.id)).toEqual(['settings-ai'])
  })
  it('preserves category and section IDs, order, labels, descriptions and search keywords', () => {
    expect(settingsCategories).toEqual(baseline.settings.categories)
    const originalKeywords = ' 更长上下文 超长上下文 256K 272K 消费'
    expect(settingsSections.filter(section => section.id !== 'settings-authors').map(section => section.id === 'settings-ai'
      ? { ...section, keywords: section.keywords.replace(originalKeywords, '') } : section)).toEqual(baseline.settings.sections)
  })

  it('finds the author credits by name and contribution', () => {
    const available = new Set(settingsSections.map(section => section.id))
    for (const query of ['关于作者', '水桶', 'SQ0', '素材贡献者']) {
      expect(findSettingsSections(available, 'general', query).visibleSections.map(section => section.id)).toContain('settings-authors')
    }
  })

  it.each(baseline.searchCases)('preserves "$query" in $activeCategory for the available sections', scenario => {
    const result = findSettingsSections(new Set(scenario.availableIds), scenario.activeCategory, scenario.query)
    expect(result.searching).toBe(scenario.searching)
    expect(result.visibleSections.map(section => section.id)).toEqual(scenario.visibleIds)
  })
})
