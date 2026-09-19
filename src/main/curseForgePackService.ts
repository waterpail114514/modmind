import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchJsonWithRetry } from './networkRequest'
import { verifiedDownload } from './downloadService'

export interface CurseForgePackReference { projectID: number; fileID: number; required: boolean }
export interface CurseForgePackFile {
  path: string
  sha1: string
  size: number
  downloads: string[]
}
export interface CurseForgePackEntry extends CurseForgePackReference {
  file?: CurseForgePackFile
  installedPath?: string
  status: 'pending' | 'installed' | 'failed'
  error?: string
}
export interface CurseForgePackState {
  version: 1
  files: CurseForgePackEntry[]
}
export const CURSEFORGE_IMPORT_STATE = '.modmind/import/curseforge.json'
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
const installing = new Set<string>()

export function parseCurseForgeReferences(input: unknown): CurseForgePackReference[] {
  if (!Array.isArray(input) || input.length > 100_000) throw new Error('CurseForge files 清单无效')
  const seen = new Set<number>()
  return input.map((value) => {
    if (!value || !Number.isSafeInteger(value.projectID) || value.projectID < 1 || !Number.isSafeInteger(value.fileID) || value.fileID < 1 || (value.required !== undefined && typeof value.required !== 'boolean')) throw new Error('CurseForge 项目或文件 ID 无效')
    if (seen.has(value.projectID)) throw new Error(`CurseForge 清单包含重复项目：${value.projectID}`)
    seen.add(value.projectID)
    return { projectID: value.projectID, fileID: value.fileID, required: value.required !== false }
  })
}

function safeContentPath(value: string): boolean {
  return /^(mods|resourcepacks|shaderpacks)\/[^/\\:*?"<>|\x00-\x1f]+$/.test(value)
    && value.length <= 260 && !value.endsWith('.') && !value.endsWith(' ')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.split('/')[1])
    && !['.', '..'].includes(value.split('/')[1])
}

