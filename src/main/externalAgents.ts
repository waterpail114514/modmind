import { existsSync, promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AiSettings, ProjectInfo } from '../shared/types'

export type ExternalAgentKind = 'codex' | 'claude' | 'opencode'

export interface ExternalAgentStatus {
  kind: ExternalAgentKind
  label: string
  installed: boolean
  executable: string
  version?: string
  detail: string
}

export interface ExternalAgentBridgeHandlers {
  projectInfo: Record<string, unknown>
  setIntent: (intent: 'engineering' | 'informational', reason: string) => Promise<unknown>
  applyEdits: (edits: unknown[]) => Promise<unknown>
  updateTodo: (tasks: unknown[]) => Promise<unknown>
  mappingsSearch: (query: string, limit?: number) => Promise<unknown>
  mappingsClass: (className: string, memberQuery?: string) => Promise<unknown>
  dependencySearch: (query: string, offset?: number) => Promise<unknown>
  dependencyInstall: (projectId: string, versionId?: string) => Promise<unknown>
  contentValidate: () => Promise<unknown>
  testMatrix: (targets: string[]) => Promise<unknown>
  releasePreflight: () => Promise<unknown>
  build: () => Promise<unknown>
  testMinecraft: () => Promise<unknown>
  blockbenchActions: (actions: unknown[]) => Promise<unknown>
  runtimeState: () => Promise<unknown>
}

export interface ExternalAgentRunOptions {
  kind: ExternalAgentKind
  appVersion?: string
  executable?: string
  project: ProjectInfo
  settings: AiSettings
  prompt: string
  signal: AbortSignal
  onSessionId?: (sessionId: string) => void
  onOutput: (kind: 'start' | 'delta' | 'tool' | 'response' | 'warning' | 'error', content: string) => void
  onProgress: (title: string, detail: string, status: 'running' | 'success' | 'warning' | 'error') => void
  bridge: ExternalAgentBridgeHandlers
}

export interface ExternalAgentRunResult {
  summary: string
  transcript: string
  buildUsed: boolean
  runtimeUsed: boolean
  exitCode: number | null
  sessionId?: string
}

interface PersistedExternalSession {
  kind: ExternalAgentKind
  sessionId: string
  updatedAt: string
}

export interface ParsedExternalAgentOutput {
  parsed: Record<string, unknown> | null
  kind: 'delta' | 'tool' | 'response' | 'warning' | 'error'
  content: string
  agentMessage: boolean
}

export function parseExternalAgentOutputLine(line: string, stream: 'stdout' | 'stderr'): ParsedExternalAgentOutput | null {
  if (!line.trim()) return null
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(line) as Record<string, unknown> } catch { /* External CLIs may emit plain text. */ }
  const item = parsed?.item as Record<string, unknown> | undefined
  const rawMessage = parsed?.message
  const message = rawMessage && typeof rawMessage === 'object' ? rawMessage as Record<string, unknown> : undefined
  const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data as Record<string, unknown> : undefined
  const part = data?.part && typeof data.part === 'object' ? data.part as Record<string, unknown> : undefined
  const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : []
  const contentText = content
    .filter((entry) => (entry.type === 'text' || entry.type === 'output_text') && typeof entry.text === 'string')
    .map((entry) => String(entry.text))
    .join('\n')
  const rawError = parsed?.error
  const errorText = typeof rawError === 'string'
    ? rawError
    : rawError && typeof rawError === 'object' && typeof (rawError as Record<string, unknown>).message === 'string'
      ? String((rawError as Record<string, unknown>).message)
      : ''
  const candidate = typeof item?.text === 'string' ? item.text
    : typeof part?.text === 'string' ? part.text
      : typeof parsed?.result === 'string' ? parsed.result
        : typeof parsed?.text === 'string' ? parsed.text
          : typeof rawMessage === 'string' ? rawMessage
            : typeof message?.content === 'string' ? message.content
              : contentText || errorText || (!parsed ? line : '')
  const normalized = candidate.trim()
  if (!normalized) return null
  const type = typeof parsed?.type === 'string' ? parsed.type.toLowerCase() : ''
  const agentMessage = item?.type === 'agent_message' || type === 'result' || type === 'assistant'
    || type === 'message.part' || type === 'message.completed' || type === 'session.idle'
  const structuredError = type === 'error' || type === 'turn.failed' || type === 'session.error' || parsed?.is_error === true || Boolean(rawError)
  const errorPattern = /(?:^|\b)(?:error|fatal|exception|failed|forbidden|unauthorized|timed out|timeout)(?:\b|:)/i
  const warningPattern = /(?:^|\b)(?:warning|warn|deprecated|deprecation)(?:\b|:)/i
  const kind = agentMessage ? 'response'
    : structuredError || (stream === 'stderr' && errorPattern.test(normalized)) ? 'error'
      : warningPattern.test(normalized) ? 'warning'
        : parsed || stream === 'stderr' ? 'tool' : 'delta'
  return {parsed, kind, content: normalized.slice(0, 12_000), agentMessage}
}

