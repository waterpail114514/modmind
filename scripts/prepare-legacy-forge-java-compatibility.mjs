import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..'), cache = path.join(root, 'test-results/game-control-legacy-java-fixer')
const upstream = { url: 'https://maven.minecraftforge.net/net/minecraftforge/legacyjavafixer/2.0.1/legacyjavafixer-2.0.1.jar', sha256: '0d88288ecc0b9cb1870ac64ba4c6d905a2797b93966abd46f16fdfcafe58a98c', bytes: 6630, sourceCommit: '4b28ed9af160b38236be8601b376f96f19f837e4', license: 'MIT' }
const licenseUrl = `https://raw.githubusercontent.com/MinecraftForge/LegacyJavaFixer/${upstream.sourceCommit}/LICENSE`, licenseHash = '507855ce866f9d91ed2edeba5a64dd40b8aaf440f8ec20a63bca5c015d970846'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await fs.mkdir(cache, { recursive: true })
async function verified(name, url, expected) {
  const file = path.join(cache, name)
  let bytes = await fs.readFile(file).catch(() => undefined)
  if (!bytes || hash(bytes) !== expected) {
    if (process.argv.includes('--offline')) throw new Error('Verified compatibility artifact missing: ' + name)
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Compatibility artifact HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 32768 || hash(bytes) !== expected) throw new Error('Compatibility artifact SHA256 mismatch: ' + name)
    await fs.writeFile(file, bytes)
  }
  return bytes
}
const [jar, license] = await Promise.all([verified('legacyjavafixer-2.0.1.jar', upstream.url, upstream.sha256), verified('LICENSE', licenseUrl, licenseHash)])
if (jar.length !== upstream.bytes) throw new Error('Unexpected compatibility JAR size')
const artifact = { upstream, licenseText: license.toString('utf8'), data: jar.toString('base64') }
const target = path.join(root, process.argv.find(value => value.startsWith('--artifact='))?.slice('--artifact='.length) || 'feature-plugins/testing/src/main/legacyForgeJavaCompatibilityArtifact.json')
await fs.writeFile(target, JSON.stringify(artifact, null, 2) + '\n')
console.log(JSON.stringify({ artifact: target, ...upstream }))
