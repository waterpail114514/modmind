import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createStoredZip } from '../../../../src/main/bedrockAddon'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { ShaderValidation } from '../../../../src/shared/shaderStudio'
import { assertShaderProject, hash, safeFile, serial } from './shaderFiles'
import { shaderInventory } from './shaderSourceService'
import { validateShader } from './shaderValidationService'

export async function exportShader(project: ProjectInfo, structureOnly = false): Promise<{ status: 'exported'; path: string; bytes: number; sha256: string; revision: string; validation: ShaderValidation }> {
  assertShaderProject(project)
  return serial(project.path, async () => {
    const validation = await validateShader(project, structureOnly)
    if (validation.status === 'failed') throw new Error('光影检查未通过，请修复错误后导出')
    const inventory = await shaderInventory(project), entries = []
    for (const file of inventory.files) entries.push({ name: file.path, data: await fs.readFile(await safeFile(project.path, file.path)) })
    if (validation.revision !== inventory.revision || (await shaderInventory(project)).revision !== inventory.revision) throw new Error('导出时工程发生变化，请重试')
    const bytes = createStoredZip(entries, true), name = `shader-${hash(project.namespace).slice(0, 12)}.zip`
    const target = await safeFile(project.path, `build/${name}`, true)
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes)
    const exportedHash = hash(await fs.readFile(target))
    if (exportedHash !== hash(bytes)) throw new Error('导出校验失败')
    return { status: 'exported', path: target, bytes: bytes.length, sha256: exportedHash, revision: inventory.revision, validation }
  })
}
