import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

if (process.platform !== 'darwin') throw new Error('Packaged smoke test requires macOS')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ModMind 中文 smoke '))
const appPath = path.resolve(process.argv[2] || `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/ModMind.app`)
const executable = path.join(appPath, 'Contents/MacOS/ModMind')
const child = spawn(executable, ['--macos-smoke-check'], { env: { ...process.env, MODMIND_SMOKE_ROOT: root }, stdio: 'inherit' })
const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60_000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
if (code !== 0) throw new Error(`Packaged smoke failed (${code}); evidence: ${root}`)
const report = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'))
if (!report.success || report.arch !== process.arch) throw new Error('Missing successful native smoke report')
await fs.mkdir('test-results', { recursive: true })
await fs.copyFile(path.join(root, 'result.json'), `test-results/macos-${process.arch}-smoke.json`)
console.log(JSON.stringify(report, null, 2))
await fs.rm(root, { recursive: true, force: true })
