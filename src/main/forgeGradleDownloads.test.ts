import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { prepareForgeGradleDownloads } from './forgeGradleDownloads'
import { verifiedDownload } from './downloadService'
import { fetchTextWithRetry } from './networkRequest'
import type { ProjectInfo } from '../shared/types'
vi.mock('./downloadService', () => ({ verifiedDownload: { download: vi.fn() } }))
vi.mock('./networkRequest', () => ({ fetchTextWithRetry: vi.fn() }))
vi.mock('./archiveInspection', () => ({
  archiveRead: async (file: string) => Buffer.from(JSON.stringify(file.endsWith('userdev.jar')
    ? { mcp: 'de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip' }
    : { version: '1.20.1', steps: { joined: [{ type: 'downloadClient' }, { type: 'downloadServer', name: 'downloadServer' }] } }))
}))
const roots: string[] = []
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
it('prepares FG6 MinecraftRepo and MCPRuntime binary caches using original metadata and file identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-fg6-cache-')); roots.push(root)
  const project = { path: root, minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23' } as ProjectInfo
  await fs.writeFile(path.join(root, 'build.gradle'), "plugins { id 'net.minecraftforge.gradle' version '6.0.54' }")
  const hash = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex')
  const jars = { client: Buffer.from('client binary'), server: Buffer.from('server binary') }
  const metadata = Buffer.from(JSON.stringify({ downloads: Object.fromEntries(Object.entries(jars).map(([name, bytes]) => [name, { sha1: hash(bytes), size: bytes.length, url: `https://piston-data.mojang.com/v1/objects/${hash(bytes)}/${name}.jar` }])) }))
  const manifest = Buffer.from(JSON.stringify({ versions: [{ id: '1.20.1', sha1: hash(metadata), url: `https://piston-meta.mojang.com/v1/packages/${hash(metadata)}/1.20.1.json` }] }))
  vi.mocked(fetchTextWithRetry).mockResolvedValue(hash(Buffer.from('metadata archive')))
  vi.mocked(verifiedDownload.download).mockImplementation(async request => {
    const bytes = request.destination.endsWith('manifest.json') ? manifest : request.destination.endsWith('version.json') ? metadata : request.destination.endsWith('client.jar') ? jars.client : request.destination.endsWith('server.jar') ? jars.server : Buffer.from('metadata archive')
    if (request.expectedHash) expect(hash(bytes)).toBe(request.expectedHash.value)
    await fs.mkdir(path.dirname(request.destination), { recursive: true }); await fs.writeFile(request.destination, bytes); await request.validate?.(request.destination)
    return { source: request.sources[0], destination: request.destination, bytes: bytes.length, attempts: 1, failures: [] }
  })
  const home = path.join(root, 'cache'); await prepareForgeGradleDownloads(project, home)
  const mcp = path.join(home, 'caches/forge_gradle/mcp_repo/de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/joined')
  expect(await fs.readFile(path.join(mcp, 'downloadClient/client.jar'))).toEqual(jars.client)
  expect(await fs.readFile(path.join(mcp, 'downloadServer/server.jar'))).toEqual(jars.server)
  expect(await fs.readFile(path.join(home, 'caches/forge_gradle/minecraft_repo/versions/1.20.1/client.jar.sha1'), 'utf8')).toBe(hash(jars.client))
  const priorMetadataCalls = vi.mocked(fetchTextWithRetry).mock.calls.length
  await prepareForgeGradleDownloads(project, home)
  expect(fetchTextWithRetry).toHaveBeenCalledTimes(priorMetadataCalls)
})
it('leaves unsupported ForgeGradle versions and other loaders to their existing runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-fg-unsupported-')); roots.push(root)
  await fs.writeFile(path.join(root, 'build.gradle'), "plugins { id 'net.minecraftforge.gradle' version '5.1.0' }")
  await prepareForgeGradleDownloads({ path: root, minecraftVersion: '1.18.2', loader: 'forge' } as ProjectInfo, path.join(root, 'cache'))
  expect(verifiedDownload.download).not.toHaveBeenCalled()
})
