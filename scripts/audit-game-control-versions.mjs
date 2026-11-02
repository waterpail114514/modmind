import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { XMLParser } from 'fast-xml-parser'

// Metadata audit only. Never downloads clients, assets, Java runtimes or starts a game.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(root, 'test-results/game-control-version-audit')
const output = path.join(root, 'docs/game-control-compatibility')
const offline = process.argv.includes('--offline')
const refresh = process.argv.includes('--refresh')
const sources = {
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabric: 'https://meta.fabricmc.net/v2/versions/game',
  quilt: 'https://meta.quiltmc.org/v3/versions/game',
  forge: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
  neoforge: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  neoTransition: 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml'
}
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n')
await fs.mkdir(cache, { recursive: true })
await fs.mkdir(path.join(cache, 'metadata'), { recursive: true })
await fs.mkdir(output, { recursive: true })
let networkBytes = 0
const provenance = {}

async function getBytes(url, maxBytes = 2 * 1024 * 1024) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { 'User-Agent': 'ModMind-game-control-metadata-audit' } })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > maxBytes) throw new Error('response exceeds metadata limit')
        chunks.push(chunk)
      }
      networkBytes += size
      return Buffer.concat(chunks)
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  throw new Error(`${url}: ${lastError}`)
}

async function sourceBytes(name) {
  const file = path.join(cache, `${name}.source`)
  let bytes
  if (offline) bytes = await fs.readFile(file)
  else { bytes = await getBytes(sources[name]); await fs.writeFile(file, bytes) }
  provenance[name] = { url: sources[name], sha256: hash(bytes), bytes: bytes.length }
  return bytes
}

const catalogs = {}
await Promise.all(Object.keys(sources).map(async name => {
  try { catalogs[name] = (await sourceBytes(name)).toString('utf8') }
  catch (error) { provenance[name] = { url: sources[name], error: String(error) } }
}))
if (!catalogs.manifest) throw new Error('official version manifest unavailable; cannot establish completeness')
const manifest = JSON.parse(catalogs.manifest)
assert.equal(new Set(manifest.versions.map(version => version.id)).size, manifest.versions.length)

const compiledPolicy = path.join(cache, 'loader-policy.mjs')
await build({ entryPoints: [path.join(root, 'src/main/loaderCompatibility.ts')], bundle: true, platform: 'node', format: 'esm', outfile: compiledPolicy, logLevel: 'silent' })
const workspacePolicy = await import(pathToFileURL(compiledPolicy).href)
const policyBytes = await fs.readFile(path.join(root, 'src/main/loaderCompatibility.ts'))

// Execute the real catalog selection code, replacing only its network transport
// with this audit's bounded, reproducible cache. No app/user catalog is modified.
globalThis.__modmindGameAuditFetchText = async url => {
  const existing = Object.entries(sources).find(([, source]) => source === url)?.[0]
  if (existing && catalogs[existing]) return catalogs[existing]
  const key = `catalog-${hash(url)}`
  const file = path.join(cache, `${key}.source`)
  const bytes = offline ? await fs.readFile(file) : await getBytes(url, 8 * 1024 * 1024)
  if (!offline) await fs.writeFile(file, bytes)
  provenance[url] = { url, sha256: hash(bytes), bytes: bytes.length }
  return bytes.toString('utf8')
}
const catalogFile = path.join(cache, 'modmind-catalog.mjs')
await build({ entryPoints: [path.join(root, 'src/main/loaderCatalog.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: catalogFile, logLevel: 'silent', plugins: [{ name: 'audit-network-cache', setup(builder) {
  builder.onResolve({ filter: /\/networkRequest$/ }, () => ({ path: 'audit-network', namespace: 'audit' }))
  builder.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({ contents: 'export const fetchTextWithRetry = (url) => globalThis.__modmindGameAuditFetchText(url);', loader: 'js' }))
} }] })
const modmindCatalog = await import(pathToFileURL(catalogFile).href)
const bundledOptions = modmindCatalog.bundledLoaderCatalog()
let onlineOptions = [], onlineCatalogError = null
try { onlineOptions = await modmindCatalog.downloadLoaderCatalog('game-control-audit') }
catch (error) { onlineCatalogError = String(error) }
const pluginFile = path.join(cache, 'modmind-plugin-catalog.mjs')
await build({ entryPoints: [path.join(root, 'src/main/serverPluginCatalog.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: pluginFile, logLevel: 'silent', plugins: [{ name: 'audit-network-cache', setup(builder) {
  builder.onResolve({ filter: /\/networkRequest$/ }, () => ({ path: 'audit-network', namespace: 'audit' }))
  builder.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({ contents: 'export const fetchTextWithRetry = (url) => globalThis.__modmindGameAuditFetchText(url);', loader: 'js' }))
} }] })
const { ServerPluginCatalog } = await import(pathToFileURL(pluginFile).href)
const pluginOptions = await new ServerPluginCatalog(path.join(cache, 'plugin-catalog-cache'), 'audit').list(true)
const targets = new Map()
for (const [origin, options] of [['bundled', bundledOptions], ['online', onlineOptions], ['server-plugin-catalog', pluginOptions]]) {
  for (const option of options) {
    const key = `${option.loader}:${option.minecraftVersion}`
    let target = targets.get(key)
    if (!target) {
      target = { key, loader: option.loader, minecraftVersion: option.minecraftVersion, profiles: [], implementation: 'not-implemented', backgroundInputVerified: false, freshFramesVerified: false }
      targets.set(key, target)
    }
    target.profiles.push({ origin, ...option })
  }
}
const targetVersions = new Set([...targets.values()].filter(target => !['bedrock', 'netease-pc', 'netease-mobile', 'velocity'].includes(target.loader)).map(target => target.minecraftVersion))
const selectedManifest = manifest.versions.filter(entry => targetVersions.has(entry.id))
const missingTargetVersions = [...targetVersions].filter(id => !manifest.versions.some(entry => entry.id === id))
await writeJson(path.join(output, 'modmind-targets.json'), { scope: 'union of current ModMind bundled and online catalogs, plus server-plugin catalog; snapshots/old_alpha/old_beta not independently added', onlineCatalogError, missingTargetVersions, targets: [...targets.values()] })

