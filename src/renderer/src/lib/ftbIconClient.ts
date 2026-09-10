import { ftbIconKey } from '../../../shared/ftbIcon'
import type { FtbQuestIconInspection } from '../../../shared/types'

const cache = new Map<string, { expires: number; request: Promise<FtbQuestIconInspection> }>()
let active = 0
const queue: Array<() => void> = []
export function clearFtbIconClient(): void { cache.clear() }
export function requestFtbIcon(projectPath: string, scope: string, descriptor: unknown): Promise<FtbQuestIconInspection> {
  const key = `${scope}\u0000${ftbIconKey(descriptor)}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.request
  const entry = { expires: Infinity, request: Promise.resolve(null as unknown as FtbQuestIconInspection) }
  entry.request = new Promise<FtbQuestIconInspection>((resolve, reject) => {
    const run = (): void => {
      active++
      const load = async (): Promise<FtbQuestIconInspection> => {
        const local = await window.modmind.modpack.inspectFtbQuestIcon(descriptor, projectPath)
        const result = local.icon || !local.reason.includes('unavailable: assets/minecraft/') ? local : await window.modmind.modpack.inspectFtbQuestIcon(descriptor, projectPath, true)
        if (result.icon?.modelPreview) {
          const { renderFtbModel } = await import('./ftbModelPreview')
          try { return { ...result, icon: { ...result.icon, url: await renderFtbModel(result.icon.modelPreview) } } }
          catch (error) { return { ...result, icon: null, reason: `Model preview failed: ${String(error)}` } }
        }
        return result
      }
      load().then(result => { entry.expires = result.icon ? Infinity : Date.now() + (result.reason.includes('network failure') ? 10_000 : 60_000); resolve(result) }, error => { entry.expires = 0; reject(error) }).finally(() => { active--; queue.shift()?.() })
    }
    if (active < 6) run(); else queue.push(run)
  })
  cache.set(key, entry)
  while (cache.size > 512) cache.delete(cache.keys().next().value!)
  return entry.request
}
