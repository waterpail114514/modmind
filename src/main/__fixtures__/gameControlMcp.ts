import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from '../externalAgents'
import { FeaturePluginService } from '../featurePluginService'
import type { FeaturePluginDefinition, FeaturePluginManifest } from '../../shared/featurePlugins'
import type { ProjectInfo } from '../../shared/types'
import { GAME_TEST_SCHEMAS, GAME_TEST_DESCRIPTIONS } from '../../shared/gameControl'
import type { BackgroundMinecraftTestService } from '../../../feature-plugins/testing/src/main/backgroundMinecraftTestService'
import { normalizeWorkbenchFeatures } from '../../shared/workbenchFeatures'

/** Real JSON-RPC stdio -> HTTP bridge -> feature discovery/schema/permission/project -> business service. */
export async function gameControlMcpFixture(project: () => ProjectInfo, service: BackgroundMinecraftTestService, options: { standalone?: boolean; rendered?: boolean; readOnly?: boolean } = {}) {
  const initialProject = { ...project() }
  const root = initialProject.path
  let authorized = true
  const plugins = new FeaturePluginService(path.join(root, 'fixture-plugins', randomUUID()), {
    requireFrom: path.resolve('package.json'), capabilities: {}, options: () => ({ service, project }), busy: () => false, changed: () => {},
    projectRoot: () => project().path, project, authorize: async () => authorized
  })
  await plugins.initialize()
  const categories = ['session', 'observe', 'action', 'capture', 'scenario'] as const
  const code = `exports.activate = ({service,project}) => ({actions:Object.fromEntries(${JSON.stringify(categories)}.map(category=>['test_'+category,(input,context)=>service.execute(project(),category,input,context.signal)])),dispose:()=>service.stop()});`
  const files = new Map([['main.cjs', Buffer.from(code)], ['renderer.js', Buffer.from('/* test routing fixture */')], ['renderer.css', Buffer.alloc(0)]])
  const manifest: FeaturePluginManifest = { format: 'modmind-feature', apiVersion: 2, hostVersion: '1.5.0-plugintest', id: 'testing', name: 'Game control test routing', version: '1.0.0', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css',
    actions: categories.map(category => ({ id: 'test_' + category, handler: 'test_' + category, permission: 'process', projectRequired: true, surfaces: ['workbench'], inputSchema: GAME_TEST_SCHEMAS[category] })),
    tools: categories.map(category => ({ name: 'modmind_test_' + category, action: 'test_' + category, description: GAME_TEST_DESCRIPTIONS[category] })),
    files: Object.fromEntries([...files].map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')])) }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest))); await plugins.install({ manifest, files })
  const noop = async () => ({})
  const handlers: ExternalAgentBridgeHandlers = { projectInfo: { ...project() }, projectFiles: async () => ({ files: [], truncated: false }), setIntent: noop, applyEdits: noop, updateTodo: noop, mappingsSearch: noop, mappingsClass: noop, dependencySearch: noop, dependencyInstall: noop, contentValidate: noop, testMatrix: noop, releasePreflight: noop, build: noop, testMinecraft: noop, blockbenchActions: noop, runtimeState: noop,
    featureTools: async surface => plugins.tools(surface), featureCatalog: async () => plugins.catalog(),
    featureInvoke: (id, action, input, context) => plugins.invoke(id, action, input, context), playerTest: (category, input) => service.execute(initialProject, category, input) }
  const features = normalizeWorkbenchFeatures({ headlessTesting: true, renderedTesting: options.rendered !== false, imageGeneration: true, modeling: true })
  const bridge = new ModMindBridge(project(), handlers, 'test', undefined, options.readOnly === true, undefined, undefined, features)
  const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
  const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(config.command, options.standalone ? [path.resolve('modmind-mcp-open-source/src/mcp-server.mjs')] : config.args,
    { env: { ...process.env, ...config.env, MODMIND_BRIDGE_CONFIG: path.join(path.dirname(mcpConfigPath), 'bridge.json') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let sequence = 0, buffer = '', diagnostic = ''
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  child.stdout.on('data', (bytes: Buffer) => {
    buffer += bytes.toString('utf8')
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue
      const value = JSON.parse(line), entry = pending.get(value.id)
      if (entry) { clearTimeout(entry.timer); pending.delete(value.id); entry.resolve(value) }
    }
  })
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-4000) })
  child.once('exit', code => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited ${code}: ${diagnostic}`)) } pending.clear() })
  const rpc = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timeout')) }, 30000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { plugins, bridge, child: child as ChildProcessWithoutNullStreams, manifest: manifest as FeaturePluginDefinition,
    list: () => rpc('tools/list'), call: (category: string, input: Record<string, unknown>) => rpc('tools/call', { name: 'modmind_test_' + category, arguments: input }),
    setAuthorized: (value: boolean) => { authorized = value },
    close: async () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP fixture closed')) } pending.clear(); child.stdin.end(); await service.stop(); await bridge.stop(); if (child.exitCode === null) child.kill(); await plugins.shutdown() }
  }
}
