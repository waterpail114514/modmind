import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PlayerTestService, setTestOperator } from './playerTestService'
import type { LocalServerManager } from './localServerService'
import type { ProjectInfo } from '../shared/types'

vi.mock('./minecraftRuntime', () => ({ MinecraftRuntimeManager: class {} }))
vi.mock('./testSpecifics', () => ({ specificsFor: () => ({ inventory: false, key: false }), installTestSpecifics: vi.fn() }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
it('confirms op and restores ordinary permissions using the actual ops file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'player-permissions-')); roots.push(root)
  const commands: string[] = []
  const server = { sendCommand: async (command: string) => {
    commands.push(command)
    await fs.writeFile(path.join(root, 'ops.json'), JSON.stringify(command.startsWith('op ') ? [{ name: 'ModMind_test' }] : []))
  } } as unknown as LocalServerManager
  await setTestOperator(server, root, 'ModMind_test', true)
  await setTestOperator(server, root, 'ModMind_test', false)
  expect(commands).toEqual(['op ModMind_test', 'deop ModMind_test'])
  expect(JSON.parse(await fs.readFile(path.join(root, 'ops.json'), 'utf8'))).toEqual([])
})
it('stops only after startup cancellation has drained and restores permissions before stopping its server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'player-lifecycle-')); roots.push(root)
  const order: string[] = []
  const project = { path: root, kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.20.1' } as ProjectInfo
  const server = { getState: () => ({ sessionId: 'server-a' }), isRunning: () => true,
    sendCommand: async () => { order.push('deop'); await fs.writeFile(path.join(root, 'ops.json'), '[]') },
    stop: async () => { order.push('server-stop') } } as unknown as LocalServerManager
  const service = new PlayerTestService({ server: () => server, currentProject: () => project, headless: () => { throw new Error('unused') }, javaPreferences: async () => ({ game: '', build: '', tools: '' }) })
  // Exercise the actual lifecycle queue with an in-flight preparation phase.
  const internals = service as unknown as { controller: AbortController; lane: { run: (f: () => Promise<void>) => Promise<void> }; session: unknown; client: { stop: () => Promise<void>; logs: () => { lines: string[] } } }
  internals.controller = new AbortController()
  internals.session = { id: 'player-a', project, username: 'ModMind_test', serverOwned: true, serverId: 'server-a', serverRoot: root, operatorChanged: true, operatorBefore: false }
  internals.client = { stop: async () => { order.push('client-stop') }, logs: () => ({ lines: [] }) }
  const preparation = internals.lane.run(async () => {
    await new Promise<void>(resolve => internals.controller.signal.addEventListener('abort', () => { order.push('cancelled'); resolve() }, { once: true }))
  })
  await Promise.resolve()
  await Promise.all([service.stop(), service.stop(), preparation])
  expect(order).toEqual(['cancelled', 'client-stop', 'deop', 'server-stop'])
  await expect(service.execute(project, 'action', { sessionId: 'player-a', operation: 'operator', enabled: true })).rejects.toThrow('过期')
})
it('rejects unsupported topology and hidden rendering before creating a client', async () => {
  const project = { path: 'fixture', kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.20.1' } as ProjectInfo
  const server = vi.fn()
  const service = new PlayerTestService({ server, currentProject: () => project, headless: vi.fn(), javaPreferences: async () => ({ game: '', build: '', tools: '' }) })
  await expect(service.execute(project, 'session', { operation: 'start', mode: 'rendered', hidden: true })).rejects.toThrow('后台真实渲染')
  expect(server).not.toHaveBeenCalled()
})
