import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { ServerCore, ServerCoreBuild, ServerProfile } from '../shared/serverPlugin'
import { isServerPluginPlatform } from '../shared/projectPlatform'
import { fetchJsonWithRetry } from './networkRequest'
import { verifiedDownload, type DownloadSource } from './downloadService'
import { archiveEntries } from './ftbResourceArchive'
import { archiveRead } from './ftbResourceArchive'
import { findPluginArtifact, inspectPluginJar, listPluginDependencies } from './serverPluginService'
import { configureLocalServer, deployServerInstance } from './serverInstance'
import type { ServerPackResult, ServerRuntimeResult } from './serverPackService'
import { throwIfAborted } from './asyncControl'
import { pluginJavaVersion } from '../shared/serverPluginCompatibility'

export const SERVER_CORE_HEADERS = { 'User-Agent': 'ModMind/1.4.6-preview0912 (https://github.com/waterpail114514/modmind)' }
const cores: ServerCore[] = ['paper', 'purpur', 'spigot', 'folia', 'velocity', 'custom']
const cache = new Map<string, { at: number; value: unknown }>()
const safeVersion = (value: string): string => { if (!/^[A-Za-z0-9._+-]{1,80}$/.test(value)) throw new Error('核心版本或构建号无效'); return encodeURIComponent(value) }
const javaFor = (core: ServerCore, version: string): number => {
  if (core === 'custom') return 21
  const minimum = pluginJavaVersion(core === 'purpur' ? 'paper' : core, version)
  return core !== 'velocity' && core !== 'spigot' && /^1\.20(?:\.|$)/.test(version) ? Math.max(21, minimum) : minimum
}

