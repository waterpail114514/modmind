import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AddonRelationship } from '../shared/production'
import type { ProjectInfo } from '../shared/types'
import { descriptorPath } from './projectTemplates'

const START = '# MODMIND ADDON RELATIONSHIPS START'
const END = '# MODMIND ADDON RELATIONSHIPS END'

function direct(relationships: AddonRelationship[]): AddonRelationship[] {
  const seen = new Set<string>()
  return relationships.filter((entry) => !entry.automatic && entry.role !== 'test').map(entry => ({ ...entry, modIds: entry.modIds.filter(id => { if (seen.has(id)) return false; seen.add(id); return true }) }))
}

function previousIds(relationships: AddonRelationship[]): Set<string> {
  return new Set(direct(relationships).flatMap((entry) => entry.modIds))
}

function exactVersion(value: string): string {
  const clean = value.trim()
  return clean && clean !== 'unknown' && /^[0-9A-Za-z.+_-]{1,120}$/.test(clean) ? clean : '*'
}

function tomlValue(value: string): string {
  return JSON.stringify(value)
}

function side(value: AddonRelationship['environment']): string {
  return value === 'client' ? 'CLIENT' : value === 'server' ? 'SERVER' : 'BOTH'
}

async function updateJsonDescriptor(target: string, project: ProjectInfo, relationships: AddonRelationship[], previous: AddonRelationship[]): Promise<void> {
  const value = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>
  const oldIds = previousIds(previous)
  if (project.loader === 'fabric') {
    const depends = value.depends && typeof value.depends === 'object' && !Array.isArray(value.depends) ? { ...value.depends as Record<string, unknown> } : {}
    const suggests = value.suggests && typeof value.suggests === 'object' && !Array.isArray(value.suggests) ? { ...value.suggests as Record<string, unknown> } : {}
    oldIds.forEach((id) => { delete depends[id]; delete suggests[id] })
    for (const relationship of direct(relationships)) {
      const targetMap = relationship.role === 'required' ? depends : suggests
      for (const id of relationship.modIds) {
        const existing = (value.depends as Record<string, unknown> | undefined)?.[id] ?? (value.suggests as Record<string, unknown> | undefined)?.[id]
        const old = previous.find(entry => entry.modIds.includes(id))
        targetMap[id] = relationship.compatibilityRange ?? (typeof existing === 'string' && existing !== exactVersion(old?.version ?? relationship.version) ? existing : exactVersion(relationship.version))
      }
    }
    value.depends = depends
    if (Object.keys(suggests).length) value.suggests = suggests
    else delete value.suggests
  } else if (project.loader === 'quilt') {
    const loader = value.quilt_loader && typeof value.quilt_loader === 'object' ? { ...value.quilt_loader as Record<string, unknown> } : null
    if (!loader) throw new Error('quilt.mod.json 缺少 quilt_loader')
    const depends = Array.isArray(loader.depends) ? [...loader.depends] : []
    loader.depends = depends.filter((entry) => {
      if (typeof entry === 'string') return !oldIds.has(entry)
      return !(entry && typeof entry === 'object' && oldIds.has(String((entry as Record<string, unknown>).id ?? '')))
    })
    for (const relationship of direct(relationships).filter((entry) => entry.role === 'required')) {
      for (const id of relationship.modIds) {
        const existing = depends.find(entry => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === id) as Record<string, unknown> | undefined
        const old = previous.find(entry => entry.modIds.includes(id))
        const saved = existing?.versions
        ;(loader.depends as unknown[]).push({ id, versions: relationship.compatibilityRange ?? (saved && saved !== exactVersion(old?.version ?? relationship.version) ? saved : exactVersion(relationship.version)) })
      }
    }
    value.quilt_loader = loader
  } else {
    const entries = Array.isArray(value) ? value : [value]
    const primary = entries.find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined
    if (!primary) throw new Error('mcmod.info 格式无效')
    const required = Array.isArray(primary.requiredMods) ? primary.requiredMods.filter((entry) => !oldIds.has(String(entry).split('@')[0])) : []
    for (const relationship of direct(relationships).filter((entry) => entry.role === 'required')) {
      for (const id of relationship.modIds) {
        const version = exactVersion(relationship.version)
        const old = previous.find(entry => entry.modIds.includes(id))
        const existing = (Array.isArray(primary.requiredMods) ? primary.requiredMods : []).find(entry => typeof entry === 'string' && entry.startsWith(`${id}@`)) as string | undefined
        const saved = existing?.slice(id.length + 1)
        const range = relationship.compatibilityRange ?? (saved && saved !== `[${exactVersion(old?.version ?? relationship.version)}]` ? saved : version === '*' ? undefined : `[${version}]`)
        required.push(range ? `${id}@${range}` : id)
      }
    }
    primary.requiredMods = required
  }
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function updateTomlDescriptor(target: string, project: ProjectInfo, relationships: AddonRelationship[], previous: AddonRelationship[]): Promise<void> {
  const source = await fs.readFile(target, 'utf8')
  const withoutManaged = source.replace(/\n?# MODMIND ADDON RELATIONSHIPS START[\s\S]*?# MODMIND ADDON RELATIONSHIPS END\n?/g, '\n')
  const modernNeo = project.loader === 'neoforge' && target.endsWith('neoforge.mods.toml')
  const existingRanges = new Map<string, string>()
  for (const block of source.split(/(?=\[\[dependencies\.)/)) {
    const owner = /^\[\[dependencies\.([^\]]+)\]\]/.exec(block)?.[1]
    if (owner !== project.namespace && owner !== '${mod_id}') continue
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(block)?.[1]
    const range = /^\s*versionRange\s*=\s*["']([^"']+)["']/m.exec(block)?.[1]
    if (id && range) existingRanges.set(id, range)
  }
  const blocks = direct(relationships).flatMap((relationship) => relationship.modIds.map((id) => {
    const required = relationship.role === 'required'
    const version = exactVersion(relationship.version)
    const existing = existingRanges.get(id)
    const old = previous.find(entry => entry.modIds.includes(id))
    const range = relationship.compatibilityRange ?? (existing && existing !== `[${exactVersion(old?.version ?? relationship.version)}]` ? existing : version === '*' ? undefined : `[${version}]`)
    return [
      `[[dependencies.${project.namespace}]]`,
      `modId=${tomlValue(id)}`,
      modernNeo ? `type=${tomlValue(required ? 'required' : 'optional')}` : `mandatory=${required}`,
      ...(range ? [`versionRange=${tomlValue(range)}`] : []),
      'ordering="AFTER"',
      `side=${tomlValue(side(relationship.environment))}`
    ].join('\n')
  }))
  const managed = blocks.length ? `${START}\n${blocks.join('\n\n')}\n${END}\n` : ''
  await fs.writeFile(target, `${withoutManaged.trimEnd()}${managed ? `\n\n${managed}` : '\n'}`, 'utf8')
}

export async function syncAddonDescriptor(project: ProjectInfo, relationships: AddonRelationship[], previous: AddonRelationship[] = []): Promise<string> {
  const relative = descriptorPath(project.loader, project.minecraftVersion)
  const target = path.join(project.path, ...relative.split('/'))
  if (relative.endsWith('.json') || relative.endsWith('mcmod.info')) await updateJsonDescriptor(target, project, relationships, previous)
  else await updateTomlDescriptor(target, project, relationships, previous)
  return relative
}
