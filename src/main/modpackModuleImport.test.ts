import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { importModpackModule } from './modpackModuleImport'
import { collectBuiltModpackModuleArtifacts, createModpackTemplate, createModrinthPackArchive, readModpackManifest, readModpackModuleProject } from './modpackService'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; pack: ProjectInfo; source: ProjectInfo }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-module-import-')))
  roots.push(root)
  const pack: ProjectInfo = { kind: 'modpack', name: 'Pack', namespace: 'pack', path: path.join(root, 'pack'), loader: 'fabric', minecraftVersion: '1.21.1', createdAt: new Date().toISOString() }
  const source: ProjectInfo = { ...pack, kind: 'mod', name: 'Existing', namespace: 'existing', path: path.join(root, 'source'), projectId: 'original-project', loaderVersion: '0.16.0', javaVersion: 21 }
  await createModpackTemplate(pack)
  await fs.mkdir(path.join(source.path, 'src/main/java'), { recursive: true })
  await fs.writeFile(path.join(source.path, 'src/main/java/Example.java'), 'class Example {}')
  await fs.writeFile(path.join(source.path, 'build.gradle'), '// custom build\n')
  await fs.writeFile(path.join(source.path, 'modmind.project.json'), JSON.stringify(source))
  return { root, pack, source }
}

describe('existing modpack modules', () => {
  it('copies source and build inputs without modifying the original or copying caches', async () => {
    const { pack, source } = await fixture()
    const original = await fs.readFile(path.join(source.path, 'modmind.project.json'), 'utf8')
    await fs.mkdir(path.join(source.path, '.gradle'), { recursive: true })
    await fs.writeFile(path.join(source.path, '.gradle/cache'), 'cache')
    const manifest = await importModpackModule(pack, source, 'copy')
    expect(manifest.modules).toEqual([expect.objectContaining({ path: 'modules/existing', namespace: 'existing' })])
    const imported = await readModpackModuleProject(pack, manifest.modules[0])
    expect(imported).toMatchObject({ loaderVersion: '0.16.0', javaVersion: 21, path: path.join(pack.path, 'modules/existing') })
    expect(imported.projectId).not.toBe(source.projectId)
    await expect(fs.readFile(path.join(imported.path, 'build.gradle'), 'utf8')).resolves.toBe('// custom build\n')
    await expect(fs.access(path.join(imported.path, '.gradle'))).rejects.toThrow()
    await fs.writeFile(path.join(imported.path, 'src/main/java/Example.java'), 'changed')
    await expect(fs.readFile(path.join(source.path, 'src/main/java/Example.java'), 'utf8')).resolves.toBe('class Example {}')
    await expect(fs.readFile(path.join(source.path, 'modmind.project.json'), 'utf8')).resolves.toBe(original)
  })

  it('uses the original linked project and exports its current artifact', async () => {
    const { root, pack, source } = await fixture()
    const original = await fs.readFile(path.join(source.path, 'modmind.project.json'), 'utf8')
    await importModpackModule(pack, source, 'link')
    const manifest = await readModpackManifest(pack)
    expect(manifest.modules[0]).toMatchObject({ linked: true, path: source.path.replaceAll('\\', '/') })
    const linked = await readModpackModuleProject(pack, manifest.modules[0])
    expect(linked).toMatchObject({ path: source.path, projectId: source.projectId, javaVersion: 21 })
    await expect(fs.access(path.join(pack.path, 'modules/existing'))).rejects.toThrow()
    await fs.mkdir(path.join(source.path, 'build/libs'), { recursive: true })
    const artifact = path.join(source.path, 'build/libs/example.jar')
    await fs.writeFile(artifact, Buffer.alloc(2048, 7))
    expect((await collectBuiltModpackModuleArtifacts(pack))[0].path).toBe(artifact)
    const bytes = Buffer.alloc(2048, 8)
    await fs.writeFile(artifact, bytes)
    const archive = path.join(root, 'pack.mrpack')
    await fs.writeFile(archive, await createModrinthPackArchive(pack))
    await extractZip(archive, { dir: path.join(root, 'export') })
    await expect(fs.readFile(path.join(root, 'export/overrides/mods/modmind-local-existing.jar'))).resolves.toEqual(bytes)
    await expect(fs.readFile(path.join(source.path, 'modmind.project.json'), 'utf8')).resolves.toBe(original)
  })

  it('adds metadata for an external Gradle project linked in place', async () => {
    const { pack, source } = await fixture()
    await fs.rm(path.join(source.path, 'modmind.project.json'))
    const manifest = await importModpackModule(pack, source, 'link')
    expect((await readModpackModuleProject(pack, manifest.modules[0])).path).toBe(source.path)
    await expect(fs.readFile(path.join(source.path, 'build.gradle'), 'utf8')).resolves.toBe('// custom build\n')
  })

  it.each(['copy', 'link'] as const)('rejects incompatible, duplicate and incomplete projects in %s mode', async mode => {
    const { pack, source } = await fixture()
    await expect(importModpackModule(pack, { ...source, loader: 'forge' }, mode)).rejects.toThrow('请先统一')
    await expect(importModpackModule(pack, { ...source, minecraftVersion: '1.20.1' }, mode)).rejects.toThrow('请先统一')
    await expect(importModpackModule(pack, { ...source, kind: 'modpack' }, mode)).rejects.toThrow('源码项目')
    await fs.rename(path.join(source.path, 'build.gradle'), path.join(source.path, 'build.gradle.saved'))
    await expect(importModpackModule(pack, source, mode)).rejects.toThrow('缺少 Gradle')
    expect((await readModpackManifest(pack)).modules).toEqual([])
    await fs.rename(path.join(source.path, 'build.gradle.saved'), path.join(source.path, 'build.gradle'))
    await importModpackModule(pack, source, mode)
    await expect(importModpackModule(pack, source, mode)).rejects.toThrow('同名')
    expect((await readModpackManifest(pack)).modules).toHaveLength(1)
  })

  it('reports moved and incompatible linked projects', async () => {
    const { pack, source } = await fixture()
    const manifest = await importModpackModule(pack, source, 'link')
    await fs.writeFile(path.join(source.path, 'modmind.project.json'), JSON.stringify({ ...source, minecraftVersion: '1.20.1' }))
    await expect(readModpackModuleProject(pack, manifest.modules[0])).rejects.toThrow('目标版本已改变')
    await fs.rename(source.path, `${source.path}-moved`)
    await expect(collectBuiltModpackModuleArtifacts(pack)).rejects.toThrow('找不到直接使用的模组项目')
  })

  it('preserves an existing destination and rejects implicit external paths', async () => {
    const { pack, source } = await fixture()
    await fs.mkdir(path.join(pack.path, 'modules/existing'))
    await fs.writeFile(path.join(pack.path, 'modules/existing/keep.txt'), 'keep')
    await expect(importModpackModule(pack, source, 'copy')).rejects.toThrow('目录已存在')
    await expect(fs.readFile(path.join(pack.path, 'modules/existing/keep.txt'), 'utf8')).resolves.toBe('keep')
    const manifest = await readModpackManifest(pack)
    await fs.writeFile(path.join(pack.path, 'modmind.pack.json'), JSON.stringify({ ...manifest, modules: [{ name: source.name, namespace: source.namespace, path: source.path, createdAt: source.createdAt }] }))
    await expect(readModpackManifest(pack)).rejects.toThrow('无效的自制 Mod')
  })
})
