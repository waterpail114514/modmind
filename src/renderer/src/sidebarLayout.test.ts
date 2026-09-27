import { describe, expect, it } from 'vitest'
import { deleteSidebarCategory, emptySidebarLayout, migrateSidebarLayout, moveSidebarCategory, moveSidebarEntry, parseSidebarLayout, resolveSidebarGroups, type SidebarLayout } from './sidebarLayout'

const defaults = [
  { groupKey: '0', label: '创作', items: [{ id: 'workspace' }, { id: 'inspiration' }] },
  { groupKey: '1', label: '资源', items: [{ id: 'images' }, { id: 'sounds' }] },
  { groupKey: '2', label: '项目', items: [{ id: 'settings' }] }
]
const ids = (groups: ReturnType<typeof resolveSidebarGroups>) => groups.map(group => [group.groupKey, group.items.map(item => item.id)])

describe('sidebar layout persistence and recovery', () => {
  it('migrates existing cross-category assignments and order without duplicating entries', () => {
    const layout = migrateSidebarLayout({ 0: ['sounds', 'inspiration', 'inspiration'], 1: ['sounds', 'images'] }, ['1', '0'])
    expect(ids(resolveSidebarGroups(defaults, layout))).toEqual([
      ['1', ['images']], ['0', ['sounds', 'inspiration', 'workspace']], ['2', ['settings']]
    ])
  })

  it('deletes built-in and custom categories while preserving visibility and all entries', () => {
    let layout = { ...emptySidebarLayout(), hiddenItems: ['sounds'], customGroups: [{ groupKey: 'custom-test', label: '常用' }] }
    layout = moveSidebarEntry(layout, resolveSidebarGroups(defaults, layout), 'inspiration', 'custom-test')
    layout = deleteSidebarCategory(layout, resolveSidebarGroups(defaults, layout), '1')
    layout = deleteSidebarCategory(layout, resolveSidebarGroups(defaults, layout), 'custom-test')
    const groups = resolveSidebarGroups(defaults, layout)
    expect(groups.find(group => group.groupKey === 'ungrouped')?.items.map(item => item.id)).toEqual(['images', 'sounds', 'inspiration'])
    expect(groups.some(group => group.groupKey === '1' || group.groupKey === 'custom-test')).toBe(false)
    expect(layout.hiddenItems).toEqual(['sounds'])
    expect(groups.flatMap(group => group.items)).toHaveLength(5)
  })

  it('reorders hidden entries and categories and supports moving to an empty category', () => {
    let layout = { ...emptySidebarLayout(), hiddenItems: ['sounds'], customGroups: [{ groupKey: 'custom-test', label: '常用' }] }
    layout = moveSidebarEntry(layout, resolveSidebarGroups(defaults, layout), 'sounds', '1', 'images')
    layout = moveSidebarEntry(layout, resolveSidebarGroups(defaults, layout), 'images', 'custom-test')
    layout = moveSidebarCategory(layout, resolveSidebarGroups(defaults, layout), 'custom-test', '0')
    expect(ids(resolveSidebarGroups(defaults, layout))).toEqual([
      ['custom-test', ['images']], ['0', ['workspace', 'inspiration']], ['1', ['sounds']], ['2', ['settings']]
    ])
  })

  it('keeps temporarily unavailable plugin assignments while other entries are moved', () => {
    let layout: SidebarLayout = { ...emptySidebarLayout(), orders: { 1: ['plugin:example', 'sounds'] }, hiddenItems: ['plugin:example'] }
    layout = moveSidebarEntry(layout, resolveSidebarGroups(defaults, layout), 'images', '0')
    const withPlugin = [...defaults, { groupKey: '3', label: '插件', items: [{ id: 'plugin:example' }] }]
    expect(resolveSidebarGroups(withPlugin, layout).find(group => group.groupKey === '1')?.items.map(item => item.id)).toEqual(['plugin:example', 'sounds'])
    expect(layout.hiddenItems).toContain('plugin:example')
  })

  it('keeps future entries in a deleted default category recoverable', () => {
    const layout = deleteSidebarCategory(emptySidebarLayout(), defaults, '1')
    const updated = defaults.map(group => group.groupKey === '1' ? { ...group, items: [...group.items, { id: 'new-resource' }] } : group)
    expect(resolveSidebarGroups(updated, layout).find(group => group.groupKey === 'ungrouped')?.items.map(item => item.id)).toContain('new-resource')
  })

  it('round trips renamed categories and validates corrupt or unsupported storage', () => {
    const layout = { ...emptySidebarLayout(), customGroups: [{ groupKey: 'custom-test', label: '自定义' }], labels: { 0: '我的创作' } }
    expect(parseSidebarLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    expect(() => parseSidebarLayout(null)).toThrow()
    expect(() => parseSidebarLayout({ version: 2 })).toThrow()
    expect(parseSidebarLayout({ version: 1, customGroups: [null, {}, { groupKey: '0', label: '冲突' }], orders: { 0: ['workspace', null, 'workspace'] } }).orders).toEqual({ 0: ['workspace'] })
  })

  it('never loses entries when all default categories are removed', () => {
    let layout = emptySidebarLayout()
    for (const group of defaults) layout = deleteSidebarCategory(layout, resolveSidebarGroups(defaults, layout), group.groupKey)
    expect(resolveSidebarGroups(defaults, layout)).toEqual([{ groupKey: 'ungrouped', label: '未分类', items: defaults.flatMap(group => group.items) }])
  })
})
