import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

// These are compiler inputs only. The running game supplies its own libraries.
const dependencies = {
  'gson-2.14.0.jar': 'efc0e34ede4e3204eaefb84a00e55e8c86634382',
  'brigadier-1.3.11.jar': '3373d1e7bf00c8b99bed1ea4efb8c47344e4a887',
  'datafixerupper-10.0.21.jar': 'b6b2ae770c02e0c1eb90f9985b151e9085a38d0b',
  'joml-1.10.9.jar': '438e036486bad66b189bff385dd07dea4f74a146',
  'jspecify-1.0.1.jar': '3d60fd98eb8ade73004f4195c37b6317e02cf3d7',
  'fastutil-8.5.18.jar': 'a6cff377eecc19c2037bf31568a6d7106b50ba1f'
}
const [javac, client, upstream, cache] = process.argv.slice(2)
if (!cache) throw new Error('Usage: node scripts/compile-minecraft-mcp-263-helper.mjs <JDK25 javac> <26.3 client.jar> <26.3 Fabric v0.4.8 JAR> <dependency cache directory>')
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
if (hash(await readFile(upstream)) !== '1b72f1f0fd945e5671663325572936647f20d86bb592765e5ce7a9ef4bd01d82') throw new Error('Unreviewed upstream JAR')
if (hash(await readFile(client), 'sha1') !== 'e877b6a07acd633fb3bb475002175cec036e7b87') throw new Error('Use the official Minecraft 26.3 client JAR')
const found = new Map()
async function find(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await find(file)
    else if (dependencies[entry.name] && hash(await readFile(file), 'sha1') === dependencies[entry.name]) found.set(entry.name, file)
  }
}
await find(cache)
if (found.size !== Object.keys(dependencies).length) throw new Error('Missing pinned compilation dependencies')
const directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-mcp-263-'))
try {
  const source = 'resources/minecraft-mcp/ModMind263InputHandler.java'
  const classPath = 'xyz/langyo/minecraft/mcp/common/ModMind263InputHandler.class'
  execFileSync(javac, ['--release', '25', '-encoding', 'UTF-8', '-cp', [client, upstream, ...Object.keys(dependencies).map(name => found.get(name))].join(path.delimiter), '-d', directory, source], { stdio: 'inherit', windowsHide: true })
  const bytes = await readFile(path.join(directory, classPath))
  const classes = [{ path: classPath, source, sourceSha256: hash((await readFile(source, 'utf8')).replaceAll('\r\n', '\n')), classSha256: hash(bytes), data: bytes.toString('base64') }]
  await writeFile('src/main/nativeMinecraftMcp263Helper.json', JSON.stringify({ minecraft: '26.3', release: 'v0.4.8', classes }, null, 2) + '\n')
} finally { await rm(directory, { recursive: true, force: true }) }
