import type { JavaLoaderKind, LoaderKind, ProjectInfo } from '../shared/types'
import { isJavaLoader, isServerPluginPlatform } from '../shared/projectPlatform'
import { pluginJavaVersion, supportsPluginTarget } from '../shared/serverPluginCompatibility'

export interface LoaderBuildCompatibility {
  javaVersion: number
  gradleVersion: string
  gradleChecksum: string
  pluginVersion: string
}

const gradleChecksums: Record<string, string> = {
  '2.0': 'a1eb880c8755333c4d33c4351b269bebe517002532d3142c0b6164c9e8c081c3',
  '2.14.1': 'cfc61eda71f2d12a572822644ce13d2919407595c2aec3e3566d2aab6f97ef39',
  '2.7': 'cde43b90945b5304c43ee36e58aab4cc6fb3a3d5f9bd9449bb1709a68371cb06',
  '4.9': 'e66e69dce8173dd2004b39ba93586a184628bc6c28461bc771d6835f7f9b0d28',
  '4.10.3': '8626cbf206b4e201ade7b87779090690447054bc93f052954c78480fa6ed186e',
  '6.9.4': '3e240228538de9f18772a574e99a0ba959e83d6ef351014381acd9631781389a',
  '7.3.3': 'b586e04868a22fd817c8971330fec37e298f3242eb85c374181b12d637f80302',
  '7.6.4': 'bed1da33cca0f557ab13691c77f38bb67388119e4794d113e051039b80af9bb1',
  '8.9': 'd725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab',
  '8.12.1': '8d97a97984f6cbd2b85fe4c60a743440a347544bf18818048e611f5288d46c94',
  '8.14.5': '6f74b601422d6d6fc4e1f9a1ab6522f642c2fdcbc15ae33ebd30ba3d7198e854',
  '9.2.1': '72f44c9f8ebcb1af43838f45ee5c4aa9c5444898b3468ab3f4af7b6076c5bc3f',
  '9.5.0': '553c78f50dafcd54d65b9a444649057857469edf836431389695608536d6b746',
  '9.5.1': 'bafc141b619ad6350fd975fc903156dd5c151998cc8b058e8c1044ab5f7b031f'
}

export function gradleChecksumForVersion(version: string): string | undefined {
  return gradleChecksums[version]
}

