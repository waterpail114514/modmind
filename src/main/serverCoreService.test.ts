import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { serverCoreBuilds, validateServerProfile, defaultServerProfile, readServerProfile, saveServerProfile, preparePluginServer } from './serverCoreService'
import { fetchJsonWithRetry } from './networkRequest'
import { createStoredZip } from './bedrockAddon'
import type { ProjectInfo } from '../shared/types'

vi.mock('./networkRequest', () => ({ fetchJsonWithRetry: vi.fn() }))

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it.each([false, undefined])('prepares an existing plugin test server with prior client acceptance when the legacy EULA flag is %s', async eulaAccepted => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-server-eula-')); roots.push(root)
  const project: ProjectInfo = { name: 'Test', path: root, namespace: 'test', kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.21.1', createdAt: '' }
  const initial = await readServerProfile(project)
  expect(initial.eulaAccepted).toBe(true)
  const legacy = { ...initial, core: 'custom' as const, localJar: '.modmind/server/local/core.jar', port: 25580, onlineMode: false, eulaAccepted }
  const instance = path.join(root, '.modmind/server/instances/custom-1.21.1')
  await fs.mkdir(path.join(root, '.modmind/server/local'), { recursive: true })
  await fs.mkdir(path.join(root, 'build/libs'), { recursive: true })
  await fs.mkdir(instance, { recursive: true })
  await fs.writeFile(path.join(root, '.modmind/server/profile.json'), JSON.stringify(legacy))
  await fs.writeFile(path.join(root, legacy.localJar), createStoredZip([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Main-Class: example.Server\n') }]))
  await fs.writeFile(path.join(root, 'build/libs/test.jar'), createStoredZip([
    { name: 'plugin.yml', data: Buffer.from('name: Test\nversion: "1"\nmain: example.Plugin\n') },
    { name: 'example/Plugin.class', data: Buffer.from('test fixture') }
  ]))
  await fs.writeFile(path.join(instance, 'eula.txt'), 'eula=false\n')

  const prepared = await preparePluginServer(project, { javaPath: async () => 'java', cacheDirectory: path.join(root, 'cache'), signal: new AbortController().signal, onProgress: () => undefined })

  expect(prepared.profile).toMatchObject({ eulaAccepted: true, port: 25580, onlineMode: false })
  await expect(fs.readFile(path.join(prepared.pack.root, 'eula.txt'), 'utf8')).resolves.toBe('eula=true\n')
  const properties = await fs.readFile(path.join(prepared.pack.root, 'server.properties'), 'utf8')
  expect(properties).toContain('server-ip=127.0.0.1')
  expect(properties).toContain('server-port=25580')
  expect(properties).toContain('online-mode=false')
  await saveServerProfile(project, { ...prepared.profile, eulaAccepted: false })
  expect(JSON.parse(await fs.readFile(path.join(root, '.modmind/server/profile.json'), 'utf8')).eulaAccepted).toBe(true)
})

it('filters unverifiable builds and sorts upstream builds before automatic selection', async () => {
  const download = { name: 'paper.jar', url: 'https://fill-data.papermc.io/test.jar', checksums: { sha256: 'a'.repeat(64) } }
  vi.mocked(fetchJsonWithRetry).mockResolvedValue([
    { id: 1, channel: 'STABLE', downloads: { 'server:default': download } },
    { id: 3, channel: 'STABLE', downloads: { 'server:default': { ...download, checksums: {} } } },
    { id: 2, channel: 'STABLE', downloads: { 'server:default': download } }
  ])
  expect((await serverCoreBuilds('paper', '1.21.1')).map(b => b.build)).toEqual(['2', '1'])
  const controller = new AbortController(); controller.abort()
  await expect(serverCoreBuilds('paper', '1.21.1', controller.signal)).rejects.toThrow()
})

it('keeps verified Purpur builds when another metadata request fails', async () => {
  vi.mocked(fetchJsonWithRetry).mockImplementation(async url => {
    if (url.endsWith('/1.20.4')) return { builds: { all: ['1', '2', '3'] } }
    if (url.endsWith('/2')) throw new Error('HTTP 503')
    return { result: 'SUCCESS', md5: 'b'.repeat(32) }
  })
  expect((await serverCoreBuilds('purpur', '1.20.4')).map(b => b.build)).toEqual(['3', '1'])
})

it('rejects too-old runtime Java and applies Velocity version boundaries', () => {
  const project: ProjectInfo = { name: 'Test', path: '', namespace: 'test', kind: 'server-plugin', loader: 'velocity', minecraftVersion: '4.1.1', createdAt: '' }
  expect(defaultServerProfile(project).javaVersion).toBe(25)
  expect(defaultServerProfile({ ...project, minecraftVersion: '3.4.0' }).javaVersion).toBe(17)
  expect(() => validateServerProfile(project, { ...defaultServerProfile(project), javaVersion: 21 })).toThrow('Java')
})
