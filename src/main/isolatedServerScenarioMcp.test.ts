import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it } from 'vitest'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { IsolatedServerScenarioService } from './isolatedServerScenarioService'
import { ServerFixtureService, fixtureJarHash } from './serverFixtureService'
import { createStoredZip } from './bedrockAddon'
import type { ProjectInfo } from '../shared/types'
import { SERVER_SCENARIO_SCHEMA } from '../shared/serverScenario'

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { clean(); reject(new Error('MCP response timed out')) }, 10000)
    const onClose = (): void => { clean(); reject(new Error('MCP process exited')) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString(); const newline = buffer.indexOf('\n'); if (newline < 0) return
      clean(); try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    const clean = (): void => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose) }
    child.stdout.on('data', onData); child.once('close', onClose)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
it('discovers, starts, polls and reads actual isolated scenario evidence through workbench MCP with read-only and project boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-isolated-mcp-'))
  const fixtures = new ServerFixtureService()
  const project: ProjectInfo = { path: root, name: 'Pack', namespace: 'pack', kind: 'modpack', loader: 'forge', loaderVersion: '47.4.23', minecraftVersion: '1.20.1', createdAt: '' }
  const file = path.join(root, 'target.jar')
  await fs.writeFile(file, createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="target"\nversion="1.0.0"') }]))
  const service = new IsolatedServerScenarioService({ fixtures, java: async () => ({ path: process.execPath, version: '17' }), install: async options => {
    const properties = await fs.readFile(path.join(options.serverPack.root, 'server.properties'), 'utf8')
    const port = properties.match(/server-port=(\d+)/)![1]
    const script = "const net=require('net');const s=net.createServer(c=>c.end()).listen(Number(process.argv[1]),'127.0.0.1',()=>console.log('Done (0.1s)!'));process.stdin.on('data',c=>{if(c.toString().trim()==='stop')s.close(()=>process.exit(0));else console.log(c.toString().trim());});"
    return { loader: 'forge', loaderVersion: '47.4.23', launchCommand: [process.execPath, '-e', script, port] }
  } })
  const bridges: ModMindBridge[] = []
  const children: ChildProcessWithoutNullStreams[] = []
  let id = 0
  const connect = async (readOnly = false) => {
    const handlers = { modpackRunServerScenario: (input: Record<string, unknown>) => input.operation === 'state' ? service.read(project, String(input.taskId), Number(input.waitSeconds ?? 0)) : input.operation === 'cancel' ? service.cancel(project, String(input.taskId)) : service.start(project, input) } as unknown as ExternalAgentBridgeHandlers
    const bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly, readOnly ? 'readonly' : 'write'); bridges.push(bridge)
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
    return { child, call: (args: object) => rpc(child, ++id, 'tools/call', { name: 'modmind_modpack_run_server_scenario', arguments: args }) }
  }
  try {
    const client = await connect()
    const tools = await rpc(client.child, ++id, 'tools/list')
    expect(tools.result.tools.find((tool: any) => tool.name === 'modmind_modpack_run_server_scenario').inputSchema).toEqual(SERVER_SCENARIO_SCHEMA)
    const input = { operation: 'start', acceptEula: true, fixture: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', jars: [{ path: file, sha256: (await fixtureJarHash(file)).sha256 }] }, steps: [{ command: 'say exact evidence', expect: ['exact evidence'] }] }
    const parse = (reply: any) => { expect(reply.result.isError).not.toBe(true); return JSON.parse(reply.result.content[0].text) }
    const started = parse(await client.call(input))
    expect(started.taskId).toMatch(/^[a-f0-9-]{36}$/)
    const done = parse(await client.call({ operation: 'state', taskId: started.taskId, waitSeconds: 10 }))
    expect(done).toMatchObject({ status: 'completed', result: { success: true, cleanup: 'complete' } })
    expect(await fs.readFile(done.logPath, 'utf8')).toContain('exact evidence')
    expect(JSON.parse(await fs.readFile(done.result.reportPath, 'utf8')).jars[0].sha256).toBe(input.fixture.jars[0].sha256)
    const reader = await connect(true)
    const denied = await reader.call(input)
    expect(denied.result.isError).toBe(true); expect(JSON.stringify(denied)).toContain('只读')
    expect(parse(await reader.call({ operation: 'state', taskId: started.taskId })).status).toBe('completed')
    await expect(service.read({ ...project, path: path.join(root, 'other') }, started.taskId)).rejects.toThrow('不属于当前项目')
  } finally {
    await service.stop()
    for (const child of children) if (child.exitCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill(); await closed }
    for (const bridge of bridges) await bridge.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20000)
