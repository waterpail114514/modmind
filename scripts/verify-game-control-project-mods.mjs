import { promises as fs, createWriteStream } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const main = process.cwd(), host = path.resolve(arg('host-root') || '.')
const read = file => fs.readFile(file, 'utf8').then(JSON.parse)
const artifact = await read('feature-plugins/testing/src/main/gameControlAgent.json')
const matrix = await read(path.join(host, 'docs/game-control-compatibility/compatibility-matrix.json'))
if (process.argv.includes('--wait-for-profile-matrix')) {
  const deadline = Date.now() + 3 * 60 * 60000
  for (;;) {
    const report = await read(path.join(host, 'docs/game-control-compatibility/loader-profile-runtime-results.json')).catch(() => undefined)
    const expected = matrix.selectedLoaderProfileCount - matrix.javaLoaderCombinationCount
    if (report?.completed === expected && report.passed === expected && report.rows.every(row => row.agentSha256 === artifact.jarSha256)) break
    assert(Date.now() < deadline, 'Additional Loader profile matrix incomplete; inspect it before another game')
    console.log(JSON.stringify({ phase: 'waiting-for-profile-matrix', passed: report?.passed || 0, expected }))
    await new Promise(resolve => setTimeout(resolve, 30000))
  }
}
const prepared = await read('test-results/game-control-forge-preparation/results.json')
const targets = [
  { key: 'forge:1.20.1', name: 'game-control-project-mod-forge', java: 'temurin-17-windows-x64' },
  { key: 'neoforge:1.21.1', name: 'game-control-project-mod-neo', java: 'temurin-21-x64' }
]
const rows = []
for (const target of targets) {
  const preparation = prepared.rows.find(row => row.key === target.key && row.status === 'prepared')
  assert(preparation, 'Missing existing project-Mod resources: ' + target.key)
  const directory = path.join(host, 'test-results', target.name)
  await fs.mkdir(directory, { recursive: true })
  const java = path.join(process.env.APPDATA, 'modmind/build-jdks', target.java, 'bin/java.exe')
  const reportPath = path.join(directory, 'verification.json')
  let proof = await read(reportPath).catch(() => undefined), exitCode = 0
  if (!(proof?.agentSha256 === artifact.jarSha256 && proof.projectModLoaded && proof.assertions?.sharedViewerRevision)) {
    const log = createWriteStream(path.join(directory, 'acceptance.log'))
    const child = spawn(process.execPath, ['scripts/verify-game-control-mcp.mjs', `--directory=${directory}`, `--resources=${prepared.resources}`, `--version=${preparation.versionId}`, `--minecraft-version=${preparation.minecraftVersion}`, `--loader=${preparation.loader}`, `--java=${java}`, '--fixture-mod', '--create-world', ...(rows.length ? ['--standalone'] : [])], { cwd: host, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    console.log(JSON.stringify({ phase: 'running-project-mod', key: target.key, pid: child.pid }))
    const timer = setTimeout(() => { try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }) } catch {} }, 360000)
    exitCode = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    clearTimeout(timer); log.end()
    proof = await read(reportPath).catch(() => undefined)
  }
  const passed = exitCode === 0 && proof?.agentSha256 === artifact.jarSha256 && proof.projectModLoaded && proof.projectModArtifact?.sha256 && proof.worldLoaded && proof.assertions.foregroundUnchanged
  rows.push({ key: target.key + ':project-mod', minecraftVersion: preparation.minecraftVersion, loader: preparation.loader, agentSha256: artifact.jarSha256, status: passed ? 'runtime-verified' : 'failed', runtimeVerified: Boolean(passed), report: reportPath })
  await fs.writeFile(path.join(main, 'test-results/game-control-project-mod-runtime.json'), JSON.stringify({ updatedAt: new Date().toISOString(), evidenceRoot: host, targetCombinations: targets.length, completed: rows.length, passed: rows.filter(row => row.runtimeVerified).length, rows }, null, 2))
  console.log(JSON.stringify(rows.at(-1)))
  if (!passed) { process.exitCode = 1; break }
}
