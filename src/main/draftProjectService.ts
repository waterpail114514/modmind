import { constants, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { LoaderVersionOption, ProjectCreateInput, ProjectInfo } from '../shared/types'
import { draftTargetFromMessage, missingDraftDetails } from '../shared/draftProject'
import { isJavaLoader, PROJECT_PLATFORMS } from '../shared/projectPlatform'
import { CURRENT_PROJECT_VERSION } from './projectVersion'

const manifest = 'modmind.project.json'
const pending = new Map<string, Promise<unknown>>()

async function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root).toLowerCase()
  const prior = pending.get(key) ?? Promise.resolve()
  const task = prior.catch(() => undefined).then(action)
  pending.set(key, task)
  try { return await task } finally { if (pending.get(key) === task) pending.delete(key) }
}

async function writeManifest(project: ProjectInfo): Promise<void> {
  const temporary = path.join(project.path, `${manifest}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, JSON.stringify(project, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, path.join(project.path, manifest))
  } finally { await fs.rm(temporary, { force: true }) }
}

async function readProject(root: string): Promise<ProjectInfo> {
  const project = JSON.parse(await fs.readFile(path.join(root, manifest), 'utf8')) as ProjectInfo
  return { ...project, path: root }
}

export async function createDraftProject(documentsDirectory: string, message: string): Promise<ProjectInfo> {
  const parent = path.join(documentsDirectory, 'modmindproject')
  await fs.mkdir(parent, { recursive: true })
  const id = randomUUID().replaceAll('-', '').slice(0, 12)
  const root = path.join(parent, `project-${id}`)
  const name = message.trim().split(/\r?\n/)[0].replace(/[\x00-\x1f]/g, '').slice(0, 32) || '新作品'
  const project: ProjectInfo = { name, path: root, namespace: `mod_${id}`, createdAt: new Date().toISOString(), loader: 'fabric', minecraftVersion: '', draft: { target: draftTargetFromMessage({}, message) }, projectVersion: CURRENT_PROJECT_VERSION, toolDataDirectory: '.modmind' }
  await fs.mkdir(root)
  try {
    await fs.mkdir(path.join(root, '.modmind'))
    await writeManifest(project)
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
  return project
}

export async function recordDraftMessage(root: string, message: string): Promise<ProjectInfo> {
  return serial(root, async () => {
    const project = await readProject(root)
    if (!project.draft) return project
    project.draft.target = draftTargetFromMessage(project.draft.target, message)
    await writeManifest(project)
    return project
  })
}

async function templateFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && (entry.name === '.modmind' || entry.name === manifest)) continue
    const item = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error('工程模板包含不支持的符号链接')
    if (entry.isDirectory()) result.push(...await templateFiles(root, item))
    else if (entry.isFile()) result.push(item)
  }
  return result
}

export async function initializeDraftProject(root: string, services: {
  resolve: (loader: ProjectCreateInput['loader'], version: string) => Promise<LoaderVersionOption>
  scaffold: (project: ProjectInfo) => Promise<void>
}): Promise<ProjectInfo> {
  return serial(root, async () => {
    const original = await readProject(root)
    if (!original.draft) return original
    const missing = missingDraftDetails(original)
    if (missing.length) throw new Error(`请先在对话中补充：${missing.join('、')}`)
    const target = original.draft.target as ProjectCreateInput
    if (!(PROJECT_PLATFORMS as readonly string[]).includes(target.loader) || !['mod', 'modpack'].includes(target.kind ?? '')) throw new Error('不支持的工程类型或平台')
    if (target.kind === 'modpack' && !isJavaLoader(target.loader)) throw new Error('整合包目前仅支持 Java 版平台')
    const compatibility = await services.resolve(target.loader, target.minecraftVersion)
    const project: ProjectInfo = { ...original, kind: target.kind, loader: target.loader, minecraftVersion: target.minecraftVersion, loaderVersion: compatibility.loaderVersion, apiVersion: compatibility.apiVersion, qslVersion: compatibility.qslVersion, javaVersion: compatibility.javaVersion }
    delete project.draft
    // Generate away from the live conversation; publish new files exclusively and commit metadata last.
    const stage = await fs.mkdtemp(path.join(path.dirname(root), '.modmind-init-'))
    const published: string[] = []
    try {
      await services.scaffold({ ...project, path: stage })
      const files = await templateFiles(stage)
      for (const relative of files) {
        const segments = relative.split(path.sep)
        let parent = root
        for (const segment of segments.slice(0, -1)) {
          parent = path.join(parent, segment)
          const stat = await fs.lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
          if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`不能写入已有路径：${relative}`)
        }
        if (await fs.lstat(path.join(root, relative)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) throw new Error(`项目已有文件，未覆盖：${relative}`)
      }
      for (const relative of files) {
        const destination = path.join(root, relative)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.copyFile(path.join(stage, relative), destination, constants.COPYFILE_EXCL)
        published.push(destination)
      }
      if (project.kind === 'modpack') {
        for (const relative of ['mods', 'modules', path.join('overrides', 'config')]) {
          const target = path.join(root, relative)
          const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
          if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error(`不能写入已有路径：${relative}`)
          await fs.mkdir(target, { recursive: true })
        }
      }
      await writeManifest(project)
      return project
    } catch (error) {
      await Promise.all(published.map(file => fs.rm(file, { force: true })))
      throw error
    } finally { await fs.rm(stage, { recursive: true, force: true }) }
  })
}
