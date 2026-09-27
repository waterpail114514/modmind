import fs from 'node:fs/promises'
import path from 'node:path'
import type { VanillaItem, VanillaItemKind } from '../shared/itemEditor'
import { fetchTextWithRetry } from './networkRequest'
import { bundledVanillaItems } from './itemCatalogBundled'

const catalogs = new Map<string, Promise<VanillaItem[]>>()
const itemName = /^[a-z0-9_]+$/

async function catalogJson(url: string): Promise<unknown> {
  return JSON.parse(await fetchTextWithRetry(url, { attempts: 2, timeoutMs: 12000 })) as unknown
}

function kindOf(id: string, blocks: Set<string>): VanillaItemKind {
  if (blocks.has(id)) return 'block'
  for (const kind of ['sword', 'pickaxe', 'axe', 'shovel', 'hoe'] as const) {
    if (id.endsWith(`_${kind}`)) return kind
  }
  return /_(helmet|chestplate|leggings|boots)$/.test(id) ? 'armor' : 'item'
}

export async function listVanillaItems(version: string, getJson: (url: string) => Promise<unknown> = catalogJson, cacheDirectory?: string): Promise<VanillaItem[]> {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('当前 Minecraft 版本没有可用的原版物品目录')
  const bundled = bundledVanillaItems(version)
  if (bundled) return bundled
  const cached = catalogs.get(version)
  if (cached) return cached
  const task = (async () => {
    const cacheFile = cacheDirectory ? path.join(cacheDirectory, 'item-catalog', `${version}.json`) : null
    if (cacheFile) {
      const saved = await fs.readFile(cacheFile, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null)
      if (Array.isArray(saved) && saved.length > 0 && saved.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.englishName === 'string' && typeof item.stackSize === 'number')) return saved as VanillaItem[]
    }
    const dataRoot = 'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data'
    const paths = await getJson(`${dataRoot}/dataPaths.json`).catch(() => null)
    const pc = paths && typeof paths === 'object' && !Array.isArray(paths) ? (paths as Record<string, unknown>).pc : null
    const versionPaths = pc && typeof pc === 'object' && !Array.isArray(pc) ? (pc as Record<string, unknown>)[version] : null
    const mapped = versionPaths && typeof versionPaths === 'object' && !Array.isArray(versionPaths) ? (versionPaths as Record<string, unknown>).items : null
    const mappedBlocks = versionPaths && typeof versionPaths === 'object' && !Array.isArray(versionPaths) ? (versionPaths as Record<string, unknown>).blocks : null
    if (paths && (typeof mapped !== 'string' || !/^pc\/\d+\.\d+(?:\.\d+)?$/.test(mapped))) throw new Error('此 Minecraft 版本暂无原版物品目录')
    const itemsUrl = `${dataRoot}/${mapped ?? `pc/${version}`}/items.json`
    const blocksUrl = typeof mappedBlocks === 'string' && /^pc\/\d+\.\d+(?:\.\d+)?$/.test(mappedBlocks) ? `${dataRoot}/${mappedBlocks}/blocks.json` : ''
    const languageUrl = `https://cdn.jsdelivr.net/gh/misode/mcmeta@${version}-assets/assets/minecraft/lang/zh_cn.json`
    const [rawItems, rawLanguage, rawBlocks] = await Promise.all([
      getJson(itemsUrl).catch(error => { throw new Error(/HTTP 404/.test(String(error)) ? '此 Minecraft 版本暂无原版物品目录' : '原版物品加载失败，请检查网络后重试', { cause: error }) }),
      getJson(languageUrl).catch(() => ({})),
      blocksUrl ? getJson(blocksUrl).catch(() => []) : Promise.resolve([])
    ])
    if (!Array.isArray(rawItems)) throw new Error('原版物品目录无法读取')
    const language = rawLanguage && typeof rawLanguage === 'object' && !Array.isArray(rawLanguage) ? rawLanguage as Record<string, unknown> : {}
    const blocks = new Set(Array.isArray(rawBlocks) ? rawBlocks.map(value => value && typeof value === 'object' ? (value as Record<string, unknown>).name : null).filter((name): name is string => typeof name === 'string') : [])
    const items: VanillaItem[] = []
    for (const value of rawItems) {
      if (!value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      if (typeof row.name !== 'string' || !itemName.test(row.name) || row.name === 'air'
        || typeof row.displayName !== 'string' || !Number.isInteger(row.stackSize)) continue
      const translated = language[`item.minecraft.${row.name}`] ?? language[`block.minecraft.${row.name}`]
      items.push({
        id: row.name,
        name: typeof translated === 'string' ? translated : row.displayName,
        englishName: row.displayName,
        kind: kindOf(row.name, blocks),
        stackSize: row.stackSize as number,
        ...(Number.isInteger(row.maxDurability) && (row.maxDurability as number) > 0 ? { maxDurability: row.maxDurability as number } : {})
      })
    }
    if (!items.length) throw new Error('原版物品目录为空')
    if (cacheFile) await fs.mkdir(path.dirname(cacheFile), { recursive: true }).then(() => fs.writeFile(cacheFile, JSON.stringify(items), 'utf8')).catch(() => undefined)
    return items
  })().catch(error => { catalogs.delete(version); throw error })
  catalogs.set(version, task)
  return task
}
