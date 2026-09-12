import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { LocalServerManager } from './localServerService'
import { createModpackTemplate } from './modpackService'
import * as serverPackService from './serverPackService'
import { ServerProcess } from './serverVerificationService'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

const project: ProjectInfo = {
  kind: 'modpack',
  name: 'Local Panel Test',
  path: 'C:/modmind-local-panel-test',
  loader: 'fabric',
  minecraftVersion: '1.21.1',
  loaderVersion: '0.19.3',
  namespace: 'local_panel_test',
  createdAt: new Date().toISOString()
}

describe('local server manager', () => {
  it.each([false, true])('starts without another EULA confirmation (existing pack: %s)', async (existingPack) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-local-eula-'))
    roots.push(root)
    const activeProject = { ...project, path: root }
    await createModpackTemplate(activeProject)
    const packRoot = path.join(root, '.modmind', 'server-pack')
    if (existingPack) await serverPackService.buildServerPack(activeProject, { outputDirectory: packRoot, acceptEula: false })
    vi.spyOn(serverPackService, 'installServerRuntime').mockResolvedValue({ launchCommand: ['unused'], loader: 'fabric', loaderVersion: project.loaderVersion! })
    const startProcess = vi.spyOn(ServerProcess.prototype, 'start').mockImplementation(async options => ({ address: `127.0.0.1:${options.port}`, logPath: path.join(options.pack.root, 'logs', 'latest.log') }))
    const manager = new LocalServerManager({ getProject: () => activeProject, getJavaPath: async () => 'unused', onState: () => undefined, onEvent: () => undefined })

    try {
      await expect(manager.start()).resolves.toMatchObject({ stage: 'running', running: true })
      const instanceRoot = path.join(root, '.modmind', 'server', 'instances', 'modpack')
      await expect(fs.readFile(path.join(instanceRoot, 'eula.txt'), 'utf8')).resolves.toBe('eula=true\n')
      if (!existingPack) await expect(fs.readFile(path.join(packRoot, 'eula.txt'), 'utf8')).resolves.toBe('eula=true\n')
      expect(startProcess).toHaveBeenCalledWith(expect.objectContaining({ pack: expect.objectContaining({ root: instanceRoot }) }))
    } finally {
      await manager.stop()
    }
  })

  it('preserves explicit EULA refusal before installing or launching a new server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-local-eula-refusal-'))
    roots.push(root)
    const activeProject = { ...project, path: root }
    await createModpackTemplate(activeProject)
    const installRuntime = vi.spyOn(serverPackService, 'installServerRuntime')
    const startProcess = vi.spyOn(ServerProcess.prototype, 'start')
    const manager = new LocalServerManager({ getProject: () => activeProject, getJavaPath: async () => 'unused', onState: () => undefined, onEvent: () => undefined })

    await expect(manager.start({ acceptEula: false })).rejects.toThrow('首次启动需要接受 Minecraft EULA')
    await expect(fs.readFile(path.join(root, '.modmind', 'server', 'instances', 'modpack', 'eula.txt'), 'utf8')).resolves.toBe('eula=false\n')
    expect(installRuntime).not.toHaveBeenCalled()
    expect(startProcess).not.toHaveBeenCalled()
  })

  it('cancels preparation before any core install can start and keeps the captured project', async () => {
    let captured: ProjectInfo | undefined
    const manager = new LocalServerManager({ getProject: () => ({ ...project, kind: 'server-plugin', loader: 'paper' }), getJavaPath: vi.fn(async () => 'unused'), onState: () => undefined, onEvent: () => undefined, buildPlugin: (value, signal) => { captured = value; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) } })
    const start = manager.start().catch(error => error)
    expect(manager.isBusy()).toBe(true)
    expect(manager.getState().projectPath).toBe(project.path)
    await manager.stop()
    await start
    expect(captured?.loader).toBe('paper')
    expect(manager.isBusy()).toBe(false)
    expect(manager.getState()).toMatchObject({ stage: 'stopped', running: false, canCancel: false })
  })
  it('starts with a project-aware idle state and rejects commands before launch', async () => {
    const manager = new LocalServerManager({
      getProject: () => project,
      getJavaPath: async () => 'C:/java/bin/java.exe',
      onState: () => undefined,
      onEvent: () => undefined
    })
    expect(manager.getState()).toMatchObject({ stage: 'idle', running: false, recentLogs: [] })
    await expect(manager.sendCommand('list')).rejects.toThrow('请先启动本机服务端')
    await expect(manager.stop()).resolves.toMatchObject({ stage: 'idle', running: false })
  })

  it('keeps synchronization output in the service panel before the server is running', () => {
    const states: string[] = []
    const manager = new LocalServerManager({
      getProject: () => project,
      getJavaPath: async () => 'C:/java/bin/java.exe',
      onState: (state) => states.push(state.recentLogs.at(-1)?.message ?? ''),
      onEvent: () => undefined
    })

    manager.recordOperation('ServerPackCreator synchronization started')
    manager.recordOperation('ServerPackCreator synchronization completed', 'info', 'C:/logs/serverpackcreator.log')

    expect(manager.getState()).toMatchObject({ stage: 'idle', running: false, logPath: 'C:/logs/serverpackcreator.log' })
    expect(manager.getState().recentLogs).toEqual([
      expect.objectContaining({ message: 'ServerPackCreator synchronization started', level: 'info' }),
      expect.objectContaining({ message: 'ServerPackCreator synchronization completed', level: 'info' })
    ])
    expect(manager.getState().recentLogs.every((entry) => Number.isFinite(Date.parse(entry.time)))).toBe(true)
    expect(states).toEqual(['ServerPackCreator synchronization started', 'ServerPackCreator synchronization completed'])
  })
})
