import { describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { LocalServerManager } from './localServerService'

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
