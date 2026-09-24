import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { CLAUDE_REQUIRED_FLAGS, claudeHostedEnvironment } from './claudeCompatibility'
import { deleteExternalAgentSession, detectExternalAgent, readExternalAgentHistory, runExternalAgent, type ExternalAgentBridgeHandlers, type ExternalAgentRunOptions } from './externalAgents'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-claude-'))
  roots.push(root)
  const project: ProjectInfo = { name: 'Claude fixture', path: path.join(root, 'project'), loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'claude_fixture', createdAt: new Date().toISOString() }
  await fs.mkdir(project.path)
  const empty = async () => ({})
  const bridge: ExternalAgentBridgeHandlers = {
    projectInfo: { name: project.name }, setIntent: empty, applyEdits: empty,
    updateTodo: empty, mappingsSearch: empty, mappingsClass: empty, dependencySearch: empty,
    dependencyInstall: empty, contentValidate: empty, testMatrix: empty,
    releasePreflight: empty, build: empty, testMinecraft: empty, blockbenchActions: empty, runtimeState: empty
  }
  const outputs: string[] = []
  const options: ExternalAgentRunOptions = {
    kind: 'claude', project, prompt: '完成测试', signal: AbortSignal.timeout(20_000),
    bridge, onOutput: (_kind, text) => outputs.push(text), onProgress: () => undefined
  }
  return { root, project, bridge, outputs, options }
}

async function fakeCli(root: string, source: string, help = CLAUDE_REQUIRED_FLAGS.join(' ') + ' dontAsk --bare'): Promise<string> {
  const runner = path.join(root, 'claude-fixture.mjs')
  await fs.writeFile(runner, `#!/usr/bin/env node\nimport fs from 'node:fs';\nif (process.argv.includes('--version')) { console.log('2.1.231 (Claude Code)'); process.exit(0); }\nif (process.argv.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0); }\n${source}`)
  if (process.platform !== 'win32') { await fs.chmod(runner, 0o755); return runner }
  const executable = path.join(root, 'claude-fixture.cmd')
  await fs.writeFile(executable, '@echo off\r\nnode "%~dp0claude-fixture.mjs" %*\r\n')
  return executable
}

