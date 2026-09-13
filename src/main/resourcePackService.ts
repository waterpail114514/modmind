import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { ProjectInfo } from '../shared/types'
import type { ResourceFileContent, ResourcePackCreate, ResourcePackInfo, ResourcePackIssue, ResourcePackValidation } from '../shared/resourcePack'
import { suggestedResourcePackFormat } from '../shared/resourcePack'
import { isAddonPlatform, isJavaLoader } from '../shared/projectPlatform'
import { archiveEntries, archiveFileInfo, archiveRead } from './ftbResourceArchive'
import { createStoredZip } from './bedrockAddon'
import { modpackContentProjectPath, invalidateModpackContentCache } from './modpackContentInventoryService'
import { authoredModelDocument, inspectAuthoredResourceModel } from './ftbquesticonservice'

const MAX_BYTES = 256 * 1024 * 1024
const MAX_FILE = 16 * 1024 * 1024
const textExtensions = new Set(['.json', '.mcmeta', '.txt', '.md', '.lang', '.properties', '.fsh', '.vsh', '.glsl', '.bbmodel'])
const allowedExtensions = new Set([...textExtensions, '.png', '.ogg', '.ttf', '.otf', '.bin', '.bbmodel', '.md'])
const imageMimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const audioMimeTypes: Record<string, string> = { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }
const previewTextExtensions = new Set([...textExtensions, '.yaml', '.yml', '.toml', '.ini', '.cfg', '.csv'])
const pending = new Map<string, Promise<unknown>>()
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Known authoring roots only: never crawl build output, caches or the entire project. */
function projectResourceRoots(project: ProjectInfo): string[] {
  if (project.kind === 'modpack') return [modpackContentProjectPath(project, 'kubejs')]
  if (!isJavaLoader(project.loader)) return []
  return ['src/main/resources', 'src/client/resources', ...['common', 'fabric', 'forge', 'neoforge', 'quilt'].map(module => `${module}/src/main/resources`)]
}

function projectSourcePath(project: ProjectInfo, id: string): string | undefined {
  if (!id.startsWith('project:')) return undefined
  const relative = id.slice('project:'.length)
  if (!projectResourceRoots(project).includes(relative)) throw new Error('项目资源来源无效')
  return relative
}

function sourceRoot(project: ProjectInfo): string {
  if (isAddonPlatform(project.loader)) throw new Error('基岩和网易资源请使用现有 Add-on 资源流程')
  return path.join(project.path, 'resource-packs')
}

function installedPackPath(project: ProjectInfo, id: string): string | undefined {
  if (!id.startsWith('installed:')) return undefined
  const name = id.slice('installed:'.length)
  if (project.kind !== 'modpack' || !name || name.length > 240 || /[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) throw new Error('整合包资源包路径无效')
  return modpackContentProjectPath(project, `resourcepacks/${name}`)
}

const fileKind = (file: string): ResourcePackInfo['files'][number]['kind'] => {
  const extension = path.extname(file).toLowerCase()
  return imageMimeTypes[extension] ? 'image' : audioMimeTypes[extension] ? 'audio' : previewTextExtensions.has(extension) || /^(LICENSE|NOTICE|COPYING)$/i.test(path.basename(file)) ? 'text' : 'binary'
}

function packRoot(project: ProjectInfo, id: string): string {
  if (typeof id === 'string') {
    const installed = installedPackPath(project, id)
    if (installed) return path.join(project.path, installed)
    const source = projectSourcePath(project, id)
    if (source) return path.join(project.path, source)
  }
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,90}$/.test(id)) throw new Error('资源包标识无效')
  return path.join(sourceRoot(project), id)
}

async function packIsArchive(project: ProjectInfo, id: string): Promise<boolean> {
  const root = packRoot(project, id)
  await safeTarget(root, '')
  const stat = await fs.stat(root)
  if (stat.isDirectory()) return false
  if (!installedPackPath(project, id) || !root.toLowerCase().endsWith('.zip') || !stat.isFile()) throw new Error('资源包不是目录或 ZIP')
  if (stat.size > MAX_BYTES) throw new Error('资源包 ZIP 超过大小限制')
  return true
}

