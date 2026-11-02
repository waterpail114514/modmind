import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl'), yazl = require('yazl')
const root = path.resolve(import.meta.dirname, '..')
export const asm = { version: '9.11.1', sha256: 'ae4e6e10d59d0a1500317764b21881ad883f8550e33c66e6142f7032c6fb566c', url: 'https://repo.maven.apache.org/maven2/org/ow2/asm/asm/9.11.1/asm-9.11.1.jar', license: 'BSD-3-Clause' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function entries(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)))
  const result = []
  await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve)
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) return zip.readEntry()
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error)
        const chunks = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk))
        stream.on('end', () => { result.push({ name: entry.fileName, data: Buffer.concat(chunks) }); zip.readEntry() })
      })
    }); zip.readEntry()
  })
  return result
}

// Relocate constant-pool UTF8 entries, including descriptors. The bytecode itself
// is emitted by upstream ASM; this only keeps its namespace private to the agent.
function relocate(bytes) {
  const chunks = [bytes.subarray(0, 10)]
  let cursor = 10
  for (let index = 1; index < bytes.readUInt16BE(8); index++) {
    const tag = bytes[cursor++]
    if (tag === 1) {
      const size = bytes.readUInt16BE(cursor); cursor += 2
      const original = bytes.subarray(cursor, cursor + size); cursor += size
      // ASM's class names are ASCII. Preserve modified UTF8 of unrelated entries.
      const value = Buffer.from(original.toString('latin1').replaceAll('org/objectweb/asm', 'dev/modmind/gamecontrol/asm'), 'latin1')
      const prefix = Buffer.alloc(3); prefix[0] = 1; prefix.writeUInt16BE(value.length, 1); chunks.push(prefix, value)
    } else {
      const size = ({ 3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2 })[tag]
      if (!size) throw new Error(`Unknown class constant tag ${tag}`)
      chunks.push(Buffer.from([tag]), bytes.subarray(cursor, cursor + size)); cursor += size
      if (tag === 5 || tag === 6) index++
    }
  }
  chunks.push(bytes.subarray(cursor)); return Buffer.concat(chunks)
}

async function jar(entries) {
  const zip = new yazl.ZipFile(), chunks = []
  const result = new Promise((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject) })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) zip.addBuffer(entry.data, entry.name, { mtime: new Date('2000-01-01T00:00:00Z'), mode: 0o100644, compress: true })
  zip.end(); return result
}

export async function compileGameControlAgent({ javac = 'javac', offline = false, sourceDirectory = path.join(root, 'resources/game-control'), artifactPath = path.join(root, 'feature-plugins/testing/src/main/gameControlAgent.json'), jarName = 'game-control-agent.jar' } = {}) {
  const cache = path.join(root, 'test-results/game-control-build'), upstream = path.join(cache, `asm-${asm.version}.jar`)
  await mkdir(cache, { recursive: true })
  let bytes = await readFile(upstream).catch(() => null)
  if (!bytes || hash(bytes) !== asm.sha256) {
    if (offline) throw new Error('Verified ASM is missing; compile once online before using --offline')
    const response = await fetch(asm.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`ASM download: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer()); if (hash(bytes) !== asm.sha256) throw new Error('ASM SHA256 mismatch')
    await writeFile(upstream, bytes)
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'modmind-game-agent-'))
  try {
    const sources = (await readdir(sourceDirectory)).filter(name => name.endsWith('.java')).sort()
    const sourceHashes = {}
    for (const name of sources) sourceHashes[name] = hash((await readFile(path.join(sourceDirectory, name), 'utf8')).replaceAll('\r\n', '\n'))
    execFileSync(javac, ['--release', '8', '-encoding', 'UTF-8', '-cp', upstream, '-d', temporary, ...sources.map(name => path.join(sourceDirectory, name))], { stdio: 'inherit', windowsHide: true })
    const files = []
    async function collect(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await collect(file); else files.push({ name: path.relative(temporary, file).replaceAll('\\', '/'), data: relocate(await readFile(file)) }) } }
    await collect(temporary)
    for (const entry of await entries(bytes)) if (entry.name.startsWith('org/objectweb/asm/') && entry.name.endsWith('.class')) files.push({ name: entry.name.replace('org/objectweb/asm/', 'dev/modmind/gamecontrol/asm/'), data: relocate(entry.data) })
    files.push({ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\nPremain-Class: dev.modmind.gamecontrol.GameControlAgent\r\nCan-Redefine-Classes: false\r\nCan-Retransform-Classes: false\r\n\r\n') })
    files.push({ name: 'META-INF/LICENSE-ASM.txt', data: await readFile(path.join(sourceDirectory, 'LICENSE-ASM.txt')) })
    const output = await jar(files)
    const artifact = { protocol: 1, minimumJava: 8, sourceHashes, upstream: asm, jarSha256: hash(output), jarBytes: output.length, data: output.toString('base64') }
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n')
    await writeFile(path.join(cache, jarName), output)
    return { jarPath: path.join(cache, jarName), jarSha256: artifact.jarSha256, jarBytes: output.length, sourceHashes }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  console.log(JSON.stringify(await compileGameControlAgent({ javac: arg('javac') || 'javac', offline: process.argv.includes('--offline'), ...(arg('source') ? { sourceDirectory: path.resolve(arg('source')), jarName: 'game-control-candidate.jar' } : {}), ...(arg('artifact') ? { artifactPath: path.resolve(arg('artifact')) } : {}) }), null, 2))
}
