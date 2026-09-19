import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddonRelationship } from '../shared/production'
import type { ProjectInfo } from '../shared/types'
import { syncAddonDescriptor } from './addonDescriptors'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

function relationship(id: string, role: 'required' | 'optional'): AddonRelationship {
  return { id, role, provider: 'modrinth', projectId: id, versionId: 'v1', name: id, version: '1.2.3', primaryModId: id, modIds: [id], fileName: `${id}.jar`, relativePath: `libs/modmind/${id}.jar`, installedAt: '', environment: 'both', api: { primaryModId: id, modIds: [id], displayName: id, version: '1.2.3', loader: 'fabric', classCount: 1, packages: [], sourceKind: 'jar' } }
}

describe('add-on descriptor synchronization', () => {
  it('preserves an explicit published range while refreshing the development lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'addon-range-')); roots.push(root)
    const target = path.join(root, 'src/main/resources/META-INF/neoforge.mods.toml')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'modLoader="javafml"\n[[mods]]\nmodId="addon"\nversion="1"\n')
    const project: ProjectInfo = { name: 'Addon', path: root, loader: 'neoforge', minecraftVersion: '1.21.1', namespace: 'addon', createdAt: '' }
    const old = relationship('engine', 'required')
    await syncAddonDescriptor(project, [old])
    await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('[1.2.3]', '[1.2.3,2.0)'))
    await syncAddonDescriptor(project, [{ ...old, version: '1.3.0' }, { ...old, id: 'legacy' }], [old])
    const text = await fs.readFile(target, 'utf8')
    expect(text).toContain('versionRange="[1.2.3,2.0)"')
    expect(text.match(/modId="engine"/g)).toHaveLength(1)
  })
  it('updates Fabric required and optional relationships while preserving manual entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-addon-descriptor-'))
    roots.push(root)
    const target = path.join(root, 'src', 'main', 'resources', 'fabric.mod.json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ schemaVersion: 1, id: 'addon', depends: { minecraft: '1.21.1', manual: '*' } }, null, 2))
    const project: ProjectInfo = { name: 'Addon', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'addon', createdAt: '' }
    const create = relationship('create', 'required')
    const jei = relationship('jei', 'optional')
    await syncAddonDescriptor(project, [create, jei])
    let descriptor = JSON.parse(await fs.readFile(target, 'utf8')) as { depends: Record<string, string>; suggests: Record<string, string> }
    expect(descriptor.depends).toMatchObject({ minecraft: '1.21.1', manual: '*', create: '1.2.3' })
    expect(descriptor.suggests).toMatchObject({ jei: '1.2.3' })
    await syncAddonDescriptor(project, [], [create, jei])
    descriptor = JSON.parse(await fs.readFile(target, 'utf8'))
    expect(descriptor.depends).toMatchObject({ minecraft: '1.21.1', manual: '*' })
    expect(descriptor.depends.create).toBeUndefined()
    expect(descriptor.suggests).toBeUndefined()
  })

  it('replaces one managed Forge block without duplicating it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-addon-forge-'))
    roots.push(root)
    const target = path.join(root, 'src', 'main', 'resources', 'META-INF', 'mods.toml')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'modLoader="javafml"\n[[mods]]\nmodId="addon"\nversion="1"\n')
    const project: ProjectInfo = { name: 'Addon', path: root, loader: 'forge', minecraftVersion: '1.20.1', namespace: 'addon', createdAt: '' }
    const create = { ...relationship('create', 'required'), api: { ...relationship('create', 'required').api, loader: 'forge' as const } }
    await syncAddonDescriptor(project, [create])
    await syncAddonDescriptor(project, [create], [create])
    const descriptor = await fs.readFile(target, 'utf8')
    expect(descriptor.match(/MODMIND ADDON RELATIONSHIPS START/g)).toHaveLength(1)
    expect(descriptor).toContain('modId="create"')
    expect(descriptor).toContain('mandatory=true')
  })
})
