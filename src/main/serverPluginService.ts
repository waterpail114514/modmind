import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import type { ProjectInfo } from '../shared/types'
import type { PluginDescriptor, ServerPluginDependency } from '../shared/serverPlugin'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import { fetchJsonWithRetry } from './networkRequest'
import { verifiedDownload } from './downloadService'
import type { PluginDownloadVersion } from '../shared/serverPlugin'

async function pluginHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const descriptors = ['paper-plugin.yml', 'plugin.yml', 'velocity-plugin.json']
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export function parsePluginDescriptor(text: string, file: string): PluginDescriptor {
  const raw = record(file.endsWith('.json') ? JSON.parse(text) : parse(text, { maxAliasCount: 50 }))
  const name = file === 'velocity-plugin.json' ? raw.id : raw.name
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || typeof raw.main !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(raw.main) || typeof raw.version !== 'string') throw new Error(`${file} 缺少有效名称、版本或入口类`)
  const dependencies: PluginDescriptor['dependencies'] = [
    ...strings(raw.depend).map(name => ({ name, optional: false })),
    ...strings(raw.softdepend).map(name => ({ name, optional: true }))
  ]
  if (file === 'paper-plugin.yml') for (const section of ['bootstrap', 'server']) {
    for (const [name, value] of Object.entries(record(record(raw.dependencies)[section]))) dependencies.push({ name, optional: record(value).required === false })
  }
  if (file === 'velocity-plugin.json' && Array.isArray(raw.dependencies)) for (const value of raw.dependencies) {
    const dependency = record(value)
    if (typeof dependency.id === 'string') dependencies.push({ name: dependency.id, optional: dependency.optional === true })
  }
  return { name, version: raw.version, main: raw.main, platform: file === 'velocity-plugin.json' ? 'velocity' : file === 'paper-plugin.yml' ? 'paper' : 'spigot', apiVersion: typeof raw['api-version'] === 'string' || typeof raw['api-version'] === 'number' ? String(raw['api-version']) : undefined, dependencies, commands: Object.keys(record(raw.commands)), permissions: Object.keys(record(raw.permissions)), foliaSupported: raw['folia-supported'] === true, file }
}

export async function inspectPluginJar(file: string): Promise<PluginDescriptor> {
  const entries = await archiveEntries(file)
  const descriptor = descriptors.find(name => entries.includes(name))
  if (!descriptor) throw new Error('JAR 不包含 Bukkit/Paper/Velocity 插件描述文件')
  const parsed = parsePluginDescriptor((await archiveRead(file, descriptor)).toString('utf8'), descriptor)
  if (!entries.includes(`${parsed.main.replaceAll('.', '/')}.class`)) throw new Error(`插件入口类不存在：${parsed.main}`)
  return parsed
}

export async function inspectPluginProject(project: ProjectInfo): Promise<PluginDescriptor | null> {
  for (const file of descriptors) {
    const target = path.join(project.path, 'src/main/resources', file)
    const text = await fs.readFile(target, 'utf8').catch(() => null)
    if (text !== null) return parsePluginDescriptor(text, file)
  }
  const artifact = await findPluginArtifact(project).catch(() => null)
  return artifact ? inspectPluginJar(artifact.path) : null
}

export async function findPluginArtifact(project: ProjectInfo): Promise<{ name: string; path: string; size: number; modifiedAt: string; projectArtifact: true }> {
  const candidates: Array<{ name: string; path: string; size: number; modifiedAt: string; projectArtifact: true }> = []
  for (const relative of ['build/libs', 'target']) {
    const directory = path.join(project.path, relative)
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jar') || /(?:-sources|-javadoc|-dev|-plain|^original-)(?:\.|-)/i.test(entry.name)) continue
      const file = path.join(directory, entry.name)
      const descriptor = await inspectPluginJar(file).catch(() => null)
      if (!descriptor) continue
      if (project.loader === 'velocity' ? descriptor.platform !== 'velocity' : descriptor.platform === 'velocity') continue
      const stat = await fs.stat(file)
      candidates.push({ name: entry.name, path: file, size: stat.size, modifiedAt: stat.mtime.toISOString(), projectArtifact: true })
    }
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? '找到多个插件主 JAR，请清理旧产物后重新构建' : '未找到包含有效入口与描述文件的插件主 JAR，请先构建')
  return candidates[0]
}

export async function listPluginDependencies(project: ProjectInfo): Promise<ServerPluginDependency[]> {
  const root = path.join(project.path, 'server-plugins')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const result: ServerPluginDependency[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jar')) continue
    const target = path.join(root, entry.name)
    result.push({ fileName: entry.name, sha256: await pluginHash(target), descriptor: await inspectPluginJar(target) })
  }
  return result
}

