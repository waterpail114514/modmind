import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launch } from '@xmcl/core'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import type { ProjectInfo } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => process.env.TEMP || '/tmp' } }))
vi.mock('@xmcl/core', async importOriginal => ({ ...await importOriginal<typeof import('@xmcl/core')>(), launch: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(launch).mockReset()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-vanilla-test-'))
  roots.push(root)
  const project: ProjectInfo = { path: root, name: 'Plugin', namespace: 'test', kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.20.1', createdAt: '' }
  const instance = path.join(root, '.modmind', 'local-test-client')
  await fs.mkdir(instance, { recursive: true })
  await fs.writeFile(path.join(instance, 'runtime.json'), JSON.stringify({ minecraftVersion: '1.20.1', loader: 'paper', loaderVersion: 'vanilla', loaderVersionId: '1.20.1', javaPath: 'test-java', javaSource: 'custom', preparedAt: new Date().toISOString() }))
  const runtime = new MinecraftRuntimeManager({ getProject: () => project, vanillaClient: true, instanceDirectory: instance, onState: () => undefined, onEvent: () => undefined })
  vi.spyOn(runtime, 'prepare').mockResolvedValue(runtime.getState())
  return { runtime, instance }
}

describe('visible plugin test client', () => {
  it('launches the matching vanilla version in its isolated instance without requiring a project Mod or pack manifest', async () => {
    const { runtime, instance } = await fixture()
    const child = new EventEmitter() as ChildProcess
    vi.mocked(launch).mockResolvedValue(child)
    await runtime.launch({ username: 'ModMindDev', maxMemoryMb: 4096, server: { ip: '127.0.0.1', port: 25565 } })
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ version: '1.20.1', javaPath: 'test-java', gamePath: instance, quickPlayMultiplayer: '127.0.0.1:25565', extraExecOption: { cwd: instance, windowsHide: false } }))
    child.emit('spawn')
    expect(runtime.getState().running).toBe(true)
    child.emit('close', 0, null)
    await vi.waitFor(() => expect(runtime.getState().stage).toBe('stopped'))
  })

  it('does not launch if cancelled after preparation', async () => {
    const { runtime } = await fixture()
    const controller = new AbortController()
    vi.mocked(runtime.prepare).mockImplementation(async () => { controller.abort(); return runtime.getState() })
    await expect(runtime.launch({ username: 'ModMindDev', maxMemoryMb: 4096 }, controller.signal)).rejects.toThrow()
    expect(launch).not.toHaveBeenCalled()
  })
})
