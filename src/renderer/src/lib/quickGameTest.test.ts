import { describe, expect, it, vi } from 'vitest'
import type { ModMindApi, ProjectInfo } from '../../../shared/types'
import { launchQuickGameTest, quickTestOptions, quickTestUnavailable } from './quickGameTest'

const project: ProjectInfo = { name: 'test', namespace: 'test', path: '/project', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
const options = { username: 'ModMindDev', maxMemoryMb: 4096 }
function fixture(target = project) {
  const calls: string[] = []
  const running = { projectPath: target.path, stage: 'running', running: true, message: 'running' }
  const api = {
    project: { current: vi.fn(async () => target) },
    minecraft: {
      getState: vi.fn(async () => ({ running: false })),
      buildProject: vi.fn(async () => { calls.push('build') }),
      syncModpack: vi.fn(async () => { calls.push('sync') }),
      launch: vi.fn(async () => { calls.push('launch'); return running })
    },
    localTest: {
      getState: vi.fn(async () => ({ active: false })),
      start: vi.fn(async () => { calls.push('server-and-client'); return { ...running, active: true } })
    }
  }
  const start = (signal = new AbortController().signal) => launchQuickGameTest(api as unknown as ModMindApi, target, options, signal)
  return { api, calls, start }
}

describe('one-click game testing', () => {
  it('builds and synchronizes a mod before opening its game', async () => {
    const { api, calls, start } = fixture()
    await start()
    expect(calls).toEqual(['build', 'launch'])
    expect(api.minecraft.buildProject).toHaveBeenCalledWith(project.path)
  })
  it('synchronizes a modpack before opening its client', async () => {
    const { calls, start } = fixture({ ...project, kind: 'modpack' })
    await start()
    expect(calls).toEqual(['sync', 'launch'])
  })
  it('starts a plugin server and connected client through the existing service', async () => {
    const { api, calls, start } = fixture({ ...project, kind: 'server-plugin', loader: 'paper' })
    await start()
    expect(calls).toEqual(['server-and-client'])
    expect(api.localTest.start).toHaveBeenCalledWith(options)
  })
  it('never launches after a build failure or cancellation', async () => {
    const failed = fixture()
    failed.api.minecraft.buildProject.mockRejectedValueOnce(new Error('build failed'))
    await expect(failed.start()).rejects.toThrow('build failed')
    expect(failed.api.minecraft.launch).not.toHaveBeenCalled()
    const cancelled = fixture()
    const controller = new AbortController()
    cancelled.api.minecraft.buildProject.mockImplementationOnce(async () => { controller.abort() })
    await expect(cancelled.start(controller.signal)).rejects.toThrow()
    expect(cancelled.api.minecraft.launch).not.toHaveBeenCalled()
  })
  it('never launches against a project selected while building', async () => {
    const { api, start } = fixture()
    api.minecraft.buildProject.mockImplementationOnce(async () => {
      api.project.current.mockResolvedValue({ ...project, path: '/another-project' })
    })
    await expect(start()).rejects.toThrow('当前项目已切换')
    expect(api.minecraft.launch).not.toHaveBeenCalled()
  })
  it('reuses a running game and reports launch failures', async () => {
    const running = fixture()
    running.api.minecraft.getState.mockResolvedValue({ running: true })
    await running.start()
    expect(running.calls).toEqual([])
    const failed = fixture()
    failed.api.minecraft.launch.mockResolvedValue({ projectPath: project.path, stage: 'error', running: false, message: 'launch failed' })
    await expect(failed.start()).rejects.toThrow('launch failed')
  })
  it('explains unsupported platforms before starting any process', async () => {
    for (const loader of ['bedrock', 'netease-pc', 'netease-mobile', 'velocity'] as const) {
      const target = { ...project, loader }
      const { calls, start } = fixture(target)
      expect(quickTestUnavailable(target)).toBeTruthy()
      await expect(start()).rejects.toThrow()
      expect(calls).toEqual([])
    }
  })
  it('recovers invalid stored launch settings with valid defaults', () => {
    expect(quickTestOptions({ getItem: () => 'invalid value!' })).toEqual({ ...options, width: 1280, height: 720 })
    expect(quickTestOptions({ getItem: key => key.endsWith('username') ? 'Player_1' : '8192' }).maxMemoryMb).toBe(8192)
  })
})
