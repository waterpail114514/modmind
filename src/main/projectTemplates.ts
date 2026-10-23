import type { LoaderKind, ProjectInfo } from '../shared/types'
import { compareMinecraftVersions } from './loaderCompatibility'
import { studios } from './studioRegistry'

export function descriptorPath(loader: LoaderKind, minecraftVersion: string): string {
  if (loader === 'bedrock' || loader === 'netease-pc' || loader === 'netease-mobile') return 'behavior_pack/manifest.json'
  if (loader === 'fabric') return 'src/main/resources/fabric.mod.json'
  if (loader === 'quilt') return 'src/main/resources/quilt.mod.json'
  if (loader === 'forge' && compareMinecraftVersions(minecraftVersion, '1.13') < 0) return 'src/main/resources/mcmod.info'
  if (loader === 'neoforge' && compareMinecraftVersions(minecraftVersion, '1.20.5') >= 0) return 'src/main/resources/META-INF/neoforge.mods.toml'
  return 'src/main/resources/META-INF/mods.toml'
}

/** Compatibility entry for migrations and builders; implementations belong to installed studios. */
export function projectTemplateFiles(project: ProjectInfo, includeStarter = true): Record<string, string> {
  return studios().templateFiles(project, includeStarter)
}
