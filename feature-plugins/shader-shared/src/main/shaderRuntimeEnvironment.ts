import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LaunchPrecheck, MinecraftFolder, Version, type ResolvedVersion } from '@xmcl/core'
import { archiveRead } from '../../../../src/main/archiveInspection'
import type { ShaderRuntimeCapabilities } from '../../../../src/shared/shaderStudio'
import type { ProjectInfo, DetectedJavaHome } from '../../../../src/shared/types'
import { assertShaderProject, hash, safeFile, serial } from './shaderFiles'

export interface ShaderRuntimeBinding { instancePath: string; runtimeRoot?: string }
export interface RuntimeMod { id: string; version: string; file: string; sha256: string; dependencies: string[]; provides: string[]; metadataError?: string }
const versionId = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,150}$/
export function validVersionId(value: string): boolean { return versionId.test(value) && !value.endsWith('.') }

export async function readRuntimeBinding(directory: string, project: ProjectInfo): Promise<ShaderRuntimeBinding | null> {
  const key = hash((await fs.realpath(project.path)).toLowerCase())
  try {
    const file = await safeFile(directory, `${key}.json`)
    if ((await fs.stat(file)).size > 4096) throw new Error('光影运行库绑定记录过大')
    const binding = JSON.parse(await fs.readFile(file, 'utf8')) as ShaderRuntimeBinding
    if (typeof binding.instancePath !== 'string' || binding.runtimeRoot !== undefined && typeof binding.runtimeRoot !== 'string') throw new Error('光影运行库绑定记录无效')
    return binding
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function saveRuntimeBinding(directory: string, project: ProjectInfo, value: ShaderRuntimeBinding): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
  const key = hash((await fs.realpath(project.path)).toLowerCase())
  await serial(directory, async () => {
    const file = await safeFile(directory, `${key}.json`, true), temporary = `${file}.tmp`
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx' })
    try { await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
  })
}
export async function installedShaderMods(root: string): Promise<RuntimeMod[]> {
  const directory = await safeFile(root, 'mods')
  const files = await fs.readdir(directory, { withFileTypes: true }), result: RuntimeMod[] = []
  if (files.length > 512) throw new Error('实例 mods 超过 512 项，请选择精简 Iris 实例')
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.jar')) continue
    const file = await safeFile(root, `mods/${entry.name}`)
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) continue
    let metadata: Record<string, unknown>
    try { metadata = JSON.parse((await archiveRead(file, 'fabric.mod.json')).toString('utf8')) } catch { continue }
    if (typeof metadata.id !== 'string' || typeof metadata.version !== 'string') continue
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(metadata.id)) continue
    const dependencies = new Set(metadata.depends && typeof metadata.depends === 'object' ? Object.keys(metadata.depends) : [])
    const provides = new Set(Array.isArray(metadata.provides) ? metadata.provides.filter((id): id is string => typeof id === 'string') : [])
    let nestedCount = 0
    const nested = async (container: string, value: Record<string, unknown>, depth: number): Promise<void> => {
      if (!Array.isArray(value.jars)) return
      for (const item of value.jars) {
        if (depth > 4 || ++nestedCount > 128 || !item || typeof item.file !== 'string' || !/^[A-Za-z0-9_./+-]+\.jar$/.test(item.file) || item.file.split('/').includes('..')) throw new Error('模组内嵌依赖无效或超过限制')
        const archive = `${container}!/${item.file}`
        let child: Record<string, unknown>
        try { child = JSON.parse((await archiveRead(archive, 'fabric.mod.json')).toString('utf8')) } catch { continue }
        if (typeof child.id === 'string') provides.add(child.id)
        if (child.depends && typeof child.depends === 'object') for (const id of Object.keys(child.depends)) dependencies.add(id)
        await nested(archive, child, depth + 1)
      }
    }
    let metadataError: string | undefined
    try { await nested(file, metadata, 0) } catch (error) { metadataError = (error as Error).message }
    result.push({ id: metadata.id, version: metadata.version, file, sha256: '', dependencies: [...dependencies], provides: [...provides], metadataError })
  }
  // Fingerprint the chosen closure, not every unrelated mod in a large player instance.
  let selected = result.filter(mod => mod.id === 'iris')
  try { selected = shaderModClosure(result) } catch { /* The caller reports the missing dependency; retain Iris identity. */ }
  for (const mod of selected) mod.sha256 = hash(await fs.readFile(mod.file))
  return result
}
export function shaderModClosure(mods: RuntimeMod[]): RuntimeMod[] {
  const selected = new Map<string, RuntimeMod>(), queue = ['iris']
  const supplied = new Set(['minecraft', 'java', 'fabricloader'])
  while (queue.length) {
    const id = queue.shift()!
    if (supplied.has(id) || selected.has(id)) continue
    const candidates = mods.filter(mod => mod.id === id || mod.provides.includes(id))
    if (candidates.length !== 1) throw new Error(`Iris 依赖 ${id} 缺失或存在多个版本；请在已有启动器修复实例`)
    const mod = candidates[0]
    if (mod.metadataError) throw new Error(`Iris 依赖 ${mod.id} 无效：${mod.metadataError}`)
    selected.set(id, mod); supplied.add(mod.id); for (const provided of mod.provides) supplied.add(provided)
    queue.push(...mod.dependencies)
  }
  return [...new Set(selected.values())]
}
export async function shaderInstalledVersion(root: string, id: string): Promise<ResolvedVersion> {
  if (!validVersionId(id)) throw new Error('游戏版本标识无效')
  const visited = new Set<string>(); let next: string | undefined = id
  while (next) {
    if (!validVersionId(next) || visited.has(next) || visited.size >= 16) throw new Error('游戏运行库继承无效或越界')
    visited.add(next)
    const file = await safeFile(root, `versions/${next}/${next}.json`)
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('游戏版本配置超过 1 MiB')
    const metadata = JSON.parse(await fs.readFile(file, 'utf8'))
    if (metadata.jar !== undefined && (typeof metadata.jar !== 'string' || !validVersionId(metadata.jar))) throw new Error('游戏 JAR 路径无效')
    if (metadata.inheritsFrom !== undefined && typeof metadata.inheritsFrom !== 'string') throw new Error('游戏继承配置无效')
    next = metadata.inheritsFrom
  }
  const resolved = await Version.parse(root, id)
  if (resolved.mainClass !== 'net.fabricmc.loader.impl.launch.knot.KnotClient') throw new Error('隔离光影测试需要已有 Fabric 运行库')
  if (resolved.libraries.length > 512 || !validVersionId(resolved.minecraftVersion) || !validVersionId(resolved.assets)) throw new Error('游戏运行库规模或资源标识无效')
  for (const library of resolved.libraries) await safeFile(root, `libraries/${library.path}`)
  await safeFile(root, `versions/${resolved.minecraftVersion}/${resolved.minecraftVersion}.jar`)
  const argumentsToCheck = [...resolved.arguments.jvm, ...resolved.arguments.game].flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value.value) ? value.value : [value.value])
  if (argumentsToCheck.some(value => /(?:-javaagent:|-agent(?:lib|path):|-XX:On|^-Djava\.system\.class\.loader|^-Dfabric\.(?:addMods|gameJarPath)|[\r\n\0])/.test(value))) throw new Error('运行库包含额外执行参数；请使用标准 Fabric 配置')
  for (const flag of ['--gameDir', '--assetsDir']) {
    const index = argumentsToCheck.indexOf(flag)
    if (index >= 0 && argumentsToCheck[index + 1] !== (flag === '--gameDir' ? '${game_directory}' : '${assets_root}')) throw new Error('运行库强制了外部游戏目录，无法隔离')
  }
  const folder = MinecraftFolder.from(root), options = { gamePath: root, javaPath: '', version: resolved }
  await LaunchPrecheck.checkVersion(folder, resolved, options)
  await LaunchPrecheck.checkLibraries(folder, resolved, options)
  const assetFile = await safeFile(root, `assets/indexes/${resolved.assets}.json`)
  if ((await fs.stat(assetFile)).size > 8 * 1024 * 1024) throw new Error('游戏资源索引超过 8 MiB')
  const assets = JSON.parse(await fs.readFile(assetFile, 'utf8'))
  if (!assets.objects || typeof assets.objects !== 'object' || Array.isArray(assets.objects) || Object.keys(assets.objects).length > 65536) throw new Error('游戏资源索引无效或超过限制')
  for (const asset of Object.values(assets.objects) as Array<{ hash?: unknown; size?: unknown }>) {
    if (!asset || typeof asset.hash !== 'string' || !/^[a-f0-9]{40}$/.test(asset.hash) || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error('游戏资源路径或大小无效')
    const file = await safeFile(root, `assets/objects/${asset.hash.slice(0, 2)}/${asset.hash}`), stat = await fs.stat(file)
    if (!stat.isFile() || stat.size !== asset.size) throw new Error(`游戏资源不完整：${asset.hash}`)
  }
  return resolved
}
export async function shaderRuntimeCapabilities(project: ProjectInfo, binding: ShaderRuntimeBinding | null, javaHomes: () => Promise<DetectedJavaHome[]>): Promise<ShaderRuntimeCapabilities> {
  assertShaderProject(project)
  const result: ShaderRuntimeCapabilities = { supported: project.minecraftVersion === '26.2', ready: false, minecraft: project.minecraftVersion, versions: [], issues: [], backend: 'iris-session-agent', runtimeVerified: false }
  if (!result.supported) result.issues.push(`隔离会话暂适配 Minecraft 26.2；当前 ${project.minecraftVersion} 可继续手动部署`)
  if (!binding) { result.issues.push('请在游戏验证页面选择 Iris 实例'); return result }
  try {
    const mods = await installedShaderMods(binding.instancePath), iris = mods.filter(mod => mod.id === 'iris')
    if (iris.length !== 1) throw new Error('需要唯一的 Iris 安装')
    result.iris = { version: iris[0].version, path: iris[0].file, sha256: iris[0].sha256 }
    if (!/^1\.11\.2(?:\+|$)/.test(iris[0].version)) { result.supported = false; result.issues.push(`适配器暂支持 Iris 1.11.2；当前为 ${iris[0].version}`) }
    shaderModClosure(mods)
  } catch (error) { result.issues.push(String((error as Error).message)) }
  if (!binding.runtimeRoot) result.issues.push('请选择已有游戏运行库目录（包含 versions、libraries 和 assets）')
  else {
    result.runtimeRoot = binding.runtimeRoot
    try {
      const directory = await safeFile(binding.runtimeRoot, 'versions'), entries = await fs.readdir(directory, { withFileTypes: true })
      if (entries.length > 128) throw new Error('运行库超过 128 个版本，请选择专用目录')
      const failures: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !validVersionId(entry.name)) continue
        try {
          const version = await shaderInstalledVersion(binding.runtimeRoot, entry.name)
          if (version.minecraftVersion === project.minecraftVersion) result.versions.push({ id: entry.name, minecraft: version.minecraftVersion })
        } catch (error) { if (failures.length < 3) failures.push(`${entry.name}：${String((error as Error).message).slice(0, 180)}`) }
      }
      if (!result.versions.length) result.issues.push(`没有完整的 Minecraft ${project.minecraftVersion} / Fabric 运行库${failures.length ? `；${failures.join('；')}` : ''}`)
    } catch (error) { result.issues.push(String((error as Error).message)) }
  }
  if (result.supported) {
    const available = await javaHomes(), java = available.filter(java => java.major === 25)[0]
    if (java) result.java = java
    else result.issues.push('需要本地 Java 25；请在设置中选择游戏 Java，或通过启动器准备运行环境')
  }
  result.ready = result.supported && result.issues.length === 0
  return result
}
