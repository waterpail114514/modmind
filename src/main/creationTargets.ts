import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { CreationTargetRecord } from '../shared/creationFeedback'
import { artifactHash, isBuildInput } from './creationBuildEvidence'
import { resolveAgentModpackModule } from './modpackModuleTools'
import { readModpackManifest } from './modpackService'

const inside = (root: string, target: string): boolean => { const relative = path.relative(root, target); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }

export async function resolveCreationTarget(project: ProjectInfo, requested: string): Promise<string> {
  if (!requested.trim()) throw new Error('需要明确目标路径')
  const target = await fs.realpath(path.resolve(project.path, requested))
  const allowed = [await fs.realpath(project.path)]
  if (project.kind === 'modpack') {
    for (const module of (await readModpackManifest(project)).modules) {
      if (!module.linked) continue
      const linked = await resolveAgentModpackModule(project, module.namespace).catch(() => null)
      if (linked) allowed.push(await fs.realpath(linked.path))
    }
  }
  const visited = new Set<string>()
  for (let i = 0; i < allowed.length; i++) {
    const root = allowed[i]
    if (visited.has(root)) continue
    visited.add(root)
    if (allowed.length > 100) throw new Error('关联项目图过大，请缩小任务目标')
    const manifest = await fs.readFile(path.join(root, 'modmind.relationships.json'), 'utf8').then(text => JSON.parse(text) as { relationships?: Array<{ provider?: string; linkedProjectPath?: string }> }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relationships: [] }
      throw error
    })
    for (const link of manifest.relationships ?? []) if (link.provider === 'modmind-project' && link.linkedProjectPath) {
      const resolved = await fs.realpath(link.linkedProjectPath).catch(() => undefined)
      if (resolved && !allowed.includes(resolved)) allowed.push(resolved)
    }
  }
  if (!allowed.some(root => inside(root, target)) || !(await fs.stat(target)).isDirectory()) throw new Error('目标必须位于当前项目或已关联项目中；请先关联外部项目')
  return target
}

async function sourceHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(directory: string, relative = ''): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (!isBuildInput(name) && !name.startsWith('docs/') && name !== 'docs') continue
      if (/(?:^|\/)docs\/(?:evidence|source-snapshots|last-ai-change\.json|last-ai-response\.txt)(?:\/|$)/.test(name)) continue
      if (entry.isSymbolicLink()) throw new Error(`任务目标包含符号链接，无法记录完整变更：${name}`)
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target, name)
      else if (entry.isFile()) result[name] = await artifactHash(target)
    }
  }
  await visit(root)
  return result
}

/** Inspect literal Gradle child-project declarations without evaluating build scripts. */
export async function missingProjectInputs(root: string): Promise<string[]> {
  const missing: string[] = []
  for (const file of ['settings.gradle', 'settings.gradle.kts']) {
    const source = await fs.readFile(path.join(root, file), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })
    const directories = new Map<string, string>()
    for (const match of source.matchAll(/project\s*\(\s*["']([^"']+)["']\s*\)\.projectDir\s*=\s*file\s*\(\s*["']([^"']+)["']\s*\)/g)) directories.set(match[1], match[2])
    for (const match of source.matchAll(/^\s*include\s*(?:\(([^\n]*)\)|([^\n]+))/gm)) {
      for (const child of (match[1] ?? match[2]).matchAll(/["'](:?[^"']+)["']/g)) {
        const relative = directories.get(child[1]) ?? child[1].replace(/^:/, '').replaceAll(':', '/')
        if (relative.includes('$')) { missing.push(`${file}: 动态子项目路径未验证 ${relative}`); continue }
        const location = path.resolve(root, relative)
        if (!inside(root, location)) { missing.push(`${file}: 外部子项目须单独记录 ${relative}`); continue }
        if (!(await fs.stat(location).catch(() => null))?.isDirectory()) missing.push(`${file}: 缺少子项目 ${relative}`)
      }
    }
  }
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const source = await fs.readFile(path.join(root, file), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })
    for (const call of source.matchAll(/\bfiles\s*\(([^\n)]*)\)/g)) for (const literal of call[1].matchAll(/["']([^"']+)["']/g)) {
      const relative = literal[1]
      if (relative.includes('$')) { missing.push(`${file}: 动态本地依赖路径未验证 ${relative}`); continue }
      const location = path.resolve(root, relative)
      if (!inside(root, location)) missing.push(`${file}: 外部依赖须单独记录 ${relative}`)
      else if (!(await fs.stat(location).catch(() => null))?.isFile()) missing.push(`${file}: 缺少本地依赖 ${relative}`)
    }
  }
  return missing
}

export async function beginCreationTarget(project: ProjectInfo, requested: string): Promise<CreationTargetRecord> {
  const root = await resolveCreationTarget(project, requested)
  const metadata = await fs.readFile(path.join(root, 'modmind.project.json'), 'utf8').then(text => JSON.parse(text) as ProjectInfo).catch(() => undefined)
  return { path: root, projectId: metadata?.projectId, before: await sourceHashes(root), missing: await missingProjectInputs(root) }
}

export async function finishCreationTarget(project: ProjectInfo, target: CreationTargetRecord, artifacts: string[] = []): Promise<CreationTargetRecord> {
  const root = await resolveCreationTarget(project, target.path)
  const after = await sourceHashes(root)
  const changedFiles = [...new Set([...Object.keys(target.before), ...Object.keys(after)])].filter(name => target.before[name] !== after[name]).sort()
  const recorded = []
  for (const artifact of artifacts) {
    const file = await fs.realpath(path.resolve(root, artifact))
    if (!inside(root, file) || !(await fs.stat(file)).isFile()) throw new Error('产物必须位于对应目标内')
    recorded.push({ path: file, sha256: await artifactHash(file) })
  }
  const missing = await missingProjectInputs(root)
  const selectedArtifacts = recorded.length ? recorded : target.artifacts
  for (const artifact of selectedArtifacts ?? []) {
    if (await artifactHash(artifact.path).catch(() => '') !== artifact.sha256) missing.push(`产物缺失或已变化：${artifact.path}`)
  }
  return { ...target, changedFiles, artifacts: selectedArtifacts, missing }
}
