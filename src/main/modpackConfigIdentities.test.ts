import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { createStoredZip } from './bedrockAddon'
import { modpackConfigIdentities, modpackContentFeatures } from './modpackConfigIdentities'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it.each(['archive', 'instance', 'workspace'])('reads installed mod IDs in the %s layout and refreshes changed JARs', async layout => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-config-mods-'))
  roots.push(root)
  const project = { path: root, kind: 'modpack', name: 'Fixture', loader: 'fabric', minecraftVersion: '1.21.1' } as ProjectInfo
  await fs.writeFile(path.join(root, 'modmind.pack.json'), JSON.stringify({ version: 1, name: project.name, loader: project.loader, minecraftVersion: project.minecraftVersion, mods: [], modules: [{ name: 'Local', namespace: 'local', path: 'modules/local', createdAt: '' }], source: { format: 'modrinth', layout, importedAt: '' } }))
  const mods = path.join(root, ...(layout === 'archive' ? ['overrides', 'mods'] : ['mods']))
  await fs.mkdir(mods, { recursive: true })
  const jar = path.join(mods, 'unrelated-filename.jar')
  const writeMod = async (id: string): Promise<void> => {
    await fs.writeFile(jar, createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id, name: id, version: '1' })) }]))
  }
  await writeMod('create')
  await fs.writeFile(path.join(mods, 'broken.jar'), 'invalid archive')
  expect((await modpackConfigIdentities(project)).map(mod => mod.id)).toEqual(['create', 'local'])
  await writeMod('another_mod')
  expect((await modpackConfigIdentities(project)).map(mod => mod.id)).toEqual(['another_mod', 'local'])
  expect(await modpackContentFeatures(project)).toEqual({ ftbQuests: false, patchouli: false })
  await writeMod('ftbquests')
  expect(await modpackContentFeatures(project)).toEqual({ ftbQuests: true, patchouli: false })
  await writeMod('patchouli')
  expect(await modpackContentFeatures(project)).toEqual({ ftbQuests: false, patchouli: true })
  await fs.unlink(jar)
  const content = layout === 'instance' ? root : path.join(root, 'overrides')
  await fs.mkdir(path.join(content, 'config/ftbquests/quests'), { recursive: true })
  await fs.mkdir(path.join(content, 'kubejs/data/test/patchouli_books'), { recursive: true })
  expect(await modpackContentFeatures(project)).toEqual({ ftbQuests: true, patchouli: true })
})