const EXTERNAL_AGENT_DOCS: Record<ExternalAgentKind, string> = {
  codex: 'https://search.bilibili.com/all?keyword=Codex%20CLI%20%E5%AE%89%E8%A3%85%E6%95%99%E7%A8%8B',
  claude: 'https://search.bilibili.com/all?keyword=Claude%20Code%20%E5%AE%89%E8%A3%85%E6%95%99%E7%A8%8B',
  opencode: 'https://search.bilibili.com/all?keyword=opencode%20CLI%20%E5%AE%89%E8%A3%85%E6%95%99%E7%A8%8B'
}

const EXTERNAL_AGENT_PACKAGES: Record<ExternalAgentKind, {winget?: string; npm: string}> = {
  codex: {winget: 'OpenAI.Codex', npm: '@openai/codex@latest'},
  claude: {winget: 'Anthropic.ClaudeCode', npm: '@anthropic-ai/claude-code@latest'},
  opencode: {npm: 'opencode-ai@latest'}
}

export function externalAgentLabel(kind: ExternalAgentKind): string {
  switch (kind) {
    case 'codex': return 'Codex'
    case 'claude': return 'Claude Code'
    case 'opencode': return 'opencode'
  }
}

const MCP_SERVER = String.raw`import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const config = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'bridge.json'), 'utf8'));
const endpoint = 'http://127.0.0.1:' + config.port + '/tool';

const readOnlyLocal = {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false};
const readOnlyRemote = {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:true};
const safeStateChange = {readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false};
const managedAction = {readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true};

async function callTool(action, input) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-modmind-token': config.token},
    body: JSON.stringify({action, input: input || {}})
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body || ('ModMind tool failed: ' + response.status));
  return JSON.parse(body);
}

const tools = [
  {name:'modmind_project_info', description:'Read the active ModMind project metadata and integration rules.', inputSchema:{type:'object',properties:{}}, annotations:readOnlyLocal},
  {name:'modmind_set_intent', description:'Required first ModMind call. Classify the user request before inspecting or changing the project. Use engineering only when the user explicitly requests project changes; use informational for greetings, questions, explanations, reviews, audits, or status checks that do not request changes.', inputSchema:{type:'object',properties:{intent:{type:'string',enum:['engineering','informational']},reason:{type:'string'}},required:['intent','reason']}, annotations:safeStateChange},
  {name:'modmind_apply_edits', description:'Apply 1-8 exact text edits inside the active project through ModMind. Use this for source changes on Windows instead of native apply_patch. Paths are project-relative. For an existing file, oldText must match exactly once. To create a new file, omit oldText or pass an empty string.', inputSchema:{type:'object',properties:{edits:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{path:{type:'string'},purpose:{type:'string'},oldText:{type:'string'},newText:{type:'string'}},required:['path','newText']}}},required:['edits']}, annotations:managedAction},
  {name:'modmind_update_todo', description:'Publish the complete task list to ModMind. Call after inspection, whenever statuses change, and before building. Existing tasks cannot be removed and statuses cannot move backward. Multiple tasks may be in progress.', inputSchema:{type:'object',properties:{tasks:{type:'array',minItems:1,maxItems:30,items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},status:{type:'string',enum:['pending','in_progress','completed']}},required:['id','title','status']}}},required:['tasks']}, annotations:safeStateChange},
  {name:'modmind_mapping_search', description:'Search mappings.dev for the active Minecraft version.', inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'number'}},required:['query']}, annotations:readOnlyRemote},
  {name:'modmind_mapping_class', description:'Inspect an exact mapped Minecraft class and optional member query.', inputSchema:{type:'object',properties:{className:{type:'string'},memberQuery:{type:'string'}},required:['className']}, annotations:readOnlyRemote},
  {name:'modmind_dependency_search', description:'Search Modrinth for projects compatible with the active Loader and Minecraft version.', inputSchema:{type:'object',properties:{query:{type:'string'},offset:{type:'number'}},required:['query']}, annotations:readOnlyRemote},
  {name:'modmind_dependency_install', description:'Install a compatible Modrinth dependency through the managed Gradle and test-instance integration.', inputSchema:{type:'object',properties:{projectId:{type:'string'},versionId:{type:'string'}},required:['projectId']}, annotations:managedAction},
  {name:'modmind_validate_content', description:'Validate project JSON, OGG headers, and sound references without changing files.', inputSchema:{type:'object',properties:{}}, annotations:readOnlyLocal},
  {name:'modmind_test_matrix', description:'Run selected managed build, client, server, or GameTest targets.', inputSchema:{type:'object',properties:{targets:{type:'array',items:{type:'string',enum:['build','client','server','gametest']}}},required:['targets']}, annotations:managedAction},
  {name:'modmind_release_preflight', description:'Inspect release artifact, metadata, license, version, and changelog readiness. This tool cannot publish.', inputSchema:{type:'object',properties:{}}, annotations:readOnlyLocal},
  {name:'modmind_build_project', description:'Run the ModMind-managed Gradle build. Use only after all Todo work is complete.', inputSchema:{type:'object',properties:{}}, annotations:managedAction},
  {name:'modmind_test_minecraft', description:'Build and launch the isolated ModMind Minecraft test instance, then return startup/crash evidence.', inputSchema:{type:'object',properties:{}}, annotations:managedAction},
  {name:'modmind_blockbench_actions', description:'Execute validated Blockbench actions through the embedded ModMind bridge.', inputSchema:{type:'object',properties:{actions:{type:'array'}},required:['actions']}, annotations:managedAction},
  {name:'modmind_runtime_state', description:'Read the current isolated Minecraft test runtime state and recent events.', inputSchema:{type:'object',properties:{}}, annotations:readOnlyLocal}
];

function result(id, value) { return {jsonrpc:'2.0',id,result:value}; }
function error(id, code, message) { return {jsonrpc:'2.0',id,error:{code,message}}; }

const input = readline.createInterface({input:process.stdin, crlfDelay:Infinity});
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'notifications/initialized' || request.method?.startsWith('notifications/')) return;
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify(result(request.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'modmind',version:config.version || 'development'}}))+'\n');
    return;
  }
  if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify(result(request.id,{tools}))+'\n');
    return;
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name || '';
    const args = request.params?.arguments || {};
    const actions = {
      modmind_project_info: 'project_info',
      modmind_set_intent: 'set_intent',
      modmind_apply_edits: 'apply_edits',
      modmind_update_todo: 'update_todo',
      modmind_mapping_search: 'mappings_search',
      modmind_mapping_class: 'mappings_class',
      modmind_dependency_search: 'dependency_search',
      modmind_dependency_install: 'dependency_install',
      modmind_validate_content: 'content_validate',
      modmind_test_matrix: 'test_matrix',
      modmind_release_preflight: 'release_preflight',
      modmind_build_project: 'build_project',
      modmind_test_minecraft: 'test_minecraft',
      modmind_blockbench_actions: 'blockbench_actions',
      modmind_runtime_state: 'runtime_state'
    };
    const action = actions[name];
    if (!action) {
      process.stdout.write(JSON.stringify(error(request.id,-32601,'Unknown ModMind tool'))+'\n');
      return;
    }
    try {
      const value = await callTool(action, args);
      process.stdout.write(JSON.stringify(result(request.id,{content:[{type:'text',text:JSON.stringify(value)}]}))+'\n');
    } catch (e) {
      process.stdout.write(JSON.stringify(result(request.id,{isError:true,content:[{type:'text',text:String(e?.message || e)}]}))+'\n');
    }
    return;
  }
  process.stdout.write(JSON.stringify(error(request.id,-32601,'Unsupported MCP method'))+'\n');
});
`