async function readPackBytes(project: ProjectInfo, id: string, file: string): Promise<Buffer> {
  const relative = safeRelativeFile(file), root = packRoot(project, id)
  // Project source browsing stays within assets; pack browsing includes ancillary files.
  if (projectSourcePath(project, id) && !['pack.mcmeta', 'pack.png'].includes(relative) && !relative.startsWith('assets/')) throw new Error('项目资源必须位于 assets/ 下')
  if (await packIsArchive(project, id)) return archiveRead(root, relative)
  const target = await safeTarget(root, relative)
  if ((await fs.stat(target)).size > MAX_FILE) throw new Error('文件过大')
  return fs.readFile(target)
}

async function assertEditablePack(project: ProjectInfo, id: string): Promise<void> {
  if (await packIsArchive(project, id)) throw new Error('ZIP 资源包为只读，请先创建可编辑副本')
}

function safeRelativeFile(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 400 || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('资源文件路径无效')
  return value
}

function relativeFile(value: string): string {
  safeRelativeFile(value)
  if (/^(?:LICENSE|COPYING|NOTICE)(?:\.txt|\.md)?$/i.test(value)) return value
  if (!['pack.mcmeta', 'pack.png'].includes(value) && !value.startsWith('assets/') && !/^[a-z0-9_.-]+\/assets\//.test(value) && !/^(?:readme|credits)\.(?:txt|md)$/i.test(value)) throw new Error('资源必须位于 assets/ 或 overlay/assets/ 下')
  if (!allowedExtensions.has(path.extname(value).toLowerCase())) throw new Error('不支持的资源文件类型')
  return value
}

async function safeTarget(root: string, file: string): Promise<string> {
  const resolved = path.resolve(root, file)
  if (resolved !== path.resolve(root) && !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('资源路径越界')
  let ancestor = path.resolve(root)
  while (path.dirname(ancestor) !== ancestor) {
    const stat = await fs.lstat(ancestor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('资源路径的父目录不能是符号链接')
    ancestor = path.dirname(ancestor)
  }
  let current = path.resolve(root)
  const rootStat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (rootStat?.isSymbolicLink()) throw new Error('资源包目录不能是符号链接')
  for (const segment of file.split('/').filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('资源路径不能包含符号链接')
  }
  return resolved
}

async function serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(root).toLowerCase()
  const task = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
  pending.set(key, task)
  try { return await task } finally { if (pending.get(key) === task) pending.delete(key) }
}

async function scan(root: string, projectAssetsOnly = false): Promise<ResourcePackInfo['files']> {
  await safeTarget(root, '')
  const files: ResourcePackInfo['files'] = []
  let total = 0
  const visit = async (relative = ''): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (projectAssetsOnly && !relative && !['assets', 'pack.mcmeta', 'pack.png'].includes(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error('资源包包含不支持的符号链接')
      const file = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(root, file)); total += stat.size
        if (stat.size > MAX_FILE || total > MAX_BYTES || files.length >= 20000) throw new Error('资源包超过文件数量或大小限制')
        files.push({ path: file, size: stat.size, kind: fileKind(file) })
      }
    }
  }
  await visit()
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function inspectResourcePack(project: ProjectInfo, id: string): Promise<ResourcePackInfo> {
  const root = packRoot(project, id)
  const source = projectSourcePath(project, id)
  const installed = installedPackPath(project, id)
  const archive = await packIsArchive(project, id)
  let files: ResourcePackInfo['files']
  if (archive) {
    const entries = await archiveFileInfo(root)
    let total = 0
    files = entries.map(entry => {
      total += entry.size
      if (entries.length > 20000 || entry.size > MAX_FILE || total > MAX_BYTES) throw new Error('资源包超过文件数量或大小限制')
      if (/[\\:\x00-\x1f]/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('ZIP 包含无效资源路径')
      return { ...entry, kind: fileKind(entry.path) }
    }).sort((a, b) => a.path.localeCompare(b.path))
  } else files = await scan(root, Boolean(source))
  const metadata = await readPackBytes(project, id, 'pack.mcmeta').then(bytes => JSON.parse(bytes.toString('utf8'))).catch(() => null)
  return { id, path: source ?? installed ?? `resource-packs/${id}`, ...(source ? { origin: 'project' as const } : installed ? { origin: 'installed' as const } : {}), readOnly: archive, name: source ? `项目资源 · ${source}` : installed ? `整合包 · ${id.slice('installed:'.length)}` : id, description: typeof metadata?.pack?.description === 'string' ? metadata.pack.description : metadata?.pack?.description ? JSON.stringify(metadata.pack.description) : '', packFormat: Number.isInteger(metadata?.pack?.pack_format) ? metadata.pack.pack_format : null, files }
}

export async function listResourcePacks(project: ProjectInfo): Promise<ResourcePackInfo[]> {
  const root = sourceRoot(project)
  await safeTarget(root, '')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  const packs = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,90}$/.test(entry.name)).map(entry => inspectResourcePack(project, entry.name)))
  const sources: ResourcePackInfo[] = []
  for (const relative of projectResourceRoots(project)) {
    const assets = await safeTarget(project.path, `${relative}/assets`)
    const stat = await fs.lstat(assets).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isDirectory()) {
      const source = await inspectResourcePack(project, `project:${relative}`)
      if (source.files.some(file => file.path.startsWith('assets/'))) sources.push(source)
    }
  }
  const installed: ResourcePackInfo[] = []
  if (project.kind === 'modpack') {
    const directory = await safeTarget(project.path, modpackContentProjectPath(project, 'resourcepacks'))
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !(entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))) continue
      const id = `installed:${entry.name}`
      const relative = installedPackPath(project, id)!
      try { installed.push(await inspectResourcePack(project, id)) }
      catch (error) { installed.push({ id, path: relative, name: `整合包 · ${entry.name}`, origin: 'installed', readOnly: true, error: error instanceof Error ? error.message : String(error), description: '', packFormat: null, files: [] }) }
    }
  }
  return [...sources, ...packs, ...installed]
}

