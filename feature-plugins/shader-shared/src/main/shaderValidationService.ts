import { parse } from '@shaderfrog/glsl-parser'
import { preprocess } from '@shaderfrog/glsl-parser/preprocessor/index.js'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { ShaderIssue, ShaderValidation } from '../../../../src/shared/shaderStudio'
import { stages } from './shaderFiles'
import { expandedShader, shaderInventory } from './shaderSourceService'

export async function validateShader(project: ProjectInfo, structureOnly = false): Promise<ShaderValidation> {
  const inventory = await shaderInventory(project), issues: ShaderIssue[] = []; let parsed = 0, skipped = 0
  if (!inventory.programs.length) issues.push({ severity: 'error', path: 'shaders', message: '没有可执行的光影程序' })
  for (const program of inventory.programs) if (!program.stages.includes('csh') && (!program.stages.includes('vsh') || !program.stages.includes('fsh'))) issues.push({ severity: 'warning', path: program.name, message: '缺少顶点或片元阶段，需要在 Iris 中检查程序回退' })
  for (const file of inventory.files.filter(file => stages.test(file.path))) {
    try {
      const expanded = await expandedShader(project, file.path)
      if (!/^\s*#version\s+\d+/m.test(expanded.source)) issues.push({ severity: 'error', path: file.path, message: '缺少 GLSL #version 声明' })
      if (structureOnly) { skipped++; continue }
      if (/\.(gsh|csh)$/.test(file.path)) { skipped++; issues.push({ severity: 'warning', path: file.path, message: '几何 / 计算阶段须在游戏中编译验证；已检查 include' }); continue }
      if (Buffer.byteLength(expanded.source) > 256 * 1024) { skipped++; issues.push({ severity: 'warning', path: file.path, message: '展开后的着色器超过本地语法解析限额 256 KiB，请在游戏中编译验证' }); continue }
      const source = preprocess(expanded.source, { defines: { MC_VERSION: project.minecraftVersion.split('.').map((value, i) => i === 0 ? value : value.padStart(2, '0')).join(''), IS_IRIS: '1' } })
      parse(source, { stage: file.path.endsWith('.vsh') ? 'vertex' : 'fragment', quiet: true, includeLocation: true, grammarSource: file.path })
      parsed++
    } catch (error) {
      const reason = error as { message?: string; location?: { start?: { line?: number } } }
      issues.push({ severity: 'error', path: file.path, line: reason.location?.start?.line, message: String(reason.message ?? error).slice(0, 1500) })
    }
  }
  if (!inventory.files.some(file => /^(LICENSE|COPYING)(?:\.|$)/i.test(file.path))) issues.push({ severity: 'warning', path: 'LICENSE', message: '尚未提供发行许可证' })
  if (structureOnly) issues.push({ severity: 'warning', path: 'shaders', message: '仅检查结构与 include；着色器编译交给隔离实例的实际 Iris，未标记语法通过' })
  return { status: issues.some(issue => issue.severity === 'error') ? 'failed' : structureOnly ? 'structure-checked' : 'syntax-checked', revision: inventory.revision, issues, parsed, skipped, gameVerified: false }
}
