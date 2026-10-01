// Runs the real managed Codex against a local Responses fixture; no paid API calls.
// node scripts/codex-compaction-smoke.mjs <path-to-managed-codex>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const executable = path.resolve(process.argv[2] || 'missing-codex-path')
await fs.access(executable)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-compaction-smoke-'))
let requestCount = 0
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!req.url.endsWith('/responses')) { res.writeHead(404).end(); return }
    JSON.parse(Buffer.concat(chunks).toString())
    const n = ++requestCount
    const item = { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture response: continue the current task.', annotations: [] }] }
    const usage = { input_tokens: n === 1 ? 250000 : 100, output_tokens: 10, total_tokens: n === 1 ? 250010 : 110 }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: [item], usage } }
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  } catch (error) { res.writeHead(500).end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

async function check(prepareCodex, autoCompactTokenLimit, expectedCompactions) {
  requestCount = 0
  const home = await fs.mkdtemp(path.join(temporary, 'home-'))
  const prepared = await prepareCodex({ rootDir: temporary, homeDir: home, existingExecutable: executable, rememberPrepared: false, serverConfig: {
    apiKey: 'local-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'modmind-compaction-fixture', contextWindow: 512000, autoCompactTokenLimit
  } })
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: home, env: { ...process.env, ...prepared.environment }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', stderr = '', id = 0
  const pending = new Map(), events = [], completions = []
  let finishTurn
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
      else {
        events.push(message)
        if (message.method === 'turn/completed') { completions.push(message); finishTurn?.(message); finishTurn = undefined }
      }
    }
  })
  const request = async (method, params) => {
    const message = await new Promise(resolve => { const next = ++id; pending.set(next, resolve); child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n') })
    assert.ok(message.result, JSON.stringify(message))
    return message.result
  }
  let timeout
  try {
    await Promise.race([
      (async () => {
        await request('initialize', { clientInfo: { name: 'modmind_compaction_test', version: '1' } })
        const config = await request('config/read', { cwd: home })
        assert.equal(config.config.model_auto_compact_token_limit, autoCompactTokenLimit ?? 437760)
        const thread = await request('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true })
        for (const text of ['Reply with a short acknowledgement.', 'Continue with a short acknowledgement.']) {
          const completed = new Promise(resolve => { finishTurn = resolve })
          await request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text, text_elements: [] }] })
          const completion = await completed
          assert.equal(completion.params.turn.status, 'completed', JSON.stringify(completion))
        }
        const compactions = events.filter(event => event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction')
        assert.equal(compactions.length, expectedCompactions, JSON.stringify({ autoCompactTokenLimit, compactions, requests: requestCount, stderr }))
        const windows = events.filter(event => event.method === 'thread/tokenUsage/updated').map(event => event.params.tokenUsage.modelContextWindow)
        assert.ok(windows.some(window => window >= 460800 && window <= 512000), JSON.stringify(windows))
        assert.equal(completions.length, 2)
        console.log(`PASS threshold=${autoCompactTokenLimit ?? 'auto'}: context=512000, observed input=250000, compactions=${compactions.length}, turns=2`)
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out: ${stderr}\n${JSON.stringify(events).slice(-3000)}`)), 30000) })
    ])
  } finally {
    clearTimeout(timeout)
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
}

try {
  const bundle = path.join(temporary, 'setup.cjs')
  await build({ entryPoints: ['src/main/codexSetup.ts'], outfile: bundle, platform: 'node', format: 'cjs', bundle: true })
  const { prepareCodex } = createRequire(import.meta.url)(bundle)
  await check(prepareCodex, 200000, 1)
  await check(prepareCodex, 450000, 0)
  await check(prepareCodex, undefined, 0)
} finally {
  await new Promise(resolve => server.close(resolve))
  // temporary is a verified task-owned directory created by mkdtemp.
  await fs.rm(temporary, { recursive: true, force: true })
}
