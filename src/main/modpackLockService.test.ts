import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { createEmptyModpackLock, manageModpackLock, matchesLockedMod, MODPACK_LOCK_FILE, readModpackLock, upsertLockedMod, writeModpackLock, type LockedMod } from './modpackLockService'
import { addModpackFiles, createModpackTemplate, readModpackManifest, reconcileImportedModpack, writeModpackManifest } from './modpackService'
import { writeCurseForgePackState } from '../../feature-plugins/modpack-mods/src/main/curseForgePackService'

const roots: string[] = []
const bytes = Buffer.alloc(2048, 8)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const filename = 'create-1.20.1-6.0.8.jar'
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-lock-test-'))
  roots.push(root)
  const project: ProjectInfo = { kind: 'modpack', name: 'Lock', path: root, namespace: 'lock_test', loader: 'forge', minecraftVersion: '1.20.1', createdAt: '' }
  await createModpackTemplate(project)
  await fs.writeFile(path.join(root, 'mods', filename), bytes)
  await addModpackFiles(project, [path.join(root, 'mods', filename)])
  return project
}
function record(provider: 'modrinth' | 'curseforge', patch: Partial<LockedMod> = {}): LockedMod {
  return { provider, projectId: provider === 'modrinth' ? 'create' : '12345', versionId: '608', versionName: '6.0.8', fileName: filename, sha256, size: bytes.length, side: 'both', sources: [`https://example.test/${provider}.jar`], installedAt: '', ...patch }
}
async function legacy(project: ProjectInfo, mods: LockedMod[]): Promise<string> {
  const text = JSON.stringify({ ...createEmptyModpackLock(project), mods })
  await fs.writeFile(path.join(project.path, MODPACK_LOCK_FILE), text)
  return text
}

