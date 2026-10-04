// Real managed runtime + ModMind MCP + local provider; no API keys or model charges.
// node scripts/codex-image-input-smoke.mjs <managed-codex-executable>
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '..')
const executable = path.resolve(process.argv[2] || 'missing-codex-path')
await fs.access(executable)
const work = path.join(root, 'test-results', 'codex-image-input', String(Date.now()))
await fs.mkdir(work, { recursive: true })
for (const [name, entry] of Object.entries({ agents: 'externalAgents', adapter: 'chatCompletionsAdapter', catalog: 'codexModelCatalog', images: 'projectImages', capabilities: 'modelImageCapabilities' })) {
  await build({ absWorkingDir: root, entryPoints: [`src/main/${entry}.ts`], bundle: true, platform: 'node', packages: 'external', format: 'cjs',
    define: { 'import.meta.url': '__bundleUrl' }, banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' },
    outfile: path.join(work, `${name}.cjs`) })
}
const require = createRequire(import.meta.url)
const { runExternalAgent } = require(path.join(work, 'agents.cjs'))
const { ChatCompletionsAdapter } = require(path.join(work, 'adapter.cjs'))
const { prepareCodexModelCatalog } = require(path.join(work, 'catalog.cjs'))
const { readProjectImage } = require(path.join(work, 'images.cjs'))
const { ModelImageCapabilities } = require(path.join(work, 'capabilities.cjs'))
const imagePath = '.modmind/attachments/reference.png'
const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#26a69a' } }).png().toBuffer()
await fs.mkdir(path.join(work, '.modmind', 'attachments'), { recursive: true })
await fs.writeFile(path.join(work, imagePath), png)
const expectedImage = `data:image/png;base64,${png.toString('base64')}`
const textOnly = process.argv.includes('--text-only')
const report = []

