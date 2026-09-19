import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectExternalModpack, materializeExternalModpack, type ExternalModpackInspection } from './modpackImportService'
import extractZip from 'extract-zip'
import { createStoredZip } from './bedrockAddon'

const roots: string[] = []
const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('external modpack import', () => {
  it('keeps newly downloaded files when the archive is copied to a different project root', async () => {
    const bytes = Buffer.alloc(2048, 3)
    const server = http.createServer((_request, response) => response.end(bytes))
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-separate-')); roots.push(root)
    const target = path.join(root, 'project')
    const inspection: ExternalModpackInspection = { root, format: 'modrinth', layout: 'archive', localModFiles: [], overrideFiles: [], unresolvedDependencyCount: 0, warnings: [], remoteFiles: [{ path: 'mods/a.jar', downloads: [`http://127.0.0.1:${port}/a.jar`], hashes: { sha1: createHash('sha1').update(bytes).digest('hex') } }] }
    await expect(materializeExternalModpack(inspection, target, { trackDownloadActivities: false })).resolves.toMatchObject({ downloadedFiles: 1 })
    await expect(fs.readFile(path.join(target, 'overrides/mods/a.jar'))).resolves.toEqual(bytes)
  })
  it('does not steal a complete Gradle Mod project that happens to contain pack-like files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-mod-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'build.gradle'), 'plugins {}\n', 'utf8')
    await fs.mkdir(path.join(root, 'src', 'main', 'resources'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), '{}', 'utf8')
    await fs.mkdir(path.join(root, 'config'))
    await expect(inspectExternalModpack(root)).resolves.toBeNull()
  })

  it('recognizes MultiMC and Prism-style instance folders without moving their content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-instance-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'instance.cfg'), 'name=Example\n', 'utf8')
    await fs.writeFile(path.join(root, 'mmc-pack.json'), JSON.stringify({ components: [
      { uid: 'net.minecraft', version: '1.20.1' },
      { uid: 'net.fabricmc.fabric-loader', version: '0.15.11' }
    ] }), 'utf8')
    await fs.mkdir(path.join(root, 'mods'), { recursive: true })
    await fs.writeFile(path.join(root, 'mods', 'example.jar'), Buffer.alloc(2_048, 1))
    await fs.mkdir(path.join(root, 'config'), { recursive: true })
    await fs.writeFile(path.join(root, 'config', 'example.json'), '{}', 'utf8')

    const result = await inspectExternalModpack(root)
    expect(result).toMatchObject({ format: 'multimc', layout: 'instance', loader: 'fabric', loaderVersion: '0.15.11', minecraftVersion: '1.20.1' })
    expect(result?.localModFiles).toEqual(['mods/example.jar'])
    expect(result?.overrideFiles).toContain('config/example.json')
  })

  it('reads Modrinth index files and materializes overrides into a destination', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-mrpack-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'modrinth.index.json'), JSON.stringify({
      name: 'Imported Pack',
      dependencies: { minecraft: '1.21.1', 'neoforge': '21.1.0' },
      files: [{ path: 'mods/example.jar', downloads: ['https://example.test/example.jar'], hashes: { sha1: 'a'.repeat(40) } }]
    }), 'utf8')
    await fs.mkdir(path.join(root, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'config', 'example.json'), '{"enabled":true}\n', 'utf8')
    await fs.mkdir(path.join(root, 'overrides', 'mods'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'mods', 'local.jar'), Buffer.alloc(2_048, 7))
    const target = path.join(root, 'adopted')

    const inspection = await inspectExternalModpack(root)
    expect(inspection).toMatchObject({ format: 'modrinth', layout: 'archive', loader: 'neoforge', loaderVersion: '21.1.0', minecraftVersion: '1.21.1' })
    expect(inspection?.remoteFiles).toHaveLength(1)
    expect(inspection?.localModFiles).toEqual(['overrides/mods/local.jar'])
    expect(inspection?.overrideFiles).toContain('overrides/config/example.json')
    expect(inspection?.overrideFiles).not.toContain('overrides/mods/local.jar')

    const result = await materializeExternalModpack({ ...inspection!, remoteFiles: [] }, target)
    expect(result.copiedFiles).toBe(2)
    await expect(fs.readFile(path.join(target, 'overrides', 'config', 'example.json'), 'utf8')).resolves.toContain('enabled')
    await expect(fs.stat(path.join(target, 'overrides', 'mods', 'local.jar'))).resolves.toMatchObject({ size: 2_048 })
  })

  it('preserves the exact Forge version declared by a Modrinth pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-forge-mrpack-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'modrinth.index.json'), JSON.stringify({
      game: 'minecraft',
      formatVersion: 1,
      name: '1.20.1-Forge_47.4.20',
      dependencies: { minecraft: '1.20.1', forge: '47.4.20' },
      files: []
    }), 'utf8')
    await fs.mkdir(path.join(root, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'config', 'forge-client.toml'), '', 'utf8')

    await expect(inspectExternalModpack(root)).resolves.toMatchObject({
      format: 'modrinth',
      loader: 'forge',
      loaderVersion: '47.4.20',
      minecraftVersion: '1.20.1'
    })
  })

  it('reads the loader version from a CurseForge manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-curseforge-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      name: 'Forge Pack',
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.20', primary: true }] },
      files: []
    }), 'utf8')
    await fs.mkdir(path.join(root, 'mods'))
    await fs.writeFile(path.join(root, 'mods', 'example.jar'), Buffer.alloc(2_048, 3))

    await expect(inspectExternalModpack(root)).resolves.toMatchObject({
      format: 'curseforge',
      loader: 'forge',
      loaderVersion: '47.4.20',
      minecraftVersion: '1.20.1'
    })
  })

  it('rejects Modrinth entries that would previously be silently skipped', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-invalid-mrpack-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'modrinth.index.json'), JSON.stringify({
      name: 'Invalid Pack',
      dependencies: { minecraft: '1.21.1', fabric: '0.16.0' },
      files: [{ path: '../outside.jar', downloads: ['https://example.test/outside.jar'], hashes: { sha1: 'a'.repeat(40) } }]
    }), 'utf8')

    await expect(inspectExternalModpack(root)).rejects.toThrow(/路径无效/)
  })

  it('requires a supported expected hash for every Modrinth download', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-unhashed-mrpack-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'modrinth.index.json'), JSON.stringify({
      name: 'Unhashed Pack',
      dependencies: { minecraft: '1.21.1', fabric: '0.16.0' },
      files: [{ path: 'mods/example.jar', downloads: ['https://example.test/example.jar'], hashes: { md5: 'a'.repeat(32) } }]
    }), 'utf8')

    await expect(inspectExternalModpack(root)).rejects.toThrow(/sha1 或 sha512/)
  })

  it('recognizes a bare mods folder and preserves the parent instance layout', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-bare-mods-'))
    roots.push(parent)
    const mods = path.join(parent, 'mods')
    await fs.mkdir(mods)
    await fs.writeFile(path.join(mods, 'example.jar'), Buffer.alloc(2_048, 2))
    const inspection = await inspectExternalModpack(mods)
    expect(inspection).toMatchObject({ root: parent, format: 'instance', layout: 'instance', localModFiles: ['mods/example.jar'] })
  })

  it('recognizes a ZIP whose only top-level directory is mods', async () => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-zip-mods-'))
    roots.push(archiveRoot)
    const archive = path.join(archiveRoot, 'mods-only.zip')
    await fs.writeFile(archive, createStoredZip([{ name: 'mods/example.jar', data: Buffer.alloc(2_048, 4) }]))
    const extracted = path.join(archiveRoot, 'extracted')
    await extractZip(archive, { dir: extracted })
    const entries = await fs.readdir(extracted, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    const selected = directories.length === 1 && entries.every((entry) => entry.isDirectory() || entry.name.startsWith('.'))
      ? path.join(extracted, directories[0].name)
      : extracted
    const inspection = await inspectExternalModpack(selected)
    expect(inspection).toMatchObject({ root: extracted, localModFiles: ['mods/example.jar'] })
  })

  it('requires every declared remote hash before reusing an existing Modrinth file', async () => {
    const bytes = Buffer.alloc(2_048, 9)
    const server = http.createServer((_request, response) => response.end(bytes))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-hash-'))
    roots.push(root)
    await fs.mkdir(path.join(root, 'mods'))
    await fs.writeFile(path.join(root, 'mods', 'example.jar'), bytes)
    const inspection: ExternalModpackInspection = {
      root,
      format: 'modrinth',
      layout: 'instance',
      name: 'Hash test',
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      localModFiles: ['mods/example.jar'],
      overrideFiles: [],
      unresolvedDependencyCount: 0,
      warnings: [],
      remoteFiles: [{ path: 'mods/example.jar', downloads: [`http://127.0.0.1:${port}/example.jar`], hashes: { sha1: createHash('sha1').update(bytes).digest('hex'), sha512: 'f'.repeat(128) } }]
    }
    await expect(materializeExternalModpack(inspection, root)).rejects.toThrow(/sha512 mismatch/)
  })

  it('retries a transient MRPack file failure and reports the attempts to the aggregate operation', async () => {
    const bytes = Buffer.alloc(2_048, 11)
    let hits = 0
    const server = http.createServer((_request, response) => {
      hits += 1
      if (hits === 1) {
        response.statusCode = 503
        response.end('temporarily unavailable')
        return
      }
      response.end(bytes)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-retry-'))
    roots.push(root)
    const progress: Array<{ phase: string; attempt?: number }> = []
    const inspection: ExternalModpackInspection = {
      root,
      format: 'modrinth',
      layout: 'instance',
      name: 'Retry test',
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      localModFiles: [],
      overrideFiles: [],
      unresolvedDependencyCount: 0,
      warnings: [],
      remoteFiles: [{
        path: 'mods/retry.jar',
        downloads: [`http://127.0.0.1:${port}/retry.jar`],
        hashes: { sha1: createHash('sha1').update(bytes).digest('hex') }
      }]
    }

    const result = await materializeExternalModpack(inspection, root, {
      trackDownloadActivities: false,
      onProgress: (event) => progress.push({ phase: event.phase, attempt: event.attempt })
    })

    expect(result.downloadedFiles).toBe(1)
    expect(hits).toBe(2)
    expect(progress.filter((event) => event.phase === 'downloading').map((event) => event.attempt)).toEqual([1, 2])
    await expect(fs.readFile(path.join(root, 'mods', 'retry.jar'))).resolves.toEqual(bytes)
  })
})
