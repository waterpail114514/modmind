import type { ModpackContentInventory } from '../../shared/types'

const MAX_CACHED_PROJECTS = 4
const cache = new Map<string, ModpackContentInventory>()
const pending = new Map<string, Promise<ModpackContentInventory>>()

function remember(projectPath: string, inventory: ModpackContentInventory): ModpackContentInventory {
  cache.delete(projectPath)
  cache.set(projectPath, inventory)
  while (cache.size > MAX_CACHED_PROJECTS) cache.delete(cache.keys().next().value!)
  return inventory
}

export function cachedModpackContent(projectPath: string): ModpackContentInventory | undefined {
  const inventory = cache.get(projectPath)
  if (!inventory) return undefined
  return remember(projectPath, inventory)
}

export async function loadModpackContent(projectPath: string, refresh = false): Promise<ModpackContentInventory> {
  const cached = cachedModpackContent(projectPath)
  if (cached && !refresh) return cached

  const existing = pending.get(projectPath)
  if (existing) return existing

  const request = window.modmind.modpack.listContent(refresh).then((inventory) => {
    remember(projectPath, inventory)
    if (refresh) window.dispatchEvent(new Event('modmind:content-changed'))
    return inventory
  })
  pending.set(projectPath, request)
  try {
    return await request
  } finally {
    if (pending.get(projectPath) === request) pending.delete(projectPath)
  }
}
