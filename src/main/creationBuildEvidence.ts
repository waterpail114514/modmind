import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

const ignored = new Set(['.git', '.gradle', '.modmind', '.modtool', 'node_modules', 'build', 'out', 'target', 'logs', 'crash-reports', 'docs', '__pycache__', 'HeadlessMC'])
const inputHashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; hash: string }>()
async function cachedInputHash(file: string): Promise<string> {
  const stat = await fs.stat(file)
  const prior = inputHashes.get(file)
  if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs && prior.ctimeMs === stat.ctimeMs) return prior.hash
  const hash = await artifactHash(file)
  const after = await fs.stat(file)
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error(`构建输入正在变化：${file}`)
  inputHashes.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash })
  if (inputHashes.size > 100_000) inputHashes.delete(inputHashes.keys().next().value!)
  return hash
}
export function isBuildInput(relative: string): boolean {
  return !relative.replaceAll('\\', '/').split('/').some(part => ignored.has(part) || /^run(?:-|$)/.test(part)) && !/\.(?:log|pyc|pyo|tmp)$/i.test(relative)
}
export async function artifactHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
/** Project source/configuration/assets, excluding conventional generated and diagnostic directories. */
export async function buildInputFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(directory: string, relative = ''): Promise<void> {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (!isBuildInput(name)) continue
      const target = path.join(directory, entry.name)
      // Symlink targets may change independently; refuse to certify an incomplete input set.
      if (entry.isSymbolicLink()) throw new Error(`构建输入包含符号链接，无法确认完整指纹：${name}`)
      if (entry.isDirectory()) await visit(target, name)
      else if (entry.isFile()) hash.update(name).update('\0').update(await cachedInputHash(target)).update('\0')
    }
  }
  await visit(root)
  return hash.digest('hex')
}

export function currentVerification(used: boolean, verified: Map<string, string> | null, current: Map<string, string>): boolean {
  if (!used || !verified) return false
  const left = [...verified].filter(([name]) => isBuildInput(name))
  const right = [...current].filter(([name]) => isBuildInput(name))
  return left.length === right.length && left.every(([name, hash]) => current.get(name) === hash)
}
