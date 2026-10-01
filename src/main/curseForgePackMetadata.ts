import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

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

export const MAX_FILE_BYTES = 512 * 1024 * 1024

export const installing = new Set<string>()

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

export function safeContentPath(value: string): boolean {
  return /^(mods|resourcepacks|shaderpacks)\/[^/\\:*?"<>|\x00-\x1f]+$/.test(value)
    && value.length <= 260 && !value.endsWith('.') && !value.endsWith(' ')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.split('/')[1])
    && !['.', '..'].includes(value.split('/')[1])
}

export function validFile(file: CurseForgePackFile): boolean {
  return Boolean(file && typeof file.path === 'string' && safeContentPath(file.path)
    && /^[a-f0-9]{40}$/.test(file.sha1) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_FILE_BYTES
    && Array.isArray(file.downloads) && file.downloads.length && file.downloads.every(url => typeof url === 'string' && /^https:\/\//i.test(url)))
}

export async function fileSha1(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function matches(file: string, expected: CurseForgePackFile): Promise<boolean> {
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
