import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getVersionList } from '@xmcl/installer'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import { installedRuntimeCandidates } from './minecraftRuntimeCache'
import type { ProjectInfo } from '../shared/types'

const environment = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => environment.root }, net: { fetch: vi.fn(() => { throw new Error('Unexpected network request') }) } }))
vi.mock('./diagnosticLog', () => ({ diagnosticJournal: { record: vi.fn() } }))
vi.mock('@xmcl/installer', async importOriginal => ({
  ...await importOriginal<typeof import('@xmcl/installer')>(),
  getVersionList: vi.fn(async () => { throw new Error('Offline test: installation required') })
}))

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex')
let resourceRoot: string
let project: ProjectInfo
const loaderId = '1.20.1-forge-47.4.23'
const asset = 'verified language resource fixture'
const index = JSON.stringify({ objects: { 'minecraft/lang/en_us.json': { hash: sha1(asset), size: asset.length } } })
const client = 'verified Minecraft client fixture'
const library = 'verified Forge library fixture'
const libraryPath = 'net/minecraftforge/forge/1.20.1-47.4.23/forge-1.20.1-47.4.23-universal.jar'

async function write(relative: string, content: string): Promise<void> {
  const destination = path.join(resourceRoot, relative)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, content)
}

function runtime(instanceName: string): MinecraftRuntimeManager {
  const manager = new MinecraftRuntimeManager({
    getProject: () => project,
    instanceDirectory: path.join(project.path, '.modmind', 'player-tests', instanceName, 'game'),
    onState: () => undefined, onEvent: () => undefined
  })
  // Exercise real version parsing, checksums, filesystem caches and prepare().
  // Java provisioning is orthogonal and must never launch an actual game here.
  vi.spyOn(manager as unknown as { ensureJava: () => Promise<unknown> }, 'ensureJava').mockResolvedValue({
    target: 'java-runtime-gamma', javaPath: path.join(environment.root, 'java', 'bin', 'java.exe'), source: 'custom'
  })
  return manager
}

