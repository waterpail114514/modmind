import { describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import type { LocalServerState, MinecraftRuntimeState } from '../shared/minecraft'
import { LocalServerManager } from './localServerService'
import { LocalTestService } from './localTestService'
import { multiplayerLaunchOptions } from './minecraftRuntime'

const options = { username: 'ModMindDev', maxMemoryMb: 4096, port: 25565 }
const project: ProjectInfo = { path: 'C:/test', name: 'Test', namespace: 'test', createdAt: '', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.20.1' }
const clientState: MinecraftRuntimeState = { stage: 'idle', installed: true, running: false, minecraftVersion: '1.20.1', message: 'ready', mods: [] }

function fixture(kind: ProjectInfo['kind'] = 'modpack') {
  const order: string[] = []
  let state: LocalServerState = { stage: 'idle', running: false, minecraftVersion: '1.20.1', recentLogs: [], message: '' }
  let controller: AbortController
  let starting: Promise<LocalServerState> | undefined
  const server = {
    isBusy: () => Boolean(starting || state.running),
    getState: () => state,
    start: vi.fn((_options, beforeStart: (signal: AbortSignal) => Promise<void>) => {
      controller = new AbortController()
      state = { ...state, sessionId: 'owned', stage: 'preparing' }
      order.push('prepare-server')
      starting = (async () => {
        await beforeStart(controller.signal)
        controller.signal.throwIfAborted()
        order.push('start-server')
        await ready()
        controller.signal.throwIfAborted()
        order.push('server-ready')
        state = { ...state, running: true, stage: 'running', port: 25566 }
        return state
      })().finally(() => { starting = undefined })
      return starting
    }),
    stop: vi.fn(async () => {
      controller?.abort()
      await starting?.catch(() => undefined)
      order.push('stop-server')
      state = { ...state, running: false, stage: 'stopped' }
      return state
    })
  }
  const ready = vi.fn(async (): Promise<void> => undefined)
  let notify: (state: MinecraftRuntimeState) => void = () => undefined
  const client = {
    prepare: vi.fn(async (_signal?: AbortSignal) => { order.push('prepare-client'); return clientState }),
    syncModpack: vi.fn(async () => { order.push('sync-client'); return clientState }),
    launch: vi.fn(async () => { order.push('start-client'); const value = { ...clientState, stage: 'running' as const, running: true }; notify(value); return value }),
    stop: vi.fn(async () => { order.push('stop-client'); return clientState })
  }
  const createClient = vi.fn(async (_project, onState) => { notify = onState; return client })
  const service = new LocalTestService({ project: () => ({ ...project, kind }), server: server as unknown as LocalServerManager, createClient, onState: () => undefined })
  return { service, client, server, ready, order, createClient, notify: (value: MinecraftRuntimeState) => notify(value), replaceServer: () => { state = { ...state, sessionId: 'someone-else' } } }
}

describe('manual local testing', () => {
  it('prepares both sides, synchronizes current content, and launches the visible client only after server readiness', async () => {
    const f = fixture()
    let release!: () => void
    f.ready.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const pending = f.service.start(options)
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalled())
    expect(f.client.launch).not.toHaveBeenCalled()
    await expect(f.service.start(options)).rejects.toThrow('请先停止')
    release()
    await pending
    expect(f.order).toEqual(['prepare-server', 'prepare-client', 'sync-client', 'start-server', 'server-ready', 'start-client'])
    expect(f.server.start).toHaveBeenCalledWith(expect.objectContaining({ localPlayerTest: true, onlineMode: false }), expect.any(Function))
    expect(f.client.launch).toHaveBeenCalledWith(expect.objectContaining({ server: { ip: '127.0.0.1', port: 25566 } }), expect.any(AbortSignal))
    expect(f.service.getState()).toMatchObject({ active: true, stage: 'running' })
    await f.service.stop()
    expect(f.order.slice(-2)).toEqual(['stop-client', 'stop-server'])
  })

  it('does not synchronize modpack content into the plugin client', async () => {
    const f = fixture('server-plugin')
    await f.service.start(options)
    expect(f.client.syncModpack).not.toHaveBeenCalled()
    await f.service.stop()
  })

  it('cancels preparation without opening either game process', async () => {
    const f = fixture()
    f.client.prepare.mockImplementation(signal => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    const pending = f.service.start(options)
    await vi.waitFor(() => expect(f.client.prepare).toHaveBeenCalled())
    await f.service.stop()
    await pending
    expect(f.order).not.toContain('start-server')
    expect(f.client.launch).not.toHaveBeenCalled()
    expect(f.service.getState()).toMatchObject({ active: false, stage: 'stopped' })
  })

  it('cleans up when cancelled while the client factory is still resolving', async () => {
    const f = fixture()
    let release!: () => void
    f.createClient.mockImplementation(() => new Promise(resolve => { release = () => resolve(f.client) }))
    const pending = f.service.start(options)
    const stop = f.service.stop()
    release()
    await Promise.all([pending, stop])
    expect(f.server.start).not.toHaveBeenCalled()
    expect(f.client.stop).toHaveBeenCalled()
  })

  it('does not launch a client when the server fails to become ready', async () => {
    const f = fixture()
    f.ready.mockRejectedValue(new Error('port busy'))
    await expect(f.service.start(options)).rejects.toThrow('port busy')
    expect(f.client.launch).not.toHaveBeenCalled()
    expect(f.service.getState()).toMatchObject({ active: false, stage: 'error' })
  })

  it('stops its server after a client launch failure and allows retry', async () => {
    const f = fixture()
    f.client.launch.mockRejectedValueOnce(new Error('bad Java'))
    await expect(f.service.start(options)).rejects.toThrow('bad Java')
    expect(f.server.stop).toHaveBeenCalled()
    await f.service.start(options)
    expect(f.service.getState().stage).toBe('running')
    await f.service.stop()
  })

  it('shows client exit while retaining a stoppable server, and never stops a replacement session', async () => {
    const f = fixture()
    await f.service.start(options)
    f.notify({ ...clientState, stage: 'stopped' })
    expect(f.service.getState()).toMatchObject({ active: true, stage: 'stopped' })
    f.replaceServer()
    await f.service.stop()
    expect(f.client.stop).toHaveBeenCalled()
    expect(f.server.stop).not.toHaveBeenCalled()
  })

  it('rejects invalid inputs before preparation', async () => {
    const f = fixture()
    await expect(f.service.start({ ...options, username: 'x' })).rejects.toThrow('玩家名')
    expect(f.createClient).not.toHaveBeenCalled()
  })

  it.each(['1.20', '1.20.1', '1.21.8'])('uses Quick Play on %s', version => {
    expect(multiplayerLaunchOptions(version, { ip: '127.0.0.1', port: 25565 })).toEqual({ quickPlayMultiplayer: '127.0.0.1:25565' })
  })
  it('keeps legacy direct connect for older clients', () => {
    expect(multiplayerLaunchOptions('1.19.4', { ip: '127.0.0.1', port: 25565 })).toEqual({ server: { ip: '127.0.0.1', port: 25565 } })
  })
})
