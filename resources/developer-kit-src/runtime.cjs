// A development host in its own process. Native package code has local Node
// permissions; the separate process/profile protects application lifecycle and data.
const fs = require('node:fs/promises')
const path = require('node:path')
const Ajv = require('ajv')
const { createHash } = require('node:crypto')
let config, manifest, root
const logs = []
const events = []
const stringify = value => { try { return typeof value === 'string' ? value : JSON.stringify(value) } catch { return String(value) } }
for (const method of ['log', 'warn', 'error', 'info', 'debug']) console[method] = (...args) => {
  logs.push(args.map(stringify).join(' ').slice(0, 8000)); if (logs.length > 100) logs.shift()
}
const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, validateFormats: false, ownProperties: true })
function safe(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 240 || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part) || /[. ]$/.test(part))) throw Error('模板文件路径无效：' + relative)
  return path.join(root, ...relative.split('/'))
}
let runtime
let compatibilityHost, resolveHost
const hostReady = new Promise(resolve => { resolveHost = resolve })
exports.configureHost = host => { compatibilityHost = host; resolveHost() }
async function execute(request) {
  if (request.input !== undefined && (!request.input || typeof request.input !== 'object' || Array.isArray(request.input))) throw Error('动作参数须为对象')
  if (request.operation === 'mcp') {
    const rpc = request.rpc
    if (!rpc || rpc.jsonrpc !== '2.0') throw Error('MCP JSON-RPC 请求无效')
    if (rpc.method === 'initialize') return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: manifest.id, version: manifest.version } } }
    if (rpc.method === 'tools/list') return { jsonrpc: '2.0', id: rpc.id, result: { tools: (manifest.tools || []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: manifest.actions.find(action => action.id === tool.action).inputSchema })) } }
    if (rpc.method !== 'tools/call') return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Unknown MCP method' } }
    try {
      const result = await execute({ operation: 'tool', name: rpc.params?.name, input: rpc.params?.arguments, readOnly: request.readOnly })
      return { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result } } }
    } catch (error) { return { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } } }
  }
  const context = { projectPath: root, readOnly: !!request.readOnly, surface: 'workbench' }
  if (request.operation === 'host-api') {
    if (compatibilityHost) return compatibilityHost.api(request.channel, request.args || [], context)
    if (request.channel === 'feature-plugins:catalog') return [{ id: manifest.id, manifest, installed: true, available: true, enabled: true }]
    if (request.channel === 'feature-plugins:list') return [{ id: manifest.id, manifest, enabled: true }]
    if (request.channel === 'project:current') return JSON.parse(await fs.readFile(path.join(root, 'modmind.project.json'), 'utf8'))
    if (request.channel === 'feature-plugins:invoke') {
      const [id, name, input] = request.args || []
      if (id !== manifest.id) throw Error('预览仅能调用当前开发包')
      return execute({ operation: 'action', name, input, readOnly: request.readOnly })
    }
    throw Error('独立预览未开放此宿主操作：' + request.channel)
  }
  if (request.operation === 'inspect') return { actions: manifest.actions || [], tools: manifest.tools || [], studios: manifest.studios || [], pages: manifest.views || [], activated: true }
  if (request.operation === 'create-studio') {
    if (request.readOnly) throw Error('只读调试禁止创建项目')
    const studio = (manifest.studios || []).find(item => item.id === request.name) || manifest.studios?.[0]
    if (!studio) throw Error('没有可创建的工作台领域')
    const provider = runtime.studios?.[studio.templateHandler]
    if (typeof provider?.templateFiles !== 'function') throw Error('第一版开发宿主支持 templateFiles；scaffold 请在目标宿主验证')
    const values = {}
    const project = { name: request.input?.name || '测试项目', path: root, namespace: 'devtest', kind: studio.projectKind, loader: studio.defaultTarget.loader, minecraftVersion: studio.defaultTarget.version, createdAt: new Date().toISOString(), studioId: studio.id, studioName: studio.name, studioValues: values }
    const matches = condition => !condition || Object.entries(condition).every(([key, allowed]) => allowed.includes(raw[key]))
    const raw = Object.fromEntries((studio.creation?.fields || []).map(field => [field.id, request.input?.[field.id] ?? field.default ?? (field.bind ? project[field.bind] : '') ?? '']))
    const allowedKeys = new Set(['name', ...(studio.creation?.fields || []).map(field => field.id)])
    if (Object.keys(request.input || {}).some(key => !allowedKeys.has(key))) throw Error('创建参数包含未知字段')
    for (const field of studio.creation?.fields || []) {
      if (!matches(field.when)) continue
      if (field.source) throw Error('开发宿主不提供在线平台版本，请在目标宿主验证')
      const supplied = request.input?.[field.id]
      const value = raw[field.id]
      if (typeof value !== 'string' || field.required && !value.trim() || field.maxLength && value.length > field.maxLength) throw Error('创建字段无效：' + field.title)
      if (field.readOnly && supplied !== undefined && value !== field.default) throw Error('禁止修改只读字段：' + field.title)
      if (field.options?.length && !field.options.some(option => option.value === value && matches(option.when))) throw Error('创建选项无效：' + field.title)
      if (field.bind) project[field.bind] = value
      else values[field.id] = value
    }
    if (!studio.loaders.includes(project.loader)) throw Error('测试项目平台不受该工作台支持')
    const files = await provider.templateFiles(project, true)
    if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 512) throw Error('模板必须返回最多 512 个文本文件')
    let bytes = 0
    for (const [relative, content] of Object.entries(files)) {
      safe(relative)
      if (relative.toLowerCase() === 'modmind.project.json' || typeof content !== 'string' || (bytes += Buffer.byteLength(content)) > 32 * 1024 * 1024) throw Error('模板内容或大小无效')
    }
    const created = []
    // Preflight all files; repeat creation reports conflicts instead of replacing drafts.
    for (const relative of [...Object.keys(files), 'modmind.project.json']) if (await fs.lstat(safe(relative)).then(() => true, () => false)) throw Error('测试项目已有文件：' + relative)
    for (const [relative, content] of Object.entries({ ...files, 'modmind.project.json': JSON.stringify(project, null, 2) + '\n' })) {
      const target = safe(relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx' }); created.push(relative)
    }
    const readback = []
    let remaining = 128 * 1024
    for (const relative of created) {
      const data = await fs.readFile(safe(relative)), content = data.toString('utf8')
      const excerpt = content.slice(0, Math.max(0, remaining)); remaining -= excerpt.length
      readback.push({ path: relative, content: excerpt, truncated: excerpt.length < content.length, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
    }
    return { verified: true, project, files: created, readback, ai: studio.ai }
  }
  const tool = request.operation === 'tool' ? manifest.tools?.find(item => item.name === request.name) : null
  if (request.operation === 'tool' && !tool) throw Error('工具未声明：' + request.name)
  const action = manifest.actions?.find(item => item.id === (tool?.action || request.name))
  if (!action) throw Error('动作未声明：' + request.name)
  if (request.readOnly && action.permission !== 'read') throw Error('只读调试禁止执行写入、联网或进程动作')
  if (action.surfaces && !action.surfaces.includes(context.surface)) throw Error('动作不支持当前调试模式')
  const check = ajv.compile(action.inputSchema)
  if (!check(request.input || {})) throw Error('参数校验失败：' + ajv.errorsText(check.errors))
  const metadata = await fs.readFile(path.join(root, 'modmind.project.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (action.projectRequired && !metadata) throw Error('请先创建测试项目')
  for (const scope of [manifest, action]) {
    if (scope.studioIds && !scope.studioIds.includes(metadata?.studioId) || scope.loaders && !scope.loaders.includes(metadata?.loader)) throw Error('动作不适用于当前测试项目')
  }
  const handler = runtime.actions?.[action.handler] || runtime[action.handler]
  if (typeof handler !== 'function') throw Error('动作未实现：' + action.handler)
  return compatibilityHost ? compatibilityHost.invoke(action.id, request.input || {}, context) : await handler.call(runtime, request.input || {}, context)
}
async function initialize(workerData) {
    config = workerData; manifest = config.manifest; root = config.projectPath
    await fs.mkdir(root, { recursive: true })
    const entry = path.join(workerData.directory, 'main.cjs')
    if (createHash('sha256').update(await fs.readFile(entry)).digest('hex') !== manifest.files['main.cjs']) throw Error('调试产物已变化，请重新构建')
    if (process.env.MODMIND_DEVELOPER_HOST_CONFIG) {
      await hostReady
      runtime = await compatibilityHost.initialize(workerData)
      return { activated: true, host: 'modmind' }
    }
    const module = require(entry)
    if (typeof module.activate !== 'function') throw Error('main.ts 必须导出 activate()')
    runtime = module.activate({ pluginId: manifest.id, pluginDirectory: workerData.directory, assetBaseUrl: '', userDataDir: workerData.userDataDir, projectRoot: () => root,
      emitEvent: (name, payload) => {
        if (!manifest.events?.includes(name)) throw Error('事件未声明：' + name)
        if (events.length < 100) events.push({ name, payload, delivered: true })
        process.send?.({ type: 'renderer-event', channel: 'feature-plugins:event', args: [manifest.id, name, payload] })
      } })
    if (!runtime || typeof runtime.then === 'function') throw Error('activate() 必须同步返回运行时对象')
    for (const action of manifest.actions || []) if (typeof (runtime.actions?.[action.handler] || runtime[action.handler]) !== 'function') throw Error('动作未实现：' + action.handler)
    for (const studio of manifest.studios || []) if (!runtime.studios?.[studio.templateHandler]) throw Error('工作台 provider 未实现：' + studio.templateHandler)
    await runtime.projectChanged?.(root)
    return { activated: true }
}
let queue = Promise.resolve()
process.on('message', message => {
  const run = async () => {
    logs.length = 0; events.length = 0
    try {
      if (message.request.operation === 'dispose') { await runtime?.dispose?.(); process.exit(0); return }
      const result = message.request.operation === 'init' ? await initialize(message.request) : await execute(message.request)
      process.send?.({ id: message.id, ok: true, result, logs, events })
    } catch (error) {
      process.send?.({ id: message.id, ok: false, error: String(error?.message || error), stack: error?.stack, logs })
    }
  }
  if (message.request.operation === 'init' || message.request.operation === 'dispose') queue = queue.then(run)
  else void queue.then(run)
})
process.on('disconnect', () => { Promise.resolve(runtime?.dispose?.()).finally(() => process.exit(0)) })
