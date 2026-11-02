import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

// Resumable sequential real-client acceptance. Vanilla results are never
// promoted to Loader results. All game instances and worlds are isolated.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = path.resolve(arg('directory') || 'test-results/game-control-runtime-matrix')
const resources = path.resolve(arg('resources') || 'test-results/game-control-matrix-resources')
const source = JSON.parse(await fs.readFile('docs/game-control-compatibility/versions.json', 'utf8')).versions
const agentSha256 = JSON.parse(await fs.readFile('feature-plugins/testing/src/main/gameControlAgent.json', 'utf8')).jarSha256
const only = arg('versions') ? new Set(arg('versions').split(',')) : undefined
const javas = {
  8: path.resolve(process.env.APPDATA, '.minecraft/runtime/jre-legacy/bin/java.exe'),
  17: path.resolve(process.env.APPDATA, 'modmind/build-jdks/temurin-17-windows-x64/bin/java.exe'),
  21: path.resolve(process.env.APPDATA, 'modmind/build-jdks/temurin-21-x64/bin/java.exe'),
  25: path.resolve(process.env.APPDATA, '.minecraft/runtime/java-runtime-epsilon/bin/java.exe')
}
for (const java of Object.values(javas)) await fs.access(java)
const priority = ['1.6.4', '1.13.2', '1.17.1', '1.21.1', '26.2']
const versions = source.filter(version => !only || only.has(version.id)).sort((a, b) => { const rank = id => priority.includes(id) ? priority.indexOf(id) : 100; return rank(a.id) - rank(b.id) })
await fs.mkdir(root, { recursive: true })
if (process.argv.includes('--wait-for-resources')) {
  const deadline = Date.now() + 30 * 60000
  for (;;) {
    const result = await fs.readFile('test-results/game-control-matrix-preparation/result.json', 'utf8').then(JSON.parse, () => undefined)
    if (result) { if (result.failures.length) throw new Error('Resource preparation has failures; repair them first'); break }
    if (Date.now() > deadline) throw new Error('Resource preparation not complete')
    console.log(JSON.stringify({ phase: 'waiting-for-verified-resources' })); await new Promise(resolve => setTimeout(resolve, 30000))
  }
}
const rows = []
async function persist() {
  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({ scope: 'vanilla actual game instances; no Loader combinations inferred', rows }, null, 2))
  await fs.writeFile('docs/game-control-compatibility/runtime-results.json', JSON.stringify({ updatedAt: new Date().toISOString(), scope: 'vanilla actual game instances; Loader combinations tracked separately', targetVersions: source.length, completed: rows.length, passed: rows.filter(row => row.status === 'runtime-verified').length, rows }, null, 2))
}
let failures = 0
for (const version of versions) {
  if (JSON.parse(await fs.readFile('feature-plugins/testing/src/main/gameControlAgent.json', 'utf8')).jarSha256 !== agentSha256) throw new Error('Agent changed during acceptance; restart the matrix for the new artifact')
  const directory = path.join(root, version.id), requiredJava = version.java?.majorVersion || 8, javaMajor = requiredJava === 16 ? 17 : requiredJava, java = javas[javaMajor]
  const existing = await fs.readFile(path.join(directory, 'verification.json'), 'utf8').then(JSON.parse, () => undefined)
  if (existing?.agentSha256 === agentSha256 && existing.worldLoaded && existing.assertions.foregroundUnchanged) { rows.push({ minecraftVersion: version.id, backend: 'vanilla', status: 'runtime-verified', worldLoaded: true, requiredJava, javaMajor, agentSha256, report: path.relative(process.cwd(), path.join(directory, 'verification.json')).replaceAll('\\', '/') }); await persist(); continue }
  await fs.mkdir(directory, { recursive: true })
  const log = createWriteStream(path.join(directory, 'acceptance.log'))
  const child = spawn(process.execPath, ['scripts/verify-game-control-mcp.mjs', `--directory=${directory}`, `--resources=${resources}`, `--version=${version.id}`, `--java=${java}`, '--create-world', ...(rows.length % 2 ? ['--standalone'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  console.log(JSON.stringify({ phase: 'running', minecraftVersion: version.id, javaMajor, pid: child.pid }))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32' && child.pid) { try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }) } catch {} }
    else child.kill()
  }, 330000)
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }); clearTimeout(timer); log.end()
  const report = await fs.readFile(path.join(directory, 'verification.json'), 'utf8').then(JSON.parse, () => undefined)
  const passed = code === 0 && report?.agentSha256 === agentSha256 && report.worldLoaded === true && report.assertions.foregroundUnchanged === true
  const row = { minecraftVersion: version.id, backend: 'vanilla', status: passed ? 'runtime-verified' : 'failed', worldLoaded: report?.worldLoaded === true, requiredJava, javaMajor, agentSha256, timedOut, exitCode: code, report: path.relative(process.cwd(), path.join(directory, passed ? 'verification.json' : 'failure.json')).replaceAll('\\', '/') }
  rows.push(row); console.log(JSON.stringify(row))
  await persist()
  failures = passed ? 0 : failures + 1
  if (failures >= 3) { console.error('Three consecutive failures; stop and inspect before more launches'); process.exitCode = 1; break }
}
if (rows.some(row => row.status !== 'runtime-verified')) process.exitCode = 1
