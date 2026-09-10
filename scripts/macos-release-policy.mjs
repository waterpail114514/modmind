import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export function macArtifactNames(version, arch) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid release version or architecture')
  return ['dmg', 'zip'].map(ext => `ModMind-${version}-${arch}.${ext}`)
}
export function assertMacArchitecture(output, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`)
  const architectures = output.trim().split(/\s+/)
  if (architectures.length !== 1 || architectures[0] !== (arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error(`Wrong architecture: expected ${arch}, got ${output}`)
}
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex').toUpperCase()
}
