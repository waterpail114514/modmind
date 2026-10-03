// Real managed Codex + ModMind adapter/runner, local fixtures only; no API key needed.
// node scripts/codex-output-limit-smoke.mjs <path-to-codex-0.154.0>
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const executable = path.resolve(process.argv[2] || 'missing-codex-path')
await fs.access(executable)
const root = path.resolve('test-results', 'codex-output-limit', String(Date.now()))
await fs.mkdir(root, { recursive: true })
await build({ entryPoints: ['src/main/externalAgents.ts', 'src/main/chatCompletionsAdapter.ts', 'src/main/codexModelCatalog.ts'],
  outdir: root, bundle: true, platform: 'node', packages: 'external', format: 'cjs', outExtension: { '.js': '.cjs' },
  define: { 'import.meta.url': '__bundleUrl' }, banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' } })
const require = createRequire(import.meta.url)
const { runExternalAgent } = require(path.join(root, 'externalAgents.cjs'))
const { ChatCompletionsAdapter } = require(path.join(root, 'chatCompletionsAdapter.cjs'))
const { prepareCodexModelCatalog } = require(path.join(root, 'codexModelCatalog.cjs'))
const summaries = []

for (const mode of ['responses-hidden', 'responses-explicit', 'chat-length']) {
  const work = path.join(root, mode), home = path.join(work, 'home')
  await fs.mkdir(home, { recursive: true })
  const controller = new AbortController(), adapter = new ChatCompletionsAdapter()
  const timer = setTimeout(() => controller.abort(new Error('output-limit smoke timed out')), 45_000)
  const requests = [], turns = [], audits = [], notices = []
  const partial = '已经检查当前代码，接下来根据现有结果继续验证。'.repeat(80) + '\n- 0'
  const upstream = createServer((req, res) => { void (async () => {
    if (mode === 'chat-length' && req.url === '/v1/responses') {
      res.writeHead(404).end('{"error":{"message":"responses endpoint not found"}}'); return
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const history = mode === 'chat-length' ? body.messages : body.input
    const continuing = JSON.stringify(history).includes('上一轮生成因输出上限而未完整结束')
    if (continuing) assert.ok(JSON.stringify(history).includes(JSON.stringify(partial).slice(1, -1)), 'Original partial reply was lost on resume')
    requests.push({ model: body.model, continuing })
    const text = continuing ? '任务已完成，原有结果已保留。' : partial
    if (mode === 'chat-length') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `chat_${requests.length}`,
        choices: [{ finish_reason: continuing ? 'stop' : 'length', message: { role: 'assistant', content: text } }],
        usage: { prompt_tokens: 100, completion_tokens: continuing ? 20 : 8192 } }))
      return
    }
    const item = { type: 'message', role: 'assistant', id: `msg_${requests.length}`, status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }
    const incomplete = mode === 'responses-explicit' && !continuing
    const response = { id: `resp_${requests.length}`, status: incomplete ? 'incomplete' : 'completed', output: [item],
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: { input_tokens: 100, output_tokens: continuing ? 20 : 8192, total_tokens: continuing ? 120 : 8292 } }
    const events = [
      { type: 'response.created', response: { id: response.id, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: incomplete ? 'response.incomplete' : 'response.completed', response }
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })().catch(error => { console.error(error); controller.abort(error); res.destroy(error) }) })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    const model = 'deepseek-v4-flash'
    const catalog = await prepareCodexModelCatalog(home, model)
    const url = await adapter.baseUrl(`http://127.0.0.1:${upstream.address().port}/v1`, mode, controller.signal, undefined, model, null)
    await fs.writeFile(path.join(home, 'config.toml'), [
      `model=${JSON.stringify(model)}`, `model_catalog_json=${JSON.stringify(catalog.path)}`, 'model_provider="thirdparty"',
      '[features]', 'enable_request_compression=false', '[model_providers.thirdparty]', 'name="Local fixture"',
      `base_url=${JSON.stringify(url)}`, 'wire_api="responses"', 'requires_openai_auth=false', 'stream_max_retries=0'
    ].join('\n'))
    const result = await runExternalAgent({ kind: 'codex', executable, forceCodexAppServer: true,
      project: { path: work, name: mode, namespace: 'output_limit', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' },
      prompt: '继续检查已有结果，完成任务。', model, modelProvider: 'thirdparty', env: { CODEX_HOME: home }, sessionHome: home,
      maxAttempts: 1, signal: controller.signal, onOutput: (kind, content) => { if (kind === 'retry') notices.push(content) },
      onProgress: () => {}, onAttemptAudit: audit => audits.push(audit.outcome),
      onNativeTurn: async (sessionId, turnId) => { turns.push({ sessionId, turnId }) }, bridge: { projectInfo: { name: mode } } })
    assert.equal(result.summary, '任务已完成，原有结果已保留。')
    assert.equal(turns.length, 2)
    assert.equal(new Set(turns.map(turn => turn.sessionId)).size, 1)
    assert.equal(new Set(turns.map(turn => turn.turnId)).size, 2)
    assert.deepEqual(audits, ['retry', 'complete'])
    assert.ok(notices.some(text => text.includes('输出上限')))
    assert.ok(requests.at(-1).continuing)
    assert.ok(requests.every(request => request.model === model))
    summaries.push({ mode, nativeTurns: turns.length, sameSession: true, partialPreserved: true, audits, requests: requests.length })
    console.log(`PASS ${mode}: same session, two native turns, partial history preserved, final delivered`)
  } finally {
    clearTimeout(timer); controller.abort(); adapter.close()
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  }
}
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(summaries, null, 2))
console.log(path.join(root, 'result.json'))
