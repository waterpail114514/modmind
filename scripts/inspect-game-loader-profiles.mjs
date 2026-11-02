import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

// Inspect catalog-selected launcher JSON, not installers' executable code.
// Forge/NeoForge ZIPs use bounded HTTP ranges; no complete installer is fetched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs/game-control-compatibility')
const cache = path.join(root, 'test-results/game-control-version-audit/loader-profiles')
const offline = process.argv.includes('--offline')
const hash = value => createHash('sha256').update(value).digest('hex')
await fs.mkdir(cache, { recursive: true })
const { targets } = JSON.parse(await fs.readFile(path.join(output, 'modmind-targets.json'), 'utf8'))
const tasks = new Map()
for (const target of targets.filter(item => ['fabric', 'quilt', 'forge', 'neoforge'].includes(item.loader))) {
  for (const profile of target.profiles) {
    const key = `${target.key}:${profile.loaderVersion}`
    let task = tasks.get(key)
    if (!task) { task = { key, loader: target.loader, minecraft: target.minecraftVersion, loaderVersion: profile.loaderVersion, origins: [] }; tasks.set(key, task) }
    task.origins.push(profile.origin)
  }
}
let downloadedBytes = 0, completed = 0

async function requestBytes(url, range) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(25_000) })
      if ((range && response.status !== 206) || (!range && !response.ok)) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}; byte ranges required for installer`) }
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > (range ? 65536 : 2 * 1024 * 1024)) throw new Error('profile response size limit')
        chunks.push(chunk)
      }
      downloadedBytes += size
      return { bytes: Buffer.concat(chunks), contentRange: response.headers.get('content-range') }
    } catch (error) { last = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1))) }
  }
  throw last
}

class HttpZipReader extends yauzl.RandomAccessReader {
  constructor(url, total) { super(); this.url = url; this.total = total; this.blocks = new Map(); this.rangeEvidence = []; this.bytes = 0 }
  async block(start) {
    if (!this.blocks.has(start)) {
      const end = Math.min(start + 65536, this.total)
      this.bytes += end - start
      if (this.bytes > 1024 * 1024) throw new Error('installer metadata exceeded 1 MiB per-artifact budget')
      this.blocks.set(start, requestBytes(this.url, `bytes=${start}-${end - 1}`).then(result => {
        assert.equal(result.contentRange, `bytes ${start}-${end - 1}/${this.total}`)
        assert.equal(result.bytes.length, end - start)
        this.rangeEvidence.push({ start, endExclusive: end, sha256: hash(result.bytes) })
        return result.bytes
      }))
    }
    return this.blocks.get(start)
  }
  _readStreamForRange(start, end) {
    const reader = this
    return Readable.from((async function* () {
      for (let position = start; position < end;) {
        const blockStart = Math.floor(position / 65536) * 65536
        const bytes = await reader.block(blockStart)
        const count = Math.min(end - position, bytes.length - (position - blockStart))
        yield bytes.subarray(position - blockStart, position - blockStart + count)
        position += count
      }
    })())
  }
  _destroy(callback) { callback() }
}

async function installerJson(url) {
  const initial = await requestBytes(url, 'bytes=0-0')
  const total = Number(initial.contentRange?.match(/^bytes 0-0\/(\d+)$/)?.[1])
  assert.ok(Number.isSafeInteger(total) && total > 0, 'valid installer range size')
  const reader = new HttpZipReader(url, total)
  const zip = await new Promise((resolve, reject) => yauzl.fromRandomAccessReader(reader, total, { lazyEntries: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value)))
  const documents = {}
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', entry => {
        if (!['version.json', 'install_profile.json'].includes(entry.fileName)) { zip.readEntry(); return }
        if (entry.uncompressedSize > 2 * 1024 * 1024) { reject(new Error('installer JSON exceeds 2 MiB')); return }
        zip.openReadStream(entry, async (error, stream) => {
          if (error) { reject(error); return }
          try {
            const chunks = []
            for await (const chunk of stream) chunks.push(chunk)
            const bytes = Buffer.concat(chunks)
            documents[entry.fileName] = { sha256: hash(bytes), value: JSON.parse(bytes) }
            zip.readEntry()
          } catch (error) { reject(error) }
        })
      })
      zip.readEntry()
    })
  } finally { zip.close() }
  assert.ok(Object.keys(documents).length, 'installer contains launcher metadata')
  return { mode: 'partial-zip-json-only', fullInstallerHashVerified: false, totalInstallerBytes: total, fetchedInstallerBytes: reader.bytes + 1, rangeEvidence: reader.rangeEvidence.sort((a, b) => a.start - b.start), documents }
}

function urlFor(task) {
  const mc = encodeURIComponent(task.minecraft), version = encodeURIComponent(task.loaderVersion)
  if (task.loader === 'fabric') return `https://meta.fabricmc.net/v2/versions/loader/${mc}/${version}/profile/json`
  if (task.loader === 'quilt') return `https://meta.quiltmc.org/v3/versions/loader/${mc}/${version}/profile/json`
  const group = task.loader === 'forge' ? 'net/minecraftforge/forge' : 'net/neoforged/neoforge'
  const artifact = task.loader === 'forge' ? 'forge' : 'neoforge'
  const host = task.loader === 'forge' ? 'https://maven.minecraftforge.net' : 'https://maven.neoforged.net/releases'
  return `${host}/${group}/${version}/${artifact}-${version}-installer.jar`
}

