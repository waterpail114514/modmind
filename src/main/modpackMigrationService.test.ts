import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LoaderVersionOption, ModpackMigrationModDecision, ProjectInfo } from '../shared/types'
import { createEmptyModpackLock, writeModpackLock } from './modpackLockService'
import { assessModpackMigration, createModpackMigration, inspectModpackMigrationJar } from "../../feature-plugins/modpack-migration/src/main/modpackMigrationService"
import type { ModFile, ModProviderRegistry } from './modProviderService'
import { addModpackFiles, createModpackTemplate, readModpackManifest } from './modpackService'
import { createStoredZip } from './bedrockAddon'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function project(root: string): ProjectInfo {
  return {
    kind: 'modpack',
    name: 'Migration Pack',
    path: root,
    loader: 'fabric',
    minecraftVersion: '1.20.1',
    loaderVersion: '0.15.11',
    namespace: 'migration_pack',
    createdAt: new Date().toISOString(),
    toolDataDirectory: '.modmind'
  }
}

const target: LoaderVersionOption = {
  loader: 'fabric',
  minecraftVersion: '1.21.1',
  loaderVersion: '0.16.10',
  apiVersion: '0.116.0+1.21.1',
  javaVersion: 21,
  channel: 'release',
  supportTier: 'stable',
  notes: []
}

function file(projectId: string, versionId: string, filename: string): ModFile {
  return {
    provider: 'modrinth',
    projectId,
    versionId,
    versionName: versionId,
    filename,
    primary: true,
    side: 'both',
    sources: [{ id: 'fixture', label: 'fixture', url: `https://example.test/${filename}` }]
  }
}

function registry(): ModProviderRegistry {
  const targetFile = file('available', 'target-v2', 'available-target.jar')
  const replacement = file('replacement', 'replacement-v1', 'replacement.jar')
  return {
    details: async (_provider: string, projectId: string) => ({
      provider: 'modrinth',
      projectId,
      slug: projectId,
      name: projectId === 'available' ? 'Available Mod' : 'Retired Feature',
      projectUrl: `https://example.test/${projectId}`
    }),
    search: async () => [{
      provider: 'modrinth',
      total: 1,
      hits: [{ provider: 'modrinth', projectId: 'replacement', slug: 'replacement', name: 'Replacement Feature', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 100 }]
    }],
    versions: async (_provider: string, projectId: string, query: { minecraftVersion: string }) => {
      if (query.minecraftVersion !== target.minecraftVersion) return []
      if (projectId === 'available') return [targetFile]
      if (projectId === 'replacement') return [replacement]
      return []
    },
    identify: async () => [],
    install: async (_selected: ModFile, destination: string) => {
      const bytes = Buffer.alloc(2_048, 7)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, bytes)
      return { path: destination, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  } as unknown as ModProviderRegistry
}

async function sourcePack(): Promise<{ root: string; pack: ProjectInfo }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-migration-'))
  roots.push(root)
  const source = path.join(root, 'source')
  const pack = project(source)
  await fs.mkdir(source, { recursive: true })
  await createModpackTemplate(pack)
  const available = Buffer.alloc(2_048, 1)
  const retired = Buffer.alloc(2_048, 2)
  const availablePath = path.join(source, 'mods', 'available-source.jar')
  const retiredPath = path.join(source, 'mods', 'retired-source.jar')
  await fs.writeFile(availablePath, available)
  await fs.writeFile(retiredPath, retired)
  await addModpackFiles(pack, [availablePath, retiredPath])
  await writeModpackLock(pack, {
    ...createEmptyModpackLock(pack),
    mods: [
      { provider: 'modrinth', projectId: 'available', versionId: 'source-v1', versionName: '1.0', fileName: 'available-source.jar', sha256: createHash('sha256').update(available).digest('hex'), size: available.length, side: 'both', sources: ['https://example.test/available-source.jar'], installedAt: new Date().toISOString() },
      { provider: 'modrinth', projectId: 'retired', versionId: 'source-v1', versionName: '1.0', fileName: 'retired-source.jar', sha256: createHash('sha256').update(retired).digest('hex'), size: retired.length, side: 'both', sources: ['https://example.test/retired-source.jar'], installedAt: new Date().toISOString() }
    ]
  })
  await fs.mkdir(path.join(source, 'overrides', 'config'), { recursive: true })
  await fs.writeFile(path.join(source, 'overrides', 'config', 'author-tuning.toml'), 'difficulty = 4\n', 'utf8')
  return { root, pack }
}