export function compareMinecraftVersions(left: string, right: string): number {
  const normalize = (value: string): number[] => (value.startsWith('1.') ? value.slice(2) : value)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const a = normalize(left)
  const b = normalize(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

function between(version: string, minimum: string, maximum: string): boolean {
  return compareMinecraftVersions(version, minimum) >= 0 && compareMinecraftVersions(version, maximum) <= 0
}

export function supportsProjectCreation(loader: LoaderKind, minecraftVersion: string): boolean {
  if (isServerPluginPlatform(loader)) return supportsPluginTarget(loader, minecraftVersion)
  if (loader === 'fabric') return between(minecraftVersion, '1.14', '26.2')
  if (loader === 'quilt') return ['1.18.2', '1.19.2', '1.19.4', '1.20.1', '1.20.2', '1.20.4', '1.20.6', '1.21'].includes(minecraftVersion)
  if (loader === 'forge') return between(minecraftVersion, '1.6.4', '26.2')
  if (loader === 'neoforge') return between(minecraftVersion, '1.20.2', '26.2')
  if (loader === 'bedrock') return ['1.20.80', '1.21.100', '1.26.30'].includes(minecraftVersion)
  return minecraftVersion === '3.8'
}

export function assertProjectCreationSupported(loader: LoaderKind, minecraftVersion: string): void {
  if (!supportsProjectCreation(loader, minecraftVersion)) {
    throw new Error(`${loader} / Minecraft ${minecraftVersion} is not supported by the bundled official template`)
  }
}

export function javaVersionForMinecraft(version: string): number {
  if (version.startsWith('26.')) return 25
  if (!version.startsWith('1.')) return 21
  const normalized = version.slice(2)
  const [major = 0, minor = 0] = normalized.split('.').map((part) => Number.parseInt(part, 10) || 0)
  if (major <= 16) return 8
  if (major === 17) return 16
  if (major < 20 || (major === 20 && minor <= 4)) return 17
  return 21
}

export function javaRuntimeTargetForMinecraft(version: string): string {
  if (version.startsWith('26.')) return 'java-runtime-epsilon'
  if (compareMinecraftVersions(version, '1.20.5') >= 0) return 'java-runtime-delta'
  if (compareMinecraftVersions(version, '1.18') >= 0) return 'java-runtime-gamma'
  if (compareMinecraftVersions(version, '1.17') >= 0) return 'java-runtime-alpha'
  return 'jre-legacy'
}

export function javaRuntimeTargetForJavaVersion(version: number): string {
  if (version >= 25) return 'java-runtime-epsilon'
  if (version >= 21) return 'java-runtime-delta'
  if (version >= 17) return 'java-runtime-gamma'
  if (version >= 16) return 'java-runtime-alpha'
  return 'jre-legacy'
}

export function buildJavaRangeForProject(project: Pick<ProjectInfo, 'loader' | 'minecraftVersion'>): { minimum: number; maximum?: number } {
  if (isServerPluginPlatform(project.loader)) return { minimum: Math.max(17, pluginJavaVersion(project.loader, project.minecraftVersion)) }
  if (!isJavaLoader(project.loader)) return { minimum: 0 }
  const gameJava = javaVersionForMinecraft(project.minecraftVersion)
  if (project.loader === 'forge' && compareMinecraftVersions(project.minecraftVersion, '1.17') < 0) return { minimum: 8, maximum: 8 }
  if (project.loader === 'forge' && compareMinecraftVersions(project.minecraftVersion, '1.18') < 0) return { minimum: 16, maximum: 16 }
  if (project.loader === 'fabric') return { minimum: Math.max(21, gameJava) }
  if (project.loader === 'quilt') return { minimum: Math.max(17, gameJava) }
  return { minimum: gameJava }
}

export function loaderBuildCompatibility(loader: JavaLoaderKind, minecraftVersion: string): LoaderBuildCompatibility {
  const javaVersion = javaVersionForMinecraft(minecraftVersion)
  let gradleVersion: string
  let pluginVersion: string

  if (loader === 'fabric') {
    gradleVersion = '9.5.1'
    pluginVersion = '1.17.17'
  } else if (loader === 'quilt') {
    gradleVersion = '8.9'
    pluginVersion = '1.7.4'
  } else if (loader === 'forge') {
    if (minecraftVersion === '1.7.10') {
      gradleVersion = '2.0'
      pluginVersion = '1.2-SNAPSHOT'
    } else if (minecraftVersion === '1.8.9') {
      gradleVersion = '2.7'
      pluginVersion = '2.1.6'
    } else if (minecraftVersion === '1.12.2') {
      gradleVersion = '4.9'
      pluginVersion = '3.0.197'
    } else if (compareMinecraftVersions(minecraftVersion, '1.8') < 0) {
      gradleVersion = '2.14.1'
      pluginVersion = '1.2-SNAPSHOT'
    } else if (compareMinecraftVersions(minecraftVersion, '1.13') < 0) {
      gradleVersion = '4.10.3'
      pluginVersion = compareMinecraftVersions(minecraftVersion, '1.9') < 0 ? '2.1-SNAPSHOT' : '2.3-SNAPSHOT'
    } else if (compareMinecraftVersions(minecraftVersion, '1.17') < 0) {
      gradleVersion = '6.9.4'
      pluginVersion = compareMinecraftVersions(minecraftVersion, '1.15') < 0 ? '3.+' : compareMinecraftVersions(minecraftVersion, '1.16') < 0 ? '4.+' : '5.1.+'
    } else if (compareMinecraftVersions(minecraftVersion, '1.18') < 0) {
      gradleVersion = '7.3.3'
      pluginVersion = '5.1.+'
    } else {
      const modernPlugin = compareMinecraftVersions(minecraftVersion, '1.21.3') >= 0 || minecraftVersion.startsWith('26.')
      gradleVersion = modernPlugin ? '9.5.0' : '8.12.1'
      pluginVersion = modernPlugin ? '7.0.31' : '6.0.54'
    }
  } else {
    const neoGradle = compareMinecraftVersions(minecraftVersion, '1.20.4') < 0
    gradleVersion = neoGradle ? '8.14.5' : '9.2.1'
    pluginVersion = neoGradle ? '7.0.116' : '2.0.143'
  }

  return {
    javaVersion,
    gradleVersion,
    gradleChecksum: gradleChecksums[gradleVersion],
    pluginVersion
  }
}

export function gradleVersionForProject(project: Pick<ProjectInfo, 'loader' | 'minecraftVersion'>): string {
  if (isServerPluginPlatform(project.loader)) return '9.5.1'
  if (!isJavaLoader(project.loader)) throw new Error(`${project.loader} projects do not use Gradle`)
  if (supportsProjectCreation(project.loader, project.minecraftVersion)) {
    return loaderBuildCompatibility(project.loader, project.minecraftVersion).gradleVersion
  }
  if (project.loader === 'fabric' && compareMinecraftVersions(project.minecraftVersion, '1.18') < 0) return '7.6.4'
  if (project.loader === 'forge') {
    if (compareMinecraftVersions(project.minecraftVersion, '1.8') < 0) return '2.14.1'
    if (compareMinecraftVersions(project.minecraftVersion, '1.13') < 0) return '4.10.3'
    if (compareMinecraftVersions(project.minecraftVersion, '1.17') < 0) return '6.9.4'
    if (compareMinecraftVersions(project.minecraftVersion, '1.18') < 0) return '7.3.3'
  }
  return '8.12.1'
}

export function gradleWrapperProperties(project: Pick<ProjectInfo, 'loader' | 'minecraftVersion'>): string {
  if (!isJavaLoader(project.loader)) throw new Error(`${project.loader} projects do not use Gradle Wrapper`)
  const compatibility = loaderBuildCompatibility(project.loader, project.minecraftVersion)
  return [
    'distributionBase=GRADLE_USER_HOME',
    'distributionPath=wrapper/dists',
    `distributionUrl=https\\://mirrors.huaweicloud.com/gradle/gradle-${compatibility.gradleVersion}-bin.zip`,
    `distributionSha256Sum=${compatibility.gradleChecksum}`,
    'networkTimeout=30000',
    'validateDistributionUrl=true',
    'zipStoreBase=GRADLE_USER_HOME',
    'zipStorePath=wrapper/dists',
    ''
  ].join('\n')
}

export const officialTemplateSources: Record<LoaderKind, string> = {
  paper: 'https://docs.papermc.io/paper/dev/project-setup/',
  spigot: 'https://www.spigotmc.org/wiki/creating-a-blank-spigot-plugin-in-intellij-idea/',
  folia: 'https://docs.papermc.io/folia/',
  velocity: 'https://docs.papermc.io/velocity/dev/creating-your-first-plugin/',
  fabric: 'https://github.com/FabricMC/fabric-example-mod',
  quilt: 'https://github.com/QuiltMC/quilt-template-mod',
  forge: 'https://github.com/MinecraftForge/MinecraftForge/tree/1.21.11/mdk',
  neoforge: 'https://github.com/NeoForgeMDKs/MDK-1.21.11-ModDevGradle',
  bedrock: 'https://github.com/microsoft/minecraft-scripting-samples/tree/main/ts-starter',
  'netease-pc': 'https://mc.163.com/dev/',
  'netease-mobile': 'https://mc.163.com/dev/'
}
