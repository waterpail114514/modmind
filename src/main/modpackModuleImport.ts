import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModpackManifest, ProjectInfo } from '../shared/types'
import { isJavaLoader } from '../shared/projectPlatform'
import { addModpackModule, readModpackManifest } from './modpackService'

const excludedDirectories = new Set(['.git', '.gradle', '.modmind', '.idea', 'node_modules', 'build', 'out', 'run', 'logs', 'target'])

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export async function importModpackModule(pack: ProjectInfo, source: ProjectInfo, mode: 'copy' | 'link'): Promise<ModpackManifest> {
  if (mode !== 'copy' && mode !== 'link') throw new Error('请选择复制或直接使用原项目')
  const manifest = await readModpackManifest(pack)
  if (source.draft || (source.kind && source.kind !== 'mod') || !isJavaLoader(source.loader)) {
    throw new Error('请选择 Java 版模组源码项目')
  }
  if (source.loader !== manifest.loader || source.minecraftVersion !== manifest.minecraftVersion) {
    throw new Error(`模组目标为 ${source.loader} ${source.minecraftVersion}，整合包目标为 ${manifest.loader} ${manifest.minecraftVersion}，请先统一加载器和 Minecraft 版本`)
  }
  if (!/^[a-z0-9_]{1,64}$/.test(source.namespace) || !source.name?.trim()) throw new Error('模组名称或 namespace 无效')
  if (manifest.modules.some(module => module.namespace === source.namespace)) throw new Error('同名自制 Mod 已存在')
  const sourceRoot = await fs.realpath(source.path)
  const packRoot = await fs.realpath(pack.path)
  if (!(await fs.stat(sourceRoot)).isDirectory()) throw new Error('请选择模组项目目录')
  const hasBuild = await Promise.all(['build.gradle', 'build.gradle.kts'].map(file => fs.stat(path.join(sourceRoot, file)).then(stat => stat.isFile()).catch(() => false)))
  if (!hasBuild.some(Boolean)) throw new Error('模组项目缺少 Gradle 构建文件，请选择包含 build.gradle 或 build.gradle.kts 的目录')
  if (contains(sourceRoot, packRoot)) throw new Error('不能将整合包自身或其上级目录导入为模组')
  if (mode === 'link') {
    const metadataPath = path.join(sourceRoot, 'modmind.project.json')
    let createdMetadata = false
    try {
      await fs.writeFile(metadataPath, `${JSON.stringify({ ...source, kind: 'mod', path: sourceRoot, toolDataDirectory: '.modmind' }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      createdMetadata = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      return await addModpackModule(pack, { name: source.name, namespace: source.namespace, path: sourceRoot, linked: true, createdAt: new Date().toISOString() })
    } catch (error) {
      if (createdMetadata) await fs.rm(metadataPath, { force: true })
      throw error
    }
  }
  const modulesRoot = path.join(packRoot, 'modules')
  await fs.mkdir(modulesRoot, { recursive: true })
  if (await fs.realpath(modulesRoot) !== modulesRoot) throw new Error('自制模组目录不能是符号链接')
  const relativePath = `modules/${source.namespace}`
  const target = path.join(modulesRoot, source.namespace)
  if (contains(sourceRoot, target) || contains(target, sourceRoot)) throw new Error('源项目和目标模组目录不能重叠')
  // An exclusive mkdir prevents an import from overwriting an existing module.
  await fs.mkdir(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名自制 Mod 目录已存在')
    throw error
  })
  try {
    await fs.cp(sourceRoot, target, {
      recursive: true,
      filter: async file => {
        const stat = await fs.lstat(file)
        if (stat.isDirectory() && file !== sourceRoot && excludedDirectories.has(path.basename(file).toLowerCase())) return false
        if (stat.isSymbolicLink()) throw new Error(`模组项目包含符号链接，请先替换为实际文件：${path.relative(sourceRoot, file)}`)
        return true
      }
    })
    const imported: ProjectInfo = { ...source, kind: 'mod', path: target, projectId: randomUUID(), toolDataDirectory: '.modmind' }
    await fs.writeFile(path.join(target, 'modmind.project.json'), `${JSON.stringify(imported, null, 2)}\n`, 'utf8')
    await fs.mkdir(path.join(target, '.modmind'), { recursive: true })
    return await addModpackModule(pack, { name: source.name, namespace: source.namespace, path: relativePath, createdAt: new Date().toISOString() })
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true })
    throw error
  }
}
