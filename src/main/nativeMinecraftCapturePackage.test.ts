import { afterEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import { compileFunction } from 'node:vm'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })

async function compiledCapture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-capture-package-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const result = await build({ stdin: { contents: `export { NativeMinecraftMcpClient } from './feature-plugins/testing/src/main/nativeMinecraftMcp'; export { TestClientSession } from './feature-plugins/testing/src/main/testClientSession';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'electron-path', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'capture-test' }))
      builder.onLoad({ filter: /.*/, namespace: 'capture-test' }, () => ({ contents: `export const app = {getPath:()=>${JSON.stringify(root)}}; export const net={fetch:globalThis.fetch};` }))
    } }] })
  // Match FeaturePluginService: the code is verified and compiled in a VM;
  // native dependencies are resolved by the host, without VM import hooks.
  const module = { exports: {} as any }, file = path.join(root, 'main.cjs')
  compileFunction(result.outputFiles[0].text, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file })(module.exports, createRequire(path.resolve('package.json')), module, file, root)
  return { root, ...module.exports }
}
const png = () => sharp(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()

it('captures the original PNG through the compiled native client and still rejects blank frames', async () => {
  const { root, NativeMinecraftMcpClient } = await compiledCapture()
  let bytes = await png(), port = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/api/status' ? { type: 'minecraft-mod', pid: 4321, port } : { original: `data:image/png;base64,${bytes.toString('base64')}` }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const client = new NativeMinecraftMcpClient(port, 4321, () => true)
  const image = await client.capture(path.join(root, 'captures'))
  expect(await fs.readFile(image.path)).toEqual(bytes)
  expect(image).toMatchObject({ width: 2, height: 2 })
  bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer()
  await expect(client.capture(path.join(root, 'captures'))).rejects.toThrow('空白')
})

it('validates an F2 screenshot through the compiled rendered client', async () => {
  const { root, TestClientSession } = await compiledCapture()
  const client = new TestClientSession(), bytes = await png()
  client.mode = 'rendered'; client.directory = root; client.commands.add('key')
  client.action = async () => {
    await fs.mkdir(path.join(root, 'screenshots'), { recursive: true })
    await fs.writeFile(path.join(root, 'screenshots/frame.png'), bytes)
    return { acknowledged: true }
  }
  const image = await client.capture()
  expect(await fs.readFile(image.path)).toEqual(bytes)
  expect(image.dataUrl).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
})
