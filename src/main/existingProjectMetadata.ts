import type { JavaLoaderKind } from '../shared/types'
import { parse as parseToml } from 'smol-toml'

export interface ExistingProjectTextFile {
  path: string
  content: string
}

export function extractMinecraftVersion(value: string): string | null {
  const labelled = value.match(/\bMinecraft\s+((?:1|[2-9]\d)\.\d{1,2}(?:\.\d{1,2})?)/i)?.[1]
  return labelled ?? minecraftVersionsIn(value)[0] ?? null
}

function minecraftVersionsIn(value: string): string[] {
  if (/\$\{|\$[A-Za-z_]/.test(value)) return []
  return [...value.matchAll(/(?<![\w.])(?:1|2[6-9]|[3-9]\d)\.\d{1,2}(?:\.\d{1,2})?(?![\w.])/g)].map(match => match[0])
}

/** Read only Minecraft-specific metadata; unrelated dependency versions are never fallbacks. */
export function inferMinecraftVersions(contents: ExistingProjectTextFile[]): string[] {
  const versions = new Set<string>()
  const declared = new Set<string>()
  const add = (value: unknown, target = versions): void => {
    if (Array.isArray(value)) { value.forEach(entry => add(entry, target)); return }
    if (typeof value === 'string') minecraftVersionsIn(value).forEach(version => target.add(version))
  }
  for (const { path, content } of contents) {
    if (/(?:^|\/)gradle\.properties$/i.test(path)) {
      const properties = parseGradleProperties(content)
      add(properties.minecraft_version ?? properties.mc_version ?? properties.parchment_minecraft_version, declared)
    } else if (/fabric\.mod\.json$/i.test(path)) {
      try { add(JSON.parse(content).depends?.minecraft) } catch { /* malformed metadata stays undetermined */ }
    } else if (/quilt\.mod\.json$/i.test(path)) {
      try {
        const depends = JSON.parse(content).quilt_loader?.depends
        if (Array.isArray(depends)) depends.filter(entry => entry?.id === 'minecraft').forEach(entry => add(entry.versions))
      } catch { /* malformed metadata stays undetermined */ }
    } else if (/(?:^|\/)(?:neoforge\.)?mods\.toml$/i.test(path)) {
      try {
        const dependencies = parseToml(content).dependencies
        if (dependencies && typeof dependencies === 'object') {
          Object.values(dependencies).forEach(entries => {
            if (Array.isArray(entries)) entries.forEach(entry => {
              if (entry && typeof entry === 'object' && entry.modId === 'minecraft') add(entry.versionRange)
            })
          })
        }
      } catch { /* malformed metadata stays undetermined */ }
    } else if (/(?:^|\/)build\.gradle(?:\.kts)?$/i.test(path)) {
      const script = content.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
      for (const match of script.matchAll(/\b(?:minecraft_version|minecraftVersion|mc_version)\s*(?:=|\()\s*["']([^"']+)["']/g)) add(match[1], declared)
      for (const match of script.matchAll(/["']com\.mojang:minecraft:([^"']+)["']/g)) add(match[1], declared)
      for (const match of script.matchAll(/["']net\.minecraftforge:forge:([^"']+)["']/g)) add(match[1].split('-')[0], declared)
    } else if (/(?:^|\/)\.build-target-props\.json$/i.test(path)) {
      try { add(JSON.parse(content).minecraft_version, declared) } catch { /* malformed metadata stays undetermined */ }
    }
  }
  return [...(declared.size ? declared : versions)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export function parseGradleProperties(content: string): Record<string, string> {
  return Object.fromEntries(content.split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*(?:#.*)?$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => [match[1], match[2]]))
}

function cleanVersion(value: string | undefined): string | undefined {
  return value && value.length <= 120 && /^[0-9A-Za-z][0-9A-Za-z.+_:-]*$/.test(value) ? value : undefined
}

export function inferGradleLoader(contents: ExistingProjectTextFile[], descriptor?: string): { loader: JavaLoaderKind; loaderVersion?: string } {
  const properties = contents.find((entry) => /(?:^|\/)gradle\.properties$/i.test(entry.path))
  const values = properties ? parseGradleProperties(properties.content) : {}
  if (descriptor && /neoforge\.mods\.toml$/i.test(descriptor)) return { loader: 'neoforge', loaderVersion: cleanVersion(values.neoforge_version ?? values.neo_version) }
  const joined = contents.map((entry) => entry.content).join('\n')
  // AutoForge's 1.20.1 template uses ModDevGradle's legacyForge bridge. The
  // plugin lives under net.neoforged, but the produced project is Forge.
  if (/net\.neoforged\.moddev\.legacyforge|\blegacyForge\s*\{/i.test(joined) || /(?:^|\n)\s*forge_version\s*=/i.test(joined)) {
    return { loader: 'forge', loaderVersion: cleanVersion(values.forge_version) }
  }
  if (/net\.neoforged\.moddev|(?:^|\n)\s*(?:neo(?:forge)?_version)\s*=/i.test(joined)) {
    return { loader: 'neoforge', loaderVersion: cleanVersion(values.neoforge_version ?? values.neo_version) }
  }
  if (descriptor && /(?:^|\/)mods\.toml$/i.test(descriptor)) return { loader: 'forge', loaderVersion: cleanVersion(values.forge_version) }
  if (/net\.minecraftforge|forgegradle|\bforge_version\b/i.test(joined)) return { loader: 'forge' }
  if (/quilt\.mod\.json|org\.quiltmc/i.test(joined)) return { loader: 'quilt' }
  if (/fabric\.mod\.json|fabric-loom|net\.fabricmc/i.test(joined)) return { loader: 'fabric' }
  return { loader: 'fabric' }
}