function allowed(library, osName, version, arch) {
  if (!library.rules) return true
  let result = false
  for (const rule of library.rules) {
    const os = rule.os ?? {}
    if (os.name && os.name !== osName) continue
    if (os.version && !new RegExp(os.version).test(version)) continue
    if (os.arch && !new RegExp(os.arch).test(arch)) continue
    if (rule.features && Object.values(rule.features).some(value => value !== false)) continue
    result = rule.action === 'allow'
  }
  return result
}
function inputLibrary(library) {
  const [group, artifact, version, classifier] = library.name.split(':')
  if (classifier) return null
  const family = group === 'org.lwjgl.lwjgl' && artifact === 'lwjgl' ? 'lwjgl2'
    : group === 'org.lwjgl' && artifact === 'lwjgl-glfw' ? 'glfw'
      : group === 'org.lwjgl' && artifact === 'lwjgl-sdl' ? 'sdl'
      : null
  if (!family) return null
  return { family, name: library.name, version, sha1: library.downloads?.artifact?.sha1 ?? null, url: library.downloads?.artifact?.url ?? null, size: library.downloads?.artifact?.size ?? null, rules: library.rules }
}
const parser = new XMLParser()
function xmlVersions(name) {
  if (!catalogs[name]) return null
  const value = parser.parse(catalogs[name])?.metadata?.versioning?.versions?.version
  return value == null ? [] : (Array.isArray(value) ? value : [value]).map(String)
}
function jsonVersions(name) {
  return catalogs[name] ? new Set(JSON.parse(catalogs[name]).map(item => item.version)) : null
}
const fabric = jsonVersions('fabric')
const quilt = jsonVersions('quilt')
const forgeVersions = xmlVersions('forge')
const neoVersions = xmlVersions('neoforge')
const transitionVersions = xmlVersions('neoTransition')
function listed(set, id) { return set ? (set.has(id) ? 'catalog-listed-pair-unverified' : 'not-listed') : 'catalog-unavailable' }
function matches(list, prefix) { return list ? list.filter(value => value.startsWith(prefix)) : null }
function neoforgePrefix(id) {
  if (/^1\.\d+(?:\.\d+)?$/.test(id)) {
    const parts = id.split('.'); return `${parts[1]}.${parts[2] ?? '0'}.`
  }
  return /^\d{2}\.\d+(?:\.\d+)?$/.test(id) ? `${id.split('.').slice(0, 2).join('.')}.` : null
}
function loaderStatus(id) {
  const forge = matches(forgeVersions, `${id}-`)
  const prefix = neoforgePrefix(id)
  // A version prefix is a candidate only; exact installer dependency must be inspected.
  const neo = prefix ? matches(neoVersions, prefix) : []
  const transition = matches(transitionVersions, `${id}-`)
  return { fabric: listed(fabric, id), quilt: listed(quilt, id), forge: { status: forge == null ? 'catalog-unavailable' : forge.length ? 'maven-listed-pair-unverified' : 'not-listed', builds: forge?.length ?? null, example: forge?.at(-1) ?? null }, neoforge: { status: neo == null || transition == null ? 'catalog-unavailable' : neo.length || transition.length ? 'prefix-candidate-installer-unverified' : 'not-listed', builds: neo?.length ?? null, example: neo?.at(-1) ?? transition?.at(-1) ?? null, prefix, transitionBuilds: transition?.length ?? null } }
}

