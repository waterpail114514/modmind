import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { MinecraftRuntimeManager } from '../../feature-plugins/testing/src/main/minecraftRuntime'
import { createModpackTemplate, adoptExternalModpack, auditImportedPackArtifacts, readModpackImportStatus } from './modpackService'
import { createStoredZip } from './bedrockAddon'
import type { ProjectInfo } from '../shared/types'
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { clean(); reject(new Error('MCP response timed out')) }, 10_000)
    const onClose = (): void => { clean(); reject(new Error('MCP process exited')) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clean()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    const clean = (): void => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose) }
    child.stdout.on('data', onData); child.once('close', onClose)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}


it('reads advisory import status over MCP and keeps runtime validation mandatory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-import-compat-mcp-'))
  let bridge: ModMindBridge | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    const project: ProjectInfo = { path: root, name: 'Pack', namespace: 'pack', kind: 'modpack', loader: 'forge', minecraftVersion: '1.20.1', createdAt: '' }
    await createModpackTemplate(project)
    await fs.writeFile(path.join(root, 'mods/valid.jar'), createStoredZip([
      { name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"') },
      { name: 'example/Mod.class', data: Buffer.alloc(2048) }
    ]))
    await adoptExternalModpack(project, { format: 'instance', layout: 'instance', importedAt: '' })
    const runtime = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: () => {} })
    bridge = new ModMindBridge(project, {
      build: async () => { await runtime.syncModpack(); return { success: true } },
      runtimeState: async () => ({ ...runtime.getState(), modpackImport: await readModpackImportStatus(project) })
    } as unknown as ExternalAgentBridgeHandlers)
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const listed = await rpc(child, 1, 'tools/list')
    expect(listed.result.tools.some((tool: { name: string }) => tool.name === 'modmind_runtime_state')).toBe(true)
    const successful = await rpc(child, 2, 'tools/call', { name: 'modmind_build_project', arguments: {} })
    expect(successful.result.isError).not.toBe(true)
    const custom = path.join(root, 'mods/unrecognized.jar')
    const original = createStoredZip([{ name: 'example/Unknown.class', data: Buffer.alloc(2048) }])
    await fs.writeFile(custom, original)
    await adoptExternalModpack(project, { format: 'instance', layout: 'instance', importedAt: '' })
    const warnings = await auditImportedPackArtifacts(project)
    const report = await rpc(child, 3, 'tools/call', { name: 'modmind_runtime_state', arguments: {} })
    expect(report.result.isError).not.toBe(true)
    expect(JSON.parse(report.result.content[0].text).modpackImport.compatibilityWarnings).toEqual(warnings)
    expect(warnings.join('')).toContain('已按原包保留')
    const failed = await rpc(child, 4, 'tools/call', { name: 'modmind_build_project', arguments: {} })
    expect(failed.result.isError).toBe(true)
    expect(JSON.stringify(failed.result)).toContain('forge descriptor')
    expect(await fs.readFile(custom)).toEqual(original)
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill(); await exited }
    await bridge?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20_000)
