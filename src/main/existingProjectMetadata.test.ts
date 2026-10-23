import { describe, expect, it } from 'vitest'
import { extractMinecraftVersion, inferGradleLoader, inferMinecraftVersions } from './existingProjectMetadata'

describe('existing project metadata inference', () => {
  it('treats ModDevGradle legacyForge as Forge', () => {
    const result = inferGradleLoader([
      { path: 'gradle.properties', content: 'minecraft_version=1.20.1\nforge_version=47.4.10\n' },
      { path: 'build.gradle', content: "id 'net.neoforged.moddev.legacyforge' version '2.0.91'\nlegacyForge { }" },
      { path: 'src/main/templates/META-INF/mods.toml', content: 'modLoader="javafml"' }
    ], 'src/main/templates/META-INF/mods.toml')
    expect(result).toEqual({ loader: 'forge', loaderVersion: '47.4.10' })
  })

  it('does not mistake a loader version for a Minecraft version', () => {
    expect(extractMinecraftVersion('forge 47.4.10, Minecraft 1.20.1')).toBe('1.20.1')
    expect(extractMinecraftVersion('NeoForge 5.0')).toBeNull()
  })

  it('ignores plugin versions and unrelated dependencies when Minecraft uses a placeholder', () => {
    expect(inferMinecraftVersions([
      { path: 'build.gradle.kts', content: 'plugins { id("fabric-loom") version "1.17" }' },
      { path: 'gradle.properties', content: 'mod_version=1.0.0\nloom_version=1.18.2' },
      { path: 'fabric.mod.json', content: JSON.stringify({ depends: { minecraft: '${minecraft_dependency}' }, suggests: { other: '>=1.0.0' } }) }
    ])).toEqual([])
  })

  it('collects distinct explicit targets from version subprojects including calendar versions', () => {
    expect(inferMinecraftVersions(['1.20.1', '1.21.1', '26.1.2', '26.2', '1.20.1'].map((version, index) => ({
      path: `versions/${index}/gradle.properties`, content: `minecraft_version=${version}`
    })))).toEqual(['1.20.1', '1.21.1', '26.1.2', '26.2'])
    expect(extractMinecraftVersion('26.1.2')).toBe('26.1.2')
  })

  it('reads only Minecraft dependency declarations in Gradle, Fabric, Quilt and Forge metadata', () => {
    expect(inferMinecraftVersions([
      { path: 'build.gradle', content: 'minecraft "com.mojang:minecraft:1.20.1"\n// minecraftVersion = "1.19.4"' },
      { path: 'fabric.mod.json', content: JSON.stringify({ version: '1.0.0', depends: { minecraft: '~1.20.1' } }) },
      { path: 'quilt.mod.json', content: JSON.stringify({ quilt_loader: { depends: [{ id: 'minecraft', versions: '1.20.1' }, { id: 'other', versions: '1.0.0' }] } }) },
      { path: 'META-INF/mods.toml', content: '[[dependencies.test]]\nmodId="minecraft"\nversionRange="[1.20.1]"\n[[dependencies.test]]\nmodId="other"\nversionRange="[1.0.0]"' }
    ])).toEqual(['1.20.1'])
  })

  it('prefers exact build targets over descriptor compatibility ranges', () => {
    expect(inferMinecraftVersions([
      { path: 'gradle.properties', content: 'minecraft_version=1.20.1' },
      { path: 'META-INF/mods.toml', content: '[[dependencies.test]]\nmodId="minecraft"\nversionRange="[1.20.1,1.21)"' }
    ])).toEqual(['1.20.1'])
  })

  it('keeps NeoForge transition projects on NeoForge when they still use mods.toml', () => {
    expect(inferGradleLoader([
      { path: 'build.gradle', content: "id 'net.neoforged.moddev' version '1.0.21'" },
      { path: 'src/main/resources/META-INF/mods.toml', content: 'modLoader="javafml"' }
    ], 'src/main/resources/META-INF/mods.toml').loader).toBe('neoforge')
  })
})
