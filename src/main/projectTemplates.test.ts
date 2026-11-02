import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { bundledLoaderCatalog, downloadLoaderCatalog, javaVersionForMinecraft } from './loaderCatalog'
import { descriptorPath, projectTemplateFiles } from './projectTemplates'
import { supportsProjectCreation } from './loaderCompatibility'
import type { LoaderKind, ProjectInfo } from '../shared/types'

function project(loader: LoaderKind, minecraftVersion: string, loaderVersion = 'test-loader'): ProjectInfo {
  return {
    name: 'Template Test',
    path: 'C:/template-test',
    loader,
    minecraftVersion,
    loaderVersion,
    apiVersion: loader === 'fabric' ? `test-api+${minecraftVersion}` : loader === 'quilt' ? `test-qfapi-${minecraftVersion}` : undefined,
    qslVersion: loader === 'quilt' ? `test-qsl+${minecraftVersion}` : undefined,
    javaVersion: javaVersionForMinecraft(minecraftVersion),
    namespace: 'template_test',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('Minecraft loader templates', () => {
  it('bundles all 48 stable Fabric game versions for offline creation', () => {
    const fabric = bundledLoaderCatalog().filter((option) => option.loader === 'fabric')
    expect(fabric).toHaveLength(48)
    expect(fabric.every((option) => Boolean(option.apiVersion))).toBe(true)
    expect(fabric.at(-1)?.minecraftVersion).toBe('1.14')
    expect(fabric[0]).toMatchObject({ minecraftVersion: '26.3', loaderVersion: '0.19.5', apiVersion: '0.164.0+26.3', javaVersion: 25 })
  })
  it('selects Java versions across Minecraft toolchain boundaries', () => {
    expect(javaVersionForMinecraft('1.16.5')).toBe(8)
    expect(javaVersionForMinecraft('1.17.1')).toBe(16)
    expect(javaVersionForMinecraft('1.20.1')).toBe(17)
    expect(javaVersionForMinecraft('1.20.6')).toBe(21)
    expect(javaVersionForMinecraft('26.2')).toBe(25)
  })

  it('creates a Fabric Loom project with a Fabric descriptor', () => {
    const files = projectTemplateFiles(project('fabric', '1.21.1', '0.16.10'))
    expect(files['build.gradle']).toContain("id 'net.fabricmc.fabric-loom-remap' version '1.17.17'")
    expect(files['build.gradle']).toContain('fabric-api')
    expect(JSON.parse(files['src/main/resources/fabric.mod.json'])).toMatchObject({ id: 'template_test' })
  })

  it('keeps hostile display names as data in generated files', () => {
    const files = projectTemplateFiles({ ...project('fabric', '1.21.1', '0.16.10'), name: 'Demo; $(whoami)\r\nnext' })
    expect(files['gradle.properties']).toContain('mod_name=Demo; $(whoami)  next')
    expect(JSON.parse(files['src/main/resources/fabric.mod.json']).name).toBe('Demo; $(whoami)  next')
  })

  it('uses the unobfuscated Fabric toolchain for 26.x', () => {
    const files = projectTemplateFiles(project('fabric', '26.2', '0.19.3'))
    expect(files['build.gradle']).toContain("id 'net.fabricmc.fabric-loom' version '1.17.17'")
    expect(files['build.gradle']).not.toContain('officialMojangMappings')
    expect(files['build.gradle']).toContain('implementation "net.fabricmc:fabric-loader:')
    expect(files['gradle.properties']).toContain('java_version=25')
  })

  it('omits Fabric API cleanly when upstream has no matching release', () => {
    const files = projectTemplateFiles({ ...project('fabric', '1.21.11', '0.19.3'), apiVersion: undefined })
    expect(files['build.gradle']).not.toContain('fabric-api:')
    expect(files['gradle.properties']).not.toContain('fabric_api_version')
    expect(JSON.parse(files['src/main/resources/fabric.mod.json']).depends['fabric-api']).toBeUndefined()
  })

  it('generates 26.3 templates with each official toolchain and exact game dependency', () => {
    for (const option of bundledLoaderCatalog().filter(option => option.minecraftVersion === '26.3')) {
      const files = projectTemplateFiles({ ...project(option.loader, '26.3'), ...option })
      expect(files['gradle.properties']).toContain('java_version=25')
      expect(files['gradle.properties']).toContain('minecraft_version=26.3')
      if (option.loader === 'fabric') {
        expect(files['build.gradle']).toContain("id 'net.fabricmc.fabric-loom' version '1.17.21'")
        expect(files['build.gradle']).not.toContain('mappings')
        expect(JSON.parse(files[descriptorPath(option.loader, '26.3')]).depends.minecraft).toBe('26.3')
      } else if (option.loader === 'forge') {
        expect(files['build.gradle']).not.toContain('mappings channel:')
        expect(files['build.gradle']).toContain('minecraft.dependency(')
      } else {
        expect(files['build.gradle']).toContain("id 'net.neoforged.moddev' version '2.0.148'")
      }
    }
  })

  it('creates a Quilt Loom project with a Quilt descriptor and runtime API', () => {
    const files = projectTemplateFiles(project('quilt', '1.20.1', '0.27.1'))
    expect(files['build.gradle']).toContain("id 'org.quiltmc.loom' version '1.7.4'")
    expect(files['build.gradle']).toContain('quilted-fabric-api')
    expect(files['build.gradle']).toContain('org.quiltmc:qsl')
    expect(JSON.parse(files['src/main/resources/quilt.mod.json']).quilt_loader).toMatchObject({ id: 'template_test' })
    expect(files['src/main/java/dev/modmind/template_test/ModMindEntry.java']).toContain('org.quiltmc.qsl.base.api.entrypoint.ModInitializer')
  })

  it('creates modern and legacy Forge descriptors', () => {
    const modern = projectTemplateFiles(project('forge', '1.20.1', '1.20.1-47.4.0'))
    expect(modern['build.gradle']).toContain("id 'net.minecraftforge.gradle'")
    expect(modern['build.gradle']).toContain('gameTestServer')
    expect(modern['build.gradle']).toContain("args '--nogui'")
    expect(modern['src/main/resources/META-INF/mods.toml']).toContain('modId="template_test"')

    expect(descriptorPath('forge', '1.12.2')).toBe('src/main/resources/mcmod.info')
    const legacy = projectTemplateFiles(project('forge', '1.12.2', '1.12.2-14.23.5.2860'))
    expect(legacy['build.gradle']).toContain("ForgeGradle:3.0.197")
    expect(legacy['build.gradle']).toContain("mappings channel: 'snapshot', version: '20171003-1.12'")
    expect(legacy['build.gradle']).toContain("apply plugin: 'net.minecraftforge.gradle'")
    expect(legacy['gradle/wrapper/gradle-wrapper.properties']).toContain('gradle-4.9-bin.zip')
    expect(legacy['src/main/resources/mcmod.info']).toContain('template_test')

    const forge189 = projectTemplateFiles(project('forge', '1.8.9', '1.8.9-11.15.1.2318-1.8.9'))
    expect(forge189['build.gradle']).toContain("ForgeGradle:2.1.6")
    expect(forge189['build.gradle']).toContain("mappings = 'stable_20'")
    expect(forge189['gradle/wrapper/gradle-wrapper.properties']).toContain('gradle-2.7-bin.zip')

    const forge1710 = projectTemplateFiles(project('forge', '1.7.10', '1.7.10-10.13.4.1614-1.7.10'))
    expect(forge1710['build.gradle']).toContain("ForgeGradle:1.2-SNAPSHOT")
    expect(forge1710['gradle/wrapper/gradle-wrapper.properties']).toContain('gradle-2.0-bin.zip')
    expect(forge1710['build.gradle']).toContain('e80d9b3bf5085002218d4be59e668bac718abbc6/client.jar')
  })

  it('creates a modern NeoForge ModDevGradle project', () => {
    const files = projectTemplateFiles(project('neoforge', '1.21.1', '21.1.244'))
    expect(files['build.gradle']).toContain("id 'net.neoforged.moddev'")
    expect(files['build.gradle']).toContain("type = 'gameTestServer'")
    expect(files['build.gradle']).toContain("programArgument '--nogui'")
    expect(files['build.gradle']).toContain("dependsOn 'processResources', 'classes'")
    expect(files['src/main/resources/META-INF/neoforge.mods.toml']).toContain('modId="template_test"')
    expect(files['src/main/java/dev/modmind/template_test/ModMindEntry.java']).toContain('net.neoforged.fml.common.Mod')
  })

  it('pins a checksummed Wrapper and safely handles starter-free and quoted projects', () => {
    const quoted = { ...project('fabric', '1.21.11', '0.19.3'), name: `Builder's "Choice"` }
    const files = projectTemplateFiles(quoted)
    expect(files['gradle/wrapper/gradle-wrapper.properties']).toContain('gradle-9.5.1-bin.zip')
    expect(files['gradle/wrapper/gradle-wrapper.properties']).toMatch(/distributionSha256Sum=[a-f0-9]{64}/)
    expect(files['src/main/java/dev/modmind/template_test/ModMindEntry.java']).toContain(`Builder's \\"Choice\\"`)
    expect(JSON.parse(files['modmind.project.json'])).toMatchObject({ projectVersion: '1.1.3' })

    const withoutStarter = projectTemplateFiles(project('fabric', '1.21.11', '0.19.3'), false)
    expect(Object.keys(withoutStarter).some((relative) => relative.endsWith('ModMindEntry.java'))).toBe(false)
    expect(JSON.parse(withoutStarter['src/main/resources/fabric.mod.json']).entrypoints).toBeUndefined()
  })

  it('ships the complete verified Gradle Wrapper assets used during project creation', async () => {
    const expected: Record<string, string> = {
      gradlew: 'b2fe376b143a459ba5d0bd290dc89beed5399fc6d159cd1214bd642ea94bcf07',
      'gradlew.bat': '9386e790d58b9368ca8e034536a5baa688643d51cb37bfa462503d36fd0291a6',
      'gradle-wrapper.jar': '423cb469ccc0ecc31f0e4e1c309976198ccb734cdcbb7029d4bda0f18f57e8d9'
    }
    for (const [name, checksum] of Object.entries(expected)) {
      const bytes = await fs.readFile(path.join(process.cwd(), 'vendor', 'gradle-wrapper', name))
      expect(bytes.length, name).toBeGreaterThan(1_000)
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(checksum)
    }
    const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { build?: { extraResources?: Array<{ from?: string }> } }
    expect(packageJson.build?.extraResources?.some((entry) => entry.from === 'vendor/gradle-wrapper')).toBe(true)
  })

  it('generates complete Gradle template files across loader generation boundaries', () => {
    const cases: Array<[LoaderKind, string]> = [
      ['fabric', '1.14'], ['fabric', '1.16.5'], ['fabric', '1.17.1'], ['fabric', '1.18.2'], ['fabric', '1.20.1'], ['fabric', '26.2'],
      ['quilt', '1.18.2'], ['quilt', '1.20.1'], ['quilt', '1.21'],
      ['forge', '1.6.4'], ['forge', '1.7.10'], ['forge', '1.8.9'], ['forge', '1.12.2'], ['forge', '1.13.2'], ['forge', '1.16.5'], ['forge', '1.17.1'], ['forge', '1.18.2'], ['forge', '1.20.1'], ['forge', '1.21.11'], ['forge', '26.2'],
      ['neoforge', '1.20.2'], ['neoforge', '1.20.4'], ['neoforge', '1.21.1'], ['neoforge', '26.2']
    ]
    for (const [loader, version] of cases) {
      const files = projectTemplateFiles(project(loader, version))
      expect(files['build.gradle'], `${loader} ${version} build.gradle`).toBeTruthy()
      expect(files['settings.gradle'], `${loader} ${version} settings.gradle`).toBeTruthy()
      expect(files['gradle.properties'], `${loader} ${version} gradle.properties`).toBeTruthy()
      expect(files['gradle/wrapper/gradle-wrapper.properties'], `${loader} ${version} wrapper`).toMatch(/distributionSha256Sum=[a-f0-9]{64}/)
      expect(files[descriptorPath(loader, version)], `${loader} ${version} descriptor`).toBeTruthy()
    }
  })

  it.runIf(process.env.MODMIND_LIVE_CATALOG === '1')('loads all four loader catalogs from upstream metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-loader-catalog-'))
    try {
      const options = await downloadLoaderCatalog()
      for (const loader of ['fabric', 'quilt', 'forge', 'neoforge'] as const) {
        const entries = options.filter((option) => option.loader === loader)
        expect(entries.length).toBeGreaterThan(0)
        expect(entries.every((option) => supportsProjectCreation(loader, option.minecraftVersion))).toBe(true)
      }
      expect(options.filter((option) => option.loader === 'fabric')).toHaveLength(48)
      for (const loader of ['fabric', 'forge', 'neoforge'] as const) {
        expect(options.find(option => option.loader === loader && option.minecraftVersion === '26.3')).toMatchObject({ javaVersion: 25 })
      }
      expect(options.some((option) => option.loader === 'neoforge' && option.minecraftVersion === '1.0')).toBe(false)
      expect(options.some((option) => option.loader === 'forge' && option.minecraftVersion === '1.12.2')).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
