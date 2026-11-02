import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Version, MinecraftFolder } from '@xmcl/core'

// Development acceptance fixture. Plan is the default; downloading is explicit
// and bounded. Never install assets, JREs or write to the user's game cache.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = path.resolve(arg('directory') || 'test-results/game-control-matrix-resources')
const cache = path.resolve(process.env.APPDATA, 'modmind/minecraft-runtime/game')
const legacyCache = path.resolve('test-results/game-control-legacy-resources')
const reuse = arg('reuse') ? path.resolve(arg('reuse')) : undefined
const output = path.resolve('test-results/game-control-matrix-preparation'); await fs.mkdir(output, { recursive: true })
const versions = JSON.parse(await fs.readFile('docs/game-control-compatibility/versions.json', 'utf8')).versions
const selected = arg('versions') ? new Set(arg('versions').split(',')) : undefined
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex')
const files = new Map(), targets = []
await fs.mkdir(directory, { recursive: true })
for (const version of versions.filter(version => !selected || selected.has(version.id))) {
  const raw = await fs.readFile(`test-results/game-control-version-audit/metadata/${version.metadataSha1}.json`)
  if (sha1(raw) !== version.metadataSha1) throw new Error('Metadata hash mismatch: ' + version.id)
  const metadata = JSON.parse(raw)
  const versionRoot = path.join(directory, 'versions', version.id); await fs.mkdir(versionRoot, { recursive: true })
  await fs.writeFile(path.join(versionRoot, version.id + '.json'), raw)
  const resolved = await Version.parse(new MinecraftFolder(directory), version.id)
  for (const file of [{ ...metadata.downloads.client, path: `versions/${version.id}/${version.id}.jar` }, ...resolved.libraries.map(lib => ({ ...lib.download, path: 'libraries/' + lib.download.path }))]) {
    if (!file.sha1 || !Number.isSafeInteger(file.size) || !file.url || !/^https:\/\//.test(file.url) || file.path.split('/').some(part => part === '..') || !/^[a-f0-9]{40}$/.test(file.sha1)) throw new Error('Unverifiable artifact: ' + JSON.stringify(file))
    const old = files.get(file.path); if (old && old.sha1 !== file.sha1) throw new Error('Conflicting library path: ' + file.path)
    files.set(file.path, file)
  }
  const index = metadata.assetIndex?.id || metadata.assets || 'legacy'
  await fs.mkdir(path.join(directory, 'assets/indexes'), { recursive: true })
  await fs.writeFile(path.join(directory, 'assets/indexes', index + '.json'), '{"objects":{}}')
  targets.push({ id: version.id, javaMajor: version.java?.majorVersion, inputFamily: version.inputFamily, declaredLibraries: resolved.libraries.length })
}
const artifacts = []
let missingBytes = 0, availableBytes = 0
for (const file of files.values()) {
  let source
  for (const root of [directory, ...(reuse ? [reuse] : []), cache, legacyCache]) {
    const candidate = path.join(root, file.path), bytes = await fs.readFile(candidate).catch(() => undefined)
    if (bytes && bytes.length === file.size && sha1(bytes) === file.sha1) { source = candidate; break }
  }
  if (source) availableBytes += file.size; else missingBytes += file.size
  artifacts.push({ ...file, source })
}
const report = { createdAt: new Date().toISOString(), directory, targets, files: artifacts.length, declaredBytes: missingBytes + availableBytes, missingBytes, availableBytes, assetsDownloaded: false, javaDownloaded: false }
await fs.writeFile(path.join(output, 'plan.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
if (!process.argv.includes('--download-fixture')) process.exit(0)
const budget = Number(arg('budget-bytes') || 2 * 1024 ** 3)
if (!Number.isSafeInteger(budget) || missingBytes > budget) throw new Error('Missing artifacts exceed the declared fixture budget')
let cursor = 0, downloadedBytes = 0, reusedBytes = 0
const failures = []
async function worker() {
  while (cursor < artifacts.length) {
    const file = artifacts[cursor++], target = path.join(directory, file.path)
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (file.source) { if (file.source !== target) await fs.copyFile(file.source, target); reusedBytes += file.size; continue }
      let bytes
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(file.url, { signal: AbortSignal.timeout(90000) })
          if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP ' + response.status) }
          const chunks = []; let count = 0
          for await (const chunk of response.body) { count += chunk.length; if (count > file.size) throw new Error('Artifact exceeds declared size'); chunks.push(chunk) }
          bytes = Buffer.concat(chunks)
          if (bytes.length !== file.size || sha1(bytes) !== file.sha1) throw new Error('Artifact hash/size mismatch')
          break
        } catch (error) { if (attempt === 2) throw error }
      }
      downloadedBytes += bytes.length; if (downloadedBytes > budget) throw new Error('Download budget exceeded')
      await fs.writeFile(target + '.part', bytes); await fs.rename(target + '.part', target)
      console.log(JSON.stringify({ path: file.path, bytes: bytes.length, downloadedBytes }))
    } catch (error) { failures.push({ path: file.path, error: String(error) }); console.error(file.path + ': ' + error) }
  }
}
await Promise.all([worker(), worker(), worker()])
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ...report, downloadedBytes, reusedBytes, failures, artifacts: artifacts.map(({ source: _source, ...file }) => file) }, null, 2))
if (failures.length) process.exitCode = 1
