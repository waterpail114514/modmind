import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

const excluded = new Set(['.git', '.gradle', '.idea', '.modmind', 'node_modules', 'build', 'target', 'dist', 'out', 'logs', 'crash-reports', 'snapshots', 'caches', '.tmp', 'request-evidence'])
const textExtension = /\.(?:java|kt|kts|scala|groovy|gradle|properties|json|json5|mcmeta|yml|yaml|toml|xml|cfg|conf|ini|txt|md|mcfunction|zs|js|ts|py|css|html|snbt)$/i
const MAX_FILES = 5_000

/** Search inventory only: does not change build/export file selection or global ignore files. */
export async function projectSearchFiles(project: ProjectInfo): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue = [project.path]
  const toolRoot = path.resolve(project.path, project.toolDataDirectory ?? '.modmind')
  let visited = 0
  while (queue.length && files.length < MAX_FILES && visited++ < 10_000) {
    const directory = queue.shift()!
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase()) || path.resolve(absolute) === toolRoot) continue
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && !/\.(?:log|jsonl|bak|previous)$/i.test(entry.name)) files.push(path.relative(project.path, absolute).replaceAll('\\', '/'))
      if (files.length >= MAX_FILES) return { files, truncated: true }
    }
  }
  return { files: files.sort(), truncated: queue.length > 0 }
}

export async function searchProjectText(project: ProjectInfo, query: string, limit = 50): Promise<{
  matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; skippedFiles: number
}> {
  if (!query.trim() || query.length > 500) throw new Error('搜索文字长度必须为 1–500 个字符')
  const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50
  const inventory = await projectSearchFiles(project)
  const matches: Array<{ path: string; line: number; text: string }> = []
  let skippedFiles = 0
  let bytes = 0
  for (const relative of inventory.files) {
    if (!textExtension.test(relative)) continue
    const file = path.join(project.path, relative)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat || stat.size > 1024 * 1024) { skippedFiles++; continue }
    bytes += stat.size
    if (bytes > 16 * 1024 * 1024) return { matches, truncated: true, skippedFiles }
    const content = await fs.readFile(file, 'utf8').catch(() => null)
    if (content === null || content.includes('\0')) { skippedFiles++; continue }
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const offset = lines[i].toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      if (offset < 0) continue
      if (matches.length >= maximum) return { matches, truncated: true, skippedFiles }
      const start = Math.max(0, offset - 100)
      matches.push({ path: relative, line: i + 1, text: `${start ? '…' : ''}${lines[i].slice(start, start + 800)}${lines[i].length > start + 800 ? '…' : ''}` })
    }
  }
  return { matches, truncated: inventory.truncated, skippedFiles }
}
