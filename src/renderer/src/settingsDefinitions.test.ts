import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findSettingsSections, settingsCategories, settingsSections } from './settingsDefinitions'

// Search results and metadata were captured from SettingsSections.tsx at
// checkpoint 6002438becc683a5126b36fd9ce4fd4d8b0aaaca before extraction.
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
  it('preserves category and section IDs, order, labels, descriptions and search keywords', () => {
    expect(settingsCategories).toEqual(baseline.settings.categories)
    expect(settingsSections).toEqual(baseline.settings.sections)
  })

  it.each(baseline.searchCases)('preserves "$query" in $activeCategory for the available sections', scenario => {
    const result = findSettingsSections(new Set(scenario.availableIds), scenario.activeCategory, scenario.query)
    expect(result.searching).toBe(scenario.searching)
    expect(result.visibleSections.map(section => section.id)).toEqual(scenario.visibleIds)
  })
})
