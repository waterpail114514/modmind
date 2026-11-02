import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'

// Verify files independently of the acceptance runner: a success JSON alone
// cannot prove that the recorded PNGs, frames and desktop samples exist.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = path.resolve(arg('evidence-root') || '.'), reportPath = path.resolve(arg('report') || 'docs/game-control-compatibility/runtime-results.json')
const output = path.resolve(arg('output') || 'test-results/game-control-evidence.json')
const matrix = JSON.parse(await fs.readFile(reportPath, 'utf8'))
const artifact = JSON.parse(await fs.readFile(arg('agent-artifact') || 'feature-plugins/testing/src/main/gameControlAgent.json', 'utf8'))
const rows = []
for (const row of matrix.rows) {
  if (row.status !== 'runtime-verified') { rows.push({ key: row.key || row.minecraftVersion, status: 'not-verified' }); continue }
  const file = path.resolve(root, row.report)
  assert(file.startsWith(root + path.sep), 'Evidence must stay within the explicit evidence root')
  const directory = path.dirname(file), report = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(report.agentSha256, artifact.jarSha256)
  assert.equal(report.minecraftVersion, row.minecraftVersion)
  assert.equal(report.worldLoaded, true)
  assert.equal(report.ready.pid, report.current.pid)
  assert.equal(report.current.ownership, 'ai')
  assert.deepEqual(report.current.keysDown, []); assert.deepEqual(report.current.buttonsDown, [])
  for (const value of Object.values(report.assertions)) assert.equal(value, true)
  const frames = Object.entries(report.captures)
  assert(frames.length >= 10, 'Full acceptance needs menu, world, input and ownership images')
  let previous = 0, imageBytes = 0
  for (const [name, capture] of frames) {
    assert(capture.frameId > previous, `Fresh frame missing at ${row.key || row.minecraftVersion}/${name}`); previous = capture.frameId
    const imagePath = path.resolve(directory, capture.path)
    assert(imagePath.startsWith(directory + path.sep), 'Capture must stay in its owned evidence directory')
    const bytes = await fs.readFile(imagePath), metadata = await sharp(bytes).metadata()
    assert.equal(bytes.length, capture.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), capture.sha256)
    assert.equal(metadata.format, 'png'); assert.equal(metadata.width, capture.width); assert.equal(metadata.height, capture.height)
    imageBytes += bytes.length
  }
  for (const [before, after] of [['before', 'after'], ['after', 'inventory'], ['text', 'replaced']]) {
    assert.notEqual(report.captures[before].sha256, report.captures[after].sha256, `Rendered result did not change: ${before}/${after}`)
    assert(report.captures[after].actionSequence > report.captures[before].actionSequence)
  }
  const desktop = JSON.parse(await fs.readFile(path.join(directory, 'desktop.json'), 'utf8'))
  assert.equal(desktop.gameProcessId, report.ready.pid); assert.equal(desktop.gameEverForeground, false)
  assert.equal(desktop.samples.length, report.desktop.samples); assert(desktop.samples.length >= 50)
  assert(desktop.samples.every(sample => !sample.gameForeground && sample.process !== report.ready.pid))
  const clips = [...new Set(desktop.samples.map(sample => sample.clip.join(',')))]
  assert.deepEqual(clips, report.desktop.clips)
  if (report.projectModArtifact?.copiedJar) {
    const jar = path.resolve(directory, report.projectModArtifact.copiedJar), marker = path.resolve(directory, report.projectModArtifact.markerLog)
    assert(jar.startsWith(directory + path.sep) && marker.startsWith(directory + path.sep), 'Project-Mod evidence escaped its owned fixture')
    const bytes = await fs.readFile(jar)
    assert.equal(bytes.length, report.projectModArtifact.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), report.projectModArtifact.sha256)
    assert((await fs.readFile(marker, 'utf8')).includes('MODMIND_PROJECT_MOD_LOADED'), 'Project-Mod entrypoint marker missing')
  }
  const scopes = { scope: report.desktop.scope || 'actions-after-world-load', samples: desktop.samples.length, clips }
  rows.push({ key: row.key || row.minecraftVersion, status: 'evidence-verified', frames: frames.length, imageBytes, desktop: scopes, projectModLoaded: report.projectModLoaded, resize: report.resize, report: row.report })
}
const result = { checkedAt: new Date().toISOString(), reportPath, evidenceRoot: root, agentSha256: artifact.jarSha256, expected: matrix.targetCombinations || matrix.targetVersions, completed: matrix.completed, verified: rows.filter(row => row.status === 'evidence-verified').length, rows }
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ expected: result.expected, completed: result.completed, verified: result.verified, output }))
if (process.argv.includes('--require-complete')) assert.equal(result.verified, result.expected, 'The complete catalog has not passed runtime and file verification')
