import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { supportsProjectCreation } from './loaderCompatibility'
import { descriptorPath, projectTemplateFiles } from './projectTemplates'
import { CURRENT_PROJECT_VERSION, MIGRATABLE_PROJECT_VERSION } from './projectVersion'

export interface ProjectVersionMigrationResult {
  project: ProjectInfo
  backupDirectory: string
  changedFiles: string[]
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(() => true).catch(() => false)
}

export async function detectedProjectVersion(project: ProjectInfo): Promise<string | null> {
  if (project.projectVersion) return project.projectVersion
  const [readme, build] = await Promise.all([
    fs.readFile(path.join(project.path, 'README.md'), 'utf8').catch(() => ''),
    fs.readFile(path.join(project.path, 'build.gradle'), 'utf8').catch(() => '')
  ])
  const generatedReadme = readme.includes('This project was created with ModMind.')
  const generatedBuild = /(?:fabric-loom|org\.quiltmc\.loom|net\.minecraftforge\.gradle|net\.neoforged\.(?:moddev|gradle\.userdev))/.test(build)
  return generatedReadme && generatedBuild ? MIGRATABLE_PROJECT_VERSION : null
}

function mergeJsonDescriptor(project: ProjectInfo, originalText: string, generatedText: string): string {
  const original = JSON.parse(originalText) as Record<string, unknown>
  const generated = JSON.parse(generatedText) as Record<string, unknown>
  if (project.loader === 'fabric') {
    const originalDepends = original.depends && typeof original.depends === 'object' ? original.depends as Record<string, unknown> : {}
    const generatedDepends = generated.depends as Record<string, unknown>
    return JSON.stringify({ ...generated, ...original, id: project.namespace, version: '${version}', depends: { ...originalDepends, ...generatedDepends } }, null, 2)
  }
  const originalLoader = original.quilt_loader && typeof original.quilt_loader === 'object'
    ? original.quilt_loader as Record<string, unknown>
    : {}
  const generatedLoader = generated.quilt_loader as Record<string, unknown>
  const generatedDepends = Array.isArray(generatedLoader.depends) ? generatedLoader.depends as Array<Record<string, unknown>> : []
  const coreIds = new Set(generatedDepends.map((dependency) => dependency.id))
  const originalDepends = Array.isArray(originalLoader.depends)
    ? (originalLoader.depends as Array<Record<string, unknown>>).filter((dependency) => !coreIds.has(dependency.id))
    : []
  return JSON.stringify({
    ...generated,
    ...original,
    quilt_loader: {
      ...generatedLoader,
      ...originalLoader,
      id: project.namespace,
      version: '${version}',
      depends: [...generatedDepends, ...originalDepends]
    }
  }, null, 2)
}

function backupStamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

export async function migrateProjectVersion112(
  project: ProjectInfo,
  installWrapper: (projectRoot: string) => Promise<void>
): Promise<ProjectVersionMigrationResult> {
  const detected = await detectedProjectVersion(project)
  if (detected !== MIGRATABLE_PROJECT_VERSION) throw new Error(`项目版本不是 ${MIGRATABLE_PROJECT_VERSION}`)
  if (!supportsProjectCreation(project.loader, project.minecraftVersion)) {
    throw new Error(`${project.loader} / Minecraft ${project.minecraftVersion} 没有可用的 1.1.3 官方模板；请先使用 Loader 迁移服务升级 Minecraft 版本`)
  }
  if (!project.loaderVersion) throw new Error('项目缺少 Loader 版本，无法自动迁移模板')

  const upgraded: ProjectInfo = { ...project, projectVersion: CURRENT_PROJECT_VERSION }
  const generated = projectTemplateFiles(upgraded, false)
  const descriptor = descriptorPath(project.loader, project.minecraftVersion)
  const originalDescriptor = await fs.readFile(path.join(project.path, ...descriptor.split('/')), 'utf8').catch(() => '')
  if (originalDescriptor && (project.loader === 'fabric' || project.loader === 'quilt')) {
    try {
      generated[descriptor] = mergeJsonDescriptor(project, originalDescriptor, generated[descriptor])
    } catch {
      throw new Error(`无法解析原始 ${path.basename(descriptor)}，迁移未修改项目`)
    }
  }

  const replacementFiles = [
    'modmind.project.json', 'modmind.template.json', 'build.gradle', 'settings.gradle', 'gradle.properties',
    'gradle/wrapper/gradle-wrapper.properties', 'gradle/wrapper/gradle-wrapper.jar', 'gradlew', 'gradlew.bat',
    '.gitignore', '.gitattributes', 'LICENSE', descriptor
  ]
  const backupDirectory = path.join(project.path, '.modmind', 'migrations', '1.1.2-to-1.1.3', backupStamp())
  const existed = new Set<string>()
  await fs.mkdir(backupDirectory, { recursive: true })
  for (const relative of replacementFiles) {
    const source = path.join(project.path, ...relative.split('/'))
    if (!(await exists(source))) continue
    existed.add(relative)
    const backup = path.join(backupDirectory, ...relative.split('/'))
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.copyFile(source, backup)
  }

  const changedFiles = Object.keys(generated).filter((relative) => replacementFiles.includes(relative) && relative !== 'README.md')
  try {
    for (const relative of changedFiles) {
      const target = path.join(project.path, ...relative.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, generated[relative], 'utf8')
    }
    await installWrapper(project.path)
    await fs.writeFile(path.join(backupDirectory, 'migration.json'), JSON.stringify({
      from: MIGRATABLE_PROJECT_VERSION,
      to: CURRENT_PROJECT_VERSION,
      migratedAt: new Date().toISOString(),
      changedFiles: [...new Set([...changedFiles, 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar'])]
    }, null, 2), 'utf8')
  } catch (error) {
    const restoreErrors: Error[] = []
    for (const relative of replacementFiles) {
      const target = path.join(project.path, ...relative.split('/'))
      try {
        if (existed.has(relative)) {
          const backup = path.join(backupDirectory, ...relative.split('/'))
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.copyFile(backup, target)
        } else {
          await fs.rm(target, { force: true })
        }
      } catch (restoreError) {
        restoreErrors.push(new Error(`${relative}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`))
      }
    }
    if (restoreErrors.length) {
      throw new AggregateError([error, ...restoreErrors], `项目升级失败，部分文件未能恢复。原文件备份保留在 ${backupDirectory}；${restoreErrors.map(item => item.message).join('；')}`, { cause: error })
    }
    throw error
  }
  return {
    project: upgraded,
    backupDirectory,
    changedFiles: [...new Set([...changedFiles, 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar'])]
  }
}
