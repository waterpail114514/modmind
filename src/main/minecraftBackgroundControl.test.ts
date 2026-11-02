import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MinecraftRuntimeManager } from '../../feature-plugins/testing/src/main/minecraftRuntime'
import { BackgroundGameControlSession } from '../../feature-plugins/testing/src/main/gameControlSession'
import type { ProjectInfo } from '../shared/types'

const control = vi.hoisted(() => ({ launch: vi.fn(), spawn: vi.fn(), root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => control.root } }))
vi.mock('@xmcl/core', async original => ({ ...await original<typeof import('@xmcl/core')>(), launch: (...args: unknown[]) => control.launch(...args) }))
vi.mock('./processTree', async original => ({ ...await original<typeof import('./processTree')>(), spawnManaged: (...args: unknown[]) => control.spawn(...args) }))
const children: EventEmitter[] = []

afterEach(async () => {
  for (const child of children.splice(0)) { child.emit('exit', 0, null); child.emit('close', 0, null) }
  await new Promise(resolve => setTimeout(resolve, 20))
  vi.restoreAllMocks(); control.launch.mockReset(); control.spawn.mockReset()
  await fs.rm(control.root, { recursive: true, force: true })
})

async function manager() {
  control.root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-background-launch-'))
  const project = { path: control.root, loader: 'fabric', minecraftVersion: '1.20.1', kind: 'mod' } as ProjectInfo
  const runtime = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: () => {} })
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() })
  children.push(child)
  Object.assign(runtime, {
    prepare: async () => undefined,
    readMetadata: async () => ({ loaderVersionId: 'owned-fixture', javaPath: process.execPath }),
    resolveLaunchJava: async () => process.execPath,
    handleMinecraftExit: async () => undefined
  })
  control.spawn.mockReturnValue(child)
  control.launch.mockImplementation(async options => options.spawn('fixture-java', [], { env: { PATH: 'fixture-path' } }))
  return { runtime, child }
}

it('loads the bundled agent only for an explicit background test launch and scopes its token to the child', async () => {
  const { runtime, child } = await manager()
  const previous = process.env.MODMIND_GAME_CONTROL_TOKEN
  await runtime.launch({ username: 'ProbeUser', maxMemoryMb: 1024, withoutProjectMod: true, backgroundControl: true })
  const options = control.launch.mock.calls[0][0]
  expect(options.extraJVMArgs).toEqual([expect.stringMatching(/^-Dfabric.systemLibraries=.*agent-[a-f0-9]{64}\.jar$/), expect.stringMatching(/^-javaagent:.*agent-[a-f0-9]{64}\.jar$/)])
  const spawnOptions = control.spawn.mock.calls[0][2]
  expect(spawnOptions.env.MODMIND_GAME_CONTROL_TOKEN).toMatch(/^[a-f0-9]{64}$/)
  const session = runtime.getBackgroundGameControl()
  expect(spawnOptions.env.MODMIND_GAME_CONTROL_CONFIG).toBe(session.configurationPath)
  expect(await fs.readFile(session.configurationPath, 'utf8')).toBe(`sessionId=${session.sessionId}\n`)
  expect(process.env.MODMIND_GAME_CONTROL_TOKEN).toBe(previous)
  child.emit('exit', 0, null)
  expect(() => runtime.getBackgroundGameControl()).toThrow('未启用')
})

it('preserves a normal launch without adding an agent or virtual input environment', async () => {
  const { runtime } = await manager()
  await runtime.launch({ username: 'ProbeUser', maxMemoryMb: 1024, withoutProjectMod: true })
  expect(control.launch.mock.calls[0][0].extraJVMArgs).toBeUndefined()
  expect(control.spawn.mock.calls[0][2].env).toEqual({ PATH: 'fixture-path' })
  expect(() => runtime.getBackgroundGameControl()).toThrow('未启用')
})

it('removes the session configuration when the launcher fails before starting the game', async () => {
  const { runtime } = await manager()
  const prepared = vi.spyOn(BackgroundGameControlSession, 'prepare')
  control.launch.mockRejectedValue(new Error('fixture launch failure'))
  await expect(runtime.launch({ username: 'ProbeUser', maxMemoryMb: 1024, withoutProjectMod: true, backgroundControl: true })).rejects.toThrow('fixture launch failure')
  const session = await prepared.mock.results[0].value
  await expect(fs.access(session.configurationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.access(session.configurationPath + '.endpoint')).rejects.toMatchObject({ code: 'ENOENT' })
})
