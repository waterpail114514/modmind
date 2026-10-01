import ts from 'typescript'
import { access, readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const features = path.join(root, 'feature-plugins')
const aliases = { items: 'item-editor', sounds: 'sound-studio', models: 'model-studio', dependencies: 'relationships' }
const exists = file => access(file).then(() => true, () => false)
const movedRendererFiles = new Map()
for (const name of ['BeepBoxEditor.tsx', 'beepboxMusic.ts', 'soundStudioEngine.ts']) {
  const source = path.join(root, 'src/renderer/src/components', name), target = path.join(features, 'sound-studio/components', name)
  if (await exists(source)) { movedRendererFiles.set(source, target); await rename(source, target) }
}
const originalRendererPaths = new Map([...movedRendererFiles].map(([source, target]) => [target, source]))
const beepboxSource = path.join(root, 'resources/renderer-public/beepbox'), beepboxTarget = path.join(features, 'sound-studio/assets/beepbox')
if (await exists(beepboxSource)) { await mkdir(path.dirname(beepboxTarget), { recursive: true }); await rename(beepboxSource, beepboxTarget) }
for (const [oldId, id] of Object.entries(aliases)) {
  const source = path.join(features, oldId), target = path.join(features, id)
  if (!await exists(source)) continue
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source)) {
    if (await exists(path.join(target, entry))) throw new Error(`Conflicting plugin source: ${id}/${entry}`)
    await rename(path.join(source, entry), path.join(target, entry))
  }
}

async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { await rewrite(file); continue }
    if (!/\.(?:ts|tsx|mjs)$/.test(entry.name) || file === import.meta.filename) continue
    const source = await readFile(file, 'utf8')
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, entry.name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const edits = []
    function visit(node) {
      if (ts.isStringLiteral(node)) {
        let value = node.text
        const isModule = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isImportTypeNode(node.parent?.parent)
        if (isModule && value.startsWith('.')) {
          const original = originalRendererPaths.get(file) ?? file
          const absolute = path.resolve(path.dirname(original), value)
          const moved = [...movedRendererFiles].find(([source]) => source === absolute || source.replace(/\.(?:ts|tsx)$/, '') === absolute)
          if (original !== file || moved) {
            const target = moved ? (path.extname(value) ? moved[1] : moved[1].replace(/\.(?:ts|tsx)$/, '')) : absolute
            value = path.relative(path.dirname(file), target).replaceAll('\\', '/')
            if (!value.startsWith('.')) value = './' + value
          }
        }
        for (const [oldId, id] of Object.entries(aliases)) {
          value = value.replaceAll(`feature-plugins/${oldId}/`, `feature-plugins/${id}/`)
          if (file.startsWith(features)) value = value.replace(new RegExp(`^((?:\\.\\./)+)${oldId}/`), `$1${id}/`)
          const call = node.parent
          if (value === oldId && ts.isCallExpression(call) && /(?:featurePluginService|nativeFeatureFunction|nativeFeatureService)/.test(call.expression.getText(ast))) value = id
          if (value === oldId && ts.isCallExpression(call) && call.expression.getText(ast) === 'path.join' && call.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === 'feature-plugins')) value = id
        }
        if (value !== node.text) edits.push({ start: node.getStart(ast) + 1, end: node.end - 1, text: value })
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    let result = source
    for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    if (result !== source) await writeFile(file, result)
  }
}
for (const directory of ['src', 'feature-plugins', 'scripts']) await rewrite(path.join(root, directory))

const renderers = JSON.parse(await readFile(path.join(features, 'renderer-contributions.json'), 'utf8'))
for (const [id, renderer] of Object.entries(renderers)) {
  const directory = path.join(features, id), file = path.join(directory, 'manifest.json')
  const existing = await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : {}
  const manifest = { format: 'modmind-feature', apiVersion: 2, hostVersion: '1.5.0-plugintest', id,
    name: renderer.capabilities?.[0]?.name ?? renderer.views?.[0]?.label ?? id, version: '1.5.0-plugintest',
    main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', ...existing, ...renderer }
  if (id === 'model-studio') manifest.assets = { blockbench: `feature-plugins/${id}/assets/blockbench` }
  if (id === 'decompile') manifest.assets = { 'decompile-tools': `feature-plugins/${id}/assets/decompile-tools` }
  if (id === 'sound-studio') manifest.assets = { beepbox: `feature-plugins/${id}/assets/beepbox` }
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
  if (!await exists(path.join(directory, 'main.ts'))) await writeFile(path.join(directory, 'main.ts'), 'export function activate() { return { actions: {} } }\n')
}
console.log(`Merged renderer manifests for ${Object.keys(renderers).length} plugins`)
const imageFile = path.join(features, 'image-studio', 'manifest.json')
const image = JSON.parse(await readFile(imageFile, 'utf8'))
const descriptors = JSON.parse(await readFile(path.join(root, 'feature-plugin-dist', 'legacy-tool-descriptors.json'), 'utf8'))
for (const tool of image.tools) {
  const descriptor = descriptors.find(value => value.name === tool.name)
  const action = image.actions.find(value => value.id === tool.action)
  action.inputSchema = descriptor.inputSchema
  if (tool.name !== 'modmind_image_studio_info') { action.inspirationOutput = true; action.projectRequired = true }
  tool.description = descriptor.description
}
image.settings.find(value => value.id === 'settings-image').category = 'ai'
await writeFile(imageFile, JSON.stringify(image, null, 2) + '\n')

for (const entry of await readdir(features, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const file = path.join(features, entry.name, 'main.ts')
  if (!await exists(file)) continue
  const source = await readFile(file, 'utf8')
  const result = source.replaceAll(/(actions\["[^"]+"\] = )input => createMcpHandlers\(host\.requireProject\(\)\)/g, '$1(input, context) => createMcpHandlers(host.requireProject(), context.signal)')
  if (result !== source) await writeFile(file, result)
}
