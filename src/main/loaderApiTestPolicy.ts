import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Test-instance policy only; never changes build dependencies or release metadata. */
export async function prepareLoaderApiTestPolicy(projectRoot: string, loader: 'fabric' | 'quilt'): Promise<boolean> {
  const configPath = path.join(projectRoot, '.modmind', 'minecraft-test.json')
  let content: string
  try {
    content = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  let config: { managedLoaderApi?: boolean }
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
    config = value
    if (config.managedLoaderApi !== undefined && typeof config.managedLoaderApi !== 'boolean') throw new Error('expected boolean')
  } catch {
    throw new Error(`${configPath} 格式无效：managedLoaderApi 必须为布尔值，不能静默恢复自动安装 API`)
  }
  if (config.managedLoaderApi !== false) return true

  const modsRoot = path.join(projectRoot, '.modmind', 'minecraft', 'mods')
  const api = loader === 'quilt' ? 'quilted-fabric-api' : 'fabric-api'
  // Remove only ModMind-owned files; user-installed mods need explicit inspection.
  await fs.rm(path.join(modsRoot, `modmind-managed-${api}.jar`), { force: true })
  await fs.rm(path.join(modsRoot, `.modmind-${loader}-api-version`), { force: true })
  return false
}
