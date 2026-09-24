import { promises as fs } from 'node:fs'
import path from 'node:path'
import { projectImageReference } from '../shared/projectImages'

export async function readProjectImage(projectRoot: string, reference: string): Promise<string> {
  const normalized = projectImageReference(reference)
  if (!normalized) throw new Error('只能预览项目内的 PNG、JPEG、WebP、GIF 或 BMP 图片')
  const root = path.resolve(projectRoot)
  const realRoot = await fs.realpath(root)
  const target = path.resolve(root, normalized)
  const inside = (file: string, base = root): boolean => {
    const relative = path.relative(base, file)
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  if (!inside(target) || !inside(await fs.realpath(target), realRoot)) throw new Error('只能预览当前项目内的图片')
  const file = await fs.open(target, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('图片不存在或超过 20 MB')
    const mime = /\.jpe?g$/i.test(normalized) ? 'image/jpeg' : /\.webp$/i.test(normalized) ? 'image/webp' : /\.gif$/i.test(normalized) ? 'image/gif' : /\.bmp$/i.test(normalized) ? 'image/bmp' : 'image/png'
    return `data:${mime};base64,${(await file.readFile()).toString('base64')}`
  } finally { await file.close() }
}
