const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')
const { Script, compileFunction } = require('node:vm')
const { createHash, randomUUID } = require('node:crypto')
const esbuild = require('esbuild')
const ts = require('typescript')
const Ajv = require('ajv')
const archiver = require('archiver')
const { root, kit, kind, sourceMode, sources, sourceRevision } = workerData
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, validateFormats: false, ownProperties: true })
const inside = (base, file) => { const relative = path.relative(base, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) }
const diagnostic = (message, file = 'manifest.json') => { throw Object.assign(new Error(message), { diagnostics: [{ file, message }] }) }
function validateManifest(m) {
  if (sourceMode === 'package') {
    if (!m || m.format !== 'modmind-feature' || m.apiVersion !== 2 || m.hostVersion !== '1.5.0-plugintest' || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(m.id) || m.main !== 'main.cjs' || m.renderer !== 'renderer.js' || m.style !== 'renderer.css') diagnostic('导入包清单或入口无效')
    if ((kind === 'studio') !== Boolean(m.studios?.length)) diagnostic('包类型与 studios 声明不一致')
    return m // The shared archive contract validator checks the completed package without activating it.
  }
  const schema = JSON.parse(syncFs.readFileSync(path.join(kit, 'manifest.schema.json'), 'utf8'))
  const check = ajv.compile(schema)
  if (!check(m)) diagnostic(ajv.errorsText(check.errors))
  if ((kind === 'studio') !== Boolean(m.studios?.length)) diagnostic('包类型与 studios 声明不一致')
  if (m.dependencies?.length) diagnostic('第一版独立开发暂不支持依赖其他功能包')
  for (const key of ['capabilities', 'views', 'settings', 'actions', 'tools', 'studios']) {
    const values = (m[key] || []).map(item => item.id || item.name)
    if (new Set(values).size !== values.length) diagnostic('声明标识重复：' + key)
  }
  if (m.settings?.length) diagnostic('第一版预览支持页面；设置面板请改为页面或在目标宿主验证')
  for (const action of m.actions || []) {
    try { ajv.compile(action.inputSchema) } catch (e) { diagnostic('动作参数 schema 无效：' + action.id + ' ' + e.message) }
    if (action.studioIds && !action.projectRequired) diagnostic('领域动作必须声明 projectRequired：' + action.id)
  }
  for (const tool of m.tools || []) if (!m.actions?.some(action => action.id === tool.action)) diagnostic('工具引用未知动作：' + tool.name)
  for (const studio of m.studios || []) {
    if (!m.hostCapabilities?.includes('studioV1')) diagnostic('工作台包需要 studioV1 能力')
    if (!studio.loaders.includes(studio.defaultTarget.loader)) diagnostic('工作台默认平台不在支持列表中')
    if (studio.adoption) diagnostic('第一版开发宿主暂不支持接管 provider 的调试')
    const fields = studio.creation?.fields || []
    const ids = fields.map(field => field.id)
    if (new Set(ids).size !== ids.length) diagnostic('创建字段 ID 重复')
    const binds = fields.filter(field => field.bind).map(field => field.bind)
    if (new Set(binds).size !== binds.length) diagnostic('创建字段绑定重复')
    for (const field of fields) {
      if (field.type !== 'input' && !field.options?.length && !field.source) diagnostic('创建字段缺少选项：' + field.id)
      const refs = [...Object.keys(field.when || {}), ...(field.options || []).flatMap(option => Object.keys(option.when || {}))]
      if (refs.some(ref => ref === field.id || !ids.includes(ref))) diagnostic('创建字段的条件引用无效：' + field.id)
      if (field.readOnly && (!field.bind || field.default === undefined || field.source)) diagnostic('只读字段必须绑定固定默认值')
    }
    for (const binding of Object.values(studio.tasks || {})) if (binding.pluginId && binding.pluginId !== m.id || !m.actions?.some(action => action.id === binding.action)) diagnostic('任务必须引用当前包的已声明动作')
    if (studio.skillAssetGroup && !m.assets?.[studio.skillAssetGroup]) diagnostic('工作台 skills 资源组不存在')
  }
  return m
}
async function main() {
  // Compile an immutable snapshot. Edits made during a build never leak into its output.
  const id = randomUUID()
  const staging = path.join(root, '.modmind-dev', 'builds', id)
  const snapshot = path.join(staging, 'source')
  const output = path.join(staging, 'package')
  await fs.mkdir(snapshot, { recursive: true }); await fs.mkdir(output)
  for (const file of sources) {
    const destination = path.join(snapshot, ...file.path.split('/'))
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, Buffer.from(file.base64, 'base64'))
  }
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'), 'utf8')))
  const built = []
  if (sourceMode === 'package') {
    for (const entry of ['main.cjs', 'renderer.js', 'renderer.css']) if (!sources.some(file => file.path === entry)) diagnostic('缺少入口文件：' + entry, entry)
    for (const file of sources.filter(file => ['main.cjs', 'renderer.js', 'renderer.css'].includes(file.path) || file.path.startsWith('assets/'))) {
      const source = path.join(snapshot, file.path), destination = path.join(output, file.path)
      if (file.path === 'main.cjs' || file.path === 'renderer.js') {
        try {
          const code = await fs.readFile(source, 'utf8')
          if (file.path === 'main.cjs') compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file.path })
          else new Script(code, { filename: file.path })
        } catch (error) { diagnostic('JavaScript 语法错误：' + error.message, file.path) }
      }
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); built.push(file.path)
    }
  } else {
    for (const entry of ['main.ts', 'renderer.tsx']) if (!sources.some(file => file.path === entry)) diagnostic('缺少入口文件：' + entry, entry)
    const libs = path.join(kit, 'typescript-lib')
    const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, types: ['node'], typeRoots: [path.join(kit, 'types')],
      baseUrl: snapshot, paths: { '@modmind/sdk': ['sdk/index.d.ts'], 'react': [path.join(kit, 'types/react/index.d.ts')], 'react/*': [path.join(kit, 'types/react/*')],
        'react-dom': [path.join(kit, 'types/react-dom/index.d.ts')], 'react-dom/*': [path.join(kit, 'types/react-dom/*')], 'lucide-react': [path.join(kit, 'lucide.d.ts')] } }
    const host = ts.createCompilerHost(compilerOptions)
    host.getDefaultLibFileName = () => path.join(libs, 'lib.es2022.full.d.ts')
    host.getDefaultLibLocation = () => libs
    const program = ts.createProgram(sources.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => path.join(snapshot, file.path)), compilerOptions, host)
    const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error).slice(0, 80).map(item => {
      const position = item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : null
      return { file: item.file ? path.relative(snapshot, item.file.fileName).replaceAll('\\', '/') : undefined, line: position ? position.line + 1 : undefined, column: position ? position.character + 1 : undefined, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }
    })
    if (diagnostics.length) throw Object.assign(new Error('类型检查未通过'), { diagnostics })
    const mainSource = program.getSourceFile(path.join(snapshot, 'main.ts'))
    const moduleSymbol = mainSource && program.getTypeChecker().getSymbolAtLocation(mainSource)
    if (!moduleSymbol || !program.getTypeChecker().getExportsOfModule(moduleSymbol).some(symbol => symbol.name === 'activate')) diagnostic('main.ts 必须导出 activate()', 'main.ts')
    const hostShims = JSON.parse(await fs.readFile(path.join(kit, 'shims.json'), 'utf8'))
    const rendererSdk = `export function registerFeature(id,module) { const exports = Object.fromEntries([...module.pages,...(module.settings||[])].map(entry=>[entry.exportName||entry.id,entry.component])); window.__modmindRegisterFeature(id,{...module,...exports}); }`
    const confinement = platform => ({ name: 'developer-workspace', setup(build) {
      build.onResolve({ filter: /.*/ }, async args => {
        if (platform === 'browser' && args.path === 'lucide-react') return { path: path.join(kit, 'icons.mjs') }
        if (platform === 'browser' && hostShims[args.path]) return { path: args.path, namespace: 'host' }
        if (args.path === '@modmind/sdk') return { path: args.path, namespace: 'sdk' }
        if (platform === 'node' && (args.path.startsWith('node:') || builtinModules.includes(args.path))) return { path: args.path, external: true }
        if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) return { errors: [{ text: '当前开发工具未内置依赖：' + args.path }] }
        const target = path.resolve(args.resolveDir, args.path)
        if (!inside(snapshot, target)) return { errors: [{ text: '导入超出开发工程：' + args.path }] }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: hostShims[args.path], loader: 'js' }))
      build.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({ contents: platform === 'browser' ? rendererSdk : '', loader: 'js' }))
    } })
    const common = { bundle: true, sourcemap: false, logLevel: 'silent', absWorkingDir: snapshot, metafile: true,
      loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl' } }
    const backend = await esbuild.build({ ...common, entryPoints: [path.join(snapshot, 'main.ts')], outfile: path.join(output, 'main.cjs'), platform: 'node', format: 'cjs', target: 'node22', plugins: [confinement('node')] })
    const frontend = await esbuild.build({ ...common, entryPoints: [path.join(snapshot, 'renderer.tsx')], outfile: path.join(output, 'renderer.js'), platform: 'browser', format: 'iife', minify: true, jsx: 'automatic', plugins: [confinement('browser')] })
    if (!await fs.stat(path.join(output, 'renderer.css')).catch(() => null)) await fs.writeFile(path.join(output, 'renderer.css'), '')
    built.push('main.cjs', 'renderer.js', 'renderer.css')
    for (const [group, directory] of Object.entries(manifest.assets || {})) {
      if (!/^[a-z0-9-]+$/.test(group) || typeof directory !== 'string' || !directory || directory.split('/').some(part => part === '..' || part === '.' || !part) || directory.includes('\\')) diagnostic('资源目录无效：' + group)
      const matching = sources.filter(file => file.path.startsWith(directory + '/'))
      if (!matching.length) diagnostic('资源目录为空或不存在：' + directory)
      for (const file of matching) {
        const relative = 'assets/' + group + '/' + file.path.slice(directory.length + 1)
        const destination = path.join(output, relative)
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(snapshot, file.path), destination); built.push(relative)
      }
    }
    const notices = await fs.readFile(path.join(kit, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    for (const file of ['main.cjs', 'renderer.js']) await fs.appendFile(path.join(output, file), '\n/*!\n' + notices.replaceAll('*/', '* /') + '\n*/\n')
    manifest.hostCapabilities = [...new Set([...(manifest.hostCapabilities || []), 'runtime'])]
  }
  if (built.length > 512) diagnostic('包内文件超过 512 个')
  if (new Set(built.map(file => file.toLowerCase())).size !== built.length) diagnostic('包内资源存在大小写重名')
  manifest.files = {}
  let bytes = 0
  for (const file of built) { const data = await fs.readFile(path.join(output, file)); bytes += data.length; manifest.files[file] = sha(data) }
  if (bytes > 128 * 1024 * 1024) diagnostic('解压后的包超过 128 MiB')
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const archive = path.join(staging, manifest.id + (manifest.studios?.length ? '.mmstudio' : '.mmfeature'))
  await new Promise((resolve, reject) => {
    const stream = syncFs.createWriteStream(archive), zip = archiver('zip', { zlib: { level: 9 } })
    stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject); zip.pipe(stream)
    for (const file of ['manifest.json', ...built].sort()) zip.file(path.join(output, file), { name: file, date: new Date('2000-01-01') })
    void zip.finalize().catch(reject)
  })
  const size = (await fs.stat(archive)).size
  if (size > 64 * 1024 * 1024) diagnostic('安装包超过 64 MiB')
  return { id, sourceRevision, manifest, completedAt: new Date().toISOString(), bytes: size, archiveSha256: sha(await fs.readFile(archive)) }
}
main().then(result => parentPort.postMessage({ ok: true, result })).catch(error => parentPort.postMessage({ ok: false, error: String(error?.message || error), diagnostics: error.diagnostics || error.errors?.map(item => ({ file: item.location?.file, line: item.location?.line, column: item.location?.column + 1, message: item.text })) }))