function validFile(file: CurseForgePackFile): boolean {
  return Boolean(file && typeof file.path === 'string' && safeContentPath(file.path)
    && /^[a-f0-9]{40}$/.test(file.sha1) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_FILE_BYTES
    && Array.isArray(file.downloads) && file.downloads.length && file.downloads.every(url => typeof url === 'string' && /^https:\/\//i.test(url)))
}

/** Resolve the pinned file, including non-mod projects; never substitute a newer version. */
export function curseForgePackResolver(apiKey: string, metadataCacheDirectory?: string): (reference: CurseForgePackReference, signal?: AbortSignal) => Promise<CurseForgePackFile> {
  return async (reference, signal) => {
    parseCurseForgeReferences([reference])
    const cachedPath = metadataCacheDirectory ? path.join(metadataCacheDirectory, `${reference.projectID}-${reference.fileID}.json`) : undefined
    if (cachedPath) {
      const cached = await fs.readFile(cachedPath, 'utf8').then(text => JSON.parse(text) as { projectID: number; fileID: number; file: CurseForgePackFile }).catch(() => null)
      if (cached?.projectID === reference.projectID && cached.fileID === reference.fileID && validFile(cached.file)) return cached.file
    }
    if (!apiKey.trim()) throw new Error('未配置 CurseForge API，无法解析精确文件')
    const base = `https://api.curseforge.com/v1/mods/${reference.projectID}`
    const options = { headers: { 'x-api-key': apiKey.trim() }, signal }
    const [mod, result] = await Promise.all([
      fetchJsonWithRetry<{ data: { id: number; classId: number } }>(base, options),
      fetchJsonWithRetry<{ data: { id: number; modId: number; fileName: string; fileLength: number; downloadUrl?: string; hashes: Array<{ algo: number; value: string }> } }>(`${base}/files/${reference.fileID}`, options)
    ])
    const item = result.data
    if (mod.data?.id !== reference.projectID || item?.id !== reference.fileID || item.modId !== reference.projectID) throw new Error('CurseForge 返回的项目/文件与清单不符')
    const directory = ({ 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks' } as Record<number, string>)[mod.data.classId]
    if (!directory) throw new Error(`不支持的 CurseForge 内容类型：${mod.data.classId}`)
    const file: CurseForgePackFile = {
      path: `${directory}/${item.fileName}`,
      size: item.fileLength,
      sha1: item.hashes?.find(hash => hash.algo === 1)?.value.toLowerCase() ?? '',
      downloads: [item.downloadUrl, ...['edge', 'mediafilez'].map(host => `https://${host}.forgecdn.net/files/${Math.floor(item.id / 1000)}/${item.id % 1000}/${encodeURIComponent(item.fileName)}`)].filter((url): url is string => Boolean(url && /^https:\/\//i.test(url)))
    }
    file.downloads = [...new Set(file.downloads)]
    if (!validFile(file) || (directory === 'mods' ? !/\.jar$/i.test(item.fileName) : !/\.zip$/i.test(item.fileName))) throw new Error(`CurseForge 文件名、体积或 SHA-1 无效：${item.fileName}`)
    // A hash lookup is an exact byte match, not a version substitution. Some
    // networks cannot reach ForgeCDN while the author's Modrinth upload works.
    try {
      const alternative = await fetchJsonWithRetry<{ files?: Array<{ url: string; size: number; hashes?: { sha1?: string } }> }>(`https://api.modrinth.com/v2/version_file/${file.sha1}?algorithm=sha1`, { signal, attempts: 1 })
      for (const candidate of alternative.files ?? []) {
        if (candidate.hashes?.sha1 === file.sha1 && candidate.size === file.size && /^https:\/\//i.test(candidate.url) && !file.downloads.includes(candidate.url)) file.downloads.push(candidate.url)
      }
    } catch { signal?.throwIfAborted() /* An optional source must not prevent the pinned CurseForge download. */ }
    if (cachedPath) {
      await fs.mkdir(path.dirname(cachedPath), { recursive: true })
      await fs.writeFile(cachedPath, JSON.stringify({ projectID: reference.projectID, fileID: reference.fileID, file }), 'utf8')
    }
    return file
  }
}

export async function fileSha1(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function matches(file: string, expected: CurseForgePackFile): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => null)
  return Boolean(stat?.isFile() && stat.size === expected.size && await fileSha1(file) === expected.sha1)
}

export async function readCurseForgePackState(root: string): Promise<CurseForgePackState | null> {
  const text = await fs.readFile(path.join(root, CURSEFORGE_IMPORT_STATE), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (text === null) return null
  const value = JSON.parse(text) as CurseForgePackState
  if (value.version !== 1) throw new Error('CurseForge 导入状态版本无效')
  parseCurseForgeReferences(value.files)
  for (const entry of value.files) {
    if (!['pending', 'failed', 'installed'].includes(entry.status) || (entry.file && !validFile(entry.file)) || (entry.installedPath && !safeContentPath(entry.installedPath))) throw new Error('CurseForge 导入状态损坏')
  }
  return value
}

export async function writeCurseForgePackState(root: string, state: CurseForgePackState): Promise<void> {
  const target = path.join(root, CURSEFORGE_IMPORT_STATE)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(`${target}.pending`, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await fs.rename(`${target}.pending`, target)
}

export interface CurseForgePackInstallOptions {
  resolve?: (reference: CurseForgePackReference, signal?: AbortSignal) => Promise<CurseForgePackFile>
  cacheDirectory?: string
  signal?: AbortSignal
  trackDownloadActivities?: boolean
  onProgress?: (event: { path: string; fileIndex: number; fileCount: number; phase: 'checking' | 'downloading' | 'completed'; sourceLabel?: string; attempt?: number; attemptsPerSource?: number }) => void
}

export async function installCurseForgePack(root: string, contentRoot: string, references: CurseForgePackReference[], options: CurseForgePackInstallOptions = {}): Promise<{ downloadedFiles: number; unresolvedDependencyCount: number; warnings: string[] }> {
  const key = path.resolve(root).toLowerCase()
  if (installing.has(key)) throw new Error('整合包依赖正在安装，请等待或取消当前操作')
  installing.add(key)
  try { return await installCurseForgePackInternal(root, contentRoot, references, options) }
  finally { installing.delete(key) }
}

async function installCurseForgePackInternal(root: string, contentRoot: string, references: CurseForgePackReference[], options: CurseForgePackInstallOptions): Promise<{ downloadedFiles: number; unresolvedDependencyCount: number; warnings: string[] }> {
  references = parseCurseForgeReferences(references)
  const previous = await readCurseForgePackState(root)
  const state: CurseForgePackState = { version: 1, files: references.map(ref => previous?.files.find(item => item.projectID === ref.projectID && item.fileID === ref.fileID) ?? { ...ref, status: 'pending' }) }
  let writes = Promise.resolve()
  const save = (): Promise<void> => { writes = writes.then(() => writeCurseForgePackState(root, state)); return writes }
  await save()
  const localFiles = new Map<string, string>()
  for (const directory of ['mods', 'resourcepacks', 'shaderpacks']) {
    for (const item of await fs.readdir(path.join(contentRoot, directory), { withFileTypes: true }).catch(() => [])) {
      if (!item.isFile() || !/\.(jar|zip)$/i.test(item.name)) continue
      const relative = `${directory}/${item.name}`
      const stat = await fs.stat(path.join(contentRoot, relative))
      if (stat.size <= MAX_FILE_BYTES) localFiles.set(`${directory}:${await fileSha1(path.join(contentRoot, relative))}`, relative)
    }
  }
  let downloadedFiles = 0
  let totalBytes = 0
  let cursor = 0
  const claimedPaths = new Map<string, number>()
  const cache = options.cacheDirectory ?? path.join(os.tmpdir(), 'modmind-pack-download-cache')
  await Promise.all(Array.from({ length: Math.min(6, state.files.length) }, async () => {
    while (cursor < state.files.length) {
      const index = cursor++
      const entry = state.files[index]
      const progress = (phase: 'checking' | 'downloading' | 'completed'): void => options.onProgress?.({ path: entry.file?.path ?? `CurseForge ${entry.projectID}/${entry.fileID}`, fileIndex: index + 1, fileCount: state.files.length, phase })
      try {
        options.signal?.throwIfAborted()
        progress('checking')
        if (!entry.file) {
          if (!options.resolve) throw new Error('尚未配置 CurseForge 精确文件解析器')
          const resolved = await options.resolve(entry, options.signal)
          if (!validFile(resolved)) throw new Error('解析结果缺少安全路径或有效 SHA-1')
          entry.file = resolved
        } else if (entry.error && options.resolve) {
          try {
            const refreshed = await options.resolve(entry, options.signal)
            if (validFile(refreshed) && refreshed.sha1 === entry.file.sha1 && refreshed.path === entry.file.path && refreshed.size === entry.file.size) entry.file = refreshed
          } catch { options.signal?.throwIfAborted() /* Previously validated pinned metadata remains usable offline. */ }
        }
        const file = entry.file
        if (!validFile(file)) throw new Error('解析结果缺少安全路径或有效 SHA-1')
        totalBytes += file.size
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('整合包下载总量超过 8 GB')
        const claim = file.path.toLowerCase()
        if (claimedPaths.has(claim) && claimedPaths.get(claim) !== entry.projectID) throw new Error(`多个清单项目使用同一路径：${file.path}`)
        claimedPaths.set(claim, entry.projectID)
        // options.txt addresses resource packs by filename, so only mods can
        // reuse an identically hashed file under a translated name.
        const local = file.path.startsWith('mods/') ? localFiles.get(`mods:${file.sha1}`) : undefined
        entry.installedPath = local ?? file.path
        const destination = path.join(contentRoot, entry.installedPath)
        if (!await matches(destination, file)) {
          if (await fs.access(destination).then(() => true, () => false)) throw new Error(`本地文件与指定版本冲突，已保留原文件：${entry.installedPath}`)
          const cached = path.join(cache, file.sha1)
          if (!await matches(cached, file)) {
            progress('downloading')
            await verifiedDownload.download({
              sources: file.downloads.map((url, i) => ({ id: `curseforge-${i}`, label: `CurseForge ${i + 1}`, url })),
              destination: cached, expectedHash: { algorithm: 'sha1', value: file.sha1 }, maxBytes: file.size,
              retriesPerSource: 1, timeoutMs: 180_000, signal: options.signal, trackActivity: options.trackDownloadActivities !== false,
              onAttempt: ({ source, attempt, attemptsPerSource }) => options.onProgress?.({ path: file.path, fileIndex: index + 1, fileCount: state.files.length, phase: 'downloading', sourceLabel: source.label, attempt, attemptsPerSource })
            })
            if (!await matches(cached, file)) throw new Error(`下载文件大小或 SHA-1 不符：${file.path}`)
            downloadedFiles++
          }
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.copyFile(cached, destination)
        }
        entry.status = 'installed'
        delete entry.error
        progress('completed')
      } catch (error) {
        entry.status = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
      }
      await save()
      if (options.signal?.aborted) break
    }
  }))
  await writes
  options.signal?.throwIfAborted()
  return {
    downloadedFiles,
    unresolvedDependencyCount: state.files.filter(entry => entry.required && entry.status !== 'installed').length,
    warnings: state.files.filter(entry => entry.status !== 'installed').map(entry => `${entry.projectID}/${entry.fileID}: ${entry.error ?? '待安装'}`)
  }
}

/** Reconcile manually supplied files by hash, including renamed JARs; never subtract file counts. */
export async function reconcileCurseForgePack(root: string, contentRoot: string): Promise<CurseForgePackState | null> {
  if (installing.has(path.resolve(root).toLowerCase())) throw new Error('整合包依赖正在安装，请等待或取消当前操作')
  const state = await readCurseForgePackState(root)
  if (!state) return null
  const candidates = new Map<string, string>()
  for (const directory of ['mods', 'resourcepacks', 'shaderpacks']) {
    for (const item of await fs.readdir(path.join(contentRoot, directory), { withFileTypes: true }).catch(() => [])) {
      if (item.isFile() && /\.(jar|zip)$/i.test(item.name) && (await fs.stat(path.join(contentRoot, directory, item.name))).size <= MAX_FILE_BYTES) candidates.set(`${directory}:${await fileSha1(path.join(contentRoot, directory, item.name))}`, `${directory}/${item.name}`)
    }
  }
  for (const entry of state.files) {
    let match = entry.file && candidates.get(`${entry.file.path.split('/')[0]}:${entry.file.sha1}`)
    if (entry.file && !entry.file.path.startsWith('mods/')) match = await matches(path.join(contentRoot, entry.file.path), entry.file) ? entry.file.path : undefined
    entry.status = match ? 'installed' : 'pending'
    if (match) { entry.installedPath = match; delete entry.error }
  }
  await writeCurseForgePackState(root, state)
  return state
}
