import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { MinecraftRuntimeManager } from './minecraftRuntime'
import { CreationFeedbackService } from './creationFeedbackService'
import { createModpackTemplate, addModpackModule } from './modpackService'
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

it('builds and synchronizes a linked Forge module through the workbench MCP and returns readable file evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-pack-build-mcp-'))
  let bridge: ModMindBridge | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    const project: ProjectInfo = { path: path.join(root, 'pack'), name: 'Pack', namespace: 'pack', kind: 'modpack', loader: 'forge', minecraftVersion: '1.20.1', createdAt: '' }
    await fs.mkdir(project.path); await createModpackTemplate(project)
    const module: ProjectInfo = { ...project, path: path.join(root, 'linked'), name: 'Linked', namespace: 'linked', kind: 'mod' }
    await fs.mkdir(module.path)
    await fs.writeFile(path.join(module.path, 'modmind.project.json'), JSON.stringify(module))
    await fs.writeFile(path.join(module.path, 'build.gradle'), '// fixture')
    await addModpackModule(project, { name: module.name, namespace: module.namespace, path: module.path, linked: true, createdAt: '' })
    const runtime = new MinecraftRuntimeManager({ getProject: () => project, onState: () => {}, onEvent: () => {} })
    const compile = vi.fn(async () => {
      await fs.mkdir(path.join(module.path, 'build/libs'), { recursive: true })
      await fs.writeFile(path.join(module.path, 'build/libs/linked.jar'), createStoredZip([
        { name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="linked"') },
        { name: 'example/Mod.class', data: Buffer.alloc(2048) }
      ]))
    })
    Object.assign(runtime, { runGradleBuild: compile })
    const feedback = new CreationFeedbackService(project)
    const build = vi.fn(async () => ({ success: true, artifact: await feedback.build(() => runtime.buildProject()) }))
    bridge = new ModMindBridge(project, { build } as unknown as ExternalAgentBridgeHandlers)
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const tools = await rpc(child, 1, 'tools/list')
    expect(tools.result.tools.some((tool: { name: string }) => tool.name === 'modmind_build_project')).toBe(true)
    const reply = await rpc(child, 2, 'tools/call', { name: 'modmind_build_project', arguments: {} })
    expect(reply.result.isError).not.toBe(true)
    const result = JSON.parse(reply.result.content[0].text)
    expect(result.success).toBe(true)
    expect(compile).toHaveBeenCalledOnce()
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ path: module.path }), expect.anything())
    expect((await fs.stat(result.artifact.path)).isFile()).toBe(true)
    expect(JSON.parse(await fs.readFile(result.artifact.path, 'utf8')).files).toContain('modmind-local-linked.jar')
    expect(JSON.parse(await fs.readFile(result.artifact.path, 'utf8')).artifacts).toEqual([expect.objectContaining({ name: 'modmind-local-linked.jar', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })])
    expect(await feedback.verifyLatestBuild()).toBe(true)
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child!.once('close', () => resolve()))
      child.kill(); await exited
    }
    await bridge?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20_000)
