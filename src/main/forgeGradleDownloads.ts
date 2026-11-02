import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { verifiedDownload } from './downloadService'
import type { ProjectInfo } from '../shared/types'
import { diagnosticJournal } from './diagnosticLog'
import { fetchTextWithRetry } from './networkRequest'
import { archiveRead } from './archiveInspection'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { isForgeGradle6Project } from './forgeGradlePolicy'

interface VersionEntry { id: string; url: string; sha1: string }
function isMetadataUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && ['piston-meta.mojang.com', 'launchermeta.mojang.com'].includes(url.hostname) } catch { return false }
}

/** Version-gated FG6 source cache layout; preserve upstream metadata and SHA-1 identities. */
export async function prepareForgeGradleDownloads(project: ProjectInfo, gradleHome: string, signal?: AbortSignal): Promise<void> {
  if (!await isForgeGradle6Project(project)) return
  diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'forge-gradle-preparation', phase: 'start', message: 'Preparing ForgeGradle 6 MinecraftRepo files through verified downloads', data: { minecraft: project.minecraftVersion, adapter: 'FG6 MinecraftRepo and MCP binary cache', remainingDirectRequests: ['MCPRuntime manifest/version JSON', 'MCP binaries if the version/layout is unsupported or preparation fails', 'custom plugin network requests'] } })
  if (!/^[\w.+-]{1,80}$/.test(project.minecraftVersion)) throw new Error('Minecraft version is invalid')
  const base = path.join(gradleHome, 'caches', 'forge_gradle', 'minecraft_repo', 'versions')
  const manifestFile = path.join(base, 'manifest.json')
  const mirrors = (official: string, mirror: string) => [{ id: 'bmclapi', label: 'BMCLAPI', url: mirror }, { id: 'mojang', label: 'Minecraft 官方源', url: official }]
  const validManifest = async (file: string) => {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(value.versions) || !value.versions.some((entry: VersionEntry) => entry.id === project.minecraftVersion && isMetadataUrl(entry.url) && /^[a-f0-9]{40}$/i.test(entry.sha1))) throw new Error('Minecraft manifest is invalid')
  }
  if (!await validManifest(manifestFile).then(() => true, () => false)) await verifiedDownload.download({
    sources: mirrors('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'),
    destination: manifestFile, maxBytes: 8 * 1024 * 1024, validate: validManifest, signal
  })
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  const entry = (manifest.versions as VersionEntry[]).find(entry => entry.id === project.minecraftVersion)!
  const versionFile = path.join(base, project.minecraftVersion, 'version.json')
  await verifiedDownload.download({ sources: mirrors(entry.url, `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(project.minecraftVersion)}/json`),
    destination: versionFile, expectedHash: { algorithm: 'sha1', value: entry.sha1 }, maxBytes: 8 * 1024 * 1024, resume: true, signal })
  const metadata = JSON.parse(await fs.readFile(versionFile, 'utf8'))
  for (const key of ['client', 'server', 'client_mappings', 'server_mappings']) {
    const item = metadata.downloads?.[key]
    if (!item) continue
    if (!/^[a-f0-9]{40}$/i.test(item.sha1) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 2 * 1024 ** 3) throw new Error('Minecraft download metadata is invalid')
    const url = new URL(item.url)
    if (url.protocol !== 'https:' || !['piston-data.mojang.com', 'launcher.mojang.com'].includes(url.hostname)) throw new Error('Unrecognized Minecraft artifact host')
    const target = path.join(base, project.minecraftVersion, key.endsWith('_mappings') ? `${key}.txt` : `${key}.jar`)
    await verifiedDownload.download({ sources: mirrors(item.url, `https://bmclapi2.bangbang93.com${url.pathname}`), destination: target,
      expectedHash: { algorithm: 'sha1', value: item.sha1 }, maxBytes: item.size, resume: true, signal })
    await fs.writeFile(`${target}.sha1`, item.sha1)
  }
  // FG6 DownloadUtils reuses recent verified metadata before making HTTP requests.
  const now = new Date()
  for (const file of [manifestFile, versionFile]) {
    const bytes = await fs.readFile(file)
    await fs.writeFile(`${file}.sha1`, createHash('sha1').update(bytes).digest('hex'))
    await fs.utimes(file, now, now)
  }
  // MCPRuntime has a separate cache. Its download functions reuse existing
  // binary outputs only when the original SHA-1 matches (FG6 upstream contract).
  try { await prepareMcpBinaryCache(project, gradleHome, base, metadata, signal) }
  catch (error) {
    signal?.throwIfAborted()
    diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'forge-gradle-preparation', phase: 'mcp-cache-unavailable', level: 'warning', message: 'Could not prepare FG6 MCP binary cache; upstream downloads retain finite read timeouts', error })
  }
  diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'forge-gradle-preparation', phase: 'ready', message: 'ForgeGradle MinecraftRepo cache verified; MCPRuntime is a separate upstream network path', data: { minecraft: project.minecraftVersion, directory: base } })
}

