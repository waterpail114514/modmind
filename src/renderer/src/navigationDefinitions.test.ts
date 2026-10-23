import { describe, expect, it } from 'vitest'
import { WandSparkles, LibraryBig } from 'lucide-react'
import type { ProjectInfo } from '../../shared/types'
import type { FeaturePageDefinition } from './featurePluginTypes'
import { buildNavigationDefinitions } from './navigationDefinitions'
import { emptySidebarLayout, parseSidebarLayout, resolveSidebarGroups } from './sidebarLayout'
import { resolveFeatureModule } from './featurePluginDefinitions'
import catalog from '../../shared/featurePluginCatalog.json'
import type { FeaturePluginDefinition } from '../../shared/featurePlugins'

const project = { path: 'test-project', name: 'Test', namespace: 'test', loader: 'fabric', kind: 'mod', minecraftVersion: '1.20.1' } as ProjectInfo
const image: FeaturePageDefinition = { id: 'image-studio', label: '图像工坊', group: '资源', icon: WandSparkles, component: () => null }
const quests: FeaturePageDefinition = { id: 'ftb-quests', label: 'FTB 任务书', group: '内容', icon: LibraryBig, component: () => null, supports: value => value?.kind === 'modpack' }
const ids = (value: ReturnType<typeof buildNavigationDefinitions>) => value.baseVisibleNavGroups.flatMap(group => group.items.map(item => item.id))
describe('feature plugin navigation', () => {
  it.each(['beginner', 'advanced'] as const)('shows installed quest and guide pages in an empty modpack in %s mode', uiMode => {
    const featurePages = ['ftb-quests', 'patchouli'].flatMap(id => {
      const manifest = catalog.find(entry => entry.id === id) as FeaturePluginDefinition
      return resolveFeatureModule({ id, name: manifest.name, version: manifest.version, enabled: true, manifest }, { [id]: () => null }).pages
    })
    const input = { project: { ...project, kind: 'modpack' as const }, uiMode, plugins: [], featurePages }
    expect(ids(buildNavigationDefinitions(input))).toEqual(expect.arrayContaining(['ftb-quests', 'patchouli']))
    expect(ids(buildNavigationDefinitions({ ...input, featurePages: [] }))).not.toEqual(expect.arrayContaining(['ftb-quests', 'patchouli']))
    expect(ids(buildNavigationDefinitions({ ...input, project }))).not.toEqual(expect.arrayContaining(['ftb-quests', 'patchouli']))
  })
  it('uses studio-declared delivery navigation while preserving both AI surfaces and the editor', () => {
    const value = buildNavigationDefinitions({ project: { ...project, kind: 'shader', studioId: 'minecraft-shader', loader: 'iris' }, uiMode: 'advanced', plugins: [], studio: { navigation: { hideCoreViews: ['build'] } } as import('../../shared/studios').StudioDefinition })
    expect(ids(value)).not.toContain('build')
    expect(ids(value)).toEqual(['workspace', 'inspiration', 'code', 'features', 'settings', 'plugins'])
  })
  it('keeps only core surfaces when no feature modules are installed', () => {
    expect(ids(buildNavigationDefinitions({ project, uiMode: 'advanced', plugins: [] }))).toEqual(['workspace', 'inspiration', 'code', 'build', 'features', 'settings', 'plugins'])
    expect(ids(buildNavigationDefinitions({ project: null, uiMode: 'beginner', plugins: [] }))).toEqual(['workspace', 'features', 'settings', 'plugins'])
  })
  it('discovers pages from feature declarations and removes them when a module disappears', () => {
    const installed = buildNavigationDefinitions({ project, uiMode: 'advanced', plugins: [], featurePages: [image, quests] })
    expect(ids(installed)).toContain('image-studio')
    expect(ids(installed)).not.toContain('ftb-quests')
    expect(installed.navLabelMap['image-studio']).toBe('图像工坊')
    expect(ids(buildNavigationDefinitions({ project: { ...project, kind: 'modpack' }, uiMode: 'beginner', plugins: [], featurePages: [image, quests] }))).toContain('ftb-quests')
    expect(ids(buildNavigationDefinitions({ project, uiMode: 'advanced', plugins: [] }))).not.toContain('image-studio')
  })
  it('retains saved plugin positions while the plugin is absent and restores them on enable', () => {
    const layout = parseSidebarLayout({ ...emptySidebarLayout(), customGroups: [{ groupKey: 'custom-tools', label: '常用' }], orders: { 'custom-tools': ['image-studio'] } })
    const before = JSON.stringify(layout)
    const absent = buildNavigationDefinitions({ project, uiMode: 'advanced', plugins: [] })
    expect(resolveSidebarGroups(absent.baseVisibleNavGroups, layout).find(group => group.groupKey === 'custom-tools')?.items).toEqual([])
    const restored = buildNavigationDefinitions({ project, uiMode: 'advanced', plugins: [], featurePages: [image] })
    expect(resolveSidebarGroups(restored.baseVisibleNavGroups, layout).find(group => group.groupKey === 'custom-tools')?.items.map(item => item.id)).toEqual(['image-studio'])
    expect(JSON.stringify(layout)).toBe(before)
  })
  it('does not mutate feature metadata or share navigation entries between builds', () => {
    const input = { project, uiMode: 'advanced' as const, plugins: [], featurePages: [image] }
    const before = JSON.stringify(input)
    const first = buildNavigationDefinitions(input)
    const second = buildNavigationDefinitions(input)
    first.baseVisibleNavGroups[0].items[0].label = 'Changed'
    first.baseVisibleNavGroups[0].items.pop()
    expect(buildNavigationDefinitions(input)).toEqual(second)
    expect(JSON.stringify(input)).toBe(before)
  })
})
