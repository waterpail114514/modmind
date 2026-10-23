import type { FeaturePluginCatalogEntry, FeaturePluginDefinition } from './featurePlugins'

export const OFFICIAL_FEATURE_BASE = 'https://mmdesktop.cn-nb1.rains3.com/'
export const OFFICIAL_FEATURE_INDEX = 'features/stable/catalog.json'
export interface OfficialFeatureRelease {
  id: string
  name: string
  description: string
  version: string
  apiVersion: number
  hostVersion: string
  path: string
  sha256: string
  size: number
  publishedAt: string
  changelog: string[]
  dependencies: string[]
  groups: string[]
  target?: { platform: string; arch: string }
}
export interface OfficialFeatureIndex { format: 'modmind-feature-catalog'; schemaVersion: 1; generatedAt: string; features: OfficialFeatureRelease[] }
export interface FeatureStoreEntry extends FeaturePluginCatalogEntry {
  description: string
  groups: string[]
  release?: OfficialFeatureRelease
  updateAvailable: boolean
  incompatible?: string
}
export interface FeatureStoreJob {
  id: string
  name: string
  phase: 'downloading' | 'installing' | 'done' | 'error' | 'cancelled'
  downloaded: number
  total: number
  message?: string
}
export interface FeatureRecommendation { id: string; reason: string }
export interface FeatureRecommendationResult {
  mode: 'automatic' | 'manual'
  recommendations: Array<FeatureRecommendation & { name: string; status: 'ready' | 'installed' | 'manual' | 'failed'; message?: string }>
  instruction: string
  tools: import('./featurePlugins').FeaturePluginDiscoveredTool[]
}
export interface FeatureStoreSnapshot {
  entries: FeatureStoreEntry[]
  checking: boolean
  checkedAt?: string
  error?: string
  cached: boolean
  job?: FeatureStoreJob
}
export function featureGroups(definition?: Pick<FeaturePluginDefinition, 'views' | 'studios'>): string[] {
  return [...new Set([...(definition?.studios?.length ? ['工作台'] : []), ...(definition?.views?.map(view => view.group ?? '工具') ?? [])])].filter(Boolean).slice(0,16).sort((a,b) => a.localeCompare(b, 'zh-CN'))
}
export const FEATURE_GROUP_ORDER = ['工作台', '创作', '开发', '测试与构建', '资源', '内容', '运行', '项目', '工具', '支持组件']
export function orderedFeatureGroups(entries: Array<{ groups: string[] }>): string[] {
  const groups = [...new Set(entries.flatMap(entry => entry.groups.length ? entry.groups : ['支持组件']))]
  return groups.sort((a,b) => (FEATURE_GROUP_ORDER.indexOf(a) < 0 ? 99 : FEATURE_GROUP_ORDER.indexOf(a)) - (FEATURE_GROUP_ORDER.indexOf(b) < 0 ? 99 : FEATURE_GROUP_ORDER.indexOf(b)) || a.localeCompare(b, 'zh-CN'))
}
