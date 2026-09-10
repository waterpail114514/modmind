import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { auditExternalAgentCompletion, agentStreamFailureMessage, buildWindowsExternalAgentLaunch, classifyAgentStreamFailure, clearExternalAgentFailureCircuits, decodeExternalProcessOutput, detectExternalAgent, externalAgentAttemptPrompt, externalAgentContextText, externalAgentDocsUrl, externalAgentLabel, externalAgentRetryPrompt, extractClaudeTokenUsage, installExternalAgent, isExternalAgentCompletionEvent, isForcefulProcessTerminationCommand, isNativeGradleBuildCommand, isReadOnlyActionDenied, isResumedPromptRejection, managedNativeDownloadAction, MCP_SERVER_SOURCE, ModMindBridge, nativePermissionArgs, parseExternalAgentOutputLine, readExternalAgentHistory, refreshExternalAgentContext, runExternalAgent, type ExternalAgentBridgeHandlers } from './externalAgents'
import type { ProjectInfo } from '../shared/types'
import { MODMIND_SOURCE_FINGERPRINT } from '../shared/sourceFingerprint'
import { LiveConfiguration } from './liveConfiguration'
import { WORKBENCH_SKILL_POLICY } from './workbenchSkillPolicy'

const temporaryRoots: string[] = []
const bridges: ModMindBridge[] = []
const children: ChildProcessWithoutNullStreams[] = []

describe('MC百科 MCP boundary', () => {
  it('exposes query-only tools and no captcha or download action', () => {
    expect(MCP_SERVER_SOURCE).toContain("'dev.modmind/source-fingerprint'")
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_mcmod_search'")
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_mcmod_files'")
    expect(MCP_SERVER_SOURCE).not.toMatch(/name:'modmind_mcmod_(?:download|captcha|submit)/)
    expect(MCP_SERVER_SOURCE).not.toMatch(/mcmod_(?:download|captcha|submit):/)
  })
})

describe('modpack migration MCP boundary', () => {
  it('exposes the same scan, apply, history, and undo commands used by the manual workspace', () => {
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_modpack_migration_targets'")
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_modpack_migration_preview'")
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_modpack_migration_apply'")
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_modpack_migration_history'")
    expect(MCP_SERVER_SOURCE).toContain("name:'modmind_modpack_migration_undo'")
    expect(isReadOnlyActionDenied('modpack_migration_apply')).toBe(true)
    expect(isReadOnlyActionDenied('modpack_migration_undo')).toBe(true)
    expect(isReadOnlyActionDenied('modpack_migration_preview')).toBe(false)
  })
})

describe('advanced Blockbench MCP boundary', () => {
  it('exposes editable mesh, reference, visual review, candidate, and history tools', () => {
    for (const name of [
      'modmind_asset_compile_advanced', 'modmind_asset_preview_advanced', 'modmind_asset_apply_advanced',
      'modmind_asset_compile_reference', 'modmind_asset_preview_reference', 'modmind_asset_apply_reference',
      'modmind_asset_visual_review', 'modmind_blockbench_history', 'modmind_blockbench_checkpoint',
      'modmind_blockbench_restore_history'
    ]) expect(MCP_SERVER_SOURCE).toContain(`name:'${name}'`)
    for (const action of ['add-mesh', 'update-mesh', 'paint-texture', 'auto-unwrap-mesh', 'add-armature', 'set-vertex-weights', 'add-ik-target']) {
      expect(MCP_SERVER_SOURCE).toContain(`const:'${action}'`)
    }
    expect(isReadOnlyActionDenied('asset_apply_advanced')).toBe(true)
    expect(isReadOnlyActionDenied('asset_apply_reference')).toBe(true)
    expect(isReadOnlyActionDenied('blockbench_restore_history')).toBe(true)
  })
})

describe('platform-specific Agent context', () => {
  it('keeps NetEase work on the local Python Mod SDK project structure', () => {
    const context = externalAgentContextText({
      name: 'NetEase UI', path: 'C:/projects/netease-ui', loader: 'netease-mobile',
      minecraftVersion: '3.8', namespace: 'netease_ui', createdAt: new Date().toISOString()
    })
    expect(context).toContain('behavior_pack/modMain.py')
    expect(context).toContain('clientSystem.py')
    expect(context).toContain('serverSystem.py')
    expect(context).toContain('Never run Gradle')
    expect(context).toContain('Do not spend the first turn scraping the web')
    expect(context).toContain('official NetEase developer workbench')
  })
})

afterEach(async () => {
  clearExternalAgentFailureCircuits()
  for (const child of children.splice(0)) child.kill()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})))
})

async function rpc(child: ChildProcessWithoutNullStreams, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let stderr = ''
    // tools/list payloads exceed the 64 KiB pipe chunk size, so responses must
    // be reassembled across chunks before a full line can be parsed.
    let buffer = ''
    const cleanup = (): void => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onError)
      child.off('close', onClose)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) return
      cleanup()
      try { resolve(JSON.parse(line) as Record<string, unknown>) } catch (error) { reject(error) }
    }
    const onError = (chunk: Buffer): void => { stderr += chunk.toString('utf8') }
    const onClose = (code: number | null): void => {
      cleanup()
      reject(new Error(`MCP process exited with ${code}: ${stderr}`))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onError)
    child.once('close', onClose)
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

