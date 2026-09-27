// No API keys or external requests: exercise the real managed runtime against a local fixture.
// node scripts/codex-model-metadata-smoke.mjs <path-to-managed-codex>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const executable = path.resolve(process.argv[2] || 'missing-codex-path')
await fs.access(executable)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-metadata-smoke-'))
const requests = []
let Adapter
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!req.url.endsWith('/responses')) { res.writeHead(404).end(); return }
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push(body)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of [
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'metadata-ok', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

async function check(model, prepareCatalog, reasoningCase) {
  const home = await fs.mkdtemp(path.join(temporary, 'home-'))
  const effort = reasoningCase ? reasoningCase.level === 'auto' ? undefined : reasoningCase.level : 'high'
  const adapter = reasoningCase ? new Adapter() : undefined
  const upstreamBase = `http://127.0.0.1:${server.address().port}/v1`
  const baseUrl = adapter ? await adapter.baseUrl(upstreamBase, model, undefined, model, model, effort ?? null) : upstreamBase
  const catalog = await prepareCatalog(home, model, reasoningCase ? { reasoning: reasoningCase.capabilities } : {})
  const entry = JSON.parse(await fs.readFile(catalog.path, 'utf8')).models.find(entry => entry.slug === model)
  await fs.writeFile(path.join(home, 'config.toml'), [
    `model = ${JSON.stringify(model)}`, 'model_provider = "thirdparty"',
    `model_catalog_json = ${JSON.stringify(catalog.path)}`, ...(effort ? [`model_reasoning_effort = ${JSON.stringify(effort)}`] : []),
    '[features]', 'enable_request_compression = false',
    '[model_providers.thirdparty]', 'name = "Local fixture"',
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"'
  ].join('\n'))
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = '', stderr = '', id = 0
  const pending = new Map(), events = []
  let finishTurn
  const completed = new Promise(resolve => { finishTurn = resolve })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
      else { events.push(message); if (message.method === 'turn/completed') finishTurn(message) }
    }
  })
  const request = (method, params) => new Promise(resolve => {
    const next = ++id; pending.set(next, resolve)
    child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n')
  })
  let timeout
  try {
    await Promise.race([
      (async () => {
        assert.ok((await request('initialize', { clientInfo: { name: 'modmind_metadata_test', version: '1' } })).result)
        const models = await request('model/list', { includeHidden: true })
        assert.ok(models.result.data.some(entry => entry.model === model))
        assert.ok(models.result.data.some(entry => entry.model === 'gpt-6-astra'))
        assert.ok(models.result.data.some(entry => entry.model === 'codex-auto-review'))
        const thread = await request('thread/start', { model, cwd: home, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true })
        assert.equal(thread.result?.model, model, JSON.stringify(thread))
        const turn = await request('turn/start', { threadId: thread.result.thread.id, input: [{ type: 'text', text: 'Reply metadata-ok.', text_elements: [] }] })
        assert.ok(turn.result, JSON.stringify(turn))
        const completion = await completed
        assert.equal(completion.params.turn.status, 'completed', JSON.stringify(completion))
        assert.doesNotMatch(JSON.stringify(events) + stderr, /fallback model metadata|Model metadata for|Invalid configuration/)
        const outgoing = requests.at(-1)
        assert.equal(outgoing.model, model)
        const declaredTools = outgoing.tools ?? outgoing.input?.filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])
        assert.ok(declaredTools?.length > 0, `Missing tool declarations for ${model}`)
        if (!entry.supports_reasoning_summaries) assert.equal(outgoing.reasoning?.summary, undefined)
        assert.equal(outgoing.reasoning?.effort, effort)
        if (!entry.support_verbosity) assert.equal(outgoing.text?.verbosity, undefined)
        const windows = events.filter(event => event.method === 'thread/tokenUsage/updated').map(event => event.params.tokenUsage.modelContextWindow)
        assert.ok(windows.some(window => window >= entry.context_window * 0.9 && window <= entry.context_window), `Runtime context differs from registry: ${JSON.stringify(windows)} vs ${entry.context_window}`)
        console.log(`PASS ${model}: effort=${outgoing.reasoning?.effort ?? 'auto'}, context=${entry.context_window}, native window=${windows.at(-1)}, turn completed`)
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out: ${model}\n${stderr}\n${JSON.stringify(events).slice(-3000)}`)), 20_000) })
    ])
  } finally {
    clearTimeout(timeout)
    const closed = new Promise(resolve => child.once('close', resolve))
    child.kill()
    await closed
    adapter?.close()
  }
}

try {
  const bundle = path.join(temporary, 'catalog.cjs')
  await build({ entryPoints: ['src/main/codexModelCatalog.ts'], outfile: bundle, platform: 'node', format: 'cjs', bundle: true })
  const { prepareCodexModelCatalog } = createRequire(import.meta.url)(bundle)
  const models = process.argv.slice(3)
  if (models[0] === '--reasoning' || models[0] === '--ultra') {
    const adapterBundle = path.join(temporary, 'adapter.cjs')
    await build({ entryPoints: ['src/main/chatCompletionsAdapter.ts'], outfile: adapterBundle, platform: 'node', format: 'cjs', bundle: true })
    Adapter = createRequire(import.meta.url)(adapterBundle).ChatCompletionsAdapter
  }
  if (models[0] === '--ultra') {
    await check('gpt-6-sol', prepareCodexModelCatalog, { level: 'ultra', capabilities: { source: 'provider', efforts: ['ultra'], controls: ['effort'] } })
  } else if (models[0] === '--reasoning') {
    const reasoningBundle = path.join(temporary, 'reasoning.cjs')
    await build({ entryPoints: ['src/main/modelReasoningCatalog.ts'], outfile: reasoningBundle, platform: 'node', format: 'cjs', bundle: true })
    const { modelReasoningCatalog } = createRequire(import.meta.url)(reasoningBundle)
    for (const model of ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-astra', 'unknown-model']) {
      const capabilities = modelReasoningCatalog.resolve(model)
      for (const level of ['auto', ...capabilities.efforts]) await check(model, prepareCodexModelCatalog, { level, capabilities })
    }
  } else for (const model of models.length ? models : ['gpt-6-sol', 'gpt-6-luna', 'claude-opus-5-5', 'gpt-7-sol', 'gpt-6-astra', 'unknown-model', 'deepseek-v4-flash', 'gpt-4-0314', 'grok-4', 'google/gemini-2.5-pro', 'deepseek-chat', 'qwen/qwen3-coder', 'nvidia/nemotron-3-ultra-550b-a55b:free']) await check(model, prepareCodexModelCatalog)
} finally {
  await new Promise(resolve => server.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true })
}
