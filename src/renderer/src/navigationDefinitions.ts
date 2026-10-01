import { Code2, FolderOpen, Gamepad2, Hammer, LayoutGrid, Lightbulb, MessageSquareText, Puzzle, Server, Settings, type LucideIcon } from 'lucide-react'
import type { ProjectInfo, SidebarViewId, UiMode } from '../../shared/types'
import type { PluginRecord } from '../../shared/plugins'
import type { ModpackContentFeatures } from '../../shared/modpackContentFeatures'
import { isJavaLoader } from '../../shared/projectPlatform'
import type { SidebarGroup } from './sidebarLayout'
import type { FeaturePageDefinition } from './featurePluginTypes'

export interface NavigationEntry { id: SidebarViewId; label: string; icon: LucideIcon }

export function buildNavigationDefinitions({ project, uiMode, plugins, featurePages = [] }: {
  project: ProjectInfo | null
  uiMode: UiMode
  plugins: PluginRecord[]
  featurePages?: FeaturePageDefinition[]
  contentFeatures?: ModpackContentFeatures
  imageStudioEnabled?: boolean
}): {
  baseVisibleNavGroups: SidebarGroup<NavigationEntry>[]
  navLabelMap: Partial<Record<SidebarViewId, string>>
  navOrderStorageKey: string
  sidebarLayoutStorageKey: string
} {
  const groups: Array<Omit<SidebarGroup<NavigationEntry>, 'groupKey'>> = project ? [
    { label: '创作', items: [{ id: 'workspace', label: '工作台', icon: MessageSquareText }, { id: 'inspiration', label: '灵感台', icon: Lightbulb }] },
    { label: '开发', items: [{ id: 'code', label: '代码', icon: Code2 }] },
    { label: '测试与构建', items: [
      ...(project.kind === 'server-plugin' || project.kind === 'modpack' ? [{ id: 'modpack-server' as const, label: '测试', icon: Server }] : []),
      ...(project.kind !== 'server-plugin' && (project.kind === 'modpack' || isJavaLoader(project.loader)) ? [{ id: 'minecraft' as const, label: project.kind === 'modpack' ? '游戏测试' : '测试', icon: Gamepad2 }] : []),
      { id: 'build', label: '构建与导出', icon: Hammer }
    ] },
    { label: '项目', items: [{ id: 'features', label: '功能', icon: LayoutGrid }, { id: 'settings', label: '设置', icon: Settings }] }
  ] : [
    { label: '项目', items: [{ id: 'workspace', label: '项目', icon: FolderOpen }] },
    { label: '应用', items: [{ id: 'features', label: '功能', icon: LayoutGrid }, { id: 'settings', label: '设置', icon: Settings }] }
  ]
  for (const page of [...featurePages].sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    if (page.supports && !page.supports(project, uiMode)) continue
    let group = groups.find(entry => entry.label === page.group)
    if (!group) {
      group = { label: page.group, items: [] }
      groups.splice(Math.max(1, groups.length - 1), 0, group)
    }
    group.items.push({ id: page.id as SidebarViewId, label: page.label, icon: page.icon })
  }
  groups.push({ label: '插件', items: [
    ...plugins.filter(plugin => plugin.enabled && !plugin.error && plugin.manifest.panel).map(plugin => ({ id: `plugin:${plugin.manifest.id}` as SidebarViewId, label: plugin.manifest.name, icon: Puzzle })),
    { id: 'plugins', label: '管理插件', icon: Puzzle }
  ] })
  const navLabelMap = Object.fromEntries(groups.flatMap(group => group.items.map(item => [item.id, item.label]))) as Partial<Record<SidebarViewId, string>>
  const navOrderStorageKey = `modmind-sidebar-order:feature-v1:${uiMode}:${project?.kind ?? 'launcher'}:${project && isJavaLoader(project.loader) ? 'java' : 'addon'}`
  return {
    baseVisibleNavGroups: groups.map((group, index) => ({ ...group, groupKey: String(index) })),
    navLabelMap,
    navOrderStorageKey,
    sidebarLayoutStorageKey: navOrderStorageKey.replace('modmind-sidebar-order:', 'modmind-sidebar-layout:v1:')
  }
}
