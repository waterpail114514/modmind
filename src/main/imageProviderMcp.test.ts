import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { build } from 'esbuild'
import sharp from 'sharp'
import { expect, it, vi } from 'vitest'
import { FeaturePluginService } from './featurePluginService'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import * as networkRequest from './networkRequest'
import * as downloadActivityService from './downloadActivityService'
import type { ProjectInfo } from '../shared/types'

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let pending = ''
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose) }
    const onClose = () => { cleanup(); reject(new Error('MCP process exited')) }
    const onData = (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(pending.slice(0, newline))) } catch (error) { reject(error) }
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('MCP response timeout')) }, 10_000)
    child.stdout.on('data', onData); child.once('close', onClose)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

it('uses independent image leases through packaged feature discovery and actual MCP, with readback and scope checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-image-provider-mcp-'))
  const project: ProjectInfo = { path: root, name: 'Image Project', namespace: 'images', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  let activeProject: ProjectInfo = project
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer()
  const received: Array<{ path: string; auth: string; form: FormData }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push({ path: request.url!, auth: request.headers.authorization!, form: await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'Content-Type': request.headers['content-type']! } }).formData() })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`event: image_edit.partial_image\ndata: {"b64_json":"AA=="}\n\nevent: image_edit.completed\ndata: ${JSON.stringify({ b64_json: png.toString('base64') })}\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const getHostedLease = vi.fn(async () => ({ baseUrl: `${origin}/v1`, apiKey: 'temporary-image-only', model: 'lease-image-model', provider: 'ls' as const, jobId: 'lease-job', reservedCredits: 1 }))
  const getHostedImageProvider = vi.fn(async () => ({ available: true, model: 'lease-image-model', provider: 'ls' }))
  const runtime = { networkRequest, downloadActivityService }
  const plugins = new FeaturePluginService(path.join(root, 'features'), {
    requireFrom: path.resolve('package.json'), capabilities: { runtime, downloadActivities: downloadActivityService.downloadActivities },
    options: () => ({ userDataDir: path.join(root, 'settings'), projectRoot: () => activeProject.path, getHostedLease, getHostedImageProvider, host: { requireProject: () => activeProject, event: () => ({}) } }),
    busy: () => false, changed: () => {}, project: () => activeProject, projectRoot: () => activeProject.path
  })
  const bridges: ModMindBridge[] = [], children: ChildProcessWithoutNullStreams[] = []
  let id = 0
  const connect = async (readOnly = false) => {
    const handlers = { featureCatalog: async () => plugins.catalog(), featureTools: async (surface: 'workbench' | 'inspiration') => plugins.tools(surface, project), featureInvoke: (feature: string, action: string, input: Record<string, unknown>, context: any) => plugins.invoke(feature, action, input, context) } as unknown as ExternalAgentBridgeHandlers
    const bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly, readOnly ? 'image-read' : 'image-write')
    bridges.push(bridge)
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
    return child
  }
  try {
    const directory = path.join(root, 'packaged-image'); await fs.mkdir(directory)
    await build({ entryPoints: ['feature-plugins/image-studio/main.ts'], outfile: path.join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['@modmind/host'], plugins: [{ name: 'test-host', setup(builder) {
      builder.onResolve({ filter: /\/(networkRequest|downloadActivityService)$/ }, args => ({ path: path.basename(args.path), namespace: 'host-runtime' }))
      builder.onLoad({ filter: /.*/, namespace: 'host-runtime' }, args => {
        const key = args.path as keyof typeof runtime
        return { contents: `const value = require('@modmind/host').runtime.${key};\n` + Object.keys(runtime[key]).map(name => `export const ${name} = value.${name};`).join('\n'), loader: 'js' }
      })
    } }] })
    await fs.writeFile(path.join(directory, 'renderer.js'), ''); await fs.writeFile(path.join(directory, 'renderer.css'), '')
    const manifest = JSON.parse(await fs.readFile('feature-plugins/image-studio/manifest.json', 'utf8'))
    const files = Object.fromEntries(await Promise.all(['main.cjs', 'renderer.js', 'renderer.css'].map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')])))
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, hostCapabilities: ['runtime', 'downloadActivities'], files }))
    await plugins.initialize([{ id: 'image-studio', directory }])
    expect(plugins.catalog().find(entry => entry.id === 'image-studio')?.available).toBe(true)
    const child = await connect(), readOnly = await connect(true)
    expect(JSON.stringify(await rpc(child, ++id, 'tools/list'))).toContain('modmind_image_generate')
    const call = (name: string, args: object) => rpc(child, ++id, 'tools/call', { name, arguments: args })
    const info = await call('modmind_image_studio_info', { includeModels: true })
    expect(JSON.stringify(info)).toContain('lease-image-model'); expect(getHostedImageProvider).toHaveBeenCalledOnce(); expect(getHostedLease).not.toHaveBeenCalled()
    const referenceImage = `data:image/png;base64,${png.toString('base64')}`
    const output = await call('modmind_image_generate', { prompt: 'edit original', model: 'stale-model', referenceImage })
    expect(output.result.isError).not.toBe(true)
    const result = JSON.parse(output.result.content[0].text)
    expect(result.success).toBe(true); expect(result.files).toHaveLength(1)
    expect(await fs.readFile(path.join(root, result.files[0]))).toEqual(png)
    expect(received[0]).toMatchObject({ path: '/v1/images/edits', auth: 'Bearer temporary-image-only' })
    expect(received[0].form.get('model')).toBe('lease-image-model'); expect(received[0].form.get('stream')).toBe('true')
    expect(Buffer.from(await (received[0].form.get('image') as File).arrayBuffer())).toEqual(png)
    expect(JSON.parse(await fs.readFile(path.join(root, 'settings/image-studio-history.json'), 'utf8'))[0].model).toBe('lease-image-model')
    const invalid = await call('modmind_image_generate', { prompt: 'invalid', referenceImage: 'invalid' })
    expect(invalid.result.isError).toBe(true)
    const denied = await rpc(readOnly, ++id, 'tools/call', { name: 'modmind_image_generate', arguments: { prompt: 'denied' } })
    expect(denied.result.isError).toBe(true)
    activeProject = { ...project, path: path.join(root, 'other-project') }
    const changed = await call('modmind_image_generate', { prompt: 'stale project' })
    expect(changed.result.isError).toBe(true)
    expect(getHostedLease).toHaveBeenCalledOnce(); expect(received).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('temporary-image-only')
  } finally {
    for (const child of children) if (child.exitCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill(); await closed }
    for (const bridge of bridges) await bridge.stop()
    await plugins.shutdown()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
