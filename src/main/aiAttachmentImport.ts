import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MAX_AI_ATTACHMENTS, MAX_INLINE_ATTACHMENT_BYTES, type AiAttachmentSource } from '../shared/aiAttachments'
import type { AiAttachment } from '../shared/types'

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function safeName(source: string): string {
  const extension = path.extname(source).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16)
  const stem = path.basename(source, path.extname(source)).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'attachment'
  return `${stem}${extension}`
}

/** Stage every source before writing, and roll back this batch if copying fails. */
export async function importAiAttachmentSources(projectPath: string, sources: AiAttachmentSource[]): Promise<AiAttachment[]> {
  if (!Array.isArray(sources) || sources.length > MAX_AI_ATTACHMENTS) throw new Error(`一次最多上传 ${MAX_AI_ATTACHMENTS} 个附件`)
  if (!sources.length) return []
  const targetDirectory = path.resolve(projectPath, '.modmind', 'attachments')
  const canonicalProject = await fs.realpath(projectPath)
  const canonicalTarget = await fs.realpath(targetDirectory).catch(() => path.join(canonicalProject, '.modmind', 'attachments'))
  const staged = await Promise.all(sources.map(async (source) => {
    if (!source || typeof source !== 'object') throw new Error('附件数据无效')
    if ('path' in source) {
      if (typeof source.path !== 'string' || !path.isAbsolute(source.path)) throw new Error('附件路径无效')
      const canonicalSource = await fs.realpath(source.path)
      const stat = await fs.stat(canonicalSource)
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('只能上传文件或文件夹')
      if (stat.isDirectory() && (inside(canonicalTarget, canonicalSource) || inside(canonicalSource, canonicalTarget))) {
        throw new Error('不能上传 ModMind 附件目录或包含它的文件夹')
      }
      return { source: canonicalSource, name: safeName(source.path), size: stat.size, isDirectory: stat.isDirectory() }
    }
    if (typeof source.name !== 'string' || !(source.bytes instanceof Uint8Array)) throw new Error('附件数据无效')
    if (source.bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES) throw new Error('粘贴的单个附件不能超过 32 MB，请保存为文件后拖入')
    return { bytes: source.bytes, name: safeName(source.name), size: source.bytes.byteLength, isDirectory: false }
  }))
  await fs.mkdir(targetDirectory, { recursive: true })
  const destinations: string[] = []
  const attachments: AiAttachment[] = []
  try {
    for (const file of staged) {
      const id = randomUUID()
      const fileName = `${id.slice(0, 8)}-${file.name}`
      const destination = path.join(targetDirectory, fileName)
      destinations.push(destination)
      if (file.source) {
        if (file.isDirectory) await fs.cp(file.source, destination, { recursive: true })
        else await fs.copyFile(file.source, destination)
      } else await fs.writeFile(destination, file.bytes!)
      attachments.push({ id, name: file.name, path: path.posix.join('.modmind', 'attachments', fileName), size: file.size, isImage: !file.isDirectory && /\.(?:png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name), isDirectory: file.isDirectory })
    }
    return attachments
  } catch (error) {
    await Promise.allSettled(destinations.map((destination) => fs.rm(destination, { recursive: true, force: true })))
    throw error
  }
}