function stubBridgeHandlers(project: ProjectInfo): ExternalAgentBridgeHandlers {
  return {
    projectInfo: {name: project.name},
    projectFiles: async () => ({files: [], truncated: false}),
    setIntent: async () => ({}),
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
}

describe('agent stream failure extraction', () => {
  it('reads the CLI-reported reason from both codex error event shapes', () => {
    expect(agentStreamFailureMessage({type: 'error', message: 'exceeded retry limit, last status: 429 Too Many Requests'}))
      .toBe('exceeded retry limit, last status: 429 Too Many Requests')
    expect(agentStreamFailureMessage({type: 'turn.failed', error: {message: 'exceeded retry limit, last status: 429 Too Many Requests'}}))
      .toBe('exceeded retry limit, last status: 429 Too Many Requests')
    expect(agentStreamFailureMessage({type: 'item.completed', item: {type: 'error'}})).toBe('')
    expect(agentStreamFailureMessage(null)).toBe('')
  })

  it('classifies transient provider failures for retry and request errors as permanent', () => {
    // 429/5xx are transient and retryable.
    for (const message of ['last status: 429 Too Many Requests', 'upstream returned 502', 'server error, status_code=500']) {
      const result = classifyAgentStreamFailure(message)
      expect(result.transient).toBe(true)
      expect(result.reason).toContain('暂时不可用')
    }
    // 400-class request failures fail fast with a short actionable reason.
    const invalid = classifyAgentStreamFailure('请求参数无效，请检查请求格式和参数(request id: 20260827014043304885208268d9d6yoZi5cow)')
    expect(invalid.transient).toBe(false)
    expect(invalid.reason).toContain('不是你的需求内容错误')
    const badRequest = classifyAgentStreamFailure('returned 400 Bad Request')
    expect(badRequest.transient).toBe(false)
    expect(badRequest.status).toBe(400)
    expect(classifyAgentStreamFailure('模型服务与当前 Agent 请求不兼容（415）').kind).toBe('invalid-request')
    expect(classifyAgentStreamFailure('401 Unauthorized').reason).toContain('更新 API Key')
    expect(classifyAgentStreamFailure('402 Payment Required').reason).toContain('额度不足')
    expect(classifyAgentStreamFailure('404 Not Found').reason).toContain('重新扫描模型')
    // Dropped connections retry; digits inside request ids never look like statuses.
    expect(classifyAgentStreamFailure('stream disconnected before completion').transient).toBe(true)
    const idNoise = classifyAgentStreamFailure('超时 (request id: 20260827014043304885208268d9d6yoZi5cow)')
    expect(idNoise.status).toBeNull()
    expect(idNoise.transient).toBe(false)
  })

  it('retries transient provider failures with rendered progress and gives up after the cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-transient-retry-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Transient Retry', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'transient_retry', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    await fs.writeFile(runner, [
      "console.log(JSON.stringify({type:'thread.started', thread_id:'transient-thread'}));",
      "console.log(JSON.stringify({type:'error', message:'exceeded retry limit, last status: 429 Too Many Requests'}));",
      "process.exit(1);"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    const outputs: Array<{kind: string; content: string}> = []
    const progresses: Array<{title: string}> = []
    const audits: Array<{outcome: string}> = []
    await expect(runExternalAgent({
      kind: 'codex', executable, project, prompt: '原始任务', maxAttempts: 2,
      signal: new AbortController().signal,
      onOutput: (kind, content) => outputs.push({kind, content}),
      onProgress: (title) => progresses.push({title}),
      onAttemptAudit: (audit) => audits.push({outcome: audit.outcome}),
      bridge: stubBridgeHandlers(project)
    })).rejects.toThrow('已停止重试')
    // Two stream-error events collapse into one short UI message per attempt.
    expect(outputs.filter((entry) => entry.kind === 'error')).toHaveLength(2)
    expect(outputs.every((entry) => entry.content.length < 120 && !entry.content.includes('request id'))).toBe(true)
    // The retry is rendered on screen, not silent.
    expect(progresses.some((entry) => entry.title.includes('自动重试'))).toBe(true)
    expect(outputs.some((entry) => entry.kind === 'retry' && entry.content.includes('重试'))).toBe(true)
    // Only attempts that will actually run again are recorded as retries.
    expect(audits.filter((audit) => audit.outcome === 'retry')).toHaveLength(1)
    expect(audits[audits.length - 1]?.outcome).toBe('failure')
  }, 30_000)

  it('opens a short circuit after a provider retry batch is exhausted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-provider-circuit-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Circuit', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'circuit', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    await fs.writeFile(runner, "console.log(JSON.stringify({type:'error',message:'last status: 429 Too Many Requests'}));process.exit(1)", 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32' ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n` : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    const options = {
      kind: 'codex' as const, executable, project, prompt: 'task', maxAttempts: 1, retryScope: 'provider:model',
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    }
    await expect(runExternalAgent(options)).rejects.toThrow('连续 1 次')
    await expect(runExternalAgent(options)).rejects.toThrow('线路仍在冷却')
  }, 30_000)

  it('fails fast on invalid-request (400-class) provider errors without retrying', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-invalid-request-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Invalid Request', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'invalid_request', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    const attempts = path.join(root, 'attempts.jsonl')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `const attempts = ${JSON.stringify(attempts)};`,
      "fs.appendFileSync(attempts, 'run\\n');",
      "console.log(JSON.stringify({type:'error', message:'请求参数无效，请检查请求格式和参数(request id: 20260827014043304885208268d9d6yoZi5cow)'}));",
      "console.log(JSON.stringify({type:'turn.failed', error:{message:'请求参数无效，请检查请求格式和参数(request id: 20260827014043304885208268d9d6yoZi5cow)'}}));",
      "process.exit(1);"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    const outputs: Array<{kind: string; content: string}> = []
    const audits: Array<{outcome: string}> = []
    await expect(runExternalAgent({
      kind: 'codex', executable, project, prompt: '原始任务',
      signal: new AbortController().signal,
      onOutput: (kind, content) => outputs.push({kind, content}),
      onProgress: () => undefined,
      onAttemptAudit: (audit) => audits.push({outcome: audit.outcome}),
      bridge: stubBridgeHandlers(project)
    })).rejects.toThrow('不是你的需求内容错误')
    // Exactly one CLI run — no retries — and raw JSON never reaches the UI.
    expect((await fs.readFile(attempts, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1)
    const errorOutputs = outputs.filter((entry) => entry.kind === 'error')
    expect(errorOutputs).toHaveLength(1)
    expect(errorOutputs[0]?.content).toContain('不是你的需求内容错误')
    expect(outputs.some((entry) => entry.content.includes('invalid_request_error'))).toBe(false)
    expect(audits.some((audit) => audit.outcome === 'failure')).toBe(true)
    expect(audits.every((audit) => audit.outcome !== 'retry')).toBe(true)
  }, 30_000)

  it('keeps a persistent task alive and resumes the discovered session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-persistent-retry-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Persistent Retry', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'persistent_retry', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    const attempts = path.join(root, 'attempts.jsonl')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `const attempts = ${JSON.stringify(attempts)};`,
      "const args = process.argv.slice(2);",
      "const count = fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).length + 1 : 1;",
      "fs.appendFileSync(attempts, JSON.stringify(args) + '\\n');",
      "console.log(JSON.stringify({type:'thread.started', thread_id:'persistent-thread'}));",
      "if (count <= 2) { console.log(JSON.stringify({type:'error', message:'last status: 429 Too Many Requests'})); process.exit(1); }",
      "console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'recovered'}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    const audits: string[] = []
    const states: string[] = []

    const result = await runExternalAgent({
      kind: 'codex', executable, project, prompt: 'finish the task', maxAttempts: 2,
      persistentRetry: true, retryDelayMs: 1,
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      onAttemptAudit: (audit) => audits.push(audit.outcome),
      onRetryState: (state) => { states.push(state.phase) },
      bridge: stubBridgeHandlers(project)
    })

    expect(result.summary).toBe('recovered')
    const calls = (await fs.readFile(attempts, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(3)
    expect(calls[0]).not.toContain('resume')
    expect(calls[1]).toContain('resume')
    expect(calls[1]).toContain('persistent-thread')
    expect(calls[2]).toContain('persistent-thread')
    expect(audits).toContain('waiting')
    expect(audits.at(-1)).toBe('complete')
    expect(audits).not.toContain('failure')
    expect(states).toContain('waiting')
  }, 30_000)

  it('does not retry or replace a session after a generic 400 compatibility failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-persistent-compat-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Persistent Compatibility', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'persistent_compatibility', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    const attempts = path.join(root, 'attempts.txt')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `const attempts = ${JSON.stringify(attempts)};`,
      "const count = fs.existsSync(attempts) ? Number(fs.readFileSync(attempts, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(attempts, String(count));",
      "if (count === 1) { console.log(JSON.stringify({type:'turn.failed', error:{message:'returned 400 Bad Request'}})); process.exit(1); }",
      "console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'compatible again'}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    const audits: string[] = []

    await expect(runExternalAgent({
      kind: 'codex', executable, project, prompt: 'original task', maxAttempts: 1,
      persistentRetry: true, retryDelayMs: 1,
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      onAttemptAudit: (audit) => audits.push(audit.outcome),
      bridge: stubBridgeHandlers(project)
    })).rejects.toThrow('不兼容')

    expect(Number(await fs.readFile(attempts, 'utf8'))).toBe(1)
    expect(audits).toEqual(['failure'])
  }, 30_000)

  it('does not invent a successful answer when the provider completes without text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-empty-response-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Empty Response', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'empty_response', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    await fs.writeFile(runner, "console.log(JSON.stringify({type:'turn.completed'}));process.exit(0)", 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    await expect(runExternalAgent({
      kind: 'codex', executable, project, prompt: '请回答', maxAttempts: 1,
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })).rejects.toMatchObject({name: 'ExternalAgentEmptyResponseError', message: expect.stringContaining('没有返回可显示的回答')})
  }, 30_000)

  it('does not promote a native retry notice when the provider reports completion', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-retry-as-answer-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Retry Notice', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'retry_notice', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    await fs.writeFile(runner, [
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'模型服务暂时不可用（429），8 秒后自动重试（第 2 次，最多 4 次）'}}))",
      "console.log(JSON.stringify({type:'turn.completed'}))",
      'process.exit(0)'
    ].join(';'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)

    await expect(runExternalAgent({
      kind: 'codex', executable, project, prompt: '请回答', maxAttempts: 1,
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })).rejects.toMatchObject({name: 'ExternalAgentEmptyResponseError'})
  }, 30_000)
})

