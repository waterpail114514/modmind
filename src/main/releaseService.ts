import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from './safeExtractZip'
import type {
  ManagedDependency,
  ReleasePreflightResult,
  ReleasePublishInput,
  ReleasePublishResult,
  ReleaseSettings,
  ReleaseSummaryDraft
} from '../shared/production'
import type { ProjectInfo } from '../shared/types'
import { isJavaLoader, platformLabel } from '../shared/projectPlatform'
import { createModrinthPackArchive, isModpackProject, readModpackManifest } from './modpackService'
import { listModpackContent } from './modpackContentInventoryService'
import { readAddonRelationships } from './addonRelationshipService'

export interface ReleaseSecrets {
  modrinthToken: string
  curseForgeToken: string
  githubToken: string
}

const defaults = (project: ProjectInfo): ReleaseSettings => ({
  version: '0.1.0',
  displayName: `${project.name} 0.1.0`,
  summary: '',
  changelog: '',
  autoBump: true,
  bumpMode: 'patch',
  channel: 'release',
  modrinthProjectId: '',
  curseForgeProjectId: '',
  githubRepository: ''
})

function configPath(project: ProjectInfo): string {
  return path.join(project.path, 'modmind.release.json')
}

function nextVersion(value: string, mode: NonNullable<ReleaseSettings['bumpMode']>): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match || match[4]) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  if (mode === 'major') return `${major + 1}.0.0`
  if (mode === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function displayNameForVersion(project: ProjectInfo, previous: string, next: string, displayName: string): string {
  const suffix = new RegExp(`(?:\\s|^)${previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return suffix.test(displayName) ? displayName.replace(suffix, ` ${next}`) : displayName || `${project.name} ${next}`
}

async function writeModVersion(project: ProjectInfo, version: string): Promise<void> {
  if (isModpackProject(project) || !isJavaLoader(project.loader)) return
  const target = path.join(project.path, 'gradle.properties')
  const existing = await fs.readFile(target, 'utf8').catch(() => '')
  const next = /^mod_version\s*=.*$/m.test(existing)
    ? existing.replace(/^mod_version\s*=.*$/m, `mod_version=${version}`)
    : `${existing.trimEnd()}${existing.trim() ? '\n' : ''}mod_version=${version}\n`
  if (next !== existing) await fs.writeFile(target, next, 'utf8')
}

function cleanSettings(project: ProjectInfo, input: ReleaseSettings): ReleaseSettings {
  const version = input.version.trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version)) throw new Error('发布版本号无效')
  const repository = input.githubRepository.trim()
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GitHub 仓库需要使用 owner/repository 格式')
  return {
    ...defaults(project),
    version,
    displayName: input.displayName.trim().slice(0, 120) || `${project.name} ${version}`,
    summary: input.summary?.trim().slice(0, 500) ?? '',
    changelog: input.changelog.slice(0, 100_000),
    autoBump: input.autoBump !== false,
    bumpMode: input.bumpMode === 'minor' || input.bumpMode === 'major' ? input.bumpMode : 'patch',
    channel: input.channel === 'alpha' || input.channel === 'beta' ? input.channel : 'release',
    modrinthProjectId: input.modrinthProjectId.trim().slice(0, 160),
    curseForgeProjectId: input.curseForgeProjectId.trim().slice(0, 40),
    githubRepository: repository
  }
}

async function readDependencies(project: ProjectInfo): Promise<ManagedDependency[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(project.path, 'modmind.dependencies.json'), 'utf8')) as { dependencies?: ManagedDependency[] }
    return Array.isArray(manifest.dependencies) ? manifest.dependencies : []
  } catch {
    return []
  }
}

async function platformRelationships(project: ProjectInfo, provider: 'modrinth' | 'curseforge'): Promise<Array<{ projectId: string; slug?: string; role: 'required' | 'optional' }>> {
  const manifest = await readAddonRelationships(project)
  const relationships: Array<{ projectId: string; slug?: string; role: 'required' | 'optional' }> = []
  for (const entry of manifest.relationships.filter((relationship) => !relationship.automatic && relationship.role !== 'test')) {
    if (entry.provider === 'private') throw new Error(`${entry.name} 是私人定制前置，无法在 ${provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} 建立可靠的发布关系`)
    const link = entry.platformLinks?.[provider]
      ?? (entry.provider === provider && entry.projectId ? { projectId: entry.projectId, slug: entry.slug } : undefined)
    if (!link) throw new Error(`${entry.name} 尚未匹配到 ${provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} 项目，不能一键发布`)
    relationships.push({ projectId: link.projectId, slug: link.slug, role: entry.role === 'optional' ? 'optional' : 'required' })
  }
  return relationships
}

async function findArtifact(project: ProjectInfo): Promise<{ path: string; size: number } | null> {
  const directory = path.join(project.path, 'build', 'libs')
  const candidates = await Promise.all((await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jar') && !/(?:sources|javadoc|dev|shadow)/i.test(entry.name))
    .map(async (entry) => ({ path: path.join(directory, entry.name), stat: await fs.stat(path.join(directory, entry.name)) })))
  const latest = candidates.filter((entry) => entry.stat.size >= 1024).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]
  return latest ? { path: latest.path, size: latest.stat.size } : null
}

async function listExtractedFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  await visit(root)
  return files
}

async function validateReleaseArtifact(filePath: string, loader: ProjectInfo['loader']): Promise<void> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-release-jar-'))
  try {
    await extractZip(filePath, { dir: temporaryRoot })
    const files = await listExtractedFiles(temporaryRoot)
    const descriptor = loader === 'fabric'
      ? 'fabric.mod.json'
      : loader === 'quilt' ? 'quilt.mod.json'
        : loader === 'forge' ? 'META-INF/mods.toml' : 'META-INF/neoforge.mods.toml'
    if (!files.includes(descriptor)) throw new Error(`JAR 缺少 ${descriptor}`)
    if (!files.some((file) => file.endsWith('.class'))) throw new Error('JAR 不包含编译后的 class 文件')
  } catch (error) {
    throw new Error(`发布 JAR 无效：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function latestProjectInputMtime(project: ProjectInfo): Promise<number> {
  const ignored = new Set(['.git', '.gradle', '.modmind', 'build', 'out', 'run', 'node_modules', 'modmind.release.json'])
  let latest = 0
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(project.path, absolute).replaceAll('\\', '/').toLowerCase()
        const relevant = relative.startsWith('src/') || relative.startsWith('gradle/')
          || ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties'].includes(relative)
        if (!relevant) continue
        const stat = await fs.stat(absolute).catch(() => null)
        if (stat) latest = Math.max(latest, stat.mtimeMs)
      }
    }
  }
  await visit(project.path)
  return latest
}

