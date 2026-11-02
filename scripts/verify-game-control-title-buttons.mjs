import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { findTitlePlayButton } from './game-control-visual.mjs'

const report = JSON.parse(await fs.readFile('docs/game-control-compatibility/runtime-results.json', 'utf8'))
const samples = report.rows.filter(row => row.status === 'runtime-verified').map(row => ({ key: row.minecraftVersion, file: path.join(path.dirname(row.report), 'title.png'), expected: 250 }))
samples.push({ key: 'neoforge:1.21.1', file: 'test-results/game-control-loader-matrix/neoforge-1.21.1/title.png', expected: 218 })
const rows = []
for (const sample of samples) {
  const button = await findTitlePlayButton(await fs.readFile(sample.file))
  rows.push({ key: sample.key, button })
  assert(button && Math.abs(button.y - sample.expected) <= 18, 'Incorrect title-menu target: ' + sample.key + ' ' + JSON.stringify(button))
}
await fs.writeFile('test-results/game-control-title-detection.json', JSON.stringify({ verified: rows.length, rows }, null, 2))
console.log(JSON.stringify({ verified: rows.length }))
