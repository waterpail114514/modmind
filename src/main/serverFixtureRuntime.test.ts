import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { installFixtureRuntime } from './serverFixtureRuntime'
import { installServerRuntime, type ServerRuntimeInstallOptions } from './serverPackService'
import type { ProjectInfo } from '../shared/types'
vi.mock('./serverPackService', () => ({ installServerRuntime: vi.fn(async (options: ServerRuntimeInstallOptions, project: ProjectInfo) => {
  const root = options.serverPack.root
  const exists = await fs.stat(path.join(root, '.modmind-server-runtime.json')).then(() => true, () => false)
  if (!exists) {
    await fs.mkdir(path.join(root, 'libraries'), { recursive: true })
    await fs.writeFile(path.join(root, 'libraries/version.jar'), 'runtime fixture')
    await fs.writeFile(path.join(root, 'run.bat'), 'fixture')
    await fs.writeFile(path.join(root, '.modmind-server-runtime.json'), JSON.stringify({ minecraftVersion: project.minecraftVersion, loader: project.loader, loaderVersion: project.loaderVersion }))
  }
  options.signal?.throwIfAborted()
  return { loader: project.loader, loaderVersion: project.loaderVersion!, launchCommand: [path.join(root, 'run.bat')] }
}) }))
const roots: string[] = []
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
it('reuses only fixed-version runtime files and keeps each session mods, properties and world independent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-fixture-runtime-')); roots.push(root)
  const project: ProjectInfo = { path: root, name: 'Pack', namespace: 'pack', kind: 'modpack', minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', createdAt: '' }
  for (const session of ['first', 'second']) {
    const game = path.join(root, session)
    await fs.mkdir(path.join(game, 'mods'), { recursive: true }); await fs.mkdir(path.join(game, 'world'))
    await fs.writeFile(path.join(game, 'mods/test.jar'), session)
    await fs.writeFile(path.join(game, 'server.properties'), `session=${session}`)
    const result = await installFixtureRuntime(path.join(root, 'cache'), { javaPath: 'java', serverPack: { root: game, copiedMods: [], skippedClientMods: [], warnings: [], manifestPath: '' } }, project)
    expect(result.launchCommand).toEqual([path.join(game, 'run.bat')])
    expect(await fs.readFile(path.join(game, 'mods/test.jar'), 'utf8')).toBe(session)
    expect(await fs.readFile(path.join(game, 'server.properties'), 'utf8')).toBe(`session=${session}`)
  }
  expect(installServerRuntime).toHaveBeenCalledTimes(3)
  const cached = (await fs.readdir(path.join(root, 'cache')))[0]
  expect(await fs.readdir(path.join(root, 'cache', cached))).not.toContain('mods')
  expect(await fs.readdir(path.join(root, 'cache', cached))).not.toContain('world')
})
it('removes partial caches on installation failure and permits a later retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-fixture-runtime-fail-')); roots.push(root)
  const project = { path: root, minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', kind: 'modpack' } as ProjectInfo
  const options = { javaPath: 'java', serverPack: { root: path.join(root, 'game'), copiedMods: [], skippedClientMods: [], warnings: [], manifestPath: '' } }
  vi.mocked(installServerRuntime).mockRejectedValueOnce(new Error('fixture install failed'))
  await expect(installFixtureRuntime(path.join(root, 'cache'), options, project)).rejects.toThrow('fixture install failed')
  expect(await fs.readdir(path.join(root, 'cache'))).toEqual([])
  await fs.mkdir(options.serverPack.root)
  await installFixtureRuntime(path.join(root, 'cache'), options, project)
  expect((await fs.readdir(path.join(root, 'cache'))).length).toBe(1)
})
it('uses generated Forge argument files with the selected Java instead of a pausing batch launcher', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-fixture-launch-')); roots.push(root)
  const project = { path: root, minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', kind: 'modpack' } as ProjectInfo
  vi.mocked(installServerRuntime).mockImplementationOnce(async options => {
    const pack = options.serverPack.root
    const argumentsPath = `libraries/net/minecraftforge/forge/1.20.1-47.4.23/${process.platform === 'win32' ? 'win' : 'unix'}_args.txt`
    await fs.mkdir(path.dirname(path.join(pack, argumentsPath)), { recursive: true })
    await fs.writeFile(path.join(pack, argumentsPath), '--launchTarget forgeserver')
    await fs.writeFile(path.join(pack, process.platform === 'win32' ? 'run.bat' : 'run.sh'), `java @user_jvm_args.txt @${argumentsPath} %*\npause`)
    await fs.writeFile(path.join(pack, '.modmind-server-runtime.json'), '{}')
    return { loader: 'forge', loaderVersion: '47.4.23', launchCommand: ['unused'] }
  })
  const game = path.join(root, 'game'); await fs.mkdir(game)
  const result = await installFixtureRuntime(path.join(root, 'cache'), { javaPath: 'selected-java', serverPack: { root: game, copiedMods: [], skippedClientMods: [], warnings: [], manifestPath: '' } }, project)
  expect(result.launchCommand[0]).toBe('selected-java')
  expect(result.launchCommand).toEqual(expect.arrayContaining([expect.stringContaining('@libraries/net/minecraftforge/forge/1.20.1-47.4.23')]))
  expect(result.launchCommand).not.toContain('pause')
})