const results = new Array(selectedManifest.length)
let next = 0, completed = 0
const artifacts = new Map()
console.log(JSON.stringify({ phase: 'metadata', total: selectedManifest.length, modmindCombinations: targets.size, latest: manifest.latest, offline }))
await Promise.all(Array.from({ length: 8 }, async () => {
  for (;;) {
    const index = next++
    if (index >= selectedManifest.length) return
    const entry = selectedManifest[index]
    const row = { id: entry.id, type: entry.type, releaseTime: entry.releaseTime, metadataUrl: entry.url, metadataSha1: entry.sha1, implementation: 'not-implemented', runtimeVerified: false, backgroundInputVerified: false, freshFramesVerified: false }
    try {
      const file = path.join(cache, 'metadata', `${entry.sha1}.json`)
      let bytes = !refresh ? await fs.readFile(file).catch(() => null) : null
      if (bytes && hash(bytes, 'sha1') !== entry.sha1) bytes = null
      if (!bytes) {
        if (offline) throw new Error('missing verified cache')
        bytes = await getBytes(entry.url)
        assert.equal(hash(bytes, 'sha1'), entry.sha1, `metadata hash: ${entry.id}`)
        await fs.writeFile(file, bytes)
      }
      const data = JSON.parse(bytes)
      assert.equal(data.id, entry.id)
      const allInput = [...new Map(data.libraries.map(inputLibrary).filter(Boolean).map(library => [JSON.stringify(library), library])).values()]
      const targets = { windowsX64: ['windows', '10.0', 'x86_64'], linuxX64: ['linux', '6.8.0', 'x86_64'], macosIntel: ['osx', '10.15.7', 'x86_64'], macosLegacy105: ['osx', '10.5.8', 'x86_64'] }
      const selected = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, allInput.filter(library => allowed(library, ...target)).map(library => library.name)]))
      const winInput = allInput.filter(library => allowed(library, ...targets.windowsX64))
      const families = [...new Set(winInput.map(library => library.family))]
      const main = data.mainClass ?? null
      const issues = ['BACKGROUND_INPUT_UNIMPLEMENTED', 'BACKGROUND_FOCUS_CURSOR_UNVERIFIED', 'BACKGROUND_FRAMES_UNVERIFIED', 'MINIMIZED_HIDDEN_UNVERIFIED']
      if (entry.type.startsWith('old_') || main?.includes('launchwrapper')) issues.push('LEGACY_WRAPPER_OR_AWT_REVIEW')
      if (families.length !== 1) issues.push('INPUT_FAMILY_UNRESOLVED')
      if (!data.javaVersion?.majorVersion) issues.push('JAVA_NOT_DECLARED')
      const policyMajor = workspacePolicy.javaVersionForMinecraft(entry.id)
      if (data.javaVersion?.majorVersion && policyMajor !== data.javaVersion.majorVersion) issues.push('WORKSPACE_JAVA_POLICY_MISMATCH')
      const policyTarget = workspacePolicy.javaRuntimeTargetForMinecraft(entry.id)
      if (data.javaVersion?.component && policyTarget !== data.javaVersion.component) issues.push('WORKSPACE_JAVA_COMPONENT_MISMATCH')
      const natives = [...new Set(data.libraries.filter(library => /lwjgl/.test(library.name) && allowed(library, ...targets.windowsX64)).flatMap(library => [library.natives?.windows, ...Object.keys(library.downloads?.classifiers ?? {}).filter(key => key.includes('windows')), library.name.split(':')[3]].filter(Boolean)))]
      Object.assign(row, { metadataStatus: 'sha1-verified', java: data.javaVersion ?? null, mainClass: main, legacyArguments: typeof data.minecraftArguments === 'string', inheritsFrom: data.inheritsFrom ?? null, inputFamily: families.length === 1 ? families[0] : 'unresolved', inputLibraries: allInput, selectedInputLibraries: selected, windowsNatives: natives, declaredClient: data.downloads?.client ?? null, declaredClientMappings: Boolean(data.downloads?.client_mappings), workspaceJavaPolicy: { majorVersion: policyMajor, component: policyTarget }, loaders: loaderStatus(entry.id), requiredWork: issues, assessment: 'metadata-only-no-runtime-proof' })
      for (const library of allInput) if (library.url && library.sha1) artifacts.set(library.sha1, library)
    } catch (error) { Object.assign(row, { metadataStatus: 'failed', error: String(error), requiredWork: ['METADATA_UNAVAILABLE', 'BACKGROUND_INPUT_UNIMPLEMENTED', 'BACKGROUND_FRAMES_UNVERIFIED'] }) }
    results[index] = row
    completed++
    if (completed % 100 === 0 || completed === selectedManifest.length) console.log(JSON.stringify({ phase: 'metadata', completed, total: selectedManifest.length, networkBytes }))
  }
}))