function executableCandidates(kind: ExternalAgentKind): string[] {
  const name = kind
  const home = os.homedir()
  const roamingNpm = path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm')
  const wingetLinks = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')
  return process.platform === 'win32'
    ? [...new Set([
        path.join(roamingNpm, `${name}.cmd`),
        path.join(roamingNpm, `${name}.ps1`),
        path.join(wingetLinks, `${name}.exe`),
        `${name}.exe`,
        `${name}.cmd`
      ])]
    : [name, path.join(home, '.local', 'bin', name), path.join(home, '.npm-global', 'bin', name)]
}

function spawnManagedCli(executable: string, args: string[], cwd: string, env?: Record<string, string>): ChildProcessWithoutNullStreams {
  const spawnEnv = env ? {...process.env, ...env} : process.env
  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.ps1')) {
    const commandShim = executable.slice(0, -4) + '.cmd'
    if (existsSync(commandShim)) return spawnManagedCli(commandShim, args, cwd, env)
    return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args], {
      cwd, env: spawnEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
  }
  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd')) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', executable, ...args], {
      cwd, env: spawnEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
  }
  return spawn(executable, args, {cwd, env: spawnEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
}

function mcpRuntime(): {command: string; env?: Record<string, string>} {
  if (process.env.MODMIND_NODE) return {command: process.env.MODMIND_NODE}
  if (process.versions.electron) return {command: process.execPath, env: {ELECTRON_RUN_AS_NODE: '1'}}
  return {command: process.execPath}
}

async function commandVersion(executable: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawnManagedCli(executable, ['--version'], process.cwd())
    child.stdin.end()
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? output.trim().split(/\r?\n/)[0] : undefined))
    setTimeout(() => { child.kill(); resolve(undefined) }, 6_000).unref()
  })
}

