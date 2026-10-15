import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { addModpackFiles, createModpackTemplate, readModpackManifest } from './modpackService'
import { createEmptyModpackLock, readModpackLock, writeModpackLock } from './modpackLockService'
import { applyModpackPlan, planModpack } from './modpackPlanner'
import type { ModFile, ModProviderRegistry } from './modProviderService'

const roots: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function project(root: string): ProjectInfo { return { kind: 'modpack', name: 'Planner', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'planner', createdAt: new Date().toISOString() } }

describe('modpack planner', () => {
  it('reports unresolved required requests instead of silently selecting an incompatible result', async () => {
    const registry = { search: async () => [{ provider: 'modrinth', total: 0, hits: [] }], versions: async () => [], install: async () => { throw new Error('not called') } } as unknown as ModProviderRegistry
    const result = await planModpack(registry, project('/tmp/pack'), { required: ['missing'], optional: ['also missing'] })
    expect(result.success).toBe(false)
    expect(result.warnings).toHaveLength(2)
  })

  it('carries project-level client-only metadata into a version that omits side fields', async () => {
    const file: ModFile = { provider: 'modrinth', projectId: 'client', versionId: 'v1', versionName: '1', filename: 'client.jar', primary: true, side: 'unknown', sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/client.jar' }] }
    const registry = {
      search: async () => [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: 'client', slug: 'client', name: 'Client', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'unknown', downloads: 1 }] }],
      versions: async () => [file],
      install: async () => { throw new Error('not called') }
    } as unknown as ModProviderRegistry
    const result = await planModpack(registry, project('/tmp/pack'), { required: ['client'] })
    expect(result.required[0].selected?.side).toBe('client')
  })

  it('resolves required transitive dependencies and exposes an install review', async () => {
    const rootFile: ModFile = { provider: 'modrinth', projectId: 'root', versionId: 'root-v1', versionName: '1', filename: 'root.jar', primary: true, side: 'both', dependencies: [{ provider: 'modrinth', projectId: 'api', versionId: 'api-v1', kind: 'required' }], sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/root.jar' }] }
    const apiFile: ModFile = { provider: 'modrinth', projectId: 'api', versionId: 'api-v1', versionName: '1', filename: 'api.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/api.jar' }] }
    const registry = {
      search: async () => [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: 'root', slug: 'root', name: 'Root', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 1 }] }],
      versions: async (_provider: string, projectId: string) => [projectId === 'root' ? rootFile : apiFile],
      install: async () => { throw new Error('not called') }
    } as unknown as ModProviderRegistry
    const result = await planModpack(registry, project('/tmp/pack'), { required: ['Root'] })
    expect(result.success).toBe(true)
    expect(result.dependencies).toMatchObject([{ request: 'api', parent: 'Root', selected: { filename: 'api.jar' } }])
    expect(result.review).toMatchObject({ installCount: 2, unresolved: 0, requiresApproval: true })
    expect(result.dependencyEdges).toMatchObject([{ from: 'Root', to: 'modrinth:api', kind: 'required', resolved: true }])
  })

  it('blocks a required dependency when its exact compatible version cannot be resolved', async () => {
    const rootFile: ModFile = { provider: 'modrinth', projectId: 'root', versionId: 'root-v1', versionName: '1', filename: 'root.jar', primary: true, side: 'both', dependencies: [{ provider: 'modrinth', projectId: 'api', versionId: 'missing', kind: 'required' }], sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/root.jar' }] }
    const registry = {
      search: async () => [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: 'root', slug: 'root', name: 'Root', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 1 }] }],
      versions: async (_provider: string, projectId: string) => projectId === 'root' ? [rootFile] : [{ ...rootFile, projectId: 'api', versionId: 'different', filename: 'api.jar', dependencies: [] }],
      install: async () => { throw new Error('not called') }
    } as unknown as ModProviderRegistry
    const result = await planModpack(registry, project('/tmp/pack'), { required: ['Root'] })
    expect(result.success).toBe(false)
    expect(result.warnings.join('\n')).toMatch(/required version missing/)
  })

  it('applies a resolved plan through the real download and lock audit path', async () => {
    const server = http.createServer((_request, response) => response.end(Buffer.alloc(2_048, 7)))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-plan-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const file: ModFile = { provider: 'modrinth', projectId: 'sodium', versionId: 'v1', versionName: '1.0', filename: 'sodium.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: `http://127.0.0.1:${port}/sodium.jar` }] }
    const registry = {
      search: async () => [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: 'sodium', slug: 'sodium', name: 'Sodium', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 10 }] }],
      versions: async () => [file],
      install: async (selected: ModFile, target: string) => {
        const { verifiedDownload } = await import('./downloadService')
        const downloaded = await verifiedDownload.download({ sources: selected.sources, destination: target, maxBytes: 3_000 })
        const bytes = await fs.readFile(downloaded.destination)
        const { createHash } = await import('node:crypto')
        return { path: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
    } as unknown as ModProviderRegistry
    const plan = await planModpack(registry, pack, { required: ['Sodium'] })
    expect(plan.success).toBe(true)
    const result = await applyModpackPlan(registry, pack, plan)
    expect(result.installed).toEqual(['sodium.jar'])
    expect(result.audit.success).toBe(true)
    await expect(fs.access(path.join(root, 'modmind.modpack.lock.json'))).resolves.toBeUndefined()
  })

  it('rolls back staged files and the manifest when a later mod download fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-plan-rollback-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const files: ModFile[] = [
      { provider: 'modrinth', projectId: 'one', versionId: 'v1', versionName: '1', filename: 'one.jar', primary: true, side: 'both', sources: ['https://example.test/one.jar'].map((url) => ({ id: 'one', label: 'one', url })) },
      { provider: 'modrinth', projectId: 'two', versionId: 'v1', versionName: '1', filename: 'two.jar', primary: true, side: 'both', sources: ['https://example.test/two.jar'].map((url) => ({ id: 'two', label: 'two', url })) }
    ]
    let installs = 0
    const registry = {
      search: async (input: unknown) => { const query = typeof input === 'string' ? input : String((input as { query?: unknown }).query ?? ''); return [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: query.toLowerCase(), slug: query.toLowerCase(), name: query, summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 1 }] }] },
      versions: async (_provider: string, id: string) => [files.find((file) => file.projectId === id)!],
      install: async (file: ModFile, target: string) => {
        installs += 1
        if (installs === 2) throw new Error('second source failed')
        await fs.writeFile(target, Buffer.alloc(2_048, 3))
        return { path: target, sha256: '3'.repeat(64), size: 2_048 }
      }
    } as unknown as ModProviderRegistry
    const plan = await planModpack(registry, pack, { required: ['one', 'two'] })
    await expect(applyModpackPlan(registry, pack, plan)).rejects.toThrow(/second source failed/)
    await expect(fs.access(path.join(root, 'mods', 'one.jar'))).rejects.toThrow()
    await expect(fs.access(path.join(root, 'mods', 'two.jar'))).rejects.toThrow()
    await expect(fs.readFile(path.join(root, 'modmind.pack.json'), 'utf8')).resolves.toContain('"mods": []')
  })

  it('replaces an upgraded provider project without leaving the prior JAR in the pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-plan-upgrade-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const oldBytes = Buffer.alloc(2_048, 1)
    await fs.writeFile(path.join(root, 'mods', 'example-v1.jar'), oldBytes)
    await addModpackFiles(pack, [path.join(root, 'mods', 'example-v1.jar')])
    await writeModpackLock(pack, {
      ...createEmptyModpackLock(pack),
      mods: [{ provider: 'modrinth', projectId: 'example', versionId: 'v1', versionName: '1.0', fileName: 'example-v1.jar', sha256: createHash('sha256').update(oldBytes).digest('hex'), size: oldBytes.length, side: 'both', sources: ['https://example.test/example-v1.jar'], installedAt: new Date().toISOString() }]
    })
    const upgraded: ModFile = { provider: 'modrinth', projectId: 'example', versionId: 'v2', versionName: '2.0', filename: 'example-v2.jar', primary: true, side: 'both', sources: [{ id: 'fixture', label: 'fixture', url: 'https://example.test/example-v2.jar' }] }
    const registry = {
      search: async () => [{ provider: 'modrinth', total: 1, hits: [{ provider: 'modrinth', projectId: 'example', slug: 'example', name: 'Example', summary: '', projectUrl: '', clientSide: 'both', serverSide: 'both', downloads: 1 }] }],
      versions: async () => [upgraded],
      install: async (_file: ModFile, target: string) => {
        const bytes = Buffer.alloc(2_048, 2)
        await fs.writeFile(target, bytes)
        return { path: target, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
      }
    } as unknown as ModProviderRegistry
    const plan = await planModpack(registry, pack, { required: ['Example'] })
    await applyModpackPlan(registry, pack, plan)
    await expect(fs.access(path.join(root, 'mods', 'example-v1.jar'))).rejects.toThrow()
    await expect(fs.access(path.join(root, 'mods', 'example-v2.jar'))).resolves.toBeUndefined()
    await expect(readModpackManifest(pack)).resolves.toMatchObject({ mods: [{ fileName: 'example-v2.jar' }] })
    await expect(readModpackLock(pack)).resolves.toMatchObject({ mods: [{ versionId: 'v2', fileName: 'example-v2.jar' }] })
  })
})
