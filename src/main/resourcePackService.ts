import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { ProjectInfo } from '../shared/types'
import type { ResourcePackCreate, ResourcePackInfo, ResourcePackIssue, ResourcePackValidation } from '../shared/resourcePack'
import { suggestedResourcePackFormat } from '../shared/resourcePack'
import { isAddonPlatform } from '../shared/projectPlatform'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import { createStoredZip } from './bedrockAddon'
import { modpackContentProjectPath, invalidateModpackContentCache } from './modpackContentInventoryService'

const MAX_BYTES = 256 * 1024 * 1024
const MAX_FILE = 16 * 1024 * 1024
const textExtensions = new Set(['.json', '.mcmeta', '.txt', '.md', '.lang', '.properties', '.fsh', '.vsh', '.glsl'])
const allowedExtensions = new Set([...textExtensions, '.png', '.ogg', '.ttf', '.otf', '.bin', '.bbmodel', '.md'])
const pending = new Map<string, Promise<unknown>>()
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function sourceRoot(project: ProjectInfo): string {
  if (isAddonPlatform(project.loader)) throw new Error('基岩和网易资源请使用现有 Add-on 资源流程')
  return path.join(project.path, 'resource-packs')
}

function packRoot(project: ProjectInfo, id: string): string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,90}$/.test(id)) throw new Error('资源包标识无效')
  return path.join(sourceRoot(project), id)
}

function relativeFile(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 400 || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('资源文件路径无效')
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

async function scan(root: string): Promise<ResourcePackInfo['files']> {
  await safeTarget(root, '')
  const files: ResourcePackInfo['files'] = []
  let total = 0
  const visit = async (relative = ''): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('资源包包含不支持的符号链接')
      const file = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(root, file)); total += stat.size
        if (stat.size > MAX_FILE || total > MAX_BYTES || files.length >= 20000) throw new Error('资源包超过文件数量或大小限制')
        const extension = path.extname(file).toLowerCase()
        files.push({ path: file, size: stat.size, kind: extension === '.png' ? 'image' : extension === '.ogg' ? 'audio' : textExtensions.has(extension) || /^(LICENSE|NOTICE|COPYING)$/i.test(file) ? 'text' : 'binary' })
      }
    }
  }
  await visit()
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function inspectResourcePack(project: ProjectInfo, id: string): Promise<ResourcePackInfo> {
  const root = packRoot(project, id)
  const files = await scan(root)
  const metadata = await fs.readFile(path.join(root, 'pack.mcmeta'), 'utf8').then(text => JSON.parse(text)).catch(() => null)
  return { id, path: `resource-packs/${id}`, name: id, description: typeof metadata?.pack?.description === 'string' ? metadata.pack.description : metadata?.pack?.description ? JSON.stringify(metadata.pack.description) : '', packFormat: Number.isInteger(metadata?.pack?.pack_format) ? metadata.pack.pack_format : null, files }
}

export async function listResourcePacks(project: ProjectInfo): Promise<ResourcePackInfo[]> {
  const root = sourceRoot(project)
  await safeTarget(root, '')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  return Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,90}$/.test(entry.name)).map(entry => inspectResourcePack(project, entry.name)))
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

export async function readResourcePackFile(project: ProjectInfo, id: string, file: string): Promise<{ text?: string; dataUrl?: string; baseline: string }> {
  const target = await safeTarget(packRoot(project, id), relativeFile(file))
  if ((await fs.stat(target)).size > MAX_FILE) throw new Error('文件过大')
  const data = await fs.readFile(target)
  if (file.endsWith('.png')) return { dataUrl: `data:image/png;base64,${data.toString('base64')}`, baseline: digest(data) }
  if (file.endsWith('.ogg')) return { dataUrl: `data:audio/ogg;base64,${data.toString('base64')}`, baseline: digest(data) }
  if (!textExtensions.has(path.extname(file)) && !/^(LICENSE|NOTICE|COPYING)$/i.test(file)) throw new Error('该资源需要专用编辑器')
  return { text: data.toString('utf8'), baseline: digest(data) }
}