describe('ModMind external agent MCP bridge', () => {
  async function fakeAppServer(root: string, waitForInterrupt = false): Promise<{ executable: string; log: string }> {
    const runner = path.join(root, 'fake-app-server.mjs')
    const log = path.join(root, 'app-server-requests.jsonl')
    await fs.writeFile(runner, [
      "import { appendFileSync, readFileSync } from 'node:fs'",
      "import { spawn } from 'node:child_process'",
      "const log = process.env.FAKE_APP_SERVER_LOG",
      "if (log) appendFileSync(log + '.args.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')",
      "let buffer = ''",
      "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk.toString('utf8')",
      "  const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || ''",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue",
      "    const request = JSON.parse(line); if (log) appendFileSync(log, JSON.stringify(request) + '\\n')",
      "    if (request.method === process.env.FAKE_REJECT_METHOD && request.params.threadId === 'broken-thread' && (!request.params.path || process.env.FAKE_REJECT_PATH)) { send({id:request.id,error:{code:-32600,message:process.env.FAKE_REJECT_MESSAGE}}); continue }",
      "    if (request.method === 'thread/start' && process.env.FAKE_START_ERROR) { send({id:request.id,error:{code:-32600,message:process.env.FAKE_START_ERROR}}); continue }",
      "    if (request.method === 'initialize') send({id:request.id,result:{userAgent:'fake'}})",
      "    else if (request.method === 'initialized') {}",
      "    else if (request.method === 'thread/start') send({id:request.id,result:{thread:{id:'thread-new'}}})",
      "    else if (request.method === 'thread/fork') send({id:request.id,result:{thread:{id:'thread-fork'}}})",
      "    else if (request.method === 'thread/resume') send({id:request.id,result:{thread:{id:request.params.threadId}}})",
      "    else if (request.method === 'turn/start') {",
      "      send({id:request.id,result:{turn:{id:'native-turn-new'}}}); send({method:'turn/started',params:{threadId:request.params.threadId,turn:{id:'native-turn-new'}}})",
      "      if (Number(process.env.FAKE_APPROVAL_FAILURES) >= readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse).filter(r=>r.method==='turn/start').length) send({method:'item/completed',params:{item:{type:'commandExecution',id:'failed-review',aggregatedOutput:'This action was rejected due to unacceptable risk.\\nReason: Automatic approval review failed: stream disconnected before completion'}}})",
      "      if (process.env.FAKE_TOOL_BRIDGE && request.params.model === 'A') { const cfg=JSON.parse(readFileSync(process.env.FAKE_TOOL_BRIDGE,'utf8')); void fetch('http://127.0.0.1:'+cfg.port+'/tool',{method:'POST',headers:{'x-modmind-token':cfg.token},body:JSON.stringify({action:'apply_edits',input:{edits:[]}})}).then(r=>r.text()).catch(()=>{}); }",
      "      if (process.env.FAKE_WAIT_MODEL && request.params.model === process.env.FAKE_WAIT_MODEL) continue",
      waitForInterrupt
        ? "    } else if (request.method === 'turn/interrupt') { send({id:request.id,result:{}}); send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:request.params.turnId,status:'interrupted',error:null}}}) }"
        : "      send({method:'item/agentMessage/delta',params:{threadId:request.params.threadId,turnId:'native-turn-new',itemId:'answer',delta:'完成'}}); send({method:'item/completed',params:{threadId:request.params.threadId,turnId:'native-turn-new',item:{type:'agentMessage',id:'answer',text:'完成'}}}); send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'native-turn-new',status:'completed',error:null}}}) }",
      "  }",
      "})",
      "process.stdin.on('end', () => { if (process.env.FAKE_KEEP_STDIO) spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit'}).unref(); process.exit(0) })"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-app-server.cmd') : runner
    if (process.platform === 'win32') await fs.writeFile(executable, `@echo off\r\nnode "%~dp0fake-app-server.mjs" %*\r\n`, 'utf8')
    else await fs.chmod(executable, 0o755)
    return { executable, log }
  }

  it('uses app-server start, streams one answer, and records the native turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-app-server-start-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'App Server', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'app_server', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const onOutput = vi.fn()
    const result = await runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'test',
      env: { FAKE_APP_SERVER_LOG: fake.log }, signal: new AbortController().signal,
      onOutput, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    expect(result).toMatchObject({ summary: '完成', sessionId: 'thread-new', nativeTurnId: 'native-turn-new' })
    const identity = { itemId: 'answer', streamId: 'thread-new:native-turn-new:answer' }
    expect(onOutput).toHaveBeenCalledWith('delta', '完成', identity)
    expect(onOutput).toHaveBeenCalledWith('response', '完成', identity)
    const requests = await fs.readFile(fake.log, 'utf8')
    expect(requests).toContain('"method":"thread/start"')
    expect(requests).toContain('"approvalsReviewer":"auto_review"')
    const turn = requests.trim().split('\n').map(line => JSON.parse(line)).find(request => request.method === 'turn/start')
    expect(turn.params.input[0].text).toContain(WORKBENCH_SKILL_POLICY)
  })

  it('overrides the model on a resumed native thread and on the actual turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-model-override-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Override', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'override', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    await runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'continue',
      sessionId: 'old-astra-thread', model: 'gpt-5.6-terra', modelProvider: 'thirdparty', reasoningEffort: 'high',
      providerConfig: { 'model_providers.thirdparty.base_url': 'http://127.0.0.1:1234/v1' },
      env: { FAKE_APP_SERVER_LOG: fake.log }, signal: new AbortController().signal,
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.find(r => r.method === 'thread/resume').params).toMatchObject({ threadId: 'old-astra-thread', model: 'gpt-5.6-terra', modelProvider: 'thirdparty' })
    expect(requests.find(r => r.method === 'turn/start').params).toMatchObject({ model: 'gpt-5.6-terra', effort: 'high' })
    expect(requests.find(r => r.method === 'turn/start').params.input[0].text).toContain(WORKBENCH_SKILL_POLICY)
  })

  it.each([
    ['thread/resume', 'no rollout found for thread id broken-thread'],
    ['thread/resume', 'session not found'],
    ['thread/resume', 'Invalid Responses API request'],
    ['thread/fork', 'no rollout found for thread id broken-thread'],
    ['turn/start', 'no rollout found for thread id broken-thread']
  ])('recovers a rejected native %s with the original task (%s)', async (method, message) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-native-missing-rollout-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Recovery', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'recovery', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const sessionFile = path.join(root, '.modmind', 'external-agents', 'session-codex.json')
    await fs.mkdir(path.dirname(sessionFile), { recursive: true })
    await fs.writeFile(sessionFile, JSON.stringify({ kind: 'codex', sessionId: 'broken-thread', projectPath: root }))
    const audits: string[] = []
    const sessions: string[] = []
    const result = await runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project,
      prompt: 'continue', fallbackPrompt: 'Original task: implement the new block; preserve completed changes.',
      resumeSession: true, retryDelayMs: 0, maxAttempts: 2,
      ...(method === 'thread/fork' ? { forkFrom: { sessionId: 'broken-thread', nativeMode: 'native' as const } } : {}),
      env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_REJECT_METHOD: method, FAKE_REJECT_MESSAGE: message },
      signal: new AbortController().signal, onSessionId: id => sessions.push(id),
      onAttemptAudit: audit => audits.push(audit.outcome),
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    expect(result).toMatchObject({ summary: '完成', sessionId: 'thread-new' })
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === method && r.params.threadId === 'broken-thread')).toHaveLength(1)
    expect(requests.filter(r => r.method === 'thread/start')).toHaveLength(1)
    const turn = requests.find(r => r.method === 'turn/start' && r.params.threadId === 'thread-new')
    expect(turn.params.input[0].text).toContain('Original task: implement the new block')
    expect(sessions.at(-1)).toBe('thread-new')
    expect(audits).toEqual(['retry', 'complete'])
    expect(JSON.parse(await fs.readFile(sessionFile, 'utf8')).sessionId).toBe('thread-new')
  })

  it.each(['missing', 'unrelated'])('handles a %s native resume failure without reusing or deleting the wrong session', async (failure) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-native-recovery-failure-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Recovery Failure', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'recovery_failure', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const sessionFile = path.join(root, '.modmind', 'external-agents', 'session-codex.json')
    await fs.mkdir(path.dirname(sessionFile), { recursive: true })
    await fs.writeFile(sessionFile, JSON.stringify({ kind: 'codex', sessionId: 'broken-thread', projectPath: root }))
    const message = failure === 'missing' ? 'no rollout found for thread id broken-thread' : 'permission denied while reading project'
    await expect(runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'original task',
      resumeSession: true, retryDelayMs: 0, maxAttempts: 3,
      env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_REJECT_METHOD: 'thread/resume', FAKE_REJECT_MESSAGE: message, FAKE_START_ERROR: 'permission denied while reading project' },
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })).rejects.toThrow('permission denied while reading project')
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === 'thread/resume')).toHaveLength(1)
    expect(requests.filter(r => r.method === 'thread/start')).toHaveLength(failure === 'missing' ? 1 : 0)
    if (failure === 'missing') await expect(fs.stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(JSON.parse(await fs.readFile(sessionFile, 'utf8')).sessionId).toBe('broken-thread')
  })

  it.each(['thread/resume', 'thread/fork'])('recovers original history by path after a missing %s index in a moved project', async (method) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-rollout-path-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Moved', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'moved', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const data = path.join(root, '.modmind', 'external-agents')
    const rollout = path.join(data, 'codex-homes', 'old-scope', 'old-provider', 'sessions', '2026', '09', '02', 'rollout-2026-09-02-broken-thread.jsonl')
    const history = `${JSON.stringify({ type: 'session_meta', payload: { id: 'broken-thread' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Original conversation' } })}\n`
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.writeFile(rollout, history)
    const sessionFile = path.join(data, 'session-codex.json')
    await fs.writeFile(sessionFile, JSON.stringify({ kind: 'codex', sessionId: 'broken-thread', projectPath: path.join(root, 'old-project-location') }))
    const result = await runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'continue',
      resumeSession: true, maxAttempts: 1, sessionHome: path.join(data, 'codex-homes', 'new-scope', 'quota'),
      ...(method === 'thread/fork' ? { forkFrom: { sessionId: 'broken-thread', lastTurnId: 'boundary-turn', nativeMode: 'native' as const } } : {}),
      env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_REJECT_METHOD: method, FAKE_REJECT_MESSAGE: 'failed to resolve rollout path: file does not exist (code -32600)' },
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    expect(result.sessionId).toBe(method === 'thread/fork' ? 'thread-fork' : 'broken-thread')
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === 'thread/start')).toHaveLength(0)
    const restores = requests.filter(r => r.method === method)
    expect(restores).toHaveLength(2)
    expect(restores[1].params).toMatchObject({ threadId: 'broken-thread', path: rollout, cwd: root, ...(method === 'thread/fork' ? { lastTurnId: 'boundary-turn' } : {}) })
    expect(await fs.readFile(rollout, 'utf8')).toBe(history)
    expect(JSON.parse(await fs.readFile(sessionFile, 'utf8'))).toMatchObject({ sessionId: result.sessionId, projectPath: root })
  })

  it.each(['start', 'resume', 'fork', 'read-only'] as const)('applies the selected policy to app-server %s and its launch arguments', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-approval-mode-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Approval', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'approval', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    await runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'continue', approvalMode: 'yolo',
      readOnly: mode === 'read-only',
      ...(mode === 'resume' ? { sessionId: 'existing-thread' } : {}),
      ...(mode === 'fork' ? { forkFrom: { sessionId: 'existing-thread', nativeMode: 'native' as const } } : {}),
      env: { FAKE_APP_SERVER_LOG: fake.log }, signal: new AbortController().signal,
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const method = mode === 'resume' ? 'thread/resume' : mode === 'fork' ? 'thread/fork' : 'thread/start'
    const sandbox = mode === 'read-only' ? 'read-only' : 'danger-full-access'
    expect(requests.find(r => r.method === method).params).toMatchObject({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox })
    const args = JSON.parse((await fs.readFile(fake.log + '.args.jsonl', 'utf8')).trim())
    expect(args.slice(0, 6)).toEqual(['-s', sandbox, '-a', 'never', '-c', 'approvals_reviewer="user"'])
  })

  it.each([1, 3])('bounds approval retries even with persistent retry enabled (%s failures)', async (failures) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-approval-retry-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Approval Retry', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'approval_retry', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const run = runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'continue', persistentRetry: true, retryDelayMs: 0,
      env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_APPROVAL_FAILURES: String(failures) }, signal: new AbortController().signal,
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    if (failures === 1) await expect(run).resolves.toMatchObject({ summary: '完成' })
    else await expect(run).rejects.toMatchObject({ name: 'AutomaticApprovalUnavailableError', message: expect.stringContaining('YOLO') })
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(failures === 1 ? 2 : 3)
    expect(requests.filter(r => r.method === 'thread/resume').every(r => r.params.approvalsReviewer === 'auto_review' && r.params.threadId === 'thread-new')).toBe(true)
  }, 15_000)

  it('finishes after CLI exit even when a descendant retains its output pipes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-cli-pipes-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Pipes', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'pipes', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const started = Date.now()
    const result = await runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'test',
      env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_KEEP_STDIO: '1' }, signal: new AbortController().signal,
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    expect(result.summary).toBe('完成')
    expect(Date.now() - started).toBeLessThan(3000)
  }, 6000)

  it('automatically resumes the same task using the latest model without a continue action', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-live-switch-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Switch', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'switch', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const live = new LiveConfiguration()
    let model = 'A'
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const output: string[] = []
    const run = runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'remember marker HS-47',
      liveConfiguration: live,
      refreshConfiguration: async () => ({ model, env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_WAIT_MODEL: 'A' } }),
      signal: new AbortController().signal, onStarted: started,
      onOutput: (kind, text) => output.push(`${kind}:${text}`), onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    await ready
    const b = live.begin()
    model = 'B'
    const c = live.begin()
    model = 'C'
    live.finish(b)
    live.finish(c)
    expect((await run).summary).toBe('完成')
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === 'turn/start').map(r => r.params.model)).toEqual(['A', 'C'])
    expect(requests.find(r => r.method === 'thread/resume').params.threadId).toBe('thread-new')
    expect(requests.filter(r => r.method === 'turn/start')[1].params.input[0].text).toContain('HS-47')
    expect(output.some(line => line.startsWith('error:'))).toBe(false)
  }, 15_000)

  it('does not restart a live task after the user cancels during a configuration change', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-live-cancel-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Cancel', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'cancel', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root, true)
    const live = new LiveConfiguration()
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const run = runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'test',
      liveConfiguration: live, refreshConfiguration: async () => ({ model: 'A', env: { FAKE_APP_SERVER_LOG: fake.log } }),
      signal: controller.signal, onStarted: started,
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await ready
    const next = live.begin()
    controller.abort()
    live.finish(next)
    await rejected
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1)
  }, 15_000)

  it('waits for an in-flight tool and carries its receipt into the automatic continuation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-live-tool-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'Tool Switch', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'tool_switch', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root)
    const live = new LiveConfiguration()
    let model = 'A'
    let toolStarted!: () => void
    const started = new Promise<void>(resolve => { toolStarted = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let writes = 0
    let configurations = 0
    const run = runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, runId: 'tool-test', prompt: 'Write once',
      liveConfiguration: live,
      refreshConfiguration: async () => {
        configurations++
        return { model, env: { FAKE_APP_SERVER_LOG: fake.log, FAKE_WAIT_MODEL: 'A', FAKE_TOOL_BRIDGE: path.join(root, '.modmind', 'external-agents', 'runs', 'tool-test', 'bridge.json') } }
      },
      signal: new AbortController().signal,
      onOutput: () => undefined, onProgress: () => undefined,
      bridge: { ...stubBridgeHandlers(project), applyEdits: async () => { toolStarted(); await gate; writes++; return { receipt: 'written-once-47' } } }
    })
    await started
    const revision = live.begin()
    model = 'B'
    live.finish(revision)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(configurations).toBe(1)
    expect(writes).toBe(0)
    release()
    await run
    expect(writes).toBe(1)
    const requests = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(requests.filter(r => r.method === 'turn/start')[1].params.input[0].text).toContain('written-once-47')
  }, 15_000)

  it('forks before the mapped native turn and interrupts without waiting for process death', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-app-server-interrupt-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = { name: 'App Server Interrupt', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'app_server_interrupt', createdAt: new Date().toISOString() }
    const fake = await fakeAppServer(root, true)
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const run = runExternalAgent({
      kind: 'codex', executable: fake.executable, forceCodexAppServer: true, project, prompt: 'test fork',
      forkFrom: { sessionId: 'thread-source', beforeTurnId: 'native-turn-old', nativeMode: 'native' },
      env: { FAKE_APP_SERVER_LOG: fake.log }, signal: controller.signal, onStarted: started,
      onOutput: () => undefined, onProgress: () => undefined, bridge: stubBridgeHandlers(project)
    })
    await ready
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    const requests = await fs.readFile(fake.log, 'utf8')
    expect(requests).toContain('"method":"thread/fork"')
    expect(requests).toContain('"beforeTurnId":"native-turn-old"')
    expect(requests).toContain('"method":"turn/interrupt"')
  })

  it('passes a per-run Codex reasoning effort without changing global configuration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-run-effort-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Run Effort', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'run_effort', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    const argsFile = path.join(root, 'args.json')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdin.resume(); process.stdin.on('end', () => {",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fast answer'}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));",
      "});"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)

    await runExternalAgent({
      kind: 'codex', executable, project, prompt: 'quick idea', reasoningEffort: 'low',
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })

    const args = JSON.parse(await fs.readFile(argsFile, 'utf8')) as string[]
    expect(args).toContain('model_reasoning_effort="low"')
  }, 20_000)

  it.each([
    {kind: 'codex' as const, mode: 'new'},
    {kind: 'codex' as const, mode: 'resumed'},
    {kind: 'codex' as const, mode: 'read-only'},
    {kind: 'claude' as const, mode: 'new'},
    {kind: 'claude' as const, mode: 'resumed'},
    {kind: 'claude' as const, mode: 'read-only'}
  ])('delivers skill routing to $kind $mode workspace turns without embedding skill bodies', async ({kind, mode}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-skill-routing-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Skill Routing', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'skill_routing', createdAt: new Date().toISOString()}
    const receivedFile = path.join(root, 'received.json')
    const skillsDirectory = path.join(root, '.modmind', 'external-agents', 'runs', 'routing-test', 'skills')
    const skillSource = path.join(root, 'bundled-skills')
    await fs.mkdir(path.join(skillSource, 'minecraft-build-repair'), {recursive: true})
    await fs.writeFile(path.join(skillSource, 'minecraft-build-repair', 'SKILL.md'), 'SKILL_BODY_MUST_STAY_ON_DISK', 'utf8')
    const runner = path.join(root, 'fake-agent.mjs')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      "const claude = process.argv.includes('--input-format');",
      "let input = ''; let done = false;",
      "function finish() { if (done) return; done = true;",
      "const prompt = claude ? JSON.parse(input.trim()).message.content : input;",
      `const skillBody = fs.readFileSync(${JSON.stringify(path.join(skillsDirectory, 'minecraft-build-repair', 'SKILL.md'))}, 'utf8');`,
      `fs.writeFileSync(${JSON.stringify(receivedFile)}, JSON.stringify({prompt, skillBody, args: process.argv.slice(2)}));`,
      "console.log(JSON.stringify(claude ? {type:'result',subtype:'success',is_error:false,result:'完成'} : {type:'item.completed',item:{type:'agent_message',text:'完成'}}));",
      "if (!claude) console.log(JSON.stringify({type:'turn.completed'}));",
      "process.exit(0); }",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; if (claude && input.includes('\\n')) finish(); });",
      "process.stdin.on('end', finish);"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? '@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n'
      : '#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n', 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    await runExternalAgent({
      kind, executable, project, prompt: '谢谢', runId: 'routing-test', workflowSourceDirectory: skillSource,
      ...(mode === 'resumed' ? {sessionId: 'existing-native-thread'} : {}),
      readOnly: mode === 'read-only',
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })
    const received = JSON.parse(await fs.readFile(receivedFile, 'utf8')) as {prompt: string; skillBody: string; args: string[]}
    expect(received.prompt).toContain('谢谢')
    expect(received.prompt).not.toContain('SKILL_BODY_MUST_STAY_ON_DISK')
    expect(received.skillBody).toBe('SKILL_BODY_MUST_STAY_ON_DISK')
    if (mode === 'read-only') {
      expect(received.prompt).not.toContain(WORKBENCH_SKILL_POLICY)
    } else {
      expect(received.prompt.split(WORKBENCH_SKILL_POLICY)).toHaveLength(2)
      expect(received.prompt).toContain(skillsDirectory.replaceAll('\\', '/'))
    }
    if (mode === 'resumed') expect(received.args).toContain('existing-native-thread')
  }, 20_000)

  it('keeps retry prompts to the single continuation instruction', () => {
    expect(externalAgentRetryPrompt()).toBe('继续')
    expect(externalAgentAttemptPrompt({prompt: '原始任务', fallbackPrompt: '备用任务'}, 1)).toEqual({prompt: '继续', retryOnly: true})
    expect(externalAgentAttemptPrompt({prompt: '原始任务', fallbackPrompt: '备用任务'}, 1, false)).toEqual({prompt: '备用任务'})
    expect(externalAgentAttemptPrompt({prompt: '原始任务', fallbackPrompt: '备用任务'}, 0)).toEqual({prompt: '备用任务'})
  })

  it('treats Claude API error messages and failed results as errors', () => {
    expect(parseExternalAgentOutputLine(JSON.stringify({
      type: 'assistant', is_error: true, message: {role: 'assistant', content: [{type: 'text', text: 'Failed to authenticate'}]}
    }), 'stdout')).toMatchObject({kind: 'error', agentMessage: false})
    expect(parseExternalAgentOutputLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, result: 'API Error: 403'
    }), 'stdout')).toMatchObject({kind: 'error', content: 'API Error: 403', agentMessage: false})
  })

  it('recognizes Codex terminal events without requiring a tool call', () => {
    expect(isExternalAgentCompletionEvent({ type: 'turn.completed' })).toBe(true)
    expect(isExternalAgentCompletionEvent({ type: 'event_msg', payload: { type: 'task_complete' } })).toBe(true)
    expect(isExternalAgentCompletionEvent({ type: 'item.completed' })).toBe(false)
  })

  it('detects backend rejections of a resumed conversation', () => {
    expect(isResumedPromptRejection({error: {code: 'invalid_prompt', message: 'Invalid Responses API request'}})).toBe(true)
    expect(isResumedPromptRejection({error: {message: 'Invalid Responses API request'}})).toBe(true)
    expect(isResumedPromptRejection({type: 'error', message: 'session not found'})).toBe(true)
    expect(isResumedPromptRejection({error: {message: 'no rollout found for thread id 01a08abe-5b20-7490-9a92-5ce3bacdd48f'}})).toBe(true)
    expect(isResumedPromptRejection({error: {message: 'local file not found'}})).toBe(false)
    expect(isResumedPromptRejection({type: 'error', message: '会话已过期'})).toBe(true)
    expect(isResumedPromptRejection({
      type: 'item.completed',
      item: {id: 'item_0', type: 'error', message: 'stream error: Invalid Responses API request; retries exhausted'}
    })).toBe(true)
    // A generic 400 is not enough evidence that the persisted session is bad.
    expect(isResumedPromptRejection({error: {code: 'invalid_request_error', message: '会话历史包含无法识别的条目'}})).toBe(true)
    expect(isResumedPromptRejection({type: 'error', message: '请求参数无效，请检查请求格式和参数'})).toBe(false)
    expect(isResumedPromptRejection({error: {code: 'rate_limited', message: 'slow down'}})).toBe(false)
    expect(isResumedPromptRejection({type: 'item.completed', item: {type: 'agent_message', text: 'hi'}})).toBe(false)
    expect(isResumedPromptRejection(null)).toBe(false)
  })

  it('audits terminal evidence before allowing a retry', () => {
    expect(auditExternalAgentCompletion({rawExitCode: 1, terminalEventSeen: true, noOutputTimedOut: true})).toMatchObject({complete: true, reason: 'terminal-event'})
    expect(auditExternalAgentCompletion({rawExitCode: 0, terminalEventSeen: false, noOutputTimedOut: false})).toMatchObject({complete: true, reason: 'clean-exit'})
    expect(auditExternalAgentCompletion({rawExitCode: 1, terminalEventSeen: false, noOutputTimedOut: true})).toMatchObject({complete: false, reason: 'no-output-timeout'})
    expect(auditExternalAgentCompletion({rawExitCode: 1, terminalEventSeen: false, noOutputTimedOut: false})).toMatchObject({complete: false, reason: 'process-error'})
  })

  it('uses each CLI\'s managed permission mode', () => {
    expect(nativePermissionArgs('codex')).toEqual(['-s', 'workspace-write', '-a', 'on-request', '-c', 'approvals_reviewer="auto_review"'])
    expect(nativePermissionArgs('claude')).toEqual(['--permission-mode', 'auto'])
    expect(nativePermissionArgs('codex', true)).toEqual(['-s', 'read-only', '-a', 'never', '-c', 'approvals_reviewer="user"'])
    expect(nativePermissionArgs('claude', true)).toEqual(['--permission-mode', 'plan', '--tools', 'Read', 'Glob', 'Grep'])
    expect(isReadOnlyActionDenied('apply_edits')).toBe(true)
    expect(isReadOnlyActionDenied('maven_dependency_install')).toBe(true)
    expect(isReadOnlyActionDenied('modpack_download_content')).toBe(true)
    expect(isReadOnlyActionDenied('asset_apply_refinement')).toBe(true)
    expect(isReadOnlyActionDenied('mapping_search')).toBe(false)
  })

  it('allows read-only network probes but identifies covered downloads', () => {
    const project: ProjectInfo = {name: 'Probe', path: 'C:\\Probe', loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'probe', createdAt: new Date().toISOString()}
    const url = 'https://repo1.maven.org/maven2/example/library/1.0/library-1.0.jar'
    expect(managedNativeDownloadAction(project, `Invoke-WebRequest -Uri '${url}' -Method Head`)).toBeUndefined()
    expect(managedNativeDownloadAction(project, `Invoke-WebRequest -Uri '${url}' -OutFile library.jar`)).toBe('maven_dependency_install')
    expect(managedNativeDownloadAction(project, "Invoke-WebRequest -Uri 'http://127.0.0.1:42485/tool' -Body '{\"javaHome\":\"C:/Program Files/Eclipse Adoptium/jdk-17\"}'")).toBeUndefined()
  })

  it('identifies native Gradle builds while allowing file inspection and status commands', () => {
    expect(isNativeGradleBuildCommand('.\\gradlew.bat build --no-daemon')).toBe(true)
    expect(isNativeGradleBuildCommand('.\\gradlew runClient')).toBe(true)
    expect(isNativeGradleBuildCommand('Get-Content build.gradle')).toBe(false)
    expect(isNativeGradleBuildCommand('.\\gradlew.bat --status')).toBe(false)
  })

  it('blocks forceful process termination commands from managed agents', () => {
    expect(isForcefulProcessTerminationCommand('Get-Process java | Stop-Process -Force')).toBe(true)
    expect(isForcefulProcessTerminationCommand('taskkill.exe /pid 123 /t /f')).toBe(true)
    expect(isForcefulProcessTerminationCommand("Remove-Item 'C:\\Users\\me\\.gradle\\daemon\\9.5.1\\registry.bin' -Force")).toBe(true)
    expect(isForcefulProcessTerminationCommand('Get-Process java')).toBe(false)
  })

  it('decodes Windows command errors emitted in the active GBK code page', () => {
    const gbk = Buffer.from('276e706d2e636d642720b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1eea3acd2b2b2bbcac7bfc9d4cbd0d0b5c4b3ccd0f2', 'hex')
    expect(decodeExternalProcessOutput(gbk, 'win32')).toBe("'npm.cmd' 不是内部或外部命令，也不是可运行的程序")
    expect(decodeExternalProcessOutput(Buffer.from('安装完成', 'utf8'), 'win32')).toBe('安装完成')
  })

  it('creates a visible Windows terminal for manually launched agents', () => {
    const launch = buildWindowsExternalAgentLaunch('codex', 'C:\\Projects\\Demo', 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'Read the context')
    expect(launch.args.slice(0, 4)).toEqual(['/d', '/c', 'start', '""'])
    expect(launch.args).toContain('powershell.exe')
    expect(launch.args).toContain('-NoExit')
    expect(launch.args).toContain('-EncodedCommand')
    const encoded = launch.args.at(-1) ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("Set-Location -LiteralPath 'C:\\Projects\\Demo'")
  })

  it('keeps uninstalled agents as explicit, non-ready entries', async () => {
    const status = await detectExternalAgent('claude')
    expect(status.kind).toBe('claude')
    expect(status.label).toBe('Claude Code')
    expect(typeof status.installed).toBe('boolean')
  })

  it('detects only the explicitly supplied managed Codex executable when requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-managed-codex-detect-'))
    temporaryRoots.push(root)
    const executable = process.platform === 'win32' ? path.join(root, 'codex.cmd') : path.join(root, 'codex')
    await fs.writeFile(executable, process.platform === 'win32'
      ? '@echo off\r\necho codex-cli 0.146.0\r\n'
      : '#!/bin/sh\necho codex-cli 0.146.0\n', 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)

    await expect(detectExternalAgent('codex', {executables: [executable], includeDefaults: false})).resolves.toMatchObject({
      installed: true,
      executable,
      version: 'codex-cli 0.146.0'
    })
  })

  it('does not install Codex latest through the generic package-manager path', async () => {
    await expect(installExternalAgent('codex')).rejects.toThrow('固定版本托管运行时')
  })

  it('opens Bilibili installation tutorials', () => {
    expect(externalAgentDocsUrl('codex')).toMatch(/^https:\/\/search\.bilibili\.com\//)
    expect(externalAgentDocsUrl('claude')).toMatch(/^https:\/\/search\.bilibili\.com\//)
  })

  it('refreshes a moved project context before manual agent launch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-context-move-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Moved Project', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'moved_project', createdAt: new Date().toISOString()
    }
    const context = path.join(root, '.modmind', 'external-agents', 'agent-context.md')
    await fs.mkdir(path.dirname(context), {recursive: true})
    await fs.writeFile(context, 'Project path: E:\\AAAMOD\\villagerwheretogo\n', 'utf8')
    await refreshExternalAgentContext(project)
    const content = await fs.readFile(context, 'utf8')
    expect(content).toContain(`Project path: ${root}`)
    expect(content).not.toContain('E:\\AAAMOD\\villagerwheretogo')
  })

  it('does not resume legacy external sessions without a project path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-session-move-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Moved Session', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'moved_session', createdAt: new Date().toISOString()
    }
    const sessions = path.join(root, '.modmind', 'external-agents')
    await fs.mkdir(sessions, {recursive: true})
    await fs.writeFile(path.join(sessions, 'session-codex.json'), JSON.stringify({kind: 'codex', sessionId: 'old-session', updatedAt: new Date().toISOString()}), 'utf8')
    await expect(readExternalAgentHistory(project, 'codex')).resolves.toBe('')
    await expect(fs.stat(path.join(sessions, 'session-codex.json'))).rejects.toThrow()
  })

  it('does not classify ordinary stderr output as an error', () => {
    expect(parseExternalAgentOutputLine('Loading project metadata', 'stderr')?.kind).toBe('tool')
    expect(parseExternalAgentOutputLine('warning: deprecated API', 'stderr')?.kind).toBe('warning')
    expect(parseExternalAgentOutputLine('{"type":"error","message":"403 Forbidden"}', 'stdout')?.kind).toBe('error')
    expect(parseExternalAgentOutputLine('{"type":"item.completed","item":{"type":"agent_message","text":"处理完成"}}', 'stdout')).toMatchObject({
      kind: 'response', content: '处理完成', agentMessage: true
    })
  })

  it('forwards Codex command execution events to the AI output timeline', () => {
    const started = parseExternalAgentOutputLine(JSON.stringify({
      type: 'item.started',
      item: {type: 'command_execution', command: 'Get-Content -Raw src/main.java', status: 'in_progress'}
    }), 'stdout')
    expect(started).toMatchObject({kind: 'tool', agentMessage: false})
    expect(started?.content).toContain('正在执行命令')
    expect(started?.content).toContain('Get-Content -Raw src/main.java')

    const completed = parseExternalAgentOutputLine(JSON.stringify({
      type: 'item.completed',
      item: {type: 'command_execution', command: 'Get-Content -Raw src/main.java', aggregated_output: 'class Example {}', exit_code: 0, status: 'completed'}
    }), 'stdout')
    expect(completed).toMatchObject({kind: 'tool', agentMessage: false})
    expect(completed?.content).toContain('命令已完成')
    expect(completed?.content).toContain('class Example {}')

    const failed = parseExternalAgentOutputLine(JSON.stringify({
      type: 'item.completed',
      item: {type: 'command_execution', command: 'gradlew.bat build', aggregated_output: 'BUILD FAILED', exit_code: 1, status: 'failed'}
    }), 'stdout')
    expect(failed).toMatchObject({kind: 'error', agentMessage: false})
  })

  it('recognizes the response_item events emitted by the hosted Codex CLI', () => {
    const commentary = parseExternalAgentOutputLine(JSON.stringify({
      type: 'response_item',
      payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: '我会先核对现有修改。'}]}
    }), 'stdout')
    expect(commentary).toMatchObject({kind: 'response', content: '我会先核对现有修改。', agentMessage: true})

    const call = parseExternalAgentOutputLine(JSON.stringify({
      type: 'response_item',
      payload: {type: 'custom_tool_call', name: 'exec', input: 'Get-Content src/main/java/Example.java'}
    }), 'stdout')
    expect(call).toMatchObject({kind: 'tool', agentMessage: false})
    expect(call?.content).toContain('exec')

    const output = parseExternalAgentOutputLine(JSON.stringify({
      type: 'response_item',
      payload: {type: 'custom_tool_call_output', output: [{type: 'input_text', text: 'Exit code: 0'}]}
    }), 'stdout')
    expect(output).toMatchObject({kind: 'tool', agentMessage: false})
    expect(output?.content).toContain('Exit code: 0')
  })

  it('recognizes generic text events and nested Codex agent messages as final replies', () => {
    expect(parseExternalAgentOutputLine('{"type":"text","part":{"type":"text","text":"完整回答"}}', 'stdout')).toMatchObject({
      kind: 'response', content: '完整回答', agentMessage: true
    })
    expect(parseExternalAgentOutputLine('{"type":"event_msg","payload":{"type":"agent_message","message":"Codex 的完整回答"}}', 'stdout')).toMatchObject({
      kind: 'response', content: 'Codex 的完整回答', agentMessage: true
    })
  })

  it('streams Claude partial messages and reads top-level result usage', () => {
    const partial = parseExternalAgentOutputLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '正在回答' } },
      session_id: 'claude-session'
    }), 'stdout')
    expect(partial).toMatchObject({ kind: 'response', content: '正在回答', agentMessage: true })
    expect(parseExternalAgentOutputLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' \n' } } }), 'stdout')?.content).toBe(' \n')
    expect(extractClaudeTokenUsage({ type: 'result', model: 'claude-sonnet-4', usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 5 } })).toEqual({ inputTokens: 10, cachedInputTokens: 3, outputTokens: 5, contextWindow: 200_000 })
  })

  it('reports backend readiness only after the Agent process really spawns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-agent-started-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Agent Started', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'agent_started', createdAt: new Date().toISOString()
    }
    const script = path.join(root, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex.sh')
    const lines = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}',
      '{"type":"turn.completed"}'
    ]
    await fs.writeFile(script, process.platform === 'win32'
      ? `@echo off\r\n${lines.map((line) => `echo ${line}`).join('\r\n')}\r\n`
      : `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line}'`).join('\n')}\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(script, 0o755)

    let started = 0
    await runExternalAgent({
      kind: 'codex', executable: script, project, prompt: 'start handshake',
      signal: new AbortController().signal,
      onStarted: () => { started += 1 },
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })
    expect(started).toBe(1)

    started = 0
    await expect(runExternalAgent({
      kind: 'codex', executable: path.join(root, 'missing-agent.exe'), project, prompt: 'must not start',
      signal: new AbortController().signal,
      onStarted: () => { started += 1 },
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })).rejects.toThrow()
    expect(started).toBe(0)

    const controller = new AbortController()
    const cancelledDuringSetup = runExternalAgent({
      kind: 'codex', executable: script, project, prompt: 'cancel before spawn',
      signal: controller.signal,
      onStarted: () => { started += 1 },
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })
    controller.abort()
    await expect(cancelledDuringSetup).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toBe(0)
  })

  it('confirms cancellation after terminating a running Agent process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-agent-cancel-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Agent Cancel', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'agent_cancel', createdAt: new Date().toISOString()
    }
    const runner = path.join(root, 'long-running-agent.mjs')
    await fs.writeFile(runner, "console.log(JSON.stringify({type:'thread.started',thread_id:'cancel-thread'}));setInterval(() => undefined, 1000);", 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'long-running-agent.cmd') : runner
    if (process.platform === 'win32') await fs.writeFile(executable, `@echo off\r\nnode "%~dp0long-running-agent.mjs" %*\r\n`, 'utf8')
    else await fs.chmod(executable, 0o755)
    const controller = new AbortController()
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const run = runExternalAgent({
      kind: 'codex', executable, project, prompt: 'wait for cancellation', persistentRetry: true,
      signal: controller.signal,
      onStarted: notifyStarted,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })
    await started
    const cancelledAt = Date.now()
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - cancelledAt).toBeLessThan(5_000)
  }, 10_000)

  it('persists a Codex thread id even when thread.started has no text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-session-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Codex Session', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'codex_session', createdAt: new Date().toISOString()
    }
    const script = path.join(root, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex.sh')
    const lines = [
      '{"type":"thread.started","thread_id":"thread-test"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
    ]
    const content = process.platform === 'win32'
      ? `@echo off\r\n${lines.map((line) => `echo ${line}`).join('\r\n')}\r\n`
      : `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line}'`).join('\n')}\n`
    await fs.writeFile(script, content, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(script, 0o755)

    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: {name: project.name},
      projectFiles: async () => ({files: ['README.md'], truncated: false}),
      setIntent: async () => ({}),
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

    const result = await runExternalAgent({
      kind: 'codex', executable: script, project, prompt: 'session test',
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: handlers
    })

    expect(result.sessionId).toBe('thread-test')
    await expect(fs.readFile(path.join(root, '.modmind', 'external-agents', 'session-codex.json'), 'utf8'))
      .resolves.toContain('thread-test')
  })

  it('treats a Codex completion event as success even when wrapper exit is non-zero', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-terminal-exit-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Codex Terminal Exit', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'codex_terminal_exit', createdAt: new Date().toISOString()
    }
    const script = path.join(root, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex.sh')
    const lines = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"完成答复"}}',
      '{"type":"turn.completed"}'
    ]
    const content = process.platform === 'win32'
      ? `@echo off\r\n${lines.map((line) => `echo ${line}`).join('\r\n')}\r\nexit /b 1\r\n`
      : `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line}'`).join('\n')}\nexit 1\n`
    await fs.writeFile(script, content, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(script, 0o755)
    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: {name: project.name},
      projectFiles: async () => ({files: [], truncated: false}),
      setIntent: async () => ({}),
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

    const result = await runExternalAgent({
      kind: 'codex', executable: script, project, prompt: 'terminal completion test',
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: handlers
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary).toContain('完成答复')
  })

  it('never retries after a terminal completion event, even when the wrapper hangs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-terminal-cutoff-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Terminal Cutoff', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'terminal_cutoff', createdAt: new Date().toISOString()
    }
    const script = path.join(root, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex.sh')
    const lines = [
      '{"type":"thread.started","thread_id":"thread-terminal-cutoff"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"final response"}}',
      '{"type":"turn.completed"}'
    ]
    const content = process.platform === 'win32'
      ? `@echo off\r\n${lines.map((line) => `echo ${line}`).join('\r\n')}\r\nping 127.0.0.1 -n 6 >nul\r\n`
      : `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line}'`).join('\n')}\nsleep 5\n`
    await fs.writeFile(script, content, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(script, 0o755)
    const outputs: Array<{kind: string; content: string}> = []
    const audits: Array<{outcome: string; reason?: string}> = []
    const started = Date.now()

    const result = await runExternalAgent({
      kind: 'codex', executable: script, project, prompt: 'finish and stop',
      signal: new AbortController().signal, noOutputTimeoutMs: 10_000, maxAttempts: 3,
      onOutput: (kind, message) => outputs.push({kind, content: message}),
      onProgress: () => undefined,
      onAttemptAudit: (audit) => audits.push({outcome: audit.outcome, reason: audit.completion?.reason}),
      bridge: stubBridgeHandlers(project)
    })

    expect(Date.now() - started).toBeLessThan(4_000)
    expect(result.summary).toBe('final response')
    expect(result.sessionId).toBe('thread-terminal-cutoff')
    expect(result.completionAudit.reason).toBe('terminal-event')
    expect(outputs.filter((output) => output.kind === 'retry')).toHaveLength(0)
    expect(audits).toEqual([{outcome: 'complete', reason: 'terminal-event'}])
    await expect(fs.readFile(path.join(root, '.modmind', 'external-agents', 'session-codex.json'), 'utf8'))
      .resolves.toContain('thread-terminal-cutoff')
  }, 20_000)

  it('forwards a final agent message only once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-final-output-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'Final Output', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'final_output', createdAt: new Date().toISOString()
    }
    const script = path.join(root, process.platform === 'win32' ? 'fake-agent.cmd' : 'fake-agent.sh')
    const line = '{"type":"text","part":{"type":"text","text":"final response"}}'
    await fs.writeFile(script, process.platform === 'win32' ? `@echo off\r\necho ${line}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${line}'\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(script, 0o755)
    const outputs: Array<{ kind: string; content: string }> = []
    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: { name: project.name },
      setIntent: async () => ({}),
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

    const result = await runExternalAgent({
      kind: 'codex', executable: script, project, prompt: '测试最终输出',
      signal: new AbortController().signal,
      onOutput: (kind, content) => outputs.push({ kind, content }),
      onProgress: () => undefined,
      bridge: handlers
    })

    expect(outputs.filter((output) => output.kind === 'delta' && output.content === 'final response')).toHaveLength(1)
    expect(result.summary).toBe('final response')
  })

  it('does not treat a silent but live Codex process as failed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-agent-no-output-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {
      name: 'No Output Retry', path: root, loader: 'fabric', minecraftVersion: '1.21.1',
      namespace: 'no_output_retry', createdAt: new Date().toISOString()
    }
    const runner = path.join(root, 'silent-agent.mjs')
    await fs.writeFile(runner, [
      "setTimeout(() => {",
      "  console.log(JSON.stringify({type:'thread.started', thread_id:'silent-thread'}));",
      "  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'finished after silence'}}));",
      "  console.log(JSON.stringify({type:'turn.completed'}));",
      "}, 150);"
    ].join('\n'), 'utf8')
    const script = process.platform === 'win32' ? path.join(root, 'silent-agent.cmd') : runner
    if (process.platform === 'win32') await fs.writeFile(script, `@echo off\r\nnode "%~dp0silent-agent.mjs" %*\r\n`, 'utf8')
    else await fs.chmod(script, 0o755)
    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: {name: project.name},
      setIntent: async () => ({}),
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

    const result = await runExternalAgent({
      kind: 'codex', executable: script, project, prompt: 'silent upstream test',
      signal: new AbortController().signal, noOutputTimeoutMs: 40, maxAttempts: 3,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: handlers
    })
    expect(result.summary).toBe('finished after silence')
    expect(result.sessionId).toBe('silent-thread')
  }, 20_000)

  it.each([
    {kind: 'codex' as const, sessionEvent: '{"type":"thread.started","thread_id":"native-session-test"}', successEvents: ['{"type":"item.completed","item":{"type":"agent_message","text":"resumed"}}', '{"type":"turn.completed"}']},
    {kind: 'claude' as const, sessionEvent: '{"type":"system","subtype":"init","session_id":"native-session-test"}', successEvents: ['{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"resumed"}]},"session_id":"native-session-test"}', '{"type":"result","subtype":"success","is_error":false,"result":"resumed","session_id":"native-session-test"}']}
  ])('does not restart the discovered $kind session after process failure', async ({kind, sessionEvent, successEvents}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `modmind-${kind}-retry-session-`))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Retry Session', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'retry_session', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    const attempts = path.join(root, 'attempts.jsonl')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `const attempts = ${JSON.stringify(attempts)};`,
      "const previous = fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).length : 0;",
      "fs.appendFileSync(attempts, JSON.stringify(process.argv.slice(2)) + '\\n');",
      `if (previous === 0) { console.log(${JSON.stringify(sessionEvent)}); process.exit(1); }`,
      "if (!process.argv.includes('native-session-test')) process.exit(2);",
      ...successEvents.map((event) => `console.log(${JSON.stringify(event)});`)
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    await expect(runExternalAgent({
      kind, executable, project, prompt: 'original request', maxAttempts: 2,
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })).rejects.toThrow()
    const calls = (await fs.readFile(attempts, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(1)
  })

  it.each(['stream error: Invalid Responses API request', 'no rollout found for thread id broken-thread'])('drops a rejected resumed Codex thread and restarts fresh (%s)', async (message) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-invalid-resume-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Invalid Resume', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'invalid_resume', createdAt: new Date().toISOString()}
    // Seed the persisted session the way a previous run would have.
    const sessionFile = path.join(root, '.modmind', 'external-agents', 'session-codex.json')
    await fs.mkdir(path.dirname(sessionFile), {recursive: true})
    await fs.writeFile(sessionFile, JSON.stringify({kind: 'codex', sessionId: 'broken-thread', projectPath: root, updatedAt: new Date().toISOString(), fingerprint: 'old-api-key-fingerprint'}), 'utf8')
    // Keep a representative rollout file inside an isolated CLI home; the
    // CLI, rather than ModMind's preflight, decides whether the thread works.
    const sessionHome = path.join(root, 'codex-home')
    const rollout = path.join(sessionHome, 'sessions', '2026', '08', '26', 'rollout-2026-08-26T10-00-00-broken-thread.jsonl')
    await fs.mkdir(path.dirname(rollout), {recursive: true})
    await fs.writeFile(rollout, `${JSON.stringify({type: 'event_msg', payload: {type: 'user_message', message: '原始任务：实现新方块'}})}\n`, 'utf8')
    const runner = path.join(root, 'fake-agent.mjs')
    const attempts = path.join(root, 'attempts.jsonl')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `const attempts = ${JSON.stringify(attempts)};`,
      "const args = process.argv.slice(2);",
      "let stdin = '';",
      "process.stdin.on('data', (chunk) => { stdin += chunk });",
      "process.stdin.on('end', () => {",
      "  fs.appendFileSync(attempts, JSON.stringify([...args, '--PROMPT--', stdin]) + '\\n');",
      "  if (args.includes('resume')) {",
      "    console.log(JSON.stringify({type:'thread.started', thread_id:'broken-thread'}));",
      `    console.log(JSON.stringify({type:'item.completed', item:{id:'item_0', type:'error', message:${JSON.stringify(message)}}}));`,
      "    process.exit(1);",
      "  }",
      "  console.log(JSON.stringify({type:'thread.started', thread_id:'fresh-thread'}));",
      "  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'restarted with original request'}}));",
      "  console.log(JSON.stringify({type:'turn.completed'}));",
      "});"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    const outputs: Array<{kind: string; content: string}> = []
    const audits: Array<{attempt: number; outcome: string}> = []

    const result = await runExternalAgent({
      kind: 'codex', executable, project,
      prompt: '继续', fallbackPrompt: '原始任务：实现新方块',
      resumeSession: true,
      sessionFingerprint: 'new-api-key-fingerprint',
      sessionHome,
      signal: new AbortController().signal,
      onOutput: (kind, content) => outputs.push({kind, content}),
      onProgress: () => undefined,
      onAttemptAudit: (audit) => audits.push({attempt: audit.attempt, outcome: audit.outcome}),
      bridge: stubBridgeHandlers(project)
    })

    expect(result.summary).toBe('restarted with original request')
    expect(result.sessionId).toBe('fresh-thread')
    const calls = (await fs.readFile(attempts, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('resume')
    expect(calls[1]).not.toContain('resume')
    // The recovery turn carries the original request, not a bare "continue".
    expect(calls[1].at(-1)).toContain('原始任务：实现新方块')
    expect(calls[0].at(-1)).not.toBe('继续')
    // The broken session file was replaced by the recovered thread's.
    await expect(fs.readFile(sessionFile, 'utf8')).resolves.toContain('fresh-thread')
    expect(audits).toEqual([
      {attempt: 1, outcome: 'retry'},
      {attempt: 2, outcome: 'complete'}
    ])
  })

  it('does not mask unrelated resume failures as session rejections', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-resume-other-error-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Resume Other Error', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'resume_other_error', createdAt: new Date().toISOString()}
    const runner = path.join(root, 'fake-agent.mjs')
    const attempts = path.join(root, 'attempts.jsonl')
    await fs.writeFile(runner, [
      "import fs from 'node:fs';",
      `const attempts = ${JSON.stringify(attempts)};`,
      "fs.appendFileSync(attempts, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "console.log(JSON.stringify({type:'thread.started', thread_id:'some-thread'}));",
      "console.log(JSON.stringify({type:'item.completed', item:{id:'item_0', type:'error', message:'upstream 429 Too Many Requests'}}));",
      "process.exit(1);"
    ].join('\n'), 'utf8')
    const executable = process.platform === 'win32' ? path.join(root, 'fake-agent.cmd') : path.join(root, 'fake-agent.sh')
    await fs.writeFile(executable, process.platform === 'win32'
      ? `@echo off\r\nnode "%~dp0fake-agent.mjs" %*\r\n`
      : `#!/bin/sh\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n`, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
    await expect(runExternalAgent({
      kind: 'codex', executable, project, prompt: '原始任务', fallbackPrompt: '备用任务',
      resumeSession: true, sessionId: 'some-session',
      signal: new AbortController().signal, onOutput: () => undefined, onProgress: () => undefined,
      bridge: stubBridgeHandlers(project)
    })).rejects.toThrow('退出码 1')
    const calls = (await fs.readFile(attempts, 'utf8')).trim().split(/\r?\n/)
    expect(calls).toHaveLength(1)
  })

  it('isolates concurrent run bridges and only removes its own directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-run-bridge-'))
    temporaryRoots.push(root)
    const project: ProjectInfo = {name: 'Run Bridge', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'run_bridge', createdAt: new Date().toISOString()}
    const first = new ModMindBridge(project, stubBridgeHandlers(project), 'test', undefined, false, 'run-a')
    const second = new ModMindBridge(project, stubBridgeHandlers(project), 'test', undefined, true, 'run-b')
    bridges.push(first, second)
    const firstPaths = await first.start()
    const secondPaths = await second.start()
    await first.writeMcpConfig(firstPaths.mcpConfigPath)
    await second.writeMcpConfig(secondPaths.mcpConfigPath)
    expect(firstPaths.mcpConfigPath).not.toBe(secondPaths.mcpConfigPath)
    const firstBridgeConfig = JSON.parse(await fs.readFile(path.join(path.dirname(firstPaths.mcpConfigPath), 'bridge.json'), 'utf8')) as {sourceFingerprint?: string}
    expect(firstBridgeConfig.sourceFingerprint).toBe(MODMIND_SOURCE_FINGERPRINT)
    expect(await fs.readFile(path.join(path.dirname(firstPaths.mcpConfigPath), 'bridge.json'), 'utf8')).not.toBe(await fs.readFile(path.join(path.dirname(secondPaths.mcpConfigPath), 'bridge.json'), 'utf8'))
    await first.stop()
    await expect(fs.stat(path.join(path.dirname(firstPaths.mcpConfigPath), 'bridge.json'))).rejects.toThrow()
    await expect(fs.stat(path.join(path.dirname(secondPaths.mcpConfigPath), 'bridge.json'))).resolves.toBeTruthy()
  })

  it('syncs workflows and routes optional Todo, edit, and mappings tools', async () => {
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
    let imagePrompt = ''
    let renamedProject = ''
    let mavenCoordinate = ''
    let downloadedContentUrl = ''
    let addonTarget = ''
    let compiledIntentName = ''
    let previewedIntentRevision = ''
    let appliedIntentRevision = ''
    let compiledRefinementName = ''
    let previewedRefinementRevision = ''
    let appliedRefinementRevision = ''
    const handlers: ExternalAgentBridgeHandlers = {
      projectInfo: {name: project.name},
      renameProject: async (name, namespace) => { renamedProject = `${name}:${namespace}`; return {name, namespace} },
      projectFiles: async () => ({files: ['README.md'], truncated: false}),
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
      mavenDependencyInstall: async (input) => { mavenCoordinate = String(input.coordinate ?? ''); return {coordinate: mavenCoordinate} },
      addonRelationships: async () => ({relationships: []}),
      addonPrepare: async (input) => { addonTarget = String(Array.isArray(input.required) ? input.required[0] ?? '' : ''); return {target: addonTarget} },
      addonImport: async () => ({}),
      addonLinkProject: async () => ({}),
      modpackDownloadContent: async (input) => { downloadedContentUrl = String(input.url ?? ''); return {url: downloadedContentUrl} },
      contentValidate: async () => ({}),
      testMatrix: async () => ({}),
      releasePreflight: async () => ({}),
      build: async () => ({}),
      testMinecraft: async () => ({}),
      blockbenchActions: async () => ({}),
      blockbenchProjectState: async () => ({revision: `sha256:${'b'.repeat(64)}`, counts: {cubes: 1}}),
      blockbenchValidate: async () => ({valid: true, findings: []}),
      blockbenchCaptureViews: async () => ({
        revision: `sha256:${'b'.repeat(64)}`,
        captures: [{view: 'north', width: 128, height: 128, dataUrl: 'data:image/png;base64,AA=='}]
      }),
      assetCompileIntent: async (input) => {
        compiledIntentName = String((input as {metadata?: {name?: unknown}}).metadata?.name ?? '')
        return {intentHash: 'candidate', actions: []}
      },
      assetPreviewIntent: async (input, _capture, expectedRevision) => {
        compiledIntentName = String((input as {metadata?: {name?: unknown}}).metadata?.name ?? '')
        previewedIntentRevision = expectedRevision ?? ''
        return {
          intentHash: 'preview', revision: `sha256:${'d'.repeat(64)}`,
          captures: [{view: 'north', width: 128, height: 128, dataUrl: 'data:image/png;base64,AA=='}]
        }
      },
      assetApplyIntent: async (input, expectedRevision) => {
        compiledIntentName = String((input as {metadata?: {name?: unknown}}).metadata?.name ?? '')
        appliedIntentRevision = expectedRevision ?? ''
        return {intentHash: 'applied'}
      },
      assetCompileRefinement: async (input) => {
        compiledRefinementName = String((input as {metadata?: {name?: unknown}}).metadata?.name ?? '')
        return {intentHash: 'refinement-candidate', actions: []}
      },
      assetPreviewRefinement: async (input, _capture, expectedRevision) => {
        compiledRefinementName = String((input as {metadata?: {name?: unknown}}).metadata?.name ?? '')
        previewedRefinementRevision = expectedRevision ?? ''
        return {
          intentHash: 'refinement-preview', revision: `sha256:${'f'.repeat(64)}`,
          captures: [{view: 'north', width: 128, height: 128, dataUrl: 'data:image/png;base64,AA=='}]
        }
      },
      assetApplyRefinement: async (input, expectedRevision) => {
        compiledRefinementName = String((input as {metadata?: {name?: unknown}}).metadata?.name ?? '')
        appliedRefinementRevision = expectedRevision ?? ''
        return {intentHash: 'refinement-applied'}
      },
      runtimeState: async () => ({}),
      imageGenerate: async (input) => {
        imagePrompt = String(input.prompt ?? '')
        return { assets: [{ path: '.modmind/image-studio/generated/example.png', dataUrl: 'data:image/png;base64,AA==', handoffAvailable: true }] }
      }
    }
    const workflowSource = path.join(root, 'bundled-workflows')
    await fs.mkdir(path.join(workflowSource, 'sample-workflow'), {recursive: true})
    await fs.writeFile(path.join(workflowSource, 'sample-workflow', 'SKILL.md'), '# Sample workflow\n')
    const bridge = new ModMindBridge(project, handlers, 'test', workflowSource)
    bridges.push(bridge)
    const {mcpConfigPath} = await bridge.start()
    await expect(fs.readFile(path.join(root, '.modmind', 'external-agents', 'skills', 'sample-workflow', 'SKILL.md'), 'utf8')).resolves.toContain('Sample workflow')
    await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')) as {mcpServers: {modmind: {command: string; args: string[]; env?: Record<string, string>}}}
    const child = spawn(config.mcpServers.modmind.command, config.mcpServers.modmind.args, {
      env: {...process.env, ...config.mcpServers.modmind.env}, stdio: ['pipe', 'pipe', 'pipe']
    })
    children.push(child)

    const listed = await rpc(child, {jsonrpc: '2.0', id: 1, method: 'tools/list'})
    const tools = (listed.result as {tools: Array<{name: string; annotations?: Record<string, boolean>; inputSchema?: Record<string, unknown>}>}).tools
    const toolNames = tools.map((tool) => tool.name)
    expect(toolNames).toContain('modmind_update_todo')
    expect(toolNames).toContain('modmind_project_files')
    expect(toolNames).toContain('modmind_rename_project')
    expect(toolNames).toContain('modmind_set_intent')
    expect(toolNames).toContain('modmind_apply_edits')
    expect(toolNames).toContain('modmind_mapping_search')
    expect(toolNames).toContain('modmind_dependency_search')
    expect(toolNames).toContain('modmind_dependency_install')
    expect(toolNames).toContain('modmind_maven_dependency_install')
    expect(toolNames).toContain('modmind_addon_relationships')
    expect(toolNames).toContain('modmind_addon_prepare')
    expect(toolNames).toContain('modmind_addon_import')
    expect(toolNames).toContain('modmind_addon_link_project')
    expect(toolNames).toContain('modmind_modpack_download_content')
    expect(toolNames).toContain('modmind_validate_content')
    expect(toolNames).toContain('modmind_image_generate')
    expect(toolNames).toContain('modmind_blockbench_project_state')
    expect(toolNames).toContain('modmind_blockbench_validate')
    expect(toolNames).toContain('modmind_blockbench_capture_views')
    expect(toolNames).toContain('modmind_asset_compile_intent')
    expect(toolNames).toContain('modmind_asset_preview_intent')
    expect(toolNames).toContain('modmind_asset_apply_intent')
    expect(toolNames).toContain('modmind_asset_compile_refinement')
    expect(toolNames).toContain('modmind_asset_preview_refinement')
    expect(toolNames).toContain('modmind_asset_apply_refinement')
    expect(tools.find((tool) => tool.name === 'modmind_blockbench_actions')?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {actions: {type: 'array', minItems: 1, maxItems: 500}}
    })
    const actionSchema = JSON.stringify(tools.find((tool) => tool.name === 'modmind_blockbench_actions')?.inputSchema)
    expect(actionSchema).toContain('update-cube')
    expect(actionSchema).toContain('update-group')
    expect(actionSchema).not.toContain('set-asset-metadata')
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
    const projectFiles = await rpc(child, {jsonrpc: '2.0', id: 10, method: 'tools/call', params: {name: 'modmind_project_files', arguments: {}}})
    await rpc(child, {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'modmind_mapping_search', arguments: {query: 'LivingEntity'}}})
    await rpc(child, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'modmind_update_todo', arguments: {tasks: [{id: 'T1', title: 'Inspect', status: 'in_progress'}]}}})
    await rpc(child, {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'modmind_apply_edits', arguments: {edits: [{path: 'src/main/java/Test.java', newText: 'class Test {}'}]}}})
    await rpc(child, {jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'modmind_image_generate', arguments: {prompt: 'crystal item texture'}}})
    await rpc(child, {jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'modmind_rename_project', arguments: {name: 'Renamed Project', namespace: 'renamed_project'}}})
    await rpc(child, {jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'modmind_maven_dependency_install', arguments: {coordinate: 'org.example:demo:1.0.0'}}})
    await rpc(child, {jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'modmind_modpack_download_content', arguments: {kind: 'config', url: 'https://example.test/config.zip'}}})
    await rpc(child, {jsonrpc: '2.0', id: 11, method: 'tools/call', params: {name: 'modmind_addon_prepare', arguments: {required: ['Create']}}})
    const blockbenchState = await rpc(child, {jsonrpc: '2.0', id: 12, method: 'tools/call', params: {name: 'modmind_blockbench_project_state', arguments: {}}})
    const blockbenchValidation = await rpc(child, {jsonrpc: '2.0', id: 13, method: 'tools/call', params: {name: 'modmind_blockbench_validate', arguments: {}}})
    const blockbenchCapture = await rpc(child, {jsonrpc: '2.0', id: 14, method: 'tools/call', params: {name: 'modmind_blockbench_capture_views', arguments: {views: ['north'], width: 128, height: 128}}})
    const sampleIntent = {version: 1, metadata: {name: 'Intent Test'}, model: {format: 'java_block', parts: [{id: 'body', kind: 'body', size: [8, 8, 8]}]}}
    await rpc(child, {jsonrpc: '2.0', id: 15, method: 'tools/call', params: {name: 'modmind_asset_compile_intent', arguments: sampleIntent}})
    const assetPreview = await rpc(child, {jsonrpc: '2.0', id: 17, method: 'tools/call', params: {name: 'modmind_asset_preview_intent', arguments: {intent: sampleIntent, capture: {views: ['north'], width: 128, height: 128}, expectedRevision: `sha256:${'e'.repeat(64)}`}}})
    await rpc(child, {jsonrpc: '2.0', id: 16, method: 'tools/call', params: {name: 'modmind_asset_apply_intent', arguments: {intent: sampleIntent, expectedRevision: `sha256:${'c'.repeat(64)}`}}})
    const sampleRefinement = {version: 1, metadata: {name: 'Refinement Test'}, parts: [{id: 'body', size: [7, 8, 8]}]}
    await rpc(child, {jsonrpc: '2.0', id: 18, method: 'tools/call', params: {name: 'modmind_asset_compile_refinement', arguments: sampleRefinement}})
    const refinementPreview = await rpc(child, {jsonrpc: '2.0', id: 19, method: 'tools/call', params: {name: 'modmind_asset_preview_refinement', arguments: {refinement: sampleRefinement, capture: {views: ['north'], width: 128, height: 128}, expectedRevision: `sha256:${'1'.repeat(64)}`}}})
    await rpc(child, {jsonrpc: '2.0', id: 20, method: 'tools/call', params: {name: 'modmind_asset_apply_refinement', arguments: {refinement: sampleRefinement, expectedRevision: `sha256:${'2'.repeat(64)}`}}})
    expect(classifiedIntent).toBe('informational')
    expect(projectFiles.result).toEqual({content: [{type: 'text', text: JSON.stringify({files: ['README.md'], truncated: false})}]})
    expect(mappingQuery).toBe('LivingEntity')
    expect(todoCount).toBe(1)
    expect(editPath).toBe('src/main/java/Test.java')
    expect(imagePrompt).toBe('crystal item texture')
    expect(renamedProject).toBe('Renamed Project:renamed_project')
    expect(mavenCoordinate).toBe('org.example:demo:1.0.0')
    expect(downloadedContentUrl).toBe('https://example.test/config.zip')
    expect(addonTarget).toBe('Create')
    expect(JSON.parse((blockbenchState.result as {content: Array<{text: string}>}).content[0].text)).toMatchObject({counts: {cubes: 1}})
    expect(JSON.parse((blockbenchValidation.result as {content: Array<{text: string}>}).content[0].text)).toMatchObject({valid: true})
    expect((blockbenchCapture.result as {content: Array<{type: string; data?: string}>}).content).toEqual([
      expect.objectContaining({type: 'text'}),
      expect.objectContaining({type: 'image', data: 'AA=='})
    ])
    expect(compiledIntentName).toBe('Intent Test')
    expect(previewedIntentRevision).toBe(`sha256:${'e'.repeat(64)}`)
    expect((assetPreview.result as {content: Array<{type: string; data?: string}>}).content).toEqual([
      expect.objectContaining({type: 'text'}),
      expect.objectContaining({type: 'image', data: 'AA=='})
    ])
    expect(appliedIntentRevision).toBe(`sha256:${'c'.repeat(64)}`)
    expect(compiledRefinementName).toBe('Refinement Test')
    expect(previewedRefinementRevision).toBe(`sha256:${'1'.repeat(64)}`)
    expect((refinementPreview.result as {content: Array<{type: string; data?: string}>}).content).toEqual([
      expect.objectContaining({type: 'text'}),
      expect.objectContaining({type: 'image', data: 'AA=='})
    ])
    expect(appliedRefinementRevision).toBe(`sha256:${'2'.repeat(64)}`)
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
      kind: 'codex', executable, project,
      prompt: '这是一个信息查询。请声明 informational 意图，然后只回复“审批回归成功”，不要读取文件',
      signal: new AbortController().signal,
      onOutput: () => undefined,
      onProgress: () => undefined,
      bridge: handlers
    })

    expect(classifiedIntent).toBe('informational')
    expect(result.transcript).not.toContain('user cancelled MCP tool call')
  }, 120_000)
})
