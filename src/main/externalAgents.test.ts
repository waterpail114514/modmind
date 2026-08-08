import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { externalAgentDocsUrl, ModMindBridge, parseExternalAgentOutputLine, runExternalAgent, type ExternalAgentBridgeHandlers } from './externalAgents'
import type { AiSettings, ProjectInfo } from '../shared/types'

const temporaryRoots: string[] = []
const bridges: ModMindBridge[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})))
})

async function rpc(child: ChildProcessWithoutNullStreams, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let stderr = ''
    const onData = (chunk: Buffer): void => {
      const line = chunk.toString('utf8').trim().split(/\r?\n/).at(-1)
      if (!line) return
      child.stdout.off('data', onData)
      try { resolve(JSON.parse(line) as Record<string, unknown>) } catch (error) { reject(error) }
    }
    const onError = (chunk: Buffer): void => { stderr += chunk.toString('utf8') }
    const onClose = (code: number | null): void => reject(new Error(`MCP process exited with ${code}: ${stderr}`))
    child.stdout.on('data', onData)
    child.stderr.on('data', onError)
    child.once('close', onClose)
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

describe('ModMind external agent MCP bridge', () => {
  it('opens Bilibili installation tutorials', () => {
    expect(externalAgentDocsUrl('codex')).toMatch(/^https:\/\/search\.bilibili\.com\//)
    expect(externalAgentDocsUrl('claude')).toMatch(/^https:\/\/search\.bilibili\.com\//)
    expect(externalAgentDocsUrl('opencode')).toMatch(/^https:\/\/search\.bilibili\.com\//)
  })

  it('does not classify ordinary stderr output as an error', () => {
    expect(parseExternalAgentOutputLine('Loading project metadata', 'stderr')?.kind).toBe('tool')
    expect(parseExternalAgentOutputLine('warning: deprecated API', 'stderr')?.kind).toBe('warning')
    expect(parseExternalAgentOutputLine('{"type":"error","message":"403 Forbidden"}', 'stdout')?.kind).toBe('error')
    expect(parseExternalAgentOutputLine('{"type":"item.completed","item":{"type":"agent_message","text":"处理完成"}}', 'stdout')).toMatchObject({
      kind: 'response', content: '处理完成', agentMessage: true
    })
  })

  it('lists and routes Todo and mappings tools', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-external-agent-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'MCP Smoke Test', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'mcp_smoke', createdAt: new Date().toISOString()
    }
    let mappingQuery = ''
    let todoCount = 0
    let classifiedIntent = ''
    let editPath = ''
    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: {name: project.name},
      setIntent: async (intent) => { classifiedIntent = intent; return {intent} },
      applyEdits: async (edits) => {
        editPath = String((edits[0] as {path?: unknown} | undefined)?.path ?? '')
        return {changedFiles: [editPath]}
      },
      updateTodo: async (tasks) => { todoCount = tasks.length; return {todoCount} },
      mappingsSearch: async (query) => { mappingQuery = query; return {query} },
      mappingsClass: async () => ({}),
      dependencySearch: async () => ({}),
      dependencyInstall: async () => ({}),
      contentValidate: async () => ({}),
      testMatrix: async () => ({}),
      releasePreflight: async () => ({}),
      build: async () => ({}),
      testMinecraft: async () => ({}),
      blockbenchActions: async () => ({}),
      runtimeState: async () => ({})
    }
    const bridge = new ModMindBridge(project, handlers)
    bridges.push(bridge)
    const {mcpConfigPath} = await bridge.start()
    await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')) as {mcpServers: {modmind: {command: string; args: string[]; env?: Record<string, string>}}}
    const child = spawn(config.mcpServers.modmind.command, config.mcpServers.modmind.args, {
      env: {...process.env, ...config.mcpServers.modmind.env}, stdio: ['pipe', 'pipe', 'pipe']
    })
    children.push(child)

    const listed = await rpc(child, {jsonrpc: '2.0', id: 1, method: 'tools/list'})
    const tools = (listed.result as {tools: Array<{name: string; annotations?: Record<string, boolean>}>}).tools
    const toolNames = tools.map((tool) => tool.name)
    expect(toolNames).toContain('modmind_update_todo')
    expect(toolNames).toContain('modmind_set_intent')
    expect(toolNames).toContain('modmind_apply_edits')
    expect(toolNames).toContain('modmind_mapping_search')
    expect(toolNames).toContain('modmind_dependency_search')
    expect(toolNames).toContain('modmind_dependency_install')
    expect(toolNames).toContain('modmind_validate_content')
    expect(toolNames).toContain('modmind_test_matrix')
    expect(toolNames).toContain('modmind_release_preflight')
    expect(toolNames).not.toContain('modmind_publish_release')
    expect(tools.find((tool) => tool.name === 'modmind_project_info')?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false
    })
    expect(tools.find((tool) => tool.name === 'modmind_set_intent')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false
    })
    expect(tools.find((tool) => tool.name === 'modmind_build_project')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true
    })

    await rpc(child, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'modmind_set_intent', arguments: {intent: 'informational', reason: 'Greeting'}}})
    await rpc(child, {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'modmind_mapping_search', arguments: {query: 'LivingEntity'}}})
    await rpc(child, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'modmind_update_todo', arguments: {tasks: [{id: 'T1', title: 'Inspect', status: 'in_progress'}]}}})
    await rpc(child, {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'modmind_apply_edits', arguments: {edits: [{path: 'src/main/java/Test.java', newText: 'class Test {}'}]}}})
    expect(classifiedIntent).toBe('informational')
    expect(mappingQuery).toBe('LivingEntity')
    expect(todoCount).toBe(1)
    expect(editPath).toBe('src/main/java/Test.java')
  })

  it.runIf(process.env.MODMIND_LIVE_CODEX === '1')('lets Codex call ModMind tools without an approval prompt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-live-codex-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Live Codex MCP Smoke Test', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'live_codex_smoke', createdAt: new Date().toISOString()
    }
    let classifiedIntent = ''
    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: {name: project.name},
      setIntent: async (intent) => { classifiedIntent = intent; return {intent} },
      applyEdits: async () => ({}),
      updateTodo: async () => ({}),
      mappingsSearch: async () => ({}),
      mappingsClass: async () => ({}),
      dependencySearch: async () => ({}),
      dependencyInstall: async () => ({}),
      contentValidate: async () => ({}),
      testMatrix: async () => ({}),
      releasePreflight: async () => ({}),
      build: async () => ({}),
      testMinecraft: async () => ({}),
      blockbenchActions: async () => ({}),
      runtimeState: async () => ({})
    }
    const executable = process.env.MODMIND_CODEX_PATH
      ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd')
    const result = await runExternalAgent({
      kind: 'codex', executable, project, settings: {} as AiSettings,
      prompt: '这是一个信息查询。请声明 informational 意图，然后只回复“审批回归成功”，不要读取文件。',
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: handlers
    })

    expect(classifiedIntent).toBe('informational')
    expect(result.transcript).not.toContain('user cancelled MCP tool call')
  }, 120_000)
})
