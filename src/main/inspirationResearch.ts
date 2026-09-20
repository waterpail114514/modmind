import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { resolveReadablePath } from './projectTextRead'
import { archiveFingerprintInfo, archiveRead } from './ftbResourceArchive'
import { inspectDecompileJar } from './decompileJarInspection'
import { readDecompileCacheEntry } from './decompileCache'
import { listCachedSourceFiles, readCachedSourceFile, runDecompilation, scanReferencesForJar } from './decompilePipeline'

interface ResearchOptions {
  cacheRoot: string
  signal: AbortSignal
  ensureJava: () => Promise<string>
  onProgress?: (message: string) => void
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`分页参数应为 ${min}–${max} 的整数`)
  return value
}

function page<T>(items: T[], offset: number, limit: number) {
  const end = Math.min(items.length, offset + limit)
  return { items: items.slice(offset, end), total: items.length, ...(end < items.length ? { nextOffset: end } : {}) }
}

export function numberedText(content: string, startLine: number, limit: number) {
  const lines = content.split(/\r\n|\n|\r/)
  if (startLine > lines.length) throw new Error(`文件只有 ${lines.length} 行`)
  let size = 0
  const selected: Array<{ line: number; text: string }> = []
  for (let i = startLine - 1; i < lines.length && selected.length < limit; i++) {
    const text = lines[i].slice(0, 2000)
    if (size + text.length > 20000) break
    selected.push({ line: i + 1, text })
    size += text.length
  }
  const endLine = startLine + selected.length - 1
  return { lines: selected, totalLines: lines.length, ...(endLine < lines.length ? { nextStartLine: endLine + 1 } : {}) }
}

export function logEvidence(content: string) {
  const lines = content.split(/\r\n|\n|\r/)
  const selected = new Set<number>()
  let matches = 0
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:error|fatal|exception|caused by|crash|missing|incompatible|failed|outofmemory)\b|错误|异常|崩溃/i.test(lines[i])) continue
    matches++
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 5); j++) selected.add(j)
    if (selected.size >= 10000) break
  }
  return { totalLines: lines.length, matches, scanTruncated: selected.size >= 10000,
    evidence: [...selected].sort((a, b) => a - b).map(i => ({ line: i + 1, text: lines[i].slice(0, 2000) })) }
}