export async function writeResourcePackFile(project: ProjectInfo, id: string, file: string, content: string, baseline: string | null): Promise<ResourcePackInfo> {
  const root = packRoot(project, id)
  return serial(root, async () => {
    const target = await safeTarget(root, relativeFile(file))
    const bytes = file.endsWith('.png') && content.startsWith('data:image/png;base64,') ? Buffer.from(content.slice('data:image/png;base64,'.length), 'base64') : Buffer.from(content, 'utf8')
    if (bytes.length > MAX_FILE) throw new Error('文件过大')
    const previous = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (previous ? digest(previous) !== baseline : baseline !== null) throw new Error('文件已被其它操作修改，请重新读取后保存')
    if (file.endsWith('.png')) await sharp(bytes).metadata()
    const temporary = `${target}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, target) } finally { await fs.rm(temporary, { force: true }) }
    return inspectResourcePack(project, id)
  })
}

export async function removeResourcePackFile(project: ProjectInfo, id: string, file: string, baseline: string): Promise<ResourcePackInfo> {
  if (file === 'pack.mcmeta') throw new Error('不能删除资源包描述文件')
  const root = packRoot(project, id)
  return serial(root, async () => {
    const target = await safeTarget(root, relativeFile(file))
    if (digest(await fs.readFile(target)) !== baseline) throw new Error('文件已改变，请重新读取')
    await fs.rm(target)
    return inspectResourcePack(project, id)
  })
}

export async function importResourcePackAssets(project: ProjectInfo, id: string, directory: string, files: string[]): Promise<ResourcePackInfo> {
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
      return await inspectResourcePack(project, id)
    } catch (error) { await Promise.all(copied.map(file => fs.rm(file, { force: true }))); throw error }
  })
}

export async function validateResourcePack(project: ProjectInfo, id: string): Promise<ResourcePackValidation> {
  const info = await inspectResourcePack(project, id)
  const issues: ResourcePackIssue[] = []
  const root = packRoot(project, id)
  const names = new Set(info.files.map(file => file.path))
  if (!names.has('pack.mcmeta')) issues.push({ severity: 'error', path: 'pack.mcmeta', message: '缺少资源包描述文件' })
  const expected = suggestedResourcePackFormat(project.minecraftVersion)
  if (expected && info.packFormat !== expected) issues.push({ severity: 'warning', path: 'pack.mcmeta', message: `目标 ${project.minecraftVersion} 推荐资源格式 ${expected}，当前为 ${info.packFormat ?? '新版范围格式'}` })
  if (!expected) issues.push({ severity: 'warning', path: 'pack.mcmeta', message: '目标版本格式未收录，请核对官方格式并在游戏中验证' })
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
      const target = await safeTarget(root, file.path)
      if (file.path.endsWith('.json') || file.path.endsWith('.mcmeta')) {
        const value = JSON.parse(await fs.readFile(target, 'utf8'))
        if (file.path === 'pack.mcmeta' && (!value.pack || value.pack.description === undefined || (!Number.isInteger(value.pack.pack_format) && value.pack.min_format === undefined))) throw new Error('pack 元信息缺少描述或格式版本')
        if (/\/models\/.+\.json$/.test(file.path)) {
          reference(file.path, value.parent, 'models', '.json')
          for (const texture of Object.values(value.textures ?? {})) reference(file.path, texture, 'textures', '.png')
        }
        if (file.path.endsWith('/sounds.json')) for (const event of Object.values(value) as Array<{ sounds?: Array<string | { name: string; type?: string }> }>) for (const sound of event.sounds ?? []) if (typeof sound === 'string' || sound.type !== 'event') reference(file.path, typeof sound === 'string' ? sound : sound.name, 'sounds', '.ogg')
      } else if (file.kind === 'image') {
        const metadata = await sharp(target).metadata()
        if (!metadata.width || !metadata.height) throw new Error('图片无有效尺寸')
      } else if (file.kind === 'audio' && (await fs.readFile(target)).subarray(0, 4).toString() !== 'OggS') throw new Error('音频不是 OGG 容器')
    } catch (error) { issues.push({ severity: 'error', path: file.path, message: error instanceof Error ? error.message : String(error) }) }
  }
  return { success: !issues.some(issue => issue.severity === 'error'), checked: info.files.length, issues }
}

export async function resourcePackArchive(project: ProjectInfo, id: string): Promise<Buffer> {
  const root = packRoot(project, id)
  return serial(root, async () => {
    const validation = await validateResourcePack(project, id)
    if (!validation.success) throw new Error(`资源包校验失败：${validation.issues.filter(issue => issue.severity === 'error').map(issue => `${issue.path}: ${issue.message}`).join('\n')}`)
    const info = await inspectResourcePack(project, id)
    return createStoredZip(await Promise.all(info.files.map(async file => ({ name: relativeFile(file.path), data: await fs.readFile(await safeTarget(root, file.path)) }))))
  })
}

export async function deployResourcePack(project: ProjectInfo, id: string): Promise<{ path: string; message: string }> {
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
