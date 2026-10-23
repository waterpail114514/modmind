import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExistingProjectAnalysis } from '../../../../src/shared/types'
import { walk, stages } from '../../../shader-shared/src/main/shaderFiles'

export async function inspectShaderSource(root: string): Promise<ExistingProjectAnalysis | null> {
  if (!(await fs.stat(path.join(root, 'shaders')).catch(() => null))?.isDirectory()) return null
  const files = await walk(root)
  if (!files.some(file => stages.test(file.path))) return null
  const name = path.basename(root)
  return { sourcePath: await fs.realpath(root), sourceName: name, kind: 'complete', fileCount: files.length, sourceFileCount: files.filter(file => file.kind === 'shader').length,
    documentCount: files.filter(file => file.kind === 'text').length, detectedFiles: files.filter(file => stages.test(file.path) || file.path === 'shaders/shaders.properties').slice(0, 20).map(file => file.path),
    reasons: ['识别为 Java 光影源码，保留原 shaders、配置与资源文件'], inferred: { name, namespace: 'shader_pack', kind: 'shader', studioId: 'minecraft-shader', loader: 'iris', minecraftVersion: '1.21.1' } }
}

