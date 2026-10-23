import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProjectInfo, ModpackImportSource } from '../shared/types'
import { createStoredZip } from './bedrockAddon'
import { addModpackModule, createModpackTemplate, readModpackManifest, refreshModpackMods, writeModpackManifest } from './modpackService'
import { auditModpackLock, createEmptyModpackLock, writeModpackLock } from './modpackLockService'
import { modpackModsRoot } from './modpackPaths'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-mod-refresh-'))
  roots.push(root)
  const project: ProjectInfo = { path: root, kind: 'modpack', name: 'Pack', namespace: 'pack', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  await createModpackTemplate(project)
  return project
}

function jar(id: string): Buffer {
  return createStoredZip([
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id, version: '1.0.0' })) },
    { name: 'padding.bin', data: Buffer.alloc(2048) }
  ])
}

it.each(['workspace', 'instance', 'archive'] as const)('refreshes 60 to 118 local mods and persists them in the %s layout', async layout => {
  const project = await fixture()
  const source: ModpackImportSource = { format: 'modrinth', layout, importedAt: '2026-10-01T00:00:00Z' }
  await writeModpackManifest(project, { ...await readModpackManifest(project), source })
  await addModpackModule(project, { name: 'Core', namespace: 'core', path: 'modules/core', side: 'client', createdAt: '' })
  const directory = modpackModsRoot(project, source)
  await fs.mkdir(directory, { recursive: true })
  const add = (index: number): Promise<void> => fs.writeFile(path.join(directory, `mod-${index}.jar`), jar(`mod_${index}`))
  await Promise.all(Array.from({ length: 60 }, (_, index) => add(index)))
  const first = await refreshModpackMods(project)
  expect(first.mods).toHaveLength(60)
  await Promise.all(Array.from({ length: 58 }, (_, index) => add(index + 60)))
  await fs.writeFile(path.join(directory, 'ignored.jar.disabled'), jar('disabled'))
  await fs.mkdir(path.join(directory, 'nested'))
  await fs.writeFile(path.join(directory, 'nested', 'nested.jar'), jar('nested'))
  if (layout === 'archive') await fs.writeFile(path.join(project.path, 'mods', 'wrong-root.jar'), jar('wrong'))
  const refreshed = await refreshModpackMods(project)
  expect(refreshed.mods).toHaveLength(118)
  expect(refreshed.source).toEqual(source)
  expect(refreshed.modules).toEqual(first.modules)
  expect(refreshed.mods.find(mod => mod.fileName === 'mod-0.jar')?.addedAt).toBe(first.mods.find(mod => mod.fileName === 'mod-0.jar')?.addedAt)
  expect(await readModpackManifest(project)).toEqual(refreshed)
  const before = await fs.stat(path.join(project.path, 'modmind.pack.json'))
  const [one, two] = await Promise.all([refreshModpackMods(project), refreshModpackMods(project)])
  expect(one).toEqual(two)
  expect((await fs.stat(path.join(project.path, 'modmind.pack.json'))).mtimeMs).toBe(before.mtimeMs)
})

it('detects same-size replacements and removals without rewriting upstream audit evidence', async () => {
  const project = await fixture()
  const directory = path.join(project.path, 'mods')
  await fs.writeFile(path.join(directory, 'kept.jar'), jar('kept'))
  await fs.writeFile(path.join(directory, 'gone.jar'), jar('gone'))
  const first = await refreshModpackMods(project)
  await writeModpackLock(project, { ...createEmptyModpackLock(project), mods: first.mods.map(mod => ({ ...mod, provider: 'modrinth', projectId: mod.fileName, versionId: 'v1', versionName: 'v1', side: 'both', sources: ['https://example.test/mod.jar'], installedAt: mod.addedAt })) })
  const lockPath = path.join(project.path, 'modmind.modpack.lock.json')
  const lock = await fs.readFile(lockPath, 'utf8')
  const originalStat = await fs.stat(path.join(directory, 'kept.jar'))
  const replacement = jar('edit')
  await fs.writeFile(path.join(directory, 'kept.jar'), replacement)
  await fs.utimes(path.join(directory, 'kept.jar'), originalStat.atime, originalStat.mtime)
  await fs.unlink(path.join(directory, 'gone.jar'))
  const refreshed = await refreshModpackMods(project)
  expect(refreshed.mods).toEqual([{ ...first.mods.find(mod => mod.fileName === 'kept.jar'), sha256: createHash('sha256').update(replacement).digest('hex') }])
  expect(await fs.readFile(lockPath, 'utf8')).toBe(lock)
  expect(await auditModpackLock(project)).toMatchObject({ success: false, checked: 2, errors: expect.arrayContaining(['missing gone.jar', 'sha256 mismatch kept.jar']) })
})

it('keeps the stored manifest on scan errors, allows retry, and handles an absent mods directory', async () => {
  const project = await fixture()
  const directory = path.join(project.path, 'mods')
  await fs.writeFile(path.join(directory, 'good.jar'), jar('good'))
  await refreshModpackMods(project)
  const manifestPath = path.join(project.path, 'modmind.pack.json')
  const before = await fs.readFile(manifestPath, 'utf8')
  await fs.writeFile(path.join(directory, 'broken.jar'), '')
  await expect(refreshModpackMods(project)).rejects.toThrow('broken.jar')
  expect(await fs.readFile(manifestPath, 'utf8')).toBe(before)
  await fs.unlink(path.join(directory, 'broken.jar'))
  expect((await refreshModpackMods(project)).mods).toHaveLength(1)
  await fs.rename(directory, path.join(project.path, 'saved-mods'))
  await fs.writeFile(directory, 'not a directory')
  await expect(refreshModpackMods(project)).rejects.toThrow()
  expect(await fs.readFile(manifestPath, 'utf8')).toBe(before)
  await fs.unlink(directory)
  expect((await refreshModpackMods(project)).mods).toEqual([])
})
