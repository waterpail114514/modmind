import type { LoaderVersionOption, ProjectInfo, ServerPluginPlatform } from '../shared/types'
import { isServerPluginPlatform } from '../shared/projectPlatform'
import { stringify } from 'yaml'
import { compareMinecraftVersions, gradleChecksumForVersion } from './loaderCompatibility'
import { pluginJavaVersion, supportsPluginTarget } from '../shared/serverPluginCompatibility'
import { PLUGIN_CATALOG_SNAPSHOT } from './serverPluginCatalogSnapshot'
import { BUKKIT_STARTER, VELOCITY3_STARTER, STARTER_LICENSE, STARTER_GPL } from './serverPluginStarters'

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

export function pluginTemplateFiles(project: ProjectInfo, includeStarter = true): Record<string, string> {
  if (!isServerPluginPlatform(project.loader) || project.kind !== 'server-plugin') throw new Error('插件工程类型与平台不匹配')
  const target = pluginVersionOption(project.loader, project.minecraftVersion, project.apiVersion)
  const api = PLUGIN_REPOSITORIES[project.loader]
  const normalizedId = project.namespace.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  const id = /^[a-z][a-z0-9_]*$/.test(normalizedId) && !['class', 'package', 'int', 'public', 'private', 'default', 'void', 'enum', 'record', 'static', 'final', 'new', 'return'].includes(normalizedId) ? normalizedId : `plugin_${normalizedId || 'main'}`
  const className = `dev.modmind.${id}.PluginEntry`
  const velocity = project.loader === 'velocity'
  // Published Velocity 3/4 artifacts retain event.proxy; upstream V2 template is not version 4.
  const lifecyclePackage: string = 'proxy'
  const descriptor = { name: id, version: '${version}', main: className, 'api-version': compareMinecraftVersions(project.minecraftVersion, '1.20.5') >= 0 ? project.minecraftVersion : project.minecraftVersion.split('.').slice(0, 2).join('.'), description: project.name, ...(project.loader === 'folia' ? { 'folia-supported': true } : {}), commands: { [id]: { description: 'Plugin status', permission: `${id}.use` } }, permissions: { [`${id}.use`]: { default: true } } }
  if (!velocity && compareMinecraftVersions(project.minecraftVersion, '1.13') < 0) delete (descriptor as { 'api-version'?: string })['api-version']
  const files: Record<string, string> = {
    'modmind.project.json': JSON.stringify(project, null, 2),
    'settings.gradle': `rootProject.name = '${id}'\n`,
    'gradle.properties': 'org.gradle.jvmargs=-Xmx2G\norg.gradle.caching=true\nplugin_version=0.1.0\n',
    'build.gradle': `plugins { id 'java' }\ngroup = 'dev.modmind.${id}'\nversion = project.plugin_version\nrepositories {\n    mavenCentral()\n    maven { url = '${api.repository}' }\n}\ndependencies {\n    compileOnly '${api.coordinate}:${project.apiVersion ?? target.apiVersion}'\n${velocity ? `    annotationProcessor '${api.coordinate}:${project.apiVersion ?? target.apiVersion}'\n` : ''}}\njava { toolchain.languageVersion = JavaLanguageVersion.of(${project.javaVersion ?? target.javaVersion}) }\ntasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }\n${velocity ? '' : "processResources { inputs.property 'version', project.version; filesMatching('plugin.yml') { expand version: project.version } }\n"}`,
    'gradle/wrapper/gradle-wrapper.properties': `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${PLUGIN_GRADLE_VERSION}-bin.zip\ndistributionSha256Sum=${gradleChecksumForVersion(PLUGIN_GRADLE_VERSION)}\nnetworkTimeout=30000\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n`,
    '.gitignore': '.gradle/\nbuild/\n.modmind/\nrun/\n',
    'README.md': `# ${project.name}\n\nMinecraft server plugin for ${project.loader} ${project.minecraftVersion}.\n\nBuild with the bundled Gradle Wrapper. Install the resulting main JAR into the matching server plugins directory.\n\nStarter adapted from Minecraft Development (commit dec3e63ba62b9f6aaea5ad6a21bc011fe087b08c), recommended by Paper documentation. See TEMPLATE-NOTICE.md and LICENSE-template.txt.\n`,
    'LICENSE-template.txt': STARTER_LICENSE,
    'LICENSE-template-GPL.txt': STARTER_GPL,
    'TEMPLATE-NOTICE.md': 'Entry lifecycle skeleton adapted from https://github.com/minecraft-dev/MinecraftDev/tree/dec3e63ba62b9f6aaea5ad6a21bc011fe087b08c/src/main/resources/fileTemplates/j2ee (LGPL-3.0). ModMind adds status command, version filtering and explicit shutdown logging. No third-party runtime library is bundled. Upstream source and license are retained in ModMind resources/server-plugin-starters.\n'
  }
  if (project.loader === 'spigot') files['build.gradle'] = files['build.gradle'].replace("    mavenCentral()", "    mavenCentral()\n    maven { url = 'https://hub.spigotmc.org/nexus/content/repositories/public/' }")
  if (!velocity) {
    files['src/main/resources/plugin.yml'] = stringify(descriptor)
    files['src/main/resources/config.yml'] = 'enabled: true\n'
  }
  files['build.gradle'] += "\ntasks.named('jar') { from(project.files('LICENSE-template.txt', 'LICENSE-template-GPL.txt', 'TEMPLATE-NOTICE.md')) { into 'META-INF' } }\n"
  if (includeStarter) {
    let source = velocity ? VELOCITY3_STARTER : BUKKIT_STARTER
    source = source.replaceAll('${PACKAGE}', `dev.modmind.${id}`).replaceAll('${CLASS_NAME}', 'PluginEntry').replace(/#if\(\$\{HAS_DEPENDENCIES\}\)[\s\S]*?#end\n/, '')
    if (velocity) {
      source = source.replace('public class PluginEntry', `@Plugin(id = "${id}", name = ${JSON.stringify(project.name)}, version = BuildConstants.VERSION)\npublic class PluginEntry`)
        .replace('import org.slf4j.Logger;', `import org.slf4j.Logger;\nimport com.velocitypowered.api.event.${lifecyclePackage}.ProxyShutdownEvent;`)
        .replace('public void onProxyInitialization(ProxyInitializeEvent event) {', 'public void onProxyInitialization(ProxyInitializeEvent event) {\n        logger.info("Enabled " + BuildConstants.VERSION);')
        .replace(/\n}\s*$/, '\n    @Subscribe\n    public void onProxyShutdown(ProxyShutdownEvent event) {\n        logger.info("Disabled " + BuildConstants.VERSION);\n    }\n}\n')
      files['src/main/templates/BuildConstants.java'] = `package dev.modmind.${id};\npublic final class BuildConstants { private BuildConstants() {} public static final String VERSION = "\${version}"; }\n`
      files['build.gradle'] += "\ndef generatePluginConstants = tasks.register('generatePluginConstants', Copy) {\n    inputs.property 'version', project.version\n    from 'src/main/templates'\n    into layout.buildDirectory.dir('generated/sources/pluginConstants')\n    expand version: project.version\n}\nsourceSets.main.java.srcDir(generatePluginConstants)\n"
    } else source = source.replace('import org.bukkit.plugin.java.JavaPlugin;', 'import org.bukkit.plugin.java.JavaPlugin;\nimport org.bukkit.command.Command;\nimport org.bukkit.command.CommandSender;')
      .replace('// Plugin startup logic', 'saveDefaultConfig();\n        getLogger().info("Enabled " + getDescription().getVersion());')
      .replace('// Plugin shutdown logic', 'getLogger().info("Disabled " + getDescription().getVersion());')
      .replace(/\n}\s*$/, '\n    @Override\n    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {\n        sender.sendMessage(getDescription().getName() + " " + getDescription().getVersion());\n        return true;\n    }\n}\n')
    files[`src/main/java/dev/modmind/${id}/PluginEntry.java`] = source
  }
  return files
}