export async function importPluginDependencies(project: ProjectInfo, files: string[]): Promise<ServerPluginDependency[]> {
  const inspected = await Promise.all(files.map(async file => ({ file, descriptor: await inspectPluginJar(file) })))
  const existing = await listPluginDependencies(project)
  const ids = new Set(existing.map(item => item.descriptor.name.toLowerCase()))
  for (const item of inspected) {
    if (ids.has(item.descriptor.name.toLowerCase())) throw new Error(`插件已存在：${item.descriptor.name}，请先移除旧依赖`)
    if (project.loader === 'velocity' ? item.descriptor.platform !== 'velocity' : item.descriptor.platform === 'velocity') throw new Error(`插件目标不匹配：${item.descriptor.name}`)
    ids.add(item.descriptor.name.toLowerCase())
  }
  const root = path.join(project.path, 'server-plugins')
  await fs.mkdir(root, { recursive: true })
  const copied: string[] = []
  try {
    for (const item of inspected) {
      const target = path.join(root, path.basename(item.file))
      await fs.copyFile(item.file, target, fs.constants.COPYFILE_EXCL)
      copied.push(target)
    }
  } catch (error) { await Promise.all(copied.map(file => fs.rm(file, { force: true }))); throw error }
  return listPluginDependencies(project)
}

export async function searchPluginDependencies(project: ProjectInfo, query: string): Promise<Array<{ id: string; name: string; description: string }>> {
  const facets = [[`categories:${project.loader}`], ...(project.loader === 'velocity' ? [] : [[`versions:${project.minecraftVersion}`]])]
  const value = await fetchJsonWithRetry<{ hits: Array<{ project_id: string; title: string; description: string }> }>(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query.slice(0,100))}&limit=20&facets=${encodeURIComponent(JSON.stringify(facets))}`)
  return value.hits.map(item => ({ id: item.project_id, name: item.title, description: item.description }))
}

export async function pluginDependencyVersions(project: ProjectInfo, id: string): Promise<PluginDownloadVersion[]> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('插件项目标识无效')
  const query = new URLSearchParams({ loaders: JSON.stringify([project.loader]), ...(project.loader === 'velocity' ? {} : { game_versions: JSON.stringify([project.minecraftVersion]) }) })
  const values = await fetchJsonWithRetry<Array<{ id: string; name: string; version_number: string; files: PluginDownloadVersion['files'] }>>(`https://api.modrinth.com/v2/project/${id}/version?${query}`)
  return values.map(value => ({ id: value.id, name: value.name, version: value.version_number, files: value.files }))
}

export async function downloadPluginDependency(project: ProjectInfo, versionId: string): Promise<ServerPluginDependency[]> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(versionId)) throw new Error('插件版本标识无效')
  const version = await fetchJsonWithRetry<{ loaders: string[]; game_versions: string[]; files: Array<PluginDownloadVersion['files'][number] & { primary?: boolean }> }>(`https://api.modrinth.com/v2/version/${versionId}`)
  if (!version.loaders.includes(project.loader) || (project.loader !== 'velocity' && !version.game_versions.includes(project.minecraftVersion))) throw new Error('依赖版本不匹配当前目标')
  const file = version.files.find(file => file.primary) ?? version.files[0]
  if (!file || !/^[^/\\:*?"<>|\x00-\x1f]+\.jar$/.test(file.filename)) throw new Error('插件发行文件无效')
  const expected = file.hashes.sha512 ? { algorithm: 'sha512' as const, value: file.hashes.sha512 } : file.hashes.sha1 ? { algorithm: 'sha1' as const, value: file.hashes.sha1 } : undefined
  if (!expected) throw new Error('发行文件没有上游校验值')
  if (!(expected.algorithm === 'sha512' ? /^[a-f0-9]{128}$/i : /^[a-f0-9]{40}$/i).test(expected.value)) throw new Error('发行文件的上游校验值格式无效')
  const temporaryRoot = path.join(project.path, '.modmind')
  await fs.mkdir(temporaryRoot, { recursive: true })
  const stage = await fs.mkdtemp(path.join(temporaryRoot, 'dependency-'))
  try {
    const target = path.join(stage, file.filename)
    await verifiedDownload.download({ sources: [{ id: 'modrinth', label: 'Modrinth 插件', url: file.url }], destination: target, expectedHash: expected })
    return await importPluginDependencies(project, [target])
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}