async function prepareMcpBinaryCache(project: ProjectInfo, gradleHome: string, base: string, metadata: { downloads?: Record<string, { sha1: string }> }, signal?: AbortSignal): Promise<void> {
  const version = project.loaderVersion?.replace(`${project.minecraftVersion}-`, '')
  if (!version || !/^\d+(?:\.\d+){1,3}(?:-[\w.]+)?$/.test(version)) return
  const files = path.join(gradleHome, 'modmind-forge-metadata', project.minecraftVersion, version)
  const fetchArtifact = async (relative: string, destination: string) => {
    const sources = [{ id: 'bmclapi', label: 'BMCLAPI Forge Maven', url: `https://bmclapi2.bangbang93.com/maven/${relative}` }, { id: 'forge', label: 'Forge Maven', url: `https://maven.minecraftforge.net/${relative}` }]
    let sha1 = ''
    const cachedHash = await fs.readFile(`${destination}.sha1`, 'utf8').catch(() => '')
    if (/^[a-f0-9]{40}$/i.test(cachedHash) && await fs.stat(destination).then(stat => stat.isFile()).catch(() => false)) {
      const digest = createHash('sha1')
      for await (const bytes of createReadStream(destination)) { signal?.throwIfAborted(); digest.update(bytes) }
      if (digest.digest('hex') === cachedHash) return
    }
    for (const source of sources) {
      try { sha1 = (await fetchTextWithRetry(`${source.url}.sha1`, { attempts: 1, timeoutMs: 10000, signal })).trim().split(/\s+/)[0]; if (/^[a-f0-9]{40}$/i.test(sha1)) break } catch { signal?.throwIfAborted() }
    }
    if (!/^[a-f0-9]{40}$/i.test(sha1)) throw new Error('Forge metadata artifact has no valid SHA-1')
    await verifiedDownload.download({ sources, destination, expectedHash: { algorithm: 'sha1', value: sha1 }, maxBytes: 32 * 1024 * 1024, resume: true, signal })
    await fs.writeFile(`${destination}.sha1`, sha1)
  }
  const forge = `${project.minecraftVersion}-${version}`
  const userdev = path.join(files, 'userdev.jar')
  await fetchArtifact(`net/minecraftforge/forge/${forge}/forge-${forge}-userdev.jar`, userdev)
  const userdevConfig = JSON.parse((await archiveRead(userdev, 'config.json')).toString('utf8'))
  const coordinate = /^de\.oceanlabs\.mcp:mcp_config:([\w.+-]{1,100})@zip$/.exec(userdevConfig.mcp ?? '')
  if (!coordinate) throw new Error('Unsupported FG6 userdev MCP coordinate')
  const mcpVersion = coordinate[1]
  if (!mcpVersion.startsWith(`${project.minecraftVersion}-`) && mcpVersion !== project.minecraftVersion) throw new Error('MCP config Minecraft version mismatch')
  const configFile = path.join(files, 'mcp.zip')
  await fetchArtifact(`de/oceanlabs/mcp/mcp_config/${mcpVersion}/mcp_config-${mcpVersion}.zip`, configFile)
  const config = JSON.parse((await archiveRead(configFile, 'config.json')).toString('utf8'))
  if (config.version !== project.minecraftVersion || !Array.isArray(config.steps?.joined)) throw new Error('Unsupported FG6 MCP config layout')
  const outputs: Record<string, string> = { downloadClient: 'client', downloadServer: 'server', downloadClientMappings: 'client_mappings', downloadServerMappings: 'server_mappings' }
  let copied = 0
  for (const step of config.steps.joined as Array<{ name?: string; type: string; output?: string }>) {
    signal?.throwIfAborted()
    const key = outputs[step.type]
    const name = step.name ?? step.type
    if (!key || !/^[\w-]{1,100}$/.test(name) || step.output !== undefined || !metadata.downloads?.[key]) continue
    const file = key + (key.endsWith('_mappings') ? '.txt' : '.jar')
    const source = path.join(base, project.minecraftVersion, file)
    const destination = path.join(gradleHome, 'caches', 'forge_gradle', 'mcp_repo', 'de', 'oceanlabs', 'mcp', 'mcp_config', mcpVersion, 'joined', name, file)
    const expected = metadata.downloads[key].sha1
    const matches = async (candidate: string) => {
      const digest = createHash('sha1')
      try { for await (const bytes of createReadStream(candidate)) { signal?.throwIfAborted(); digest.update(bytes) }; return digest.digest('hex') === expected } catch { signal?.throwIfAborted(); return false }
    }
    if (await matches(destination)) continue
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${randomUUID()}.tmp`
    try { await fs.copyFile(source, temporary); if (!await matches(temporary)) throw new Error('MCP cache source hash changed'); signal?.throwIfAborted(); await fs.rename(temporary, destination); copied++ }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }
  diagnosticJournal.record({ subsystem: 'minecraft-download', operation: 'forge-gradle-preparation', phase: 'mcp-binaries-ready', message: 'FG6 MCP binary outputs prepared with upstream SHA-1 checks; manifest/JSON requests remain upstream', data: { minecraft: project.minecraftVersion, mcpVersion, copied } })
}