describe('modpack lock integrity and recovery', () => {
  it('coalesces identical cross-provider files while retaining identities, sources and dependencies', async () => {
    const project = await fixture()
    const left = record('modrinth', { dependencies: [{ provider: 'modrinth', projectId: 'api', kind: 'required' }] })
    const right = record('curseforge', { dependencies: [{ provider: 'curseforge', projectId: '42', kind: 'required' }] })
    const lock = await writeModpackLock(project, { ...createEmptyModpackLock(project), mods: [left, right] })
    expect(lock.mods).toHaveLength(1)
    expect(matchesLockedMod(lock.mods[0], right)).toBe(true)
    expect(lock.mods[0].sources).toHaveLength(2)
    expect(lock.mods[0].dependencies).toHaveLength(2)
    expect((await readModpackLock(project)).mods[0].aliases).toEqual([expect.objectContaining({ provider: 'curseforge', projectId: '12345' })])
    // An alias also owns its project during an upgrade; old identities must not claim new bytes.
    const upgraded = upsertLockedMod(lock.mods, record('curseforge', { versionId: '609', fileName: 'create-609.jar', sha256: '9'.repeat(64) }))
    expect(upgraded).toHaveLength(1)
    expect(upgraded[0]).toMatchObject({ provider: 'curseforge', versionId: '609', aliases: [] })
  })

  it('rejects conflicting bytes and duplicate projects before replacing a valid lock', async () => {
    const project = await fixture()
    const lock = await writeModpackLock(project, { ...createEmptyModpackLock(project), mods: [record('modrinth')] })
    const before = await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')
    await expect(writeModpackLock(project, { ...lock, mods: [...lock.mods, record('curseforge', { fileName: filename.toUpperCase(), sha256: '1'.repeat(64) })] })).rejects.toThrow(/内容不同/)
    await expect(writeModpackLock(project, { ...lock, mods: [...lock.mods, record('modrinth', { fileName: 'other.jar' })] })).rejects.toThrow(/重复平台项目/)
    expect(await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')).toBe(before)
    expect((await fs.readdir(project.path)).some((file) => file.includes('.pending-'))).toBe(false)
  })

  it('reads equivalent legacy records without mutation, then explicitly repairs with an exact backup', async () => {
    const project = await fixture()
    const original = await legacy(project, [record('modrinth'), record('curseforge')])
    expect(await readModpackLock(project)).toMatchObject({ repairNeeded: true, mods: [expect.objectContaining({ fileName: filename })] })
    expect(await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')).toBe(original)
    expect(await manageModpackLock(project, { operation: 'inspect' })).toMatchObject({ success: false, canRepair: true, duplicateFiles: [filename], repaired: false })
    const result = await manageModpackLock(project, { operation: 'repair' })
    expect(result).toMatchObject({ success: true, repaired: true, records: 1 })
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe(original)
    expect((await readModpackLock(project)).repairNeeded).toBeUndefined()
    expect(await fs.readFile(path.join(project.path, 'mods', filename))).toEqual(bytes)
    const again = await manageModpackLock(project, { operation: 'repair' })
    expect(again).toMatchObject({ success: true, repaired: false })
    expect((await fs.readdir(path.dirname(result.backupPath!)))).toHaveLength(1)
  })

  it('resolves conflicting legacy hashes only to an identity matching the actual JAR', async () => {
    const project = await fixture()
    const original = await legacy(project, [record('modrinth', { sha256: '1'.repeat(64) }), record('curseforge')])
    await expect(readModpackLock(project)).rejects.toThrow(/内容不同/)
    expect((await manageModpackLock(project, { operation: 'repair' })).repaired).toBe(true)
    expect((await readModpackLock(project)).mods).toEqual([expect.objectContaining({ provider: 'curseforge', sha256 })])
    expect(original).toContain('modrinth')
  })

  it('backs up legacy duplicates when the next managed write normalizes them', async () => {
    const project = await fixture()
    const original = await legacy(project, [record('modrinth'), record('curseforge')])
    await writeModpackLock(project, await readModpackLock(project))
    const folder = path.join(project.path, '.modmind/lock-backups')
    expect(await fs.readdir(folder)).toHaveLength(1)
    expect(await fs.readFile(path.join(folder, (await fs.readdir(folder))[0]), 'utf8')).toBe(original)
    expect((await readModpackLock(project)).mods).toHaveLength(1)
  })

  it('keeps the broken lock unchanged if its backup cannot be created', async () => {
    const project = await fixture()
    const original = await legacy(project, [record('modrinth'), record('curseforge')])
    await fs.mkdir(path.join(project.path, '.modmind'), { recursive: true })
    await fs.writeFile(path.join(project.path, '.modmind/lock-backups'), 'blocked')
    await expect(manageModpackLock(project, { operation: 'repair' })).rejects.toThrow()
    expect(await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')).toBe(original)
  })

  it('serializes concurrent repairs and uses the archive mods location', async () => {
    const project = await fixture()
    await fs.mkdir(path.join(project.path, 'overrides/mods'), { recursive: true })
    await fs.rename(path.join(project.path, 'mods', filename), path.join(project.path, 'overrides/mods', filename))
    await writeModpackManifest(project, { ...await readModpackManifest(project), source: { format: 'modrinth', layout: 'archive', importedAt: '' } })
    await legacy(project, [record('modrinth'), record('curseforge')])
    const results = await Promise.all([manageModpackLock(project, { operation: 'repair' }), manageModpackLock(project, { operation: 'repair' })])
    expect(results.every((result) => result.success)).toBe(true)
    expect(results.filter((result) => result.repaired)).toHaveLength(1)
    expect(await fs.readdir(path.join(project.path, '.modmind/lock-backups'))).toHaveLength(1)
  })

  it.each(['unmatched', 'missing'])('leaves the original lock and files unchanged when repair is %s', async (mode) => {
    const project = await fixture()
    const original = await legacy(project, [record('modrinth', { sha256: '1'.repeat(64) }), record('curseforge', { sha256: '2'.repeat(64) })])
    if (mode === 'missing') await fs.unlink(path.join(project.path, 'mods', filename))
    const result = await manageModpackLock(project, { operation: 'repair' })
    expect(result).toMatchObject({ success: false, canRepair: false, repaired: false, errors: [expect.objectContaining({ fileName: filename })] })
    expect(await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')).toBe(original)
    await expect(fs.access(path.join(project.path, '.modmind/lock-backups'))).rejects.toThrow()
    if (mode === 'unmatched') expect(await fs.readFile(path.join(project.path, 'mods', filename))).toEqual(bytes)
  })

  it('reconciles CurseForge imports repeatedly without poisoning a Modrinth lock or losing aliases', async () => {
    const project = await fixture()
    await writeModpackLock(project, { ...createEmptyModpackLock(project), mods: [record('modrinth')] })
    await writeModpackManifest(project, { ...await readModpackManifest(project), source: { format: 'curseforge', layout: 'instance', importedAt: '' } })
    await writeCurseForgePackState(project.path, { version: 1, files: [{ projectID: 12345, fileID: 608, required: true, status: 'installed', installedPath: `mods/${filename}`, file: { path: `mods/${filename}`, size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex'), downloads: ['https://example.test/create.jar'] } }] })
    await reconcileImportedModpack(project)
    await reconcileImportedModpack(project)
    const lock = await readModpackLock(project)
    expect(lock.mods).toHaveLength(1)
    expect(matchesLockedMod(lock.mods[0], { provider: 'curseforge', projectId: '12345', versionId: '608' })).toBe(true)
    expect(lock.mods[0].sha256).toBe(sha256)
    expect(lock.repairNeeded).toBeUndefined()
  })

  it('rejects unknown operations and user-supplied paths', async () => {
    const project = await fixture()
    await expect(manageModpackLock(project, { operation: 'rebuild' })).rejects.toThrow(/inspect 或 repair/)
    await expect(manageModpackLock(project, { operation: 'repair', path: '../outside.json' })).rejects.toThrow(/外部路径/)
  })
})