export async function makeResourcePackEditable(project: ProjectInfo, id: string): Promise<ResourcePackInfo> {
  if (!installedPackPath(project, id) || !await packIsArchive(project, id)) throw new Error('请选择整合包内的 ZIP 资源包')
  return importResourcePack(project, packRoot(project, id))
}

export async function createResourcePack(project: ProjectInfo, input: ResourcePackCreate): Promise<ResourcePackInfo> {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.description !== 'string' || input.description.length > 4000 || !Number.isInteger(input.packFormat) || input.packFormat < 1 || input.packFormat > 10000) throw new Error('请填写资源包名称、描述和有效格式版本')
  const id = input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0,60) || `pack-${randomUUID().slice(0,8)}`
  const root = packRoot(project, id)
  return serial(sourceRoot(project), async () => {
    await safeTarget(sourceRoot(project), id)
    await fs.mkdir(sourceRoot(project), { recursive: true })
    await fs.mkdir(root)
    try {
      await fs.mkdir(path.join(root, 'assets'))
      await fs.writeFile(path.join(root, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: input.packFormat, description: input.description } }, null, 2))
      return await inspectResourcePack(project, id)
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error }
  })
}

export async function importResourcePack(project: ProjectInfo, source: string): Promise<ResourcePackInfo> {
  const isDirectory = (await fs.lstat(source)).isDirectory()
  if (isDirectory) await scan(source)
  const entries = await archiveEntries(source)
  const descriptor = entries.includes('pack.mcmeta') ? 'pack.mcmeta' : entries.find(file => /^[^/]+\/pack\.mcmeta$/.test(file))
  if (!descriptor) throw new Error('所选资源包缺少 pack.mcmeta')
  const prefix = descriptor.slice(0, -'pack.mcmeta'.length)
  const rootBase = sourceRoot(project)
  return serial(rootBase, async () => {
    const id = `import-${randomUUID().slice(0, 8)}`
    const root = packRoot(project, id)
    await safeTarget(rootBase, id)
    await fs.mkdir(root, { recursive: true })
    let total = 0, count = 0
    try {
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue
        const file = entry.slice(prefix.length)
        if (!file || file.endsWith('/')) continue
        relativeFile(file)
        const bytes = await archiveRead(source, entry)
        total += bytes.length
        if (total > MAX_BYTES || ++count > 20000) throw new Error('导入资源包超过大小限制')
        const target = await safeTarget(root, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, bytes, { flag: 'wx' })
      }
      const info = await inspectResourcePack(project, id)
      if (!info.description && !info.packFormat) throw new Error('资源包描述文件格式无效')
      return info
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error }
  })
}

