import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import { MANAGED_JAVA_MANIFEST, validManagedJavaCache } from './managedJavaIntegrity'
import type { JavaRuntimeManifest } from '@xmcl/installer'

const environment = vi.hoisted(() => ({ root: '', manifest: {} as JavaRuntimeManifest }))
vi.mock('electron', () => ({ app: { getPath: () => environment.root }, session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } }))
vi.mock('./diagnosticLog', () => ({ diagnosticJournal: { record: vi.fn() } }))
vi.mock('@xmcl/installer', async original => ({ ...await original<typeof import('@xmcl/installer')>(), fetchJavaRuntimeManifest: async () => environment.manifest }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  setImmediate(() => { child.stderr.emit('data', Buffer.from('java version "21.0.1"')); child.emit('exit', 0) })
  return child
} }))
let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()) }); server = undefined
  await fs.rm(environment.root, { recursive: true, force: true })
})
async function fixture() {
  environment.root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-java-recovery-'))
  const java = process.platform === 'win32' ? 'java.exe' : 'java'
  const target = 'java-runtime-delta'
  const home = path.join(environment.root, 'minecraft-runtime/java', target)
  await fs.mkdir(path.join(home, 'bin'), { recursive: true })
  await fs.writeFile(path.join(home, 'bin', java), 'old-java')
  await fs.writeFile(path.join(home, 'bin/runtime.dll'), '')
  let failed = false
  server = createServer((req, res) => res.end(failed ? '' : req.url === '/java' ? 'new-java' : 'verified DLL'))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const file = (content: string, route: string) => ({ type: 'file', executable: true, downloads: { raw: { url: `${address}/${route}`, size: Buffer.byteLength(content), sha1: createHash('sha1').update(content).digest('hex') } } })
  environment.manifest = { target, files: { [`bin/${java}`]: file('new-java', 'java'), 'bin/runtime.dll': file('verified DLL', 'dll') }, version: { name: '21.0.1', released: '' } } as JavaRuntimeManifest
  const manager = new MinecraftRuntimeManager({ getProject: () => null, onState: () => {}, onEvent: () => {} })
  const prepare = (signal?: AbortSignal) => (manager as unknown as { ensureManagedJava(major: number, target: string, signal?: AbortSignal): Promise<{ javaPath: string }> }).ensureManagedJava(21, target, signal)
  return { home, java, prepare, fail: () => { failed = true }, repair: () => { failed = false } }
}
it('repairs a zero-byte DLL even when Java itself still probes successfully', async () => {
  const f = await fixture()
  await f.prepare()
  expect(await fs.readFile(path.join(f.home, 'bin/runtime.dll'), 'utf8')).toBe('verified DLL')
  expect(await validManagedJavaCache(f.home)).toBe(true)
  expect(JSON.parse(await fs.readFile(path.join(f.home, MANAGED_JAVA_MANIFEST), 'utf8')).files).toHaveProperty('bin/runtime.dll')
  f.fail()
  await f.prepare()
  expect(await fs.readFile(path.join(f.home, 'bin/runtime.dll'), 'utf8')).toBe('verified DLL')
})
it('cleans failed staging downloads, preserves the original runtime, and recovers on retry', async () => {
  const f = await fixture(); f.fail()
  await expect(f.prepare()).rejects.toThrow('Java Runtime 下载或校验失败')
  expect(await fs.readdir(path.dirname(f.home))).toEqual(['java-runtime-delta'])
  expect(await fs.readFile(path.join(f.home, 'bin', f.java), 'utf8')).toBe('old-java')
  f.repair(); await f.prepare()
  expect(await fs.readFile(path.join(f.home, 'bin', f.java), 'utf8')).toBe('new-java')
  expect(await fs.readdir(path.dirname(f.home))).toEqual(['java-runtime-delta'])
})
