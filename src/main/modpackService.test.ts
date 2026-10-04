import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, readModpackManifest, readModpackImportStatus, removeModpackFile, removeModpackModule, syncModpackOverrides, syncReloadableKubeJsScripts, updateModpackModuleSide } from './modpackService'
import { auditModpackLock, createEmptyModpackLock, readModpackLock, writeModpackLock } from './modpackLockService'
import { inspectExternalModpack, materializeExternalModpack } from './modpackImportService'
import { readManagedModpackContent } from './modpackContentInventoryService'

const roots: string[] = []

function project(root: string): ProjectInfo {
  return {
    kind: 'modpack',
    name: 'Pack Test',
    path: root,
    loader: 'fabric',
    minecraftVersion: '1.21.1',
    namespace: 'pack_test',
    createdAt: '2026-08-11T00:00:00.000Z'
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('modpack manifests', () => {
  it('removes pack-owned modules and only unlinks external modules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-remove-module-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path)
    await createModpackTemplate(info)
    const owned = path.join(info.path, 'modules', 'broken')
    const external = path.join(root, 'external')
    await fs.mkdir(owned)
    await fs.mkdir(external)
    await fs.writeFile(path.join(owned, 'source.txt'), 'broken')
    await fs.writeFile(path.join(external, 'source.txt'), 'keep')
    await addModpackModule(info, { name: 'Broken', namespace: 'broken', path: 'modules/broken', createdAt: info.createdAt })
    await addModpackModule(info, { name: 'External', namespace: 'external', path: external, linked: true, createdAt: info.createdAt })
    const trashed: string[] = []
    const trash = async (target: string): Promise<void> => { trashed.push(target); await fs.rm(target, { recursive: true }) }
    await expect(removeModpackModule(info, 'broken', trash)).resolves.toMatchObject({ modules: [expect.objectContaining({ namespace: 'external' })] })
    await expect(fs.access(owned)).rejects.toThrow()
    await expect(removeModpackModule(info, 'external', trash)).resolves.toMatchObject({ modules: [] })
    expect(trashed).toEqual([owned])
    await expect(fs.readFile(path.join(external, 'source.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('keeps a module registered when moving its source to trash fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-remove-failure-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path)
    await createModpackTemplate(info)
    await fs.mkdir(path.join(info.path, 'modules', 'broken'))
    await addModpackModule(info, { name: 'Broken', namespace: 'broken', path: 'modules/broken', createdAt: info.createdAt })
    await expect(removeModpackModule(info, 'broken', async () => { throw new Error('trash failed') })).rejects.toThrow('trash failed')
    await expect(readModpackManifest(info)).resolves.toMatchObject({ modules: [expect.objectContaining({ namespace: 'broken' })] })
  })

  it('preserves verified MRPack provenance and remote records through adoption and export', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-mrpack-provenance-'))
    roots.push(root)
    const source = path.join(root, 'source')
    const info = project(path.join(root, 'project'))
    const bytes = Buffer.alloc(2048, 7)
    const hashes = { sha1: createHash('sha1').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('hex') }
    const files = [
      { path: 'mods/official.jar', downloads: ['https://cdn.modrinth.com/data/Abc12345/versions/Xyz12345/official.jar'], hashes, env: { client: 'required', server: 'unsupported' } },
      { path: 'mods/external.jar', downloads: ['https://example.test/data/Abc12345/versions/Xyz12345/external.jar'], hashes },
      { path: 'resourcepacks/With Spaces.zip', downloads: ['https://cdn.modrinth.com/data/Resource/versions/Version1/With%20Spaces.zip'], hashes: { sha512: hashes.sha512 }, env: { client: 'required', server: 'required' } }
    ]
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(source, file.path)), { recursive: true })
      await fs.writeFile(path.join(source, file.path), bytes)
    }
    const index = JSON.stringify({ name: 'Imported', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.19.3' }, files })
    await fs.writeFile(path.join(source, 'modrinth.index.json'), index)
    await fs.mkdir(path.join(source, '.modmind/import'), { recursive: true })
    await fs.writeFile(path.join(source, '.modmind/import/source-archive.json'), '{"sha256":"original"}')
    const inspection = (await inspectExternalModpack(source))!
    await materializeExternalModpack(inspection, info.path, { trackDownloadActivities: false })
    await adoptExternalModpack(info, { format: 'modrinth', layout: inspection.layout, importedAt: '2026-09-19T00:00:00.000Z' })
    expect(await fs.readFile(path.join(info.path, '.modmind/import/modrinth.index.json'), 'utf8')).toBe(index)
    expect(await fs.readFile(path.join(info.path, '.modmind/import/source-archive.json'), 'utf8')).toBe('{"sha256":"original"}')
    const lock = await readModpackLock(info)
    expect(lock.mods).toEqual([expect.objectContaining({ projectId: 'Abc12345', versionId: 'Xyz12345', side: 'client', sources: files[0].downloads })])
    expect(await auditModpackLock(info)).toEqual({ success: true, checked: 1, errors: [] })
    expect((await readManagedModpackContent(info)).items).toEqual(expect.arrayContaining([expect.objectContaining({ path: files[2].path, delivery: 'remote', scope: 'common', sha1: hashes.sha1 })]))
    const archive = path.join(root, 'roundtrip.mrpack')
    await fs.writeFile(archive, await createModrinthPackArchive(info))
    const extracted = path.join(root, 'roundtrip')
    await extractZip(archive, { dir: extracted })
    const exported = JSON.parse(await fs.readFile(path.join(extracted, 'modrinth.index.json'), 'utf8'))
    expect(exported.files).toHaveLength(2)
    expect(exported.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: files[0].path, downloads: files[0].downloads, hashes, env: files[0].env }),
      expect.objectContaining({ path: files[2].path, downloads: files[2].downloads, hashes, env: files[2].env })
    ]))
    await expect(fs.readFile(path.join(extracted, 'overrides/mods/external.jar'))).resolves.toEqual(bytes)
    await expect(fs.access(path.join(extracted, 'overrides/mods/official.jar'))).rejects.toThrow()
    // A preserved manifest must never assign upstream identity to different bytes.
    await fs.writeFile(path.join(info.path, 'mods/official.jar'), Buffer.alloc(2048, 8))
    await expect(adoptExternalModpack(info, { format: 'modrinth', layout: inspection.layout, importedAt: '2026-09-19T00:00:00.000Z' })).rejects.toThrow(/来源校验失败/)
  })

  it('locks imported JARs and tracks editable local modules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-'))
    roots.push(root)
    const source = path.join(root, 'example.jar')
    const bytes = Buffer.alloc(2_048, 7)
    await fs.writeFile(source, bytes)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path)
    await createModpackTemplate(info)

    const imported = await addModpackFiles(info, [source])
    expect(imported.mods).toEqual([expect.objectContaining({
      fileName: 'example.jar', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
    })])
    await expect(fs.readFile(path.join(info.path, 'mods', 'example.jar'))).resolves.toEqual(bytes)

    const withModule = await addModpackModule(info, {
      name: 'Core', namespace: 'core', path: 'modules/core', createdAt: '2026-08-11T00:00:00.000Z'
    })
    expect(withModule.modules).toEqual([expect.objectContaining({ namespace: 'core', side: 'both' })])

    const clientOnly = await updateModpackModuleSide(info, 'core', 'client')
    expect(clientOnly.modules).toEqual([expect.objectContaining({ namespace: 'core', side: 'client' })])
    await expect(readModpackManifest(info)).resolves.toMatchObject({ modules: [{ namespace: 'core', side: 'client' }] })

    const removed = await removeModpackFile(info, 'example.jar')
    expect(removed.mods).toEqual([])
    await expect(fs.stat(path.join(info.path, 'mods', 'example.jar'))).rejects.toThrow()
    await expect(readModpackManifest(info)).resolves.toMatchObject({ modules: [{ namespace: 'core' }] })
  })

  it('exports managed mods, built local modules, and overrides in a Modrinth archive', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-export-'))
    roots.push(root)
    const source = path.join(root, 'example.jar')
    await fs.writeFile(source, Buffer.alloc(2_048, 5))
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path)
    await createModpackTemplate(info)
    await addModpackFiles(info, [source])
    await addModpackModule(info, { name: 'Core', namespace: 'core', path: 'modules/core', createdAt: '2026-08-11T00:00:00.000Z' })
    await fs.mkdir(path.join(info.path, 'modules', 'core', 'build', 'libs'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'modules', 'core', 'build', 'libs', 'core-1.0.0.jar'), Buffer.alloc(2_048, 9))
    await fs.writeFile(path.join(info.path, 'overrides', 'config', 'example.json'), '{"enabled":true}\n', 'utf8')
    await fs.mkdir(path.join(info.path, 'overrides', 'modmind-images'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'overrides', 'modmind-images', 'generated.png'), Buffer.alloc(16, 4))

    const archive = await createModrinthPackArchive(info)
    const content = archive.toString('utf8')
    expect(content).toContain('modrinth.index.json')
    expect(content).toContain('overrides/mods/example.jar')
    expect(content).toContain('overrides/mods/modmind-local-core.jar')
    expect(content).toContain('overrides/config/example.json')
    expect(content).toContain('overrides/modmind-images/generated.png')
  })

  it('emits locked Mod downloads as standard Modrinth file records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-remote-export-'))
    roots.push(root)
    const source = path.join(root, 'remote.jar')
    const bytes = Buffer.alloc(2_048, 8)
    await fs.writeFile(source, bytes)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path)
    await createModpackTemplate(info)
    await addModpackFiles(info, [source])
    await writeModpackLock(info, {
      ...createEmptyModpackLock(info),
      mods: [{ provider: 'modrinth', projectId: 'remote', versionId: '1', versionName: '1.0.0', fileName: 'remote.jar', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, side: 'both', sources: ['https://cdn.example.test/remote.jar'], installedAt: '2026-08-16T00:00:00.000Z' }]
    })

    const archive = await createModrinthPackArchive(info, { version: '1.2.3', summary: 'Remote delivery test' })
    const archivePath = path.join(root, 'pack.mrpack')
    const extracted = path.join(root, 'extracted')
    await fs.writeFile(archivePath, archive)
    await extractZip(archivePath, { dir: extracted })
    const index = JSON.parse(await fs.readFile(path.join(extracted, 'modrinth.index.json'), 'utf8')) as { versionId: string; summary: string; files: Array<{ path: string; downloads: string[]; hashes: Record<string, string> }> }

    expect(index.versionId).toBe('1.2.3')
    expect(index.summary).toBe('Remote delivery test')
    expect(index.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'mods/remote.jar', downloads: ['https://cdn.example.test/remote.jar'], hashes: expect.objectContaining({ sha1: expect.any(String), sha512: expect.any(String) }) })]))
    await expect(fs.access(path.join(extracted, 'overrides', 'mods', 'remote.jar'))).rejects.toThrow()
  })

  it('syncs adopted instance layout files without copying the source mods twice', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-instance-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await fs.mkdir(path.join(info.path, 'mods'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'mods', 'existing.jar'), Buffer.alloc(2_048, 3))
    await fs.mkdir(path.join(info.path, 'kubejs', 'server_scripts'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'kubejs', 'server_scripts', 'main.js'), 'ServerEvents.recipes(() => {})\n', 'utf8')
    const adopted = await adoptExternalModpack(info, { format: 'instance', layout: 'instance', importedAt: '2026-08-11T00:00:00.000Z' })
    expect(adopted.source).toMatchObject({ format: 'instance', layout: 'instance' })

    const runtime = path.join(root, 'runtime')
    const copied = await syncModpackOverrides(info, runtime)
    expect(copied).toContain('kubejs/server_scripts/main.js')
    await expect(fs.stat(path.join(runtime, 'kubejs', 'server_scripts', 'main.js'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(runtime, 'mods', 'existing.jar'))).rejects.toThrow()
  })

  it('hot-syncs only changed KubeJS server scripts and removes only previously managed scripts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-kubejs-sync-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    const overrides = path.join(info.path, 'overrides')
    const runtime = path.join(root, 'runtime')
    for (const dir of ['kubejs/server_scripts', 'kubejs/client_scripts', 'kubejs/startup_scripts', 'config']) {
      await fs.mkdir(path.join(overrides, dir), { recursive: true })
      await fs.mkdir(path.join(runtime, dir), { recursive: true })
    }
    await fs.writeFile(path.join(overrides, 'kubejs/server_scripts/recipe.js'), 'new recipe')
    await fs.writeFile(path.join(overrides, 'kubejs/client_scripts/client.js'), 'new client')
    await fs.writeFile(path.join(overrides, 'kubejs/startup_scripts/startup.js'), 'new startup')
    await fs.writeFile(path.join(overrides, 'config/settings.toml'), 'new config')
    await fs.writeFile(path.join(runtime, 'kubejs/server_scripts/old.js'), 'old recipe')
    await fs.writeFile(path.join(runtime, 'kubejs/server_scripts/user.js'), 'user recipe')
    await fs.writeFile(path.join(runtime, 'kubejs/client_scripts/client.js'), 'old client')
    await fs.writeFile(path.join(runtime, 'config/settings.toml'), 'old config')

    const previous = ['kubejs/server_scripts/old.js', 'kubejs/client_scripts/client.js', 'config/settings.toml']
    const first = await syncReloadableKubeJsScripts(info, runtime, previous)
    expect(first.copied).toEqual(['kubejs/server_scripts/recipe.js'])
    expect(first.removed).toEqual(['kubejs/server_scripts/old.js'])
    expect(first.overrides).toEqual(['kubejs/client_scripts/client.js', 'config/settings.toml', 'kubejs/server_scripts/recipe.js'])
    await expect(fs.readFile(path.join(runtime, 'kubejs/server_scripts/recipe.js'), 'utf8')).resolves.toBe('new recipe')
    await expect(fs.access(path.join(runtime, 'kubejs/server_scripts/old.js'))).rejects.toThrow()
    await expect(fs.readFile(path.join(runtime, 'kubejs/server_scripts/user.js'), 'utf8')).resolves.toBe('user recipe')
    await expect(fs.readFile(path.join(runtime, 'kubejs/client_scripts/client.js'), 'utf8')).resolves.toBe('old client')
    await expect(fs.readFile(path.join(runtime, 'config/settings.toml'), 'utf8')).resolves.toBe('old config')
    await expect(fs.access(path.join(runtime, 'kubejs/startup_scripts/startup.js'))).rejects.toThrow()
    const second = await syncReloadableKubeJsScripts(info, runtime, first.overrides)
    expect(second.copied).toEqual([])
    expect(second.removed).toEqual([])
  })

  it('rejects hot sync through a linked instance directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-kubejs-link-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path, { recursive: true })
    await createModpackTemplate(info)
    await fs.mkdir(path.join(info.path, 'overrides/kubejs/server_scripts'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'overrides/kubejs/server_scripts/recipe.js'), 'new recipe')
    const runtime = path.join(root, 'runtime')
    const elsewhere = path.join(root, 'elsewhere')
    await fs.mkdir(runtime)
    await fs.mkdir(elsewhere)
    await fs.symlink(elsewhere, path.join(runtime, 'kubejs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(syncReloadableKubeJsScripts(info, runtime, [])).rejects.toThrow(/链接/)
    await expect(fs.access(path.join(elsewhere, 'server_scripts/recipe.js'))).rejects.toThrow()
    await fs.rm(path.join(runtime, 'kubejs'), { recursive: false, force: true })
    await fs.mkdir(path.join(runtime, 'kubejs/server_scripts'), { recursive: true })
    const linkedFile = path.join(elsewhere, 'recipe.js')
    await fs.writeFile(linkedFile, 'outside')
    await fs.link(linkedFile, path.join(runtime, 'kubejs/server_scripts/recipe.js'))
    await expect(syncReloadableKubeJsScripts(info, runtime, [])).rejects.toThrow(/链接/)
    await expect(fs.readFile(linkedFile, 'utf8')).resolves.toBe('outside')
  })

  it('keeps Modrinth archive mods, overrides, and exports in their archive roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-archive-layout-'))
    roots.push(root)
    const info = project(path.join(root, 'pack'))
    const bytes = Buffer.alloc(2_048, 3)
    await fs.mkdir(path.join(info.path, 'overrides', 'mods'), { recursive: true })
    await fs.mkdir(path.join(info.path, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(info.path, 'overrides', 'mods', 'archive.jar'), bytes)
    await fs.writeFile(path.join(info.path, 'overrides', 'mods', 'glore_blocks.json'), '{"enabled":true}')
    await fs.writeFile(path.join(info.path, 'overrides', 'config', 'author.toml'), 'enabled=true\n', 'utf8')

    const adopted = await adoptExternalModpack(info, { format: 'modrinth', layout: 'archive', importedAt: '2026-08-16T00:00:00.000Z' })
    expect(adopted.mods).toEqual([expect.objectContaining({ fileName: 'archive.jar', size: bytes.length })])

    const runtime = path.join(root, 'runtime')
    const copied = await syncModpackOverrides(info, runtime)
    expect(copied).toContain('config/author.toml')
    expect(copied).not.toContain('mods/archive.jar')
    expect(copied).toContain('mods/glore_blocks.json')
    await expect(fs.readFile(path.join(runtime, 'mods', 'glore_blocks.json'), 'utf8')).resolves.toContain('enabled')
    await expect(fs.readFile(path.join(runtime, 'config', 'author.toml'), 'utf8')).resolves.toContain('enabled')

    const archive = await createModrinthPackArchive(info)
    const archivePath = path.join(root, 'archive.mrpack')
    const extracted = path.join(root, 'archive')
    await fs.writeFile(archivePath, archive)
    await extractZip(archivePath, { dir: extracted })
    await expect(fs.readFile(path.join(extracted, 'overrides', 'mods', 'archive.jar'))).resolves.toEqual(bytes)
    await expect(fs.readFile(path.join(extracted, 'overrides', 'config', 'author.toml'), 'utf8')).resolves.toContain('enabled')
    await expect(fs.readFile(path.join(extracted, 'overrides', 'mods', 'glore_blocks.json'), 'utf8')).resolves.toContain('enabled')
  })

  it('exposes local Modrinth import warnings without requiring a CurseForge state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-import-status-'))
    roots.push(root)
    const info = project(root)
    await adoptExternalModpack(info, { format: 'modrinth', layout: 'archive', importedAt: info.createdAt })
    expect(await readModpackImportStatus(info)).toBeNull()
    await fs.mkdir(path.join(root, '.modmind', 'import'), { recursive: true })
    await fs.writeFile(path.join(root, '.modmind', 'import', 'artifact-report.json'), JSON.stringify({ checked: 0, warnings: ['Incompatible NeoForge file'] }))
    expect(await readModpackImportStatus(info)).toEqual({ total: 0, installed: 0, requiredPending: 0, failures: [], compatibilityWarnings: ['Incompatible NeoForge file'] })
    expect(await readModpackImportStatus({ ...info, kind: 'mod' })).toBeNull()
  })

  it('does not replace a malformed manifest with an empty manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-corrupt-'))
    roots.push(root)
    const info = project(root)
    const corrupt = '{"version": 1, "mods": "not-an-array"}\n'
    await fs.writeFile(path.join(root, 'modmind.pack.json'), corrupt, 'utf8')

    await expect(readModpackManifest(info)).rejects.toThrow(/格式无效/)
    await expect(addModpackFiles(info, [path.join(root, 'missing.jar')])).rejects.toThrow(/格式无效/)
    await expect(fs.readFile(path.join(root, 'modmind.pack.json'), 'utf8')).resolves.toBe(corrupt)
  })

  it('refuses to export when a manifest-tracked Mod is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-missing-export-'))
    roots.push(root)
    const source = path.join(root, 'example.jar')
    await fs.writeFile(source, Buffer.alloc(2_048, 5))
    const info = project(path.join(root, 'pack'))
    await fs.mkdir(info.path)
    await createModpackTemplate(info)
    await addModpackFiles(info, [source])
    await fs.rm(path.join(info.path, 'mods', 'example.jar'))

    await expect(createModrinthPackArchive(info)).rejects.toThrow(/无法读取/)
  })
})
