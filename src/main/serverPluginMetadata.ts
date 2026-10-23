import type { LoaderVersionOption, ServerPluginPlatform } from '../shared/types'
import { pluginJavaVersion, supportsPluginTarget } from '../shared/serverPluginCompatibility'
import { PLUGIN_CATALOG_SNAPSHOT } from './serverPluginCatalogSnapshot'

export const PLUGIN_GRADLE_VERSION = '9.5.1'
export const PLUGIN_REPOSITORIES: Record<ServerPluginPlatform, { repository: string; coordinate: string }> = {
  paper: { repository: 'https://repo.papermc.io/repository/maven-public/', coordinate: 'io.papermc.paper:paper-api' },
  spigot: { repository: 'https://hub.spigotmc.org/nexus/content/repositories/snapshots/', coordinate: 'org.spigotmc:spigot-api' },
  folia: { repository: 'https://repo.papermc.io/repository/maven-public/', coordinate: 'dev.folia:folia-api' },
  velocity: { repository: 'https://repo.papermc.io/repository/maven-public/', coordinate: 'com.velocitypowered:velocity-api' }
}

export function pluginVersionOption(platform: ServerPluginPlatform, version: string, publishedApi?: string): LoaderVersionOption {
  if (!supportsPluginTarget(platform, version)) throw new Error(`尚未适配插件目标 ${platform} ${version}`)
  const apiVersion = publishedApi ?? (platform === 'velocity' ? version : version.startsWith('1.') ? `${version}-R0.1-SNAPSHOT` : undefined)
  if (!apiVersion || (platform === 'velocity' ? apiVersion !== version : !(new RegExp(`^${version.replaceAll('.', '\\.')}\\-R0\\.\\d+-SNAPSHOT$`).test(apiVersion) || new RegExp(`^${version.replaceAll('.', '\\.')}\\.build\\.\\d+-(?:stable|beta|alpha)$`).test(apiVersion)))) throw new Error('需要官方目录中匹配目标的精确 API 坐标')
  const preview = /-(?:alpha|beta)$/.test(apiVersion) || (platform === 'velocity' && apiVersion.endsWith('-SNAPSHOT'))
  return { loader: platform, minecraftVersion: version, loaderVersion: apiVersion, apiVersion, javaVersion: pluginJavaVersion(platform, version), channel: preview ? 'beta' : 'release', supportTier: 'experimental', notes: [platform === 'velocity' ? '版本为代理 API 版本；测试后端需另行配置' : '构建使用官方 Maven API；核心运行与业务兼容性需分别验证', 'API 可用不代表已通过运行验收'] }
}

export function bundledPluginVersions(): LoaderVersionOption[] {
  return PLUGIN_CATALOG_SNAPSHOT.map(([platform, version, api]) => ({ ...pluginVersionOption(platform, version, api), notes: ['离线官方目录快照（2026-09-12）；构建仍需 API 缓存或网络', '尚未完成对应核心的运行验收'] })).sort((a, b) => b.minecraftVersion.localeCompare(a.minecraftVersion, undefined, { numeric: true }))
}
