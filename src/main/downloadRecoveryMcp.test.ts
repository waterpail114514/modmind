import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import type { ProjectInfo } from '../shared/types'
import { normalizeWorkbenchFeatures } from '../shared/workbenchFeatures'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => 'test', isPackaged: false } }))
const roots: string[] = []; const bridges: ModMindBridge[] = []; const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => { children.splice(0).forEach(child => child.kill()); await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
function rpc(child: ChildProcessWithoutNullStreams, request: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => { cleanup(); reject(new Error('MCP fixture RPC timeout')) }, 10000)
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', data); child.off('exit', exit) }
    const exit = () => { cleanup(); reject(new Error('MCP process exited')) }
    const data = (chunk: Buffer) => { output += chunk; if (!output.includes('\n')) return; cleanup(); resolve(JSON.parse(output.split('\n')[0])) }
    child.stdout.on('data', data); child.once('exit', exit); child.stdin.write(JSON.stringify(request) + '\n')
  })
}
it.each([false, true])('runs slow test tasks through the actual MCP transport, with polling and cancellation (standalone=%s)', async standalone => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-test-task-mcp-')); roots.push(root)
  const project = { path: root, name: 'Slow test', namespace: 'test', loader: 'fabric', minecraftVersion: '1.20.1', createdAt: '' } as ProjectInfo
  const run = vi.fn(async (_targets: string[], signal?: AbortSignal) => await new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(signal.reason)
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const handlers: ExternalAgentBridgeHandlers = { projectInfo: {}, setIntent: async () => ({}), applyEdits: async () => ({}), updateTodo: async () => ({}), mappingsSearch: async () => ({}), mappingsClass: async () => ({}), dependencySearch: async () => ({}), dependencyInstall: async () => ({}), contentValidate: async () => ({}), testMatrix: run, releasePreflight: async () => ({}), build: async () => ({}), testMinecraft: async () => ({}), blockbenchActions: async () => ({}), runtimeState: async () => ({ stage: 'downloading-gradle', progress: 8, total: 100 }), reviewAction: async () => ({ approved: true }) as never }
  const bridge = new ModMindBridge(project, handlers, 'test', undefined, false, undefined, undefined, normalizeWorkbenchFeatures({ headlessTesting: true })); bridges.push(bridge)
  const config = await bridge.start(); await bridge.writeMcpConfig(config.mcpConfigPath)
  const runtime = JSON.parse(await fs.readFile(config.mcpConfigPath, 'utf8')).mcpServers.modmind
  const child = spawn(runtime.command, standalone ? [path.resolve('modmind-mcp-open-source/src/mcp-server.mjs')] : runtime.args, { env: { ...process.env, ...runtime.env, MODMIND_BRIDGE_CONFIG: path.join(path.dirname(config.mcpConfigPath), 'bridge.json') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); children.push(child)
  const listing = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tool = listing.result.tools.find((entry: any) => entry.name === 'modmind_test_matrix')
  expect(tool.inputSchema.properties.operation.enum).toEqual(['start', 'state', 'cancel'])
  let id = 2
  const call = async (args: object) => { const result = await rpc(child, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'modmind_test_matrix', arguments: args } }); return JSON.parse(result.result.content[0].text) }
  const task = await call({ targets: ['server'] })
  expect(task).toMatchObject({ status: 'running', state: { stage: 'downloading-gradle' } })
  expect(await call({ targets: ['server'] })).toMatchObject({ taskId: task.taskId })
  expect(await call({ operation: 'state', taskId: task.taskId })).toMatchObject({ status: 'running' })
  expect(() => bridge.assertTestResultsCollected()).toThrow('尚未完成')
  expect(await call({ operation: 'cancel', taskId: task.taskId, waitSeconds: 1 })).toMatchObject({ status: 'cancelled', success: false })
  expect(() => bridge.assertTestResultsCollected()).not.toThrow()
  expect(run).toHaveBeenCalledOnce()
})
