import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Check existing ancestors before mkdir/write, including a linked leaf. */
export async function scopedFilePath(root: string, relative: string): Promise<string> {
  const parts = relative.replaceAll('\\', '/').split('/')
  if (!relative || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)
    || /[\0\r\n:]/.test(relative) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe scoped path: ${relative}`)
  }
  const base = await fs.realpath(root)
  let target = base
  for (const part of parts) {
    target = path.join(target, part)
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw new Error(`Scoped path crosses a link: ${relative}`)
  }
  return target
}
