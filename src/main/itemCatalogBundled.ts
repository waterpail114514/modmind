import type { VanillaItem } from '../shared/itemEditor'
import base from './data/vanilla-items-1.20.1.json'
import patch from './data/vanilla-items-1.21.1.patch.json'

// The bundled snapshots come from PrismarineJS minecraft-data and Mojang zh_cn assets.
const baseItems = base.items as VanillaItem[]
const removed = new Set(patch.remove)
const updates = new Map((patch.upsert as VanillaItem[]).map(item => [item.id, item]))
const updatedIds = new Set(baseItems.map(item => item.id))
const latestItems = [
  ...baseItems.filter(item => !removed.has(item.id)).map(item => updates.get(item.id) ?? item),
  ...(patch.upsert as VanillaItem[]).filter(item => !updatedIds.has(item.id))
]

export function bundledVanillaItems(version: string): VanillaItem[] | null {
  if (version === '1.20.1') return baseItems
  if (version === '1.21' || version === '1.21.1') return latestItems
  return null
}
