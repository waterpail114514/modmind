import { promises as fs } from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import type { LoaderKind, LoaderVersionOption } from '../shared/types'
import { PROJECT_PLATFORMS } from '../shared/projectPlatform'
import { isServerPluginPlatform } from '../shared/projectPlatform'
import { ServerPluginCatalog } from './serverPluginCatalog'
import { javaVersionForMinecraft, supportsProjectCreation } from './loaderCompatibility'
import { fetchTextWithRetry } from './networkRequest'

export { javaVersionForMinecraft } from './loaderCompatibility'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const xmlParser = new XMLParser({ ignoreAttributes: false })

interface CatalogCache {
  updatedAt: string
  options: LoaderVersionOption[]
}

function supportedOptions(options: LoaderVersionOption[]): LoaderVersionOption[] {
  const seen = new Set<string>()
  return options.filter((option) => {
    if (!option || !(PROJECT_PLATFORMS as readonly string[]).includes(option.loader)) return false
    if (!supportsProjectCreation(option.loader, option.minecraftVersion)) return false
    if (!option.loaderVersion || !Number.isInteger(option.javaVersion) || !Array.isArray(option.notes)) return false
    const key = `${option.loader}:${option.minecraftVersion}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function completeCatalog(options: LoaderVersionOption[]): boolean {
  return PROJECT_PLATFORMS.filter(loader => !isServerPluginPlatform(loader)).every((loader) => options.some((option) => option.loader === loader))
}

const addonOptions: LoaderVersionOption[] = [
  { loader: 'bedrock', minecraftVersion: '1.26.30', loaderVersion: 'script-api-2.9.0', apiVersion: '2.9.0', javaVersion: 0, channel: 'release', supportTier: 'stable', notes: ['国际基岩版现代稳定档；版本表示最低引擎版本'] },
  { loader: 'bedrock', minecraftVersion: '1.21.100', loaderVersion: 'script-api-2.0.0', apiVersion: '2.0.0', javaVersion: 0, channel: 'release', supportTier: 'stable', notes: ['国际基岩版长期兼容档'] },
  { loader: 'bedrock', minecraftVersion: '1.20.80', loaderVersion: 'script-api-1.13.0', apiVersion: '1.13.0', javaVersion: 0, channel: 'release', supportTier: 'experimental', notes: ['旧版兼容档；部分现代组件和 Script API 不可用'] },
  { loader: 'netease-pc', minecraftVersion: '3.8', loaderVersion: 'netease-modsdk-3.8', apiVersion: '3.8', javaVersion: 0, channel: 'release', supportTier: 'experimental', notes: ['需要网易开发者工作台、开发者账号与对应引擎版本'] },
  { loader: 'netease-mobile', minecraftVersion: '3.8', loaderVersion: 'netease-modsdk-3.8', apiVersion: '3.8', javaVersion: 0, channel: 'release', supportTier: 'experimental', notes: ['在 PC 上开发，通过网易工作台进行手机测试与提交审核'] }
]

const fabricOfflineGames = [
  '26.2', '26.1.2', '26.1.1', '26.1', '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
  '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20', '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19', '1.18.2', '1.18.1', '1.18',
  '1.17.1', '1.17', '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16', '1.15.2', '1.15.1', '1.15', '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14'
] as const

const fabricOfflineApi: Record<string, string> = {
  '26.2': '0.156.0+26.2', '26.1.2': '0.155.2+26.1.2', '26.1.1': '0.145.4+26.1.1', '26.1': '0.145.1+26.1',
  '1.21.11': '0.141.6+1.21.11', '1.21.10': '0.138.4+1.21.10', '1.21.9': '0.134.1+1.21.9', '1.21.8': '0.136.1+1.21.8',
  '1.21.7': '0.129.0+1.21.7', '1.21.6': '0.128.2+1.21.6', '1.21.5': '0.128.2+1.21.5', '1.21.4': '0.119.4+1.21.4',
  '1.21.3': '0.114.1+1.21.3', '1.21.2': '0.106.1+1.21.2', '1.21.1': '0.116.15+1.21.1', '1.21': '0.102.0+1.21',
  '1.20.6': '0.100.8+1.20.6', '1.20.5': '0.97.8+1.20.5', '1.20.4': '0.97.3+1.20.4', '1.20.3': '0.91.1+1.20.3',
  '1.20.2': '0.91.6+1.20.2', '1.20.1': '0.92.11+1.20.1', '1.20': '0.83.0+1.20',
  '1.19.4': '0.87.2+1.19.4', '1.19.3': '0.76.1+1.19.3', '1.19.2': '0.77.0+1.19.2', '1.19.1': '0.58.5+1.19.1', '1.19': '0.58.0+1.19',
  '1.18.2': '0.77.0+1.18.2', '1.18.1': '0.46.6+1.18', '1.18': '0.46.6+1.18', '1.17.1': '0.46.1+1.17', '1.17': '0.46.1+1.17',
  '1.16.5': '0.42.0+1.16', '1.16.4': '0.42.0+1.16', '1.16.3': '0.42.0+1.16', '1.16.2': '0.42.0+1.16', '1.16.1': '0.42.0+1.16', '1.16': '0.42.0+1.16',
  '1.15.2': '0.28.5+1.15', '1.15.1': '0.28.5+1.15', '1.15': '0.28.5+1.15',
  '1.14.4': '0.28.5+1.14', '1.14.3': '0.28.5+1.14', '1.14.2': '0.28.5+1.14', '1.14.1': '0.28.5+1.14', '1.14': '0.28.5+1.14'
}

const fabricFallbackOptions: LoaderVersionOption[] = fabricOfflineGames.map((minecraftVersion) => ({
  loader: 'fabric', minecraftVersion, loaderVersion: '0.19.3', apiVersion: fabricOfflineApi[minecraftVersion],
  javaVersion: javaVersionForMinecraft(minecraftVersion), channel: 'release',
  supportTier: compareVersions(minecraftVersion, '1.20.1') >= 0 ? 'stable' : 'experimental',
  notes: fabricOfflineApi[minecraftVersion] ? ['离线官方分支兼容档；联网后刷新 Fabric API'] : ['离线提供 Fabric Loader；联网后自动匹配 Fabric API']
}))

const fallbackOptions: LoaderVersionOption[] = [
  ...fabricFallbackOptions,
  { loader: 'quilt', minecraftVersion: '1.20.1', loaderVersion: '0.27.1', apiVersion: '7.7.0+0.92.2-1.20.1', qslVersion: '6.3.0+1.20.1', javaVersion: 17, channel: 'release', supportTier: 'experimental', notes: ['Quilt 与 Quilted Fabric API 支持处于兼容验证阶段'] },
  { loader: 'forge', minecraftVersion: '1.6.4', loaderVersion: '1.6.4-9.11.1.1345', javaVersion: 8, channel: 'release', supportTier: 'experimental', notes: ['遗留 ForgeGradle 1.x 工具链'] },
  { loader: 'forge', minecraftVersion: '1.7.10', loaderVersion: '1.7.10-10.13.4.1614-1.7.10', javaVersion: 8, channel: 'release', supportTier: 'experimental', notes: ['遗留 ForgeGradle 1.x 工具链'] },
  { loader: 'forge', minecraftVersion: '1.8.9', loaderVersion: '1.8.9-11.15.1.2318-1.8.9', javaVersion: 8, channel: 'release', supportTier: 'stable', notes: ['重点兼容档：ForgeGradle 2.1、Gradle 2.7、stable_20 mappings'] },
  { loader: 'forge', minecraftVersion: '1.12.2', loaderVersion: '1.12.2-14.23.5.2860', javaVersion: 8, channel: 'release', supportTier: 'stable', notes: ['重点兼容档：ForgeGradle 3、Gradle 4.9、官方 20171003-1.12 mappings'] },
  { loader: 'forge', minecraftVersion: '1.16.5', loaderVersion: '1.16.5-36.2.42', javaVersion: 8, channel: 'release', supportTier: 'experimental', notes: ['旧版 ForgeGradle 工具链'] },
  { loader: 'forge', minecraftVersion: '1.20.1', loaderVersion: '1.20.1-47.4.0', javaVersion: 17, channel: 'release', supportTier: 'stable', notes: ['离线兼容目录，联网后会刷新 Forge 版本'] },
  { loader: 'neoforge', minecraftVersion: '1.20.4', loaderVersion: '20.4.251', javaVersion: 17, channel: 'release', supportTier: 'stable', notes: [] },
  { loader: 'neoforge', minecraftVersion: '1.21.1', loaderVersion: '21.1.244', javaVersion: 21, channel: 'release', supportTier: 'stable', notes: [] },
  ...addonOptions
]

export function bundledLoaderCatalog(): LoaderVersionOption[] {
  return supportedOptions(fallbackOptions).sort(minecraftSort)
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.match(/\d+|[A-Za-z]+/g) ?? []
  const rightParts = right.match(/\d+|[A-Za-z]+/g) ?? []
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index]
    const b = rightParts[index]
    if (a === b) continue
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = Number(a)
    const bNumber = Number(b)
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber
    if (Number.isFinite(aNumber)) return 1
    if (Number.isFinite(bNumber)) return -1
    return a.localeCompare(b)
  }
  return 0
}

async function fetchText(url: string, productVersion = 'development'): Promise<string> {
  return await fetchTextWithRetry(url, { headers: { 'User-Agent': `ModMind/${productVersion} (loader-catalog)` } })
}

async function fetchOptionalText(url: string, fallback: string, productVersion: string): Promise<string> {
  return await fetchText(url, productVersion).catch(() => fallback)
}

function metadataVersions(xml: string): string[] {
  const parsed = xmlParser.parse(xml) as {
    metadata?: { versioning?: { versions?: { version?: string | string[] } } }
  }
  return asArray(parsed.metadata?.versioning?.versions?.version).map(String)
}

function newest(values: string[]): string | undefined {
  return [...values].sort(compareVersions).at(-1)
}

function newestRelease(values: string[]): { version?: string; channel: 'release' | 'beta' } {
  const releases = values.filter((value) => !/(?:alpha|beta|rc)/i.test(value))
  return { version: newest(releases.length ? releases : values), channel: releases.length ? 'release' : 'beta' }
}

function minecraftSort(left: LoaderVersionOption, right: LoaderVersionOption): number {
  return compareVersions(right.minecraftVersion, left.minecraftVersion) || left.loader.localeCompare(right.loader)
}

export async function downloadLoaderCatalog(productVersion = 'development'): Promise<LoaderVersionOption[]> {
  const [manifestText, fabricGamesText, fabricLoadersText, fabricApiXml, quiltGamesText, quiltLoadersText, quiltedFabricApiXml, qslXml, forgeXml, neoForgeXml, neoTransitionXml] = await Promise.all([
    fetchText('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', productVersion),
    fetchOptionalText('https://meta.fabricmc.net/v2/versions/game', '[]', productVersion),
    fetchOptionalText('https://meta.fabricmc.net/v2/versions/loader', '[]', productVersion),
    fetchOptionalText('https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml', '<metadata/>', productVersion),
    fetchOptionalText('https://meta.quiltmc.org/v3/versions/game', '[]', productVersion),
    fetchOptionalText('https://meta.quiltmc.org/v3/versions/loader', '[]', productVersion),
    fetchOptionalText('https://maven.quiltmc.org/repository/release/org/quiltmc/quilted-fabric-api/quilted-fabric-api/maven-metadata.xml', '<metadata/>', productVersion),
    fetchOptionalText('https://maven.quiltmc.org/repository/release/org/quiltmc/qsl/maven-metadata.xml', '<metadata/>', productVersion),
    fetchOptionalText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', '<metadata/>', productVersion),
    fetchOptionalText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', '<metadata/>', productVersion),
    fetchOptionalText('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml', '<metadata/>', productVersion)
  ])

  const manifest = JSON.parse(manifestText) as { versions: Array<{ id: string; type: string }> }
  const releases = manifest.versions.filter((entry) => entry.type === 'release').map((entry) => entry.id)
  const releaseByLength = [...releases].sort((left, right) => right.length - left.length || compareVersions(right, left))
  const fabricGames = JSON.parse(fabricGamesText) as Array<{ version: string; stable: boolean }>
  const fabricLoaders = JSON.parse(fabricLoadersText) as Array<{ version: string; stable: boolean }>
  const loaderVersion = fabricLoaders.find((entry) => entry.stable)?.version ?? fabricLoaders[0]?.version

  const fabricApiByGame = new Map<string, string>()
  for (const version of metadataVersions(fabricApiXml)) {
    const game = version.slice(version.lastIndexOf('+') + 1)
    const existing = fabricApiByGame.get(game)
    if (!existing || compareVersions(version, existing) > 0) fabricApiByGame.set(game, version)
  }

  const options: LoaderVersionOption[] = []
  for (const game of loaderVersion ? fabricGames.filter((entry) => entry.stable && releases.includes(entry.version)) : []) {
    const family = game.version.startsWith('1.') ? game.version.split('.').slice(0, 2).join('.') : game.version
    const apiVersion = fabricApiByGame.get(game.version) ?? fabricApiByGame.get(family)
    options.push({
      loader: 'fabric', minecraftVersion: game.version, loaderVersion, apiVersion,
      javaVersion: javaVersionForMinecraft(game.version), channel: 'release',
      supportTier: apiVersion && compareVersions(game.version, '1.20.1') >= 0 ? 'stable' : 'experimental',
      notes: apiVersion
        ? (compareVersions(game.version, '1.20.1') < 0 ? ['旧版 Fabric 使用历史 Java 与资源格式，需要额外运行验证'] : [])
        : ['未找到对应的 Fabric API，模板将只包含 Fabric Loader']
    })
  }

  const quiltGames = JSON.parse(quiltGamesText) as Array<{ version: string }>
  const quiltLoaders = JSON.parse(quiltLoadersText) as Array<{ version: string }>
  const quiltLoaderVersion = quiltLoaders
    .map((entry) => entry.version)
    .filter((version) => !/(?:alpha|beta|rc)/i.test(version))
    .sort(compareVersions)
    .at(-1)
  const quiltedFabricApiByGame = new Map<string, string>()
  for (const version of metadataVersions(quiltedFabricApiXml)) {
    const game = releases.find((candidate) => version.endsWith(`-${candidate}`))
    if (game) quiltedFabricApiByGame.set(game, version)
  }
  const qslByGame = new Map<string, string>()
  for (const version of metadataVersions(qslXml)) {
    const game = releases.find((candidate) => version.endsWith(`+${candidate}`))
    if (!game) continue
    const existing = qslByGame.get(game)
    if (!existing || compareVersions(version, existing) > 0) qslByGame.set(game, version)
  }
  if (quiltLoaderVersion) {
    for (const game of quiltGames.map((entry) => entry.version).filter((version) => releases.includes(version))) {
      const apiVersion = quiltedFabricApiByGame.get(game)
      const qslVersion = qslByGame.get(game)
      if (!apiVersion || !qslVersion) continue
      options.push({
        loader: 'quilt', minecraftVersion: game, loaderVersion: quiltLoaderVersion, apiVersion, qslVersion,
        javaVersion: javaVersionForMinecraft(game), channel: 'release', supportTier: 'experimental',
        notes: ['Quilt 与 Quilted Fabric API 支持处于兼容验证阶段']
      })
    }
  }

  const forgeGroups = new Map<string, string[]>()
  for (const version of metadataVersions(forgeXml)) {
    const game = releaseByLength.find((candidate) => version.startsWith(`${candidate}-`))
    if (!game) continue
    forgeGroups.set(game, [...(forgeGroups.get(game) ?? []), version])
  }
  for (const [game, versions] of forgeGroups) {
    const version = newest(versions)
    if (!version) continue
    const modern = compareVersions(game, '1.18') >= 0
    options.push({
      loader: 'forge', minecraftVersion: game, loaderVersion: version,
      javaVersion: javaVersionForMinecraft(game), channel: 'release',
      supportTier: compareVersions(game, '1.20.1') >= 0 ? 'stable' : 'experimental',
      notes: compareVersions(game, '1.20.1') >= 0 ? [] : [modern ? '旧版 Forge 工具链需要额外构建与启动验证' : '遗留 ForgeGradle 工具链需要 Java 8 和额外运行验证']
    })
  }

  const neoGroups = new Map<string, string[]>()
  for (const version of metadataVersions(neoForgeXml)) {
    const game = releaseByLength.find((candidate) => {
      const prefix = candidate === '1.21' ? '21.0' : candidate.startsWith('1.') ? candidate.slice(2) : candidate
      return version.startsWith(`${prefix}.`)
    })
    if (!game) continue
    neoGroups.set(game, [...(neoGroups.get(game) ?? []), version])
  }
  for (const [game, versions] of neoGroups) {
    const selected = newestRelease(versions)
    if (!selected.version) continue
    options.push({
      loader: 'neoforge', minecraftVersion: game, loaderVersion: selected.version,
      javaVersion: javaVersionForMinecraft(game), channel: selected.channel,
      supportTier: selected.channel === 'release' ? 'stable' : 'experimental',
      notes: selected.channel === 'beta' ? ['当前 Minecraft 版本只有 NeoForge 测试版'] : []
    })
  }

  const transitionVersions = metadataVersions(neoTransitionXml).filter((version) => version.startsWith('1.20.1-'))
  const transition = newest(transitionVersions)
  if (transition) {
    options.push({
      loader: 'neoforge', minecraftVersion: '1.20.1', loaderVersion: transition,
      javaVersion: 17, channel: 'release', supportTier: 'experimental',
      notes: ['NeoForge 1.20.1 过渡构件使用 net.neoforged:forge']
    })
  }
  const supported = supportedOptions([...options, ...addonOptions]).sort(minecraftSort)
  if (!completeCatalog(supported)) throw new Error('上游 Loader 元数据未提供完整的受支持模板目录')
  return supported
}

export class LoaderCatalog {
  private memory: LoaderVersionOption[] | null = null
  private readonly plugins: ServerPluginCatalog

  constructor(private readonly cachePath: string, private readonly productVersion = 'development') {
    this.plugins = new ServerPluginCatalog(`${cachePath}.plugins`)
  }

  listPlugins(refresh = false): Promise<LoaderVersionOption[]> { return this.plugins.list(refresh) }

  async list(refresh = false): Promise<LoaderVersionOption[]> {
    if (!refresh && this.memory) return structuredClone(this.memory)
    if (!refresh) {
      try {
        const cached = JSON.parse(await fs.readFile(this.cachePath, 'utf8')) as CatalogCache
        const options = supportedOptions(cached.options)
        if (Date.now() - Date.parse(cached.updatedAt) < CACHE_TTL_MS && completeCatalog(options)) {
          this.memory = options
          return structuredClone(options)
        }
      } catch {
        // A stale or missing cache is refreshed below.
      }
    }
    try {
      const options = await downloadLoaderCatalog(this.productVersion)
      this.memory = options
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true })
      await fs.writeFile(this.cachePath, JSON.stringify({ updatedAt: new Date().toISOString(), options }, null, 2), 'utf8')
      return structuredClone(options)
    } catch (error) {
      try {
        const cached = JSON.parse(await fs.readFile(this.cachePath, 'utf8')) as CatalogCache
        const options = supportedOptions(cached.options)
        if (completeCatalog(options)) {
          this.memory = options
          return structuredClone(options)
        }
      } catch {
        // The bundled fallback keeps project creation available offline.
      }
      this.memory = bundledLoaderCatalog().map((option) => ({
        ...option,
        notes: [...option.notes, `兼容目录刷新失败：${error instanceof Error ? error.message : String(error)}`]
      }))
      return structuredClone(this.memory)
    }
  }

  async resolve(loader: LoaderKind, minecraftVersion: string): Promise<LoaderVersionOption> {
    if (isServerPluginPlatform(loader)) return this.plugins.resolve(loader, minecraftVersion)
    const options = await this.list()
    const match = options.find((option) => option.loader === loader && option.minecraftVersion === minecraftVersion)
    if (!match) throw new Error(`${loader} 不支持 Minecraft ${minecraftVersion}`)
    return match
  }
}
