import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import type { ProjectInfo } from '../shared/types'

const control = vi.hoisted(() => ({ launch: vi.fn(), root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => control.root } }))
vi.mock('@xmcl/core', async original => ({ ...await original<typeof import('@xmcl/core')>(), launch: (...args: unknown[]) => control.launch(...args) }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('disk full fixture'), { code: 'ENOSPC' })) } }) }))
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(control.root, { recursive: true, force: true }) })

it('stops its game and retains an error state when the launch transcript cannot be written', async () => {
  control.root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-launch-log-error-'))
  const project = { path: control.root, loader: 'fabric', minecraftVersion: '1.20.1', kind: 'mod' } as ProjectInfo
  const events: unknown[] = []
  const manager = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: event => events.push(event) })
  const child = Object.assign(new EventEmitter(), { pid: 12345, killed: false, exitCode: null as number | null, stdout: new PassThrough(), stderr: new PassThrough() })
  const stop = vi.fn(() => { child.killed = true; child.exitCode = 0; child.emit('close', 0, null) })
  Object.assign(manager, {
    prepare: async () => undefined,
    readMetadata: async () => ({ loaderVersionId: 'audit-profile', javaPath: process.execPath }),
    resolveLaunchJava: async () => process.execPath,
    killProcessTree: stop
  })
  control.launch.mockResolvedValue(child)
  await manager.launch({ username: 'AuditUser', maxMemoryMb: 1024, withoutProjectMod: true })
  child.emit('spawn')
  child.stdout.write('game output\n')
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(manager.getState()).toMatchObject({ stage: 'error', running: false, pid: undefined }))
  expect(manager.getState().message).toContain('日志写入失败')
  expect(events).toContainEqual(expect.objectContaining({ stage: 'error', message: expect.stringContaining('disk full') }))
})