export async function readResourcePackFile(project: ProjectInfo, id: string, file: string): Promise<ResourceFileContent> {
  const data = await readPackBytes(project, id, file)
  const extension = path.extname(file).toLowerCase()
  let readOnly = false
  try { relativeFile(file) } catch { readOnly = true }
  const result = { baseline: digest(data), size: data.length, readOnly }
  const mimeType = imageMimeTypes[extension] ?? audioMimeTypes[extension]
  if (mimeType) return { ...result, dataUrl: `data:${mimeType};base64,${data.toString('base64')}` }
  if (fileKind(file) === 'text') return { ...result, text: data.toString('utf8') }
  return { ...result, readOnly: true, unsupported: '此文件类型暂不支持预览，请使用对应的编辑工具查看。' }
}

export async function previewResourcePackModel(project: ProjectInfo, id: string, file: string): Promise<import('../shared/resourcePack').ResourceModelPreview> {
  relativeFile(file)
  const pack = await inspectResourcePack(project, id)
  if (!pack.files.some(entry => entry.path === file)) throw new Error('模型文件不存在')
  const result = await inspectAuthoredResourceModel(project, packRoot(project, id), pack.files.map(entry => entry.path), file)
  const localReferences = result.sources.flatMap(source => {
    const [owner, resource] = source.split(' :: ')
    return owner === packRoot(project, id) && resource !== file && pack.files.some(entry => entry.path === resource) ? [resource] : []
  })
  return { icon: result.icon, reason: result.reason, sources: result.sources, localReferences }
}