async function check(model, chat) {
  const requests = []
  let failure, reads = 0
  const controller = new AbortController()
  const capabilities = new ModelImageCapabilities()
  const adapter = new ChatCompletionsAdapter(observation => capabilities.observe(observation))
  const server = http.createServer((req, res) => { void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    if (chat && req.url.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"responses endpoint not found"}}'); return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const phase = (requests.length - 1) % 4
    const call = phase !== 3
    const callId = `call_image_${requests.length}`
    const toolName = phase === 0 ? 'modmind_mcp_probe' : phase === 1 ? 'modmind_image_read_project_asset' : 'modmind_model_image_capability'
    const argumentsText = JSON.stringify(phase === 0 ? {} : phase === 1 ? { path: imagePath } : { model, verify: false })
    const dispatcher = body.tools.some(tool => chat ? tool.function?.name === 'functions__exec' : tool.name === 'functions')
    const code = `const tool=ALL_TOOLS.find(t=>t.name.endsWith(${JSON.stringify(toolName)})); if(!tool) throw new Error("Missing tool"); const result=await tools[tool.name](${argumentsText}); if(result.isError) throw new Error(JSON.stringify(result)); for(const part of result.content){if(part.type==="image") image(part); else if(part.type==="text") text(part.text);}`
    assert.equal(body.model, model)
    if (phase >= 2) {
      await fs.writeFile(path.join(work, `request-${requests.length}.json`), JSON.stringify(body, null, 2))
      const parts = chat ? body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        : body.input.flatMap(item => Array.isArray(item.output) ? item.output : Array.isArray(item.content) ? item.content : [])
      const imagePresent = parts.some(part => chat ? part.type === 'image_url' && part.image_url.url === expectedImage
        : part.type === 'input_image' && part.image_url === expectedImage)
      assert.equal(imagePresent, !textOnly, `Unexpected image transport for ${model} ${chat ? 'chat' : 'responses'}`)
      if (chat) assert(!body.messages.filter(message => message.role === 'tool').some(message => message.content.includes(expectedImage)))
      if (phase === 3) {
        const returned = chat ? body.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n') : JSON.stringify(body.input)
        assert(returned.includes(textOnly ? 'unknown' : 'supported'), 'Capability readback must reach the model')
        if (!textOnly) assert.equal(capabilities.resolve(`http://127.0.0.1:${server.address().port}/v1`, '', model).source, 'request')
      }
    }
    if (chat) {
      const chatTool = dispatcher ? 'functions__exec' : body.tools.find(tool => tool.function?.name.endsWith(toolName))?.function.name
      if (call) assert(chatTool, 'Missing MCP tool')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `chat_${requests.length}`, choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call
        ? { tool_calls: [{ id: callId, type: 'function', function: { name: chatTool, arguments: dispatcher ? JSON.stringify({ input: code }) : argumentsText } }] }
        : { content: 'image-ok' } }] }))
      return
    }
    const item = call ? dispatcher
      ? { type: 'custom_tool_call', id: `ctc_${requests.length}`, call_id: callId, namespace: 'functions', name: 'exec', input: code, status: 'completed' }
      : { type: 'function_call', id: `fc_${requests.length}`, call_id: callId, namespace: 'mcp__modmind', name: toolName, arguments: argumentsText, status: 'completed' }
      : { type: 'message', role: 'assistant', id: `msg_${requests.length}`, status: 'completed', content: [{ type: 'output_text', text: 'image-ok', annotations: [] }] }
    const response = { id: `resp_${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })().catch(error => { failure = error; controller.abort(error); res.destroy() }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const home = path.join(work, `${model.replace(/[^a-z0-9]/gi, '_')}-${chat ? 'chat' : 'responses'}`)
    await fs.mkdir(home)
    const catalog = await prepareCodexModelCatalog(home, model)
    if (textOnly) {
      const legacy = JSON.parse(await fs.readFile(catalog.path, 'utf8'))
      legacy.models.find(entry => entry.slug === model).input_modalities = ['text']
      catalog.path = path.join(home, 'text-only-catalog.json')
      await fs.writeFile(catalog.path, JSON.stringify(legacy))
    }
    const baseUrl = await adapter.baseUrl(`http://127.0.0.1:${server.address().port}/v1`)
    await fs.writeFile(path.join(home, 'config.toml'), [
      `model=${JSON.stringify(model)}`, 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog.path)}`,
      '[features]', 'enable_request_compression=false', '[model_providers.fixture]', 'name="Image fixture"',
      `base_url=${JSON.stringify(baseUrl)}`, 'wire_api="responses"', 'requires_openai_auth=false'
    ].join('\n'))
    let sessionId
    for (let turn = 0; turn < 2; turn++) {
      const result = await runExternalAgent({ kind: 'codex', executable, forceCodexAppServer: true,
        project: { path: work, name: 'Image fixture', namespace: 'image_fixture', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' },
        model, modelProvider: 'fixture', readOnly: true, sessionId, sessionHome: home, env: { CODEX_HOME: home },
        prompt: `Inspect the attached image with modmind_image_read_project_asset: ${imagePath}`,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]), onOutput: () => {}, onProgress: () => {},
        bridge: {
          imageReadProjectAsset: async reference => { reads++; return { path: reference, dataUrl: await readProjectImage(work, reference) } },
          modelImageCapability: async input => {
            assert.equal(input.model, model); assert.equal(input.verify, false)
            return { model, imageInput: capabilities.resolve(`http://127.0.0.1:${server.address().port}/v1`, '', model) }
          }
        }
      }).catch(error => { throw failure ?? error })
      assert.equal(result.summary, 'image-ok')
      sessionId = result.sessionId
    }
    assert.equal(reads, 2)
    assert.equal(requests.length, 8)
    const evidence = { model, protocol: chat ? 'chat-completions' : 'responses', turns: ['fresh', 'resumed'], reads, imageBytes: png.length, imagesDelivered: !textOnly }
    report.push(evidence)
    console.log(`PASS ${JSON.stringify(evidence)}`)
  } finally { adapter.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

const selectedModels = process.argv.slice(3).filter(value => value !== '--text-only')
for (const model of selectedModels.length ? selectedModels : ['gpt-6-sol', 'gpt-6-luna', 'claude-opus-5-5', 'private-multimodal']) {
  await check(model, false)
  await check(model, true)
}
await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
console.log(work)
