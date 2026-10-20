import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { MinecraftRuntimeManager } from '../../feature-plugins/testing/src/main/minecraftRuntime'
import { adoptExternalModpack, auditImportedPackArtifacts, createModpackTemplate } from './modpackService'
import { createStoredZip } from './bedrockAddon'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-runtime-validation-'))
  roots.push(root)
  const project: ProjectInfo = { kind: 'modpack', path: root, name: 'Pack', namespace: 'pack', loader: 'forge', minecraftVersion: '1.20.1', createdAt: '' }
  await createModpackTemplate(project)
  const events: string[] = []
  const runtime = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: event => { events.push(event.message) } })
  // Stop at provisioning: these tests exercise the real prelaunch checks without downloads or a JVM.
  const prepare = vi.spyOn(runtime, 'prepare').mockRejectedValue(new Error('prelaunch checks passed'))
  const instance = path.join(root, '.modmind', 'minecraft')
  const launch = () => runtime.launch({ username: 'Player', maxMemoryMb: 2048 })
  return { root, project, runtime, prepare, instance, launch, events }
}

function jar(files: Record<string, string>): Buffer {
  return createStoredZip([
    ...Object.entries(files).map(([name, value]) => ({ name, data: Buffer.from(value) })),
    { name: 'example/Mod.class', data: Buffer.alloc(2048) }
  ])
}

describe('modpack import and prelaunch validation', () => {
  it('imports an unrecognized mod unchanged and refuses to deploy it for execution', async () => {
    const f = await fixture()
    const bytes = jar({})
    await fs.writeFile(path.join(f.root, 'mods', 'custom.jar'), bytes)
    await adoptExternalModpack(f.project, { format: 'instance', layout: 'instance', importedAt: '' })
    expect(await auditImportedPackArtifacts(f.project)).toEqual([expect.stringContaining('已按原包保留')])
    await expect(f.runtime.syncModpack()).rejects.toThrow('forge descriptor')
    expect(await fs.readFile(path.join(f.root, 'mods', 'custom.jar'))).toEqual(bytes)
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it('revalidates cached instance JARs before preparing or starting Minecraft', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.root, 'mods', 'valid.jar'), jar({ 'META-INF/mods.toml': 'modLoader="javafml"' }))
    await adoptExternalModpack(f.project, { format: 'instance', layout: 'instance', importedAt: '' })
    await f.runtime.syncModpack()
    await expect(f.launch()).rejects.toThrow('prelaunch checks passed')
    f.prepare.mockClear()
    await fs.writeFile(path.join(f.instance, 'mods', 'valid.jar'), jar({}))
    await expect(f.launch()).rejects.toThrow('forge descriptor')
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it('reports uncertainty for preserved foreign-loader mods at launch', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.root, 'mods', 'fabric.jar'), jar({ 'fabric.mod.json': '{}' }))
    await adoptExternalModpack(f.project, { format: 'instance', layout: 'instance', importedAt: '' })
    expect((await auditImportedPackArtifacts(f.project)).join('')).toContain('尚未检测到 Connector')
    await f.runtime.syncModpack()
    await expect(f.launch()).rejects.toThrow('prelaunch checks passed')
    expect(f.events.join('\n')).toContain('尚未检测到 Connector')
  })

  it('recognizes the installed Connector when checking Fabric companions before launch', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.root, 'mods', 'fabric.jar'), jar({ 'fabric.mod.json': '{}' }))
    await fs.writeFile(path.join(f.root, 'mods', 'connector.jar'), jar({ 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="connectormod"' }))
    await adoptExternalModpack(f.project, { format: 'instance', layout: 'instance', importedAt: '' })
    await f.runtime.syncModpack()
    await expect(f.launch()).rejects.toThrow('prelaunch checks passed')
    expect(f.events.join('\n')).not.toContain('尚未检测到 Connector')
  })

  it('rejects missing deployed files even when the sync receipt exists', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.root, 'mods', 'valid.jar'), jar({ 'META-INF/mods.toml': 'modLoader="javafml"' }))
    await adoptExternalModpack(f.project, { format: 'instance', layout: 'instance', importedAt: '' })
    await f.runtime.syncModpack()
    await fs.unlink(path.join(f.instance, 'mods', 'valid.jar'))
    await expect(f.launch()).rejects.toThrow('缺少已同步')
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it('keeps source hash verification mandatory when syncing imported files', async () => {
    const f = await fixture()
    const target = path.join(f.root, 'mods', 'changed.jar')
    await fs.writeFile(target, jar({ 'META-INF/mods.toml': 'modLoader="javafml"' }))
    await adoptExternalModpack(f.project, { format: 'instance', layout: 'instance', importedAt: '' })
    await fs.writeFile(target, jar({ 'META-INF/mods.toml': 'modLoader="lowcodefml"' }))
    await expect(f.runtime.syncModpack()).rejects.toThrow('已被修改')
    expect(f.prepare).not.toHaveBeenCalled()
  })
})
