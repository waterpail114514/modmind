import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { retryTransientFileLock } from './fileLockRetry'

const pending = new Map<string, Promise<{ content: string; cached: boolean; stale: boolean }>>()

/** Validate both old and downloaded data; publish only complete, usable cache files. */
export function readValidatedTextCache(
  target: string,
  download: () => Promise<string>,
  validate: (content: string) => void,
  maxBytes = 32 * 1024 * 1024,
  maxAgeMs?: number
): Promise<{ content: string; cached: boolean; stale: boolean }> {
  target = path.resolve(target)
  const existing = pending.get(target)
  if (existing) return existing
  const operation = (async () => {
    // Kept only as a fallback for a failed refresh; never published as fresh data.
    let stale: string | undefined
    try {
      const stat = await fs.lstat(target)
      if (stat.isFile() && stat.size > 0 && stat.size <= maxBytes) {
        const content = await fs.readFile(target, 'utf8')
        validate(content)
        // mtime is the TTL basis, so a refreshed file stays valid across process restarts.
        if (maxAgeMs === undefined || Date.now() - stat.mtimeMs <= maxAgeMs) return { content, cached: true, stale: false }
        stale = content
      }
    } catch {
      // Missing or invalid data is rebuilt once. A failed rebuild remains retryable.
    }
    try {
      const content = await download()
      if (!content.trim() || Buffer.byteLength(content) > maxBytes) throw new Error('缓存内容为空或超过大小上限')
      validate(content)
      const temporary = `${target}.pending-${randomUUID()}`
      await fs.mkdir(path.dirname(target), { recursive: true })
      try {
        await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
        await retryTransientFileLock(() => fs.rename(temporary, target))
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
      return { content, cached: false, stale: false }
    } catch (error) {
      // The last good payload is better than nothing: offline scans keep their catalog.
      if (stale !== undefined) return { content: stale, cached: true, stale: true }
      throw error
    }
  })()
  pending.set(target, operation)
  void operation.finally(() => { if (pending.get(target) === operation) pending.delete(target) }).catch(() => undefined)
  return operation
}
