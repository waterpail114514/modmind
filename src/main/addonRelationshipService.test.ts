import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { createStoredZip } from './bedrockAddon'
import { AddonRelationshipService, githubAcceleratedUrl } from './addonRelationshipService'
import type { ModCandidate, ModFile, ModProviderRegistry } from './modProviderService'
import type { McmodService } from './mcmodService'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function projectFixture(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-addon-service-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'src', 'main', 'resources'), { recursive: true })
  await fs.writeFile(path.join(root, 'build.gradle'), "plugins { id 'java' }\ndependencies {}\n")
  await fs.writeFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'addon', version: '1.0', depends: { minecraft: '1.21.1' } }, null, 2))
  return { kind: 'mod', name: 'Addon', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'addon', createdAt: '' }
}

async function modJar(root: string, fileName: string, id: string, version = '1.0.0', depends: Record<string, string> = { minecraft: '1.21.1' }): Promise<string> {
  const target = path.join(root, fileName)
  await fs.writeFile(target, createStoredZip([
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id, name: id, version, depends })) },
    { name: `example/${id}/Entry.class`, data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }
  ]))
  return target
}

function candidate(id: string, name: string): ModCandidate {
  return { provider: 'modrinth', projectId: id, slug: id, name, summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 1 }
}

function registry(files: Record<string, { candidate: ModCandidate; file: ModFile; source: string }>, failProject = ''): ModProviderRegistry {
  return {
    list: () => ['modrinth'],
    search: async (query: { query: string }) => {
      const found = Object.values(files).find((entry) => entry.candidate.name.toLowerCase() === query.query.toLowerCase() || entry.candidate.slug === query.query.toLowerCase())
      return [{ provider: 'modrinth', total: found ? 1 : 0, hits: found ? [found.candidate] : [] }]
    },
    versions: async (_provider: string, projectId: string) => files[projectId] ? [files[projectId].file] : [],
    details: async (_provider: string, projectId: string) => ({ provider: 'modrinth', projectId, slug: projectId, name: files[projectId].candidate.name, projectUrl: '' }),
    identify: async () => [],
    install: async (file: ModFile, target: string) => {
      if (file.projectId === failProject) throw new Error('fixture download failed')
      const source = files[file.projectId].source
      await fs.copyFile(source, target)
      const bytes = await fs.readFile(source)
      const { createHash } = await import('node:crypto')
      return { path: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  } as unknown as ModProviderRegistry
}

describe('add-on relationship service', () => {
  it('relocates a legacy linked project without duplicating the target or its descriptor', async () => {
    const project = await projectFixture()
    const target = { ...await projectFixture(), namespace: 'engine', name: 'Engine' }
    const jar = await modJar(target.path, 'engine.jar', 'engine')
    const service = new AddonRelationshipService({ getProject: () => project, registry: () => registry({}), cacheRoot: path.join(project.path, '.cache'), importRuntime: async () => undefined, removeRuntime: async () => undefined, readProject: async root => root === target.path ? target : null })
    const initial = await service.linkProject(target, jar)
    const original = initial.relationships.find(entry => entry.provider === 'modmind-project')!
    const legacy = { ...original, id: 'modmind-project:old-path', linkedProjectId: undefined }
    await fs.writeFile(path.join(project.path, 'modmind.relationships.json'), JSON.stringify({ ...initial, relationships: [legacy, { ...legacy, id: 'modmind-project:second-path', sha256: 'stale' }] }))
    const moved = `${target.path}-moved`; roots.push(moved)
    await fs.rename(target.path, moved); target.path = moved
    const refreshed = await service.linkProject(target, path.join(moved, 'engine.jar'))
    const links = refreshed.relationships.filter(entry => entry.provider === 'modmind-project')
    expect(links).toHaveLength(1)
    expect(links[0].id).toBe(original.id)
    expect(links[0].linkedProjectPath).toBe(moved)
    expect(links[0].sha256).toBe(original.sha256)
    const gradle = await fs.readFile(path.join(project.path, 'build.gradle'), 'utf8')
    expect(gradle.match(/modmind-linked-engine.jar/g)).toHaveLength(1)
  })
  it('uses MC百科 Chinese names while keeping automatic platform downloads first', async () => {
    const project = await projectFixture()
    const createCandidate = candidate('create', 'Create')
    const createFile: ModFile = { provider: 'modrinth', projectId: 'create', versionId: 'v1', versionName: '1', filename: 'create.jar', primary: true, side: 'both', sources: [] }
    const mcmod = {
      search: async () => [{ projectId: '2021', name: '机械动力 (Create)', englishName: 'Create', summary: '自动化', pageUrl: 'https://www.mcmod.cn/class/2021.html', iconUrl: 'https://i.mcmod.cn/create.png' }],
      recommendations: async () => [{ projectId: '2021', name: '机械动力', englishName: 'Create', summary: '自动化', pageUrl: 'https://www.mcmod.cn/class/2021.html' }]
    } as unknown as McmodService
    const service = new AddonRelationshipService({
      getProject: () => project,
      registry: () => registry({ create: { candidate: createCandidate, file: createFile, source: '' } }),
      cacheRoot: path.join(project.path, '.cache'),
      importRuntime: async () => undefined,
      removeRuntime: async () => undefined,
      readProject: async () => null,
      mcmod
    })
    const results = await service.search('Create')
    expect(results[0]).toMatchObject({ provider: 'modrinth', name: '机械动力', englishName: 'Create', summary: '自动化', iconUrl: 'https://i.mcmod.cn/create.png' })
    expect(results.every((entry) => entry.provider !== 'mcmod')).toBe(true)
    await expect(service.recommendations()).resolves.toMatchObject([{ provider: 'modrinth', name: '机械动力', englishName: 'Create' }])
  })

  it('resolves, installs and declares a direct target without declaring its transitive dependency', async () => {
    const project = await projectFixture()
    const rootJar = await modJar(project.path, 'root-source.jar', 'root_mod', '2.0.0', { minecraft: '1.21.1', runtime_api: '*' })
    const apiJar = await modJar(project.path, 'api-source.jar', 'api_mod', '1.0.0')
    const rootFile: ModFile = { provider: 'modrinth', projectId: 'root', versionId: 'root-v1', versionName: '2.0.0', filename: 'root.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/root.jar' }], dependencies: [{ provider: 'modrinth', projectId: 'api', versionId: 'api-v1', kind: 'required' }] }
    const apiFile: ModFile = { provider: 'modrinth', projectId: 'api', versionId: 'api-v1', versionName: '1.0.0', filename: 'api.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/api.jar' }] }
    const imported: string[] = []
    const service = new AddonRelationshipService({
      getProject: () => project,
      registry: () => registry({ root: { candidate: candidate('root', 'Root'), file: rootFile, source: rootJar }, api: { candidate: candidate('api', 'API'), file: apiFile, source: apiJar } }),
      cacheRoot: path.join(project.path, '.cache'),
      importRuntime: async (file) => { imported.push(path.basename(file)) },
      removeRuntime: async () => undefined,
      readProject: async () => null
    })
    const manifest = await service.prepare({ required: ['Root'] })
    expect(manifest.relationships).toHaveLength(2)
    const rootRelationship = manifest.relationships.find((entry) => entry.projectId === 'root')
    expect(rootRelationship).toMatchObject({ primaryModId: 'root_mod', role: 'required' })
    expect(rootRelationship?.dependencies).toEqual(expect.arrayContaining([
      { provider: 'modrinth', projectId: 'api', versionId: 'api-v1', kind: 'required' },
      { modId: 'runtime_api', kind: 'required' }
    ]))
    expect(rootRelationship?.automatic).toBeUndefined()
    expect(manifest.relationships.find((entry) => entry.projectId === 'api')).toMatchObject({ automatic: true, primaryModId: 'api_mod' })
    expect(imported.sort()).toEqual(['api.jar', 'root.jar'])
    const gradle = await fs.readFile(path.join(project.path, 'build.gradle'), 'utf8')
    expect(gradle).toContain("modImplementation files('libs/modmind/root.jar')")
    expect(gradle).toContain("modImplementation files('libs/modmind/api.jar')")
    const descriptor = JSON.parse(await fs.readFile(path.join(project.path, 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8')) as { depends: Record<string, string> }
    expect(descriptor.depends.root_mod).toBe('2.0.0')
    expect(descriptor.depends.api_mod).toBeUndefined()
  })

  it('leaves the project unchanged when a later dependency download fails', async () => {
    const project = await projectFixture()
    const originalBuild = await fs.readFile(path.join(project.path, 'build.gradle'), 'utf8')
    const oneJar = await modJar(project.path, 'one-source.jar', 'one_mod')
    const twoJar = await modJar(project.path, 'two-source.jar', 'two_mod')
    const oneFile: ModFile = { provider: 'modrinth', projectId: 'one', versionId: 'one-v1', versionName: '1', filename: 'one.jar', primary: true, side: 'both', sources: [{ id: 'one', label: 'one', url: 'https://example.test/one.jar' }] }
    const twoFile: ModFile = { provider: 'modrinth', projectId: 'two', versionId: 'two-v1', versionName: '1', filename: 'two.jar', primary: true, side: 'both', sources: [{ id: 'two', label: 'two', url: 'https://example.test/two.jar' }] }
    const service = new AddonRelationshipService({
      getProject: () => project,
      registry: () => registry({ one: { candidate: candidate('one', 'One'), file: oneFile, source: oneJar }, two: { candidate: candidate('two', 'Two'), file: twoFile, source: twoJar } }, 'two'),
      cacheRoot: path.join(project.path, '.cache'),
      importRuntime: async () => undefined,
      removeRuntime: async () => undefined,
      readProject: async () => null
    })
    await expect(service.prepare({ required: ['One', 'Two'] })).rejects.toThrow(/fixture download failed/)
    await expect(fs.readFile(path.join(project.path, 'build.gradle'), 'utf8')).resolves.toBe(originalBuild)
    await expect(fs.access(path.join(project.path, 'modmind.relationships.json'))).rejects.toThrow()
    await expect(fs.access(path.join(project.path, 'libs', 'modmind', 'one.jar'))).rejects.toThrow()
  })

  it('links another ModMind project together with that project\'s required runtime dependency', async () => {
    const project = await projectFixture()
    const target = await projectFixture()
    target.name = 'Base Mod'
    target.namespace = 'base_mod'
    const artifact = await modJar(target.path, 'base-mod.jar', 'base_mod', '3.0.0')
    const dependencyJar = await modJar(target.path, 'api.jar', 'shared_api', '1.1.0')
    await fs.mkdir(path.join(target.path, 'libs', 'modmind'), { recursive: true })
    await fs.copyFile(dependencyJar, path.join(target.path, 'libs', 'modmind', 'shared-api.jar'))
    await fs.writeFile(path.join(target.path, 'modmind.relationships.json'), JSON.stringify({
      version: 1,
      minecraftVersion: target.minecraftVersion,
      loader: target.loader,
      updatedAt: new Date().toISOString(),
      relationships: [{ id: 'platform:modrinth:api', role: 'required', provider: 'modrinth', projectId: 'api', versionId: 'api-v1', name: 'Shared API', version: '1.1.0', primaryModId: 'shared_api', modIds: ['shared_api'], fileName: 'shared-api.jar', relativePath: 'libs/modmind/shared-api.jar', installedAt: '', environment: 'both', sha256: '', api: { primaryModId: 'shared_api', modIds: ['shared_api'], displayName: 'Shared API', version: '1.1.0', loader: 'fabric', classCount: 1, packages: [], sourceKind: 'jar' } }]
    }, null, 2))
    const fakeRegistry = registry({})
    const imported: string[] = []
    const service = new AddonRelationshipService({
      getProject: () => project,
      registry: () => fakeRegistry,
      cacheRoot: path.join(project.path, '.cache'),
      importRuntime: async (file) => { imported.push(path.basename(file)) },
      removeRuntime: async () => undefined,
      readProject: async () => null
    })
    const manifest = await service.linkProject(target, artifact)
    expect(manifest.relationships).toHaveLength(2)
    expect(manifest.relationships.find((entry) => entry.provider === 'modmind-project')).toMatchObject({ primaryModId: 'base_mod', role: 'required' })
    expect(manifest.relationships.find((entry) => entry.primaryModId === 'shared_api')).toMatchObject({ automatic: true })
    expect(imported).toHaveLength(2)
    const descriptor = JSON.parse(await fs.readFile(path.join(project.path, 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8')) as { depends: Record<string, string> }
    expect(descriptor.depends.base_mod).toBe('3.0.0')
    expect(descriptor.depends.shared_api).toBeUndefined()
  })

  it('rejects a platform target that duplicates an imported private mod ID', async () => {
    const project = await projectFixture()
    const privateJar = await modJar(project.path, 'private-source.jar', 'shared_mod', '1.0.0')
    const platformJar = await modJar(project.path, 'platform-source.jar', 'shared_mod', '1.0.0')
    const rootFile: ModFile = { provider: 'modrinth', projectId: 'root', versionId: 'root-v1', versionName: '1.0.0', filename: 'platform.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/platform.jar' }] }
    const service = new AddonRelationshipService({
      getProject: () => project,
      registry: () => registry({ root: { candidate: candidate('root', 'Root'), file: rootFile, source: platformJar } }),
      cacheRoot: path.join(project.path, '.cache'),
      importRuntime: async () => undefined,
      removeRuntime: async () => undefined,
      readProject: async () => null
    })
    const review = await service.beginImport([privateJar])
    expect(review).not.toBeNull()
    await service.confirmImport(review!.batchId, [{ itemId: review!.items[0].id, role: 'required', privateMod: true }])
    await expect(service.prepare({ required: ['Root'] })).rejects.toThrow(/相同模组 ID/)
    const manifest = await service.list()
    expect(manifest.relationships).toHaveLength(1)
    expect(manifest.relationships[0]).toMatchObject({ provider: 'private', primaryModId: 'shared_mod' })
    await expect(fs.access(path.join(project.path, 'libs', 'modmind', 'private-source.jar'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(project.path, 'libs', 'modmind', 'platform.jar'))).rejects.toThrow()
  })

  it('prefers and verifies exact-version sources before falling back to JAR inspection', async () => {
    const project = await projectFixture()
    const rootJar = await modJar(project.path, 'root-source.jar', 'root_mod', '2.0.0')
    const sourceArchive = createStoredZip([
      { name: 'src/main/java/example/root/RootApi.java', data: Buffer.from('package example.root; public final class RootApi {}') },
      { name: 'gradle.properties', data: Buffer.from('mod_version=2.0.0\n') }
    ])
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': sourceArchive.length })
      response.end(sourceArchive)
    })
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture server did not expose a port')
      const rootFile: ModFile = {
        provider: 'modrinth', projectId: 'root', versionId: 'root-v1', versionName: '2.0.0', filename: 'root.jar', primary: true, side: 'both',
        sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/root.jar' }],
        referenceArtifacts: [{ kind: 'sources', filename: 'root-sources.jar', sha1: createHash('sha1').update(sourceArchive).digest('hex'), sources: [{ id: 'local-sources', label: 'local sources', url: `http://127.0.0.1:${address.port}/root-sources.jar` }] }]
      }
      const service = new AddonRelationshipService({
        getProject: () => project,
        registry: () => registry({ root: { candidate: candidate('root', 'Root'), file: rootFile, source: rootJar } }),
        cacheRoot: path.join(project.path, '.cache'),
        importRuntime: async () => undefined,
        removeRuntime: async () => undefined,
        readProject: async () => null
      })
      const manifest = await service.prepare({ required: ['Root'] })
      const relationship = manifest.relationships.find((entry) => entry.projectId === 'root')
      expect(relationship?.api).toMatchObject({ sourceKind: 'sources', sourceMatched: true })
      expect(relationship?.api.sourcePath).toBeTruthy()
      await expect(fs.readFile(path.join(relationship!.api.sourcePath!, 'src', 'main', 'java', 'example', 'root', 'RootApi.java'), 'utf8')).resolves.toContain('class RootApi')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('githubAcceleratedUrl', () => {
  it('wraps GitHub and codeload archive URLs with the accelerator', () => {
    expect(githubAcceleratedUrl('https://github.com/example/repo/archive/refs/tags/v1.0.0.zip'))
      .toBe('https://ghfast.top/https://github.com/example/repo/archive/refs/tags/v1.0.0.zip')
    expect(githubAcceleratedUrl('https://codeload.github.com/example/repo/zip/refs/tags/v1.0.0'))
      .toBe('https://ghfast.top/https://codeload.github.com/example/repo/zip/refs/tags/v1.0.0')
  })

  it('leaves non-GitHub URLs untouched', () => {
    expect(githubAcceleratedUrl('https://api.github.com/repos/example/repo/tags')).toBe('https://api.github.com/repos/example/repo/tags')
    expect(githubAcceleratedUrl('https://example.com/file.zip')).toBe('https://example.com/file.zip')
  })
})
