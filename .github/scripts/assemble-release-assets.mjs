import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const tag = process.env.RELEASE_TAG
const manifestName = process.env.RELAY_MANIFEST
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(tag ?? '') || !/^relay-[A-Za-z0-9._-]+\.json$/.test(manifestName ?? '')) {
  throw new Error('Invalid draft release or relay manifest name')
}
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const release = () => JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets']))
if (!release().isDraft) throw new Error('Only draft releases can receive assembled uploads')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-release-relay-'))
try {
  gh(['release', 'download', tag, '--pattern', manifestName, '--dir', root])
  const manifest = JSON.parse(await fs.readFile(path.join(root, manifestName), 'utf8'))
  if (manifest.tag !== tag || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10) throw new Error('Invalid relay manifest')
  const names = new Set(), parts = new Set()
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]+\.(?:exe|apk|zip)$/.test(file.name) || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1024 ** 3 || !Array.isArray(file.parts) || !file.parts.length || file.parts.length > 128) throw new Error('Invalid artifact declaration')
    names.add(file.name)
    for (const part of file.parts) {
      if (!/^relay-[A-Za-z0-9._-]+\.part[0-9]{3}$/.test(part.name) || parts.has(part.name) || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.size) || part.size <= 0 || part.size > 32 * 1024 ** 2) throw new Error('Invalid relay part')
      parts.add(part.name)
    }
  }
  for (const file of manifest.files) {
    const output = path.join(root, file.name), hash = createHash('sha256')
    let size = 0
    await fs.writeFile(output, '')
    for (const part of file.parts) {
      gh(['release', 'download', tag, '--pattern', part.name, '--dir', root])
      const bytes = await fs.readFile(path.join(root, part.name))
      if (bytes.length !== part.size || createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error(`Corrupt relay part: ${part.name}`)
      hash.update(bytes); size += bytes.length
      await fs.appendFile(output, bytes)
      await fs.unlink(path.join(root, part.name))
    }
    if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.name}`)
    console.log(`Verified ${file.name}: ${file.sha256}`)
  }
  if (!release().isDraft) throw new Error('Release was published during assembly')
  for (const file of manifest.files) gh(['release', 'upload', tag, path.join(root, file.name), '--clobber'])
  const uploaded = release().assets
  for (const file of manifest.files) {
    const asset = uploaded.find(asset => asset.name === file.name)
    if (asset?.digest !== `sha256:${file.sha256}` || asset.size !== file.size || asset.state !== 'uploaded') throw new Error(`Published asset verification failed: ${file.name}`)
  }
  // Delete only temporary parts belonging to this successfully verified upload.
  for (const name of [...parts, manifestName]) gh(['release', 'delete-asset', tag, name, '--yes'])
  console.log('Upload verified; temporary relay assets removed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
