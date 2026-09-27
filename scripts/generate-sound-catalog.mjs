import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

// Input: version/sounds.json and version/zh_cn.json from the version-pinned
// InventivetalentDev/minecraft-assets repository. No audio is bundled.
const source = process.argv[2]
if (!source) throw new Error('Pass the directory containing version-pinned sounds.json and zh_cn.json')
const versions = ['1.20.1', '1.21.1']
const names = [], nameIds = new Map()
const intern = name => { if (!nameIds.has(name)) { nameIds.set(name, names.length); names.push(name) } return nameIds.get(name) }
const tables = []
for (const version of versions) {
  const definitions = JSON.parse(await readFile(path.join(source, version, 'sounds.json'), 'utf8'))
  const language = JSON.parse(await readFile(path.join(source, version, 'zh_cn.json'), 'utf8'))
  tables.push(Object.fromEntries(Object.entries(definitions).map(([id, value]) => [id, [intern(value.subtitle ?? ''), intern(language[value.subtitle] ?? ''), value.replace === true ? 1 : 0, ...value.sounds.map(raw => {
    if (typeof raw === 'string') return intern(raw)
    return [intern(raw.name), raw.volume ?? 1, raw.pitch ?? 1, raw.weight ?? 1, raw.stream ? 1 : 0, raw.type === 'event' ? 1 : 0, raw.attenuation_distance ?? 16, raw.preload ? 1 : 0]
  })]])))
}
const baseline = tables[0]
const changes = Object.fromEntries(Object.entries(tables[1]).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(baseline[id])))
const removed = Object.keys(baseline).filter(id => !Object.hasOwn(tables[1], id))
const prefixes = [], prefixIds = new Map()
const compactNames = names.map(name => {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('.')) + 1
  if (cut < 4) return name
  const prefix = name.slice(0, cut)
  if (!prefixIds.has(prefix)) { prefixIds.set(prefix, prefixes.length); prefixes.push(prefix) }
  return [prefixIds.get(prefix), name.slice(cut)]
})
const result = JSON.stringify({ versions, prefixes, names: compactNames, baseline, changes, removed }) + '\n'
const bytes = Buffer.byteLength(result)
if (bytes > 256 * 1024) throw new Error(`Sound reference exceeds the 256 KiB review threshold: ${bytes}`)
const target = path.resolve(import.meta.dirname, '../src/main/data/soundCatalog.json')
await mkdir(path.dirname(target), { recursive: true })
await writeFile(target, result)
console.log(JSON.stringify({ bytes, events: tables.map(table => Object.keys(table).length), target }))
