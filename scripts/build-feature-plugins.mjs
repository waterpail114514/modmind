import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, appendFile, access, cp, rm, rename } from 'node:fs/promises'
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
const sharedModules = ['buildRuntime', 'creationFeedbackService', 'diagnosticLog', 'downloadActivityService', 'downloadService', 'modpackService', 'modpackContentMetadata', 'curseForgePackMetadata', 'agentProtection', 'nativeFeatureServices', 'networkRequest', 'processTree', 'documentRead', 'projectTextRead', 'inspirationResearch', 'studioRegistry', 'projectTemplates', 'projectMutation']
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
  const assetFiles = manifest.assetFiles ?? {}
  const assetChunks = manifest.assetChunks ?? {}
  delete manifest.nativeBinaries
  delete manifest.assetFiles
  delete manifest.assetChunks
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
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new Error(`Release versions must have three numeric components: ${manifest.id}`)
  if (manifest.id === 'shader-testing') {
    const agent = JSON.parse(await readFile(path.join(root, 'feature-plugins/shader-shared/src/main/shaderSessionAgent.json'), 'utf8'))
    const sourceHash = createHash('sha256').update((await readFile(path.join(root, 'resources/shader-runtime/ShaderSessionAgent.java'), 'utf8')).replaceAll('\r\n', '\n')).digest('hex')
    if (agent.sourceSha256 !== sourceHash) throw new Error('Shader session adapter is stale; run node scripts/compile-shader-session-agent.mjs')
  }
  const output = path.join(outputRoot, manifest.id)
  const relativeOutput = path.relative(outputRoot, path.resolve(output))
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(relativeOutput)) throw new Error(`Invalid feature output: ${manifest.id}`)
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const mainBuild = await build({ entryPoints: [path.join(source, 'main.ts')], outfile: path.join(output, 'main.cjs'), bundle: true, metafile: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp', 'ffmpeg-static', '@modmind/host', '7zip-bin', 'pdfjs-dist'], plugins: sharedShims })
  const rendererEntry = path.join(source, await exists(path.join(source, 'renderer.tsx')) ? 'renderer.tsx' : 'renderer.ts')
  const rendererBuild = await build({ entryPoints: [rendererEntry], outfile: path.join(output, 'renderer.js'), bundle: true, metafile: true, minify: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.hot': 'undefined', 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_IMAGE_TRACE': '"0"', 'import.meta.env.VITE_IMAGE_LOG_ENDPOINT': '""' }, plugins: [
    host(/^react$/, exportsOf('react', 'React')),
    host(/^react-dom$/, exportsOf('react-dom', 'ReactDOM')),
    host(/^react\/jsx-runtime$/, exportsOf('react/jsx-runtime', 'jsxRuntime')),
    host(/InteractionDialogs$/, 'export const { useConfirmDialog, usePromptDialog } = window.__modmindFeatureHost.dialogs'),
    host(/MiniPaintEditor$/, 'export default window.__modmindFeatureHost.MiniPaintEditor'),
    host(/MonacoCodeEditor$/, 'export default window.__modmindFeatureHost.MonacoCodeEditor')
  ] })
  if (!Object.values(rendererBuild.metafile.outputs).some(file => file.cssBundle)) await writeFile(path.join(output, 'renderer.css'), '')
  for (const [name, input] of Object.entries(manifest.assets ?? {})) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid asset group: ${name}`)
    const sourcePath = path.resolve(root, input)
    const relative = path.relative(root, sourcePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Asset source outside repository: ${input}`)
    const skillStudios = (manifest.studios ?? []).filter(studio => studio.skillAssetGroup === name)
    if (skillStudios.length) {
      const names = [...new Set(skillStudios.flatMap(studio => Object.values(studio.ai).flatMap(profile => [...profile.skills, ...(profile.variants ?? []).flatMap(variant => variant.skills)])))]
      for (const skill of names) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(skill)) throw new Error('Invalid studio skill name')
        await cp(path.join(sourcePath, skill), path.join(output, 'assets', name, skill), { recursive: true, dereference: false })
      }
    } else if (assetFiles[name]) {
      for (const file of assetFiles[name]) {
        if (typeof file !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(file) || file === '.' || file === '..') throw new Error(`Invalid asset file: ${name}/${file}`)
        const destination = path.join(output, 'assets', name, file)
        await mkdir(path.dirname(destination), { recursive: true })
        await cp(path.join(sourcePath, file), destination, { dereference: false })
      }
    } else await cp(sourcePath, path.join(output, 'assets', name), { recursive: true, dereference: false })
  }
  for (const [name, chunk] of Object.entries(assetChunks)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isSafeInteger(chunk.length) || chunk.length <= 0) throw new Error(`Invalid asset chunk: ${name}`)
    const sourcePath = path.resolve(root, chunk.source), relative = path.relative(root, sourcePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Asset chunk outside repository: ${name}`)
    const bytes = await readFile(sourcePath)
    if (chunk.offset + chunk.length > bytes.length) throw new Error(`Asset chunk exceeds source: ${name}`)
    const destination = path.join(output, 'assets', 'chunks', name + '.part')
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes.subarray(chunk.offset, chunk.offset + chunk.length))
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
  const archivePath = path.join(outputRoot, `${manifest.id}.${manifest.studios?.length ? 'mmstudio' : 'mmfeature'}`)
  await new Promise((resolve, reject) => {
    const out = createWriteStream(archivePath), zip = archiver('zip', { zlib: { level: 9 } })
    out.on('close', resolve); out.on('error', reject); zip.on('error', reject); zip.pipe(out)
    for (const file of ['manifest.json', ...Object.keys(files)].sort()) zip.file(path.join(output, file), { name: file, date: new Date('2000-01-01T00:00:00.000Z') })
    zip.finalize()
  })
  await writeFile(path.join(output, 'build-inputs.json'), JSON.stringify({ main: Object.keys(mainBuild.metafile.inputs), renderer: Object.keys(rendererBuild.metafile.inputs) }, null, 2))
  console.log(archivePath)
}
if (only && !definitions.some(definition => definition.id === only)) throw new Error(`Unknown feature: ${only}`)
const catalogContent = JSON.stringify(definitions, null, 2)
async function writeCatalog(file) {
  const previous = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (previous === catalogContent) return
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, catalogContent)
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break }
      catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN'].includes(error.code) || attempt >= 6) throw error
        await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000)))
      }
    }
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}
await writeCatalog(path.join(outputRoot, 'catalog.json'))
await writeCatalog(path.join(root, 'src/shared/featurePluginCatalog.json'))
