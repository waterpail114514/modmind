import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const platformIndex = process.argv.indexOf('--platform')
if (process.platform === 'darwin' || (platformIndex >= 0 && process.argv[platformIndex + 1] === 'mac')) {
  await import('./verify-macos-release.mjs')
  process.exit(0)
}

const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const releaseRoot = path.join(root, 'release')
const allowUnsigned = process.argv.includes('--allow-unsigned')
const artifacts = [
  path.join(releaseRoot, `ModMind Setup ${version}.exe`)
]

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex').toUpperCase()
}

const results = []
for (const file of artifacts) {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size < 10 * 1024 * 1024) {
    throw new Error(`Missing or implausibly small release artifact: ${file}`)
  }
  results.push({ file, size: stat.size, hash: await sha256(file) })
}

if (process.platform === 'win32') {
  for (const result of results) {
    const escaped = result.file.replaceAll("'", "''")
    const check = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`
    ], { encoding: 'utf8', windowsHide: true })
    const status = check.stdout.trim()
    if (!allowUnsigned && status !== 'Valid') throw new Error(`${path.basename(result.file)} signature is ${status || 'unknown'}`)
    result.signature = status || 'Unknown'
  }
}

await fs.writeFile(
  path.join(releaseRoot, 'SHA256SUMS.txt'),
  `${results.map((result) => `${result.hash}  ${path.basename(result.file)}`).join('\n')}\n`,
  'utf8'
)
process.stdout.write(`${JSON.stringify({ version, artifacts: results.map((result) => ({ ...result, file: path.basename(result.file) })) }, null, 2)}\n`)
