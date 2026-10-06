import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, updateModpackModuleSide, writeModpackManifest } from './modpackService'
import { createEmptyModpackLock, writeModpackLock } from './modpackLockService'
import { addServerPackMods, buildServerPack, createServerPackArchive, installServerRuntime, readExistingServerPack, readServerPackManifest, removeServerPackMod, serverRuntimeDownloadDescription } from './serverPackService'
import { verifiedDownload } from './downloadService'
import { createServer } from 'node:http'
import { httpTransport } from './networkRequest'
import { createStoredZip } from './bedrockAddon'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

function project(root: string): ProjectInfo { return { kind: 'modpack', name: 'Server Pack', path: root, loader: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.16.10', namespace: 'server_pack', createdAt: new Date().toISOString() } }

describe('server pack generation', () => {
  it('repairs a corrupt cached Fabric server JAR despite a matching installed marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-runtime-repair-')); roots.push(root)
    const pack = project(root)
    await fs.writeFile(path.join(root, 'server.jar'), '<html>previous download failure</html>')
    await fs.writeFile(path.join(root, '.modmind-server-runtime.json'), JSON.stringify({ minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: pack.loaderVersion }))
    const bytes = createStoredZip([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Main-Class: Server\r\n') }, { name: 'Server.class', data: Buffer.from('class fixture') }])
    const server = createServer((_request, response) => response.end(bytes))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const transport = httpTransport.request
    const mock = vi.spyOn(httpTransport, 'request').mockImplementation((_url, options) => transport(`http://127.0.0.1:${(server.address() as { port: number }).port}/file`, options))
    try {
      const result = await installServerRuntime({ serverPack: { root, copiedMods: [], skippedClientMods: [], warnings: [], manifestPath: path.join(root, 'modmind.server.json') }, javaPath: process.execPath }, pack)
      expect(await fs.readFile(result.serverJar!)).toEqual(bytes)
      expect(mock).toHaveBeenCalledOnce()
    } finally {
      mock.mockRestore(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it.each(['forge', 'neoforge', 'fabric'] as const)('rejects HTTP 200 error pages before installing a %s server runtime', async loader => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-runtime-invalid-')); roots.push(root)
    const server = createServer((_request, response) => response.end('<html>download unavailable</html>'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const transport = httpTransport.request
    const mock = vi.spyOn(httpTransport, 'request').mockImplementation((_url, options) => transport(`http://127.0.0.1:${(server.address() as { port: number }).port}/file`, options))
    try {
      const pack = { ...project(root), loader, loaderVersion: loader === 'forge' ? '47.4.22' : loader === 'neoforge' ? '21.1.244' : '0.16.10' }
      await expect(installServerRuntime({ serverPack: { root, copiedMods: [], skippedClientMods: [], warnings: [], manifestPath: path.join(root, 'modmind.server.json') }, javaPath: process.execPath }, pack)).rejects.toThrow('JAR 内容校验失败')
      expect(await fs.readdir(root)).toEqual([])
    } finally {
      mock.mockRestore(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('does not expose client manifest mods before a server pack exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-manifest-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    await expect(readServerPackManifest(pack)).resolves.toBeNull()
    await fs.mkdir(path.join(root, '.modmind', 'server-pack'), { recursive: true })
    await fs.writeFile(path.join(root, '.modmind', 'server-pack', 'modmind.server.json'), JSON.stringify({ version: 1, name: pack.name, minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: pack.loaderVersion, engine: 'serverpackcreator', engineVersion: '8.1.2', port: 25565, onlineMode: false, eulaAccepted: false, mods: ['server-only.jar'], skippedClientMods: ['client-only.jar'], generatedAt: new Date().toISOString() }), 'utf8')
    await expect(readServerPackManifest(pack)).resolves.toMatchObject({ mods: ['server-only.jar'], skippedClientMods: ['client-only.jar'] })
  })

  it('loads a runtime target only from a synchronized server pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-existing-server-pack-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    await expect(readExistingServerPack(pack)).resolves.toBeNull()

    const serverRoot = path.join(root, '.modmind', 'server-pack')
    await fs.mkdir(serverRoot, { recursive: true })
    await fs.writeFile(path.join(serverRoot, 'modmind.server.json'), JSON.stringify({ version: 1, name: pack.name, minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: pack.loaderVersion, engine: 'serverpackcreator', engineVersion: '8.1.2', port: 25565, onlineMode: false, eulaAccepted: false, mods: ['server-only.jar'], skippedClientMods: ['client-only.jar'], generatedAt: new Date().toISOString() }), 'utf8')

    await expect(readExistingServerPack(pack)).resolves.toMatchObject({ root: serverRoot, copiedMods: ['server-only.jar'], skippedClientMods: ['client-only.jar'], engine: 'serverpackcreator' })
  })

  it('normalizes Forge loader versions when building runtime download URLs', () => {
    const description = serverRuntimeDownloadDescription({ loader: 'forge', minecraftVersion: '1.20.1', loaderVersion: '1.20.1-47.4.22' })
    expect(description.sources[0]).toContain('/forge/1.20.1-47.4.22/forge-1.20.1-47.4.22-installer.jar')
    expect(description.sources[0]).not.toContain('1.20.1-1.20.1-47.4.22')
  })

  it('copies server-safe mods, preserves overrides, and writes an explicit EULA state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-pack-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    await fs.writeFile(path.join(root, 'mods', 'common.jar'), Buffer.alloc(2_048, 1))
    await fs.writeFile(path.join(root, 'mods', 'client.jar'), Buffer.alloc(2_048, 2))
    await writeModpackManifest(pack, { version: 1, name: pack.name, minecraftVersion: pack.minecraftVersion, loader: 'fabric', mods: [
      { fileName: 'common.jar', size: 2_048, sha256: createHash('sha256').update(Buffer.alloc(2_048, 1)).digest('hex'), addedAt: new Date().toISOString() },
      { fileName: 'client.jar', size: 2_048, sha256: createHash('sha256').update(Buffer.alloc(2_048, 2)).digest('hex'), addedAt: new Date().toISOString() }
    ], modules: [{ name: 'Core', namespace: 'core', path: 'modules/core', createdAt: new Date().toISOString() }] })
    await writeModpackLock(pack, { ...createEmptyModpackLock(pack), mods: [
      { provider: 'modrinth', projectId: 'common', versionId: 'v1', versionName: '1', fileName: 'common.jar', sha256: createHash('sha256').update(Buffer.alloc(2_048, 1)).digest('hex'), size: 2_048, side: 'both', sources: ['https://example.test/common.jar'], installedAt: new Date().toISOString() },
      { provider: 'modrinth', projectId: 'client', versionId: 'v1', versionName: '1', fileName: 'client.jar', sha256: createHash('sha256').update(Buffer.alloc(2_048, 2)).digest('hex'), size: 2_048, side: 'client', sources: ['https://example.test/client.jar'], installedAt: new Date().toISOString() }
    ] })
    await fs.mkdir(path.join(root, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'config', 'server.toml'), 'enabled=true\n', 'utf8')
    await fs.mkdir(path.join(root, 'modules', 'core', 'build', 'libs'), { recursive: true })
    await fs.writeFile(path.join(root, 'modules', 'core', 'build', 'libs', 'core-1.0.0.jar'), Buffer.alloc(2_048, 3))
    await addModpackModule(pack, { name: 'Client UI', namespace: 'client_ui', path: 'modules/client_ui', createdAt: new Date().toISOString() })
    await updateModpackModuleSide(pack, 'client_ui', 'client')
    await fs.mkdir(path.join(root, 'modules', 'client_ui', 'build', 'libs'), { recursive: true })
    await fs.writeFile(path.join(root, 'modules', 'client_ui', 'build', 'libs', 'client-ui-1.0.0.jar'), Buffer.alloc(2_048, 4))
    const result = await buildServerPack(pack, { outputDirectory: path.join(root, 'server'), acceptEula: false })
    expect(result.copiedMods).toEqual(['common.jar', 'modmind-local-core.jar'])
    expect(result.skippedClientMods).toEqual(['client.jar', 'modmind-local-client_ui.jar'])
    expect(result.directMods).toEqual(['modmind-local-core.jar'])
    await expect(fs.readFile(path.join(root, 'server', 'config', 'server.toml'), 'utf8')).resolves.toContain('enabled')
    await expect(fs.readFile(path.join(root, 'server', 'eula.txt'), 'utf8')).resolves.toContain('eula=false')
    await expect(fs.readFile(path.join(root, 'server', 'server.properties'), 'utf8')).resolves.toContain('server-ip=127.0.0.1')
    await expect(fs.stat(path.join(root, 'server', 'mods', 'modmind-local-core.jar'))).resolves.toMatchObject({ size: 2_048 })
    await expect(fs.stat(path.join(root, 'server', 'mods', 'modmind-local-client_ui.jar'))).rejects.toThrow()
    await fs.writeFile(path.join(root, 'server', 'server.jar'), Buffer.alloc(128, 9))
    await fs.writeFile(path.join(root, 'server', '.modmind-server-runtime.json'), JSON.stringify({ minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: pack.loaderVersion }), 'utf8')
    await buildServerPack(pack, { outputDirectory: path.join(root, 'server'), acceptEula: true, preserveExistingFiles: true })
    await expect(fs.stat(path.join(root, 'server', 'server.jar'))).resolves.toMatchObject({ size: 128 })
    await expect(fs.readFile(path.join(root, 'server', '.modmind-server-runtime.json'), 'utf8')).resolves.toContain('0.16.10')
  })

  it('uses override-local JARs when building a server pack from an archive layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-archive-pack-'))
    roots.push(root)
    const pack = project(root)
    await fs.mkdir(path.join(root, 'overrides', 'mods'), { recursive: true })
    await fs.mkdir(path.join(root, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(root, 'overrides', 'mods', 'common.jar'), Buffer.alloc(2_048, 5))
    await fs.writeFile(path.join(root, 'overrides', 'config', 'archive.toml'), 'enabled=true\n', 'utf8')
    await adoptExternalModpack(pack, { format: 'modrinth', layout: 'archive', importedAt: '2026-08-16T00:00:00.000Z' })

    const result = await buildServerPack(pack, { outputDirectory: path.join(root, 'server'), acceptEula: false })

    expect(result.copiedMods).toEqual(['common.jar'])
    await expect(fs.readFile(path.join(root, 'server', 'mods', 'common.jar'))).resolves.toEqual(Buffer.alloc(2_048, 5))
    await expect(fs.readFile(path.join(root, 'server', 'config', 'archive.toml'), 'utf8')).resolves.toContain('enabled')
  })

  it('updates synchronized server pack mods and exports a deployable ZIP without local logs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-pack-edit-'))
    roots.push(root)
    const pack = project(root)
    await createModpackTemplate(pack)
    const serverRoot = path.join(root, '.modmind', 'server-pack')
    await fs.mkdir(path.join(serverRoot, 'mods'), { recursive: true })
    await fs.writeFile(path.join(serverRoot, 'mods', 'existing.jar'), Buffer.from('existing'))
    await fs.writeFile(path.join(serverRoot, 'server.properties'), 'online-mode=false\n', 'utf8')
    await fs.writeFile(path.join(serverRoot, 'modmind.server.json'), JSON.stringify({ version: 1, name: pack.name, minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: pack.loaderVersion, engine: 'serverpackcreator', engineVersion: '8.1.2', port: 25565, onlineMode: false, eulaAccepted: false, mods: ['existing.jar'], skippedClientMods: [], generatedAt: new Date().toISOString() }), 'utf8')
    const extra = path.join(root, 'extra.jar')
    await fs.writeFile(extra, Buffer.from('extra'))

    await expect(addServerPackMods(pack, [extra])).resolves.toMatchObject({ mods: ['existing.jar', 'extra.jar'], eulaAccepted: true })
    await expect(removeServerPackMod(pack, 'existing.jar')).resolves.toMatchObject({ mods: ['extra.jar'] })
    await fs.mkdir(path.join(serverRoot, 'logs'), { recursive: true })
    await fs.writeFile(path.join(serverRoot, 'logs', 'latest.log'), 'local log', 'utf8')
    const archivePath = path.join(root, 'server-pack.zip')
    await fs.writeFile(archivePath, await createServerPackArchive(pack))
    const extracted = path.join(root, 'exported')
    await extractZip(archivePath, { dir: extracted })
    await expect(fs.readFile(path.join(extracted, 'mods', 'extra.jar'))).resolves.toEqual(Buffer.from('extra'))
    await expect(fs.stat(path.join(extracted, 'logs', 'latest.log'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects a freshly installed unmarked server runtime before writing the marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-server-runtime-'))
    roots.push(root)
    const pack = project(root)
    const javaPath = process.execPath
    const serverJar = path.join(root, 'server.jar')
    await fs.writeFile(path.join(root, '.modmind-server-runtime.json'), JSON.stringify({ minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: '0.16.9' }))
    const download = vi.spyOn(verifiedDownload, 'download').mockImplementation(async (input) => {
      const bytes = createStoredZip([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Main-Class: Server\r\n') }, { name: 'Server.class', data: Buffer.from('class fixture') }])
      await fs.writeFile(input.destination, bytes)
      await input.validate?.(input.destination)
      return { source: input.sources[0], destination: input.destination, bytes: bytes.length, attempts: 1, failures: [] }
    })

    try {
      const result = await installServerRuntime({
        serverPack: { root, copiedMods: [], skippedClientMods: [], warnings: [], manifestPath: path.join(root, 'modmind.server.json') },
        javaPath
      }, pack)

      expect(result.serverJar).toBe(serverJar)
      expect(download).toHaveBeenCalledOnce()
      await expect(fs.readFile(path.join(root, '.modmind-server-runtime.json'), 'utf8')).resolves.toContain('0.16.10')
      await expect(fs.readFile(path.join(root, 'start-server.cmd'), 'utf8')).resolves.toContain('server.jar')
    } finally {
      download.mockRestore()
    }
  })
})
