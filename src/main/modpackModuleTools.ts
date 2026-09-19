import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { assertAgentProjectAllowed } from './agentProtection'
import { readModpackManifest, readModpackModuleProject } from './modpackService'
import { projectSearchFiles, searchProjectText } from './projectSearch'
import { readProjectTextFile } from './projectTextRead'

/** Resolve only registered source modules, never an arbitrary agent-supplied root. */
export async function resolveAgentModpackModule(pack: ProjectInfo, namespace: unknown): Promise<ProjectInfo> {
  if (pack.kind !== 'modpack') throw new Error('当前项目不是整合包')
  if (typeof namespace !== 'string' || !namespace) throw new Error('请提供自制 Mod 的 namespace')
  const manifest = await readModpackManifest(pack)
  const module = manifest.modules.find(entry => entry.namespace === namespace)
  if (!module) throw new Error(`找不到已登记的自制 Mod：${namespace}`)
  const project = await readModpackModuleProject(pack, module)
  assertAgentProjectAllowed(project.path)
  const realRoot = await fs.realpath(project.path)
  // Windows short (8.3) paths and realpath may spell the same directory differently.
  // Inspect ancestors instead of treating a spelling change as a symlink.
  for (let current = path.resolve(project.path); ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('自制 Mod 路径不能经过符号链接')
    if (path.dirname(current) === current) break
  }
  if (!(await fs.stat(realRoot)).isDirectory()) throw new Error('自制 Mod 源码目录不存在')
  return project
}

export async function inspectModpackModules(pack: ProjectInfo, input: Record<string, unknown>): Promise<unknown> {
  if (pack.kind !== 'modpack') throw new Error('当前项目不是整合包')
  if (input.operation === 'list') {
    const manifest = await readModpackManifest(pack)
    const modules = []
    for (const module of manifest.modules) {
      try {
        const project = await resolveAgentModpackModule(pack, module.namespace)
        modules.push({ ...module, project, editable: true })
      } catch (error) {
        modules.push({ ...module, editable: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { modules, instruction: 'Use modmind_modpack_delegate_module with a registered namespace and a concrete request for source changes. The module workbench owns implementation; the pack workbench owns integration and pack-level runtime verification.' }
  }
  const project = await resolveAgentModpackModule(pack, input.namespace)
  switch (input.operation) {
    case 'info': return { project }
    case 'files': return projectSearchFiles(project)
    case 'read': return readProjectTextFile(project, input.path, input.startLine, input.lineCount)
    case 'search': return searchProjectText(project, String(input.query ?? ''), typeof input.limit === 'number' ? input.limit : undefined)
    default: throw new Error('未知自制 Mod 读取操作')
  }
}
