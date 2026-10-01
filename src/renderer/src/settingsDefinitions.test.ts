import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findSettingsSections, settingsCategories, settingsSections } from './settingsDefinitions'

// Search results and metadata were captured from SettingsSections.tsx at
// checkpoint 6002438becc683a5126b36fd9ce4fd4d8b0aaaca before extraction.
// The two model sections now include the independent compaction-setting keywords.
const baseline = JSON.parse(readFileSync(new URL('./__fixtures__/extensionDefinitions.baseline.json', import.meta.url), 'utf8')) as {
  settings: { categories: unknown; sections: Array<{ id: string; category: string; keywords: string }> }
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
  it('preserves category and section IDs, order, labels, descriptions and search keywords', () => {
    expect(settingsCategories).toEqual(baseline.settings.categories)
    const externalIds = new Set(['settings-image', 'settings-release'])
    expect(settingsSections.filter(section => section.id !== 'settings-authors' && section.id !== 'settings-feature-plugins')).toEqual(baseline.settings.sections.filter(section => !externalIds.has(section.id)))
  })

  it('finds the author credits by name and contribution', () => {
    const available = new Set(settingsSections.map(section => section.id))
    for (const query of ['关于作者', '水桶', 'SQ0', '素材贡献者']) {
      expect(findSettingsSections(available, 'general', query).visibleSections.map(section => section.id)).toContain('settings-authors')
    }
  })

  it.each(baseline.searchCases)('preserves "$query" in $activeCategory for the available sections', scenario => {
    const external = baseline.settings.sections.filter(section => ['settings-image', 'settings-release'].includes(section.id))
    const result = findSettingsSections(new Set(scenario.availableIds), scenario.activeCategory, scenario.query, external)
    expect(result.searching).toBe(scenario.searching)
    expect(result.visibleSections.map(section => section.id).sort()).toEqual([...scenario.visibleIds].sort())
  })

  it('does not expose a removed plugin setting or lose it from search after registration', () => {
    const image = { id: 'settings-image', category: 'ai', keywords: '图像工坊 image' }
    expect(findSettingsSections(new Set(['settings-image']), 'ai', '图像工坊').visibleSections).toEqual([])
    expect(findSettingsSections(new Set(['settings-image']), 'general', '图像工坊', [image]).visibleSections).toEqual([image])
  })
})
