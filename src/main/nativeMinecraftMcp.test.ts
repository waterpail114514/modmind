import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import helper from './nativeMinecraftMcpHelper.json'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeMinecraftMcpClient, nativeMcpFor, prepareLocalMcpJar, restrictMcpServerAddress } from './nativeMinecraftMcp'
import { createStoredZip } from './bedrockAddon'
import { archiveRead } from './ftbResourceArchive'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
vi.mock('./downloadService', () => ({ verifiedDownload: { download: vi.fn() } }))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-mcp-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
async function endpoint() {
  const seen: Array<Record<string, unknown>> = []
  let pid = 4321; let response: unknown = { result: 'ok' }; let screenshot: unknown = {}
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/status') res.end(JSON.stringify({ ok: true, type: 'minecraft-mod', pid, port }))
    else if (req.url === '/api/screenshot') res.end(JSON.stringify(screenshot))
    else {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      seen.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.end(JSON.stringify(response))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  return { client: new NativeMinecraftMcpClient(port, 4321, () => true), seen, pid: (value: number) => { pid = value }, response: (value: unknown) => { response = value }, screenshot: (value: unknown) => { screenshot = value } }
}
it('pins exact releases and does not substitute a nearby game version or loader', () => {
  expect(nativeMcpFor('1.20.1', 'fabric')?.sha256).toBe('a447f4b6424424879c2d4050694f8cb0d71cc0a60d49a3c46b087e710c01e418')
  expect(nativeMcpFor('1.20.1', 'quilt')).toBeUndefined()
  expect(nativeMcpFor('1.20.5', 'fabric')).toBeUndefined()
})
it('keeps bundled Java adapters reproducible from the checked-in source', async () => {
  for (const entry of helper.classes) {
    expect(createHash('sha256').update((await fs.readFile(entry.source, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')).toBe(entry.sourceSha256)
    const bytes = Buffer.from(entry.data, 'base64')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.classSha256)
    expect(bytes.readUInt32BE(0)).toBe(0xcafebabe)
    expect(bytes.readUInt16BE(6)).toBe(52)
  }
})
it('checks the owned process before every action and does not retry a failed mutation', async () => {
  const remote = await endpoint()
  await remote.client.command('execute_command', { command: '/fill 0 60 0 2 60 2 stone', cmd: 'untrusted' })
  expect(remote.seen).toEqual([{ command: '/fill 0 60 0 2 60 2 stone', cmd: 'execute_command' }])
  remote.response({ error: 'not in control mode' })
  await expect(remote.client.command('click', { x: 12, y: 34 })).rejects.toThrow('not in control mode')
  expect(remote.seen).toHaveLength(2)
  remote.pid(9999)
  await expect(remote.client.command('press_key')).rejects.toThrow('身份不匹配')
  expect(remote.seen).toHaveLength(2)
})
it('returns and saves the original PNG and rejects blank frames', async () => {
  const remote = await endpoint(); const root = await directory()
  const png = await sharp(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()
  remote.screenshot({ original: `data:image/png;base64,${png.toString('base64')}`, grid: 'wrong-grid' })
  const capture = await remote.client.capture(root)
  expect(await fs.readFile(capture.path)).toEqual(png)
  expect(capture.width).toBe(2)
  const blank = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer()
  remote.screenshot({ original: `data:image/png;base64,${blank.toString('base64')}` })
  await expect(remote.client.capture(root)).rejects.toThrow('空白')
  expect(await fs.readdir(root)).toHaveLength(1)
})
it('honors cancellation without dispatching commands', async () => {
  const remote = await endpoint(); const controller = new AbortController(); controller.abort()
  await expect(remote.client.command('click', {}, controller.signal)).rejects.toThrow()
  expect(remote.seen).toHaveLength(0)
})

function classWithAddress(address: string) {
  const header = Buffer.from('cafebabe000000340002', 'hex')
  const string = Buffer.from(address); const constant = Buffer.alloc(3)
  constant[0] = 1; constant.writeUInt16BE(string.length, 1)
  return Buffer.concat([header, constant, string, Buffer.from([0, 1, 2, 3])])
}
it('rewrites only the reviewed class constant and preserves other jar contents and licenses', async () => {
  const root = await directory(); const original = path.join(root, 'original.jar')
  const serverPath = 'xyz/langyo/minecraft/mcp/common/McpHttpServer.class'
  await fs.writeFile(original, createStoredZip([{ name: serverPath, data: classWithAddress('0.0.0.0') }, { name: 'LICENSE-MIT', data: Buffer.from('upstream license') }]))
  const patched = path.join(root, 'patched.jar'); await fs.writeFile(patched, await prepareLocalMcpJar(original))
  const bytes = await archiveRead(patched, serverPath)
  expect(bytes.includes(Buffer.from('127.0.0.1'))).toBe(true)
  expect(bytes.subarray(-4)).toEqual(Buffer.from([0, 1, 2, 3]))
  expect((await archiveRead(patched, 'LICENSE-MIT')).toString()).toBe('upstream license')
  expect((await archiveRead(patched, 'META-INF/modmind-integration.txt')).toString()).toContain('Modified')
  expect(() => restrictMcpServerAddress(classWithAddress('unknown'))).toThrow('不一致')
})
