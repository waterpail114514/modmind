import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { isModpackProject, readModpackManifest } from './modpackService'
import { modpackModsRoot } from './modpackPaths'
import { descriptorPath } from './projectTemplates'
import { inspectBedrockAddon, inspectNeteaseProject } from './bedrockAddon'
import { inspectPluginProject } from './serverPluginService'

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(() => true).catch(() => false)
}

export async function inspectProjectPreflight(project: ProjectInfo, manifestName = 'modmind.project.json'): Promise<{ success: boolean; logs: string[] }> {
  if (project.kind === 'server-plugin') {
    const logs: string[] = []
    for (const file of [manifestName, await exists(path.join(project.path, 'pom.xml')) ? 'pom.xml' : 'gradle/wrapper/gradle-wrapper.properties']) logs.push(`${await exists(path.join(project.path, file)) ? 'PASS' : 'FAIL'}  ${file}`)
    try { const descriptor = await inspectPluginProject(project); logs.push(`${descriptor || project.loader === 'velocity' ? 'PASS' : 'FAIL'}  插件描述文件${project.loader === 'velocity' ? '（构建时生成）' : ''}`) }
    catch (error) { logs.push(`FAIL  ${error instanceof Error ? error.message : String(error)}`) }
    return { success: !logs.some(line => line.startsWith('FAIL')), logs }
  }
  if (isModpackProject(project)) {
    const logs: string[] = []
    try {
      const manifest = await readModpackManifest(project)
      logs.push(`PASS  ${manifestName}`)
      logs.push(`PASS  ${'modmind.pack.json'} (${manifest.mods.length} 个外部 Mod，${manifest.modules.length} 个自制 Mod)`)
      for (const mod of manifest.mods) {
        const stat = await fs.stat(path.join(modpackModsRoot(project, manifest), mod.fileName)).catch(() => null)
        const present = Boolean(stat?.isFile() && stat.size === mod.size)
        logs.push(`${present ? 'PASS' : 'FAIL'}  ${manifest.source?.layout === 'archive' ? 'overrides/' : ''}mods/${mod.fileName}`)
      }
      for (const module of manifest.modules) {
        const root = path.resolve(project.path, ...module.path.split('/'))
        const inside = root.startsWith(`${path.resolve(project.path)}${path.sep}`)
        const build = inside && (await exists(path.join(root, 'build.gradle')) || await exists(path.join(root, 'build.gradle.kts')))
        logs.push(`${build ? 'PASS' : 'FAIL'}  ${module.path} Gradle project`)
        if (build) {
          const wrapper = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']
          const complete = (await Promise.all(wrapper.map((file) => exists(path.join(root, ...file.split('/')))))).every(Boolean)
          logs.push(`${complete ? 'PASS' : 'FAIL'}  ${module.path} Gradle Wrapper`)
        }
      }
    } catch (error) {
      logs.push(`FAIL  modmind.pack.json: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { success: !logs.some((line) => line.startsWith('FAIL')), logs }
  }
  if (project.loader === 'bedrock') {
    const result = await inspectBedrockAddon(project)
    const manifestPresent = await exists(path.join(project.path, manifestName))
    return { success: result.success && manifestPresent, logs: [`${manifestPresent ? 'PASS' : 'FAIL'}  ${manifestName}`, ...result.logs] }
  }
  if (project.loader === 'netease-pc' || project.loader === 'netease-mobile') {
    const result = await inspectNeteaseProject(project)
    const manifestPresent = await exists(path.join(project.path, manifestName))
    return { success: result.success && manifestPresent, logs: [`${manifestPresent ? 'PASS' : 'FAIL'}  ${manifestName}`, ...result.logs] }
  }
  const logs: string[] = []
  const descriptor = descriptorPath(project.loader, project.minecraftVersion)
  const required: Array<{ label: string; alternatives: string[] }> = [
    { label: manifestName, alternatives: [manifestName] },
    { label: 'build.gradle or build.gradle.kts', alternatives: ['build.gradle', 'build.gradle.kts'] },
    { label: 'settings.gradle or settings.gradle.kts', alternatives: ['settings.gradle', 'settings.gradle.kts'] },
    { label: descriptor, alternatives: [descriptor] }
  ]
  for (const requirement of required) {
    const present = (await Promise.all(requirement.alternatives.map((file) => exists(path.join(project.path, ...file.split('/')))))).some(Boolean)
    logs.push(`${present ? 'PASS' : 'FAIL'}  ${requirement.label}`)
  }
  const wrapperFiles = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']
  const wrapperComplete = (await Promise.all(wrapperFiles.map((file) => exists(path.join(project.path, ...file.split('/')))))).every(Boolean)
  logs.push(`${wrapperComplete ? 'PASS' : 'FAIL'}  Gradle Wrapper ${wrapperComplete ? 'complete' : 'missing; the project build requires its pinned Wrapper'}`)
  try {
    const descriptorContent = await fs.readFile(path.join(project.path, ...descriptor.split('/')), 'utf8')
    let modId = ''
    if (project.loader === 'fabric') {
      const parsed = JSON.parse(descriptorContent) as { id?: unknown }
      modId = typeof parsed.id === 'string' ? parsed.id : ''
    } else if (project.loader === 'quilt') {
      const parsed = JSON.parse(descriptorContent) as { quilt_loader?: { id?: unknown } }
      modId = typeof parsed.quilt_loader?.id === 'string' ? parsed.quilt_loader.id : ''
    } else if (descriptor.endsWith('mcmod.info')) {
      const parsed = JSON.parse(descriptorContent) as Array<{ modid?: unknown }>
      modId = typeof parsed[0]?.modid === 'string' ? parsed[0].modid : ''
    } else {
      modId = descriptorContent.match(/modId\s*=\s*["']([a-z0-9_]{2,64})["']/i)?.[1] ?? ''
    }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(modId)) throw new Error('missing or invalid mod id')
    logs.push(`PASS  ${path.basename(descriptor)} syntax`)
  } catch (error) {
    logs.push(`FAIL  ${path.basename(descriptor)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { success: !logs.some((line) => line.startsWith('FAIL')), logs }
}
