import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { ModConfigIdentity } from '../shared/contentFileFilters'
import { readModpackManifest } from './modpackService'
import { modpackModsRoot, modpackOverridesRoot } from './modpackPaths'
import type { ModpackContentFeatures } from '../shared/modpackContentFeatures'
import { readModJarIdentities } from './jarInspection'

const cache = new Map<string, Promise<ModConfigIdentity[]>>()

/** Only inspect the directories used by these content tools; no second whole-project scan. */
export async function modpackContentFeatures(project: ProjectInfo): Promise<ModpackContentFeatures> {
  const [manifest, mods] = await Promise.all([readModpackManifest(project), modpackConfigIdentities(project)])
  const ids = new Set(mods.map(mod => mod.id.toLowerCase()))
  const result = { ftbQuests: ids.has('ftbquests'), patchouli: ids.has('patchouli') }
  const isDirectory = async (file: string): Promise<boolean> => {
    try { return (await fs.lstat(file)).isDirectory() }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error }
  }
  for (const root of new Set([modpackOverridesRoot(project, manifest), project.path])) {
    result.ftbQuests ||= await isDirectory(path.join(root, 'config', 'ftbquests', 'quests'))
    result.patchouli ||= await isDirectory(path.join(root, 'patchouli_books'))
    if (!result.patchouli) for (const kind of ['data', 'assets']) {
      const parent = path.join(root, 'kubejs', kind)
      if (!await isDirectory(parent)) continue
      const namespaces = await fs.readdir(parent, { withFileTypes: true })
      for (const namespace of namespaces.filter(entry => entry.isDirectory())) {
        result.patchouli ||= await isDirectory(path.join(parent, namespace.name, 'patchouli_books'))
        if (result.patchouli) break
      }
    }
  }
  return result
}

export async function modpackConfigIdentities(project: ProjectInfo): Promise<ModConfigIdentity[]> {
  const manifest = await readModpackManifest(project)
  const root = modpackModsRoot(project, manifest)
  const entries = (await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
  const result: ModConfigIdentity[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]
      const file = path.join(root, entry.name)
      try {
        const stat = await fs.stat(file)
        const key = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        let request = cache.get(key)
        if (!request) {
          request = readModJarIdentities(file).catch(() => { cache.delete(key); return [] })
          cache.set(key, request)
          while (cache.size > 512) cache.delete(cache.keys().next().value!)
        }
        result.push(...await request)
      } catch { /* A removed or unreadable JAR must not block configuration browsing. */ }
    }
  }))
  for (const module of manifest.modules) result.push({ id: module.namespace, name: module.name })
  return [...new Map(result.map(mod => [mod.id, mod])).values()].sort((a, b) => a.name.localeCompare(b.name))
}
