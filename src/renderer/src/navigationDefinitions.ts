import { Archive, ArrowRightLeft, Binary, BookOpen, Box, CloudUpload, Code2, FileCog, FolderOpen, Gamepad2, Gauge, Hammer, History, Image, LibraryBig, Lightbulb, Link2, List, MessageSquareText, Music, PackageOpen, PackagePlus, Puzzle, Save, Server, ServerCog, Settings, SlidersHorizontal, Sparkles, WandSparkles, type LucideIcon } from 'lucide-react'
import type { ProjectInfo, SidebarViewId, UiMode } from '../../shared/types'
import type { PluginRecord } from '../../shared/plugins'
import { isJavaLoader, isServerPluginPlatform } from '../../shared/projectPlatform'
import type { SidebarGroup } from './sidebarLayout'

export interface NavigationEntry {
  id: SidebarViewId
  label: string
  icon: LucideIcon
}

type NavigationProject = Pick<ProjectInfo, 'kind' | 'loader'> | null
type NavigationGroup = Omit<SidebarGroup<NavigationEntry>, 'groupKey'>

function buildProjectNavigationGroups(project: NavigationProject): NavigationGroup[] {
  const javaProject = !project || isJavaLoader(project.loader)
  const modpackProject = project?.kind === 'modpack'
  const pluginProject = project?.kind === 'server-plugin'
  if (!project) {
    return [
      {
        label: '项目',
        items: [{ id: 'workspace' as const, label: '项目', icon: FolderOpen }]
      },
      {
        label: '应用',
        items: [
          { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
          { id: 'settings' as const, label: '设置', icon: Settings }
        ]
      }
    ]
  }

  if (pluginProject) return [
    { label: '创作', items: [{ id: 'workspace' as const, label: '工作台', icon: MessageSquareText }, { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }] },
    { label: '工具', items: [{ id: 'relationships' as const, label: '依赖与联动', icon: Link2 }, { id: 'code' as const, label: '代码', icon: Code2 }, { id: 'decompile' as const, label: '反编译', icon: Binary }, { id: 'modpack-server' as const, label: '测试', icon: Server }, { id: 'build' as const, label: '构建与导出', icon: Hammer }, { id: 'snapshots' as const, label: '版本迁移', icon: ArrowRightLeft }] },
    { label: '项目', items: [{ id: 'settings' as const, label: '设置', icon: Settings }] },
    { label: '资源', items: [
      { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
      { id: 'blockbench' as const, label: '模型', icon: Box },
      { id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image }
    ] }
  ]
  if (modpackProject) {
    return [
      { label: '创作', items: [
        { id: 'workspace' as const, label: '整合包创作', icon: MessageSquareText },
        { id: 'modpack-manifest' as const, label: '文件清单', icon: Archive },
        { id: 'modpack-mod-list' as const, label: '模组列表', icon: List },
        { id: 'third-party-mods' as const, label: '模组下载', icon: PackagePlus }
      ] },
      { label: '内容', items: [
        { id: 'modpack-config' as const, label: '配置与默认项', icon: FileCog },
        { id: 'modpack-scripts' as const, label: '脚本与 KubeJS', icon: Code2 },
        { id: 'modpack-datapacks' as const, label: '数据包', icon: Archive },
        { id: 'ftb-quests' as const, label: 'FTB 任务书', icon: BookOpen },
        { id: 'patchouli' as const, label: 'Patchouli 指南书', icon: LibraryBig },
        { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
        { id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image },
        { id: 'modpack-shaders' as const, label: '光影包', icon: Sparkles },
        { id: 'modpack-ui' as const, label: '界面资源', icon: WandSparkles },
        { id: 'modpack-worlds' as const, label: '存档与世界', icon: Save },
        { id: 'modpack-client' as const, label: '玩家预设', icon: SlidersHorizontal },
        { id: 'modpack-server-content' as const, label: '服务端配置', icon: ServerCog },
        { id: 'modpack-files' as const, label: '文件工作台', icon: FolderOpen },
        { id: 'code' as const, label: '代码编辑器', icon: Code2 }
      ] },
      { label: '运行', items: [
        { id: 'modpack-migration' as const, label: '版本迁移', icon: ArrowRightLeft },
        { id: 'decompile' as const, label: '反编译', icon: Binary },
        { id: 'modpack-automation' as const, label: '依赖与优化', icon: Gauge },
        { id: 'modpack-server' as const, label: '测试', icon: Server },
        { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 }
      ] },
      { label: '项目', items: [
        { id: 'production' as const, label: '版本与导出', icon: CloudUpload },
        { id: 'snapshots' as const, label: '版本记录', icon: History },
        { id: 'settings' as const, label: '设置', icon: Settings }
      ] }
    ]
  }

  if (javaProject) return [
    { label: '创作', items: [
      { id: 'workspace' as const, label: '工作台', icon: MessageSquareText },
      { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }
    ] },
    { label: '资源', items: [
      { id: 'item-editor' as const, label: '物品与装备', icon: PackageOpen },
      { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
      { id: 'blockbench' as const, label: '模型', icon: Box },
      { id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image },
      { id: 'sounds' as const, label: '声音', icon: Music }
    ] },
    { label: '开发', items: [
      { id: 'code' as const, label: '代码', icon: Code2 },
      { id: 'relationships' as const, label: '前置与联动', icon: Link2 },
      { id: 'decompile' as const, label: '反编译', icon: Binary },
      { id: 'mappings' as const, label: 'Mappings', icon: LibraryBig }
    ] },
    { label: '测试与构建', items: [
      { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 },
      { id: 'build' as const, label: '构建与导出', icon: Hammer }
    ] },
    { label: '项目', items: [
      { id: 'production' as const, label: '发布', icon: CloudUpload },
      { id: 'snapshots' as const, label: '版本', icon: History },
      { id: 'settings' as const, label: '设置', icon: Settings }
    ] }
  ]

  return [
  {
    label: '创作',
    items: modpackProject ? [
      { id: 'workspace' as const, label: '整合包创作', icon: MessageSquareText },
      { id: 'modpack-mod-list' as const, label: '模组列表', icon: List },
      { id: 'third-party-mods' as const, label: '模组下载', icon: PackagePlus },
      { id: 'modpack-config' as const, label: '配置与默认项', icon: FileCog },
      { id: 'modpack-scripts' as const, label: '脚本与 KubeJS', icon: Code2 },
      { id: 'modpack-datapacks' as const, label: '数据包', icon: Archive },
      { id: 'ftb-quests' as const, label: 'FTB 任务书', icon: BookOpen },
      { id: 'patchouli' as const, label: 'Patchouli 指南书', icon: LibraryBig },
      { id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image },
      { id: 'modpack-shaders' as const, label: '光影包', icon: Sparkles },
      { id: 'modpack-ui' as const, label: '界面资源', icon: WandSparkles },
      { id: 'modpack-worlds' as const, label: '存档与世界', icon: Save },
      { id: 'modpack-client' as const, label: '玩家预设', icon: SlidersHorizontal },
      { id: 'modpack-server-content' as const, label: '服务端配置', icon: ServerCog },
      { id: 'modpack-files' as const, label: '文件工作台', icon: FolderOpen },
      { id: 'modpack-automation' as const, label: '依赖与优化', icon: Gauge },
      { id: 'modpack-server' as const, label: '测试', icon: Server },
      { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 },
      { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }
    ] : [
      { id: 'workspace' as const, label: '工作台', icon: MessageSquareText },
      { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb },
      ...(javaProject ? [{ id: 'item-editor' as const, label: '物品与装备', icon: PackageOpen }] : []),
      { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
      { id: 'blockbench' as const, label: '模型', icon: Box },
      { id: 'code' as const, label: '代码', icon: Code2 },
      ...(javaProject ? [{ id: 'relationships' as const, label: '前置与联动', icon: Link2 }] : []),
      ...(javaProject ? [{ id: 'decompile' as const, label: '反编译', icon: Binary }] : []),
      ...(javaProject ? [{ id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 }] : []),
      { id: 'build' as const, label: '构建与导出', icon: Hammer }
    ]
  },
  {
    label: '项目',
    items: modpackProject ? [
      { id: 'production' as const, label: '导出', icon: CloudUpload },
      { id: 'snapshots' as const, label: '版本', icon: History },
      { id: 'settings' as const, label: '设置', icon: Settings }
    ] : [
      ...(javaProject ? [{ id: 'production' as const, label: '发布', icon: CloudUpload }] : []),
      { id: 'snapshots' as const, label: '版本', icon: History },
      ...(javaProject ? [{ id: 'mappings' as const, label: 'Mappings', icon: LibraryBig }] : []),
      { id: 'settings' as const, label: '设置', icon: Settings }
    ]
  }
  ]
}

export function buildNavigationDefinitions({ project, uiMode, plugins }: {
  project: NavigationProject
  uiMode: UiMode
  plugins: PluginRecord[]
}): {
  baseVisibleNavGroups: SidebarGroup<NavigationEntry>[]
  navLabelMap: Partial<Record<SidebarViewId, string>>
  navOrderStorageKey: string
  sidebarLayoutStorageKey: string
} {
  const javaProject = !project || isJavaLoader(project.loader)
  const modpackProject = project?.kind === 'modpack'
  const pluginProject = project?.kind === 'server-plugin'
  const navGroups = buildProjectNavigationGroups(project)
  const visibleNavGroupsRaw = uiMode === 'beginner' && !pluginProject
    ? !project
      ? [
          { label: '项目', items: [{ id: 'workspace' as const, label: '项目', icon: FolderOpen }] },
          { label: '应用', items: [
            { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
            { id: 'settings' as const, label: '设置', icon: Settings }
          ] }
        ]
      : [
          ...(modpackProject ? [{
            label: '创作',
            items: [
              { id: 'workspace' as const, label: '工作台', icon: Sparkles },
              { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb },
              { id: 'ftb-quests' as const, label: 'FTB 任务书', icon: BookOpen },
              { id: 'patchouli' as const, label: 'Patchouli 指南书', icon: LibraryBig },
              { id: 'image-studio' as const, label: '图像工坊', icon: WandSparkles },
              { id: 'code' as const, label: '代码编辑器', icon: Code2 },
              { id: 'minecraft' as const, label: '游戏测试', icon: Gamepad2 }
            ]
          }] : []),
          ...(!modpackProject ? javaProject
            ? navGroups.map(group => ({ ...group, items: group.items.filter(item => ['workspace', 'inspiration', 'item-editor', 'modpack-resourcepacks', 'sounds', 'relationships', 'minecraft'].includes(item.id)) })).filter(group => group.items.length > 0)
            : [{ label: '创作', items: [
              { id: 'workspace' as const, label: '开始创作', icon: Sparkles },
              { id: 'inspiration' as const, label: '灵感', icon: Lightbulb },
              { id: 'build' as const, label: '构建与导出', icon: Hammer }
            ] }] : [])
        ]
    : navGroups
  const enabledPanelPlugins = plugins.filter(plugin => plugin.enabled && !plugin.error && plugin.manifest.panel)
  const hasEnabledOverlayPlugin = plugins.some(plugin => plugin.enabled && !plugin.error && plugin.manifest.overlay)
  const visibleNavGroupsWithPlugins = (() => {
    const groups = project && (isJavaLoader(project.loader) || isServerPluginPlatform(project.loader)) && !visibleNavGroupsRaw.some(group => group.items.some(item => item.id === 'modpack-resourcepacks'))
      ? [...visibleNavGroupsRaw, { label: '资源', items: [{ id: 'modpack-resourcepacks' as const, label: '资源包', icon: Image }, ...(isJavaLoader(project.loader) && project.kind !== 'modpack' && project.kind !== 'server-plugin' ? [{ id: 'sounds' as const, label: '声音', icon: Music }] : [])] }]
      : visibleNavGroupsRaw
    const showManagerAlways = uiMode !== 'beginner'
    if (enabledPanelPlugins.length === 0 && !hasEnabledOverlayPlugin && !showManagerAlways) return groups
    return [...groups, {
      label: '插件',
      items: [
        ...enabledPanelPlugins.map((plugin) => ({
          id: `plugin:${plugin.manifest.id}` as SidebarViewId,
          label: plugin.manifest.name,
          icon: Puzzle
        })),
        { id: 'plugins' as const, label: '管理插件', icon: Puzzle }
      ]
    }]
  })()
  const navLabelMap: Partial<Record<SidebarViewId, string>> = {
    workspace: modpackProject ? '工作台' : uiMode === 'beginner' ? '开始创作' : '工作台',
    'item-editor': '物品与装备',
    sounds: '声音',
    inspiration: '灵感台',
    relationships: pluginProject ? '依赖与联动' : uiMode === 'beginner' ? '联动模组' : '前置与联动',
    'modpack-manifest': '文件清单',
    'modpack-mod-list': '模组列表',
    'third-party-mods': '模组下载',
    'modpack-config': '配置与默认项',
    'modpack-scripts': '脚本与 KubeJS',
    'modpack-datapacks': '数据包',
    'modpack-content': '任务与手册',
    'ftb-quests': 'FTB 任务书',
    patchouli: 'Patchouli 指南书',
    'modpack-resourcepacks': '资源包',
    'modpack-shaders': '光影包',
    'modpack-ui': '界面资源',
    'modpack-worlds': '存档与世界',
    'modpack-client': '玩家预设',
    'modpack-server-content': '服务端配置',
    'modpack-files': '文件工作台',
    'modpack-migration': '版本迁移',
    decompile: '反编译',
    plugins: '管理插件',
    'modpack-automation': '依赖与优化',
    'modpack-server': '测试',
    minecraft: '游戏测试',
    'image-studio': '图像工坊',
    blockbench: '模型',
    code: '代码',
    build: '构建与导出',
    production: '发布',
    snapshots: pluginProject ? '版本迁移' : '版本记录',
    mappings: 'Mappings',
    settings: '设置'
  }
  // Group indices changed for Java mods. Preserve the previous layout under its
  // old key so saved cross-group assignments cannot undo the new defaults.
  const navLayoutVersion = project && javaProject && !modpackProject && !pluginProject ? 'v3' : 'v2'
  const navOrderStorageKey = `modmind-sidebar-order:${navLayoutVersion}:${uiMode}:${project?.kind ?? 'launcher'}:${javaProject ? 'java' : 'addon'}`
  const sidebarLayoutStorageKey = navOrderStorageKey.replace('modmind-sidebar-order:', 'modmind-sidebar-layout:v1:')

  const baseVisibleNavGroups = visibleNavGroupsWithPlugins.map((group, groupIndex) => ({
    ...group,
    groupKey: String(groupIndex),
    label: group.label === '创建' || group.label === '鍒涗綔' ? '创作' : group.label === '项目' || group.label === '椤圭洰' ? '项目' : group.label === '应用' || group.label === '搴旂敤' ? '应用' : group.label,
    items: (() => {
      const mapped = group.items
        .filter((item) => uiMode !== 'beginner' || pluginProject || item.id !== 'image-studio')
        .map((item) => ({ ...item, label: navLabelMap[item.id] || item.label }))
      if (uiMode === 'beginner' && modpackProject && !mapped.some((item) => item.id === 'modpack-server')) {
        mapped.push({ id: 'modpack-server' as const, label: '测试', icon: Server })
      }
      if (!modpackProject || uiMode === 'beginner' || groupIndex !== 0) return mapped
      const primary = mapped.find((item) => item.id === 'workspace')
      const inspiration = { id: 'inspiration' as const, label: '灵感台', icon: Lightbulb }
      const modList = mapped.find((item) => item.id === 'modpack-mod-list')
      const downloads = mapped.find((item) => item.id === 'third-party-mods')
      const rest = mapped.filter((item) => !['workspace', 'inspiration', 'modpack-mod-list', 'third-party-mods'].includes(item.id))
      return [primary, inspiration, modList, downloads, ...rest].filter(Boolean) as typeof mapped
    })()
  }))
  return { baseVisibleNavGroups, navLabelMap, navOrderStorageKey, sidebarLayoutStorageKey }
}
