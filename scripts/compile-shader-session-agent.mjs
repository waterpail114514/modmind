import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'resources/shader-runtime/ShaderSessionAgent.java')
const target = path.join(root, 'feature-plugins/shader-shared/src/main/shaderSessionAgent.json')
const directory = await mkdtemp(path.join(os.tmpdir(), 'modmind-shader-agent-'))
try {
  execFileSync(process.argv[2] || 'javac', ['--release', '17', '-encoding', 'UTF-8', '-d', directory, source], { stdio: 'inherit', windowsHide: true })
  const classes = []
  for (const name of (await readdir(path.join(directory, 'dev/modmind/shader'))).sort()) {
    const bytes = await readFile(path.join(directory, 'dev/modmind/shader', name))
    classes.push({ path: `dev/modmind/shader/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') })
  }
  await writeFile(target, JSON.stringify({ sourceSha256: createHash('sha256').update((await readFile(source, 'utf8')).replaceAll('\r\n', '\n')).digest('hex'), classes }, null, 2) + '\n')
} finally { await rm(directory, { recursive: true, force: true }) }
