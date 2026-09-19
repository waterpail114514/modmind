import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { ProjectInfo } from '../shared/types'
import { inspectNeteaseEntrypoints } from './neteaseEntrypoints'

const PACK_DIRECTORIES = ['behavior_pack', 'resource_pack'] as const

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  }
  return (value ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  }
}

export function createStoredZip(entries: Array<{ name: string; data: Buffer }>, compress = false): Buffer {
  if (entries.length > 0xffff) throw new Error('ZIP 条目数超过传统 ZIP 格式上限；请拆分导出')
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const timestamp = dosDateTime()
  for (const entry of entries) {
    const directory = entry.name.endsWith('/')
    const payload = compress && !directory ? deflateRawSync(entry.data, { level: 6 }) : entry.data
    const method = compress && !directory ? 8 : 0
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8')
    if (!name.length || name.length > 0xffff) throw new Error(`ZIP 文件名无效或过长：${entry.name}`)
    if (entry.data.length > 0xffffffff || offset > 0xffffffff - (30 + name.length + entry.data.length)) {
      throw new Error('ZIP 内容超过传统 ZIP 格式上限；请拆分导出')
    }
    const checksum = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(timestamp.time, 10)
    local.writeUInt16LE(timestamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(timestamp.time, 12)
    central.writeUInt16LE(timestamp.date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    if (directory) central.writeUInt32LE(0x10, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  if (centralSize > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP 目录超过传统 ZIP 格式上限；请拆分导出')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

async function packEntries(root: string, delivery = false): Promise<Array<{ name: string; data: Buffer }>> {
  const entries: Array<{ name: string; data: Buffer }> = []
  const visit = async (directory: string, relative = ''): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true })
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.isSymbolicLink()) continue
      if (delivery && (['__pycache__', '.git', '.modmind', '.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(child.name) || /\.(?:pyc|pyo|tmp|swp)$/i.test(child.name))) continue
      const childRelative = path.posix.join(relative, child.name)
      const absolute = path.join(directory, child.name)
      if (child.isDirectory()) {
        if (delivery) entries.push({ name: `${childRelative}/`, data: Buffer.alloc(0) })
        await visit(absolute, childRelative)
      }
      else if (child.isFile()) entries.push({ name: childRelative, data: await fs.readFile(absolute) })
    }
  }
  await visit(root)
  return entries
}

interface BedrockManifest {
  format_version?: unknown
  header?: { name?: unknown; uuid?: unknown; version?: unknown; min_engine_version?: unknown }
  modules?: Array<{ type?: unknown; uuid?: unknown; entry?: unknown }>
  dependencies?: Array<{ uuid?: unknown }>
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function inspectBedrockAddon(project: ProjectInfo): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = []
  const manifests = new Map<string, BedrockManifest>()
  for (const directory of PACK_DIRECTORIES) {
    const manifestPath = path.join(project.path, directory, 'manifest.json')
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BedrockManifest
      if (manifest.format_version !== 2) throw new Error('format_version must be 2')
      if (!validUuid(manifest.header?.uuid)) throw new Error('header UUID is missing or invalid')
      if (!Array.isArray(manifest.header?.version) || manifest.header.version.length !== 3) throw new Error('header version must contain three numbers')
      if (!manifest.modules?.length || manifest.modules.some((module) => !validUuid(module.uuid))) throw new Error('module UUID is missing or invalid')
      manifests.set(directory, manifest)
      logs.push(`PASS  ${directory}/manifest.json`)
    } catch (error) {
      logs.push(`FAIL  ${directory}/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const behavior = manifests.get('behavior_pack')
  const resource = manifests.get('resource_pack')
  if (behavior && resource) {
    const resourceUuid = resource.header?.uuid
    const linked = behavior.dependencies?.some((dependency) => dependency.uuid === resourceUuid)
    logs.push(`${linked ? 'PASS' : 'FAIL'}  behavior pack links the resource pack UUID`)
    const uuids = [behavior.header?.uuid, resource.header?.uuid, ...behavior.modules!.map((module) => module.uuid), ...resource.modules!.map((module) => module.uuid)]
    logs.push(`${new Set(uuids).size === uuids.length ? 'PASS' : 'FAIL'}  pack and module UUIDs are unique`)
  }
  const scriptEntry = behavior?.modules?.find((module) => module.type === 'script')?.entry
  if (typeof scriptEntry === 'string') {
    const present = await fs.access(path.join(project.path, 'behavior_pack', ...scriptEntry.split('/'))).then(() => true).catch(() => false)
    logs.push(`${present ? 'PASS' : 'FAIL'}  behavior_pack/${scriptEntry}`)
  }
  return { success: !logs.some((line) => line.startsWith('FAIL')), logs }
}

export async function buildBedrockAddon(project: ProjectInfo): Promise<string> {
  if (project.loader !== 'bedrock') throw new Error('Only Bedrock projects can be packaged as .mcaddon')
  const inspection = await inspectBedrockAddon(project)
  if (!inspection.success) throw new Error(`Bedrock Add-On validation failed:\n${inspection.logs.join('\n')}`)
  const output = path.join(project.path, 'build')
  await fs.mkdir(output, { recursive: true })
  const packs: Array<{ name: string; data: Buffer }> = []
  for (const directory of PACK_DIRECTORIES) {
    const data = createStoredZip(await packEntries(path.join(project.path, directory)))
    const kind = directory === 'behavior_pack' ? 'behavior' : 'resources'
    const fileName = `${project.namespace}-${kind}.mcpack`
    await fs.writeFile(path.join(output, fileName), data)
    packs.push({ name: fileName, data })
  }
  const addonPath = path.join(output, `${project.namespace}.mcaddon`)
  await fs.writeFile(addonPath, createStoredZip(packs))
  return addonPath
}

export async function inspectNeteaseProject(project: ProjectInfo): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = []
  const required = [
    'netease.project.json',
    'behavior_pack/manifest.json',
    'resource_pack/manifest.json'
  ]
  for (const relative of required) {
    const present = await fs.access(path.join(project.path, ...relative.split('/'))).then(() => true).catch(() => false)
    logs.push(`${present ? 'PASS' : 'FAIL'}  ${relative}`)
  }
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(project.path, 'netease.project.json'), 'utf8')) as { target?: unknown; modSdkVersion?: unknown }
    const expectedTarget = project.loader === 'netease-mobile' ? 'mobile' : 'pc'
    if (metadata.target !== expectedTarget) throw new Error(`target must be ${expectedTarget}`)
    if (metadata.modSdkVersion !== project.minecraftVersion) throw new Error('Mod SDK version does not match the project')
    logs.push('PASS  NetEase target metadata')
  } catch (error) {
    logs.push(`FAIL  netease.project.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  logs.push(...(await inspectBedrockAddon(project)).logs)
  logs.push(...await inspectNeteaseEntrypoints(path.join(project.path, 'behavior_pack')))
  logs.push('INFO  本地结构检查不代表 MCStudio 导入、游戏运行或线上审核通过')
  return { success: !logs.some((line) => line.startsWith('FAIL')), logs }
}

export async function buildNeteaseArchive(project: ProjectInfo): Promise<string> {
  if (project.loader !== 'netease-pc' && project.loader !== 'netease-mobile') throw new Error('Only NetEase projects can be packaged as workbench archives')
  const inspection = await inspectNeteaseProject(project)
  if (!inspection.success) throw new Error(`NetEase project validation failed:\n${inspection.logs.join('\n')}`)
  const entries: Array<{ name: string; data: Buffer }> = []
  for (const directory of PACK_DIRECTORIES) {
    entries.push({ name: `${directory}/`, data: Buffer.alloc(0) })
    for (const entry of await packEntries(path.join(project.path, directory), true)) entries.push({ ...entry, name: `${directory}/${entry.name}` })
  }
  const output = path.join(project.path, 'build')
  await fs.mkdir(output, { recursive: true })
  const target = path.join(output, `${project.namespace}-netease-${project.loader === 'netease-mobile' ? 'mobile' : 'pc'}.zip`)
  await fs.writeFile(target, createStoredZip(entries, true))
  return target
}
