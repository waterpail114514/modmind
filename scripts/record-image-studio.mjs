import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = resolve(root, 'test-results/image-studio-recorder/recorder.mjs')
await build({ entryPoints: [resolve(root, 'scripts/image-studio-recorder.ts')], outfile, bundle: true, platform: 'node', format: 'esm' })
const child = spawn(process.execPath, [outfile], { stdio: 'inherit', windowsHide: true })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
