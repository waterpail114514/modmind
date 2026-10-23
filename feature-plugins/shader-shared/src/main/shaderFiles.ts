import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { ShaderFile } from '../../../../src/shared/shaderStudio'

export const MAX_FILE = 2 * 1024 * 1024, MAX_PACK = 128 * 1024 * 1024, MAX_FILES = 2048
export const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
export const textExtension = /\.(?:fsh|vsh|gsh|csh|glsl|properties|lang|txt|md|json|mcmeta)$/i
export const stages = /\.(vsh|fsh|gsh|csh)$/i
// Native feature bundles share one main process; preserve serialization across source and options packages.
const queueKey = Symbol.for('modmind.shader.pendingWrites.v1')
const sharedState = globalThis as typeof globalThis & { [key: symbol]: Map<string, Promise<unknown>> | undefined }
const pending = sharedState[queueKey] ??= new Map<string, Promise<unknown>>()
export function assertShaderProject(project: ProjectInfo): void {
  if (project.kind !== 'shader' || project.studioId !== 'minecraft-shader' || project.loader !== 'iris') throw new Error('此操作只支持光影工作台的 Iris 工程')
}
export function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\:\x00-\x1f<>"|?*]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('光影文件路径无效')
  return value
}
export async function safeFile(root: string, relative: string, create = false): Promise<string> {
  relativePath(relative)
  const canonical = await fs.realpath(root)
  let current = canonical
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (create && error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('光影文件路径不能包含符号链接')
  }
  return current
}
export async function serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = (await fs.realpath(root)).toLowerCase()
  const promise = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
  pending.set(key, promise)
  try { return await promise } finally { if (pending.get(key) === promise) pending.delete(key) }
}
export async function walk(root: string): Promise<ShaderFile[]> {
  const files: ShaderFile[] = []; let bytes = 0
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 16) throw new Error('光影目录层级超过限制')
    const directory = relative ? await safeFile(root, relative) : await fs.realpath(root)
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && ['.git', '.modmind', 'build', 'node_modules', 'modmind.project.json'].includes(entry.name)) continue
      const file = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`光影目录包含链接：${file}`)
      if (entry.isDirectory()) { if (file === 'shaders' || relative.startsWith('shaders')) await visit(file, depth + 1); continue }
      if (!entry.isFile() || !file.startsWith('shaders/') && !/^(README|LICENSE|NOTICE|COPYING)(?:\.(?:md|txt))?$/i.test(file)) continue
      relativePath(file)
      const stat = await fs.stat(await safeFile(root, file))
      if (files.length >= MAX_FILES || (bytes += stat.size) > MAX_PACK || stat.size > 16 * 1024 * 1024) throw new Error('光影工程超过 2048 个文件、128 MiB 或单文件 16 MiB 限制')
      files.push({ path: file, size: stat.size, kind: /\.(vsh|fsh|gsh|csh|glsl)$/i.test(file) ? 'shader' : /\.(png|jpg|jpeg|webp)$/i.test(file) ? 'image' : /\.(properties|lang|json|mcmeta)$/i.test(file) ? 'config' : textExtension.test(file) ? 'text' : 'binary' })
    }
  }
  await visit('', 0); return files
}
