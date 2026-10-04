import { it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { FeaturePluginService, prepareFeaturePlugin } from './featurePluginService'
import { ModMindBridge, runExternalAgent, type ExternalAgentBridgeHandlers } from './externalAgents'
import { LiveConfiguration } from './liveConfiguration'
import { downloadActivities } from './downloadActivityService'
import { featureHostRuntime } from './featureHostRuntime'
import type { ImageStudioBackend } from '../shared/imageStudio'
import type { FeaturePluginInvocationContext, FeaturePluginSurface } from '../shared/featurePlugins'
import type { ProjectInfo } from '../shared/types'

it('calls the installed plugin through real workbench MCP, preserving discovery, read-only, validation and permission gates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-feature-mcp-'))
  const project = { name: 'Feature MCP', namespace: 'feature_mcp', path: root, loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' } as ProjectInfo
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#33aa99' } }).png().toBuffer()
  const secondPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#9933aa' } }).png().toBuffer()
  const requests: Array<{ url?: string; type?: string; body: Buffer }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({ url: request.url, type: request.headers['content-type'], body: Buffer.concat(chunks) })
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const service = new FeaturePluginService(path.join(root, 'features'), {
    requireFrom: path.resolve('package.json'), capabilities: { downloadActivities, runtime: featureHostRuntime }, busy: () => false, changed: () => undefined, projectRoot: () => project.path,
    options: () => ({ host: { event: () => ({}), requireProject: () => project }, userDataDir: root, projectRoot: () => root, getSyncedImageApi: async () => ({ customMode: true, imageApi: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-key', model: 'fixture-model' } }) })
  })
  const backend = (): ImageStudioBackend => service.service<ImageStudioBackend>('image-studio')
  let allowed = true
  const handlers = {
    projectInfo: project, imageStudioAvailable: async () => service.enabled('image-studio'),
    featureCatalog: async () => service.catalog(),
    featureTools: async (surface: FeaturePluginSurface) => service.tools(surface),
    featureInvoke: (id: string, action: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext) => service.invoke(id, action, input, context),
    imageStudioInfo: (models: boolean) => backend().describe(models),
    imageGenerate: (input: Record<string, unknown>) => backend().generate(input, 'agent'),
    imageProcess: (operation: 'perfect-pixel' | 'remove-background', data: string, options: object) => backend().process(operation, data, options),
    reviewAction: async () => ({ approved: allowed, complete: true, risk: 'low', dangerousOperations: [], feedback: 'fixture permission decision' })
  } as unknown as ExternalAgentBridgeHandlers
  const bridges: ModMindBridge[] = [], children: ChildProcessWithoutNullStreams[] = []
  const connect = async (readOnly = false) => {
    const bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly, readOnly ? 'read-only' : 'write')
    bridges.push(bridge)
    const { mcpConfigPath, contextPath } = await bridge.start();
    if (!service.enabled('image-studio')) { expect(await fs.readFile(contextPath, 'utf8')).not.toContain('modmind_image_generate'); expect(await fs.readFile(contextPath, 'utf8')).toContain('插件未启用') } await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); children.push(child)
    let sequence = 0, buffer = ''
    const pending = new Map<number, (value: any) => void>()
    child.stdout.on('data', chunk => { buffer += chunk; let newline: number; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id) } })
    return (method: string, params?: object): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => reject(new Error('MCP timeout')), 10000)
      pending.set(id, value => { clearTimeout(timer); resolve(value) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  try {
    await service.initialize()
    const rpc = await connect()
    expect((await rpc('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'modmind_image_generate')).toBe(false)
    await service.install(await prepareFeaturePlugin(path.resolve('feature-plugin-dist/image-studio.mmfeature')))
    expect((await rpc('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'modmind_image_generate')).toBe(true)
    expect(service.tools().find(tool => tool.name === 'modmind_image_generate')?.inputSchema.properties).toHaveProperty('referenceImages')
    const call = (name: string, args: object) => rpc('tools/call', { name, arguments: args })
    const references = [png, secondPng].map(image => `data:image/png;base64,${image.toString('base64')}`)
    const generated = await call('modmind_image_generate', { prompt: 'MCP plugin fixture', model: 'fixture-model', style: 'free', referenceImages: references })
    expect(generated.result.isError, JSON.stringify(generated.result)).toBeUndefined()
    expect(generated.result.content.some((content: { type: string }) => content.type === 'image')).toBe(true)
    expect(await backend().history()).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/images/edits')
    const form = await new Response(new Uint8Array(requests[0].body), { headers: { 'Content-Type': requests[0].type! } }).formData()
    expect(await Promise.all((form.getAll('image[]') as File[]).map(async file => Buffer.from(await file.arrayBuffer())))).toEqual([png, secondPng])
    const processed = await call('modmind_image_perfect_pixel', { dataUrl: 'data:image/png;base64,' + png.toString('base64'), perfectPixel: { gridSize: [8, 8] } })
    expect(processed.result.isError).toBeUndefined()
    const image = processed.result.content.find((content: { type: string }) => content.type === 'image')
    const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
    expect([metadata.width, metadata.height]).toEqual([8, 8])
    expect((await call('modmind_image_generate', { prompt: '' })).result.isError).toBe(true)
    expect((await call('modmind_image_generate', { prompt: 'invalid reference', referenceImages: [references[0], 'invalid'] })).result.isError).toBe(true)
    expect(requests).toHaveLength(1)
    allowed = false
    expect((await call('modmind_image_generate', { prompt: 'denied' })).result.isError).toBe(true)
    expect(await backend().history()).toHaveLength(1)
    const readOnly = await connect(true)
    expect((await readOnly('tools/call', { name: 'modmind_image_generate', arguments: { prompt: 'read-only' } })).result.isError).toBe(true)
    await service.setEnabled('image-studio', false)
    expect((await rpc('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'modmind_image_generate')).toBe(false)
    expect((await call('modmind_image_studio_info', {})).result.isError).toBe(true)
  } finally {
    for (const child of children) child.kill()
    for (const bridge of bridges) await bridge.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)

it('keeps an absent image plugin unavailable through the live model-switch proxy used by workbench runs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-live-run-'))
  const project = { name: 'Feature', namespace: 'feature', path: root, loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' } as ProjectInfo
  const runner = path.join(root, 'runner.mjs'), release = path.join(root, 'done')
  await fs.writeFile(runner, `import fs from 'node:fs'; const timer=setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'checked'}})); console.log(JSON.stringify({type:'turn.completed'})); },20);`)
  const executable = path.join(root, process.platform === 'win32' ? 'runner.cmd' : 'runner.sh')
  await fs.writeFile(executable, process.platform === 'win32' ? '@echo off\r\nnode "%~dp0runner.mjs"\r\n' : `#!/bin/sh\nnode '${runner}'\n`)
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const controller = new AbortController()
  const run = runExternalAgent({
    kind: 'codex', executable, project, runId: 'live-feature', prompt: 'check availability',
    signal: controller.signal, liveConfiguration: new LiveConfiguration(), refreshConfiguration: async () => ({ model: 'fixture' }),
    onStarted: started, onOutput: () => undefined, onProgress: () => undefined,
    bridge: { projectInfo: project, imageStudioAvailable: () => false, imageGenerate: async () => { throw new Error('Must never reach generator') } } as unknown as ExternalAgentBridgeHandlers
  })
  void run.catch(() => undefined)
  try {
    await ready
    const directory = path.join(root, '.modmind/external-agents/runs/live-feature')
    const bridge = JSON.parse(await fs.readFile(path.join(directory, 'bridge.json'), 'utf8'))
    const call = (action: string) => fetch(`http://127.0.0.1:${bridge.port}/tool`, { method: 'POST', headers: { 'x-modmind-token': bridge.token, 'content-type': 'application/json' }, body: JSON.stringify({ action, input: {} }) })
    expect(await (await call('feature_plugin_availability')).json()).toEqual({ imageStudio: false })
    const denied = await call('image_generate')
    expect(denied.status).toBe(400)
    expect(await denied.text()).toContain('FEATURE_PLUGIN_UNAVAILABLE')
    expect(await fs.readFile(path.join(directory, 'agent-context.md'), 'utf8')).not.toContain('modmind_image_generate')
    await fs.writeFile(release, '')
    await run
  } finally { controller.abort(); await run.catch(() => undefined); await fs.rm(root, { recursive: true, force: true }) }
}, 20000)
