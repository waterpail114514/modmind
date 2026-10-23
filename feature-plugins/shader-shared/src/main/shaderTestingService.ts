import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { archiveRead } from '../../../../src/main/archiveInspection'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { ShaderTestState } from '../../../../src/shared/shaderStudio'
import { assertShaderProject, hash, safeFile } from './shaderFiles'
import { exportShader } from './shaderExportService'

const testFile = '.modmind/shader-test.json'
export async function readShaderTestConfig(project: ProjectInfo): Promise<Pick<ShaderTestState, 'instancePath' | 'deployed'>> {
  try { return JSON.parse(await fs.readFile(await safeFile(project.path, testFile), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
async function writeTestConfig(project: ProjectInfo, value: unknown) {
  const file = await safeFile(project.path, testFile, true)
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2))
}
export async function bindShaderInstance(project: ProjectInfo, directory: string): Promise<ShaderTestState> {
  assertShaderProject(project)
  const instancePath = await fs.realpath(directory)
  if (!(await fs.stat(await safeFile(instancePath, 'mods', true)).catch(() => null))?.isDirectory()) throw new Error('请选择已有 Iris 实例的游戏目录（包含 mods）')
  if (!await detectIris(instancePath)) throw new Error('所选实例没有检测到 Iris 模组；请先在启动器安装 Iris')
  await writeTestConfig(project, { instancePath })
  return shaderTestState(project)
}
async function detectIris(root: string): Promise<boolean> {
  const directory = await safeFile(root, 'mods')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries.slice(0, 512)) {
    if (!entry.isFile() || !entry.name.endsWith('.jar')) continue
    const file = await safeFile(root, `mods/${entry.name}`)
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) continue
    try { const metadata = JSON.parse((await archiveRead(file, 'fabric.mod.json')).toString('utf8')); if (metadata.id === 'iris') return true } catch { /* Other installed mods may use another loader. */ }
  }
  return false
}
export async function shaderTestState(project: ProjectInfo): Promise<ShaderTestState> {
  assertShaderProject(project)
  const saved = await readShaderTestConfig(project), result: ShaderTestState = { ...saved, irisDetected: false, screenshots: [] }
  if (!saved.instancePath) return result
  result.irisDetected = await detectIris(saved.instancePath)
  const logFile = await safeFile(saved.instancePath, 'logs/latest.log', true), stat = await fs.stat(logFile).catch(() => null)
  if (stat?.isFile()) {
    const handle = await fs.open(logFile, 'r')
    try {
      const offset = saved.deployed?.logOffset ?? 0
      const start = Math.max(offset <= stat.size ? offset : 0, stat.size - 128 * 1024)
      const bytes = Buffer.alloc(Math.max(0, stat.size - start)); await handle.read(bytes, 0, bytes.length, start)
      const text = bytes.toString('utf8')
      result.log = { text, issues: text.split(/\r?\n/).filter(line => /(?:shader|glsl|iris|program)/i.test(line) && /(?:error|failed|exception|invalid)/i.test(line)).slice(-80),
        modifiedAt: stat.mtime.toISOString(), fresh: Boolean(bytes.length && saved.deployed && stat.mtimeMs >= Date.parse(saved.deployed.deployedAt)), packMentioned: Boolean(saved.deployed && text.includes(path.basename(saved.deployed.path))) }
    } finally { await handle.close() }
  }
  const directory = await safeFile(saved.instancePath, 'screenshots', true)
  const images = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of images.filter(entry => entry.isFile() && entry.name.endsWith('.png')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 4)) {
    const file = await safeFile(saved.instancePath, `screenshots/${entry.name}`)
    try {
      if ((await fs.stat(file)).size > 4 * 1024 * 1024) { (result.warnings ??= []).push(`截图超过 4 MiB：${entry.name}`); continue }
      const bytes = await sharp(file, { limitInputPixels: 16 * 1024 * 1024 }).resize({ width: 1024, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
      result.screenshots.push({ name: entry.name, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` })
    } catch { (result.warnings ??= []).push(`截图暂不可读取：${entry.name}`) }
  }
  return result
}
export async function deployShader(project: ProjectInfo): Promise<ShaderTestState> {
  const saved = await readShaderTestConfig(project)
  if (!saved.instancePath || !await detectIris(saved.instancePath)) throw new Error('请先选择有效的 Iris 游戏实例')
  const artifact = await exportShader(project), destination = await safeFile(saved.instancePath, `shaderpacks/${path.basename(artifact.path)}`, true)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  if (await fs.stat(destination).catch(() => null)) {
    const backup = await safeFile(saved.instancePath, `shaderpacks/.modmind-backups/${path.basename(destination)}.${Date.now()}.bak`, true)
    await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.copyFile(destination, backup, constants.COPYFILE_EXCL)
  }
  await fs.copyFile(artifact.path, destination)
  if (hash(await fs.readFile(destination)) !== artifact.sha256) throw new Error('游戏实例内的光影包校验失败')
  const logPath = await safeFile(saved.instancePath, 'logs/latest.log', true)
  const logOffset = (await fs.stat(logPath).catch(() => null))?.size ?? 0
  await writeTestConfig(project, { instancePath: saved.instancePath, deployed: { path: destination, revision: artifact.revision, sha256: artifact.sha256, deployedAt: new Date().toISOString(), logOffset } })
  return shaderTestState(project)
}
