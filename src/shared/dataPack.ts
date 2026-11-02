export type DataPackKind = 'recipe-shaped' | 'recipe-shapeless' | 'item-tag' | 'block-tag' | 'loot-block' | 'advancement' | 'predicate' | 'function' | 'json'
export interface DataPackInfo { root: string; name: string; source: 'mod' | 'pack'; files: number; archived?: boolean }
export interface DataPackEntry { path: string; kind: DataPackKind; id: string }
export interface DataPackDocument extends DataPackEntry { content: string; baseline: string; validation: DataPackValidation }
export interface DataPackValidation { valid: boolean; errors: string[]; warnings: string[] }
export interface DataPackItem { id: string; name: string; icon?: string }
export interface DataPackForm { kind: DataPackKind; slots: string[]; result: string; count: number; values: string; replace: boolean; rolls: number }
export const DATA_PACK_KINDS: Array<{ id: DataPackKind; label: string }> = [
  { id: 'recipe-shaped', label: '有序配方' }, { id: 'recipe-shapeless', label: '无序配方' },
  { id: 'item-tag', label: '物品标签' }, { id: 'block-tag', label: '方块标签' },
  { id: 'loot-block', label: '方块掉落' }, { id: 'advancement', label: '进度' },
  { id: 'predicate', label: '条件' }, { id: 'function', label: '函数' }, { id: 'json', label: '数据 JSON' }
]
export const dataPackObject = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
export function dataPackVersion(version: string, target: string): boolean {
  const a = version.split('.').map(Number), b = target.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}
