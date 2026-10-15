import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeadlessMcService } from './headlessMcService'
import type { ProjectInfo } from '../shared/types'

const control = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn(), failLog: false }))
vi.mock('./processTree', () => ({ spawnManaged: (...args: unknown[]) => control.spawn(...args), stopProcessTree: (...args: unknown[]) => control.stop(...args) }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(control.failLog ? Object.assign(new Error('ENOSPC fixture'), { code: 'ENOSPC' }) : undefined) } }) }))
const roots: string[] = []
beforeEach(() => { control.failLog = false; control.spawn.mockReset(); control.stop.mockReset() })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(launchOutput: string, connectOutput = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-headless-failure-')); roots.push(root)
  const mods = path.join(root, 'source-mods'); await fs.mkdir(mods); await fs.writeFile(path.join(mods, 'fixture.jar'), 'local mod fixture')
  const child = Object.assign(new EventEmitter(), { pid: 12345, killed: false, exitCode: null as number | null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as unknown as Writable })
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const command = String(chunk)
    if (command.startsWith('launch ')) setImmediate(() => child.stdout.write(launchOutput))
    if (command.startsWith('connect ')) setImmediate(() => child.stdout.write(connectOutput))
    callback()
  } })
  control.spawn.mockReturnValue(child)
  control.stop.mockImplementation(async () => { child.exitCode = 0; child.killed = true; child.emit('exit', 0); child.stdout.end(); child.stderr.end(); child.emit('close', 0) })
  const service = new HeadlessMcService({ userDataDirectory: root, onEvent: () => {} })
  vi.spyOn(service, 'ensureLauncher').mockResolvedValue(path.join(root, 'launcher.jar'))
  const project = { loader: 'fabric', minecraftVersion: '1.20.1', path: root } as ProjectInfo
  const run = (serverAddress?: string, signal?: AbortSignal) => service.run({ project, javaPath: process.execPath, gameDirectory: path.join(root, 'game'), sourceModsDirectory: mods, stableWindowMs: 5000, joinTimeoutMs: 5000, offline: true, serverAddress }, signal)
  return { run, child }
}

it('rejects an exited game even when its launcher remains alive', async () => {
  const f = await fixture('Launching Minecraft\nGame process exited with code 1\n')
  await expect(f.run()).rejects.toThrow('Game process exited')
  expect(control.stop).toHaveBeenCalled()
})
it('does not accept a joining attempt followed by a refused connection', async () => {
  const f = await fixture('[Render thread/INFO]: Reloading ResourceManager: vanilla\n', 'Joining server 127.0.0.1\nConnection refused\n')
  await expect(f.run('127.0.0.1:25565')).rejects.toThrow('Connection refused')
}, 10000)
it('accepts positive join evidence while the owned launcher remains running', async () => {
  const f = await fixture('[Render thread/INFO]: Reloading ResourceManager: vanilla\n', 'Player joined the game\n')
  await expect(f.run('127.0.0.1:25565')).resolves.toMatchObject({ success: true, joinedServer: true })
}, 10000)
it('does not declare a launcher download announcement to be a running game', async () => {
  const f = await fixture('Launching version fabric-loader-0.19.5-1.20.1\nDownloading Libraries 50%\n')
  await expect(f.run(undefined, AbortSignal.timeout(100))).rejects.toMatchObject({ name: 'AbortError' })
})
it('reports a failed transcript and settles cleanup without an unhandled stream error', async () => {
  control.failLog = true
  const f = await fixture('Launching Minecraft\n')
  await expect(f.run()).rejects.toThrow('日志写入失败')
  expect(control.stop).toHaveBeenCalled()
})