async function readPersistedSession(project: ProjectInfo, kind: ExternalAgentKind): Promise<string | undefined> {
  const file = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents', `session-${kind}.json`)
  const value = await fs.readFile(file, 'utf8').then((text) => JSON.parse(text) as PersistedExternalSession).catch(() => null)
  return value?.kind === kind && typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId.trim() : undefined
}

export async function readExternalAgentHistory(project: ProjectInfo, kind: ExternalAgentKind): Promise<string> {
  const sessionId = await readPersistedSession(project, kind)
  return sessionId ? readExternalSessionHistory(kind, sessionId) : ''
}

async function persistSession(project: ProjectInfo, kind: ExternalAgentKind, sessionId: string): Promise<void> {
  const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents')
  await fs.mkdir(directory, {recursive: true})
  await fs.writeFile(path.join(directory, `session-${kind}.json`), JSON.stringify({kind, sessionId, updatedAt: new Date().toISOString()} satisfies PersistedExternalSession, null, 2), 'utf8')
}

type ExternalHistoryEntry = {role: 'user' | 'assistant'; text: string}

function textFromHistoryValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value.map((entry) => {
    if (typeof entry === 'string') return entry
    if (!entry || typeof entry !== 'object') return ''
    const item = entry as Record<string, unknown>
    return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
  }).filter(Boolean).join('\n').trim()
}

async function locateSessionFile(kind: ExternalAgentKind, sessionId: string): Promise<string | undefined> {
  if (kind === 'opencode') {
    const root = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage')
    const pending: Array<{directory: string; depth: number}> = [{directory: root, depth: 0}]
    let visited = 0
    while (pending.length && visited < 2_000) {
      const current = pending.shift()
      if (!current) break
      const entries = await fs.readdir(current.directory, {withFileTypes: true}).catch(() => [])
      for (const entry of entries) {
        visited += 1
        const fullPath = path.join(current.directory, entry.name)
        if (entry.isDirectory() && current.depth < 8) {
          pending.push({directory: fullPath, depth: current.depth + 1})
          continue
        }
        if (entry.isFile() && entry.name.endsWith('.json') && entry.name.includes(sessionId)) return fullPath
      }
    }
    return undefined
  }
  const root = path.join(os.homedir(), kind === 'codex' ? '.codex' : '.claude', kind === 'codex' ? 'sessions' : 'projects')
  const pending: Array<{directory: string; depth: number}> = [{directory: root, depth: 0}]
  let visited = 0
  while (pending.length && visited < 2_000) {
    const current = pending.shift()
    if (!current) break
    const entries = await fs.readdir(current.directory, {withFileTypes: true}).catch(() => [])
    for (const entry of entries) {
      visited += 1
      const fullPath = path.join(current.directory, entry.name)
      if (entry.isDirectory() && current.depth < 8) {
        pending.push({directory: fullPath, depth: current.depth + 1})
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) return fullPath
    }
  }
  return undefined
}

