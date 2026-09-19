import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TestClientSession } from './testClientSession'

const mock = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }))
vi.mock('./processTree', () => ({ spawnManaged: mock.spawn, stopProcessTree: mock.stop }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); vi.clearAllMocks() })
async function clientFixture(modern: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'client-control-')); roots.push(root)
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, killed: false })
  const sent: string[] = []; let screen = 'TitleScreen'; let replies = true
  child.stdin.on('data', chunk => {
    const command = String(chunk).trim(); sent.push(command)
    if (!replies) return
    if (command.startsWith('launch ')) child.stdout.write('HeadlessMc Minecraft ready\n')
    else if (command === 'help') child.stdout.write(`gui Dumps the currently displayed screen\nclick clicks\nconnect Connects you to a server\nmenu opens menu\nmsg chat\n${modern ? 'key keys\n' : ''}`)
    else if (command === 'gui') child.stdout.write(`Screen: ${screen}\nButtons:\n0 Play 1 2 3 4 Button\n`)
    else if (command.startsWith('click ')) child.stdout.write('Clicking at x=1, y=2, button=0\n')
    else if (command.startsWith('connect ')) child.stdout.write('Connecting to server 127.0.0.1\n')
  })
  mock.spawn.mockImplementation(() => { setTimeout(() => child.emit('spawn'), 0); return child })
  mock.stop.mockImplementation(async () => { child.exitCode = 0; child.killed = true })
  const client = new TestClientSession()
  await client.start({ javaPath: 'java', launcherPath: 'launcher.jar', profile: 'fabric-1.20.1', minecraftRoot: root, gameDirectory: root, username: 'ModMind_test', offline: true, mode: 'headless', inventorySupported: modern, keysSupported: modern })
  return { client, sent, child, change: () => { screen = 'ChangedScreen' }, silence: () => { replies = false } }
}
it('does not advertise inventory or screenshots for the old headless client', async () => {
  const { client } = await clientFixture(false)
  try {
    expect(client.capabilities()).toMatchObject({ gui: true, key: false, inventory: false, tooltip: false })
    await expect(client.action({ operation: 'inventory' })).rejects.toThrow('不支持')
    await expect(client.observe(undefined, 1)).rejects.toThrow('tooltip')
    await expect(client.capture()).rejects.toThrow('真实画面')
  } finally { await client.stop() }
})
it('rejects stale GUI clicks and accepts a freshly observed matching screen', async () => {
  const { client, sent, change } = await clientFixture(true)
  try {
    const first = await client.observe()
    expect((await client.action({ operation: 'click', slot: 0, revision: first.revision })).acknowledged).toBe(true)
    const second = await client.observe(); change()
    await expect(client.action({ operation: 'click', slot: 0, revision: second.revision })).rejects.toThrow('界面已改变')
    expect(sent.filter(command => command.startsWith('click '))).toHaveLength(1)
  } finally { await client.stop() }
})
it('cancels a pending observation and keeps connect acknowledgement distinct from joining', async () => {
  const { client, silence } = await clientFixture(true)
  try {
    expect(await client.connect(25565)).toMatchObject({ acknowledged: true })
    silence()
    const controller = new AbortController(); setTimeout(() => controller.abort(), 50)
    await expect(client.observe(controller.signal)).rejects.toThrow()
  } finally { await client.stop() }
})
it('reports a broken input pipe instead of throwing an unhandled process event', async () => {
  const { client, child } = await clientFixture(false)
  try {
    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow()
    await expect(client.observe()).rejects.toThrow('输入通道已关闭')
  } finally { await client.stop() }
})