const countBy = (items, getter) => Object.fromEntries([...new Set(items.map(getter))].sort().map(key => [key, items.filter(item => getter(item) === key).length]))
const successful = results.filter(row => row.metadataStatus === 'sha1-verified')
const metadataFailures = results.filter(row => row.metadataStatus !== 'sha1-verified')
const summary = {
  schemaVersion: 1, observedAt: new Date().toISOString(), scope: 'only current ModMind catalog targets; union of bundled/online Java loaders and server-plugin Minecraft versions; non-Java platforms and Velocity API versions reported separately',
  latest: manifest.latest, officialVersionCount: manifest.versions.length, targetVersionCount: selectedManifest.length, targetCombinationCount: targets.size, targetCombinationsByLoader: countBy([...targets.values()], target => target.loader), onlineCatalogError, missingTargetVersions, metadataVerified: successful.length, metadataFailures: metadataFailures.map(row => ({ id: row.id, error: row.error })),
  byType: countBy(results, row => row.type), byInputFamily: countBy(successful, row => row.inputFamily), byJavaMajor: countBy(successful, row => row.java?.majorVersion ?? 'unknown'),
  workspaceMajorMismatches: successful.filter(row => row.requiredWork.includes('WORKSPACE_JAVA_POLICY_MISMATCH')).length,
  workspaceComponentMismatches: successful.filter(row => row.requiredWork.includes('WORKSPACE_JAVA_COMPONENT_MISMATCH')).length,
  inputArtifacts: artifacts.size, implemented: 0, runtimeVerified: 0, backgroundInputVerified: 0, freshFramesVerified: 0, noGameBinariesDownloaded: true, networkBytes,
  sources: provenance, workspacePolicy: { path: 'src/main/loaderCompatibility.ts', sha256: hash(policyBytes) }
}
await writeJson(path.join(output, 'summary.json'), summary)
await writeJson(path.join(output, 'versions.json'), { schemaVersion: 1, manifestSha256: provenance.manifest.sha256, versions: results })
await writeJson(path.join(output, 'input-artifacts.json'), [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name)))
await writeJson(path.join(output, 'manifest-snapshot.json'), { scope: 'only ModMind target entries from the official manifest', sourceFullManifestSha256: provenance.manifest.sha256, latest: manifest.latest, versions: selectedManifest })
await writeJson(path.join(output, 'loader-source-summary.json'), { sources: provenance, sourceCatalogCounts: { fabric: fabric?.size ?? null, quilt: quilt?.size ?? null, forge: forgeVersions?.length ?? null, neoforge: neoVersions?.length ?? null, neoTransition: transitionVersions?.length ?? null } })
const headers = ['id', 'type', 'javaDeclared', 'inputFamily', 'inputWindows', 'mainClass', 'javaPolicy', 'fabric', 'quilt', 'forge', 'neoforge', 'requiredWork', 'backgroundInputVerified', 'freshFramesVerified', 'metadataUrl']
const csvValue = value => '"' + String(value ?? '').replaceAll('"', '""') + '"'
const csv = [headers, ...results.map(row => [row.id, row.type, row.java?.majorVersion, row.inputFamily, row.selectedInputLibraries?.windowsX64?.join(';'), row.mainClass, row.workspaceJavaPolicy?.majorVersion, row.loaders?.fabric, row.loaders?.quilt, row.loaders?.forge?.status, row.loaders?.neoforge?.status, row.requiredWork.join(';'), false, false, row.metadataUrl])].map(values => values.map(csvValue).join(',')).join('\r\n')
await fs.writeFile(path.join(output, 'versions.csv'), '\ufeff' + csv + '\r\n')
assert.equal(results.length, selectedManifest.length)
assert.deepEqual(results.map(row => row.id), selectedManifest.map(entry => entry.id))
console.log(JSON.stringify(summary, null, 2))
if (metadataFailures.length || missingTargetVersions.length || onlineCatalogError || Object.values(provenance).some(source => source.error)) process.exitCode = 2