async function readExternalSessionHistory(kind: ExternalAgentKind, sessionId: string): Promise<string> {
  if (kind === 'opencode') return ''
  const file = await locateSessionFile(kind, sessionId)
  if (!file) return ''
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  if (!raw) return ''
  const entries: ExternalHistoryEntry[] = []
  const push = (role: ExternalHistoryEntry['role'], value: unknown): void => {
    let text = textFromHistoryValue(value)
    if (!text) return
    const systemMarker = '\nAlways write user-facing responses'
    const markerIndex = text.indexOf(systemMarker)
    if (role === 'user' && markerIndex >= 0) text = text.slice(0, markerIndex).trim()
    if (!text || entries.at(-1)?.role === role && entries.at(-1)?.text === text) return
    entries.push({role, text})
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try { record = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (kind === 'codex') {
      if (record.type !== 'event_msg') continue
      const payload = record.payload as Record<string, unknown> | undefined
      if (payload?.type === 'user_message') push('user', payload.message)
      if (payload?.type === 'agent_message') push('assistant', payload.message)
      continue
    }
    if (record.type === 'user') {
      const message = record.message as Record<string, unknown> | undefined
      push('user', message?.content)
    } else if (record.type === 'assistant') {
      const message = record.message as Record<string, unknown> | undefined
      push('assistant', message?.content)
    }
  }
  if (!entries.length) return ''
  const speaker = externalAgentLabel(kind)
  return entries.map((entry) => `${entry.role === 'user' ? '用户' : speaker}：\n${entry.text}`).join('\n\n')
}

export async function detectExternalAgents(): Promise<ExternalAgentStatus[]> {
  const result: ExternalAgentStatus[] = []
  for (const kind of ['codex', 'claude', 'opencode'] as const) {
    let found = ''
    let version: string | undefined
    for (const candidate of executableCandidates(kind)) {
      version = await commandVersion(candidate)
      if (version) { found = candidate; break }
    }
    result.push({
      kind,
      label: externalAgentLabel(kind),
      installed: Boolean(version),
      executable: found,
      version,
      detail: version ?? '未检测到命令行工具'
    })
  }
  return result
}

export function externalAgentDocsUrl(kind: ExternalAgentKind): string {
  return EXTERNAL_AGENT_DOCS[kind]
}

async function runInstaller(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = command.toLowerCase().endsWith('.cmd')
      ? spawnManagedCli(command, args, process.cwd())
      : spawn(command, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''
    const collect = (chunk: Buffer): void => {
      if (output.length < 120_000) output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'})
      else child.kill('SIGTERM')
      reject(new Error('安装超过 10 分钟，已停止安装进程'))
    }, 10 * 60_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const detail = output.trim().slice(-8_000)
      if (code === 0) resolve(detail)
      else reject(new Error(detail || `安装程序退出码 ${code}`))
    })
  })
}

