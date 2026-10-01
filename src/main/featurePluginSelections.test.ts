import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { normalizeInspirationFeatures } from '../shared/inspirationFeatures'
import type { FeaturePluginDefinition, FeaturePluginDiscoveredTool } from '../shared/featurePlugins'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = [], bridges: ModMindBridge[] = [], children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  children.splice(0).forEach(child => child.kill())
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

it.each(['none', 'jar', 'compatibility', 'comparison'])('enforces operation-specific inspiration selections on generic decompile tools (%s)', async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-selections-')); roots.push(root)
  const project = { name: 'Selections', namespace: 'selections', path: root, loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' } as ProjectInfo
  const tool: FeaturePluginDiscoveredTool = { pluginId: 'decompile', name: 'modmind_decompile_query', action: 'query', description: 'Inspect JAR and cached sources', permission: 'read', projectRequired: true, inputSchema: { type: 'object' } }
  const definition: FeaturePluginDefinition = { format: 'modmind-feature', apiVersion: 2, hostVersion: 'test', id: 'decompile', name: 'Decompile', version: 'test', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', tools: [{ name: tool.name, action: tool.action, description: tool.description }] }
  const invoke = vi.fn(async (_id: string, _action: string, input: Record<string, unknown>) => ({ operation: input.operation }))
  const handlers = { projectInfo: project, featureCatalog: async () => [{ id: definition.id, name: definition.name, version: definition.version, installed: true, enabled: true, available: true, state: 'ready', manifest: definition }], featureTools: async () => [tool], featureInvoke: invoke } as unknown as ExternalAgentBridgeHandlers
  const selections = normalizeInspirationFeatures({ jarAnalysis: mode === 'jar', compatibility: mode === 'compatibility', comparison: mode === 'comparison' })
  const bridge = new ModMindBridge(project, handlers, 'test', undefined, true, mode, undefined, undefined, selections); bridges.push(bridge)
  const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
  const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); children.push(child)
  let sequence = 0, buffer = ''
  const pending = new Map<number, (value: any) => void>()
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
      pending.get(value.id)?.(value); pending.delete(value.id)
    }
  })
  const rpc = (method: string, params?: object): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')) }, 5000)
    pending.set(id, value => { clearTimeout(timer); resolve(value) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  expect((await rpc('tools/list')).result.tools.some((entry: { name: string }) => entry.name === tool.name)).toBe(mode !== 'none')
  for (const operation of ['inspect', 'files', 'read', 'references']) {
    invoke.mockClear()
    const result = await rpc('tools/call', { name: tool.name, arguments: { operation, path: 'sample.jar' } })
    const allowed = operation === 'inspect' ? mode !== 'none' : operation === 'references' ? mode === 'compatibility' : mode === 'jar'
    expect(result.result.isError, `${mode}: ${operation}`).toBe(allowed ? undefined : true)
    expect(invoke).toHaveBeenCalledTimes(allowed ? 1 : 0)
  }
  const bridgeConfig = JSON.parse(await fs.readFile(path.join(path.dirname(mcpConfigPath), 'bridge.json'), 'utf8'))
  invoke.mockClear()
  const raw = await fetch(`http://127.0.0.1:${bridgeConfig.port}/tool`, { method: 'POST', headers: { 'x-modmind-token': bridgeConfig.token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'decompile_query', input: { operation: 'read', path: 'sample.jar' } }) })
  expect(raw.status).toBe(mode === 'jar' ? 200 : 400)
  expect(invoke).toHaveBeenCalledTimes(mode === 'jar' ? 1 : 0)
}, 20000)
