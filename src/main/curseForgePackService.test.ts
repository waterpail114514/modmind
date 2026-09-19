import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { curseForgePackResolver, installCurseForgePack, readCurseForgePackState, parseCurseForgeReferences, type CurseForgePackFile } from './curseForgePackService'
import * as network from './networkRequest'
import { verifiedDownload } from './downloadService'
import { inspectExternalModpack, materializeExternalModpack } from './modpackImportService'
import { adoptExternalModpack, addModpackFiles, assertModpackDependenciesReady, createModrinthPackArchive, readModpackManifest } from './modpackService'
import { readModpackLock } from './modpackLockService'
import { listModpackContent } from './modpackContentInventoryService'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-cf-test-')); roots.push(root)
  const project: ProjectInfo = { kind: 'modpack', name: 'Pack', path: path.join(root, 'project'), minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.22', namespace: 'pack', createdAt: new Date().toISOString() }
  return { root, project, cacheDirectory: path.join(root, 'cache') }
}
function file(relative: string, bytes: Buffer): CurseForgePackFile { return { path: relative, sha1: createHash('sha1').update(bytes).digest('hex'), size: bytes.length, downloads: ['https://example.test/' + relative] } }

describe('CurseForge pack imports', () => {
  it.each([[6, 'mods', 'a.jar'], [12, 'resourcepacks', 'a.zip'], [6552, 'shaderpacks', 'a.zip']])('resolves a pinned class %i file into %s', async (classId, directory, fileName) => {
    const calls: string[] = []
    vi.spyOn(network, 'fetchJsonWithRetry').mockImplementation(async (url) => {
      calls.push(url)
      return { data: url.endsWith('/files/1234') ? { id: 1234, modId: 42, fileName, fileLength: 2048, hashes: [{ algo: 1, value: 'a'.repeat(40) }] } : { id: 42, classId } } as never
    })
    const result = await curseForgePackResolver('test')({ projectID: 42, fileID: 1234, required: true })
    expect(result.path).toBe(`${directory}/${fileName}`)
    expect(calls).toContain('https://api.curseforge.com/v1/mods/42/files/1234')
    expect(result.downloads[0]).toContain('/files/1/234/')
  })

  it('rejects mismatched identity and unsafe file metadata', async () => {
    vi.spyOn(network, 'fetchJsonWithRetry').mockResolvedValue({ data: { id: 999, modId: 42, classId: 6 } })
    await expect(curseForgePackResolver('test')({ projectID: 42, fileID: 1234, required: true })).rejects.toThrow('不符')
    expect(() => parseCurseForgeReferences([{ projectID: '../x', fileID: 1 }])).toThrow()
    expect(() => parseCurseForgeReferences([{ projectID: 1, fileID: 1 }, { projectID: 1, fileID: 2 }])).toThrow('重复')
  })

  it('imports manifest-only packs, retains source, routes three types, locks versions and exports', async () => {
    const { root, project, cacheDirectory } = await setup()
    const source = path.join(root, 'source'); await fs.mkdir(source)
    const refs = [1, 2, 3].map(id => ({ projectID: id, fileID: id * 1000, required: true }))
    const original = { name: 'Pack', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.3.22' }] }, files: refs }
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(original))
    const bytes = new Map([['mods/a.jar', Buffer.alloc(2048, 1)], ['resourcepacks/r.zip', Buffer.alloc(2048, 2)], ['shaderpacks/s.zip', Buffer.alloc(2048, 3)]])
    const files = [...bytes].map(([relative, content]) => file(relative, content))
    vi.spyOn(verifiedDownload, 'download').mockImplementation(async request => {
      await fs.mkdir(path.dirname(request.destination), { recursive: true })
      const match = files.find(f => f.sha1 === request.expectedHash!.value)!
      await fs.writeFile(request.destination, bytes.get(match.path)!)
      return { bytes: match.size } as never
    })
    const inspection = await inspectExternalModpack(source)
    expect(inspection).toMatchObject({ format: 'curseforge', layout: 'archive', unresolvedDependencyCount: 3 })
    const result = await materializeExternalModpack(inspection!, project.path, { curseForge: { cacheDirectory, resolve: async ref => files[ref.projectID - 1] } })
    expect(result).toMatchObject({ downloadedFiles: 3, unresolvedDependencyCount: 0 })
    const manifest = await adoptExternalModpack(project, { format: 'curseforge', layout: 'archive', importedAt: project.createdAt })
    expect(manifest.mods).toHaveLength(1)
    expect(manifest.source?.unresolvedDependencies).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(project.path, '.modmind/import/manifest.json'), 'utf8'))).toEqual(original)
    expect((await readModpackLock(project)).mods[0]).toMatchObject({ projectId: '1', versionId: '1000', fileName: 'a.jar' })
    expect((await listModpackContent(project)).items).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'resourcepacks/r.zip', delivery: 'remote' }), expect.objectContaining({ path: 'shaderpacks/s.zip', scope: 'client' })]))
    expect((await createModrinthPackArchive(project)).length).toBeGreaterThan(0)
    await fs.rm(path.join(project.path, 'overrides/mods/a.jar'))
    await expect(assertModpackDependenciesReady(project)).rejects.toThrow('1 个必需文件')
    const manual = path.join(root, '手工补入.jar'); await fs.writeFile(manual, bytes.get('mods/a.jar')!)
    expect((await addModpackFiles(project, [manual])).source?.unresolvedDependencies).toBeUndefined()
    expect((await readModpackLock(project)).mods[0].fileName).toBe('手工补入.jar')
    expect((await readModpackManifest(project)).mods).toHaveLength(1)
    await expect(assertModpackDependenciesReady(project)).resolves.toBeTruthy()
  })

  it('keeps author overrides, never subtracts unrelated JARs, and resumes failed files', async () => {
    const { root, project, cacheDirectory } = await setup()
    const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'custom/mods'), { recursive: true })
    const local = Buffer.alloc(2048, 7), remote = Buffer.alloc(2048, 8)
    await fs.writeFile(path.join(source, 'custom/mods/local.jar'), local)
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ files: [{ projectID: 1, fileID: 100, required: true }], overrides: 'custom' }))
    const inspection = await inspectExternalModpack(source)
    expect(inspection?.unresolvedDependencyCount).toBe(1)
    const item = file('mods/remote.jar', remote)
    const download = vi.spyOn(verifiedDownload, 'download').mockRejectedValueOnce(new Error('offline')).mockImplementation(async request => {
      await fs.mkdir(path.dirname(request.destination), { recursive: true }); await fs.writeFile(request.destination, remote)
      return { bytes: remote.length } as never
    })
    const first = await materializeExternalModpack(inspection!, project.path, { curseForge: { cacheDirectory, resolve: async () => item } })
    expect(first.unresolvedDependencyCount).toBe(1)
    expect((await readCurseForgePackState(project.path))?.files[0].error).toBe('offline')
    const next = await installCurseForgePack(project.path, path.join(project.path, 'overrides'), inspection!.curseForgeReferences!, { cacheDirectory })
    expect(next.unresolvedDependencyCount).toBe(0)
    expect(download).toHaveBeenCalledTimes(2)
    await expect(fs.readFile(path.join(project.path, 'overrides/mods/local.jar'))).resolves.toEqual(local)
    await installCurseForgePack(project.path, path.join(project.path, 'overrides'), inspection!.curseForgeReferences!, { cacheDirectory })
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a local patch with a platform file at the same path', async () => {
    const { project, cacheDirectory } = await setup()
    const content = path.join(project.path, 'overrides')
    await fs.mkdir(path.join(content, 'mods'), { recursive: true })
    const bytes = Buffer.alloc(2048, 1); await fs.writeFile(path.join(content, 'mods/a.jar'), bytes)
    const download = vi.spyOn(verifiedDownload, 'download')
    const result = await installCurseForgePack(project.path, content, [{ projectID: 1, fileID: 2, required: true }], { cacheDirectory, resolve: async () => file('mods/a.jar', Buffer.alloc(2048, 2)) })
    expect(result.unresolvedDependencyCount).toBe(1)
    expect(result.warnings[0]).toContain('已保留原文件')
    expect(download).not.toHaveBeenCalled()
    await expect(fs.readFile(path.join(content, 'mods/a.jar'))).resolves.toEqual(bytes)
  })

  it('discovers nested author content under the appropriate editing categories', async () => {
    const { project } = await setup()
    await adoptExternalModpack(project, { format: 'instance', layout: 'archive', importedAt: project.createdAt })
    for (const relative of ['config/ftbquests/quests/a.snbt', 'config/fancymenu/layouts/a.txt', 'config/openloader/data/test/pack.mcmeta', 'config/openloader/resources/test/pack.mcmeta', 'tacz/custom/data/a.json']) {
      const target = path.join(project.path, 'overrides', relative)
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '{}')
    }
    const items = (await listModpackContent(project)).items
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'config/ftbquests/quests/a.snbt', kind: 'quests' }),
      expect.objectContaining({ path: 'config/fancymenu/layouts/a.txt', kind: 'ui', scope: 'client' }),
      expect.objectContaining({ path: 'config/openloader/data/test/pack.mcmeta', kind: 'datapacks' }),
      expect.objectContaining({ path: 'config/openloader/resources/test/pack.mcmeta', kind: 'resourcepacks' }),
      expect.objectContaining({ path: 'tacz/custom/data/a.json', kind: 'other' })
    ]))
  })

  it('persists cancellation and does not mark unrelated files as satisfied', async () => {
    const { project, cacheDirectory } = await setup()
    const controller = new AbortController()
    controller.abort()
    const refs = [{ projectID: 1, fileID: 2, required: true }, { projectID: 3, fileID: 4, required: true }]
    await expect(installCurseForgePack(project.path, path.join(project.path, 'overrides'), refs, { signal: controller.signal, cacheDirectory })).rejects.toThrow()
    const state = await readCurseForgePackState(project.path)
    expect(state?.files).toHaveLength(2)
    expect(state?.files.every(entry => entry.status !== 'installed')).toBe(true)
  })
})
