import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CORE_AGENT_TOOLS, agentToolInventoryReady, waitForAgentTools } from './agentToolReadiness'
import { runExternalAgent, type ExternalAgentBridgeHandlers } from './externalAgents'
import { CLAUDE_REQUIRED_FLAGS } from './claudeCompatibility'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('agent tool readiness', () => {
  it('requires the core catalog even when native builtins or unrelated servers are available', () => {
    expect(agentToolInventoryReady({ runtimeStatus: 'connected', tools: {} }, 'codex')).toBe(false)
    expect(agentToolInventoryReady({ runtimeStatus: 'failed', tools: Object.fromEntries(CORE_AGENT_TOOLS.map(name => [name, {}])) }, 'codex')).toBe(false)
    expect(agentToolInventoryReady({ status: 'connected', tools: CORE_AGENT_TOOLS.map(name => ({ name })) }, 'claude')).toBe(true)
  })

  it('waits through empty discovery and follows pagination to the actual server', async () => {
    const list = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ name: 'other', tools: {} }], nextCursor: 'next' })
      .mockResolvedValueOnce({ data: [{ name: 'modmind', runtimeStatus: 'connected', tools: Object.fromEntries(CORE_AGENT_TOOLS.map(name => [name, {}])) }] })
    await waitForAgentTools({ kind: 'codex', signal: new AbortController().signal, list, pollMs: 1 })
    expect(list.mock.calls.map(call => call[0])).toEqual([undefined, undefined, 'next'])
  })

  it('bounds empty catalogs and remains cancellable while discovery hangs', async () => {
    await expect(waitForAgentTools({ kind: 'codex', signal: new AbortController().signal, timeoutMs: 20, pollMs: 1, list: async () => ({ data: [] }) })).rejects.toMatchObject({ name: 'AgentToolsNotReadyError' })
    const controller = new AbortController()
    const pending = waitForAgentTools({ kind: 'codex', signal: controller.signal, list: () => new Promise(() => undefined) })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

async function fixture(kind: 'codex' | 'claude', mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-tool-gate-'))
  roots.push(root)
  const log = path.join(root, 'requests.jsonl')
  const counter = path.join(root, 'attempts.txt')
  const runner = path.join(root, 'agent.mjs')
  await fs.writeFile(runner, `
import fs from 'node:fs';
import readline from 'node:readline';
if(process.argv.includes('--help')) {console.log(${JSON.stringify(CLAUDE_REQUIRED_FLAGS.join(' ') + ' dontAsk --bare')});process.exit(0)}
const log=${JSON.stringify(log)},counter=${JSON.stringify(counter)},mode=${JSON.stringify(mode)},kind=${JSON.stringify(kind)};
const attempt=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;fs.writeFileSync(counter,String(attempt));
const tools=${JSON.stringify(CORE_AGENT_TOOLS)}.map(name=>({name}));
let checks=0;
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({attempt,...r})+'\\n');
 const method=r.method||r.request?.subtype;
 const fails=mode==='failed'||mode==='empty'||mode==='first-failed'&&attempt===1;
 const server={name:'modmind',runtimeStatus:fails&&mode!=='empty'?'failed':'connected',status:fails&&mode!=='empty'?'failed':'connected',tools:fails?[]:tools};
 if(kind==='claude'&&r.type==='control_request') {
  send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:method==='mcp_status'?{mcpServers:[server]}:{}}});return;
 }
 if(method==='initialize') send({id:r.id,result:{userAgent:'test'}});
 else if(['thread/start','thread/resume','thread/fork'].includes(method)) {
  send({id:r.id,result:{thread:{id:'tool-thread'}}});
  if(mode==='notification') send({method:'mcpServer/startupStatus/updated',params:{threadId:'tool-thread',name:'modmind',status:'failed',error:'injected failure',failureReason:null}});
  if(mode==='child-failure') send({method:'mcpServer/startupStatus/updated',params:{threadId:'unrelated-thread',name:'modmind',status:'failed'}});
 }
 else if(method==='mcpServerStatus/list') {checks++;if(mode==='delayed'&&checks===1) server.tools=[];send({id:r.id,result:{data:[server],nextCursor:null}})}
 else if(method==='mcpServer/tool/call') send({id:r.id,result:{content:[{type:'text',text:'{}'}],isError:mode==='probe-failed'}});
 else if(method==='turn/start') {
  send({id:r.id,result:{turn:{id:'tool-turn'}}});
  if((mode==='runtime-loss'||mode==='unsafe-loss')&&attempt===1) {
   if(mode==='unsafe-loss') send({method:'item/started',params:{threadId:'tool-thread',turnId:'tool-turn',item:{id:'pending-write',type:'mcpToolCall',server:'modmind',tool:'modmind_apply_edits'}}});
   send({method:'mcpServer/startupStatus/updated',params:{threadId:'tool-thread',name:'modmind',status:'failed'}});return;
  }
  send({method:'item/completed',params:{threadId:'tool-thread',turnId:'tool-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'done'}}});
  send({method:'turn/completed',params:{threadId:'tool-thread',turn:{id:'tool-turn',status:'completed'}}});
 } else if(method==='turn/interrupt') send({id:r.id,result:{}});
 else if(r.type==='user') send({type:'result',subtype:'success',is_error:false,result:'done'});
});
process.stdin.on('end',()=>process.exit(0));
`, 'utf8')
  const executable = process.platform === 'win32' ? path.join(root, 'agent.cmd') : runner
  if (process.platform === 'win32') await fs.writeFile(executable, '@echo off\r\nnode "%~dp0agent.mjs" %*\r\n')
  else { await fs.writeFile(runner, '#!/usr/bin/env node\n' + await fs.readFile(runner, 'utf8')); await fs.chmod(runner, 0o755) }
  const project = { path: root, name: 'Tool readiness', loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'tools', createdAt: '' } as ProjectInfo
  return { project, executable, log, counter, bridge: { projectInfo: { name: project.name } } as unknown as ExternalAgentBridgeHandlers }
}

describe('native turn readiness gate', () => {
  it.each(['codex', 'claude'] as const)('reconnects %s before sending the original task once, in both surfaces and restored sessions', async kind => {
    for (const readOnly of [false, true]) for (const resume of [false, true]) {
      const f = await fixture(kind, 'first-failed')
      const onOutput = vi.fn()
      const result = await runExternalAgent({ ...f, kind, readOnly, forceCodexAppServer: true, ...(resume ? { sessionId: 'saved-thread', resumeSession: true } : {}), prompt: 'Original task must survive preparation', persistentRetry: true, signal: AbortSignal.timeout(15000), onOutput, onProgress: vi.fn() })
      expect(result.summary).toBe('done')
      const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const turns = calls.filter(call => call.method === 'turn/start' || call.type === 'user')
      expect(turns).toHaveLength(1)
      expect(turns[0].attempt).toBe(2)
      expect(JSON.stringify(turns[0])).toContain('Original task must survive preparation')
      expect(onOutput.mock.calls.filter(([type]) => type === 'retry')).toHaveLength(1)
      if (kind === 'codex') expect(calls.findIndex(call => call.attempt === 2 && call.method === 'mcpServer/tool/call')).toBeLessThan(calls.indexOf(turns[0]))
    }
  }, 30000)

  it.each([
    ['codex', 'failed'], ['claude', 'failed'], ['codex', 'empty'], ['claude', 'empty'],
    ['codex', 'notification'], ['codex', 'probe-failed']
  ] as const)('never submits a user turn after two failed preparations (%s, %s)', async (kind, mode) => {
    const f = await fixture(kind, mode)
    const onStarted = vi.fn()
    await expect(runExternalAgent({ ...f, kind, forceCodexAppServer: true, prompt: 'Do not submit me', persistentRetry: true, toolReadinessTimeoutMs: 700, signal: AbortSignal.timeout(10000), onStarted, onOutput: vi.fn(), onProgress: vi.fn() })).rejects.toMatchObject({ name: 'AgentToolsNotReadyError' })
    expect(await fs.readFile(f.counter, 'utf8')).toBe('2')
    const calls = await fs.readFile(f.log, 'utf8')
    expect(calls).not.toContain('turn/start')
    expect(calls).not.toContain('"type":"user"')
    expect(onStarted).not.toHaveBeenCalled()
  }, 15000)

  it.each(['delayed', 'child-failure'])('waits for discovery and isolates unrelated startup failures (%s)', async mode => {
    const f = await fixture('codex', mode)
    await expect(runExternalAgent({ ...f, kind: 'codex', forceCodexAppServer: true, prompt: 'task', signal: AbortSignal.timeout(10000), onOutput: vi.fn(), onProgress: vi.fn() })).resolves.toMatchObject({ summary: 'done' })
    expect(await fs.readFile(f.counter, 'utf8')).toBe('1')
  })

  it('reconnects a dropped running session but never replays an unconfirmed write', async () => {
    for (const mode of ['runtime-loss', 'unsafe-loss']) {
      const f = await fixture('codex', mode)
      const run = runExternalAgent({ ...f, kind: 'codex', forceCodexAppServer: true, prompt: 'original task', persistentRetry: true, signal: AbortSignal.timeout(10000), onOutput: vi.fn(), onProgress: vi.fn() })
      if (mode === 'unsafe-loss') {
        await expect(run).rejects.toMatchObject({ name: 'ExternalAgentUnsafeInterruptionError' })
        expect(await fs.readFile(f.counter, 'utf8')).toBe('1')
      } else {
        await expect(run).resolves.toMatchObject({ summary: 'done' })
        const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        expect(calls.find(call => call.attempt === 2 && call.method === 'thread/resume')?.params.threadId).toBe('tool-thread')
        expect(JSON.stringify(calls.find(call => call.attempt === 2 && call.method === 'turn/start'))).toContain('不要重复已完成')
      }
    }
  }, 20000)

  it('preserves fallback history when an empty newly created thread needs tool reconnection', async () => {
    const f = await fixture('codex', 'first-failed')
    await runExternalAgent({ ...f, kind: 'codex', forceCodexAppServer: true, prompt: 'continue', fallbackPrompt: 'Full original task and visible history', signal: AbortSignal.timeout(10000), onOutput: vi.fn(), onProgress: vi.fn() })
    const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(JSON.stringify(calls.find(call => call.method === 'turn/start'))).toContain('Full original task and visible history')
  })

  it.each(['codex', 'claude'] as const)('cancels %s while waiting without submitting or reconnecting', async kind => {
    const f = await fixture(kind, 'empty')
    const controller = new AbortController()
    let cancellation: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(runExternalAgent({ ...f, kind, forceCodexAppServer: true, prompt: 'cancelled task', signal: controller.signal,
        onOutput: vi.fn(), onProgress: title => { if (title === '正在准备工具' && !cancellation) cancellation = setTimeout(() => controller.abort(), 700) }
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(await fs.readFile(f.counter, 'utf8')).toBe('1')
      const calls = await fs.readFile(f.log, 'utf8')
      expect(calls).not.toContain('turn/start')
      expect(calls).not.toContain('"type":"user"')
    } finally { clearTimeout(cancellation) }
  }, 10000)
})
