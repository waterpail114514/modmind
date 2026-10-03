import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Version } from '@xmcl/core'
import type { LoaderKind } from '../shared/types'
import { forgeInstallerVersion } from './forgeInstallerVersion'

/** Match installed profiles by their resolved libraries, not a guessed directory name. */
export async function installedRuntimeCandidates(
  resourceRoot: string,
  minecraftVersion: string,
  loader: LoaderKind,
  loaderVersion: string | undefined,
  vanilla: boolean
): Promise<string[]> {
  // Without a pinned loader, retain the installer's upstream version selection.
  if (!vanilla && !loaderVersion) return []
  const directories = vanilla
    ? [minecraftVersion]
    : (await fs.readdir(path.join(resourceRoot, 'versions'), { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const candidates: string[] = []
  for (const id of directories) {
    try {
      const version = await Version.parse(resourceRoot, id)
      if (version.minecraftVersion !== minecraftVersion) continue
      const matches = vanilla ? version.id === minecraftVersion : version.libraries.some(library => {
        if (loader === 'fabric') return library.groupId === 'net.fabricmc' && library.artifactId === 'fabric-loader' && library.version === loaderVersion
        if (loader === 'quilt') return library.groupId === 'org.quiltmc' && library.artifactId === 'quilt-loader' && library.version === loaderVersion
        if (loader === 'forge') return library.groupId === 'net.minecraftforge' && ['forge', 'minecraftforge'].includes(library.artifactId)
          && forgeInstallerVersion(minecraftVersion, library.version) === forgeInstallerVersion(minecraftVersion, loaderVersion!)
        if (loader === 'neoforge') return library.groupId === 'net.neoforged'
          && library.artifactId === (minecraftVersion === '1.20.1' ? 'forge' : 'neoforge')
          && library.version === loaderVersion
        return false
      })
      if (matches) candidates.push(id)
    } catch {
      // Incomplete or malformed profiles must go through the installer.
    }
  }
  return candidates
}
