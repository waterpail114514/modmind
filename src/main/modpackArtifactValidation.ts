import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { LoaderKind } from '../shared/types'
import { archiveEntries, archiveRead } from './ftbResourceArchive'

const FORGE_SERVICES = [
  'net.minecraftforge.forgespi.locating.IModLocator',
  'net.minecraftforge.forgespi.locating.IDependencyLocator',
  'cpw.mods.modlauncher.api.ITransformationService'
]

async function serviceProviders(filePath: string, files: string[], service: string): Promise<string[]> {
  const resource = `META-INF/services/${service}`
  if (!files.includes(resource)) return []
  const providers = (await archiveRead(filePath, resource)).toString('utf8').split(/\r?\n/)
    .map(line => line.split('#')[0].trim()).filter(Boolean)
  return providers.length && providers.every(provider => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(provider)
    && files.includes(`${provider.replaceAll('.', '/')}.class`)) ? providers : []
}

async function isForgeBootstrap(filePath: string, files: string[]): Promise<boolean> {
  for (const service of FORGE_SERVICES) {
    if ((await serviceProviders(filePath, files, service)).length) return true
  }
  return false
}

/** Detect the installed bridge from descriptors and real service providers, never filenames. */
export async function hasConnectorBridge(filePaths: string[], loader: LoaderKind): Promise<boolean> {
  if (loader !== 'forge' && loader !== 'neoforge') return false
  const descriptorName = loader === 'forge' ? 'META-INF/mods.toml' : 'META-INF/neoforge.mods.toml'
  const connectorDescriptor = async (file: string, files: string[]): Promise<boolean> => {
    if (!files.includes(descriptorName)) return false
    const descriptor = parseToml((await archiveRead(file, descriptorName)).toString('utf8'))
    return Array.isArray(descriptor.mods) && descriptor.mods.some(mod => mod && typeof mod === 'object'
      && 'modId' in mod && (mod.modId === 'connector' || mod.modId === 'connectormod'))
  }
  for (const file of filePaths) {
    try {
      const files = await archiveEntries(file)
      if (await connectorDescriptor(file, files)) return true
      const services = loader === 'forge' ? FORGE_SERVICES : ['net.neoforged.neoforgespi.locating.IModFileCandidateLocator']
      let connectorService = false
      for (const service of services) {
        if ((await serviceProviders(file, files, service)).some(provider => provider.startsWith('org.sinytra.connector.'))) connectorService = true
      }
      if (!connectorService) continue
      for (const nested of files.filter(name => /^META-INF\/jarjar\/[^/]+\.jar$/.test(name))) {
        try {
          const nestedPath = `${file}!/${nested}`
          if (await connectorDescriptor(nestedPath, await archiveEntries(nestedPath))) return true
        } catch { /* An invalid embedded archive cannot establish a bridge. */ }
      }
    } catch { /* Artifact validation reports unreadable files separately. */ }
  }
  return false
}

async function isNeoForgeBootstrap(filePath: string, files: string[]): Promise<boolean> {
  const service = 'META-INF/services/net.neoforged.neoforgespi.locating.IModFileCandidateLocator'
  if (!files.includes(service)) return false
  const providers = (await archiveRead(filePath, service)).toString('utf8').split(/\r?\n/)
    .map(line => line.split('#')[0].trim()).filter(Boolean)
  if (!providers.length || !providers.every(provider => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(provider)
    && files.includes(`${provider.replaceAll('.', '/')}.class`))) return false

  // Connector's full JAR supplies a locator; its actual mod descriptor lives in an embedded JAR.
  for (const nested of files.filter(name => /^META-INF\/jarjar\/[^/]+\.jar$/.test(name))) {
    try {
      const nestedPath = `${filePath}!/${nested}`
      const entries = await archiveEntries(nestedPath)
      if (!entries.includes('META-INF/neoforge.mods.toml')) continue
      const descriptor = parseToml((await archiveRead(nestedPath, 'META-INF/neoforge.mods.toml')).toString('utf8'))
      if (typeof descriptor.modLoader !== 'string' || !descriptor.modLoader.trim()
        || !Array.isArray(descriptor.mods) || !descriptor.mods.length
        || !descriptor.mods.every(mod => typeof mod === 'object' && mod !== null && 'modId' in mod
          && typeof mod.modId === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(mod.modId))) continue
      if (descriptor.modLoader === 'lowcodefml' || entries.some(name => name.endsWith('.class'))) return true
    } catch { /* A malformed embedded archive cannot establish a valid bootstrap mod. */ }
  }
  return false
}

