import path from 'node:path'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import { scopedFilePath } from './scopedFilePath'

/** Quilt's generated launcher intentionally contains only a manifest; its entry
 * point lives in one of the locally installed Class-Path libraries. */
export async function validateQuiltServerLauncher(file: string): Promise<void> {
  const manifest = (await archiveRead(file, 'META-INF/MANIFEST.MF')).toString('utf8').replace(/\r?\n /g, '')
  const main = manifest.match(/^Main-Class:\s*(\S+)\s*$/im)?.[1]
  if (main !== 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher') throw new Error('Invalid Quilt server launcher entry point')
  const libraries = manifest.match(/^Class-Path:\s*(.+)$/im)?.[1].trim().split(/\s+/) ?? []
  if (!libraries.length || libraries.length > 256) throw new Error('Invalid Quilt server launcher classpath')
  let found = false
  for (const library of libraries) {
    if (!library.startsWith('libraries/') || !library.endsWith('.jar') || library.includes('%')) throw new Error('Invalid Quilt server library path')
    const target = await scopedFilePath(path.dirname(file), library)
    // Intermediary/hashed mapping libraries legitimately contain no Java class.
    const entries = await archiveEntries(target)
    if (!entries.length) throw new Error('Quilt server library archive is empty')
    const mainEntry = `${main.replaceAll('.', '/')}.class`
    if (entries.includes(mainEntry) && (await archiveRead(target, mainEntry)).length > 0) found = true
  }
  if (!found) throw new Error('Quilt server launcher main class is missing from its installed libraries')
}
