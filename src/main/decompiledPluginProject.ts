import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DecompileProvenance } from '../shared/decompile'
import type { ProjectInfo } from '../shared/types'
import { isServerPluginPlatform } from '../shared/projectPlatform'
import { parsePluginDescriptor } from './serverPluginService'

export function validateDecompiledProjectTarget(provenance: DecompileProvenance, loader: ProjectInfo['loader']): void {
  const plugin = provenance.plugin
  if (Boolean(plugin) !== isServerPluginPlatform(loader)) throw new Error('来源 JAR 类型与目标项目类型不匹配')
  if (!plugin) return
  if ((plugin.platform === 'velocity') !== (loader === 'velocity')) throw new Error('Velocity 插件不能转换为 Bukkit/Paper 插件工程，反之亦然')
  if (loader === 'folia' && !plugin.foliaSupported) throw new Error('此插件未声明 Folia 支持；请先接管为 Spigot/Paper 工程并完成线程适配')
  if (plugin.platform === 'paper' && loader === 'spigot') throw new Error('Paper 插件描述文件不能用于 Spigot')
}

/** Called only in a newly created project, after the Java sources have been seeded. */
export async function restoreDecompiledPluginProject(project: ProjectInfo, provenance: DecompileProvenance, cachedResources: string): Promise<void> {
  validateDecompiledProjectTarget(provenance, project.loader)
  const plugin = provenance.plugin
  if (!plugin) throw new Error('来源记录中没有服务端插件描述')
  const descriptor = parsePluginDescriptor(await fs.readFile(path.join(cachedResources, plugin.file), 'utf8'), plugin.file)
  if (descriptor.main !== plugin.main || descriptor.name !== plugin.name) throw new Error('缓存插件描述与来源记录不匹配，请重新反编译')
  await fs.access(path.join(project.path, 'src/main/java', `${plugin.main.replaceAll('.', '/')}.java`))
  const resources = path.join(project.path, 'src/main/resources')
  // The template's placeholder descriptor/config must not survive adoption.
  for (const name of ['plugin.yml', 'paper-plugin.yml', 'velocity-plugin.json', 'config.yml']) await fs.rm(path.join(resources, name), { force: true })
  await fs.cp(cachedResources, resources, {
    recursive: true,
    filter: source => {
      const relative = path.relative(cachedResources, source).replaceAll('\\', '/')
      // Signatures and the old build manifest no longer describe the rebuilt JAR.
      return !/\.(?:class|java)$/i.test(relative) && !/^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i.test(relative)
    }
  })
  const buildPath = path.join(project.path, 'build.gradle')
  const build = await fs.readFile(buildPath, 'utf8')
  const quotedVersion = plugin.version.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n')
  await fs.writeFile(buildPath, build
    .replace('version = project.plugin_version', () => `version = '${quotedVersion}'`)
    .replace(/^processResources \{.*\}\r?\n/gm, '')
    .replace(/^    annotationProcessor .*\r?\n/gm, ''), 'utf8')
  await fs.appendFile(path.join(project.path, 'README.md'), '\n已保留原始插件入口、描述文件、配置与资源。目标 API 版本由接管时选择；原构建脚本、外部编译依赖及内嵌库的打包规则无法由 JAR 完整恢复，需构建并在匹配核心中验证。\n')
}
