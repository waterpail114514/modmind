import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DecompilePlatform } from '../shared/decompile'
import { archiveEntries } from './ftbResourceArchive'
import { inspectModJar } from './jarInspection'
import { inspectPluginJar } from './serverPluginService'

/** Keep plugin detection out of mod dependency/import validation. */
export async function inspectDecompileJar(filePath: string) {
  const entries = await archiveEntries(filePath)
  if (!entries.some(name => ['plugin.yml', 'paper-plugin.yml', 'velocity-plugin.json'].includes(name))) {
    const mod = await inspectModJar(filePath)
    return { ...mod, plugin: undefined, profile: { ...mod.profile, loader: mod.profile.loader as DecompilePlatform } }
  }
  const plugin = await inspectPluginJar(filePath)
  const bytes = await fs.readFile(filePath)
  const loader = plugin.platform
  return {
    filePath, fileName: path.basename(filePath), size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), plugin,
    // Bukkit api-version is a minimum API declaration, not an exact build target.
    // Velocity descriptors do not declare the proxy API version.
    minecraftVersions: plugin.apiVersion ? [plugin.apiVersion] : [],
    profile: { loader, primaryModId: plugin.name, modIds: [plugin.name], displayName: plugin.name,
      version: plugin.version, classCount: entries.filter(name => name.endsWith('.class') && !name.startsWith('META-INF/versions/')).length },
    warnings: [
      plugin.platform === 'velocity' ? 'Velocity 描述文件不声明代理 API 版本，请手动确认目标 API 版本。' : '描述文件中的 api-version 是最低 API 声明，请确认实际构建目标版本；plugin.yml 无法区分 Bukkit、Spigot 与 Paper API 用法。',
      ...(plugin.foliaSupported ? ['插件声明支持 Folia；可按实际运行核心选择 Folia。'] : []),
      ...(plugin.dependencies.length ? [`声明的插件依赖：${plugin.dependencies.map(item => `${item.name}${item.optional ? '（可选）' : ''}`).join('、')}；编译依赖可能需要另行补齐。`] : []),
      '反编译会保留原始插件描述与资源；内嵌库和还原错误可能需要修复后才能重新构建。'
    ]
  }
}
