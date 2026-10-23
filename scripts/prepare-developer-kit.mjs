import { build } from 'esbuild'
import ts from 'typescript'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'resources/developer-kit-src')
const output = path.join(root, 'resources/developer-kit')
const realRoot = await fs.realpath(root), realParent = await fs.realpath(path.dirname(output))
const relativeParent = path.relative(realRoot, realParent)
if (!relativeParent || relativeParent.startsWith('..') || path.isAbsolute(relativeParent) || (await fs.lstat(output).catch(() => null))?.isSymbolicLink()) throw new Error('Developer kit output must remain inside workspace resources')
await fs.rm(output, { recursive: true, force: true })
await fs.mkdir(output, { recursive: true })
const bundles = []
const workers = { name: 'preview-workers', setup(builder) {
  builder.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.slice(0, -7), { paths: [args.resolveDir] }), namespace: 'preview-worker' }))
  builder.onLoad({ filter: /.*/, namespace: 'preview-worker' }, async args => {
    const compiled = await build({ entryPoints: [args.path], bundle: true, minify: true, platform: 'browser', format: 'iife', write: false })
    return { contents: `export default class extends Worker { constructor() { const url = URL.createObjectURL(new Blob([${JSON.stringify(compiled.outputFiles[0].text)}], {type:'text/javascript'})); super(url); URL.revokeObjectURL(url); } }`, loader: 'js' }
  })
} }
bundles.push(await build({ entryPoints: [path.join(source, 'preview.tsx')], outfile: path.join(output, 'preview.js'), metafile: true, bundle: true, minify: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.ttf': 'dataurl' }, plugins: [workers], define: { 'process.env.NODE_ENV': '"production"' } }))
bundles.push(await build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(output, 'preview-api.js'), metafile: true, bundle: true, minify: true, platform: 'browser', format: 'iife', plugins: [{ name: 'preview-electron', setup(builder) { builder.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(source, 'preview-electron.ts') })) } }] }))
bundles.push(await build({ entryPoints: [path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/esm/lucide-react.js')], outfile: path.join(output, 'icons.mjs'), metafile: true, bundle: true, platform: 'browser', format: 'esm', external: ['react'] }))
for (const file of ['build-worker.cjs', 'runtime.cjs', 'preview-capture-preload.cjs']) bundles.push(await build({ entryPoints: [path.join(source, file)], outfile: path.join(output, file), metafile: true, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'warning' }))
await fs.copyFile(path.join(source, 'sdk.d.ts'), path.join(output, 'sdk.d.ts'))
const tsDir = path.dirname(require.resolve('typescript'))
await fs.mkdir(path.join(output, 'typescript-lib'), { recursive: true })
for (const name of await fs.readdir(tsDir)) if (/^lib\..*\.d\.ts$/.test(name)) await fs.copyFile(path.join(tsDir, name), path.join(output, 'typescript-lib', name))
for (const name of ['react', 'react-dom', 'node']) await fs.cp(path.join(root, 'node_modules/@types', name), path.join(output, 'types', name), { recursive: true })
// Types resolve sibling packages via their containing node_modules directory.
await fs.mkdir(path.join(output, 'node_modules'), { recursive: true })
// esbuild resolves its own installation at runtime. Keep its JS package intact.
const esbuildDirectory = path.dirname(require.resolve('esbuild/package.json'))
await fs.cp(esbuildDirectory, path.join(output, 'node_modules/esbuild'), { recursive: true })
for (const name of ['csstype', 'undici-types']) await fs.cp(path.join(root, 'node_modules', name), path.join(output, 'node_modules', name), { recursive: true })
const icons = await fs.readFile(path.join(root, 'node_modules/lucide-react/dist/lucide-react.d.ts'), 'utf8')
await fs.writeFile(path.join(output, 'lucide.d.ts'), icons)
const shims = {}
for (const [name, value] of [['react', 'window.__modmindFeatureHost.React'], ['react-dom', 'window.__modmindFeatureHost.ReactDOM'], ['react-dom/client', 'window.__modmindFeatureHost.ReactDOM'], ['react/jsx-runtime', 'window.__modmindFeatureHost.jsxRuntime']]) {
  const exports = Object.keys(require(name)).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))
  shims[name] = `const value = ${value}; export default value;\n` + exports.map(key => `export const ${key} = value.${key};`).join('\n')
}
// ReactDOM/client uses createRoot, kept on the shared preview host too.
await fs.writeFile(path.join(output, 'shims.json'), JSON.stringify(shims))
const schemaSource = ts.transpileModule(await fs.readFile(path.join(root, 'src/shared/studioSchema.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const schemaExports = {}; new Function('exports', schemaSource)(schemaExports)
const str = { type: 'string', minLength: 1, maxLength: 80 }
const scope = { studioIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: str }, loaders: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: str } }
const entries = (required, properties) => ({ type: 'array', maxItems: 128, items: { type: 'object', required, properties, additionalProperties: false } })
const schema = { type: 'object', required: ['format', 'apiVersion', 'hostVersion', 'id', 'name', 'version', 'main', 'renderer', 'style'], additionalProperties: false, properties: {
  format: { const: 'modmind-feature' }, apiVersion: { const: 2 }, hostVersion: { const: '1.5.0-plugintest' }, id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, name: str,
  version: { type: 'string', pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' }, main: { const: 'main.cjs' }, renderer: { const: 'renderer.js' }, style: { const: 'renderer.css' }, ...scope,
  capabilities: entries(['id', 'name', 'description'], { id: str, name: str, description: { type: 'string', minLength: 1, maxLength: 2000 } }),
  views: entries(['id', 'label', 'component', 'icon'], { id: str, label: str, component: str, icon: str, group: str, order: { type: 'number' }, ...scope }),
  settings: { type: 'array', maxItems: 0 },
  actions: entries(['id', 'handler', 'permission', 'inputSchema'], { id: str, handler: str, permission: { enum: ['read', 'write', 'network', 'process'] }, inputSchema: { type: 'object' }, projectRequired: { type: 'boolean' }, surfaces: { type: 'array', uniqueItems: true, items: { enum: ['workbench', 'inspiration'] } }, inspirationOutput: { type: 'boolean' }, ...scope }),
  tools: entries(['name', 'action', 'description'], { name: { type: 'string', pattern: '^modmind_[a-z0-9_]+$' }, action: str, description: { type: 'string', minLength: 1, maxLength: 4000 } }),
  studios: { type: 'array', maxItems: 128, items: schemaExports.STUDIO_DEFINITION_SCHEMA },
  hostCapabilities: { type: 'array', uniqueItems: true, items: { enum: ['runtime', 'studioV1'] } }, dependencies: { type: 'array', maxItems: 0 },
  events: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9:_-]{0,79}$' } }, assets: { type: 'object', additionalProperties: { type: 'string' } }
} }
await fs.writeFile(path.join(output, 'manifest.schema.json'), JSON.stringify(schema))
const binaryPackage = `@esbuild/${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
const binary = path.join(path.dirname(require.resolve(binaryPackage + '/package.json')), process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild')
await fs.copyFile(binary, path.join(output, process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'))
if (process.platform !== 'win32') await fs.chmod(path.join(output, 'esbuild'), 0o755)
const notices = ['ModMind developer kit: AGPL-3.0-only. Packaged third-party components retain their licenses.\n' + await fs.readFile(path.join(root, 'LICENSE'), 'utf8')]
const packages = new Set(bundles.flatMap(bundle => Object.keys(bundle.metafile.inputs).flatMap(file => { const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(file.replace(/^preview-worker:/, '').replaceAll('\\', '/')); return match ? [path.resolve(root, match[1])] : [] })))
packages.add(esbuildDirectory)
for (const directory of [...packages].sort()) {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  for (const file of await fs.readdir(directory)) if (/^(license|licence|copying)(\.|$)/i.test(file)) notices.push(metadata.name + ' ' + metadata.version + '\n' + await fs.readFile(path.join(directory, file), 'utf8'))
}
await fs.writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'))
for (const file of ['developer-workbench.zh-CN.md', 'extensions-development.zh-CN.md', 'mmfeature-development.zh-CN.md', 'mmstudio-development.zh-CN.md', 'design-spec.zh-CN.md', 'theme-system.zh-CN.md']) await fs.copyFile(path.join(root, 'docs', file), path.join(output, file))
console.log('Developer kit ready: ' + output)
