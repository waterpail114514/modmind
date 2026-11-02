import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

/** The cache adapter and connection preflight policy are scoped to supported FG6 projects. */
export async function isForgeGradle6Project(project: Pick<ProjectInfo, 'path' | 'loader'>): Promise<boolean> {
  if (project.loader !== 'forge') return false
  const scripts = await Promise.all(['build.gradle', 'build.gradle.kts'].map(name => fs.readFile(path.join(project.path, name), 'utf8').catch(() => '')))
  return scripts.some(script => /net\.minecraftforge\.gradle[\s\S]{0,100}(?:version\s*\(?\s*['"]6\.|:6\.)/.test(script))
}

// FG6 checks two hard-coded official repository roots before using any configured
// repository. This flag skips only that redundant HEAD preflight: it does not
// change JSSE trust, hostname verification, or artifact checksums. Scope it to a
// managed build and restore it even when project configuration fails.
export const FORGE_GRADLE_MIRROR_PREFLIGHT_INIT = `
def forgePreflightKey = 'net.minecraftforge.gradle.check.certs'
if (System.getProperty(forgePreflightKey) == null && System.getProperty('fg.check.certs') == null) {
  System.setProperty(forgePreflightKey, 'false')
  gradle.buildFinished { System.clearProperty(forgePreflightKey) }
  logger.lifecycle('ModMind：ForgeGradle 使用受管下载源，跳过固定官网连接预检；HTTPS 证书验证仍启用')
}
`
