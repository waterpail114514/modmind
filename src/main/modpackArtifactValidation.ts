import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { LoaderKind } from '../shared/types'
import { archiveEntries, archiveRead } from './ftbResourceArchive'

/** Match launcher-accepted archive shapes without unpacking every texture and sound. */
export async function validateRuntimeModArtifact(filePath: string, loader: LoaderKind, displayPath = filePath, importedPack = false): Promise<string[]> {
  try {
    if ((await fs.stat(filePath)).size < 1024) throw new Error('Mod JAR is implausibly small')
    const files = await archiveEntries(filePath)
    const forge = loader === 'forge' || loader === 'neoforge'
    const descriptors = loader === 'fabric' ? ['fabric.mod.json'] : loader === 'quilt' ? ['quilt.mod.json']
      : loader === 'forge' ? ['META-INF/mods.toml', 'mcmod.info'] : ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']
    const descriptor = descriptors.find(name => files.includes(name))
    const manifest = forge && files.includes('META-INF/MANIFEST.MF') ? (await archiveRead(filePath, 'META-INF/MANIFEST.MF')).toString('utf8') : ''
    const library = forge && /^FMLModType:\s*(?:LIBRARY|LANGPROVIDER)\s*$/im.test(manifest)
    const bootstrap = forge && /^MixinConfigs:\s*\S+/im.test(manifest) && files.some(name => /^META-INF\/core\/forge[^/]*\.jar$/.test(name))
    const foreignFabric = importedPack && forge && !descriptor && !bootstrap && !library && files.includes('fabric.mod.json')
    if (!descriptor && !library && !bootstrap && !foreignFabric) throw new Error(`Mod JAR does not contain a ${loader} descriptor`)
    const lowCode = descriptor?.endsWith('.toml') && parseToml((await archiveRead(filePath, descriptor)).toString('utf8')).modLoader === 'lowcodefml'
    let compiled = files.some(name => name.endsWith('.class'))
    if (!compiled && !lowCode) {
      for (const nested of files.filter(name => /^META-INF\/(?:jars|jarjar)\/[^/]+\.jar$/.test(name))) {
        try { if ((await archiveEntries(`${filePath}!/${nested}`)).some(name => name.endsWith('.class'))) { compiled = true; break } }
        catch { /* An invalid embedded archive does not prove this container contains code. */ }
      }
    }
    if (!compiled && !lowCode) throw new Error('Mod JAR does not contain compiled class files')
    return foreignFabric ? [`${path.basename(displayPath)} 仅声明 Fabric；已按原整合包保留，Forge 不会直接加载它。`] : []
  } catch (error) {
    throw new Error(`Invalid Mod JAR "${path.basename(displayPath)}": ${error instanceof Error ? error.message : String(error)}`)
  }
}