export async function installExternalAgent(kind: ExternalAgentKind): Promise<ExternalAgentStatus> {
  const existing = (await detectExternalAgents()).find((item) => item.kind === kind)
  if (existing?.installed) return existing
  const packageInfo = EXTERNAL_AGENT_PACKAGES[kind]
  let wingetError = ''
  if (process.platform === 'win32' && packageInfo.winget) {
    try {
      await runInstaller('winget.exe', [
        'install', '--id', packageInfo.winget, '--exact', '--silent', '--disable-interactivity',
        '--accept-source-agreements', '--accept-package-agreements'
      ])
    } catch (error) {
      wingetError = error instanceof Error ? error.message : String(error)
    }
  }
  let status = (await detectExternalAgents()).find((item) => item.kind === kind)
  if (!status?.installed) {
    try {
      await runInstaller(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', packageInfo.npm])
    } catch (error) {
      const npmError = error instanceof Error ? error.message : String(error)
      throw new Error(`一键安装失败。${wingetError ? `WinGet：${wingetError}\n` : ''}npm：${npmError}`)
    }
    status = (await detectExternalAgents()).find((item) => item.kind === kind)
  }
  if (!status?.installed) throw new Error('安装程序已完成，但当前进程尚未检测到 CLI。请重启 ModMind 后重新检测。')
  return status
}

export async function launchExternalAgent(kind: ExternalAgentKind, projectPath: string, executable?: string): Promise<void> {
  const command = executable || (await detectExternalAgents()).find((item) => item.kind === kind)?.executable
  if (!command) throw new Error(`${externalAgentLabel(kind)} CLI 未安装或不在 PATH 中`)
  const prompt = kind === 'codex'
    ? 'You are in the ModMind project workspace. Read .modmind/external-agents/agent-context.md first and use the ModMind MCP tools when available.'
    : 'Read .modmind/external-agents/agent-context.md first. Use the ModMind MCP tools for mappings, builds, tests, and Blockbench.'
  if (kind === 'opencode') {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const script = `Set-Location -LiteralPath ${quote(projectPath)}; $env:OPENCODE_CONFIG = ${quote(path.join(projectPath, '.modmind', 'external-agents', 'opencode-config.json'))}; & ${quote(command)}`
    const child = spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', process.platform === 'win32' ? ['-NoExit', '-Command', script] : ['-c', script], {cwd: projectPath, detached: true, stdio: 'ignore', windowsHide: false})
    child.unref()
    return
  }
  if (process.platform === 'win32') {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const argumentsText = kind === 'codex'
      ? `-C ${quote(projectPath)} --skip-git-repo-check ${quote(prompt)}`
      : `--add-dir ${quote(projectPath)} ${quote(prompt)}`
    const script = `Set-Location -LiteralPath ${quote(projectPath)}; & ${quote(command)} ${argumentsText}`
    const child = spawn('powershell.exe', ['-NoExit', '-Command', script], {cwd: projectPath, detached: true, stdio: 'ignore', windowsHide: false})
    child.unref()
    return
  }
  const args = kind === 'codex' ? ['-C', projectPath, '--skip-git-repo-check', prompt] : ['--add-dir', projectPath, prompt]
  const child = spawn(command, args, {cwd: projectPath, detached: true, stdio: 'ignore', windowsHide: false})
  child.unref()
}

export class ModMindBridge {
  private server: http.Server | null = null
  private port = 0
  private readonly token = randomUUID()
  private readonly directory: string

  constructor(private readonly project: ProjectInfo, private readonly handlers: ExternalAgentBridgeHandlers, private readonly appVersion = 'development') {
    this.directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'external-agents')
  }

  async start(): Promise<{mcpConfigPath: string; contextPath: string}> {
    await fs.mkdir(this.directory, {recursive: true})
    this.server = http.createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动 ModMind 外部代理桥接服务')
    this.port = address.port
    const bridgePath = path.join(this.directory, 'bridge.json')
    await fs.writeFile(bridgePath, JSON.stringify({port: this.port, token: this.token, version: this.appVersion}, null, 2), 'utf8')
    const mcpPath = path.join(this.directory, 'modmind-mcp-server.mjs')
    await fs.writeFile(mcpPath, MCP_SERVER, 'utf8')
    const contextPath = path.join(this.directory, 'agent-context.md')
    await fs.writeFile(contextPath, this.contextText(), 'utf8')
    return {mcpConfigPath: path.join(this.directory, 'mcp-config.json'), contextPath}
  }

  async writeMcpConfig(target: string): Promise<void> {
    const runtime = mcpRuntime()
    await fs.writeFile(target, JSON.stringify({mcpServers: {
      modmind: {command: runtime.command, args: [path.join(this.directory, 'modmind-mcp-server.mjs')], ...(runtime.env ? {env: runtime.env} : {})}
    }}, null, 2), 'utf8')
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(path.join(this.directory, 'bridge.json'), {force: true}).catch(() => undefined)
  }

  private contextText(): string {
    return `# ModMind External Agent Context\n\nActive project: ${this.project.name}\nProject path: ${this.project.path}\nLoader: ${this.project.loader}\nMinecraft: ${this.project.minecraftVersion}\nNamespace: ${this.project.namespace}\n\nModMind is the orchestrator. First classify the request with modmind_set_intent. Use engineering only for an explicit request to change the project. Greetings, questions, explanations, reviews, audits, and status checks without a requested change are informational: answer them without Todo, edits, build, or test. For engineering work, preserve existing files and use ModMind for source edits, Todo tracking, mappings, dependencies, content validation, test matrices, release preflight, builds, Minecraft tests, runtime state, and Blockbench. Inspect before editing, then publish a concrete Todo list with modmind_update_todo. On Windows, make source changes with modmind_apply_edits; do not use native apply_patch, junctions, subst drives, or absolute paths. Keep every task and its status current; several tasks may be in progress, but completed tasks cannot move backward or be removed. Do not modify .modmind or generated build directories. Complete all Todo work before building. Never claim engineering success without a successful ModMind build and, when behavior changed, a Minecraft smoke test. External agents can run release preflight but cannot publish.\n\nThe MCP tools are authoritative integration points:\n- modmind_set_intent (required first call)\n- modmind_apply_edits\n- modmind_update_todo\n- modmind_mapping_search / modmind_mapping_class\n- modmind_dependency_search / modmind_dependency_install\n- modmind_validate_content / modmind_test_matrix\n- modmind_release_preflight (preflight only; publishing is never exposed)\n- modmind_build_project (only after every Todo is complete)\n- modmind_test_minecraft\n- modmind_blockbench_actions\n- modmind_runtime_state\n`
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/tool' || request.headers['x-modmind-token'] !== this.token) {
      response.writeHead(404); response.end('Not found'); return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {action?: string; input?: Record<string, unknown>}
      const input = body.input ?? {}
      let value: unknown
      switch (body.action) {
        case 'project_info': value = this.handlers.projectInfo; break
        case 'set_intent': value = await this.handlers.setIntent(input.intent === 'engineering' ? 'engineering' : 'informational', String(input.reason ?? '')); break
        case 'apply_edits': value = await this.handlers.applyEdits(Array.isArray(input.edits) ? input.edits : []); break
        case 'update_todo': value = await this.handlers.updateTodo(Array.isArray(input.tasks) ? input.tasks : []); break
        case 'mappings_search': value = await this.handlers.mappingsSearch(String(input.query ?? ''), Number(input.limit ?? 20)); break
        case 'mappings_class': value = await this.handlers.mappingsClass(String(input.className ?? ''), typeof input.memberQuery === 'string' ? input.memberQuery : undefined); break
        case 'dependency_search': value = await this.handlers.dependencySearch(String(input.query ?? ''), Number(input.offset ?? 0)); break
        case 'dependency_install': value = await this.handlers.dependencyInstall(String(input.projectId ?? ''), typeof input.versionId === 'string' ? input.versionId : undefined); break
        case 'content_validate': value = await this.handlers.contentValidate(); break
        case 'test_matrix': value = await this.handlers.testMatrix(Array.isArray(input.targets) ? input.targets.map(String) : []); break
        case 'release_preflight': value = await this.handlers.releasePreflight(); break
        case 'build_project': value = await this.handlers.build(); break
        case 'test_minecraft': value = await this.handlers.testMinecraft(); break
        case 'blockbench_actions': value = await this.handlers.blockbenchActions(Array.isArray(input.actions) ? input.actions : []); break
        case 'runtime_state': value = await this.handlers.runtimeState(); break
        default: throw new Error(`未知 ModMind 工具：${String(body.action)}`)
      }
      response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(value))
    } catch (error) {
      response.writeHead(400, {'content-type': 'text/plain'}); response.end(error instanceof Error ? error.message : String(error))
    }
  }
}