export function dataPackKind(file: string, value?: unknown): DataPackKind {
  if (file.endsWith('.mcfunction')) return 'function'
  if (/\/tags\/(?:items|item)\//.test(file)) return 'item-tag'
  if (/\/tags\/(?:blocks|block)\//.test(file)) return 'block-tag'
  if (/\/loot_tables?\//.test(file)) return 'loot-block'
  if (/\/advancements?\//.test(file)) return 'advancement'
  if (/\/predicates?\//.test(file)) return 'predicate'
  const type = dataPackObject(value).type
  if (type === 'minecraft:crafting_shaped') return 'recipe-shaped'
  if (type === 'minecraft:crafting_shapeless') return 'recipe-shapeless'
  return 'json'
}
export function dataPackPath(version: string, namespace: string, id: string, kind: DataPackKind): string {
  if (!/^[a-z0-9_.-]+$/.test(namespace) || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(id) || id.split('/').some(p => p === '.' || p === '..')) throw new Error('资源 ID 无效，请使用小写命名空间和资源路径')
  const modern = dataPackVersion(version, '1.21')
  const dirs: Record<DataPackKind, string> = { 'recipe-shaped': modern ? 'recipe' : 'recipes', 'recipe-shapeless': modern ? 'recipe' : 'recipes', 'item-tag': modern ? 'tags/item' : 'tags/items', 'block-tag': modern ? 'tags/block' : 'tags/blocks', 'loot-block': modern ? 'loot_table/blocks' : 'loot_tables/blocks', advancement: modern ? 'advancement' : 'advancements', predicate: modern ? 'predicate' : 'predicates', function: modern ? 'function' : 'functions', json: '' }
  return `data/${namespace}/${dirs[kind] ? dirs[kind] + '/' : ''}${id}.${kind === 'function' ? 'mcfunction' : 'json'}`
}
function ingredientText(value: unknown): string | null {
  if (typeof value === 'string') return value
  const entry = dataPackObject(value), keys = Object.keys(entry)
  if (keys.length === 1 && typeof entry.item === 'string') return entry.item
  if (keys.length === 1 && typeof entry.tag === 'string') return '#' + entry.tag
  return null
}
export function readDataPackForm(kind: DataPackKind, content: string): { form: DataPackForm | null; reason: string } {
  try {
    const value = dataPackObject(JSON.parse(content))
    const form: DataPackForm = { kind, slots: Array(9).fill(''), result: '', count: 1, values: '', replace: false, rolls: 1 }
    if (kind === 'recipe-shaped') {
      if (value.type !== 'minecraft:crafting_shaped' || !Array.isArray(value.pattern) || value.pattern.length > 3) throw Error()
      const keys = dataPackObject(value.key)
      if (Object.values(keys).some(v => ingredientText(v) === null)) throw Error()
      value.pattern.forEach((row: unknown, y: number) => {
        if (typeof row !== 'string' || row.length > 3) throw Error()
        Array.from(row).forEach((s, x) => { if (s !== ' ' && !keys[s]) throw Error(); form.slots[y * 3 + x] = s === ' ' ? '' : ingredientText(keys[s])! })
      })
    } else if (kind === 'recipe-shapeless') {
      if (value.type !== 'minecraft:crafting_shapeless' || !Array.isArray(value.ingredients) || value.ingredients.length > 9) throw Error()
      value.ingredients.forEach((v: unknown, i: number) => { const text = ingredientText(v); if (text === null) throw Error(); form.slots[i] = text })
    } else if (kind === 'item-tag' || kind === 'block-tag') {
      if (!Array.isArray(value.values) || value.values.some((v: unknown) => typeof v !== 'string')) throw Error()
      form.values = value.values.join('\n'); form.replace = value.replace === true
    } else if (kind === 'loot-block') {
      if (!Array.isArray(value.pools) || value.pools.length !== 1) throw Error()
      const pool = value.pools[0]
      if (!Array.isArray(pool.entries) || pool.entries.length !== 1 || pool.entries[0].type !== 'minecraft:item' || typeof pool.rolls !== 'number') throw Error()
      form.result = pool.entries[0].name; form.rolls = pool.rolls
    } else return { form: null, reason: '此类型使用源码编辑，保存时保留全部字段。' }
    if (kind.startsWith('recipe')) {
      const result = dataPackObject(value.result)
      form.result = result.id ?? result.item ?? ''; form.count = result.count ?? 1
      if (typeof form.result !== 'string' || !form.result) throw Error()
    }
    return { form, reason: '' }
  } catch { return { form: null, reason: '此文件包含图形编辑尚不支持的结构，请使用源码编辑；原始内容会完整保留。' } }
}
export function writeDataPackForm(version: string, original: string, form: DataPackForm): string {
  const value = JSON.parse(original), modern = dataPackVersion(version, '1.21.2')
  const ingredient = (id: string): unknown => modern ? id : id.startsWith('#') ? { tag: id.slice(1) } : { item: id }
  if (form.kind.startsWith('recipe')) {
    if (form.kind === 'recipe-shaped') {
      const keys: Record<string, unknown> = {}, symbols = new Map<string, string>()
      const pattern = [0, 1, 2].map(y => form.slots.slice(y * 3, y * 3 + 3).map(id => {
        if (!id) return ' '
        if (!symbols.has(id)) { const symbol = String.fromCharCode(65 + symbols.size); symbols.set(id, symbol); keys[symbol] = ingredient(id) }
        return symbols.get(id)!
      }).join(''))
      while (pattern.length && !pattern[0].trim()) pattern.shift()
      while (pattern.length && !pattern[pattern.length - 1].trim()) pattern.pop()
      while (pattern.length && pattern.every(row => row[0] === ' ')) for (let i = 0; i < pattern.length; i++) pattern[i] = pattern[i].slice(1)
      while (pattern.length && pattern.every(row => row.endsWith(' '))) for (let i = 0; i < pattern.length; i++) pattern[i] = pattern[i].slice(0, -1)
      value.pattern = pattern; value.key = keys
    } else value.ingredients = form.slots.filter(Boolean).map(ingredient)
    const result: Record<string, any> = { ...dataPackObject(value.result), count: form.count }
    delete result.id; delete result.item
    result[dataPackVersion(version, '1.20.5') ? 'id' : 'item'] = form.result
    value.result = result
  } else if (form.kind.endsWith('-tag')) { value.values = form.values.split(/[\n,]/).map(s => s.trim()).filter(Boolean); value.replace = form.replace }
  else if (form.kind === 'loot-block') {
    value.pools[0].rolls = form.rolls; value.pools[0].entries[0].name = form.result
  }
  return JSON.stringify(value, null, 2) + '\n'
}
export function newDataPackContent(version: string, kind: DataPackKind): string {
  const result = { [dataPackVersion(version, '1.20.5') ? 'id' : 'item']: 'minecraft:stone', count: 1 }
  const ingredient = dataPackVersion(version, '1.21.2') ? 'minecraft:cobblestone' : { item: 'minecraft:cobblestone' }
  const templates: Record<DataPackKind, unknown> = {
    'recipe-shaped': { type: 'minecraft:crafting_shaped', pattern: ['A'], key: { A: ingredient }, result },
    'recipe-shapeless': { type: 'minecraft:crafting_shapeless', ingredients: [ingredient], result },
    'item-tag': { replace: false, values: ['minecraft:stone'] }, 'block-tag': { replace: false, values: ['minecraft:stone'] },
    'loot-block': { type: 'minecraft:block', pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: 'minecraft:stone' }], conditions: [{ condition: 'minecraft:survives_explosion' }] }] },
    advancement: { criteria: { obtain: { trigger: 'minecraft:inventory_changed', conditions: { items: [{ items: ['minecraft:stone'] }] } } } }, predicate: { condition: 'minecraft:random_chance', chance: 0.5 }, function: '', json: {}
  }
  return kind === 'function' ? '# 在这里编写 Minecraft 命令\n' : JSON.stringify(templates[kind], null, 2) + '\n'
}
