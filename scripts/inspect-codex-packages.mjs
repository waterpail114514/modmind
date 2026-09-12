// Maintainer tool: freeze official metadata only after inspecting each actual archive.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const version = '0.154.0'
const vendors = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl'
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-review-'))
try {
  const results = []
  for (const [id, vendor] of Object.entries(vendors).filter(([id]) => !process.argv[2] || id === process.argv[2])) {
    const metadata = await fetch(`https://registry.npmjs.org/@openai%2fcodex/${version}-${id}`).then(r => r.json())
    const archive = path.join(root, `${id}.tgz`)
    const download = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--retry', '3', '--retry-all-errors', '--max-time', '600', '--silent', '--show-error', '--output', archive, metadata.dist.tarball], { encoding: 'utf8', timeout: 2500000 })
    if (download.status !== 0) throw new Error(download.stderr)
    const bytes = await fs.readFile(archive)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (integrity !== metadata.dist.integrity) throw new Error(`Integrity mismatch: ${id}`)
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    if (listing.status !== 0) throw new Error(listing.stderr)
    const executableRelativePath = `package/vendor/${vendor}/bin/${id.startsWith('win32') ? 'codex.exe' : 'codex'}`
    if (!listing.stdout.split(/\r?\n/).includes(executableRelativePath)) throw new Error(`Missing executable: ${id}\n${listing.stdout}`)
    const extracted = path.join(root, id)
    await fs.mkdir(extracted)
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', extracted])
    if (unpack.status !== 0) throw new Error(`Cannot unpack ${id}`)
    if (!(await fs.lstat(path.join(extracted, executableRelativePath))).isFile()) throw new Error(`Not a regular executable: ${id}`)
    console.log(`Inspected ${id}: ${executableRelativePath}`)
    await fs.rm(extracted, { recursive: true, force: true })
    results.push({ id, archiveName: path.basename(metadata.dist.tarball), executableRelativePath, integrity, sha512: createHash('sha512').update(bytes).digest('hex'), files: listing.stdout.trim().split(/\r?\n/) })
  }
  await fs.mkdir('test-results', { recursive: true })
  await fs.writeFile(`test-results/codex-package-inspection-${process.argv[2] || 'all'}.json`, JSON.stringify({ version, inspectedAt: new Date().toISOString(), targets: results }, null, 2) + '\n')
} finally { await fs.rm(root, { recursive: true, force: true }) }
