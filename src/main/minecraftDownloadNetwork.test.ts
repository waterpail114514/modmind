import { createServer } from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { request } from 'undici'
import { installJavaRuntimeTask, type JavaRuntimeManifest } from '@xmcl/installer'
import { minecraftDownloadDispatcher } from './minecraftDownloadNetwork'
import { setNetworkProxy } from './networkRequest'
import { runtimeDownloadError } from './minecraftRuntime'

const system = vi.hoisted(() => ({ resolveProxy: vi.fn() }))
vi.mock('electron', () => ({ session: { defaultSession: system }, app: { getPath: () => os.tmpdir() } }))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { setNetworkProxy(''); vi.clearAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-java-download-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  let broken = false
  const bytes = Buffer.from('verified runtime DLL')
  const origin = createServer((_req, res) => { res.end(broken ? Buffer.alloc(0) : bytes) })
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { origin.closeAllConnections(); origin.close(() => resolve()) }))
  const proxy = createServer()
  const tunnels: string[] = []
  const sockets = new Set<net.Socket>()
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!)
    const socket = client as net.Socket
    const target = net.connect((origin.address() as net.AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target); target.pipe(socket)
    })
    sockets.add(socket); sockets.add(target)
    socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy())
    socket.on('close', () => { sockets.delete(socket); target.destroy() }); target.on('close', () => sockets.delete(target))
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); proxy.close(() => resolve()) }))
  const proxyAddress = `127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
  system.resolveProxy.mockResolvedValue(`PROXY ${proxyAddress}`)
  const dispatcher = minecraftDownloadDispatcher()
  cleanup.push(() => dispatcher.destroy())
  const manifest = { files: { 'bin/runtime.dll': { type: 'file', executable: false, downloads: { raw: { url: 'http://runtime.invalid/runtime.dll', size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') } } } } } as unknown as JavaRuntimeManifest
  return { root, dispatcher, manifest, tunnels, proxyAddress, bytes, breakDownload: () => { broken = true }, repair: () => { broken = false } }
}

it('uses the system proxy for real XMCL Runtime downloads and replaces a zero-byte cached DLL', async () => {
  const f = await fixture()
  await fs.mkdir(path.join(f.root, 'bin')); await fs.writeFile(path.join(f.root, 'bin/runtime.dll'), '')
  await installJavaRuntimeTask({ destination: f.root, manifest: f.manifest, dispatcher: f.dispatcher }).startAndWait()
  expect(await fs.readFile(path.join(f.root, 'bin/runtime.dll'))).toEqual(f.bytes)
  expect(f.tunnels).toContain('runtime.invalid:80')
  expect(system.resolveProxy).toHaveBeenCalledWith('http://runtime.invalid/runtime.dll')
})
it('gives the application proxy precedence and resolves system routes again for a different destination', async () => {
  const f = await fixture()
  setNetworkProxy(`http://${f.proxyAddress}`)
  const configured = await request('http://configured.invalid/file', { dispatcher: f.dispatcher }); await configured.body.text()
  expect(system.resolveProxy).not.toHaveBeenCalled()
  setNetworkProxy('')
  for (const host of ['runtime.invalid', 'metadata.invalid']) {
    const response = await request(`http://${host}/file`, { dispatcher: f.dispatcher }); await response.body.text()
  }
  expect(system.resolveProxy).toHaveBeenCalledWith('http://metadata.invalid/file')
})
it('preserves file and checksum error details and succeeds after a failed download is retried', async () => {
  const f = await fixture(); f.breakDownload()
  let failure: unknown
  try { await installJavaRuntimeTask({ destination: f.root, manifest: f.manifest, dispatcher: f.dispatcher }).startAndWait() }
  catch (error) { failure = error }
  expect(failure).toBeDefined()
  expect(runtimeDownloadError(failure)).toContain('runtime.dll')
  f.repair()
  await installJavaRuntimeTask({ destination: f.root, manifest: f.manifest, dispatcher: f.dispatcher }).startAndWait()
  expect(await fs.readFile(path.join(f.root, 'bin/runtime.dll'))).toEqual(f.bytes)
})
