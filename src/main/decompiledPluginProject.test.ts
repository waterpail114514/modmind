import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStoredZip } from './bedrockAddon'
import { inspectForDecompilation } from './decompilePipeline'
import { pluginTemplateFiles } from './serverPluginTemplates'
import { restoreDecompiledPluginProject, validateDecompiledProjectTarget } from './decompiledPluginProject'
import type { DecompileProvenance } from '../shared/decompile'
import type { ProjectInfo } from '../shared/types'
import { createModuleFromDecompiledSources } from './decompileModuleExport'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function scratch() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-adopt-')); roots.push(root); return root }
const descriptors = [
  ['plugin.yml', 'name: Demo\nversion: "1.0"\nmain: example.Demo\napi-version: "1.21"\nfolia-supported: true\ndepend: [Vault]\ncommands:\n  hello: {}\n', 'spigot'],
  ['paper-plugin.yml', 'name: Demo\nversion: "1.0"\nmain: example.Demo\napi-version: "1.21"\n', 'paper'],
  ['velocity-plugin.json', '{"id":"demo","name":"Demo","version":"1.0","main":"example.Demo","dependencies":[{"id":"luckperms","optional":true}]}', 'velocity']
] as const

describe('plugin JAR adoption', () => {
  it.each(descriptors)('detects %s and restores its original descriptor/resources', async (file, descriptor, platform) => {
    const root = await scratch()
    const jar = path.join(root, 'demo.jar')
    await fs.writeFile(jar, createStoredZip([
      { name: file, data: Buffer.from(descriptor) },
      { name: 'example/Demo.class', data: Buffer.from('fixture') }
    ]))
    const inspected = await inspectForDecompilation(jar, { cacheRoot: path.join(root, 'cache') })
    expect(inspected.loader).toBe(platform)
    expect(inspected.plugin?.main).toBe('example.Demo')
    expect(inspected.remapRecommended).toBe(false)
    expect(inspected.minecraftVersions).toEqual(platform === 'velocity' ? [] : ['1.21'])
    expect(inspected.classCount).toBe(1)
    const project: ProjectInfo = { name: 'Imported', namespace: 'imported', loader: platform, kind: 'server-plugin', minecraftVersion: platform === 'velocity' ? '3.4.0-SNAPSHOT' : '1.21.1', path: path.join(root, 'project'), createdAt: new Date().toISOString() }
    for (const [name, content] of Object.entries(pluginTemplateFiles(project, false))) {
      await fs.mkdir(path.dirname(path.join(project.path, name)), { recursive: true })
      await fs.writeFile(path.join(project.path, name), content)
    }
    const cachedResources = path.join(root, 'resources')
    for (const [name, content] of Object.entries({ [file]: descriptor, 'assets/message.txt': '${literal}', 'META-INF/LICENSE': 'original license', 'META-INF/ORIGINAL.SF': 'old signature', 'META-INF/MANIFEST.MF': 'old manifest' })) {
      await fs.mkdir(path.dirname(path.join(cachedResources, name)), { recursive: true })
      await fs.writeFile(path.join(cachedResources, name), content)
    }
    await fs.mkdir(path.join(project.path, 'src/main/java/example'), { recursive: true })
    await fs.writeFile(path.join(project.path, 'src/main/java/example/Demo.java'), 'package example; public class Demo {}')
    const provenance: DecompileProvenance = { schemaVersion: 1, readOnly: true, sourceSha256: inspected.sha256, sourceFileName: 'demo.jar', sourceSize: inspected.size, createdAt: project.createdAt, engine: 'vineflower', engineVersion: '1.11.1', engineArgs: [], obfuscationHint: 'clear', plugin: inspected.plugin }
    expect(() => validateDecompiledProjectTarget(provenance, 'fabric')).toThrow(/类型/)
    expect(() => validateDecompiledProjectTarget(provenance, platform === 'velocity' ? 'paper' : 'velocity')).toThrow(/Velocity/)
    if (platform === 'paper') expect(() => validateDecompiledProjectTarget(provenance, 'spigot')).toThrow(/Paper/)
    if (platform === 'paper') expect(() => validateDecompiledProjectTarget(provenance, 'folia')).toThrow(/Folia/)
    if (platform === 'spigot') expect(() => validateDecompiledProjectTarget(provenance, 'folia')).not.toThrow()
    await expect(createModuleFromDecompiledSources({ packPath: root, moduleName: 'wrong_target', jarName: 'demo.jar', provenance, sourcesDirectory: root, acknowledgement: { acceptedAt: project.createdAt, sourceJarSha256: inspected.sha256, sourceFileName: 'demo.jar', origin: 'user-workspace' } })).rejects.toThrow(/服务端插件不能/)
    await restoreDecompiledPluginProject(project, provenance, cachedResources)
    const resources = path.join(project.path, 'src/main/resources')
    expect(await fs.readFile(path.join(resources, file), 'utf8')).toBe(descriptor)
    expect(await fs.readFile(path.join(resources, 'assets/message.txt'), 'utf8')).toBe('${literal}')
    expect(await fs.readFile(path.join(resources, 'META-INF/LICENSE'), 'utf8')).toBe('original license')
    await expect(fs.access(path.join(resources, 'config.yml'))).rejects.toThrow()
    await expect(fs.access(path.join(resources, 'META-INF/ORIGINAL.SF'))).rejects.toThrow()
    if (file !== 'plugin.yml') await expect(fs.access(path.join(resources, 'plugin.yml'))).rejects.toThrow()
    const build = await fs.readFile(path.join(project.path, 'build.gradle'), 'utf8')
    expect(build).not.toContain('annotationProcessor')
    expect(build).not.toContain('processResources')
    expect(build).toContain("version = '1.0'")
  })

  it('rejects a descriptor with a missing entry class', async () => {
    const root = await scratch()
    const jar = path.join(root, 'broken.jar')
    await fs.writeFile(jar, createStoredZip([{ name: 'plugin.yml', data: Buffer.from(descriptors[0][1]) }]))
    await expect(inspectForDecompilation(jar, { cacheRoot: root })).rejects.toThrow(/入口类不存在/)
  })
})
