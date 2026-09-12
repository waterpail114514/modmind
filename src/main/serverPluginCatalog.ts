import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { LoaderVersionOption, ServerPluginPlatform } from '../shared/types'
import { supportsPluginTarget } from '../shared/serverPluginCompatibility'
import { SERVER_PLUGIN_PLATFORMS } from '../shared/projectPlatform'
import { bundledPluginVersions, PLUGIN_REPOSITORIES, pluginVersionOption } from './serverPluginTemplates'
import { fetchTextWithRetry } from './networkRequest'

const TTL = 6 * 60 * 60_000
const CATALOG_REVISION = 3
type Entry = { revision: number; at: number; options: LoaderVersionOption[] }

export function parsePluginMetadata(platform: ServerPluginPlatform, xml: string): LoaderVersionOption[] {
  if (XMLValidator.validate(xml) !== true) throw new Error(`${platform} API 元数据不是有效 XML`)
  const metadata = new XMLParser({ parseTagValue: false }).parse(xml)?.metadata
  const [group, artifact] = PLUGIN_REPOSITORIES[platform].coordinate.split(':')
  if (metadata?.groupId !== group || metadata?.artifactId !== artifact) throw new Error(`${platform} API 元数据坐标不匹配`)
  const raw = metadata.versioning?.versions?.version
  const versions: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const selected = new Map<string, LoaderVersionOption>()
  for (const api of versions) {
    if (typeof api !== 'string') continue
    const game = platform === 'velocity' ? api : api.match(/^(.*?)\-R0\.\d+-SNAPSHOT$/)?.[1] ?? api.match(/^(26\.\d+(?:\.\d+)?)\.build\.\d+-(?:stable|beta|alpha)$/)?.[1]
    if (!game || !supportsPluginTarget(platform, game)) continue
    const option = pluginVersionOption(platform, game, api)
    const previous = selected.get(game)
    const rank = (value: string): number => value.endsWith('-stable') ? 3 : value.endsWith('-beta') ? 2 : value.endsWith('-alpha') ? 1 : 3
    if (!previous || rank(api) > rank(previous.apiVersion!) || (rank(api) === rank(previous.apiVersion!) && api.localeCompare(previous.apiVersion!, undefined, { numeric: true }) > 0)) selected.set(game, option)
  }
  if (!selected.size) throw new Error(`${platform} 官方目录没有已适配的 API`)
  return [...selected.values()].sort((a, b) => b.minecraftVersion.localeCompare(a.minecraftVersion, undefined, { numeric: true }))
}

export class ServerPluginCatalog {
  private cache = new Map<ServerPluginPlatform, Entry>()
  private pending = new Map<ServerPluginPlatform, Promise<LoaderVersionOption[]>>()
  private restored?: Promise<void>
  constructor(private readonly cacheDirectory: string) {}

  private restore(): Promise<void> {
    return this.restored ??= (async () => {
      await Promise.all(SERVER_PLUGIN_PLATFORMS.map(async platform => {
        try {
          const entry = JSON.parse(await fs.readFile(path.join(this.cacheDirectory, `${platform}.json`), 'utf8')) as Entry
          if (entry.revision !== CATALOG_REVISION || !Number.isFinite(entry.at) || !Array.isArray(entry.options) || !entry.options.length) return
          const options = entry.options.map(option => {
            if (option.loader !== platform) throw new Error('platform mismatch')
            return pluginVersionOption(platform, option.minecraftVersion, option.apiVersion)
          })
          this.cache.set(platform, { revision: CATALOG_REVISION, at: entry.at, options })
        } catch { /* A damaged cache never replaces the bundled snapshot. */ }
      }))
    })()
  }

  async list(refresh = false): Promise<LoaderVersionOption[]> {
    return (await Promise.all(SERVER_PLUGIN_PLATFORMS.map(platform => this.listPlatform(platform, refresh)))).flat()
  }

  async listPlatform(platform: ServerPluginPlatform, refresh = false): Promise<LoaderVersionOption[]> {
    await this.restore()
    const cached = this.cache.get(platform)
    if (!refresh && cached && Date.now() - cached.at >= 0 && Date.now() - cached.at < TTL) return structuredClone(cached.options)
    const existing = this.pending.get(platform)
    if (existing) return structuredClone(await existing)
    const task = this.refresh(platform)
    this.pending.set(platform, task)
    try { return structuredClone(await task) }
    finally { this.pending.delete(platform) }
  }

  private async refresh(platform: ServerPluginPlatform): Promise<LoaderVersionOption[]> {
    const repository = PLUGIN_REPOSITORIES[platform]
    const url = `${repository.repository}${repository.coordinate.replaceAll('.', '/').replace(':', '/')}/maven-metadata.xml`
    let options: LoaderVersionOption[]
    try {
      options = parsePluginMetadata(platform, await fetchTextWithRetry(url, { timeoutMs: 15_000, attempts: 2 }))
    } catch (error) {
      const fallback = this.cache.get(platform)?.options ?? bundledPluginVersions().filter(option => option.loader === platform)
      return fallback.map(option => ({ ...option, notes: [...option.notes, `官方目录刷新失败，使用缓存或离线快照：${error instanceof Error ? error.message : String(error)}`] }))
    }
    const entry = { revision: CATALOG_REVISION, at: Date.now(), options }
    this.cache.set(platform, entry)
    const target = path.join(this.cacheDirectory, `${platform}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(this.cacheDirectory, { recursive: true })
      await fs.writeFile(temporary, JSON.stringify(entry), 'utf8')
      await fs.rename(temporary, target)
    } catch { /* Successful network discovery remains usable if disk persistence fails. */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    return options
  }

  async resolve(platform: ServerPluginPlatform, version: string): Promise<LoaderVersionOption> {
    if (!supportsPluginTarget(platform, version)) throw new Error(`尚未适配插件目标 ${platform} ${version}`)
    const match = (await this.listPlatform(platform)).find(option => option.minecraftVersion === version)
    if (!match) throw new Error(`${platform} 官方 API 目录没有 ${version}；请刷新目录或选择已发布版本`)
    return match
  }
}
