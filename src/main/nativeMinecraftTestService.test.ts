import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeMinecraftTestService, copyNativeTestInstance, nativeAction } from './nativeMinecraftTestService'
import type { ProjectInfo } from '../shared/types'
import type { MinecraftRuntimeState } from '../shared/minecraft'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
vi.mock('./downloadService', () => ({ verifiedDownload: { download: vi.fn() } }))
vi.mock('./creationFeedbackService', () => ({ CreationFeedbackService: class { async evidence() { return { id: 'evidence' } }; async check() {} } }))
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function root() {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-mcp-service-'))
  cleanups.push(() => fs.rm(result, { recursive: true, force: true })); return result
}
it('isolates copied mods and config from user saves and options', async () => {
  const source = await root(); const destination = await root()
  await fs.mkdir(path.join(source, 'mods')); await fs.mkdir(path.join(source, 'saves'))
  await fs.writeFile(path.join(source, 'mods', 'target.jar'), 'mod')
  await fs.writeFile(path.join(source, 'options.txt'), 'user-settings')
  await fs.writeFile(path.join(source, 'saves', 'world'), 'user-world')
  await copyNativeTestInstance(source, destination)
  expect(await fs.readdir(destination)).toEqual(['mods'])
  await fs.writeFile(path.join(destination, 'mods', 'target.jar'), 'test-only')
  expect(await fs.readFile(path.join(source, 'mods', 'target.jar'), 'utf8')).toBe('mod')
})
it('validates native actions and translates coordinates, keys, view and build commands', () => {
  expect(nativeAction({ operation: 'key', key: 'w', durationMs: 1000 })).toEqual({ command: 'press_key', params: { key: 'key.keyboard.w', hold_seconds: 1 } })
  expect(nativeAction({ operation: 'click', x: 123, y: 45, button: 1 }).params).toEqual({ x: 123, y: 45, button: 'right' })
  expect(nativeAction({ operation: 'command', command: 'setblock 0 64 0 stone' }).params.command).toBe('/setblock 0 64 0 stone')
  expect(() => nativeAction({ operation: 'look', yaw: 0, pitch: 91 })).toThrow('pitch')
  expect(() => nativeAction({ operation: 'key', key: 'w', durationMs: 10000 })).toThrow('durationMs')
  expect(() => nativeAction({ operation: 'command', command: 'say hi\nstop' })).toThrow('文字')
  expect(() => nativeAction({ operation: 'operator' })).toThrow('不支持')
})
async function fixture() {
  const directory = await root()
  const project = { path: directory, kind: 'mod', loader: 'fabric', minecraftVersion: '1.20.1' } as ProjectInfo
  const mods = path.join(directory, '.modmind', 'minecraft', 'mods'); await fs.mkdir(mods, { recursive: true })
  const artifact = { name: 'target.jar', path: path.join(mods, 'target.jar'), size: 3, modifiedAt: '', projectArtifact: true }
  await fs.writeFile(artifact.path, 'jar')
  let state = { running: false, stage: 'idle', message: '' } as MinecraftRuntimeState
  let screen = 'title'; let port = 0
  const commands: string[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/api/status') { res.end(JSON.stringify({ ok: true, type: 'minecraft-mod', pid: 1234, port })); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); commands.push(body.cmd)
    const reply = body.cmd === 'get_screen_buttons' ? { screen, buttons: [{ label: 'Play' }] }
      : body.cmd === 'enter_control_mode' ? { control_mode: true }
      : body.cmd === 'get_player_info' ? { name: null }
      : body.cmd === 'get_world_info' ? { world: null } : { result: 'ok' }
    res.end(JSON.stringify(reply))
  })
  const stop = vi.fn(async () => {
    state = { ...state, running: false, stage: 'stopped' }
    if (server.listening) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    return state
  })
  const build = vi.fn(async () => artifact)
  const install = vi.fn(async () => {})
  const service = new NativeMinecraftTestService({ currentProject: () => project, build, install, createRuntime: (_project, _directory, endpoint) => {
    port = endpoint
    return { getState: () => state, stop, launch: async () => {
      await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
      state = { ...state, running: true, stage: 'running', pid: 1234 }; return state
    } }
  } })
  cleanups.push(() => service.stop())
  return { service, project, commands, stop, build, install, change: () => { screen = 'different' } }
}
it('starts an isolated mod client, guards stale UI actions, observes results and cleans up on project switch', async () => {
  const f = await fixture()
  expect(await f.service.execute(f.project, 'session', { operation: 'capabilities' })).toMatchObject({ modes: ['rendered'], supported: true, runtimeVerified: false })
  const started = await f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered' }) as { sessionId: string; observation: { revision: string } }
  expect(f.build).toHaveBeenCalledOnce(); expect(f.install).toHaveBeenCalledOnce()
  await expect(f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered' })).rejects.toThrow('已有')
  f.change()
  await expect(f.service.execute(f.project, 'action', { sessionId: started.sessionId, operation: 'click', slot: 0, revision: started.observation.revision })).rejects.toThrow('界面已改变')
  expect(f.commands).not.toContain('click_button_index')
  const observed = await f.service.execute(f.project, 'observe', { sessionId: started.sessionId }) as { observation: { revision: string } }
  expect(await f.service.execute(f.project, 'action', { sessionId: started.sessionId, operation: 'click', slot: 0, revision: observed.observation.revision })).toMatchObject({ acknowledged: true, gameplayVerified: false })
  await f.service.projectChanged('another-project')
  expect(f.stop).toHaveBeenCalledOnce()
  await expect(f.service.execute(f.project, 'capture', { sessionId: started.sessionId })).rejects.toThrow('过期')
})
it('rejects unsupported versions and hidden/headless mode before building', async () => {
  const f = await fixture()
  for (const input of [{ mode: 'headless' }, { mode: 'rendered', hidden: true }]) {
    await expect(f.service.execute(f.project, 'session', { operation: 'start', ...input })).rejects.toThrow('可见')
  }
  f.project.loader = 'quilt'
  await expect(f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered' })).rejects.toThrow('尚无匹配')
  expect(f.build).not.toHaveBeenCalled()
})
it('cancels build preparation and cleans up without launching or installing', async () => {
  const f = await fixture(); const controller = new AbortController()
  f.build.mockImplementationOnce(async () => { controller.abort(); throw new Error('cancelled') })
  await expect(f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered' }, controller.signal)).rejects.toThrow('cancelled')
  await f.service.stop()
  expect(f.install).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalledOnce()
})
it('stops only the native session owned by the finishing agent turn', async () => {
  const f = await fixture(); const owner = new AbortController(); const other = new AbortController()
  await f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered' }, owner.signal)
  await f.service.stopForSignal(other.signal)
  expect(f.stop).not.toHaveBeenCalled()
  await f.service.stopForSignal(owner.signal)
  expect(f.stop).toHaveBeenCalledOnce()
})
it('does not count command acknowledgements as scenario assertions and stops at the failed step', async () => {
  const f = await fixture()
  const start = await f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered' }) as { sessionId: string }
  const result = await f.service.execute(f.project, 'scenario', { sessionId: start.sessionId, steps: [
    { operation: 'command', command: 'setblock 0 64 0 stone', expect: ['ok'] },
    { operation: 'command', command: 'give @s diamond', expect: ['diamond'] }
  ] })
  expect(result).toMatchObject({ success: false, failedStep: 1, visualVerified: false })
  expect(f.commands.filter(command => command === 'execute_command')).toHaveLength(1)
})