const results = new Array(tasks.size), allTasks = [...tasks.values()]
let next = 0
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const index = next++
    if (index >= allTasks.length) return
    const task = allTasks[index], url = urlFor(task), file = path.join(cache, `${hash(url)}.json`)
    const result = { ...task, url, status: 'pending', runtimeVerified: false }
    try {
      let raw = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null)
      if (!raw) {
        if (offline) throw new Error('profile cache missing')
        if (['fabric', 'quilt'].includes(task.loader)) {
          const { bytes } = await requestBytes(url)
          raw = { mode: 'official-profile-json', sha256: hash(bytes), documents: { 'version.json': { sha256: hash(bytes), value: JSON.parse(bytes) } } }
        } else raw = await installerJson(url)
        await fs.writeFile(file, JSON.stringify(raw))
      }
      const install = raw.documents['install_profile.json']?.value
      const profile = raw.documents['version.json']?.value ?? install?.versionInfo
      assert.ok(profile && typeof profile === 'object', 'launcher version JSON exists')
      const libraries = profile.libraries ?? []
      Object.assign(result, { status: 'profile-inspected', mode: raw.mode, profileSha256: raw.documents['version.json']?.sha256 ?? raw.documents['install_profile.json']?.sha256, mainClass: profile.mainClass ?? null, inheritsFrom: profile.inheritsFrom ?? null, javaVersion: profile.javaVersion ?? null, libraryCount: libraries.length,
        inputOverrides: libraries.filter(library => /(?:^org\.lwjgl(?::|\.)|lwjgl)/i.test(library.name ?? '')).map(library => ({ name: library.name, url: library.downloads?.artifact?.url ?? library.url ?? null, sha1: library.downloads?.artifact?.sha1 ?? null, rules: library.rules ?? null })),
        jvmArguments: profile.arguments?.jvm ?? [], legacyArguments: profile.minecraftArguments ?? null,
        installerMinecraft: install?.minecraft ?? install?.install?.minecraft ?? null,
        launcherLibraries: libraries.filter(library => /launchwrapper|modlauncher|bootstraplauncher|securejarhandler|fabric-loader|quilt-loader|fml|fancymodloader/i.test(library.name ?? '')).map(library => library.name),
        totalInstallerBytes: raw.totalInstallerBytes ?? null, fetchedInstallerBytes: raw.fetchedInstallerBytes ?? null, fullInstallerHashVerified: raw.fullInstallerHashVerified ?? null, rangeEvidence: raw.rangeEvidence ?? null })
      if (profile.inheritsFrom && profile.inheritsFrom !== task.minecraft) result.warning = 'profile inherits another Minecraft version; inspect before use'
      if (install?.minecraft && install.minecraft !== task.minecraft) result.warning = 'installer Minecraft target differs from catalog target'
    } catch (error) { result.status = 'failed'; result.error = String(error) }
    results[index] = result
    completed++
    if (completed % 20 === 0 || completed === allTasks.length) console.log(JSON.stringify({ phase: 'loader-profiles', completed, total: allTasks.length, failed: results.filter(row => row?.status === 'failed').length, downloadedBytes }))
  }
}))
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), scope: 'exact catalog-selected bundled/online Java loader versions; no executable installers run and no game resources fetched', profileCount: results.length, inspected: results.filter(row => row.status === 'profile-inspected').length, failures: results.filter(row => row.status === 'failed').map(row => ({ key: row.key, error: row.error })), downloadedBytes, profiles: results }
await fs.writeFile(path.join(output, 'loader-profile-inspection.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ profileCount: report.profileCount, inspected: report.inspected, failures: report.failures, downloadedBytes }))
if (report.failures.length) process.exitCode = 2