/** Host-managed analysis only. No project writes and no execution of input archives. */
export async function runInspirationResearch(project: ProjectInfo, input: Record<string, unknown>, options: ResearchOptions): Promise<unknown> {
  options.signal.throwIfAborted()
  const operation = String(input.operation ?? '')
  const offset = integer(input.offset, 0, 0, 1_000_000)
  const limit = integer(input.limit, 50, 1, 200)
  const startLine = integer(input.startLine, 1, 1, 1_000_000)
  const resolveFile = async (requested: unknown) => {
    const resolved = await resolveReadablePath(project, requested)
    const stat = await fs.stat(resolved.realTarget)
    if (!stat.isFile()) throw new Error('请选择具体文件')
    if (stat.size > 512 * 1024 * 1024) throw new Error('分析文件超过 512 MiB 上限')
    return { ...resolved, stat }
  }
  const source = await resolveFile(input.path)
  const sourcePath = path.relative(source.root, source.target).replaceAll('\\', '/')
  options.onProgress?.(`正在分析 ${sourcePath}`)
  if (operation === 'logs' || operation === 'text') {
    if (source.stat.size > 32 * 1024 * 1024) throw new Error('日志超过 32 MiB，请截取相关时段后上传')
    const bytes = await fs.readFile(source.realTarget)
    if (bytes.includes(0)) throw new Error('日志必须是 UTF-8 文本')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (operation === 'text') return { source: sourcePath, ...numberedText(content, startLine, limit) }
    const evidence = logEvidence(content)
    options.signal.throwIfAborted()
    return { source: sourcePath, totalLines: evidence.totalLines, matches: evidence.matches, scanTruncated: evidence.scanTruncated,
      ...page(evidence.evidence, offset, Math.min(limit, 20)), note: '关键字筛选证据，不是已确认根因；无匹配时用文本工具阅读日志。' }
  }
  const inspect = async (file: string) => {
    if (path.extname(file).toLowerCase() !== '.jar') throw new Error('该操作需要 JAR 文件')
    const entries = await archiveFingerprintInfo(file)
    if (entries.length > 50000 || entries.some(item => item.size > 64 * 1024 * 1024) || entries.reduce((sum, item) => sum + item.size, 0) > 1024 * 1024 * 1024) {
      throw new Error('JAR 解压规模超过分析上限')
    }
    options.signal.throwIfAborted()
    const metadata = await inspectDecompileJar(file)
    return { metadata, entries }
  }
  const { metadata, entries } = await inspect(source.realTarget)
  const origin = { source: sourcePath, sha256: metadata.sha256 }
  if (operation === 'inspect') return { ...origin, metadata, ...page(entries, offset, limit) }
  if (operation === 'resource') {
    const name = String(input.relativePath ?? '')
    if (!entries.some(entry => entry.path === name && entry.size <= 1024 * 1024)) throw new Error('资源不存在或超过 1 MiB')
    const bytes = await archiveRead(source.realTarget, name)
    if (bytes.includes(0)) throw new Error('只能读取文本资源')
    return { ...origin, file: name, ...numberedText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), startLine, limit) }
  }
  if (operation === 'compare') {
    const other = await resolveFile(input.otherPath)
    const right = await inspect(other.realTarget)
    const leftMap = new Map(entries.map(item => [item.path, item]))
    const rightMap = new Map(right.entries.map(item => [item.path, item]))
    const changes = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort().flatMap(name => {
      const before = leftMap.get(name), after = rightMap.get(name)
      const status = !before ? 'added' : !after ? 'removed' : before.crc32 !== after.crc32 || before.size !== after.size ? 'changed' : undefined
      return status ? [{ path: name, status }] : []
    })
    return { ...origin, otherSource: input.otherPath, otherSha256: right.metadata.sha256, before: metadata, after: right.metadata,
      ...page(changes, offset, limit), note: '按 ZIP CRC32 与大小比较归档条目；变更不等于 API 不兼容。用 resource 比较配置，启用反编译后查看实现差异。' }
  }
  if (operation === 'references') {
    const report = await scanReferencesForJar(source.realTarget, [])
    options.signal.throwIfAborted()
    return { ...origin, metadata, declaredModIds: report.declaredModIds, scannedClasses: report.scannedClasses,
      warnings: report.warnings, ...page(report.items, offset, limit), note: '依赖声明与字节码引用是静态证据，需结合项目依赖列表判断缺失或冲突；未启动游戏验证。' }
  }
  if (operation === 'decompile') {
    const cached = await readDecompileCacheEntry(options.cacheRoot, metadata.sha256)
    if (cached?.provenance) {
      return { ...origin, reused: true, provenance: cached.provenance, ...page(await listCachedSourceFiles(options.cacheRoot, metadata.sha256), offset, limit) }
    }
    const javaPath = await options.ensureJava()
    options.signal.throwIfAborted()
    const result = await runDecompilation({ jarPath: source.realTarget, minecraftVersion: project.minecraftVersion }, {
      cacheRoot: options.cacheRoot, javaPath, signal: options.signal, onProgress: event => options.onProgress?.(event.message)
    })
    return { ...origin, reused: result.reused, provenance: result.provenance, ...page(result.files, offset, limit) }
  }
  const files = await listCachedSourceFiles(options.cacheRoot, metadata.sha256)
  if (operation === 'files') return { ...origin, ...page(files, offset, limit) }
  if (operation === 'read') {
    const name = String(input.relativePath ?? '')
    if (!files.some(file => file.relativePath === name && file.size <= 2 * 1024 * 1024)) throw new Error('源码不存在或超过 2 MiB')
    return { ...origin, file: name, ...numberedText(await readCachedSourceFile(options.cacheRoot, metadata.sha256, name), startLine, limit) }
  }
  if (operation === 'search') {
    const query = String(input.query ?? '')
    if (!query || query.length > 500) throw new Error('搜索词长度应为 1–500 字符')
    const matches: Array<{ file: string; line: number; text: string }> = []
    const end = Math.min(files.length, offset + Math.min(limit, 20))
    for (const file of files.slice(offset, end)) {
      options.signal.throwIfAborted()
      if (file.size > 2 * 1024 * 1024) continue
      const lines = (await readCachedSourceFile(options.cacheRoot, metadata.sha256, file.relativePath)).split(/\r?\n/)
      let fileMatches = 0
      for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) {
        matches.push({ file: file.relativePath, line: i + 1, text: lines[i].slice(0, 400) })
        if (++fileMatches >= 5) break
      }
    }
    return { ...origin, matches, searchedFiles: end - offset, totalFiles: files.length, note: '每文件最多返回 5 处匹配，每行最多 400 字符；按行读取以查看完整上下文。', ...(end < files.length ? { nextOffset: end } : {}) }
  }
  throw new Error('未知的分析操作')
}