describe('modpack migration service', () => {
  it('classifies official target files and replacement candidates separately', async () => {
    const { pack } = await sourcePack()
    const progress: string[] = []
    const assessment = await assessModpackMigration(registry(), pack, target, (event) => progress.push(`${event.phase}:${event.completed}/${event.total}`))
    expect(assessment.mods).toMatchObject([
      { sourceProjectId: 'available', status: 'compatible', compatible: { projectId: 'available', versionId: 'target-v2' } },
      { sourceProjectId: 'retired', status: 'replacement', alternatives: [{ projectId: 'replacement', versionId: 'replacement-v1' }] }
    ])
    expect(assessment.content).toMatchObject([{ kind: 'config', status: 'review', copyByDefault: true }])
    expect(assessment.summary).toMatchObject({ compatible: 1, replacement: 1, missing: 0 })
    expect(progress).toContain('identifying:2/2')
    expect(progress.at(-1)).toBe('complete:2/2')
  })

  it('uses source-version metadata search when an imported JAR has no lock or hash match', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-migration-metadata-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const jar = path.join(root, 'metadata-source.jar')
    await fs.writeFile(jar, createStoredZip([
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'metadata_mod', version: '1.0', name: 'Metadata Mod' })) },
      { name: 'dev/example/Metadata.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
      { name: 'assets/metadata_mod/padding.bin', data: Buffer.alloc(2_048, 3) }
    ]))
    await addModpackFiles(pack, [jar])
    const sourceFile = file('metadata-project', 'source-v1', 'metadata-source.jar')
    sourceFile.versionName = '1.0'
    const targetFile = file('metadata-project', 'target-v2', 'metadata-target.jar')
    const service = {
      identify: async () => [],
      search: async (query: { minecraftVersion: string }) => query.minecraftVersion === '1.20.1' ? [{
        provider: 'modrinth', total: 1,
        hits: [{ provider: 'modrinth', projectId: 'metadata-project', slug: 'metadata-mod', name: 'Metadata Mod', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 10 }]
      }] : [],
      versions: async (_provider: string, _projectId: string, query: { minecraftVersion: string }) => query.minecraftVersion === '1.20.1' ? [sourceFile] : [targetFile],
      details: async () => ({ provider: 'modrinth', projectId: 'metadata-project', slug: 'metadata-mod', name: 'Metadata Mod', projectUrl: '' })
    } as unknown as ModProviderRegistry
    const assessment = await assessModpackMigration(service, pack, target)
    expect(assessment.mods).toMatchObject([{ status: 'compatible', sourceProjectId: 'metadata-project', identityEvidence: 'metadata', compatible: { fileName: 'metadata-target.jar' } }])
  })

  it('uses MC百科 aliases to resolve a verifiable Modrinth or CurseForge project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-migration-mcmod-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const jar = path.join(root, 'localized-source.jar')
    await fs.writeFile(jar, createStoredZip([
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'localized_mod', version: '1.0', name: '本地化模组名' })) },
      { name: 'dev/example/Localized.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
      { name: 'assets/localized_mod/padding.bin', data: Buffer.alloc(2_048, 4) }
    ]))
    await addModpackFiles(pack, [jar])
    const sourceFile = file('english-project', 'source-v1', 'localized-source.jar')
    sourceFile.versionName = '1.0'
    const targetFile = file('english-project', 'target-v2', 'localized-target.jar')
    const searched: string[] = []
    const service = {
      identify: async () => [],
      search: async (query: { query: string; minecraftVersion: string }) => {
        searched.push(query.query)
        if (query.query !== 'English Project') return []
        return [{
          provider: 'modrinth', total: 1,
          hits: [{ provider: 'modrinth', projectId: 'english-project', slug: 'english-project', name: 'English Project', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 10 }]
        }]
      },
      versions: async (_provider: string, _projectId: string, query: { minecraftVersion: string }) => query.minecraftVersion === '1.20.1' ? [sourceFile] : [targetFile],
      details: async () => ({ provider: 'modrinth', projectId: 'english-project', slug: 'english-project', name: 'English Project', projectUrl: '' })
    } as unknown as ModProviderRegistry
    const mcmod = {
      search: async () => [{ projectId: '2021', name: '百科中文名 (English Project)', englishName: 'English Project', summary: '', pageUrl: 'https://www.mcmod.cn/class/2021.html' }]
    }
    const assessment = await assessModpackMigration(service, pack, target, undefined, mcmod)
    expect(searched).toContain('English Project')
    expect(assessment.mods).toMatchObject([{
      status: 'compatible',
      sourceProjectId: 'english-project',
      identityEvidence: 'mcmod',
      mcmodMatches: [{ projectId: '2021' }],
      compatible: { provider: 'modrinth', fileName: 'localized-target.jar' }
    }])
  })

  it('does not query MC百科 when Modrinth or CurseForge already has a target candidate', async () => {
    const { pack } = await sourcePack()
    let mcmodSearches = 0
    const assessment = await assessModpackMigration(registry(), pack, target, undefined, {
      search: async () => {
        mcmodSearches += 1
        return []
      }
    })
    expect(assessment.summary).toMatchObject({ compatible: 1, replacement: 1 })
    expect(mcmodSearches).toBe(0)
  })

  it('creates a new target pack from explicit decisions without modifying the source', async () => {
    const { root, pack } = await sourcePack()
    const service = registry()
    const assessment = await assessModpackMigration(service, pack, target)
    const available = assessment.mods.find((mod) => mod.sourceProjectId === 'available')!
    const retired = assessment.mods.find((mod) => mod.sourceProjectId === 'retired')!
    const decisions: ModpackMigrationModDecision[] = [
      { modId: available.id, action: 'use-compatible', candidate: available.compatible! },
      { modId: retired.id, action: 'remove' }
    ]
    const destination = path.join(root, 'target')
    const result = await createModpackMigration(service, pack, target, {
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      mods: decisions,
      modules: [],
      content: assessment.content.map((entry) => ({ kind: entry.kind, action: 'copy' }))
    }, destination, async (moduleRoot) => {
      await fs.mkdir(path.join(moduleRoot, 'gradle', 'wrapper'), { recursive: true })
      await fs.writeFile(path.join(moduleRoot, 'gradlew'), 'wrapper\n', 'utf8')
      await fs.writeFile(path.join(moduleRoot, 'gradlew.bat'), 'wrapper\r\n', 'utf8')
      await fs.writeFile(path.join(moduleRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'wrapper', 'utf8')
    })
    await expect(fs.access(path.join(destination, 'mods', 'available-target.jar'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(destination, 'mods', 'retired-source.jar'))).rejects.toThrow()
    await expect(fs.readFile(path.join(destination, 'overrides', 'config', 'author-tuning.toml'), 'utf8')).resolves.toContain('difficulty = 4')
    await expect(fs.access(result.reportPath)).resolves.toBeUndefined()
    await expect(readModpackManifest(pack)).resolves.toMatchObject({ mods: [{ fileName: 'available-source.jar' }, { fileName: 'retired-source.jar' }] })
  })

  it('rejects a migration destination nested inside the source before creating it', async () => {
    const { pack } = await sourcePack()
    const nested = path.join(pack.path, 'nested-target')
    await expect(createModpackMigration(registry(), pack, target, {
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      mods: [],
      modules: [],
      content: []
    }, nested, async () => undefined)).rejects.toThrow(/不能相同或互相嵌套/)
    await expect(fs.access(nested)).rejects.toThrow()
  })

  it('generates an incomplete pack and evidence when decisions are deferred', async () => {
    const { root, pack } = await sourcePack()
    const destination = path.join(root, 'deferred-target')
    const service = registry()
    const assessment = await assessModpackMigration(service, pack, target)
    const result = await createModpackMigration(service, pack, target, {
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      mods: [],
      modules: [],
      content: assessment.content.map((entry) => ({ kind: entry.kind, action: 'exclude' }))
    }, destination, async () => undefined)
    expect(result).toMatchObject({ status: 'incomplete', deferred: ['available-source.jar', 'retired-source.jar'] })
    await expect(fs.access(path.join(destination, 'mods', 'available-source.jar'))).rejects.toThrow()
    await expect(fs.readFile(path.join(destination, 'docs', 'modpack-migration-report.md'), 'utf8')).resolves.toContain('## Deferred source mods')
    const evidence = await fs.readdir(path.join(destination, 'docs', 'migration-evidence', 'mods'))
    expect(evidence).toHaveLength(2)
    await expect(fs.readFile(path.join(destination, 'docs', 'migration-evidence', 'mods', evidence[0]), 'utf8')).resolves.toContain('"sha256"')
  })

  it('turns a missing source project into a target-version compatibility module scaffold', async () => {
    const { root, pack } = await sourcePack()
    const service = registry() as unknown as {
      details: (provider: string, projectId: string) => Promise<Record<string, unknown>>
      search: () => Promise<unknown[]>
    }
    service.details = async (_provider, projectId) => ({
      provider: 'modrinth', projectId, slug: projectId,
      name: projectId === 'available' ? 'Available Mod' : 'Retired Feature',
      projectUrl: `https://example.test/${projectId}`,
      ...(projectId === 'retired' ? { sourceUrl: 'https://github.com/example/retired', license: 'MIT' } : {})
    })
    service.search = async () => []
    const typedService = service as unknown as ModProviderRegistry
    const assessment = await assessModpackMigration(typedService, pack, target)
    const available = assessment.mods.find((mod) => mod.sourceProjectId === 'available')!
    const retired = assessment.mods.find((mod) => mod.sourceProjectId === 'retired')!
    expect(retired).toMatchObject({ status: 'source-port', sourceLicense: 'MIT', sourceUrl: 'https://github.com/example/retired' })
    const destination = path.join(root, 'compat-target')
    const result = await createModpackMigration(typedService, pack, target, {
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      mods: [
        { modId: available.id, action: 'use-compatible', candidate: available.compatible! },
        { modId: retired.id, action: 'create-compat-module' }
      ],
      modules: [],
      content: assessment.content.map((entry) => ({ kind: entry.kind, action: 'exclude' }))
    }, destination, async (moduleRoot) => {
      await fs.mkdir(path.join(moduleRoot, 'gradle', 'wrapper'), { recursive: true })
      await fs.writeFile(path.join(moduleRoot, 'gradlew'), 'wrapper\n', 'utf8')
      await fs.writeFile(path.join(moduleRoot, 'gradlew.bat'), 'wrapper\r\n', 'utf8')
      await fs.writeFile(path.join(moduleRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'wrapper', 'utf8')
    })
    expect(result.portedModules).toEqual(['Retired Feature Compatibility'])
    await expect(fs.readFile(path.join(destination, 'modules', 'compat_retired', 'docs', 'compatibility-spec.md'), 'utf8')).resolves.toContain('Declared license: MIT')
    await expect(readModpackManifest(result.project)).resolves.toMatchObject({ modules: [{ namespace: 'compat_retired' }] })
  })

  it('accepts a user-selected target-loader JAR for manual replacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-migration-jar-'))
    roots.push(root)
    const jar = path.join(root, 'manual.jar')
    const archive = createStoredZip([
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'manual_mod', version: '2.0', name: 'Manual Mod' })) },
      { name: 'dev/example/Manual.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }
    ])
    await fs.writeFile(jar, archive)
    await expect(inspectModpackMigrationJar(jar, 'fabric')).resolves.toMatchObject({ fileName: 'manual.jar', displayName: 'Manual Mod', version: '2.0', modIds: ['manual_mod'] })
    await expect(inspectModpackMigrationJar(jar, 'forge')).rejects.toThrow(/Fabric|fabric/)
  })
})
