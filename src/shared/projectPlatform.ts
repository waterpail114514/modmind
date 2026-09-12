import type { AddonPlatformKind, JavaLoaderKind, LoaderKind, ServerPluginPlatform } from './types'

export const JAVA_LOADERS: readonly JavaLoaderKind[] = ['fabric', 'quilt', 'forge', 'neoforge']
export const ADDON_PLATFORMS: readonly AddonPlatformKind[] = ['bedrock', 'netease-pc', 'netease-mobile']
export const SERVER_PLUGIN_PLATFORMS: readonly ServerPluginPlatform[] = ['paper', 'spigot', 'folia', 'velocity']
export const PROJECT_PLATFORMS: readonly LoaderKind[] = [...JAVA_LOADERS, ...ADDON_PLATFORMS, ...SERVER_PLUGIN_PLATFORMS]

export function isServerPluginPlatform(value: unknown): value is ServerPluginPlatform {
  return typeof value === 'string' && (SERVER_PLUGIN_PLATFORMS as readonly string[]).includes(value)
}

export function isJavaLoader(value: unknown): value is JavaLoaderKind {
  return typeof value === 'string' && (JAVA_LOADERS as readonly string[]).includes(value)
}

export function isAddonPlatform(value: unknown): value is AddonPlatformKind {
  return typeof value === 'string' && (ADDON_PLATFORMS as readonly string[]).includes(value)
}

export function platformLabel(platform: LoaderKind): string {
  const labels: Record<LoaderKind, string> = {
    fabric: 'Fabric',
    quilt: 'Quilt',
    forge: 'Forge',
    neoforge: 'NeoForge',
    paper: 'Paper',
    spigot: 'Spigot',
    folia: 'Folia',
    velocity: 'Velocity',
    bedrock: '国际基岩版',
    'netease-pc': '网易版 PC',
    'netease-mobile': '网易版手游'
  }
  return labels[platform]
}
