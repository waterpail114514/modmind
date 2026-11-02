import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = path.resolve(arg('directory') || 'test-results/game-control-loader-matrix'), resources = path.resolve(arg('resources') || 'test-results/game-control-matrix-resources')
const hostRoot = path.resolve(arg('host-root') || '.'), hostBranch = execFileSync('git', ['branch', '--show-current'], { cwd: hostRoot, encoding: 'utf8' }).trim()
const matrixPath = path.resolve(arg('matrix') || 'docs/game-control-compatibility/compatibility-matrix.json')
const matrix = JSON.parse(await fs.readFile(matrixPath, 'utf8'))
const reportPath = path.resolve(arg('report') || 'docs/game-control-compatibility/loader-runtime-results.json')
const preparationFiles = ['test-results/game-control-loader-preparation/results.json', 'test-results/game-control-forge-preparation/results.json', ...(arg('extra-preparation') ? [arg('extra-preparation')] : []), ...(arg('profile-variants') ? [arg('profile-variants')] : [])]
const only = arg('keys') ? new Set(arg('keys').split(',')) : undefined
const cacheRoot = arg('cache') ? path.resolve(arg('cache')) : undefined
const agentSha256 = JSON.parse(await fs.readFile('feature-plugins/testing/src/main/gameControlAgent.json', 'utf8')).jarSha256
const javas = { 8: path.resolve(process.env.APPDATA, '.minecraft/runtime/jre-legacy/bin/java.exe'), 17: path.resolve(process.env.APPDATA, 'modmind/build-jdks/temurin-17-windows-x64/bin/java.exe'), 21: path.resolve(process.env.APPDATA, 'modmind/build-jdks/temurin-21-x64/bin/java.exe'), 25: path.resolve(process.env.APPDATA, '.minecraft/runtime/java-runtime-epsilon/bin/java.exe') }
await fs.mkdir(root, { recursive: true })
if (process.argv.includes('--wait-for-vanilla')) {
  const deadline = Date.now() + 3 * 60 * 60000
  for (;;) {
    const report = await fs.readFile('docs/game-control-compatibility/runtime-results.json', 'utf8').then(JSON.parse, () => undefined)
    if (report?.completed === 63 && report.passed === 63 && report.rows.every(row => row.agentSha256 === agentSha256)) break
    if (Date.now() > deadline) throw new Error('Vanilla matrix incomplete; inspect it before launching more games')
    console.log(JSON.stringify({ phase: 'waiting-for-vanilla-matrix', passed: report?.passed || 0 })); await new Promise(resolve => setTimeout(resolve, 30000))
  }
}
if (process.argv.includes('--wait-for-base-matrix') || process.argv.includes('--wait-for-primary-completion')) {
  const deadline = Date.now() + 6 * 60 * 60000
  for (;;) {
    const base = await fs.readFile(path.join(hostRoot, 'docs/game-control-compatibility/loader-runtime-results.json'), 'utf8').then(JSON.parse, () => undefined)
    if (base?.completed === matrix.javaLoaderCombinationCount && (process.argv.includes('--wait-for-primary-completion') || base.passed === matrix.javaLoaderCombinationCount) && base.rows.every(row => row.agentSha256 === agentSha256)) break
    if (Date.now() > deadline) throw new Error('Primary Loader matrix incomplete; inspect it before more launches')
    console.log(JSON.stringify({ phase: 'waiting-for-primary-loader-matrix', passed: base?.passed || 0 })); await new Promise(resolve => setTimeout(resolve, 30000))
  }
}
const priority = ['fabric:1.21.1', 'quilt:1.20.1', 'forge:1.20.1', 'neoforge:1.21.1', 'forge:1.6.4']
const variants = arg('profile-variants') ? JSON.parse(await fs.readFile(arg('profile-variants'), 'utf8')).rows : undefined
if (variants && variants.length !== matrix.selectedLoaderProfileCount - matrix.javaLoaderCombinationCount) throw new Error('Additional catalog profile preparation is incomplete')
const scopeTargets = variants ? variants.map(row => {
  const target = matrix.combinations.find(target => target.key === row.baseKey)
  if (!target) throw new Error('Unknown profile base combination: ' + row.key)
  return { ...target, key: row.key, baseKey: row.baseKey }
}) : matrix.combinations
const targets = scopeTargets.filter(target => !only || only.has(target.key)).sort((a, b) => { const rank = key => priority.includes(key) ? priority.indexOf(key) : 100; return rank(a.key) - rank(b.key) })
const results = []
let consecutiveFailures = 0
for (const target of targets) {
  if (await fs.access(path.join(root, 'stop-after-current')).then(() => true, () => false)) { console.log(JSON.stringify({ phase: 'stopped-between-owned-games', completed: results.length })); break }
  if (JSON.parse(await fs.readFile('feature-plugins/testing/src/main/gameControlAgent.json', 'utf8')).jarSha256 !== agentSha256) throw new Error('Agent changed; restart Loader acceptance')
  const preparations = await Promise.all(preparationFiles.map(file => fs.readFile(file, 'utf8').then(JSON.parse, () => ({ rows: [] }))))
  const prepared = preparations.flatMap(report => report.rows.map(row => ({ ...row, resources: row.resources || report.resources }))).find(row => row.key === target.key && row.status === 'prepared')
  const directory = path.join(root, target.key.replace(':', '-'))
  const candidates = [path.join(directory, 'verification.json'), ...(cacheRoot ? [path.join(cacheRoot, target.key.replace(':', '-'), 'verification.json')] : [])]
  const cached = (await Promise.all(candidates.map(async file => ({ file, value: await fs.readFile(file, 'utf8').then(JSON.parse, () => undefined) })))).find(({ value }) => value?.agentSha256 === agentSha256 && value.worldLoaded && value.assertions.foregroundUnchanged && value.version === prepared?.versionId && (hostBranch !== '1.4' || value.routing.includes('real 1.4')))
  const requiredJava = target.java?.majorVersion || 8, javaMajor = requiredJava === 16 ? 17 : requiredJava
  const row = { key: target.key, minecraftVersion: target.minecraftVersion, loader: target.loader, requiredJava, javaMajor, agentSha256, hostBranch }
  if (!prepared) Object.assign(row, { status: 'resources-unavailable', runtimeVerified: false })
  else if (cached) Object.assign(row, { status: 'runtime-verified', runtimeVerified: true, versionId: prepared.versionId, loaderVersion: prepared.loaderVersion, report: path.relative(process.cwd(), cached.file).replaceAll('\\', '/') })
  else {
    await fs.mkdir(directory, { recursive: true })
    const log = createWriteStream(path.join(directory, 'acceptance.log'))
    const child = spawn(process.execPath, ['scripts/verify-game-control-mcp.mjs', `--directory=${directory}`, `--resources=${prepared.resources || resources}`, `--version=${prepared.versionId}`, `--minecraft-version=${target.minecraftVersion}`, `--loader=${target.loader}`, `--java=${javas[javaMajor]}`, '--create-world', ...(results.length % 2 ? ['--standalone'] : [])], { cwd: hostRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    console.log(JSON.stringify({ phase: 'running-loader', key: target.key, versionId: prepared.versionId, pid: child.pid }))
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }) } catch {} } else child.kill() }, 360000)
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }); clearTimeout(timer); log.end()
    const report = await fs.readFile(path.join(directory, 'verification.json'), 'utf8').then(JSON.parse, () => undefined)
    const passed = code === 0 && report?.agentSha256 === agentSha256 && report.worldLoaded && report.assertions.foregroundUnchanged
    Object.assign(row, { status: passed ? 'runtime-verified' : 'failed', runtimeVerified: Boolean(passed), versionId: prepared.versionId, loaderVersion: prepared.loaderVersion, profileSha256: prepared.profileSha256, timedOut, exitCode: code, report: path.relative(process.cwd(), path.join(directory, passed ? 'verification.json' : 'failure.json')).replaceAll('\\', '/') })
  }
  consecutiveFailures = row.runtimeVerified ? 0 : consecutiveFailures + 1
  results.push(row)
  const report = { updatedAt: new Date().toISOString(), hostBranch, evidenceRoot: process.cwd(), scope: variants ? 'additional catalog Loader profiles' : 'selected catalog Loader combinations', targetCombinations: scopeTargets.length, completed: results.length, passed: results.filter(row => row.runtimeVerified).length, rows: results }
  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(row))
  if (consecutiveFailures >= 3) { console.error('Three consecutive Loader failures; inspect and repair before more launches'); process.exitCode = 1; break }
}
if (results.some(row => !row.runtimeVerified)) process.exitCode = 1
