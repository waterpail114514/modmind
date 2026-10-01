import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, appendFile, access, cp } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const archiver = require('archiver')
const root = path.resolve(import.meta.dirname, '..')
const outputRoot = path.join(root, 'feature-plugin-dist')
await mkdir(outputRoot, { recursive: true })
const host = (filter, contents) => ({ name: 'host-' + filter.source.replace(/\W/g, ''), setup(b) {
  b.onResolve({ filter }, a => ({ path: a.path, namespace: 'host-' + filter.source.replace(/\W/g, '') }))
  b.onLoad({ filter: /.*/, namespace: 'host-' + filter.source.replace(/\W/g, '') }, () => ({ contents, loader: 'js' }))
}})
const exportsOf = (name, value) => `const value = window.__modmindFeatureHost.${value}; export default value;\n` + Object.keys(require(name)).filter(k => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k)).map(k => `export const ${k} = value.${k};`).join('\n')
const definitions = []
const only = process.argv.find(argument => argument.startsWith('--only='))?.slice(7)
const exists = file => access(file).then(() => true, () => false)
const sharedModules = ['diagnosticLog', 'downloadActivityService', 'downloadService', 'modpackService', 'modpackContentMetadata', 'curseForgePackMetadata', 'agentProtection', 'nativeFeatureServices', 'networkRequest', 'processTree', 'documentRead', 'projectTextRead', 'inspirationResearch']
const sharedShims = []
for (const name of sharedModules) {
  const source = ts.createSourceFile(name, await readFile(path.join(root, 'src/main', name + '.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const names = source.statements.flatMap(statement => {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) return statement.exportClause.elements.filter(element => !element.isTypeOnly).map(element => element.name.text)
    if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return []
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name)).map(declaration => declaration.name.text)
    return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name ? [statement.name.text] : []
  })
  sharedShims.push(host(new RegExp(`(?:^|/)${name}(?:\\.ts)?$`), `const value = require('@modmind/host').runtime.${name};\n` + names.map(key => `export const ${key} = value.${key};`).join('\n')))
}
for (const entry of await readdir(path.join(root, 'feature-plugins'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !await exists(path.join(root, 'feature-plugins', entry.name, 'manifest.json'))) continue
  const source = path.join(root, 'feature-plugins', entry.name)
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
  const nativeBinaries = manifest.nativeBinaries ?? {}
  delete manifest.nativeBinaries
  if (Object.keys(nativeBinaries).length) manifest.target = { platform: process.platform, arch: process.arch }
  manifest.hostCapabilities = [...new Set([...(manifest.hostCapabilities ?? []), 'runtime'])]
  if (await exists(path.join(source, 'main-contributions.json'))) {
    const contributions = JSON.parse(await readFile(path.join(source, 'main-contributions.json'), 'utf8'))
    for (const key of ['actions', 'tools']) {
      const entries = [...(manifest[key] ?? []), ...(contributions[key] ?? [])]
      const unique = new Map(entries.map(entry => [entry.id ?? entry.name, entry]))
      if (unique.size !== entries.length) throw new Error(`Duplicate ${key} contribution: ${entry.name}`)
      manifest[key] = [...unique.values()]
    }
  }
  if (manifest.id !== entry.name || manifest.apiVersion !== 2 || manifest.format !== 'modmind-feature' || manifest.main !== 'main.cjs' || manifest.renderer !== 'renderer.js' || manifest.style !== 'renderer.css') throw new Error(`Invalid feature manifest: ${entry.name}`)
  const { files: _files, ...definition } = manifest
  definitions.push(definition)
  if (only && only !== manifest.id) continue
  const output = path.join(outputRoot, manifest.id)
  await mkdir(output, { recursive: true })
  const mainBuild = await build({ entryPoints: [path.join(source, 'main.ts')], outfile: path.join(output, 'main.cjs'), bundle: true, metafile: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp', 'ffmpeg-static', '@modmind/host', '7zip-bin', 'pdfjs-dist'], plugins: sharedShims })
  const rendererEntry = path.join(source, await exists(path.join(source, 'renderer.tsx')) ? 'renderer.tsx' : 'renderer.ts')
  const rendererBuild = await build({ entryPoints: [rendererEntry], outfile: path.join(output, 'renderer.js'), bundle: true, metafile: true, minify: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.hot': 'undefined', 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_IMAGE_TRACE': '"0"', 'import.meta.env.VITE_IMAGE_LOG_ENDPOINT': '""' }, plugins: [
    host(/^react$/, exportsOf('react', 'React')),
    host(/^react-dom$/, exportsOf('react-dom', 'ReactDOM')),
    host(/^react\/jsx-runtime$/, exportsOf('react/jsx-runtime', 'jsxRuntime')),
    host(/InteractionDialogs$/, 'export const { useConfirmDialog, usePromptDialog } = window.__modmindFeatureHost.dialogs'),
    host(/MiniPaintEditor$/, 'export default window.__modmindFeatureHost.MiniPaintEditor')
  ] })
  if (!Object.values(rendererBuild.metafile.outputs).some(file => file.cssBundle)) await writeFile(path.join(output, 'renderer.css'), '')
  for (const [name, input] of Object.entries(manifest.assets ?? {})) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid asset group: ${name}`)
    const sourcePath = path.resolve(root, input)
    const relative = path.relative(root, sourcePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Asset source outside repository: ${input}`)
    await cp(sourcePath, path.join(output, 'assets', name), { recursive: true, dereference: false })
  }
  if (Object.keys(nativeBinaries).length) {
    const directory = path.join(output, 'assets', 'native')
    await mkdir(directory, { recursive: true })
    const binaries = {}
    for (const [name, packageName] of Object.entries(nativeBinaries)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof packageName !== 'string') throw new Error('Invalid native binary declaration')
      const binary = require(packageName)
      if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw new Error(`Native binary unavailable: ${packageName}`)
      const file = name + path.extname(binary), bytes = await readFile(binary)
      await writeFile(path.join(directory, file), bytes)
      binaries[name] = { file, sha256: createHash('sha256').update(bytes).digest('hex') }
      for (const suffix of ['LICENSE', 'README']) if (await exists(binary + '.' + suffix)) await cp(binary + '.' + suffix, path.join(directory, name + '-' + suffix + '.txt'))
    }
    await writeFile(path.join(directory, 'binaries.json'), JSON.stringify({ platform: process.platform, arch: process.arch, binaries }, null, 2))
  }
  // Keep upstream licenses inside each portable artifact, including transitive code.
  const packages = new Set([...Object.keys(rendererBuild.metafile.inputs), ...Object.keys(mainBuild.metafile.inputs)].flatMap(file => {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file.replaceAll('\\', '/'))
    return match ? [match[1]] : []
  }))
  for (const name of Object.values(nativeBinaries)) packages.add(name)
  const notices = [await readFile(path.join(root, 'LICENSE'), 'utf8'), await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')]
  for (const name of [...packages].sort()) {
    const directory = path.join(root, 'node_modules', name)
    for (const file of await readdir(directory)) if (/^(?:license|licence|copying)(?:\.|$)/i.test(file)) notices.push(`${name}\n${await readFile(path.join(directory, file), 'utf8')}`)
  }
  const legal = `\n/*! ${manifest.name} and bundled component notices\n` + notices.join('\n\n').replaceAll('*/', '* /') + '\n*/\n'
  await appendFile(path.join(output, 'renderer.js'), legal)
  await appendFile(path.join(output, 'main.cjs'), legal)
  const files = {}
  for (const file of ['main.cjs', 'renderer.js', 'renderer.css']) files[file] = createHash('sha256').update(await readFile(path.join(output, file))).digest('hex')
  async function hashAssets(directory, prefix) {
    if (!await exists(directory)) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Asset links are not portable: ${name}`)
      if (entry.isDirectory()) await hashAssets(file, name)
      else if (entry.isFile()) files[name] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
  await hashAssets(path.join(output, 'assets'), 'assets')
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ ...definition, files }, null, 2))
  const archivePath = path.join(outputRoot, `${manifest.id}.mmfeature`)
  await new Promise((resolve, reject) => {
    const out = createWriteStream(archivePath), zip = archiver('zip', { zlib: { level: 9 } })
    out.on('close', resolve); out.on('error', reject); zip.on('error', reject); zip.pipe(out)
    for (const file of ['manifest.json', ...Object.keys(files)]) zip.file(path.join(output, file), { name: file })
    zip.finalize()
  })
  await writeFile(path.join(output, 'build-inputs.json'), JSON.stringify({ main: Object.keys(mainBuild.metafile.inputs), renderer: Object.keys(rendererBuild.metafile.inputs) }, null, 2))
  console.log(archivePath)
}
if (only && !definitions.some(definition => definition.id === only)) throw new Error(`Unknown feature: ${only}`)
await writeFile(path.join(outputRoot, 'catalog.json'), JSON.stringify(definitions, null, 2))
await writeFile(path.join(root, 'src/shared/featurePluginCatalog.json'), JSON.stringify(definitions, null, 2))
