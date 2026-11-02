import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DataPackItem } from '../../../../src/shared/dataPack'
import { assertContentTarget } from '../../../../src/main/contentInstallTransaction'

type Captured = { root: string; key: string; items: DataPackItem[]; iconNames: Map<string, string>; warning: string }
const catalogs = new Map<string, { fingerprint: string; at: number; value: Promise<Captured> }>()
async function captureData(projectPath: string): Promise<Captured | null> {
  const active = path.join(projectPath, '.modmind/mc-capture/active.txt'); await assertContentTarget(projectPath, active)
  const key = await fs.readFile(active, 'utf8').then(s => s.trim()).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  if (!key) return null
  if (!/^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff-]{0,127}$/.test(key) || key.includes('..')) throw new Error('当前资源来源无效，请重新选择实例')
  const root = path.join(projectPath, '.modmind/mc-capture/packs', key), file = path.join(root, 'items.json'); await assertContentTarget(projectPath, file)
  const stat = await fs.stat(file); if (stat.size > 32 * 1024 * 1024) throw new Error('采集目录过大，请重新采集')
  const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, cached = catalogs.get(file)
  if (cached?.fingerprint === fingerprint && Date.now() - cached.at < 30000) return cached.value
  const task = (async () => {
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(data.ids) || !Array.isArray(data.names) || data.ids.length > 100000) throw new Error('采集目录损坏，请刷新资源来源')
    const items: DataPackItem[] = [], iconNames = new Map<string, string>()
    data.ids.forEach((id: unknown, index: number) => {
      if (typeof id !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) return
      items.push({ id, name: typeof data.names[index] === 'string' ? data.names[index] : id })
      const icon = data.icons?.[index]; if (typeof icon === 'string' && /^[A-Za-z0-9_.-]+\.png$/.test(icon)) iconNames.set(id, icon)
    })
    return { root, key, items, iconNames, warning: data.attrProvenance === 'unknown' ? '本地静态资源不包含完整运行时属性。' : '' }
  })()
  const entry = { fingerprint, at: Date.now(), value: task }; catalogs.delete(file); catalogs.set(file, entry)
  while (catalogs.size > 4) catalogs.delete(catalogs.keys().next().value!)
  task.catch(() => { if (catalogs.get(file) === entry) catalogs.delete(file) })
  return task
}

export async function captureSources(projectPath: string) {
  const root = path.join(projectPath, '.modmind/mc-capture'), active = path.join(root, 'active.txt'), directory = path.join(root, 'packs')
  await assertContentTarget(projectPath, active); await assertContentTarget(projectPath, directory)
  const activeKey = await fs.readFile(active, 'utf8').then(s => s.trim()).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  const packs: Array<{ key: string; title: string; count: number | null; instanceDir: string; capturedAt: string }> = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })) {
    if (!entry.isDirectory()) continue
    const metadata = path.join(directory, entry.name, 'meta.json'); await assertContentTarget(projectPath, metadata)
    try { const value = JSON.parse(await fs.readFile(metadata, 'utf8')); packs.push({ key: entry.name, title: String(value.title ?? entry.name), count: Number.isInteger(value.count) ? value.count : null, instanceDir: String(value.instanceDir ?? ''), capturedAt: String(value.capturedAt ?? '') }) } catch { packs.push({ key: entry.name, title: entry.name, count: null, instanceDir: '', capturedAt: '' }) }
  }
  return { activeKey, packs }
}

/** Shared read model: selecting an instance in any workspace updates this project source. */
export async function captureCatalog(projectPath: string): Promise<{ items: DataPackItem[]; key: string | null; warning: string }> {
  const data = await captureData(projectPath)
  return data ? { key: data.key, items: data.items, warning: data.warning } : { items: [], key: null, warning: '' }
}

export async function captureIcons(projectPath: string, ids: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  if (!ids.length) return result
  const data = await captureData(projectPath)
  if (!data) return result
  let bytes = 0
  for (const id of new Set(ids.slice(0, 64))) {
    const icon = data.iconNames.get(id); if (!icon) continue
    const image = path.join(data.root, 'icons', icon); await assertContentTarget(projectPath, image)
    try { if ((await fs.stat(image)).size > 128 * 1024) continue; const content = await fs.readFile(image); bytes += content.length; if (bytes > 2 * 1024 * 1024) break; result[id] = `data:image/png;base64,${content.toString('base64')}` } catch { /* Missing images leave the ID selectable. */ }
  }
  return result
}