async function createModpackReleaseArtifact(project: ProjectInfo, settings: ReleaseSettings): Promise<{ path: string; size: number }> {
  const archive = await createModrinthPackArchive(project, { version: settings.version, summary: settings.summary })
  const directory = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'builds')
  const artifactPath = path.join(directory, `${project.namespace}-${settings.version}.mrpack`)
  const pending = `${artifactPath}.pending`
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(pending, archive)
  try {
    await fs.rename(pending, artifactPath)
  } finally {
    await fs.rm(pending, { force: true }).catch(() => undefined)
  }
  return { path: artifactPath, size: archive.length }
}

function artifactMediaType(artifactPath: string): string {
  return path.extname(artifactPath).toLowerCase() === '.mrpack' ? 'application/zip' : 'application/java-archive'
}

async function checkedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(120_000) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${label}失败：HTTP ${response.status}${body ? ` - ${body.slice(0, 1_000)}` : ''}`)
  }
  return response
}

export class ReleaseService {
  constructor(
    private readonly getProject: () => ProjectInfo,
    private readonly readSecrets: () => Promise<ReleaseSecrets>,
    private readonly writeSecrets: (secrets: ReleaseSecrets) => Promise<void>,
    private readonly productVersion = 'development'
  ) {}

  async getSettings(project = this.getProject()): Promise<ReleaseSettings> {
    const secrets = await this.readSecrets()
    const stored = await fs.readFile(configPath(project), 'utf8').then((value) => JSON.parse(value) as ReleaseSettings).catch(() => defaults(project))
    return {
      ...defaults(project),
      ...stored,
      hasModrinthToken: Boolean(secrets.modrinthToken),
      hasCurseForgeToken: Boolean(secrets.curseForgeToken),
      hasGithubToken: Boolean(secrets.githubToken)
    }
  }

  async saveSettings(input: ReleaseSettings, project = this.getProject()): Promise<ReleaseSettings> {
    const settings = cleanSettings(project, input)
    const previous = await this.readSecrets()
    await this.writeSecrets({
      modrinthToken: input.modrinthToken?.trim() || previous.modrinthToken,
      curseForgeToken: input.curseForgeToken?.trim() || previous.curseForgeToken,
      githubToken: input.githubToken?.trim() || previous.githubToken
    })
    await fs.writeFile(configPath(project), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    return this.getSettings(project)
  }

  async prepareExport(): Promise<ReleaseSettings> {
    const project = this.getProject()
    const settings = await this.getSettings(project)
    await writeModVersion(project, settings.version)
    return settings
  }

  async markExported(): Promise<ReleaseSettings> {
    const project = this.getProject()
    const settings = await this.getSettings(project)
    if (!settings.autoBump) return settings
    const next = nextVersion(settings.version, settings.bumpMode ?? 'patch')
    if (!next) return settings
    return this.saveSettings({
      ...settings,
      version: next,
      displayName: displayNameForVersion(project, settings.version, next, settings.displayName)
    }, project)
  }

  async suggestSummary(): Promise<ReleaseSummaryDraft> {
    const project = this.getProject()
    if (!isModpackProject(project)) {
      return {
        summary: `${project.name} 为 Minecraft ${project.minecraftVersion} 的 ${project.loader} Mod`,
        changelog: `- 更新 ${project.name}\n- 目标版本：Minecraft ${project.minecraftVersion} · ${project.loader}`,
        generatedBy: 'local'
      }
    }
    const [manifest, content] = await Promise.all([readModpackManifest(project), listModpackContent(project)])
    const kinds = new Set(content.items.map((item) => item.kind))
    const features = [
      kinds.has('quests') ? '任务引导' : '',
      kinds.has('scripts') ? '脚本内容' : '',
      kinds.has('resourcepacks') ? '资源包' : '',
      kinds.has('shaderpacks') ? '光影预设' : '',
      kinds.has('worlds') ? '世界存档' : ''
    ].filter(Boolean)
    const summary = `${manifest.name} 为 Minecraft ${manifest.minecraftVersion} 的 ${manifest.loader} 整合包，包含 ${manifest.mods.length} 个第三方 Mod${manifest.modules.length ? ` 与 ${manifest.modules.length} 个自制模块` : ''}${features.length ? `，并提供${features.join('、')}` : ''}`
    return {
      summary,
      changelog: [
        `- 整合包版本：Minecraft ${manifest.minecraftVersion} · ${manifest.loader}`,
        `- 已锁定 ${manifest.mods.length} 个第三方 Mod${manifest.modules.length ? `，构建 ${manifest.modules.length} 个自制模块` : ''}`,
        ...(features.length ? [`- 内容：${features.join('、')}`] : []),
        `- 已管理 ${content.items.length} 项覆盖内容`
      ].join('\n'),
      generatedBy: 'local'
    }
  }

  async preflight(project = this.getProject(), settings?: ReleaseSettings): Promise<ReleasePreflightResult> {
    settings ??= await this.getSettings(project)
    if (isModpackProject(project)) {
      const checks: ReleasePreflightResult['checks'] = []
      let artifact: { path: string; size: number } | null = null
      try {
        artifact = await createModpackReleaseArtifact(project, settings)
        checks.push({ id: 'artifact', label: 'Modrinth 整合包', status: 'pass', detail: `${path.basename(artifact.path)} · ${(artifact.size / 1024).toFixed(1)} KB` })
      } catch (error) {
        checks.push({ id: 'artifact', label: 'Modrinth 整合包', status: 'fail', detail: error instanceof Error ? error.message : String(error) })
      }
      checks.push({ id: 'version', label: '版本号', status: /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(settings.version) ? 'pass' : 'fail', detail: settings.version || '未配置' })
      checks.push({ id: 'changelog', label: '更新日志', status: settings.changelog.trim() ? 'pass' : 'warning', detail: settings.changelog.trim() ? `${settings.changelog.trim().length} 个字符` : '尚未填写更新日志' })
      return {
        ready: checks.every((check) => check.status !== 'fail'),
        ...(artifact ? { artifactPath: artifact.path, artifactSize: artifact.size } : {}),
        checks
      }
    }
    if (!isJavaLoader(project.loader)) {
      const artifact = await this.findAddonArtifact(project)
      const checks: ReleasePreflightResult['checks'] = [
        { id: 'artifact', label: '平台归档', status: artifact ? 'pass' : 'fail', detail: artifact ? `${path.basename(artifact.path)} · ${(artifact.size / 1024).toFixed(1)} KB` : `${platformLabel(project.loader)} 尚未生成可导出的归档` },
        { id: 'platform', label: '发布平台', status: 'warning', detail: `${platformLabel(project.loader)} 不支持 Modrinth/CurseForge 的 Java JAR 发布流程；请使用官方客户端或网易工作台提交` }
      ]
      return { ready: false, ...(artifact ? { artifactPath: artifact.path, artifactSize: artifact.size } : {}), checks }
    }
    const artifact = await findArtifact(project)
    const checks: ReleasePreflightResult['checks'] = []
    checks.push({ id: 'artifact', label: '发布 JAR', status: artifact ? 'pass' : 'fail', detail: artifact ? `${path.basename(artifact.path)} · ${(artifact.size / 1024).toFixed(1)} KB` : 'build/libs 中没有有效发布 JAR' })
    if (artifact) {
      try {
        await validateReleaseArtifact(artifact.path, project.loader)
        const sourceMtime = await latestProjectInputMtime(project)
        const artifactMtime = (await fs.stat(artifact.path)).mtimeMs
        if (sourceMtime > artifactMtime + 1_000) throw new Error('项目源文件在该 JAR 构建后发生过变化，请重新构建')
        checks[0] = { id: 'artifact', label: '发布 JAR', status: 'pass', detail: `${path.basename(artifact.path)} · ${(artifact.size / 1024).toFixed(1)} KB · 结构与源码时间已核验` }
      } catch (error) {
        checks[0] = { id: 'artifact', label: '发布 JAR', status: 'fail', detail: error instanceof Error ? error.message : String(error) }
      }
    }
    const license = await Promise.any(['LICENSE', 'LICENSE.txt', 'COPYING'].map((name) => fs.access(path.join(project.path, name)).then(() => name))).catch(() => '')
    checks.push({ id: 'license', label: '许可证', status: license ? 'pass' : 'warning', detail: license || '建议在项目根目录添加 LICENSE' })
    checks.push({ id: 'version', label: '版本号', status: /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(settings.version) ? 'pass' : 'fail', detail: settings.version || '未配置' })
    checks.push({ id: 'changelog', label: '更新日志', status: settings.changelog.trim() ? 'pass' : 'warning', detail: settings.changelog.trim() ? `${settings.changelog.trim().length} 个字符` : '尚未填写更新日志' })
    const descriptor = project.loader === 'fabric'
      ? 'src/main/resources/fabric.mod.json'
      : project.loader === 'quilt' ? 'src/main/resources/quilt.mod.json'
        : project.loader === 'neoforge' ? 'src/main/resources/META-INF/neoforge.mods.toml' : 'src/main/resources/META-INF/mods.toml'
    const descriptorExists = await fs.access(path.join(project.path, descriptor)).then(() => true).catch(() => false)
    checks.push({ id: 'descriptor', label: '模组元数据', status: descriptorExists ? 'pass' : 'fail', detail: descriptor })
    return {
      ready: checks.every((check) => check.status !== 'fail'),
      ...(artifact ? { artifactPath: artifact.path, artifactSize: artifact.size } : {}),
      checks
    }
  }

  private async findAddonArtifact(project: ProjectInfo): Promise<{ path: string; size: number } | null> {
    const suffix = project.loader === 'bedrock' ? '.mcaddon' : '.zip'
    const directory = path.join(project.path, 'build')
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map(async (entry) => {
      const target = path.join(directory, entry.name)
      return { path: target, stat: await fs.stat(target) }
    }))
    const latest = candidates.filter((entry) => entry.stat.size > 0).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]
    return latest ? { path: latest.path, size: latest.stat.size } : null
  }

  private async publishModrinth(project: ProjectInfo, settings: ReleaseSettings, secrets: ReleaseSecrets, artifactPath: string): Promise<ReleasePublishResult> {
    if (!settings.modrinthProjectId || !secrets.modrinthToken) throw new Error('Modrinth 项目 ID 或令牌未配置')
    const addonDependencies = await platformRelationships(project, 'modrinth')
    const legacyDependencies = (await readDependencies(project)).filter((entry) => !entry.relationshipId && entry.source === 'modrinth')
    const dependencies = new Map<string, 'required' | 'optional'>()
    for (const entry of legacyDependencies) dependencies.set(entry.projectId, 'required')
    for (const entry of addonDependencies) dependencies.set(entry.projectId, entry.role)
    const bytes = await fs.readFile(artifactPath)
    const form = new FormData()
    form.append('data', JSON.stringify({
      name: settings.displayName,
      version_number: settings.version,
      changelog: settings.changelog,
      dependencies: [...dependencies].map(([projectId, role]) => ({ project_id: projectId, dependency_type: role })),
      game_versions: [project.minecraftVersion],
      version_type: settings.channel,
      loaders: [project.loader],
      featured: false,
      project_id: settings.modrinthProjectId,
      file_parts: ['file'],
      primary_file: 'file'
    }))
    form.append('file', new Blob([new Uint8Array(bytes)], { type: artifactMediaType(artifactPath) }), path.basename(artifactPath))
    const response = await checkedFetch('https://api.modrinth.com/v2/version', {
      method: 'POST', headers: { Authorization: secrets.modrinthToken, 'User-Agent': `ModMind/${this.productVersion} (publisher)` }, body: form
    }, 'Modrinth 发布')
    const value = await response.json() as { id?: string }
    return { target: 'modrinth', success: true, url: `https://modrinth.com/mod/${settings.modrinthProjectId}/version/${value.id ?? ''}`, detail: `已发布 ${settings.version}` }
  }

  private async publishCurseForge(project: ProjectInfo, settings: ReleaseSettings, secrets: ReleaseSecrets, artifactPath: string): Promise<ReleasePublishResult> {
    if (!/^\d+$/.test(settings.curseForgeProjectId) || !secrets.curseForgeToken) throw new Error('CurseForge 项目 ID 或令牌未配置')
    const dependencies = await platformRelationships(project, 'curseforge')
    if (dependencies.some((entry) => !entry.slug)) throw new Error('部分 CurseForge 前置缺少可发布的项目短名称，请重新识别目标模组')
    const bytes = await fs.readFile(artifactPath)
    const releaseType = settings.channel === 'release' ? 'release' : settings.channel === 'beta' ? 'beta' : 'alpha'
    const form = new FormData()
    form.append('metadata', JSON.stringify({
      changelog: settings.changelog,
      changelogType: 'markdown',
      displayName: settings.displayName,
      releaseType,
      gameVersions: [project.minecraftVersion],
      relations: { projects: dependencies.map((entry) => ({ slug: entry.slug, type: entry.role === 'optional' ? 'optionalDependency' : 'requiredDependency' })) }
    }))
    form.append('file', new Blob([new Uint8Array(bytes)], { type: artifactMediaType(artifactPath) }), path.basename(artifactPath))
    const response = await checkedFetch(`https://minecraft.curseforge.com/api/projects/${settings.curseForgeProjectId}/upload-file`, {
      method: 'POST', headers: { 'X-Api-Token': secrets.curseForgeToken }, body: form
    }, 'CurseForge 发布')
    const value = await response.json().catch(() => ({})) as { id?: number }
    return { target: 'curseforge', success: true, url: `https://www.curseforge.com/minecraft/mc-mods/${settings.curseForgeProjectId}/files/${value.id ?? ''}`, detail: `已上传 ${settings.version}` }
  }

  private async publishGithub(settings: ReleaseSettings, secrets: ReleaseSecrets, artifactPath: string): Promise<ReleasePublishResult> {
    if (!settings.githubRepository || !secrets.githubToken) throw new Error('GitHub 仓库或令牌未配置')
    const headers = { Authorization: `Bearer ${secrets.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    const response = await checkedFetch(`https://api.github.com/repos/${settings.githubRepository}/releases`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: `v${settings.version}`, name: settings.displayName, body: settings.changelog, prerelease: settings.channel !== 'release' })
    }, 'GitHub Release 创建')
    const release = await response.json() as { upload_url?: string; html_url?: string }
    if (!release.upload_url) throw new Error('GitHub 没有返回资源上传地址')
    const bytes = await fs.readFile(artifactPath)
    const uploadUrl = `${release.upload_url.replace(/\{.*$/, '')}?name=${encodeURIComponent(path.basename(artifactPath))}`
    await checkedFetch(uploadUrl, { method: 'POST', headers: { ...headers, 'Content-Type': artifactMediaType(artifactPath) }, body: new Uint8Array(bytes) }, 'GitHub 资源上传')
    return { target: 'github', success: true, url: release.html_url, detail: `已创建 v${settings.version}` }
  }

  async publish(input: ReleasePublishInput): Promise<ReleasePublishResult[]> {
    const project = this.getProject()
    if (!isJavaLoader(project.loader) && !isModpackProject(project)) throw new Error(`${platformLabel(project.loader)} 项目不能通过 Java Mod 发布中心发布；请在官方平台完成提交`)
    if (!input.confirmed) throw new Error('发布操作需要明确确认')
    const targets = [...new Set(input.targets)].filter((target) => target === 'modrinth' || target === 'curseforge' || target === 'github')
    if (!targets.length) throw new Error('请选择至少一个发布平台')
    const settings = await this.getSettings(project)
    const preflight = await this.preflight(project, settings)
    if (!preflight.ready || !preflight.artifactPath) throw new Error('发布预检未通过')
    const secrets = await this.readSecrets()
    const results: ReleasePublishResult[] = []
    for (const target of targets) {
      try {
        const result = target === 'modrinth'
          ? await this.publishModrinth(project, settings, secrets, preflight.artifactPath)
          : target === 'curseforge'
            ? await this.publishCurseForge(project, settings, secrets, preflight.artifactPath)
            : await this.publishGithub(settings, secrets, preflight.artifactPath)
        results.push(result)
      } catch (error) {
        results.push({ target, success: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}