beforeEach(async () => {
  environment.root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-runtime-reuse-'))
  resourceRoot = path.join(environment.root, 'minecraft-runtime', 'game')
  project = { name: 'Test', path: path.join(environment.root, 'project'), loader: 'forge', loaderVersion: '1.20.1-47.4.23', minecraftVersion: '1.20.1', namespace: 'test', createdAt: '' }
  await write('versions/1.20.1/1.20.1.json', JSON.stringify({
    id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', assets: '5',
    assetIndex: { id: '5', sha1: sha1(index) }, libraries: [],
    downloads: { client: { sha1: sha1(client), size: client.length } }
  }))
  await write('versions/1.20.1/1.20.1.jar', client)
  await write(`versions/${loaderId}/${loaderId}.json`, JSON.stringify({
    id: loaderId, inheritsFrom: '1.20.1', mainClass: 'cpw.mods.modlauncher.Launcher',
    libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.4.23:universal', downloads: { artifact: { path: libraryPath, sha1: sha1(library), size: library.length } } }]
  }))
  await write(`libraries/${libraryPath}`, library)
  await write('assets/indexes/5.json', index)
  await write(`assets/objects/${sha1(asset).slice(0, 2)}/${sha1(asset)}`, asset)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(getVersionList).mockClear()
  const root = environment.root
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('shared Minecraft runtime reuse', () => {
  it('prepares successive isolated player tests from the existing install without contacting a download source', async () => {
    const first = await runtime('first-session').prepare()
    const second = await runtime('second-session').prepare()
    expect(first.installed).toBe(true)
    expect(second).toMatchObject({ installed: true, loaderVersionId: loaderId, loaderVersion: project.loaderVersion })
    expect(second.instancePath).not.toBe(first.instancePath)
    for (const state of [first, second]) {
      const metadata = JSON.parse(await fs.readFile(path.join(state.instancePath!, 'runtime.json'), 'utf8'))
      expect(metadata.loaderVersionId).toBe(loaderId)
    }
    expect(getVersionList).not.toHaveBeenCalled()
  })

  it('recovers missing metadata after restart and keeps existing instance files', async () => {
    const state = await runtime('same-session').prepare()
    await fs.writeFile(path.join(state.instancePath!, 'options.txt'), 'renderDistance:8')
    await fs.rm(path.join(state.instancePath!, 'runtime.json'))
    const restored = await runtime('same-session').prepare()
    expect(restored.installed).toBe(true)
    expect(await fs.readFile(path.join(restored.instancePath!, 'options.txt'), 'utf8')).toBe('renderDistance:8')
    expect(getVersionList).not.toHaveBeenCalled()
  })

  it('repairs a stale named asset index from the verified hash cache while offline', async () => {
    await write(`assets/indexes/${sha1(index)}.json`, index)
    await write('assets/indexes/5.json', '{"stale":true}')
    expect((await runtime('hash-index').prepare()).installed).toBe(true)
    expect(await fs.readFile(path.join(resourceRoot, 'assets/indexes/5.json'), 'utf8')).toBe(index)
    expect(getVersionList).not.toHaveBeenCalled()
  })

  it.each(['client', 'library', 'asset-index', 'asset'])('does not reuse a corrupt %s or write a ready marker', async broken => {
    if (broken === 'client') await write('versions/1.20.1/1.20.1.jar', 'corrupt')
    if (broken === 'library') await write(`libraries/${libraryPath}`, 'corrupt')
    if (broken === 'asset-index') await write('assets/indexes/5.json', 'corrupt')
    if (broken === 'asset') await write(`assets/objects/${sha1(asset).slice(0, 2)}/${sha1(asset)}`, 'x'.repeat(asset.length))
    await expect(runtime('broken').prepare()).rejects.toThrow()
    expect(getVersionList).toHaveBeenCalled()
    await expect(fs.stat(path.join(project.path, '.modmind/player-tests/broken/game/runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not substitute another Minecraft or loader version', async () => {
    expect(await installedRuntimeCandidates(resourceRoot, '1.21.1', 'forge', project.loaderVersion, false)).toEqual([])
    expect(await installedRuntimeCandidates(resourceRoot, '1.20.1', 'forge', '47.4.24', false)).toEqual([])
    expect(await installedRuntimeCandidates(resourceRoot, '1.20.1', 'fabric', '47.4.23', false)).toEqual([])
    expect(await installedRuntimeCandidates(resourceRoot, '1.20.1', 'forge', undefined, false)).toEqual([])
    expect(await installedRuntimeCandidates(resourceRoot, '1.20.1', 'forge', '47.4.23', false)).toEqual([loaderId])
  })

  it.each([
    ['fabric', 'net.fabricmc:fabric-loader:0.16.0', '0.16.0'],
    ['quilt', 'org.quiltmc:quilt-loader:0.26.0', '0.26.0'],
    ['neoforge', 'net.neoforged:forge:1.20.1-47.1.106', '1.20.1-47.1.106']
  ] as const)('matches %s profiles using library metadata even with a custom profile name', async (loader, libraryName, version) => {
    await write('versions/custom-profile/custom-profile.json', JSON.stringify({ id: 'custom-profile', inheritsFrom: '1.20.1', libraries: [{ name: libraryName }] }))
    expect(await installedRuntimeCandidates(resourceRoot, '1.20.1', loader, version, false)).toEqual(['custom-profile'])
  })

  it('selects only the base version for a vanilla client', async () => {
    expect(await installedRuntimeCandidates(resourceRoot, '1.20.1', 'paper', 'vanilla', true)).toEqual(['1.20.1'])
  })

  it('reuses an existing project record and repairs Java independently of the game', async () => {
    await runtime('existing-session').prepare()
    expect((await runtime('existing-session').prepare()).installed).toBe(true)
    expect(getVersionList).not.toHaveBeenCalled()
  })

  it('does not create metadata when preparation has been cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runtime('cancelled').prepare(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(getVersionList).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(project.path, '.modmind/player-tests/cancelled/game/runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