export async function runExternalAgent(options: ExternalAgentRunOptions): Promise<ExternalAgentRunResult> {
  const bridge = new ModMindBridge(options.project, options.bridge, options.appVersion ?? 'development')
  const {mcpConfigPath} = await bridge.start()
  await bridge.writeMcpConfig(mcpConfigPath)
  const executable = options.executable || (await detectExternalAgents()).find((item) => item.kind === options.kind)?.executable
  if (!executable) { await bridge.stop(); throw new Error(`${externalAgentLabel(options.kind)} CLI 未安装或不在 PATH 中`) }
  const contextPath = path.join(options.project.path, options.project.toolDataDirectory ?? '.modmind', 'external-agents', 'agent-context.md')
  const prompt = `${options.prompt}\n\nAlways write user-facing responses in Simplified Chinese unless the user explicitly requests another language. Before inspecting files or using any other ModMind tool, call modmind_set_intent. Choose engineering only when the user explicitly requests a project change. Choose informational for greetings, questions, explanations, reviews, audits, and status checks without a requested change; then answer directly without Todo, edits, build, or test. For engineering work, read ${contextPath.replaceAll('\\', '/')} first, use ModMind for Todo tracking, mappings, build, test, and Blockbench, keep the Todo current, and do not build until every Todo is complete.`
  const runtime = mcpRuntime()
  const persistedSessionId = await readPersistedSession(options.project, options.kind)
  if (persistedSessionId) options.onSessionId?.(persistedSessionId)
  const resumedHistory = persistedSessionId ? await readExternalSessionHistory(options.kind, persistedSessionId) : ''
  const mcpServerPath = path.join(options.project.path, options.project.toolDataDirectory ?? '.modmind', 'external-agents', 'modmind-mcp-server.mjs').replaceAll('\\', '\\\\')
  const codexConfig = [
    '-c', 'sandbox_mode="read-only"',
    '-c', `mcp_servers.modmind.command=${JSON.stringify(runtime.command)}`,
    '-c', `mcp_servers.modmind.args=["${mcpServerPath}"]`,
    '-c', 'mcp_servers.modmind.default_tools_approval_mode="approve"',
    ...(runtime.env ? ['-c', 'mcp_servers.modmind.env={ELECTRON_RUN_AS_NODE="1"}'] : [])
  ]
  let args: string[]
  let childEnv: Record<string, string> | undefined
  if (options.kind === 'opencode') {
    const opencodeConfigPath = path.join(options.project.path, options.project.toolDataDirectory ?? '.modmind', 'external-agents', 'opencode-config.json')
    const opencodeConfig = {
      mcp: {
        modmind: {
          type: 'local',
          command: [runtime.command, path.join(options.project.path, options.project.toolDataDirectory ?? '.modmind', 'external-agents', 'modmind-mcp-server.mjs')],
          enabled: true,
          ...(runtime.env ? {environment: {ELECTRON_RUN_AS_NODE: '1'}} : {})
        }
      }
    }
    await fs.writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2), 'utf8')
    childEnv = {OPENCODE_CONFIG: opencodeConfigPath}
    args = [
      'run',
      '--format', 'json',
      ...(persistedSessionId ? ['--session', persistedSessionId] : []),
      '--dir', options.project.path,
      prompt
    ]
  } else if (options.kind === 'codex') {
    args = persistedSessionId
      ? ['--ask-for-approval', 'never', 'exec', 'resume', persistedSessionId, '--json', '--skip-git-repo-check', ...codexConfig, '-']
      : ['--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', options.project.path, ...codexConfig, '-']
  } else {
    args = ['-p', ...(persistedSessionId ? ['--resume', persistedSessionId] : []), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--mcp-config', mcpConfigPath, '--strict-mcp-config', '--add-dir', options.project.path, '--append-system-prompt', 'Write user-facing responses in Simplified Chinese unless explicitly asked otherwise. Call modmind_set_intent before any inspection or other tool. Informational requests must not create Todo, edit, build, or test. Engineering requests must use modmind_update_todo before edits and whenever task statuses change. Do not edit .modmind.']
  }
  const historyLabel = externalAgentLabel(options.kind)
  const startContent = `${historyLabel} 托管任务已启动${resumedHistory ? `\n\n[已恢复的 ${historyLabel} 对话上下文]\n${resumedHistory}` : ''}`
  options.onOutput('start', startContent)
  options.onProgress(`${externalAgentLabel(options.kind)} 正在分析项目`, '外部代理已连接 ModMind 工具桥', 'running')
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnManagedCli(executable, args, options.project.path, childEnv)
  } catch (error) {
    await bridge.stop()
    throw error
  }
  child.stdin.end(prompt)
  let transcript = ''
  let lastMessage = ''
  let activeSessionId = persistedSessionId
  const buffers = {stdout: '', stderr: ''}
  const processLine = (line: string, stream: 'stdout' | 'stderr'): void => {
    const output = parseExternalAgentOutputLine(line, stream)
    if (!output) return
    const {parsed} = output
    const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data as Record<string, unknown> : undefined
    const discoveredSessionId = typeof data?.sessionID === 'string' ? data.sessionID
      : typeof parsed?.thread_id === 'string' ? parsed.thread_id
        : typeof parsed?.session_id === 'string' ? parsed.session_id : undefined
    if (discoveredSessionId && discoveredSessionId !== activeSessionId) {
      activeSessionId = discoveredSessionId
      options.onSessionId?.(discoveredSessionId)
      void persistSession(options.project, options.kind, discoveredSessionId)
    }
    if (output.agentMessage) lastMessage = output.content
    options.onOutput(output.kind, output.content)
  }
  const consume = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    const text = chunk.toString('utf8')
    transcript += text
    buffers[stream] += text
    const lines = buffers[stream].split(/\r?\n/)
    buffers[stream] = lines.pop() ?? ''
    for (const line of lines) processLine(line, stream)
  }
  child.stdout.on('data', (chunk) => consume(chunk, 'stdout'))
  child.stderr.on('data', (chunk) => consume(chunk, 'stderr'))
  const abort = (): void => {
    if (child.killed) return
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'})
      killer.unref()
      return
    }
    child.kill('SIGTERM')
  }
  if (options.signal.aborted) abort()
  options.signal.addEventListener('abort', abort, {once: true})
  let exitCode: number | null
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
  } finally {
    options.signal.removeEventListener('abort', abort)
    processLine(buffers.stdout, 'stdout')
    processLine(buffers.stderr, 'stderr')
    await bridge.stop()
  }
  if (options.signal.aborted) throw new Error('外部代理任务已停止；已保留当前修改并保存恢复信息')
  if (exitCode !== 0) throw new Error(`${externalAgentLabel(options.kind)} 退出码 ${exitCode}\n${transcript.trim().slice(-8_000) || lastMessage}`)
  options.onProgress(`${externalAgentLabel(options.kind)} 任务结束`, '正在由 ModMind 检查任务意图与最终结果', 'success')
  options.onOutput('response', lastMessage || '外部代理已完成任务')
  if (activeSessionId) await persistSession(options.project, options.kind, activeSessionId)
  return {summary: lastMessage || `${options.kind} task completed`, transcript, buildUsed: false, runtimeUsed: false, exitCode, sessionId: activeSessionId}
}
