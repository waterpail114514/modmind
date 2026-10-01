import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { applyKeybindPreset, writeFtbQuestChapter, writePatchouliBook } from "../../feature-plugins/modpack-content/src/main/modpackContentService"
import { addModpackFiles, createModpackTemplate } from './modpackService'
import { applyModpackPlan, planModpack } from "../../feature-plugins/modpack-mods/src/main/modpackPlanner"
import type { ModFile, ModProviderRegistry } from './modProviderService'
import { auditModpackLock } from './modpackLockService'
import { buildServerPack } from './serverPackService'

const roots: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function project(root: string): ProjectInfo { return { kind: 'modpack', name: 'End to End Pack', path: root, loader: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.16.10', namespace: 'end_to_end', createdAt: new Date().toISOString() } }

describe('modpack automation chain', () => {
  it('plans, downloads, locks, writes content, applies keybinds, audits, and builds a server pack', async () => {
    const server = http.createServer((_request, response) => response.end(Buffer.alloc(2_048, 9)))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-e2e-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const file: ModFile = { provider: 'modrinth', projectId: 'example', versionId: 'v1', versionName: '1.0', filename: 'example.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: `http://127.0.0.1:${port}/example.jar` }] }
    const registry = {
      search: async () => [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: 'example', slug: 'example', name: 'Example', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 1 }] }],
      versions: async () => [file],
      install: async (selected: ModFile, target: string) => {
        const { verifiedDownload } = await import('./downloadService')
        const result = await verifiedDownload.download({ sources: selected.sources, destination: target, maxBytes: 3_000 })
        const bytes = await fs.readFile(result.destination)
        const { createHash } = await import('node:crypto')
        return { path: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
    } as unknown as ModProviderRegistry
    const plan = await planModpack(registry, pack, { required: ['Example'] })
    expect(plan.success).toBe(true)
    await applyModpackPlan(registry, pack, plan)
    const contentMods = ['ftb-quests-forge.jar', 'patchouli.jar', 'kubejs-forge.jar'].map((name) => path.join(root, name))
    await Promise.all(contentMods.map((source) => fs.writeFile(source, Buffer.alloc(2_048, 6))))
    await addModpackFiles(pack, contentMods)
    await writeFtbQuestChapter(pack, { chapterId: 'start', title: 'Start', quests: [{ id: 'first', title: 'First', tasks: [{ id: 'task', title: 'Task', type: 'checkmark' }] }] })
    await writePatchouliBook(pack, { bookId: 'guide', name: 'Guide', landingText: 'Welcome', categories: [{ id: 'start', name: 'Start', icon: 'minecraft:book', entries: [{ id: 'intro', name: 'Intro', icon: 'minecraft:stone', text: 'Welcome' }] }] })
    await applyKeybindPreset(pack, { id: 'default', name: 'Default', bindings: { 'key_example.open': 'key.keyboard.j' } })
    expect((await auditModpackLock(pack)).success).toBe(true)
    const serverPack = await buildServerPack(pack, { outputDirectory: path.join(root, 'server'), acceptEula: false, port: 25565 })
    expect(serverPack.copiedMods).toEqual(['example.jar', 'ftb-quests-forge.jar', 'kubejs-forge.jar', 'patchouli.jar'])
    await expect(fs.access(path.join(serverPack.root, 'config', 'ftbquests', 'quests', 'chapters', 'start.snbt'))).resolves.toBeUndefined()
    await expect(fs.readFile(path.join(serverPack.root, 'eula.txt'), 'utf8')).resolves.toContain('eula=false')
    await expect(fs.readFile(path.join(root, 'overrides', 'config', 'ftbquests', 'quests', 'chapters', 'start.snbt'), 'utf8')).resolves.toMatch(/id:"[A-F0-9]{32}"/)
  })
})
