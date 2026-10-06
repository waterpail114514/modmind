import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { JavaRuntimeManifest } from '@xmcl/installer'

export const MANAGED_JAVA_MANIFEST = '.modmind-java-manifest.json'
const hashes = new Map<string, { size: number; mtime: number; ctime: number; sha1: string }>()

/** Validate downloads offline; legacy installations at least reject empty native files. */
export async function validManagedJavaCache(home: string): Promise<boolean> {
  try {
    let manifest: JavaRuntimeManifest
    try { manifest = JSON.parse(await fs.readFile(path.join(home, MANAGED_JAVA_MANIFEST), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      let count = 0
      const visit = async (directory: string): Promise<boolean> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (++count > 10_000) return false
          const file = path.join(directory, entry.name)
          if (entry.isDirectory() && !await visit(file)) return false
          if (entry.isFile() && /\.(?:dll|exe|so|dylib)$|^java$/i.test(entry.name) && (await fs.stat(file)).size === 0) return false
        }
        return true
      }
      return await visit(home)
    }
    if (!manifest.files || !Object.keys(manifest.files).length) return false
    for (const [relative, entry] of Object.entries(manifest.files)) {
      if (entry.type !== 'file') continue
      const file = path.resolve(home, relative)
      if (!file.startsWith(`${path.resolve(home)}${path.sep}`)) return false
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size !== entry.downloads.raw.size) return false
      let prior = hashes.get(file)
      if (!prior || prior.size !== stat.size || prior.mtime !== stat.mtimeMs || prior.ctime !== stat.ctimeMs) {
        const hash = createHash('sha1')
        for await (const chunk of createReadStream(file)) hash.update(chunk)
        prior = { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, sha1: hash.digest('hex') }
        hashes.set(file, prior)
        if (hashes.size > 1024) hashes.delete(hashes.keys().next().value!)
      }
      if (prior.sha1 !== entry.downloads.raw.sha1) return false
    }
    return true
  } catch { return false }
}
