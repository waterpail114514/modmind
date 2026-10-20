import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Check every ancestor before a download/import is allowed to write beneath a project. */
export async function assertContentTarget(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('内容路径越界')
  let current = path.resolve(root)
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw new Error(`内容目标包含链接：${relative}`)
  }
}
