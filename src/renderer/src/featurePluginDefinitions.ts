import * as icons from 'lucide-react'
import type { FeaturePluginRecord } from '../../shared/featurePlugins'
import { featureDefinitionApplies, featureScopeApplies, featurePageApplies } from '../../shared/featureApplicability'
import type { FeatureRendererModule, FeaturePageDefinition, FeatureSettingsDefinition } from './featurePluginTypes'

export function resolveFeatureModule(record: FeaturePluginRecord, exports: Record<string, unknown>): FeatureRendererModule {
  if (!exports) throw new Error('插件未注册界面')
  const metadata = exports as unknown as Partial<FeatureRendererModule>
  const pages = (record.manifest?.views ?? []).map(view => {
    const component = exports[view.component]
    if (typeof component !== 'function') throw new Error(`插件页面未注册：${view.id}`)
    const extra = metadata.pages?.find(page => page.id === view.id)
    return { ...extra, id: view.id, label: view.label, group: view.group ?? '工具', order: view.order, icon: (icons as unknown as Record<string, icons.LucideIcon>)[view.icon] ?? icons.Puzzle, component,
      supports: (project, uiMode) => featureScopeApplies(record.manifest, project) && featureScopeApplies(view, project) && featurePageApplies(extra ?? {}, project, uiMode)
    } as FeaturePageDefinition
  })
  const settings = (record.manifest?.settings ?? []).map(section => {
    const component = exports[section.component]
    if (typeof component !== 'function') throw new Error(`插件设置未注册：${section.id}`)
    const extra = metadata.settings?.find(value => value.id === section.id)
    return { ...extra, id: section.id, category: section.category, keywords: section.keywords ?? section.label, component,
      supports: (project, uiMode) => featureScopeApplies(record.manifest, project) && featureScopeApplies(section, project) && featurePageApplies(extra ?? {}, project, uiMode)
    } as FeatureSettingsDefinition
  })
  return { apiVersion: 2, pages, settings, launcherActions: metadata.launcherActions, backgroundComponents: metadata.backgroundComponents,
    supports: (project, uiMode) => featureDefinitionApplies(record.manifest, project) && featurePageApplies(metadata, project, uiMode) }
}
