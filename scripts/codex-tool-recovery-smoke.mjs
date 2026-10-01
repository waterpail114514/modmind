import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const executable = process.env.MODMIND_TEST_CODEX_EXECUTABLE
if (!executable) throw new Error('Set MODMIND_TEST_CODEX_EXECUTABLE to the Codex executable')

const work = path.join(root, 'test-results', 'codex-tool-recovery', String(Date.now()))
await fs.mkdir(work, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['src/main/externalAgents.ts'], bundle: true, platform: 'node', packages: 'external', format: 'cjs',
  define: { 'import.meta.url': '__bundleUrl' }, banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' },
  outfile: path.join(work, 'agents.cjs') })
await build({ absWorkingDir: root, entryPoints: ['src/main/chatCompletionsAdapter.ts'], bundle: true, platform: 'node', packages: 'external', format: 'cjs',
  outfile: path.join(work, 'adapter.cjs') })

const require = createRequire(import.meta.url)
const { runExternalAgent } = require(path.join(work, 'agents.cjs'))
const { ChatCompletionsAdapter } = require(path.join(work, 'adapter.cjs'))
const adapter = new ChatCompletionsAdapter()
const requests = []
const outputs = []
const progress = []
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 90_000)
const probeCode = 'const probe=ALL_TOOLS.find(t=>t.name.endsWith("modmind_mcp_probe")); if(!probe) throw new Error("probe missing from Codex dispatcher"); const result=await tools[probe.name]({}); if(result.isError) throw new Error(JSON.stringify(result)); text(result.content[0].text);'

function respond(res, item, index) {
  const response = { id: `resp_recovery_${index}`, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response }
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

const upstream = createServer((req, res) => { void (async () => {
  if (req.url !== '/v1/responses') { res.writeHead(404).end(); return }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const index = requests.length + 1
  // The first request reproduces a provider that omits the tool catalog before
  // the model sees it. The Codex-to-adapter request is left intact.
  const modelView = index === 1 ? { ...body, tools: [] } : body
  const probeOutput = Array.isArray(body.input) ? body.input.find(item => item.call_id === 'call_probe' && typeof item.type === 'string' && item.type.endsWith('_output')) : undefined
  requests.push({ index, codexToolCount: body.tools?.length ?? 0, modelToolCount: modelView.tools?.length ?? 0,
    dispatcherAvailable: Boolean(modelView.tools?.some(tool => tool.name === 'functions' || tool.name === 'functions__exec')),
    probeCallOutputPresent: Boolean(probeOutput && JSON.stringify(probeOutput).includes('modmind-mcp-ready-v1')) })
  if (index === 1) {
    respond(res, { type: 'message', id: 'msg_no_tools', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '当前会话没有可用的项目文件读写工具，暂时无法修改。', annotations: [] }] }, index)
    return
  }
  if (index === 2) {
    assert(requests[index - 1].dispatcherAvailable, 'Codex did not send its tool dispatcher after recovery')
    respond(res, { type: 'custom_tool_call', id: 'ctc_probe', call_id: 'call_probe', namespace: 'functions', name: 'exec', input: probeCode, status: 'completed' }, index)
    return
  }
  assert(requests[index - 1].probeCallOutputPresent, 'The model did not receive the result of call_probe')
  respond(res, { type: 'message', id: 'msg_recovered', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '恢复完成：已通过 ModMind MCP 探针验证工具可用。', annotations: [] }] }, index)
})().catch(error => { controller.abort(error); res.destroy(error) }) })

await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const home = path.join(work, 'home')
await fs.mkdir(home)
const adapterUrl = await adapter.baseUrl(`http://127.0.0.1:${upstream.address().port}/v1`)
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.6-luna"\nmodel_provider="recovery"\n[features]\nenable_request_compression=false\n[model_providers.recovery]\nname="Recovery smoke"\nbase_url=${JSON.stringify(adapterUrl)}\nwire_api="responses"\nrequires_openai_auth=false\n`)

try {
  const result = await runExternalAgent({ kind: 'codex', executable, forceCodexAppServer: true, project: {
    path: work, name: 'Tool recovery smoke', namespace: 'tool_recovery', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: ''
  }, prompt: '调用探针确认工具可用，然后回复结果。', env: { CODEX_HOME: home }, sessionHome: home,
  model: 'gpt-5.6-luna', modelProvider: 'recovery', adapterRouteId: adapterUrl.match(/\/adapter\/([a-f0-9]{32})\/v1$/)?.[1],
  persistentRetry: true, signal: controller.signal, onOutput: (kind, content) => outputs.push({ kind, content }),
  onProgress: (title, detail) => progress.push({ title, detail }), bridge: { projectInfo: { name: 'Tool recovery smoke' } } })
  assert.equal(requests.length, 3)
  assert(requests[0].codexToolCount > 0)
  assert.equal(requests[0].modelToolCount, 0)
  assert(requests[1].modelToolCount > 0)
  assert.equal(requests[0].probeCallOutputPresent, false)
  assert.equal(requests[1].probeCallOutputPresent, false)
  assert(requests[2].probeCallOutputPresent)
  assert.equal(result.summary, '恢复完成：已通过 ModMind MCP 探针验证工具可用。')
  assert(!JSON.stringify(outputs).includes('当前会话没有可用的项目文件读写工具'))
  assert(!outputs.some(event => event.kind === 'retry'))
  const report = { result: result.summary, sessionId: result.sessionId, nativeTurnId: result.nativeTurnId, requests, outputs, progress }
  await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ work, ...report }, null, 2))
} finally {
  clearTimeout(timeout)
  adapter.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
}
