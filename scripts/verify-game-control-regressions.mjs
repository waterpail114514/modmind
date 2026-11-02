import { spawn } from 'node:child_process'
import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'

// Keep the two full suites sequential while the real-game matrix uses the GPU.
// The 20 s runner budget includes child-process startup; assertions and their
// own operation/abort deadlines remain unchanged.
const main = process.cwd(), branch = path.resolve(process.argv[2] || 'D:/Codex/UserData/worktrees/modmind-1-4-14/modmind')
const results = []
for (const [cwd, name] of [[branch, 'port'], [main, 'unified']]) {
  const report = path.join(cwd, `test-results/game-control-regression-${name}-final.json`)
  const output = createWriteStream(path.join(cwd, `test-results/game-control-regression-${name}-final.log`))
  console.log(JSON.stringify({ phase: 'full-regression', cwd }))
  const child = spawn(process.execPath, [path.join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', 'src', '--maxWorkers=2', '--testTimeout=20000', '--reporter=json', '--outputFile=' + report], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) }); output.end()
  const data = JSON.parse(await fs.readFile(report, 'utf8'))
  results.push({ cwd, exitCode: code, total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests, skipped: data.numPendingTests })
  console.log(JSON.stringify(results.at(-1)))
}
await fs.writeFile(path.join(main, 'test-results/game-control-full-regression-summary.json'), JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 2))
if (results.some(result => result.exitCode !== 0 || result.failed)) process.exitCode = 1
