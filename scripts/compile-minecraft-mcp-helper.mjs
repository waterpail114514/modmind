import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
const sources = ['ScreenshotHelper', 'WindowHelper'].map(name => path.resolve(`resources/minecraft-mcp/${name}.java`))
const target = path.resolve('src/main/nativeMinecraftMcpHelper.json')
const directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-mcp-helper-'))
try {
  if (!process.argv[3]) throw new Error('Usage: node scripts/compile-minecraft-mcp-helper.mjs <javac> <verified v0.3.0 upstream JAR>')
  const upstream = await readFile(process.argv[3])
  if (createHash('sha256').update(upstream).digest('hex') !== 'a447f4b6424424879c2d4050694f8cb0d71cc0a60d49a3c46b087e710c01e418') throw new Error('Use the pinned Fabric 1.20.1 v0.3.0 upstream JAR for reproducible compilation')
  execFileSync(process.argv[2] || 'javac', ['--release', '8', '-encoding', 'UTF-8', '-cp', process.argv[3], '-d', directory, ...sources], { stdio: 'inherit', windowsHide: true })
  const classes = []
  for (const source of sources) {
    const classPath = `xyz/langyo/minecraft/mcp/common/${path.basename(source, '.java')}.class`
    const bytes = await readFile(path.join(directory, classPath))
    classes.push({ path: classPath, source: path.relative(process.cwd(), source).replaceAll('\\', '/'), sourceSha256: createHash('sha256').update((await readFile(source, 'utf8')).replaceAll('\r\n', '\n')).digest('hex'), classSha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') })
  }
  await writeFile(target, JSON.stringify({ classes }, null, 2) + '\n')
} finally { await rm(directory, { recursive: true, force: true }) }
