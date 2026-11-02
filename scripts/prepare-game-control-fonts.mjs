import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Optional visual fixture: reuse only font objects already on disk. An explicit
// --fetch-index allows the small official index, never the complete asset set.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = path.resolve(arg('resources') || 'test-results/game-control-matrix-resources')
assert(root.startsWith(path.resolve('test-results') + path.sep), 'An isolated test resource root is required')
const source = path.resolve(arg('reuse') || path.join(process.env.APPDATA, 'modmind/minecraft-runtime/game'))
const version = arg('version') || '1.20.1'
assert(/^[a-zA-Z0-9._-]+$/.test(version))
const metadata = JSON.parse(await fs.readFile(path.join(root, 'versions', version, version + '.json'), 'utf8'))
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex')
let index, downloadedIndexBytes = 0
for (const name of await fs.readdir(path.join(source, 'assets/indexes'))) {
  if (!name.endsWith('.json')) continue
  const bytes = await fs.readFile(path.join(source, 'assets/indexes', name))
  if (sha1(bytes) === metadata.assetIndex.sha1) { index = JSON.parse(bytes); break }
}
if (!index && process.argv.includes('--fetch-index')) {
  const url = new URL(metadata.assetIndex.url)
  assert(url.protocol === 'https:' && url.hostname === 'piston-meta.mojang.com')
  assert(metadata.assetIndex.size <= 1024 * 1024)
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) }); assert(response.ok)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, metadata.assetIndex.size); assert.equal(sha1(bytes), metadata.assetIndex.sha1)
  index = JSON.parse(bytes); downloadedIndexBytes = bytes.length
}
assert(index, 'The exact official asset index must exist locally, or use --fetch-index')
const objects = Object.fromEntries(Object.entries(index.objects).filter(([key]) => /^minecraft\/(?:font\/|textures\/font\/)/.test(key)))
assert(Object.keys(objects).length > 0, 'This index contains no reusable font assets')
let reusedBytes = 0
for (const [name, entry] of Object.entries(objects)) {
  assert(/^[a-f0-9]{40}$/.test(entry.hash))
  const relative = path.join('assets/objects', entry.hash.slice(0, 2), entry.hash), bytes = await fs.readFile(path.join(source, relative))
  assert.equal(bytes.length, entry.size); assert.equal(sha1(bytes), entry.hash)
  const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes)
  reusedBytes += bytes.length
}
const indexPath = path.join(root, 'assets/indexes', metadata.assetIndex.id + '.json')
await fs.mkdir(path.dirname(indexPath), { recursive: true }); await fs.writeFile(indexPath, JSON.stringify({ objects }))
const result = { version, assetIndexId: metadata.assetIndex.id, officialIndexSha1: metadata.assetIndex.sha1, scope: 'font objects only; intentionally incomplete game assets', downloadedIndexBytes, downloadedAssetBytes: 0, reusedBytes, objects }
await fs.writeFile(path.join(root, 'assets', `modmind-font-fixture-${version}.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