async function fileHash(file: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function metadata<T>(url: string, signal?: AbortSignal): Promise<T> {
  if (signal) throwIfAborted(signal)
  const cached = cache.get(url)
  if (cached && Date.now() - cached.at < 15 * 60_000) return structuredClone(cached.value) as T
  const value = await fetchJsonWithRetry<T>(url, { headers: SERVER_CORE_HEADERS, signal })
  cache.set(url, { at: Date.now(), value })
  while (cache.size > 80) cache.delete(cache.keys().next().value!)
  return structuredClone(value)
}

export async function serverCoreVersions(core: ServerCore): Promise<string[]> {
  if (core === 'spigot' || core === 'custom') return []
  if (!cores.includes(core)) throw new Error('核心类型无效')
  const value = await metadata<{ versions: string[] | Record<string, string[]> }>(core === 'purpur' ? 'https://api.purpurmc.org/v2/purpur' : `https://fill.papermc.io/v3/projects/${core}`)
  const versions = Array.isArray(value.versions) ? value.versions : Object.values(value.versions ?? {}).flat()
  return versions.filter(version => typeof version === 'string').sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
}

export async function serverCoreBuilds(core: ServerCore, version: string, signal?: AbortSignal): Promise<ServerCoreBuild[]> {
  const encoded = safeVersion(version)
  if (core === 'custom' || core === 'spigot') return []
  if (!cores.includes(core)) throw new Error('核心类型无效')
  if (core === 'purpur') {
    const root = `https://api.purpurmc.org/v2/purpur/${encoded}`
    const list = await metadata<{ builds: { all: string[] } }>(root, signal)
    const builds = (list.builds?.all ?? []).slice(-20).reverse()
    const results: ServerCoreBuild[] = []
    // Bound upstream fan-out; one failed build must not hide all other builds.
    for (let offset = 0; offset < builds.length; offset += 4) {
      const batch = await Promise.allSettled(builds.slice(offset, offset + 4).map(async build => {
        const value = await metadata<{ result: string; md5?: string }>(`${root}/${safeVersion(build)}`, signal)
        if (value.result !== 'SUCCESS' || !value.md5 || !/^[a-f0-9]{32}$/i.test(value.md5)) throw new Error('Purpur 构建缺少有效校验值')
        return { core, version, build, javaVersion: javaFor(core, version), url: `${root}/${safeVersion(build)}/download`, fileName: `purpur-${version}-${build}.jar`, channel: 'STABLE', checksum: { algorithm: 'md5' as const, value: value.md5 } }
      }))
      for (const result of batch) if (result.status === 'fulfilled') results.push(result.value)
      if (signal) throwIfAborted(signal)
    }
    if (builds.length && !results.length) throw new Error('Purpur 构建查询失败或没有可校验的构建，请重试')
    return results.sort((a, b) => Number(b.build) - Number(a.build))
  }
  const entries = await metadata<Array<{ id: number; channel: string; downloads: Record<string, { name: string; url: string; checksums?: { sha256?: string } }> }>>(`https://fill.papermc.io/v3/projects/${core}/versions/${encoded}/builds`, signal)
  return entries.flatMap(entry => {
    const download = entry.downloads?.['server:default']
    if (!download || !/^https:\/\//.test(download.url) || !/^[a-f0-9]{64}$/i.test(download.checksums?.sha256 ?? '') || !Number.isSafeInteger(entry.id) || entry.id < 0) return []
    return [{ core, version, build: String(entry.id), javaVersion: javaFor(core, version), url: download.url, fileName: download.name, channel: entry.channel, ...(download.checksums?.sha256 ? { checksum: { algorithm: 'sha256' as const, value: download.checksums.sha256 } } : {}) }]
  }).sort((a, b) => Number(b.build) - Number(a.build))
}

export function defaultServerProfile(project: ProjectInfo): ServerProfile {
  const core = isServerPluginPlatform(project.loader) ? project.loader : 'paper'
  return { core, version: project.minecraftVersion.replace(/-SNAPSHOT$/, ''), javaVersion: javaFor(core, project.minecraftVersion), memoryMb: 2048, port: core === 'velocity' ? 25577 : 25565, onlineMode: true, eulaAccepted: false }
}

export function validateServerProfile(project: ProjectInfo, input: ServerProfile): ServerProfile {
  if (!input || !cores.includes(input.core)) throw new Error('请选择有效的服务端核心')
  safeVersion(input.version)
  if (input.build) safeVersion(input.build)
  if (!Number.isInteger(input.memoryMb) || input.memoryMb < 512 || input.memoryMb > 32768) throw new Error('服务端内存需为 512-32768 MB')
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('服务端端口需为 1024-65535')
  if (![8, 11, 16, 17, 21, 25].includes(input.javaVersion)) throw new Error('不支持的 Java 版本')
  if (project.loader === 'velocity' && input.core !== 'velocity' && input.core !== 'custom') throw new Error('Velocity 插件需要代理核心')
  if (project.loader !== 'velocity' && input.core === 'velocity') throw new Error('世界服务器插件不能部署到 Velocity')
  if (input.core !== 'custom' && input.javaVersion < javaFor(input.core, input.version)) throw new Error('所选 Java 低于该核心版本要求')
  if (project.javaVersion && input.javaVersion < project.javaVersion) throw new Error('所选 Java 低于插件编译目标')
  if (project.loader === 'paper' && input.core === 'spigot') throw new Error('Paper API 工程不能直接声明 Spigot 兼容，请先迁移编译目标')
  if (input.localJar && !/^\.modmind\/server\/local\/[^/\\]+\.jar$/.test(input.localJar)) throw new Error('本地核心路径无效')
  return { core: input.core, version: input.version, build: input.build, javaVersion: input.javaVersion, memoryMb: input.memoryMb, port: input.port, onlineMode: input.onlineMode === true, eulaAccepted: input.eulaAccepted === true, ...(input.localJar ? { localJar: input.localJar } : {}) }
}

export async function readServerProfile(project: ProjectInfo): Promise<ServerProfile> {
  const file = path.join(project.path, '.modmind/server/profile.json')
  const value = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  return value === null ? defaultServerProfile(project) : validateServerProfile(project, JSON.parse(value))
}

export async function saveServerProfile(project: ProjectInfo, input: ServerProfile): Promise<ServerProfile> {
  const profile = validateServerProfile(project, input)
  const file = path.join(project.path, '.modmind/server/profile.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, JSON.stringify(profile, null, 2)); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
  return profile
}

export async function importLocalServerCore(project: ProjectInfo, file: string): Promise<ServerProfile> {
  const names = await archiveEntries(file)
  if (!names.includes('META-INF/MANIFEST.MF')) throw new Error('所选文件不是可识别的 Java JAR')
  if (!/^Main-Class:\s*\S+/m.test((await archiveRead(file, 'META-INF/MANIFEST.MF')).toString('utf8'))) throw new Error('该 JAR 没有 Main-Class，不能作为直接启动的服务端核心')
  const hash = await fileHash(file, 'sha256')
  const relative = `.modmind/server/local/${hash}.jar`
  await fs.mkdir(path.join(project.path, '.modmind/server/local'), { recursive: true })
  await fs.copyFile(file, path.join(project.path, relative))
  const previous = await readServerProfile(project)
  return saveServerProfile(project, { ...previous, core: previous.core === 'spigot' ? 'spigot' : 'custom', localJar: relative, build: undefined })
}

export async function preparePluginServer(project: ProjectInfo, options: {
  javaPath: (major: number) => Promise<string>
  cacheDirectory: string
  signal: AbortSignal
  onProgress: (message: string, fraction?: number) => void
  onDownloadProgress?: (progress: { source: DownloadSource; downloaded: number; total?: number }) => void
}): Promise<{ pack: ServerPackResult; runtime: ServerRuntimeResult; profile: ServerProfile }> {
  let profile = await readServerProfile(project)
  if (!profile.eulaAccepted && profile.core !== 'velocity') throw new Error('请在服务端设置中接受 Minecraft EULA')
  const artifact = await findPluginArtifact(project)
  const descriptor = await inspectPluginJar(artifact.path)
  if (profile.core === 'folia' && !descriptor.foliaSupported) throw new Error('插件未声明 Folia 支持，请先完成线程调度适配与验证')
  const dependencies = await listPluginDependencies(project)
  const names = new Set(dependencies.map(item => item.descriptor.name.toLowerCase()))
  names.add(descriptor.name.toLowerCase())
  for (const dependency of descriptor.dependencies) if (!dependency.optional && !names.has(dependency.name.toLowerCase())) throw new Error(`缺少必需运行插件：${dependency.name}`)
  for (const item of dependencies) {
    if (profile.core === 'folia' && !item.descriptor.foliaSupported) throw new Error(`运行依赖未声明 Folia 支持：${item.descriptor.name}`)
    for (const dependency of item.descriptor.dependencies) if (!dependency.optional && !names.has(dependency.name.toLowerCase())) throw new Error(`${item.descriptor.name} 缺少必需依赖 ${dependency.name}`)
  }
  options.onProgress('正在解析服务端核心', 0.05)
  let jar: string
  if (profile.core === 'custom' || profile.core === 'spigot') {
    if (!profile.localJar) throw new Error('该核心需要导入本地服务端 JAR；Spigot 可使用官方 BuildTools 生成')
    jar = path.join(project.path, profile.localJar)
  } else {
    const builds = await serverCoreBuilds(profile.core, profile.version, options.signal)
    const build = profile.build ? builds.find(item => item.build === profile.build) : builds.find(item => item.channel === 'STABLE')
    if (!build) throw new Error(profile.build ? `固定构建 ${profile.build} 已不可用；请在服务端设置刷新目录并明确选择替代构建，不会自动升级` : '没有稳定构建；请刷新目录并明确选择可用构建')
    profile = await saveServerProfile(project, { ...profile, build: build.build, javaVersion: Math.max(profile.javaVersion, build.javaVersion) })
    await fs.mkdir(options.cacheDirectory, { recursive: true })
    jar = path.join(options.cacheDirectory, `${profile.core}-${profile.version}-${profile.build}.jar`)
    const expected = build.checksum
    if (!expected) throw new Error('核心构建缺少上游校验值，拒绝下载')
    const valid = await fileHash(jar, expected.algorithm).then(hash => hash === expected.value.toLowerCase()).catch(() => false)
    if (!valid) await verifiedDownload.download({ sources: [{ id: profile.core, label: `${profile.core} 官方`, url: build.url, headers: SERVER_CORE_HEADERS }], destination: jar, expectedHash: expected, signal: options.signal, onProgress: options.onDownloadProgress })
  }
  throwIfAborted(options.signal)
  options.onProgress('正在准备插件与运行依赖', 0.65)
  const staged = path.join(project.path, '.modmind/server', `build-${randomUUID()}`)
  const instance = path.join(project.path, '.modmind/server/instances', `${profile.core}-${profile.version}`)
  await fs.mkdir(path.join(staged, 'plugins'), { recursive: true })
  try {
    await fs.copyFile(jar, path.join(staged, 'server.jar'))
    await fs.copyFile(artifact.path, path.join(staged, 'plugins', artifact.name))
    for (const item of dependencies) await fs.copyFile(path.join(project.path, 'server-plugins', item.fileName), path.join(staged, 'plugins', item.fileName))
    const deployment = await deployServerInstance(staged, instance, options.signal)
    if (deployment.conflicts.length) throw new Error(`运行文件存在本地修改，请检查：${deployment.conflicts.join(', ')}`)
  } finally { await fs.rm(staged, { recursive: true, force: true }) }
  if (profile.core !== 'velocity') await configureLocalServer(instance, profile.port, profile.onlineMode, profile.eulaAccepted)
  else {
    const target = path.join(instance, 'velocity.toml')
    const { parse, stringify } = await import('smol-toml')
    const config = parse(await fs.readFile(target, 'utf8').catch(() => ''))
    config.bind = `127.0.0.1:${profile.port}`
    config['online-mode'] = profile.onlineMode
    await fs.writeFile(target, stringify(config))
  }
  const javaPath = await options.javaPath(profile.javaVersion)
  throwIfAborted(options.signal)
  return { profile, pack: { root: instance, manifestPath: path.join(instance, '.modmind-deployment.json'), copiedMods: [], skippedClientMods: [], warnings: [] }, runtime: { serverJar: path.join(instance, 'server.jar'), launchCommand: [javaPath, '-Xms512M', `-Xmx${profile.memoryMb}M`, '-jar', 'server.jar', ...(profile.core === 'velocity' ? [] : ['nogui'])], loader: project.loader, loaderVersion: profile.build ?? 'local' } }
}
