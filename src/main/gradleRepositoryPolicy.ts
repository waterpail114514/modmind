import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FORGE_GRADLE_MIRROR_PREFLIGHT_INIT } from './forgeGradlePolicy'

export function isManagedRepositoryFailure(log: string): boolean {
  return /https:\/\/(?:repo\.huaweicloud\.com|maven\.aliyun\.com|bmclapi2\.bangbang93\.com)\//i.test(log)
    && /Could not (?:GET|HEAD|download|resolve|get resource)|timed? out|UnknownHostException|Connection reset|status code (?:404|408|429|5\d\d)/i.test(log)
}

// Applied only to managed invocations. Custom/private repositories are untouched.
export const GRADLE_REPOSITORY_INIT = `
import org.gradle.api.artifacts.repositories.MavenArtifactRepository
def configureMirrors = { repositories ->
  repositories.all { repository ->
    if (!(repository instanceof MavenArtifactRepository)) return
    def uri = repository.url
    if (uri.scheme != 'https' || uri.userInfo || uri.query) return
    def mapping = [
      'repo.maven.apache.org': ['https://repo.huaweicloud.com/repository/maven/', '/maven2'],
      'repo1.maven.org': ['https://repo.huaweicloud.com/repository/maven/', '/maven2'],
      'plugins.gradle.org': ['https://maven.aliyun.com/repository/gradle-plugin/', '/m2'],
      'maven.minecraftforge.net': ['https://bmclapi2.bangbang93.com/maven/', ''],
      'repo.spongepowered.org': ['https://bmclapi2.bangbang93.com/maven/', '/repository/maven-public'],
      'libraries.minecraft.net': ['https://bmclapi2.bangbang93.com/maven/', '']
    ][uri.host]
    if (!mapping || uri.path.replaceAll('/+$', '') != mapping[1]) return
    if (uri.host == 'repo.spongepowered.org' && gradle.gradleVersion.tokenize('.')[0].toInteger() < 5) return
    // getCredentials() creates an empty credential object and can make even a
    // public original repository fail with "Username must not be null".
    // Read the configured provider only; on older Gradle retain original repos.
    if (!repository.metaClass.respondsTo(repository, 'getConfiguredCredentials')) return
    try {
      def credentials = repository.getConfiguredCredentials()
      if (credentials != null && credentials.isPresent()) return
    } catch (Exception ignored) { return }
    def name = 'ModMind mirror ' + repository.name
    if (repositories.findByName(name)) return
    def mirror = repositories.maven { r ->
      r.name = name
      r.url = mapping[0]
      // BMCLAPI's SNAPSHOT metadata is not Maven snapshot metadata. Let the
      // original Sponge repository resolve those versions; mirror releases.
      if (uri.host == 'repo.spongepowered.org') r.mavenContent { releasesOnly() }
    }
    repositories.remove(mirror)
    repositories.add(repositories.indexOf(repository), mirror)
  }
}
def configureSettings = { settings ->
  if (settings.metaClass.respondsTo(settings, 'getPluginManagement')) {
    configureMirrors(settings.pluginManagement.repositories)
    // Supply Gradle's implicit default early enough for settings plugins, then
    // remove it when the settings script declares explicit repositories.
    def repositories = settings.pluginManagement.repositories
    if (repositories.isEmpty()) {
      def implicitPortal = repositories.gradlePluginPortal()
      repositories.whenObjectAdded { added ->
        if (added != implicitPortal && !added.name.startsWith('ModMind mirror ')) {
          def mirror = repositories.findByName('ModMind mirror ' + implicitPortal.name)
          if (mirror) repositories.remove(mirror)
          repositories.remove(implicitPortal)
        }
      }
    }
  }
  if (settings.metaClass.respondsTo(settings, 'getDependencyResolutionManagement')) configureMirrors(settings.dependencyResolutionManagement.repositories)
}
if (gradle.gradleVersion.tokenize('.')[0].toInteger() >= 6) beforeSettings(configureSettings)
else settingsEvaluated(configureSettings)
beforeProject { project ->
  configureMirrors(project.buildscript.repositories)
  configureMirrors(project.repositories)
}
`

export function gradleRepositoryArguments(userHome: string, official = false, managedForge6 = false): string[] {
  if (official && !managedForge6) return []
  const source = (managedForge6 ? FORGE_GRADLE_MIRROR_PREFLIGHT_INIT : '') + (official ? '' : GRADLE_REPOSITORY_INIT)
  const directory = path.join(userHome, 'modmind-init')
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `repositories-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.gradle`)
  try { writeFileSync(file, source, { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return ['--init-script', file]
}
