import type { FeatureStoreEntry } from '../../shared/featureStore'

export const featureBundles = [
  { id: 'mod', name: '制作模组', studioId: 'minecraft-mod', ids: ['item-editor', 'data-packs', 'mappings', 'relationships', 'versions', 'testing'] },
  { id: 'modpack', name: '制作整合包', studioId: 'minecraft-modpack', ids: ['modpack-mods', 'modpack-content', 'data-packs', 'modpack-automation', 'ftb-quests', 'versions', 'testing'] },
  { id: 'server', name: '开发服务端插件', studioId: 'minecraft-server-plugin', ids: ['relationships', 'versions', 'testing'] },
  { id: 'assets', name: '制作素材', studioId: 'minecraft-mod', ids: ['image-studio', 'model-studio', 'resource-packs', 'sound-studio'] },
  { id: 'shader', name: '制作光影', studioId: 'minecraft-shader', ids: ['shader-source', 'shader-options', 'shader-preview', 'shader-testing', 'shader-export'] }
]

export function isStudioEntry(entry: FeatureStoreEntry): boolean {
  return Boolean(entry.manifest?.studios?.length || entry.groups.includes('工作台'))
}

export function isSupportEntry(entry: FeatureStoreEntry): boolean {
  return !isStudioEntry(entry) && entry.groups.includes('支持组件')
}

export function isLocalFeatureEntry(entry: FeatureStoreEntry): boolean {
  return entry.installed && !entry.builtin && (entry.installationSource === 'local' || !entry.installationSource && !entry.release)
}

export function canSelectFeature(entry: FeatureStoreEntry): boolean {
  return !entry.builtin && !entry.incompatible && !(entry.available && !entry.updateAvailable)
    && Boolean(entry.release || entry.installed && !entry.enabled && !entry.error)
}

export function featureInstallPlan(entries: FeatureStoreEntry[], ids: string[]): { bytes: number; dependencies: FeatureStoreEntry[]; error?: string } {
  const known = new Map(entries.map(entry => [entry.id, entry]))
  const selected = new Set(ids), visited = new Set<string>(), visiting = new Set<string>()
  const dependencies: FeatureStoreEntry[] = []
  let bytes = 0, error: string | undefined
  const visit = (id: string, dependency: boolean): void => {
    if (visiting.has(id)) { error ??= '功能依赖存在循环'; return }
    if (visited.has(id)) return
    const entry = known.get(id)
    if (!entry) { error ??= `缺少组件：${id}`; return }
    if (entry.builtin && entry.available || entry.available && (!selected.has(id) || !entry.updateAvailable)) { visited.add(id); return }
    if (entry.installed && !entry.enabled && !entry.error && !entry.updateAvailable && selected.has(id)) { visited.add(id); return }
    if (entry.incompatible || !entry.release) { error ??= entry.incompatible ?? `${entry.name}尚未发布`; return }
    visiting.add(id)
    for (const child of entry.release.dependencies) visit(child, true)
    visiting.delete(id)
    visited.add(id)
    bytes += entry.release.size
    if (dependency && !selected.has(id)) dependencies.push(entry)
  }
  ids.forEach(id => visit(id, false))
  return { bytes, dependencies, error }
}