export async function resourcePackThumbnail(project: ProjectInfo, id: string, file: string): Promise<string> {
  if (!imageMimeTypes[path.extname(file).toLowerCase()]) throw new Error('此文件类型不支持图片缩略图')
  const value = await readResourcePackFile(project, id, file)
  const png = await sharp(Buffer.from(value.dataUrl!.split(',')[1], 'base64'), { limitInputPixels: 16_777_216 }).resize(32, 32, { fit: 'inside', kernel: 'nearest' }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

export async function resourcePackModelDocument(project: ProjectInfo, id: string, file: string): Promise<{ document: import('../shared/modelSource').ModelSourceDocument; baseline: string }> {
  await assertEditablePack(project, id)
  const value = await readResourcePackFile(project, id, file)
  if (!value.text) throw new Error('请选择模型文件')
  if (file.endsWith('.bbmodel')) {
    const model = JSON.parse(value.text)
    if (!model.meta || !Array.isArray(model.elements)) throw new Error('无效的 Blockbench 项目')
    return { baseline: value.baseline, document: { name: path.basename(file, '.bbmodel'), format: 'project', model, textures: [], animations: [] } }
  }
  const pack = await inspectResourcePack(project, id)
  return { baseline: value.baseline, document: await authoredModelDocument(project, packRoot(project, id), pack.files.map(entry => entry.path), file) }
}

export async function writeResourcePackFile(project: ProjectInfo, id: string, file: string, content: string, baseline: string | null): Promise<ResourcePackInfo> {
  await assertEditablePack(project, id)
  const root = packRoot(project, id)
  return serial(root, async () => {
    const target = await safeTarget(root, relativeFile(file))
    const png = path.extname(file).toLowerCase() === '.png'
    const bytes = png && content.startsWith('data:image/png;base64,') ? Buffer.from(content.slice('data:image/png;base64,'.length), 'base64') : Buffer.from(content, 'utf8')
    if (bytes.length > MAX_FILE) throw new Error('文件过大')
    const previous = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (previous ? digest(previous) !== baseline : baseline !== null) throw new Error('文件已被其它操作修改，请重新读取后保存')
    if (png) await sharp(bytes).metadata()
    const temporary = `${target}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, target) } finally { await fs.rm(temporary, { force: true }) }
    if (installedPackPath(project, id)) invalidateModpackContentCache(project)
    return inspectResourcePack(project, id)
  })
}

export async function removeResourcePackFile(project: ProjectInfo, id: string, file: string, baseline: string): Promise<ResourcePackInfo> {
  await assertEditablePack(project, id)
  if (file === 'pack.mcmeta') throw new Error('不能删除资源包描述文件')
  const root = packRoot(project, id)
  return serial(root, async () => {
    const target = await safeTarget(root, relativeFile(file))
    if (digest(await fs.readFile(target)) !== baseline) throw new Error('文件已改变，请重新读取')
    await fs.rm(target)
    if (installedPackPath(project, id)) invalidateModpackContentCache(project)
    return inspectResourcePack(project, id)
  })
}

export async function importResourcePackAssets(project: ProjectInfo, id: string, directory: string, files: string[]): Promise<ResourcePackInfo> {
  await assertEditablePack(project, id)
  relativeFile(`${directory}/placeholder.png`)
  const root = packRoot(project, id)
  return serial(root, async () => {
    const copied: string[] = []
    try {
      for (const source of files) {
        const file = `${directory}/${path.basename(source)}`
        const target = await safeTarget(root, relativeFile(file))
        if (!(await fs.lstat(source)).isFile() || (await fs.stat(source)).size > MAX_FILE) throw new Error('素材文件无效或过大')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(source, target, constants.COPYFILE_EXCL)
        copied.push(target)
      }
      if (installedPackPath(project, id)) invalidateModpackContentCache(project)
      return await inspectResourcePack(project, id)
    } catch (error) { await Promise.all(copied.map(file => fs.rm(file, { force: true }))); throw error }
  })
}

export async function validateResourcePack(project: ProjectInfo, id: string): Promise<ResourcePackValidation> {
  const info = await inspectResourcePack(project, id)
  const issues: ResourcePackIssue[] = []
  const names = new Set(info.files.map(file => file.path))
  if (!names.has('pack.mcmeta') && info.origin !== 'project') issues.push({ severity: 'error', path: 'pack.mcmeta', message: '缺少资源包描述文件' })
  const expected = suggestedResourcePackFormat(project.minecraftVersion)
  if (expected && info.packFormat !== expected && (info.origin !== 'project' || names.has('pack.mcmeta'))) issues.push({ severity: 'warning', path: 'pack.mcmeta', message: `目标 ${project.minecraftVersion} 推荐资源格式 ${expected}，当前为 ${info.packFormat ?? '新版范围格式'}` })
  if (!expected && info.origin !== 'project') issues.push({ severity: 'warning', path: 'pack.mcmeta', message: '目标版本格式未收录，请核对官方格式并在游戏中验证' })
  const reference = (owner: string, id: unknown, folder: string, suffix: string): void => {
    if (typeof id !== 'string' || id.startsWith('#') || id.startsWith('builtin/')) return
    const parts = id.includes(':') ? id.split(':') : ['minecraft', id]
    const target = `assets/${parts[0]}/${folder}/${parts[1]}${suffix}`
    if (!names.has(target)) {
      const ownNamespace = info.files.some(file => file.path.startsWith(`assets/${parts[0]}/`))
      issues.push({ severity: parts[0] !== 'minecraft' && ownNamespace ? 'error' : 'warning', path: owner, message: `引用资源未包含于本包：${id}（${target}）；外部模组或基础资源需运行时确认` })
    }
  }
  for (const file of info.files) {
    try {
      relativeFile(file.path)
      if (/^assets\//.test(file.path) && /[A-Z\s]/.test(file.path)) issues.push({ severity: 'error', path: file.path, message: '游戏资源路径必须使用小写且不能包含空格' })
      const bytes = await readPackBytes(project, id, file.path)
      if (file.path.endsWith('.json') || file.path.endsWith('.mcmeta')) {
        const value = JSON.parse(bytes.toString('utf8'))
        if (file.path === 'pack.mcmeta' && (!value.pack || value.pack.description === undefined || (!Number.isInteger(value.pack.pack_format) && value.pack.min_format === undefined))) throw new Error('pack 元信息缺少描述或格式版本')
        if (/\/models\/.+\.json$/.test(file.path)) {
          reference(file.path, value.parent, 'models', '.json')
          for (const texture of Object.values(value.textures ?? {})) reference(file.path, texture, 'textures', '.png')
        }
        if (file.path.endsWith('/sounds.json')) for (const event of Object.values(value) as Array<{ sounds?: Array<string | { name: string; type?: string }> }>) for (const sound of event.sounds ?? []) if (typeof sound === 'string' || sound.type !== 'event') reference(file.path, typeof sound === 'string' ? sound : sound.name, 'sounds', '.ogg')
      } else if (file.kind === 'image') {
        const metadata = await sharp(bytes).metadata()
        if (!metadata.width || !metadata.height) throw new Error('图片无有效尺寸')
      } else if (file.kind === 'audio' && bytes.subarray(0, 4).toString() !== 'OggS') throw new Error('音频不是 OGG 容器')
    } catch (error) { issues.push({ severity: 'error', path: file.path, message: error instanceof Error ? error.message : String(error) }) }
  }
  return { success: !issues.some(issue => issue.severity === 'error'), checked: info.files.length, issues }
}

export async function resourcePackArchive(project: ProjectInfo, id: string): Promise<Buffer> {
  if (projectSourcePath(project, id)) throw new Error('项目资源在原位置编辑并随项目构建；请使用独立资源包进行 ZIP 导出和部署')
  const root = packRoot(project, id)
  return serial(root, async () => {
    const validation = await validateResourcePack(project, id)
    if (!validation.success) throw new Error(`资源包校验失败：${validation.issues.filter(issue => issue.severity === 'error').map(issue => `${issue.path}: ${issue.message}`).join('\n')}`)
    const info = await inspectResourcePack(project, id)
    return createStoredZip(await Promise.all(info.files.map(async file => ({ name: relativeFile(file.path), data: await readPackBytes(project, id, file.path) }))))
  })
}

export async function deployResourcePack(project: ProjectInfo, id: string): Promise<{ path: string; message: string }> {
  if (installedPackPath(project, id)) throw new Error('此资源包已在整合包中，无需重复部署')
  const bytes = await resourcePackArchive(project, id)
  const relative = project.kind === 'modpack' ? modpackContentProjectPath(project, `resourcepacks/${id}.zip`) : `.modmind/minecraft/resourcepacks/${id}.zip`
  const target = await safeTarget(project.path, relative)
  const manifestPath = path.join(project.path, '.modmind/resource-pack-deployments.json')
  const deployments: Record<string, string> = await fs.readFile(manifestPath, 'utf8').then(text => JSON.parse(text) as Record<string, string>).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {} as Record<string, string>; throw error })
  const existing = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (existing && digest(existing) !== deployments[relative] && digest(existing) !== digest(bytes)) throw new Error('目标资源包已经存在且不属于上次部署，请先备份并更名')
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, target) } finally { await fs.rm(temporary, { force: true }) }
  deployments[relative] = digest(bytes)
  await fs.mkdir(path.dirname(manifestPath), { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify(deployments, null, 2))
  if (project.kind === 'modpack') invalidateModpackContentCache(project)
  return { path: relative, message: project.kind === 'modpack' ? '已部署到整合包资源包目录；在游戏资源包选项中启用' : '已部署到本项目客户端测试目录；在游戏资源包选项中启用，尚未验证实际加载' }
}