/** Match launcher-accepted archive shapes without unpacking every texture and sound. */
export async function validateRuntimeModArtifact(filePath: string, loader: LoaderKind, displayPath = filePath, importedPack = false, connectorBridge = false): Promise<string[]> {
  try {
    if ((await fs.stat(filePath)).size < 1024) throw new Error('Mod JAR is implausibly small')
    const files = await archiveEntries(filePath)
    const forge = loader === 'forge' || loader === 'neoforge'
    const descriptors = loader === 'fabric' ? ['fabric.mod.json'] : loader === 'quilt' ? ['quilt.mod.json']
      : loader === 'forge' ? ['META-INF/mods.toml', 'mcmod.info'] : ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']
    const descriptor = descriptors.find(name => files.includes(name))
    const manifest = forge && files.includes('META-INF/MANIFEST.MF') ? (await archiveRead(filePath, 'META-INF/MANIFEST.MF')).toString('utf8') : ''
    const library = forge && /^FMLModType:\s*(?:LIBRARY|LANGPROVIDER)\s*$/im.test(manifest)
    const bootstrap = (forge && /^MixinConfigs:\s*\S+/im.test(manifest) && files.some(name => /^META-INF\/core\/forge[^/]*\.jar$/.test(name)))
      || (loader === 'forge' && !descriptor && !library && await isForgeBootstrap(filePath, files))
      || (loader === 'neoforge' && !descriptor && !library && await isNeoForgeBootstrap(filePath, files))
    const foreignFabric = importedPack && forge && !descriptor && !bootstrap && !library && files.includes('fabric.mod.json')
    const foreignNeoForge = importedPack && loader === 'forge' && !descriptor && !bootstrap && !library && files.includes('META-INF/neoforge.mods.toml')
    if (!descriptor && !library && !bootstrap && !foreignFabric && !foreignNeoForge) throw new Error(`Mod JAR does not contain a ${loader} descriptor`)
    const tomlDescriptor = descriptor?.endsWith('.toml') ? descriptor : foreignNeoForge ? 'META-INF/neoforge.mods.toml' : undefined
    const parsedToml = tomlDescriptor ? parseToml((await archiveRead(filePath, tomlDescriptor)).toString('utf8')) : undefined
    const lowCode = parsedToml?.modLoader === 'lowcodefml'
    let compiled = files.some(name => name.endsWith('.class'))
    if (!compiled && !lowCode) {
      for (const nested of files.filter(name => /^META-INF\/(?:jars|jarjar)\/[^/]+\.jar$/.test(name))) {
        try { if ((await archiveEntries(`${filePath}!/${nested}`)).some(name => name.endsWith('.class'))) { compiled = true; break } }
        catch { /* An invalid embedded archive does not prove this container contains code. */ }
      }
    }
    if (!compiled && !lowCode) throw new Error('Mod JAR does not contain compiled class files')
    if (foreignNeoForge) {
      const dependencies = parsedToml?.dependencies
      const minecraftRanges = dependencies && typeof dependencies === 'object'
        ? Object.values(dependencies).flatMap(value => Array.isArray(value) ? value : [])
          .filter(value => value && typeof value === 'object' && value.modId === 'minecraft' && typeof value.versionRange === 'string')
          .map(value => value.versionRange) : []
      return [`${path.basename(displayPath)} 声明 NeoForge${minecraftRanges.length ? `（Minecraft ${minecraftRanges.join('、')}）` : ''}；已按原包保留，尚未验证它在此整合包加载链中的运行结果。`]
    }
    return foreignFabric && !connectorBridge
      ? [`${path.basename(displayPath)} 仅声明 Fabric；已按原整合包保留，尚未检测到 Connector，加载前需确认兼容桥。`] : []
  } catch (error) {
    throw new Error(`Invalid Mod JAR "${path.basename(displayPath)}": ${error instanceof Error ? error.message : String(error)}`)
  }
}
