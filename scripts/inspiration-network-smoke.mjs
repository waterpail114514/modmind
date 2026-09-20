import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
// Uses the installed Codex runtime and a local scripted model provider (no API key
// or model charge). Exercises real public web requests through the MCP bridge.
// Run once normally and once with --chat to cover both upstream protocols.
const root = path.resolve(import.meta.dirname, '..')
const executable = process.env.MODMIND_TEST_CODEX_EXECUTABLE
if (!executable) throw new Error('Set MODMIND_TEST_CODEX_EXECUTABLE to the Codex executable to test')
const work = path.join(root, 'test-results', 'inspiration-network', String(Date.now()))
await fs.mkdir(work, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['src/main/externalAgents.ts'], bundle: true, platform: 'node', packages: 'external', format: 'cjs', define: { 'import.meta.url': '__bundleUrl' }, banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' }, outfile: path.join(work, 'agents.cjs') })
const { runExternalAgent } = createRequire(import.meta.url)(path.join(work, 'agents.cjs'))
await build({ absWorkingDir: root, entryPoints: ['src/main/chatCompletionsAdapter.ts'], bundle: true, platform: 'node', packages: 'external', format: 'cjs', outfile: path.join(work, 'adapter.cjs') })
const { ChatCompletionsAdapter } = createRequire(import.meta.url)(path.join(work, 'adapter.cjs'))
const adapter = new ChatCompletionsAdapter()
const chat = process.argv.includes('--chat')
const code = 'const search=ALL_TOOLS.find(t=>t.name.endsWith("modmind_web_search")); const read=ALL_TOOLS.find(t=>t.name.endsWith("modmind_web_read")); if(!search||!read) throw new Error("Missing web tools"); const found=await tools[search.name]({query:"原神 官网",limit:2}); const page=await tools[read.name]({url:"https://ys.mihoyo.com/",maxChars:2000}); if(found.isError||page.isError) throw new Error(JSON.stringify({found,page})); text({search:JSON.parse(found.content[0].text),page:JSON.parse(page.content[0].text)});'
const requests = []
const evidence = []
const controller = new AbortController()
let serverFailure
const server = http.createServer((req, res) => { void handle(req, res).catch(error => {
  serverFailure = error
  controller.abort(error)
  res.destroy()
}) })
async function handle(req, res) {
  const chunks = []; for await (const c of req) chunks.push(c)
  if (chat && req.url.endsWith('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"responses endpoint not found"}}'); return }
  const input = JSON.parse(Buffer.concat(chunks).toString())
  requests.push(input)
  await fs.writeFile(path.join(work, `request-${requests.length}.json`), JSON.stringify(input, null, 2))
  assert(input.tools?.length, 'The model must receive callable tools')
  const callId = `call-web-${Math.ceil(requests.length / 2)}`
  const call = requests.length % 2 === 1
  if (!call) {
    const returned = chat ? input.messages.filter(x => x.tool_call_id === callId) : input.input.filter(x => x.call_id === callId && x.type.endsWith('_output'))
    const blocks = chat ? JSON.parse(returned[0]?.content ?? '[]') : returned[0]?.output ?? []
    const data = blocks.flatMap(block => { try { return [JSON.parse(block.text)] } catch { return [] } }).find(value => value?.page)
    assert(data?.search.results.length > 0, `No search results returned: ${JSON.stringify(returned)}`)
    assert.equal(data.page.url, 'https://ys.mihoyo.com/')
    assert(data.page.fetchedAt)
    assert(data.page.title.includes('原神'))
    if (!data.page.content) {
      assert(data.page.description.length > 0)
      assert(data.page.warning.includes('网页已成功获取'))
    }
    evidence.push({ turn: evidence.length ? 'resumed' : 'fresh', search: data.search.provider, page: data.page })
    console.log(JSON.stringify({ protocol: chat ? 'chat-completions' : 'responses', turn: evidence.at(-1).turn, title: data.page.title, description: data.page.description, bodyChars: data.page.totalChars }))
  }
  if (chat) {
    assert(input.tools.some(t => t.function?.name === 'functions__exec'))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `chat-${requests.length}`, choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: callId, type: 'function', function: { name: 'functions__exec', arguments: JSON.stringify({ input: code }) } }] } : { content: '验证完成' } }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const item = call ? { type: 'custom_tool_call', id: `ctc-${requests.length}`, call_id: callId, name: 'exec', namespace: 'functions', input: code, status: 'completed' } : { type: 'message', role: 'assistant', id: 'msg-probe', status: 'completed', content: [{ type: 'output_text', text: '验证完成', annotations: [] }] }
  const response = { id: 'resp-probe', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end()
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const home = path.join(work, 'home'); await fs.mkdir(home)
const adapterUrl = await adapter.baseUrl(`http://127.0.0.1:${server.address().port}`)
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.6-luna"\nmodel_provider="probe"\n[features]\nenable_request_compression=false\n[model_providers.probe]\nname="Probe"\nbase_url=${JSON.stringify(adapterUrl)}\nwire_api="responses"\nrequires_openai_auth=false\n`)
try {
  let sessionId
  for (let turn = 0; turn < 2; turn++) {
    const result = await runExternalAgent({ kind: 'codex', executable, forceCodexAppServer: true,
      project: { path: work, name: 'Network probe', namespace: 'probe', loader: 'fabric', minecraftVersion: '1.20.1', createdAt: '' },
      readOnly: true, prompt: '读取 https://ys.mihoyo.com/ 网页。', env: { CODEX_HOME: home }, model: 'gpt-5.6-luna', reasoningEffort: 'low',
      sessionId, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), onOutput: (kind, text) => console.log(kind, text.slice(0,200)), onProgress: () => {}, bridge: {} }).catch(error => { throw serverFailure ?? error })
    sessionId = result.sessionId
  }
  assert.equal(requests.length, 4)
  await fs.writeFile(path.join(work, 'report.json'), JSON.stringify({ protocol: chat ? 'chat-completions' : 'responses', evidence }, null, 2))
  console.log('work', work)
} finally { adapter.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
