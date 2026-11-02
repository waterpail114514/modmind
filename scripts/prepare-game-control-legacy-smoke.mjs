import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Version, MinecraftFolder } from '@xmcl/core'

// Explicit development smoke fixture only. No application cache is changed and
// no assets or JVM are downloaded. Every executable artifact uses Mojang's hash.
if (!process.argv.includes('--download-fixture')) throw new Error('Pass --download-fixture to download the bounded 1.12.2 test fixture (about 50 MB)')
const directory = path.resolve('test-results/game-control-legacy-resources')
const snapshot = JSON.parse(await fs.readFile('docs/game-control-compatibility/manifest-snapshot.json', 'utf8'))
const entry = snapshot.versions.find(version => version.id === '1.12.2')
const bytes = await fs.readFile(`test-results/game-control-version-audit/metadata/${entry.sha1}.json`)
const sha1 = value => createHash('sha1').update(value).digest('hex')
if (sha1(bytes) !== entry.sha1) throw new Error('Metadata hash mismatch')
const metadata = JSON.parse(bytes)
const versionDirectory = path.join(directory, 'versions/1.12.2')
await fs.mkdir(versionDirectory, { recursive: true }); await fs.writeFile(path.join(versionDirectory, '1.12.2.json'), bytes)
const version = await Version.parse(new MinecraftFolder(directory), '1.12.2')
const files = [{ ...metadata.downloads.client, path: 'versions/1.12.2/1.12.2.jar' }, ...version.libraries.map(library => ({ ...library.download, path: `libraries/${library.download.path}` }))]
let downloaded = 0, reused = 0
const maxBytes = 64 * 1024 * 1024
const unique = [...new Map(files.map(file => [file.path, file])).values()]
if (unique.reduce((sum, file) => sum + file.size, 0) > maxBytes) throw new Error('Fixture exceeds the declared download budget')
const cache = path.join(process.env.APPDATA, 'ModMind/minecraft-runtime/game')
let cursor = 0
async function worker() {
  while (cursor < unique.length) {
    const file = unique[cursor++], output = path.join(directory, file.path)
    await fs.mkdir(path.dirname(output), { recursive: true })
    let content = await fs.readFile(output).catch(() => null)
    if (content && sha1(content) === file.sha1) { reused += content.length; continue }
    content = await fs.readFile(path.join(cache, file.path)).catch(() => null)
    if (content && sha1(content) === file.sha1) reused += content.length
    else {
      const response = await fetch(file.url, { signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${file.url}`)
      content = Buffer.from(await response.arrayBuffer()); downloaded += content.length
    }
    if (content.length !== file.size || sha1(content) !== file.sha1) throw new Error(`Integrity check failed: ${file.path}`)
    await fs.writeFile(output, content)
  }
}
await Promise.all([worker(), worker(), worker(), worker()])
// Legacy textures/fonts live in the client JAR; sounds and optional online data
// are intentionally absent. This must never be reported as a full asset install.
await fs.mkdir(path.join(directory, 'assets/indexes'), { recursive: true })
await fs.writeFile(path.join(directory, 'assets/indexes/1.12.json'), '{"objects":{}}')
const result = { minecraft: '1.12.2', directory, downloadedBytes: downloaded, reusedBytes: reused, files: unique.length, assetsDownloaded: false, javaDownloaded: false }
await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
