import { describe, expect, it, vi } from 'vitest'
import { runRenderedMinecraftTest } from './renderedMinecraftTest'
import type { MinecraftLaunchTestResult } from '../shared/minecraft'

function fixture() {
  return {
    isRunning: vi.fn(() => false), build: vi.fn(async () => ({})), stop: vi.fn(async () => ({})),
    launch: vi.fn(async () => ({ success: true, state: { running: true } }) as MinecraftLaunchTestResult)
  }
}

describe('managed visible client test', () => {
  it('builds before launching and cleans up without claiming visual or gameplay evidence', async () => {
    const dependencies = fixture()
    expect(await runRenderedMinecraftTest(dependencies)).toMatchObject({ success: true, visualVerified: false, gameplayVerified: false, clientStopped: true })
    expect(dependencies.launch.mock.invocationCallOrder[0]).toBeGreaterThan(dependencies.build.mock.invocationCallOrder[0])
    expect(dependencies.stop.mock.invocationCallOrder[0]).toBeGreaterThan(dependencies.launch.mock.invocationCallOrder[0])
  })

  it('never takes over or stops an existing user client', async () => {
    const dependencies = fixture()
    dependencies.isRunning.mockReturnValue(true)
    await expect(runRenderedMinecraftTest(dependencies)).rejects.toThrow('已有 Minecraft')
    expect(dependencies.build).not.toHaveBeenCalled()
    expect(dependencies.stop).not.toHaveBeenCalled()
  })

  it('does not stop a client started by the user during the build', async () => {
    const dependencies = fixture()
    dependencies.isRunning.mockReturnValueOnce(false).mockReturnValue(true)
    await expect(runRenderedMinecraftTest(dependencies)).rejects.toThrow('构建期间')
    expect(dependencies.launch).not.toHaveBeenCalled()
    expect(dependencies.stop).not.toHaveBeenCalled()
  })

  it('cleans up after launch failure and propagates cleanup failures', async () => {
    const dependencies = fixture()
    dependencies.launch.mockRejectedValueOnce(new Error('launch failed'))
    await expect(runRenderedMinecraftTest(dependencies)).rejects.toThrow('launch failed')
    expect(dependencies.stop).toHaveBeenCalledOnce()
    dependencies.stop.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(runRenderedMinecraftTest(dependencies)).rejects.toThrow('cleanup failed')
  })

  it('does not launch after cancellation during build', async () => {
    const dependencies = fixture()
    const controller = new AbortController()
    dependencies.build.mockImplementationOnce(async () => { controller.abort(); return {} })
    await expect(runRenderedMinecraftTest(dependencies, controller.signal)).rejects.toThrow()
    expect(dependencies.launch).not.toHaveBeenCalled()
    expect(dependencies.stop).not.toHaveBeenCalled()
  })
})