describe('Claude managed process', () => {
  it.each(['allow', 'deny'] as const)('answers native permission requests with %s while preserving the input', async decision => {
    const f = await fixture()
    const executable = await fakeCli(f.root, `
      if (!process.argv.includes('--permission-prompt-tool') || !process.argv.includes('stdio')) process.exit(3);
      const readline = await import('node:readline');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const message = JSON.parse(line);
        if (message.type === 'user') console.log(JSON.stringify({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Read',input:{file_path:'src/Main.java'},decision_reason:'需要读取文件'}}));
        if (message.type === 'control_response') {
          fs.writeFileSync(${JSON.stringify(path.join(f.root, 'permission.json'))}, JSON.stringify(message));
          console.log(JSON.stringify({type:'result',subtype:'success',result:'完成权限请求',session_id:'manual-session'}));
        }
      });
    `)
    await runExternalAgent({ ...f.options, executable, approvalMode: 'manual', onApproval: async request => {
      expect(request).toMatchObject({ engine: 'claude', allowSession: false, reason: '需要读取文件' })
      expect(request.detail).toContain('src/Main.java')
      return decision
    } })
    const reply = JSON.parse(await fs.readFile(path.join(f.root, 'permission.json'), 'utf8'))
    expect(reply.response).toMatchObject({ subtype: 'success', request_id: 'permission-1', response: { behavior: decision } })
    if (decision === 'allow') expect(reply.response.response.updatedInput).toEqual({ file_path: 'src/Main.java' })
  })

  it.each(['manual', 'auto-review', 'yolo'] as const)('gates managed mutations in %s mode and falls back when review is unavailable', async mode => {
    const f = await fixture()
    let mutations = 0
    let approvals = 0
    const approvalReasons: (string | undefined)[] = []
    const executable = await fakeCli(f.root, `
      const args=process.argv.slice(2);
      const config=JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'));
      const server=config.mcpServers.modmind;
      const bridge=JSON.parse(fs.readFileSync(new URL('./bridge.json', 'file:///'+server.args[0].replaceAll('\\\\','/')),'utf8'));
      const result=await fetch('http://127.0.0.1:'+bridge.port+'/tool',{method:'POST',headers:{'x-modmind-token':bridge.token},body:JSON.stringify({action:'apply_edits',input:{edits:[]}})});
      await result.text();
      console.log(JSON.stringify({type:'result',subtype:'success',result:'托管工具检查完成',session_id:'tools-session'}));
    `)
    await runExternalAgent({ ...f.options, executable, approvalMode: mode,
      bridge: { ...f.bridge, applyEdits: async () => { mutations++; return {} }, reviewAction: async () => ({ approved: true, complete: true, risk: 'low', feedback: 'review unavailable', unavailable: mode === 'auto-review', dangerousOperations: [] }) },
      onApproval: async request => { approvals++; approvalReasons.push(request.fallbackReason); return 'deny' }
    })
    expect(approvals).toBe(mode === 'yolo' ? 0 : 1)
    if (mode === 'manual') expect(approvalReasons).toEqual([undefined])
    if (mode === 'auto-review') expect(approvalReasons[0]).toContain('回退')
    expect(mutations).toBe(mode === 'yolo' ? 1 : 0)
  })

  it('rejects an installed incompatible CLI without starting or endlessly retrying a task', async () => {
    const f = await fixture()
    const marker = path.join(f.root, 'started')
    const executable = await fakeCli(f.root, `fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`, '--print')
    expect(await detectExternalAgent('claude', { executables: [executable], includeDefaults: false })).toMatchObject({ installed: true, compatible: false })
    await expect(runExternalAgent({ ...f.options, executable, persistentRetry: true })).rejects.toMatchObject({ name: 'ClaudeCompatibilityError' })
    await expect(fs.stat(marker)).rejects.toThrow()
  })

  it('restores system instructions on resume and preserves UTF-8 split across chunks', async () => {
    const f = await fixture()
    const executable = await fakeCli(f.root, `
      const args = process.argv.slice(2);
      const system = args[args.indexOf('--append-system-prompt') + 1];
      if (!system.includes('恢复工作流规则') || !system.includes('我是 ModMind 工作台，基于 Claude Code') || !system.includes('当前接入的模型是 claude-test-model。')) process.exit(2);
      if (args[args.indexOf('--permission-mode') + 1] !== 'dontAsk') process.exit(3);
      if (!JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks) process.exit(4);
      const result = Buffer.from(JSON.stringify({type:'result',subtype:'success',result:'中文完成',session_id:'test-session'})+'\\n');
      const split = result.indexOf(Buffer.from('中文'))+1;
      process.stdout.write(result.subarray(0, split));
      setTimeout(() => { process.stdout.write(result.subarray(split)); process.exit(0); }, 30);
    `)
    await runExternalAgent({ ...f.options, executable, sessionId: 'test-session', systemPrompt: '恢复工作流规则', env: { ANTHROPIC_MODEL: 'claude-test-model' } })
    expect(f.outputs).toContain('中文完成')
  })

  it.each(['structured', 'stderr'] as const)('recovers a missing Claude session reported through %s once with fallback context', async format => {
    const f = await fixture()
    const executable = await fakeCli(f.root, `
      if (process.argv.includes('--resume')) {
        ${format === 'structured' ? `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['No conversation found with session ID missing-session']}));` : `console.error('No conversation found with session ID missing-session');`}
        process.exit(1);
      }
      process.stdin.once('data', data => {
        if (!String(data).includes('保留已完成的构建')) process.exit(2);
        console.log(JSON.stringify({type:'result',subtype:'success',result:'恢复完成',session_id:'fresh-session'}));
        process.exit(0);
      });
    `)
    const result = await runExternalAgent({ ...f.options, executable, sessionId: 'missing-session', fallbackPrompt: '保留已完成的构建，继续任务', maxAttempts: 2, retryDelayMs: 1 })
    expect(result.sessionId).toBe('fresh-session')
  })

  it('reads and deletes only the exact session in its custom home', async () => {
    const f = await fixture()
    const sessionHome = path.join(f.root, 'custom-home')
    const sessionDir = path.join(sessionHome, 'projects', 'encoded-project')
    await fs.mkdir(sessionDir, { recursive: true })
    const exact = path.join(sessionDir, 'test-session.jsonl')
    const other = path.join(sessionDir, 'prefix-test-session.jsonl')
    await fs.writeFile(exact, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '自定义目录的历史' }] } }))
    await fs.writeFile(other, 'must remain')
    const executable = await fakeCli(f.root, `console.log(JSON.stringify({type:'result',subtype:'success',result:'完成',session_id:'test-session'})); process.exit(0);`)
    await runExternalAgent({ ...f.options, executable, sessionHome })
    expect(await readExternalAgentHistory(f.project, 'claude')).toContain('自定义目录的历史')
    await deleteExternalAgentSession(f.project, 'claude', 'test-session', sessionHome)
    await expect(fs.stat(exact)).rejects.toThrow()
    expect(await fs.readFile(other, 'utf8')).toBe('must remain')
  })
})

