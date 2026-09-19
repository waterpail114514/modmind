import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

const MAX_TEXT_BYTES = 1024 * 1024

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isAllowed(base: string, target: string, tools: string, uploads: string): boolean {
  return isInside(base, target) && !isInside(path.join(base, '.git'), target)
    && (!isInside(tools, target) || isInside(uploads, target))
}

export async function resolveReadablePath(project: ProjectInfo, requestedPath: unknown) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath.length > 8192
    || /[\0\r\n:]/.test(requestedPath) || path.posix.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    throw new Error('Provide a project-relative file path')
  }
  const root = path.resolve(project.path)
  const target = path.resolve(root, requestedPath.replaceAll('\\', '/'))
  const toolRoot = path.resolve(root, project.toolDataDirectory ?? '.modmind')
  const attachments = path.join(toolRoot, 'attachments')
  if (!isAllowed(root, target, toolRoot, attachments)) throw new Error('File must be inside the project or its attachments; internal tool data is unavailable')

  // Check the real path too, so a symlink cannot expose files outside this scope.
  const realRoot = await fs.realpath(root)
  const realTarget = await fs.realpath(target)
  const realToolRoot = await fs.realpath(toolRoot).catch(() => path.resolve(realRoot, path.relative(root, toolRoot)))
  const realAttachments = await fs.realpath(attachments).catch(() => path.join(realToolRoot, 'attachments'))
  if (!isAllowed(realRoot, realTarget, realToolRoot, realAttachments)) throw new Error('File resolves outside the allowed project scope')
  return { root, target, toolRoot, attachments, realRoot, realTarget, realToolRoot, realAttachments }
}

/** List one directory at a time, including uploaded folders omitted from the project index. */
export async function listProjectDirectory(project: ProjectInfo, requestedPath: unknown, offset: unknown = 0, limit: unknown = 200) {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('offset must be a non-negative integer; limit must be between 1 and 500')
  }
  const scope = await resolveReadablePath(project, requestedPath)
  if (!(await fs.stat(scope.realTarget)).isDirectory()) throw new Error('Requested path is not a directory; use modmind_read_project_file for text files')
  const children = await fs.readdir(scope.realTarget, { withFileTypes: true })
  const entries = children.filter(entry => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory())
    && isAllowed(scope.root, path.join(scope.target, entry.name), scope.toolRoot, scope.attachments)
    && isAllowed(scope.realRoot, path.join(scope.realTarget, entry.name), scope.realToolRoot, scope.realAttachments))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const end = Math.min(offset + limit, entries.length)
  return {
    path: path.relative(scope.root, scope.target).replaceAll('\\', '/') || '.',
    entries: entries.slice(offset, end).map(entry => ({
      name: entry.name,
      path: path.relative(scope.root, path.join(scope.target, entry.name)).replaceAll('\\', '/'),
      type: entry.isDirectory() ? 'directory' as const : 'file' as const
    })),
    totalEntries: entries.length, offset, truncated: end < entries.length,
    ...(end < entries.length ? { nextOffset: end } : {}),
    skippedEntries: children.length - entries.length
  }
}

export async function readProjectTextFile(project: ProjectInfo, requestedPath: unknown, startLine: unknown = 1, lineCount: unknown = 200) {
  if (typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1
    || typeof lineCount !== 'number' || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 500) {
    throw new Error('startLine must be a positive integer; lineCount must be between 1 and 500')
  }
  const { root, target, realTarget } = await resolveReadablePath(project, requestedPath)
  if (/\.(docx|pdf)$/i.test(target)) throw new Error('Use modmind_read_document for DOCX/PDF text extraction; these are not plain-text files')
  if ((await fs.stat(realTarget)).isDirectory()) throw new Error('Requested path is a directory; use modmind_list_project_directory to list its contents, then modmind_read_project_file for individual text files')
  const handle = await fs.open(realTarget, 'r')
  let bytes: Buffer
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Requested path is not a regular file')
    if (stat.size > MAX_TEXT_BYTES) throw new Error('Text file exceeds the 1 MiB read limit')
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_TEXT_BYTES) throw new Error('Text file exceeds the 1 MiB read limit')
    bytes = buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
  if (bytes.includes(0)) throw new Error('This tool reads UTF-8 text only; binary files are unsupported')
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('File is not valid UTF-8 text') }
  const lines = content.length ? content.split(/\r\n|\n|\r/) : []
  if (startLine > Math.max(1, lines.length)) throw new Error(`startLine exceeds the file's ${lines.length} lines`)
  const endLine = Math.min(lines.length, startLine - 1 + lineCount)
  return {
    path: path.relative(root, target).replaceAll('\\', '/'),
    content: lines.slice(startLine - 1, endLine).join('\n'),
    startLine, endLine, totalLines: lines.length,
    truncated: endLine < lines.length,
    ...(endLine < lines.length ? { nextStartLine: endLine + 1 } : {})
  }
}
