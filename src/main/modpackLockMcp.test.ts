import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { createEmptyModpackLock, manageModpackLock, MODPACK_LOCK_FILE, readModpackLock } from './modpackLockService'
import { createModpackTemplate } from './modpackService'
import type { ProjectInfo } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const clean = (): void => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose) }
    const timer = setTimeout(() => { clean(); reject(new Error('MCP response timed out')) }, 10_000)
    const onClose = (): void => { clean(); reject(new Error('MCP process exited')) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clean()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    child.stdout.on('data', onData); child.once('close', onClose)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

it.each(['embedded', 'standalone'])('discovers, inspects and repairs a lock through %s MCP with project and permission boundaries', async (transport) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-lock-mcp-'))
  let bridge: ModMindBridge | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  const stop = async (): Promise<void> => {
    if (child && child.exitCode === null) { const closed = new Promise<void>((resolve) => child!.once('close', () => resolve())); child.kill(); await closed }
    child = undefined
    await bridge?.stop(); bridge = undefined
  }
  try {
    const project: ProjectInfo = { path: path.join(root, 'a'), name: 'A', namespace: 'a', kind: 'modpack', loader: 'forge', minecraftVersion: '1.20.1', createdAt: '' }
    const other: ProjectInfo = { ...project, path: path.join(root, 'b'), name: 'B' }
    for (const p of [project, other]) { await fs.mkdir(p.path); await createModpackTemplate(p) }
    const contents = Buffer.alloc(2048, 6)
    await fs.writeFile(path.join(project.path, 'mods/create.jar'), contents)
    const records = ['modrinth', 'curseforge'].map((provider) => ({ provider, projectId: provider, versionId: '608', versionName: '6.0.8', fileName: 'create.jar', sha256: createHash('sha256').update(contents).digest('hex'), size: contents.length, side: 'both', sources: [`https://example.test/${provider}.jar`], installedAt: '' }))
    const original = JSON.stringify({ ...createEmptyModpackLock(project), mods: records })
    await fs.writeFile(path.join(project.path, MODPACK_LOCK_FILE), original)
    let approved = true
    const reviewAction = vi.fn(async () => ({ approved }))
    let active = project
    const start = async (readOnly: boolean): Promise<void> => {
      // Bind to the bridge's project even when the visible project changes later.
      const bound = active
      const handlers = { modpackLock: (input: Record<string, unknown>) => manageModpackLock(bound, input), reviewAction } as unknown as ExternalAgentBridgeHandlers
      bridge = new ModMindBridge(bound, handlers, 'development', undefined, readOnly)
      const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
      const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
      const env = { ...process.env, ...config.env }
      if (transport === 'standalone') {
        env.MODMIND_BRIDGE_CONFIG = path.join(path.dirname(config.args[0]), 'bridge.json')
        config.args = [path.resolve('modmind-mcp-open-source/src/mcp-server.mjs')]
      }
      child = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    }
    let id = 0
    const call = async (input: object): Promise<any> => (await rpc(child!, ++id, 'tools/call', { name: 'modmind_modpack_lock', arguments: input })).result
    await start(false)
    const tools = (await rpc(child!, ++id, 'tools/list')).result.tools
    const tool = tools.find((entry: { name: string }) => entry.name === 'modmind_modpack_lock')
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ['operation'] })
    expect(tool.inputSchema.properties.operation.enum).toEqual(['inspect', 'repair'])
    expect(tool.annotations.readOnlyHint).toBe(false)
    const inspected = await call({ operation: 'inspect' })
    expect(JSON.parse(inspected.content[0].text)).toMatchObject({ success: false, canRepair: true, repaired: false, duplicateFiles: ['create.jar'] })
    expect(await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')).toBe(original)
    expect(reviewAction).not.toHaveBeenCalled()
    approved = false
    const denied = await call({ operation: 'repair' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('AI Review denied')
    expect(await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE), 'utf8')).toBe(original)
    approved = true
    active = other
    const repaired = await call({ operation: 'repair' })
    expect(repaired.isError).not.toBe(true)
    const result = JSON.parse(repaired.content[0].text)
    expect(result).toMatchObject({ success: true, repaired: true, records: 1 })
    expect(await fs.readFile(result.backupPath, 'utf8')).toBe(original)
    expect(await fs.readFile(path.join(project.path, 'mods/create.jar'))).toEqual(contents)
    expect((await readModpackLock(project)).mods).toHaveLength(1)
    await expect(fs.access(path.join(other.path, MODPACK_LOCK_FILE))).rejects.toThrow()
    expect(reviewAction).toHaveBeenCalledWith('modpack_lock', { operation: 'repair' })
    expect((await call({ operation: 'repair', path: other.path })).isError).toBe(true)
    expect((await call({ operation: 'reset' })).isError).toBe(true)
    // A real file mismatch is returned structurally, without changing the lock or JAR.
    await fs.writeFile(path.join(project.path, 'mods/create.jar'), Buffer.alloc(2048, 2))
    const mismatch = JSON.parse((await call({ operation: 'repair' })).content[0].text)
    expect(mismatch).toMatchObject({ success: false, canRepair: false, repaired: false, errors: [expect.objectContaining({ fileName: 'create.jar' })] })
    await stop(); active = project; await start(true)
    const read = await call({ operation: 'inspect' })
    expect(read.isError).not.toBe(true)
    expect((await call({ operation: 'repair' })).isError).toBe(true)
    expect(JSON.stringify(await call({ operation: 'repair' }))).toContain('只读')
  } finally { await stop(); await fs.rm(root, { recursive: true, force: true }) }
}, 30_000)
