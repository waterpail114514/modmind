export interface SidebarEntry { id: string }
export interface SidebarGroup<T extends SidebarEntry = SidebarEntry> {
  groupKey: string
  label: string
  items: T[]
}

export interface SidebarLayout {
  version: 1
  customGroups: Array<{ groupKey: string; label: string }>
  labels: Record<string, string>
  deletedGroups: string[]
  hiddenItems: string[]
  orders: Record<string, string[]>
  groupOrder: string[]
}

export const UNGROUPED_SIDEBAR_KEY = 'ungrouped'
export const emptySidebarLayout = (): SidebarLayout => ({ version: 1, customGroups: [], labels: {}, deletedGroups: [], hiddenItems: [], orders: {}, groupOrder: [] })
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))] : []
const ordersFrom = (value: unknown): Record<string, string[]> => record(value) ? Object.fromEntries(Object.entries(value).map(([key, ids]) => [key, strings(ids)])) : {}

export function parseSidebarLayout(value: unknown): SidebarLayout {
  if (!record(value) || value.version !== 1) throw new Error('无法读取侧边栏布局')
  const seen = new Set<string>()
  const customGroups: SidebarLayout['customGroups'] = []
  for (const group of Array.isArray(value.customGroups) ? value.customGroups : []) {
    if (!record(group) || typeof group.groupKey !== 'string' || !/^custom-[a-z0-9-]+$/.test(group.groupKey) || seen.has(group.groupKey)) continue
    if (typeof group.label !== 'string' || !group.label.trim()) continue
    seen.add(group.groupKey)
    customGroups.push({ groupKey: group.groupKey, label: group.label.trim().slice(0, 24) })
  }
  return {
    version: 1, customGroups,
    labels: record(value.labels) ? Object.fromEntries(Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim())).map(([key, label]) => [key, label.trim().slice(0, 24)])) : {},
    deletedGroups: strings(value.deletedGroups).filter(key => key !== UNGROUPED_SIDEBAR_KEY),
    hiddenItems: strings(value.hiddenItems), orders: ordersFrom(value.orders), groupOrder: strings(value.groupOrder)
  }
}

export function migrateSidebarLayout(orders: unknown, groupOrder: unknown): SidebarLayout {
  return { ...emptySidebarLayout(), orders: ordersFrom(orders), groupOrder: strings(groupOrder) }
}

/** Keep unavailable plugin/feature preferences intact; each available entry appears exactly once. */
export function resolveSidebarGroups<T extends SidebarEntry>(defaults: SidebarGroup<T>[], layout: SidebarLayout): SidebarGroup<T>[] {
  const entries = new Map(defaults.flatMap(group => group.items.map(item => [item.id, item] as const)))
  const groups: SidebarGroup<T>[] = [
    ...defaults.map(group => ({ ...group, items: [] as T[] })),
    ...layout.customGroups.map(group => ({ ...group, items: [] as T[] }))
  ].filter(group => !layout.deletedGroups.includes(group.groupKey))
  groups.push({ groupKey: UNGROUPED_SIDEBAR_KEY, label: '未分类', items: [] })
  const assigned = new Set<string>()
  for (const group of groups) {
    group.label = layout.labels[group.groupKey] ?? group.label
    for (const id of layout.orders[group.groupKey] ?? []) {
      const entry = entries.get(id)
      if (entry && !assigned.has(id)) { group.items.push(entry); assigned.add(id) }
    }
  }
  const ungrouped = groups[groups.length - 1]
  for (const base of defaults) {
    const target = groups.find(group => group.groupKey === base.groupKey) ?? ungrouped
    for (const item of base.items) {
      if (!assigned.has(item.id)) { target.items.push(item); assigned.add(item.id) }
    }
  }
  return groups.filter(group => group !== ungrouped || group.items.length > 0).sort((a, b) => {
    const index = (key: string): number => { const found = layout.groupOrder.indexOf(key); return found < 0 ? Number.MAX_SAFE_INTEGER : found }
    return index(a.groupKey) - index(b.groupKey)
  })
}

export function moveSidebarEntry(layout: SidebarLayout, groups: SidebarGroup[], id: string, targetKey: string, targetId: string | null = null, after = false): SidebarLayout {
  const source = groups.find(group => group.items.some(item => item.id === id))
  const target = groups.find(group => group.groupKey === targetKey)
  if (!source || !target || targetId === id) return layout
  // Preserve temporarily unavailable entries when saving a reorder.
  const ids = (group: SidebarGroup): string[] => [...new Set([...(layout.orders[group.groupKey] ?? []), ...group.items.map(item => item.id)])].filter(item => item !== id)
  const targetIds = ids(target)
  const index = targetId === null ? targetIds.length : targetIds.indexOf(targetId)
  if (index < 0) return layout
  targetIds.splice(index + (targetId !== null && after ? 1 : 0), 0, id)
  const orders = Object.fromEntries(Object.entries(layout.orders).map(([key, values]) => [key, values.filter(value => value !== id)]))
  orders[source.groupKey] = ids(source)
  orders[targetKey] = targetIds
  return { ...layout, orders }
}

export function moveSidebarCategory(layout: SidebarLayout, groups: SidebarGroup[], id: string, targetId: string, after = false): SidebarLayout {
  if (id === targetId || !groups.some(group => group.groupKey === id) || !groups.some(group => group.groupKey === targetId)) return layout
  const order = [...new Set([...groups.map(group => group.groupKey), ...layout.groupOrder])].filter(key => key !== id)
  order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id)
  return { ...layout, groupOrder: order }
}

export function deleteSidebarCategory(layout: SidebarLayout, groups: SidebarGroup[], key: string): SidebarLayout {
  if (key === UNGROUPED_SIDEBAR_KEY) return layout
  const group = groups.find(entry => entry.groupKey === key)
  if (!group) return layout
  const orders = { ...layout.orders }
  orders[UNGROUPED_SIDEBAR_KEY] = [...new Set([...(orders[UNGROUPED_SIDEBAR_KEY] ?? []), ...group.items.map(item => item.id), ...(orders[key] ?? [])])]
  delete orders[key]
  const labels = { ...layout.labels }
  delete labels[key]
  return {
    ...layout, orders, labels,
    customGroups: layout.customGroups.filter(entry => entry.groupKey !== key),
    deletedGroups: [...new Set([...layout.deletedGroups, key])],
    groupOrder: layout.groupOrder.filter(entry => entry !== key)
  }
}
