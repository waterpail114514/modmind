import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { BackgroundMinecraftTestService } from '../../feature-plugins/testing/src/main/backgroundMinecraftTestService'
import { PlayerTestService } from '../../feature-plugins/testing/src/main/playerTestService'
import type { MinecraftRuntimeManager } from '../../feature-plugins/testing/src/main/minecraftRuntime'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
const services: BackgroundMinecraftTestService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture(version = '1.14.2') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-background-service-')); roots.push(root)
  let project = { name: 'Owned', path: root, loader: 'quilt', minecraftVersion: version, kind: 'mod' } as ProjectInfo
  const id = randomUUID(), image = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#335577' } }).png().toBuffer()
  let ready!: () => void; const waiting = new Promise<void>(resolve => { ready = resolve }); let running = false, frameId = 1
  const state = { protocol: 1, pid: 1, family: 'glfw', ownership: 'ai', active: true, ready: true, coordinateRevision: id + ':1', width: 16, height: 9, logicalWidth: 16, logicalHeight: 9, frameId: 1, actionSequence: 0, physicalCallbacksFiltered: true, keysDown: [], buttonsDown: [], error: null }
  const transport = { sessionId: id, assertProject: vi.fn(), waitUntilReady: vi.fn(async (signal: AbortSignal) => { await Promise.race([waiting, new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))]); return state }),
    status: vi.fn(async () => state), sync: vi.fn(async () => state), input: vi.fn(async () => ({ dispatched: true, actionSequence: ++state.actionSequence })),
    capture: vi.fn(async () => ({ ...state, frameId: ++frameId, capturedAt: Date.now(), image })), release: vi.fn(async () => {}), settle: vi.fn(async () => ({ settled: true, frameId: ++frameId })), ownership: vi.fn(async owner => ({ ...state, ownership: owner })) }
  const runtime = { getState: () => ({ running }), launch: vi.fn(async () => { running = true; return { running } }), stop: vi.fn(async () => { running = false }), getBackgroundGameControl: () => transport } as unknown as MinecraftRuntimeManager
  const build = vi.fn(async () => ({ name: 'test.jar', path: path.join(root, '.modmind/minecraft/mods/test.jar'), size: 2, modifiedAt: '', projectArtifact: true }))
  const service = new BackgroundMinecraftTestService({ currentProject: () => project, build, createRuntime: () => runtime }); services.push(service)
  return { project, service, transport, runtime, build, ready, setProject: (value: ProjectInfo) => { project = value } }
}

it('does not use control-Mod catalogs to gate existing Java versions/loaders', async () => {
  const f = await fixture()
  expect(await f.service.execute(f.project, 'session', { operation: 'capabilities' })).toMatchObject({ supported: true, backend: 'background-agent', requiresControlMod: false })
  const start = await f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered', withoutProjectMod: true }) as { sessionId: string; ready: boolean }
  expect(start.ready).toBe(false)
  await vi.waitFor(() => expect(f.runtime.launch).toHaveBeenCalled())
  expect(f.build).not.toHaveBeenCalled(); f.ready()
  const state = await f.service.execute(f.project, 'session', { operation: 'state', sessionId: start.sessionId, waitSeconds: 1 })
  expect(state).toMatchObject({ ready: true, ownership: 'ai' })
  const capture = await f.service.execute(f.project, 'capture', { sessionId: start.sessionId }) as { captures: Array<{ dataUrl: string }> }
  expect(capture.captures[0].dataUrl).toMatch(/^data:image\/png;base64,/)
  await expect(f.service.execute(f.project, 'action', { sessionId: 'wrong', operation: 'key', key: 'W' })).rejects.toThrow('过期')
})

it('cancels preparation, deduplicates concurrent starts, and prevents stale project actions', async () => {
  const f = await fixture(), input = { operation: 'start', mode: 'rendered', withoutProjectMod: true }, owner = new AbortController()
  const start = await f.service.execute(f.project, 'session', input, owner.signal) as { sessionId: string }
  expect(await f.service.execute(f.project, 'session', input, owner.signal)).toMatchObject({ sessionId: start.sessionId })
  await expect(f.service.execute(f.project, 'session', { ...input, width: 900 }, owner.signal)).rejects.toThrow('不同输入')
  await f.service.execute(f.project, 'session', { operation: 'stop', sessionId: start.sessionId }); await f.service.stop()
  expect(f.runtime.stop).toHaveBeenCalledOnce()
  f.setProject({ ...f.project, path: f.project.path + '-different' })
  await expect(f.service.execute(f.project, 'capture', { sessionId: start.sessionId })).rejects.toThrow('当前项目')
})

it('routes rendered tests to the bundled backend while keeping explicit legacy/headless routes', async () => {
  const f = await fixture(); const legacy = { execute: vi.fn(async () => 'legacy'), isBusy: () => false }
  const router = new PlayerTestService({ currentProject: () => f.project, background: f.service, native: legacy as never, server: vi.fn(), headless: vi.fn(), javaPreferences: async () => ({ game: '', build: '', tools: '' }) })
  expect(await router.execute(f.project, 'session', { operation: 'capabilities' })).toMatchObject({ backend: 'background-agent' })
  expect(await router.execute(f.project, 'session', { operation: 'start', backend: 'legacy', mode: 'rendered' })).toBe('legacy')
  const started = await router.execute(f.project, 'session', { operation: 'start', mode: 'rendered', withoutProjectMod: true })
  expect(started).toHaveProperty('sessionId')
  await expect(router.execute(f.project, 'session', { operation: 'start', backend: 'legacy', mode: 'rendered' })).rejects.toThrow('更换后端')
  await f.service.stop()
})

it('stops the owned instance on project switch and leaves user files untouched', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.project.path, 'options.txt'), 'USER FILE')
  const start = await f.service.execute(f.project, 'session', { operation: 'start', mode: 'rendered', withoutProjectMod: true }) as { sessionId: string }
  f.ready(); await f.service.execute(f.project, 'session', { operation: 'state', sessionId: start.sessionId, waitSeconds: 1 })
  await f.service.projectChanged(f.project.path + '-new')
  expect(f.runtime.stop).toHaveBeenCalledOnce()
  expect(await fs.readFile(path.join(f.project.path, 'options.txt'), 'utf8')).toBe('USER FILE')
})
