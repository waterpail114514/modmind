import type { ServerPluginPlatform } from './types'

/** Template boundaries; publication is checked separately against Maven metadata. */
export function supportsPluginTarget(platform: ServerPluginPlatform, version: string): boolean {
  return platform === 'velocity'
    ? /^[34]\.\d+\.\d+(?:-SNAPSHOT)?$/.test(version)
    : (platform === 'spigot' && ['1.8.8', '1.12.2', '1.16.5'].includes(version)) || /^(?:1\.(?:1[7-9]|2[01])(?:\.\d+)?|26\.[12](?:\.\d+)?)$/.test(version)
}

export function pluginJavaVersion(platform: ServerPluginPlatform, version: string): number {
  if (!supportsPluginTarget(platform, version)) throw new Error(`尚未适配插件目标 ${platform} ${version}`)
  if (platform === 'velocity') {
    const [major, minor] = version.split('.').map(Number)
    return major >= 4 ? 25 : minor >= 5 ? 21 : 17
  }
  if (version.startsWith('26.')) return 25
  const [, minor, patch = 0] = version.split('.').map(Number)
  if (minor <= 16) return 8
  return minor > 20 || (minor === 20 && patch >= 5) ? 21 : 17
}
