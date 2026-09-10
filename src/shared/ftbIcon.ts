import { Byte, Short, Int, Float, parse } from 'ftbq-nbt'

export interface FtbIconDescriptor {
  id: string
  tag?: Record<string, unknown>
  components?: Record<string, unknown>
  predicates?: Record<string, number>
  tint?: number[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function plain(value: unknown): unknown {
  if (value instanceof Byte || value instanceof Short || value instanceof Int || value instanceof Float) return value.valueOf()
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]))
  return value
}

export function ftbIconDescriptor(value: unknown): FtbIconDescriptor | null {
  if (typeof value === 'string') {
    const text = value.trim()
    try {
      if (text.startsWith('{')) return ftbIconDescriptor(parse(text))
      const start = text.indexOf('{')
      if (start >= 0) return ftbIconDescriptor({ id: text.slice(0, start), tag: parse(text.slice(start)) })
    } catch { return null }
    value = { id: text }
  }
  const raw = record(plain(value))
  if (typeof (raw.id ?? raw.item) !== 'string') return null
  let id = String(raw.id ?? raw.item).trim()
  if (!id.includes(':')) id = `minecraft:${id}`
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || id.split(':')[1].split('/').some(p => !p || p === '.' || p === '..')) return null
  let tag = raw.tag
  if (typeof tag === 'string') { try { tag = plain(parse(tag)) } catch { return null } }
  return { id, ...(tag ? { tag: record(tag) } : {}), ...(raw.components ? { components: record(raw.components) } : {}), ...(raw.predicates ? { predicates: record(raw.predicates) as Record<string, number> } : {}), ...(Array.isArray(raw.tint) ? { tint: raw.tint as number[] } : {}) }
}

export function ftbIconKey(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (typeof entry === 'bigint') return `${entry}L`
    if (Array.isArray(entry)) return entry.map(stable)
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]))
    return entry
  }
  return JSON.stringify(stable(ftbIconDescriptor(value)))
}
