import { expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { FeaturePluginService } from './featurePluginService'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import type { FeaturePluginDefinition, FeaturePluginManifest } from '../shared/featurePlugins'
import type { ProjectInfo } from '../shared/types'

it('discovers and invokes a new plugin without feature-specific host handlers, including lifecycle and inspiration boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-generic-mcp-'))
  const definition: FeaturePluginDefinition = {
    format: 'modmind-feature', apiVersion: 2, hostVersion: '1.5.0-plugintest', id: 'example-palette', name: 'Example palette', version: 'test',
    main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css',
    capabilities: [{ id: 'palette', name: 'Palette inspection', description: 'Read and save project palettes' }],
    actions: [
      { id: 'palette_read', handler: 'read', permission: 'read', projectRequired: true, inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
      { id: 'palette_save', handler: 'save', permission: 'write', projectRequired: true, inputSchema: { type: 'object', additionalProperties: false, properties: { color: { $ref: '#/$defs/color' } }, required: ['color'], $defs: { color: { type: 'string', pattern: '^#[0-9a-f]{6}$' } } } }
    ],
    tools: [{ name: 'modmind_example_palette_read', action: 'palette_read', description: 'Read palette' }, { name: 'modmind_example_palette_save', action: 'palette_save', description: 'Save palette' }]
  }
  const manager = new FeaturePluginService(path.join(root, 'plugins'), {
    requireFrom: path.resolve('package.json'), capabilities: {}, options: () => ({}), projectRoot: () => root,
    catalog: [definition], busy: () => false, changed: () => undefined
  })
  const project = { name: 'Generic plugin', namespace: 'generic', path: root, loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' } as ProjectInfo
  const handlers = {
    projectInfo: project, featureCatalog: async () => manager.catalog(), featureTools: async (surface: 'workbench' | 'inspiration') => manager.tools(surface),
    featureInvoke: (id: string, action: string, input: Record<string, unknown>, context: object) => manager.invoke(id, action, input, context),
    reviewAction: async () => ({ approved: true, complete: true, risk: 'low', dangerousOperations: [], feedback: '' })
  } as unknown as ExternalAgentBridgeHandlers
  const bridges: ModMindBridge[] = [], children: ChildProcessWithoutNullStreams[] = []
  async function connect(readOnly = false) {
    const bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly, readOnly ? 'inspiration' : 'workbench'); bridges.push(bridge)
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); children.push(child)
    let sequence = 0, buffer = ''
    const pending = new Map<number, (value: any) => void>()
    child.stdout.on('data', chunk => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const result = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
        pending.get(result.id)?.(result); pending.delete(result.id)
      }
    })
    return (method: string, params?: object): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => reject(new Error('MCP timeout')), 5000)
      pending.set(id, result => { clearTimeout(timer); resolve(result) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  try {
    await manager.initialize()
    const rpc = await connect(), call = (name: string, args = {}) => rpc('tools/call', { name, arguments: args })
    expect((await rpc('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'modmind_example_palette_read')).toBe(false)
    const absent = JSON.parse((await call('modmind_feature_catalog')).result.content[0].text)
    expect(absent.features.find((feature: { id: string }) => feature.id === definition.id)).toMatchObject({ state: 'not-installed', available: false })
    const files = new Map([['main.cjs', Buffer.from('exports.activate=()=>{let color="#ffffff";return {actions:{read:()=>({color}),save:input=>({color:color=input.color})}}}')], ['renderer.js', Buffer.from('')], ['renderer.css', Buffer.from('')]])
    const manifest: FeaturePluginManifest = { ...definition, files: Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
    await manager.install({ manifest, files })
    expect((await rpc('tools/list')).result.tools.filter((tool: { name: string }) => tool.name.startsWith('modmind_example_'))).toHaveLength(2)
    expect((await call('modmind_example_palette_save', { color: 'invalid' })).result.isError).toBe(true)
    expect((await call('modmind_example_palette_save', { color: '#22aabb' })).result.isError).toBeUndefined()
    expect(JSON.parse((await call('modmind_example_palette_read')).result.content[0].text)).toEqual({ color: '#22aabb' })
    const inspiration = await connect(true)
    expect((await inspiration('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'modmind_example_palette_save')).toBe(false)
    expect((await inspiration('tools/call', { name: 'modmind_example_palette_save', arguments: { color: '#ffffff' } })).result.isError).toBe(true)
    expect(JSON.parse((await inspiration('tools/call', { name: 'modmind_example_palette_read', arguments: {} })).result.content[0].text)).toEqual({ color: '#22aabb' })
    await manager.setEnabled(definition.id, false)
    expect((await call('modmind_example_palette_read')).result.isError).toBe(true)
    await manager.uninstall(definition.id)
    expect(JSON.parse((await call('modmind_feature_catalog')).result.content[0].text).features.find((feature: { id: string }) => feature.id === definition.id).state).toBe('not-installed')
  } finally {
    for (const child of children) child.kill()
    for (const bridge of bridges) await bridge.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20000)
