import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Diagnostics for owned acceptance fixtures; --stop-owned explicitly cancels it.
const directory = path.resolve(process.argv[2])
if (!directory.startsWith(path.resolve('test-results') + path.sep)) throw new Error('Acceptance fixture required')
const project = path.join(directory, 'project'), config = JSON.parse(await fs.readFile(path.join(project, '.modmind/external-agents/mcp-config.json'), 'utf8')).mcpServers.modmind
let sessionId
const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env, MODMIND_BRIDGE_CONFIG: path.join(project, '.modmind/external-agents/bridge.json') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = '', sequence = 0
const pending = new Map()
child.stdout.on('data', chunk => { buffer += chunk; for (let i; (i = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) { const value = JSON.parse(line); pending.get(value.id)?.(value) } } })
const call = (name, input) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(new Error('Diagnostic timeout')), 12000); pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'modmind_test_' + name, arguments: { ...input, ...(sessionId ? { sessionId } : {}) } } }) + '\n') })
try {
  const state = await call('session', { operation: 'state', waitSeconds: 1 }); console.log(JSON.stringify(state))
  sessionId = state.result?.content?.filter(item => item.type === 'text').map(item => { try { return JSON.parse(item.text).sessionId } catch {} }).find(Boolean)
  if (!sessionId) throw new Error('Owned fixture has no current session')
  if (process.argv.includes('--stop-owned')) { console.log(JSON.stringify(await call('session', { operation: 'stop' }))); }
  else {
  const captured = await call('capture', {})
  for (const item of captured.result?.content || []) {
    if (item.type === 'image') { await fs.writeFile(path.join(directory, 'diagnostic.png'), Buffer.from(item.data, 'base64')); console.log('Image written to diagnostic.png') }
    else if (item.type === 'text') console.log(item.text)
  }
  }
} finally { child.stdin.end(); child.kill() }
