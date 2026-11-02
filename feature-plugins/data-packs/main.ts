import path from 'node:path'
import { dialog } from 'electron'
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'
import type { DataPackKind } from '../../src/shared/dataPack'
import { bundledVanillaItems } from '../item-editor/src/main/itemCatalogBundled'
import { captureCatalog, captureIcons } from '../mc-pull/src/main/captureCatalogService'
import { activate as createResourceSources } from '../mc-pull/main'
import * as packs from './src/main/dataPackService'

export function activate({ host }: { host: NativeFeatureHost }) {
  const resources = createResourceSources()
  const project = (input: Record<string, unknown>, context: FeaturePluginInvocationContext, write = false) => {
    const current = host.requireProject()
    for (const root of [input.projectPath, context.projectPath]) if (root && path.resolve(String(root)).toLowerCase() !== path.resolve(current.path).toLowerCase()) throw new Error('项目已经切换，请重新打开数据包')
    if (write && host.runsForProject(current.path).length) throw new Error('项目正在执行任务，请等待完成后保存')
    return current
  }
  const actions = {
    query: async (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => {
      const current = project(input, context)
      if (input.operation === 'read') return packs.readDataPackDocument(current, String(input.root), String(input.path))
      if (input.operation === 'history') return packs.dataPackHistory(current, String(input.root))
      if (input.operation === 'files') { const all = await packs.listDataPackEntries(current, String(input.root)), query = String(input.query ?? '').toLowerCase(), matches = all.filter(entry => !query || entry.path.toLowerCase().includes(query)), offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 200); return { entries: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null } }
      if (input.operation === 'validate') return packs.validateDataPack(current, String(input.root))
      return { packs: await packs.listDataPacks(current), minecraftVersion: current.minecraftVersion }
    },
    write: (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => {
      const current = project(input, context, true)
      if (input.operation === 'create-pack') return packs.createDataPack(current, String(input.name))
      if (input.operation === 'create') return packs.createDataPackEntry(current, String(input.root), input.kind as DataPackKind, String(input.namespace ?? current.namespace), String(input.id))
      if (input.operation === 'remove') return packs.removeDataPackDocument(current, String(input.root), String(input.path), String(input.baseline))
      if (input.operation === 'restore') return packs.restoreDataPackHistory(current, String(input.root), String(input.historyId), typeof input.baseline === 'string' ? input.baseline : null)
      if (input.operation === 'export') return packs.exportDataPack(current, String(input.root))
      return packs.writeDataPackDocument(current, { root: String(input.root), path: String(input.path), content: String(input.content), baseline: typeof input.baseline === 'string' ? input.baseline : null })
    },
    import: async (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => {
      const current = project(input, context, true)
      if (input.root) {
        const existing = (await packs.listDataPacks(current)).find(info => info.root === input.root && info.archived)
        if (!existing) throw new Error('只能解包当前项目中已发现的数据包 ZIP')
        return packs.importDataPack(current, path.join(current.path, existing.root))
      }
      const result = await dialog.showOpenDialog({ title: '导入数据包', properties: ['openFile'], filters: [{ name: 'Minecraft 数据包', extensions: ['zip'] }] })
      if (result.canceled || !result.filePaths[0]) return null
      project(input, context, true)
      return packs.importDataPack(current, result.filePaths[0])
    },
    catalog: async (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => {
      const current = project(input, context), base = bundledVanillaItems(current.minecraftVersion) ?? [], items = new Map(base.map(item => [`minecraft:${item.id}`, { id: `minecraft:${item.id}`, name: item.name }]))
      let warning = ''
      try { const captured = await captureCatalog(current.path); for (const item of captured.items) items.set(item.id, item); warning = captured.warning } catch (error) { warning = String(error) }
      const query = String(input.query ?? '').toLowerCase(), matches = [...items.values()].filter(item => !query || `${item.id} ${item.name}`.toLowerCase().includes(query)), offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 48)
      const page = matches.slice(offset, offset + limit)
      let icons: Record<string, string> = {}; try { icons = await captureIcons(current.path, page.map(item => item.id)) } catch { /* Selection still works with names and IDs. */ }
      return { items: page.map(item => ({ ...item, ...(icons[item.id] ? { icon: icons[item.id] } : {}) })), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null, warning: warning || (!items.size ? '此版本暂无内置目录，可输入物品 ID 或选择本地实例。' : '') }
    }
  }
  return { actions: { ...resources.actions, ...actions }, ...packs }
}