// Opt in with a locally installed CLI. The model is a loopback fixture: no paid
// API, user credentials, user settings, or external model requests are needed.
describe.skipIf(!process.env.MODMIND_CLAUDE_TEST_EXE)('real Claude CLI against local Anthropic protocol fixture', () => {
  it('edits through MCP, builds, resumes, enforces read-only/protected paths, and interrupts', async () => {
    const f = await fixture()
    let buildCount = 0
    let resumeSawHistory = false
    let signalWaiting!: () => void
    const waiting = new Promise<void>(resolve => { signalWaiting = resolve })
    const observedToolErrors: string[] = []
    const requests: string[] = []
    f.bridge.applyEdits = async edits => {
      for (const value of edits as Array<{ path: string; newText: string }>) await fs.writeFile(path.join(f.project.path, value.path), value.newText)
      return { success: true }
    }
    f.bridge.build = async () => {
      expect(await fs.readFile(path.join(f.project.path, 'answer.txt'), 'utf8')).toBe('中文构建测试')
      buildCount += 1
      return { success: true, evidence: 'fixture content verified' }
    }
    const server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        requests.push(request.url ?? '')
        if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ input_tokens: 100 })); return }
        if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end('{}'); return }
        const body = JSON.parse(raw)
        const messages = body.messages as Array<{ role: string; content: unknown }>
        const text = JSON.stringify(messages)
        const scenario = [...text.matchAll(/SMOKE_(WRITE|RESUME|READONLY|PROTECTED|WAIT)/g)].at(-1)?.[1]
        if (scenario === 'WAIT') { signalWaiting(); return }
        if (scenario === 'RESUME') resumeSawHistory = text.includes('SMOKE_WRITE') && text.includes('中文构建测试')
        const last = messages.at(-1)
        const results = Array.isArray(last?.content) ? last.content.filter(item => item.type === 'tool_result') : []
        for (const item of results) if (item.is_error || JSON.stringify(item.content).includes('error')) observedToolErrors.push(JSON.stringify(item))
        let block: Record<string, unknown> = { type: 'text', text: '验证完成' }
        if (scenario === 'WRITE' && !results.length || (scenario === 'READONLY' || scenario === 'PROTECTED') && !results.length) {
          const tool = body.tools.find((entry: { name: string }) => entry.name.endsWith('modmind_apply_edits'))
          block = { type: 'tool_use', id: 'tool_edit', name: tool?.name ?? 'mcp__modmind__modmind_apply_edits', input: { edits: [{ path: scenario === 'PROTECTED' ? '.modmind/forbidden.txt' : scenario === 'READONLY' ? 'forbidden.txt' : 'answer.txt', newText: '中文构建测试' }] } }
        } else if (scenario === 'WRITE' && results.at(-1)?.tool_use_id === 'tool_edit') {
          const tool = body.tools.find((entry: { name: string }) => entry.name.endsWith('modmind_build_project'))
          block = { type: 'tool_use', id: 'tool_build', name: tool?.name ?? 'mcp__modmind__modmind_build_project', input: {} }
        }
        const usage = { input_tokens: 100, output_tokens: 10 }
        const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage }
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
        response.setHeader('content-type', 'text/event-stream')
        const emit = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } })
        emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
        emit('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
        emit('content_block_stop', { index: 0 })
        emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage })
        emit('message_stop', {})
        response.end()
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const sessionHome = path.join(f.root, 'cli-home')
    const env = claudeHostedEnvironment({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-key', model: 'claude-sonnet-4-5' }, sessionHome)
    const options = { ...f.options, executable: process.env.MODMIND_CLAUDE_TEST_EXE!, sessionHome,
      env: { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false' }, signal: AbortSignal.timeout(90_000) }
    const first = await runExternalAgent({ ...options, prompt: 'SMOKE_WRITE' })
    expect(buildCount).toBe(1)
    expect(first.sessionId).toBeTruthy()
    await runExternalAgent({ ...options, sessionId: first.sessionId, prompt: 'SMOKE_RESUME' })
    expect(resumeSawHistory).toBe(true)
    const hookMarker = path.join(f.root, 'unexpected-hook')
    const hookScript = path.join(f.root, 'hook.mjs')
    await fs.writeFile(hookScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(hookMarker)}, 'ran');`)
    const hooks = { SessionStart: [{ hooks: [{ type: 'command', command: `node "${hookScript}"` }] }] }
    await fs.writeFile(path.join(sessionHome, 'settings.json'), JSON.stringify({ hooks }))
    await fs.mkdir(path.join(f.project.path, '.claude'), { recursive: true })
    await fs.writeFile(path.join(f.project.path, '.claude', 'settings.json'), JSON.stringify({ hooks }))
    // Local mode retains user authentication/config but suppresses hooks too.
    await runExternalAgent({ ...options, prompt: 'SMOKE_RESUME', env: { ...options.env, MODMIND_CLAUDE_HOSTED: undefined } })
    await expect(fs.stat(hookMarker)).rejects.toThrow()
    await runExternalAgent({ ...options, readOnly: true, prompt: 'SMOKE_READONLY' })
    await runExternalAgent({ ...options, prompt: 'SMOKE_PROTECTED' })
    await expect(fs.stat(path.join(f.project.path, 'forbidden.txt'))).rejects.toThrow()
    await expect(fs.stat(path.join(f.project.path, '.modmind', 'forbidden.txt'))).rejects.toThrow()
    expect(observedToolErrors.join('\n')).toContain('只读')
    expect(observedToolErrors.join('\n')).toContain('protected')
    const abort = new AbortController()
    const stopped = runExternalAgent({ ...options, prompt: 'SMOKE_WAIT', signal: AbortSignal.any([abort.signal, options.signal]) })
    const outcome = stopped.then(() => 'unexpected-success', error => (error as Error).name)
    await Promise.race([waiting, stopped])
    abort.abort()
    expect(await outcome).toBe('AbortError')
    expect(requests.filter(url => url.startsWith('/v1/messages')).length).toBeGreaterThanOrEqual(8)
  }, 120_000)
})
