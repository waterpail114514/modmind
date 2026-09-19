import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import extractZip from 'extract-zip'
import type {
  AddonImportReview,
  AddonImportReviewItem,
  AddonImportSelection,
  AddonPlatformInstallInput,
  AddonPrepareInput,
  AddonRelationship,
  AddonRelationshipAudit,
  AddonRelationshipManifest,
  AddonRelationshipRole,
  AddonSearchProvider,
  AddonSearchHit,
  AddonVersionOption,
  ManagedDependency
} from '../shared/production'
import type { JavaLoaderKind, ProjectInfo } from '../shared/types'
import { isJavaLoader } from '../shared/projectPlatform'
import { applyManagedDependencies, readManagedDependencies } from './dependencyService'
import { fetchJsonWithRetry } from './networkRequest'
import { syncAddonDescriptor } from './addonDescriptors'
import { ensureProjectIdentity } from './projectIdentity'
import { descriptorPath } from './projectTemplates'
import { inspectModJar, type InspectedModJar } from './jarInspection'
import { planMods, type ModpackPlan, type PlannedMod } from './modpackPlanner'
import type { AutomaticModPlatform, IdentifiedModFile, ModFile, ModProjectDetails, ModProviderRegistry } from './modProviderService'
import { verifiedDownload } from './downloadService'
import type { McmodService } from './mcmodService'

export const ADDON_RELATIONSHIPS_FILE = 'modmind.relationships.json'

interface ImportSessionItem {
  id: string
  path: string
  inspection: InspectedModJar
  identified: IdentifiedModFile[]
  candidates: AddonImportReviewItem['candidates']
}

interface ImportSession {
  projectPath: string
  createdAt: number
  items: ImportSessionItem[]
}

interface ServiceOptions {
  getProject: () => ProjectInfo
  registry: () => ModProviderRegistry
  cacheRoot: string
  importRuntime: (filePath: string) => Promise<unknown>
  removeRuntime: (fileName: string) => Promise<unknown>
  readProject: (projectPath: string) => Promise<ProjectInfo | null>
  mcmod?: McmodService
}

interface PrivateImport {
  source: string
  inspection: InspectedModJar
  role: AddonRelationshipRole
}

function manifestPath(project: ProjectInfo): string {
  return path.join(project.path, ADDON_RELATIONSHIPS_FILE)
}

function emptyManifest(project: ProjectInfo): AddonRelationshipManifest {
  return { version: 1, minecraftVersion: project.minecraftVersion, loader: project.loader, updatedAt: new Date().toISOString(), relationships: [] }
}

function safeRelationship(value: unknown): value is AddonRelationship {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && ['required', 'optional', 'test'].includes(String(entry.role))
    && ['modrinth', 'curseforge', 'modmind-project', 'private'].includes(String(entry.provider))
    && typeof entry.name === 'string'
    && typeof entry.version === 'string'
    && typeof entry.primaryModId === 'string'
    && Array.isArray(entry.modIds)
    && typeof entry.fileName === 'string'
    && typeof entry.relativePath === 'string'
    && Boolean(entry.api && typeof entry.api === 'object')
}

export async function readAddonRelationships(project: ProjectInfo): Promise<AddonRelationshipManifest> {
  const fallback = emptyManifest(project)
  const parsed = await fs.readFile(manifestPath(project), 'utf8').then((value) => JSON.parse(value) as Record<string, unknown>).catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ENOENT') return null
    throw error
  })
  if (!parsed) return fallback
  if (parsed.version !== 1 || parsed.minecraftVersion !== project.minecraftVersion || parsed.loader !== project.loader || !Array.isArray(parsed.relationships)) {
    throw new Error(`${ADDON_RELATIONSHIPS_FILE} 与当前项目版本或加载器不一致`)
  }
  if (parsed.relationships.some((entry) => !safeRelationship(entry))) throw new Error(`${ADDON_RELATIONSHIPS_FILE} 包含无效记录`)
  return { ...fallback, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : fallback.updatedAt, relationships: parsed.relationships as AddonRelationship[] }
}

async function writeManifest(project: ProjectInfo, relationships: AddonRelationship[]): Promise<AddonRelationshipManifest> {
  const manifest = { ...emptyManifest(project), relationships, updatedAt: new Date().toISOString() }
  const target = manifestPath(project)
  const temporary = `${target}.pending-${process.pid}`
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try { await fs.rename(temporary, target) } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  return manifest
}

function directPlatform(relationships: AddonRelationship[]): Array<AddonRelationship & { provider: AutomaticModPlatform }> {
  return relationships.filter((entry): entry is AddonRelationship & { provider: AutomaticModPlatform } => !entry.automatic && (entry.provider === 'modrinth' || entry.provider === 'curseforge'))
}

function relationKey(provider: string, projectId: string): string {
  return `${provider}:${projectId}`
}

function aliasName(name: string): string | undefined {
  const match = name.match(/\(([A-Za-z][A-Za-z0-9 ._':-]{1,100})\)/)
  return match?.[1]
}

function chineseName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function translationFor(hit: AddonSearchHit, translations: AddonSearchHit[]): AddonSearchHit | undefined {
  const candidates = [hit.name, hit.englishName ?? '', hit.slug, hit.projectId].map(normalizedName).filter(Boolean)
  return translations.find((translation) => {
    const names = [translation.englishName ?? '', translation.name].map(normalizedName).filter(Boolean)
    return names.some((name) => candidates.includes(name))
  })
}

function scoreHit(hit: AddonSearchHit, query: string): number {
  const name = hit.name.toLowerCase()
  const english = (hit.englishName ?? '').toLowerCase()
  const exact = name === query || english === query ? 100 : 0
  const starts = name.startsWith(query) || english.startsWith(query) ? 30 : 0
  const auto = hit.provider === 'mcmod' ? 0 : 20
  return exact + starts + auto + Math.min(10, Math.log10(Math.max(1, hit.downloads)))
}

function planEntries(plan: ModpackPlan): PlannedMod[] {
  return [...plan.required, ...plan.optional, ...(plan.dependencies ?? [])]
}

function directKeys(plan: ModpackPlan): { required: Set<string>; optional: Set<string> } {
  const keys = (entries: PlannedMod[]): Set<string> => new Set(entries.flatMap((entry) => entry.selected ? [relationKey(entry.selected.provider, entry.selected.projectId)] : []))
  return { required: keys(plan.required), optional: keys(plan.optional) }
}

function environment(side: ModFile['side']): AddonRelationship['environment'] {
  return side === 'client' || side === 'server' || side === 'both' ? side : 'unknown'
}

function safeFileName(value: string): string {
  const name = path.basename(value)
  if (name !== value || !name.toLowerCase().endsWith('.jar') || name.length > 180) throw new Error(`无效的模组文件名：${value}`)
  return name
}

async function countSourceFiles(root: string): Promise<{ javaFiles: number; packages: string[]; versions: string[] }> {
  let javaFiles = 0
  const packages = new Set<string>()
  const versions = new Set<string>()
  const queue = [root]
  while (queue.length) {
    const directory = queue.shift()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && entry.name.endsWith('.java')) {
        javaFiles += 1
        if (javaFiles > 100_000) throw new Error('源码文件数量异常')
        const relative = path.relative(root, absolute).replaceAll('\\', '/')
        const marker = relative.includes('/java/') ? relative.split('/java/')[1] : relative
        const packageName = marker.split('/').slice(0, -1).join('.').replace(/[^A-Za-z0-9_.$]/g, '')
        if (packageName) packages.add(packageName)
      } else if (entry.isFile() && ['gradle.properties', 'fabric.mod.json', 'quilt.mod.json'].includes(entry.name)) {
        const stat = await fs.stat(absolute)
        if (stat.size > 1024 * 1024) continue
        const text = await fs.readFile(absolute, 'utf8').catch(() => '')
        if (entry.name === 'gradle.properties') {
          const version = text.match(/^\s*mod_version\s*=\s*([^\s#]+)/m)?.[1]
          if (version && !version.includes('$')) versions.add(version)
        } else {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>
            const version = entry.name === 'quilt.mod.json' && parsed.quilt_loader && typeof parsed.quilt_loader === 'object'
              ? (parsed.quilt_loader as Record<string, unknown>).version
              : parsed.version
            if (typeof version === 'string' && version.trim() && !version.includes('$')) versions.add(version.trim())
          } catch { /* Source trees may contain templated JSON. */ }
        }
      }
    }
  }
  return { javaFiles, packages: [...packages].slice(0, 80), versions: [...versions] }
}

function githubRepository(value?: string): { owner: string; repository: string } | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const [owner, repository] = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (!owner || !repository || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return null
    return { owner, repository: repository.replace(/\.git$/i, '') }
  } catch { return null }
}

function tagMatchesVersion(tag: string, version: string, minecraftVersion: string): boolean {
  const normalized = tag.toLowerCase().replace(/^v/, '')
  const target = version.toLowerCase().replace(/^v/, '')
  const versionMatches = normalized === target || normalized.split(/[-_]/).includes(target)
  if (!versionMatches) return false
  const declaredMinecraft = normalized.match(/(?:^|[-_])(?:mc)?(1\.\d+(?:\.\d+)?)(?:$|[-_])/i)?.[1]
  return !declaredMinecraft || declaredMinecraft === minecraftVersion
}

async function githubSource(details: ModProjectDetails, file: ModFile, minecraftVersion: string): Promise<{ url: string; tag: string } | null> {
  const repository = githubRepository(details.sourceUrl)
  if (!repository || file.versionName === 'unknown') return null
  const tags = await fetchJsonWithRetry<Array<{ name?: unknown; zipball_url?: unknown }>>(
    `https://api.github.com/repos/${repository.owner}/${repository.repository}/tags?per_page=100`,
    { headers: { Accept: 'application/vnd.github+json' }, attempts: 2 }
  ).catch(() => null)
  if (!tags) return null
  const match = tags.find((entry) => typeof entry.name === 'string' && typeof entry.zipball_url === 'string' && tagMatchesVersion(entry.name, file.versionName, minecraftVersion))
  return match && typeof match.name === 'string' && typeof match.zipball_url === 'string' ? { tag: match.name, url: match.zipball_url } : null
}

/**
 * codeload.github.com (the redirect target of zipball URLs) is frequently
 * unreachable without a proxy. ghfast.top mirrors GitHub archive downloads.
 */
export function githubAcceleratedUrl(url: string): string {
  return /^https:\/\/(codeload\.github\.com|github\.com)\//i.test(url) ? `https://ghfast.top/${url}` : url
}

export class AddonRelationshipService {
  private readonly sessions = new Map<string, ImportSession>()

  constructor(private readonly options: ServiceOptions) {}

  private project(): ProjectInfo {
    const project = this.options.getProject()
    if (project.kind === 'modpack' || !isJavaLoader(project.loader)) throw new Error('只有 Java 模组项目支持前置与联动')
    return project
  }

  async list(): Promise<AddonRelationshipManifest> {
    return readAddonRelationships(this.project())
  }

  providers(): Array<{ id: AddonSearchProvider; label: string }> {
    return [...this.options.registry().list().map((id) => ({ id, label: id === 'modrinth' ? 'Modrinth' : 'CurseForge' })), { id: 'mcmod' as const, label: 'MC百科' }]
  }

  async search(query: string, providers?: AddonSearchProvider[]): Promise<AddonSearchHit[]> {
    const project = this.project()
    const text = query.trim().slice(0, 120)
    if (!text) return []
    const selected = providers?.length ? providers : this.providers().map((entry) => entry.id)
    const aliases = new Set<string>([text])
    if (/[^\x00-\x7F]/.test(text)) {
      const known: Record<string, string> = { '机械动力': 'Create', '农夫乐事': "Farmer's Delight" }
      if (known[text]) aliases.add(known[text])
      const mcmodMatches = await this.options.mcmod?.search(text, 20).catch(() => []) ?? []
      for (const result of mcmodMatches) {
        const english = result.englishName ?? result.name.match(/\(([A-Za-z][A-Za-z0-9 ._':-]{1,100})\)/)?.[1]
        if (english) aliases.add(english)
      }
    }
    const automatic = selected.filter((entry): entry is AutomaticModPlatform => entry === 'modrinth' || entry === 'curseforge')
    const platformResults = (await Promise.all([...aliases].map((alias) => this.options.registry().search({ query: alias, minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind, limit: 30 }, automatic)))).flatMap((results) => results.flatMap((result) => result.hits.map((hit) => ({ provider: hit.provider, projectId: hit.projectId, slug: hit.slug, name: hit.name, summary: hit.summary, projectUrl: hit.projectUrl, downloads: hit.downloads, iconUrl: hit.iconUrl, license: hit.license, englishName: aliasName(hit.name) }))))
    const mcmodMatches = this.options.mcmod
      ? (await Promise.all([...aliases].map((alias) => this.options.mcmod!.search(alias, 20).catch(() => [])))).flat()
      : []
    const translations: AddonSearchHit[] = mcmodMatches.map((hit) => ({
      provider: 'mcmod',
      projectId: hit.projectId,
      slug: hit.projectId,
      name: chineseName(hit.name),
      englishName: hit.englishName ?? aliasName(hit.name),
      summary: hit.summary,
      projectUrl: hit.pageUrl,
      downloads: 0,
      iconUrl: hit.iconUrl
    }))
    const translatedPlatformResults = platformResults.map((hit) => {
      const translation = translationFor(hit, translations)
      if (!translation || translation.name === translation.englishName) return hit
      return {
        ...hit,
        name: translation.name,
        englishName: hit.name,
        summary: translation.summary || hit.summary,
        iconUrl: translation.iconUrl || hit.iconUrl
      }
    })
    const mcmodHits: AddonSearchHit[] = translatedPlatformResults.length || !selected.includes('mcmod') ? [] : translations
    const seen = new Set<string>()
    const unique = [...translatedPlatformResults, ...mcmodHits].filter((hit) => { const key = `${hit.provider}:${hit.projectId}`; if (seen.has(key)) return false; seen.add(key); return true })
    const lower = text.toLowerCase()
    return unique.sort((a, b) => scoreHit(b, lower) - scoreHit(a, lower))
  }

  async recommendations(): Promise<AddonSearchHit[]> {
    const project = this.project()
    if (!this.options.mcmod) return []
    const mcmod = await this.options.mcmod.recommendations(12).catch(() => [])
    const automatic = this.options.registry().list()
    return Promise.all(mcmod.map(async (hit) => {
      const searchText = hit.englishName || hit.name
      const results = await this.options.registry().search({ query: searchText, minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind, limit: 8 }, automatic).catch(() => [])
      const match = results.flatMap((result) => result.hits).find((candidate) => {
        const candidateNames = [candidate.name, candidate.slug].map(normalizedName)
        const targetNames = [hit.englishName || '', hit.name].map(normalizedName)
        return targetNames.some((name) => name && candidateNames.includes(name))
      })
      if (!match) return { provider: 'mcmod' as const, projectId: hit.projectId, slug: hit.projectId, name: hit.name, englishName: hit.englishName, summary: hit.summary, projectUrl: hit.pageUrl, downloads: 0, iconUrl: hit.iconUrl }
      return { provider: match.provider, projectId: match.projectId, slug: match.slug, name: hit.name, englishName: match.name, summary: hit.summary || match.summary, projectUrl: match.projectUrl, downloads: match.downloads, iconUrl: match.iconUrl, license: match.license }
    }))
  }

  async versions(provider: AddonSearchProvider, projectId: string): Promise<AddonVersionOption[]> {
    const project = this.project()
    if (provider === 'mcmod') {
      if (!this.options.mcmod) throw new Error('MC百科服务不可用')
      return (await this.options.mcmod.listFiles(projectId)).filter((file) => (!file.minecraftVersion || file.minecraftVersion === project.minecraftVersion) && (!file.loaders.length || file.loaders.includes(project.loader))).map((file) => ({ provider, projectId, versionId: file.fileId, versionName: file.minecraftVersion || file.fileId, filename: file.filename, side: 'both' as const, fileKey: file.fileKey, minecraftVersion: file.minecraftVersion, loaders: file.loaders, sha256: file.sha256, size: file.size }))
    }
    return (await this.options.registry().versions(provider, projectId, { minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind }))
      .map((file) => ({ provider, projectId, versionId: file.versionId, versionName: file.versionName, filename: file.filename, side: file.side, publishedAt: file.publishedAt }))
  }

  async beginMcmodDownload(projectId: string, fileKey: string): Promise<import('../shared/types').McmodCaptchaChallenge> {
    if (!this.options.mcmod) throw new Error('MC百科服务不可用')
    return this.options.mcmod.beginAddonDownload(this.project(), projectId, fileKey)
  }

  async refreshMcmodCaptcha(sessionId: string): Promise<import('../shared/types').McmodCaptchaChallenge> {
    if (!this.options.mcmod) throw new Error('MC百科服务不可用')
    return this.options.mcmod.refreshCaptcha(this.project(), sessionId)
  }

  async submitMcmodCaptcha(sessionId: string, captcha: string, role: AddonRelationshipRole): Promise<import('../shared/types').McmodDownloadResult & { relationshipAdded?: boolean }> {
    const project = this.project()
    if (!this.options.mcmod) throw new Error('MC百科服务不可用')
    const result = await this.options.mcmod.submitCaptcha(project, sessionId, captcha)
    if (!result.success || !result.filePath) return result
    try {
      const review = await this.beginImport([result.filePath])
      if (!review || review.items.length !== 1) throw new Error('MC百科文件无法识别为当前加载器的 Mod')
      const manifest = await this.confirmImport(review.batchId, [{ itemId: review.items[0].id, role, privateMod: true }])
      await fs.rm(path.dirname(result.filePath), { recursive: true, force: true }).catch(() => undefined)
      void manifest
      return { ...result, relationshipAdded: true, filePath: undefined, message: `${result.fileName ?? 'MC百科文件'} 已校验并加入附属关系` }
    } catch (error) {
      throw error
    }
  }

  private async planFor(seeds: Array<{ provider: AutomaticModPlatform; projectId: string; versionId?: string; name: string; role: AddonRelationshipRole }>, named?: AddonPrepareInput): Promise<ModpackPlan> {
    const project = this.project()
    const plan = await planMods(this.options.registry(), project, {
      required: named?.required ?? [],
      optional: named?.optional ?? [],
      providers: named?.providers,
      strictMatch: true,
      maxMods: 300,
      requiredProjects: seeds.filter((entry) => entry.role === 'required' || entry.role === 'test').map((entry) => ({ provider: entry.provider, projectId: entry.projectId, versionId: entry.versionId, name: entry.name })),
      optionalProjects: seeds.filter((entry) => entry.role === 'optional').map((entry) => ({ provider: entry.provider, projectId: entry.projectId, versionId: entry.versionId, name: entry.name }))
    })
    if (!plan.success) throw new Error(`无法准备前置模组：${[...plan.conflicts, ...plan.warnings].join('；')}`)
    return plan
  }

  private platformSeeds(current: AddonRelationship[], additions: AddonPlatformInstallInput[] = []): Array<{ provider: AutomaticModPlatform; projectId: string; versionId?: string; name: string; role: AddonRelationshipRole }> {
    const values = new Map<string, { provider: AutomaticModPlatform; projectId: string; versionId?: string; name: string; role: AddonRelationshipRole }>()
    for (const entry of directPlatform(current)) {
      if (!entry.projectId || !entry.versionId) continue
      values.set(relationKey(entry.provider, entry.projectId), { provider: entry.provider, projectId: entry.projectId, versionId: entry.versionId, name: entry.name, role: entry.role })
    }
    for (const entry of additions) values.set(relationKey(entry.provider, entry.projectId), { provider: entry.provider, projectId: entry.projectId, versionId: entry.versionId, name: entry.name || entry.projectId, role: entry.role })
    return [...values.values()]
  }

  private roleMap(seeds: Array<{ provider: AutomaticModPlatform; projectId: string; role: AddonRelationshipRole }>): Map<string, AddonRelationshipRole> {
    return new Map(seeds.map((entry) => [relationKey(entry.provider, entry.projectId), entry.role]))
  }

  async installPlatform(input: AddonPlatformInstallInput): Promise<AddonRelationshipManifest> {
    const current = await this.list()
    const seeds = this.platformSeeds(current.relationships, [input])
    return this.applyPlan(await this.planFor(seeds), new Map(), [], this.roleMap(seeds))
  }

  async prepare(input: AddonPrepareInput): Promise<AddonRelationshipManifest> {
    const current = await this.list()
    const seeds = this.platformSeeds(current.relationships)
    return this.applyPlan(await this.planFor(seeds, input), new Map(), [], this.roleMap(seeds))
  }

  private async acquireSources(file: ModFile, details: ModProjectDetails, profile: AddonRelationship['api']): Promise<AddonRelationship['api']> {
    const root = path.join(this.options.cacheRoot, file.provider, file.projectId, file.versionId)
    const sourceRoot = path.join(root, 'sources')
    const cached = await countSourceFiles(sourceRoot).catch(() => ({ javaFiles: 0, packages: [], versions: [] }))
    if (cached.javaFiles) return { ...profile, sourceKind: 'sources', sourcePath: sourceRoot, sourceMatched: true, sourceLicense: details.license, packages: cached.packages.length ? cached.packages : profile.packages }
    const reference = file.referenceArtifacts?.find((entry) => entry.kind === 'sources')
    let archive = ''
    if (reference) {
      archive = path.join(root, safeFileName(reference.filename))
      const expected = reference.sha512 ? { algorithm: 'sha512' as const, value: reference.sha512 } : reference.sha1 ? { algorithm: 'sha1' as const, value: reference.sha1 } : undefined
      await fs.mkdir(root, { recursive: true })
      await verifiedDownload.download({ sources: reference.sources, destination: archive, expectedHash: expected, maxBytes: 256 * 1024 * 1024, retriesPerSource: 3 })
    } else {
      const github = await githubSource(details, file, this.project().minecraftVersion)
      if (!github) return { ...profile, sourceLicense: details.license }
      archive = path.join(root, `${github.tag.replace(/[^A-Za-z0-9._-]+/g, '-') || 'source'}.zip`)
      await fs.mkdir(root, { recursive: true })
      await verifiedDownload.download({
        sources: [
          { id: 'github-tag', label: `GitHub ${github.tag}`, url: github.url },
          // codeload.github.com is frequently unreachable without a proxy;
          // the accelerator mirrors the same archive for direct connections.
          { id: 'github-tag-ghfast', label: `GitHub 加速源 ${github.tag}`, url: githubAcceleratedUrl(github.url) }
        ],
        destination: archive,
        maxBytes: 256 * 1024 * 1024,
        retriesPerSource: 3
      })
    }
    await fs.rm(sourceRoot, { recursive: true, force: true })
    await fs.mkdir(sourceRoot, { recursive: true })
    await extractZip(archive, { dir: sourceRoot })
    const source = await countSourceFiles(sourceRoot)
    if (!source.javaFiles) {
      await fs.rm(sourceRoot, { recursive: true, force: true })
      return { ...profile, sourceLicense: details.license }
    }
    return { ...profile, sourceKind: 'sources', sourcePath: sourceRoot, sourceMatched: true, sourceLicense: details.license, packages: source.packages.length ? source.packages : profile.packages }
  }

  private async applyPlan(plan: ModpackPlan, localOverrides: Map<string, string>, privateImports: PrivateImport[], desiredRoles = new Map<string, AddonRelationshipRole>()): Promise<AddonRelationshipManifest> {
    const project = this.project()
    const previousManifest = await readAddonRelationships(project)
    const previousDependencies = await readManagedDependencies(project)
    const descriptor = path.join(project.path, ...descriptorPath(project.loader, project.minecraftVersion).split('/'))
    const descriptorBytes = await fs.readFile(descriptor).catch(() => null)
    const manifestBytes = await fs.readFile(manifestPath(project)).catch(() => null)
    const staging = path.join(project.path, '.modmind', 'relationship-staging', `${Date.now()}-${process.pid}`)
    const backup = path.join(staging, 'backup')
    const targetRoot = path.join(project.path, 'libs', 'modmind')
    const moved: string[] = []
    const backedUp: string[] = []
    const removedBackups: Array<{ source: string; backup: string }> = []
    const nextRelationships: AddonRelationship[] = previousManifest.relationships.filter((entry) => entry.provider === 'private' || entry.provider === 'modmind-project')
    const retainedLocalIds = new Set(nextRelationships.map((entry) => entry.id))
    const nextDependencies: ManagedDependency[] = previousDependencies.filter((entry) => !entry.relationshipId || retainedLocalIds.has(entry.relationshipId))
    const keys = directKeys(plan)
    const names = new Set(nextRelationships.map((entry) => entry.fileName.toLowerCase()))
    const occupiedModIds = new Map(nextRelationships.flatMap((entry) => entry.modIds.map((modId) => [modId, entry] as const)))
    const importedPrivateModIds = new Set<string>()
    await fs.mkdir(staging, { recursive: true })
    try {
      for (const entry of planEntries(plan)) {
        if (!entry.selected || !entry.candidate) continue
        const file = entry.selected
        const key = relationKey(file.provider, file.projectId)
        const id = `platform:${key}`
        const fileName = safeFileName(file.filename)
        if (names.has(fileName.toLowerCase())) throw new Error(`多个依赖使用同一文件名：${fileName}`)
        names.add(fileName.toLowerCase())
        const staged = path.join(staging, fileName)
        const target = path.join(targetRoot, fileName)
        const existing = previousManifest.relationships.find((relationship) => relationship.id === id && relationship.versionId === file.versionId && relationship.fileName === fileName)
        const override = localOverrides.get(key)
        if (override) await fs.copyFile(override, staged)
        else if (existing && await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) await fs.copyFile(target, staged)
        else await this.options.registry().install(file, staged)
        const inspection = await inspectModJar(staged, project.loader as JavaLoaderKind)
        if (inspection.profile.loader !== project.loader) throw new Error(`${fileName} 使用 ${inspection.profile.loader}，与当前项目的 ${project.loader} 不兼容`)
        const automatic = !keys.required.has(key) && !keys.optional.has(key)
        const plannedVersion = inspection.profile.version === 'unknown' ? file.versionName : inspection.profile.version
        const collisions = [...new Set(inspection.profile.modIds.map((modId) => occupiedModIds.get(modId)).filter((entry): entry is AddonRelationship => Boolean(entry)))]
        if (collisions.length) {
          const fullyProvided = inspection.profile.modIds.every((modId) => occupiedModIds.has(modId))
          const exactVersions = plannedVersion !== 'unknown' && collisions.every((entry) => entry.version !== 'unknown' && entry.version === plannedVersion)
          if (automatic && fullyProvided && exactVersions) {
            names.delete(fileName.toLowerCase())
            continue
          }
          throw new Error(`${entry.candidate.name} 与已添加的 ${collisions[0].name} 使用相同模组 ID，请先移除其中一个`)
        }
        const details = await this.options.registry().details(file.provider, file.projectId)
        const api = await this.acquireSources(file, details, inspection.profile).catch(() => ({ ...inspection.profile, sourceLicense: details.license }))
        const platformLinks: NonNullable<AddonRelationship['platformLinks']> = { [file.provider]: { projectId: file.projectId, slug: entry.candidate.slug } }
        if (!automatic) {
          const matches = await this.options.registry().identify(staged, { sha1: inspection.sha1 }, { minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind })
          for (const match of matches) platformLinks[match.file.provider] = { projectId: match.file.projectId, slug: match.candidate.slug }
        }
        const prior = previousManifest.relationships.find((relationship) => relationship.id === id)
        const role: AddonRelationshipRole = automatic ? 'required' : desiredRoles.get(key) ?? (keys.optional.has(key) ? 'optional' : prior?.role === 'test' ? 'test' : 'required')
        const relationship: AddonRelationship = {
          id,
          role,
          provider: file.provider,
          projectId: file.projectId,
          versionId: file.versionId,
          slug: entry.candidate.slug,
          name: entry.candidate.name,
          version: inspection.profile.version === 'unknown' ? file.versionName : inspection.profile.version,
          primaryModId: inspection.profile.primaryModId,
          modIds: inspection.profile.modIds,
          fileName,
          relativePath: `libs/modmind/${fileName}`,
          installedAt: new Date().toISOString(),
          environment: environment(file.side),
          sha256: inspection.sha256,
          platformLinks,
          ...(automatic ? { automatic: true } : {}),
          dependencies: [...(file.dependencies ?? []), ...inspection.dependencies],
          api
        }
        nextRelationships.push(relationship)
        for (const modId of relationship.modIds) occupiedModIds.set(modId, relationship)
        nextDependencies.push({
          projectId: `${file.provider}-${file.projectId}`,
          versionId: file.versionId,
          slug: entry.candidate.slug,
          name: entry.candidate.name,
          versionNumber: file.versionName,
          fileName,
          relativePath: `libs/modmind/${fileName}`,
          installedAt: new Date().toISOString(),
          environment: environment(file.side) === 'unknown' ? 'both' : environment(file.side) as 'client' | 'server' | 'both',
          ...(file.provider === 'modrinth' ? { source: 'modrinth' as const } : {}),
          sha512: inspection.sha512,
          relationshipId: id,
          relationshipRole: automatic ? 'transitive' : role,
          provider: file.provider
        })
      }

      for (const item of privateImports) {
        const duplicateModId = item.inspection.profile.modIds.find((modId) => importedPrivateModIds.has(modId))
        if (duplicateModId) throw new Error(`本次导入包含多个使用模组 ID ${duplicateModId} 的私人 JAR`)
        const replacing = nextRelationships.find((entry) => entry.provider === 'private' && entry.primaryModId === item.inspection.profile.primaryModId)
        if (replacing) {
          names.delete(replacing.fileName.toLowerCase())
          for (const modId of replacing.modIds) if (occupiedModIds.get(modId)?.id === replacing.id) occupiedModIds.delete(modId)
          nextRelationships.splice(nextRelationships.indexOf(replacing), 1)
          for (let index = nextDependencies.length - 1; index >= 0; index -= 1) if (nextDependencies[index].relationshipId === replacing.id) nextDependencies.splice(index, 1)
        }
        const collision = item.inspection.profile.modIds.map((modId) => occupiedModIds.get(modId)).find(Boolean)
        if (collision) throw new Error(`${item.inspection.profile.displayName} 与已添加的 ${collision.name} 使用相同模组 ID，请先移除其中一个`)
        const fileName = safeFileName(item.inspection.fileName)
        const id = `private:${item.inspection.sha256}`
        if (names.has(fileName.toLowerCase())) throw new Error(`多个依赖使用同一文件名：${fileName}`)
        names.add(fileName.toLowerCase())
        await fs.copyFile(item.source, path.join(staging, fileName))
        const relationship: AddonRelationship = {
          id,
          role: item.role,
          provider: 'private',
          name: item.inspection.profile.displayName,
          version: item.inspection.profile.version,
          primaryModId: item.inspection.profile.primaryModId,
          modIds: item.inspection.profile.modIds,
          fileName,
          relativePath: `libs/modmind/${fileName}`,
          installedAt: new Date().toISOString(),
          environment: 'both',
          sha256: item.inspection.sha256,
          dependencies: item.inspection.dependencies,
          api: item.inspection.profile
        }
        nextRelationships.push(relationship)
        for (const modId of relationship.modIds) {
          occupiedModIds.set(modId, relationship)
          importedPrivateModIds.add(modId)
        }
        for (let index = nextDependencies.length - 1; index >= 0; index -= 1) if (nextDependencies[index].relationshipId === id) nextDependencies.splice(index, 1)
        nextDependencies.push({
          projectId: id,
          versionId: item.inspection.sha256,
          slug: item.inspection.profile.primaryModId,
          name: item.inspection.profile.displayName,
          versionNumber: item.inspection.profile.version,
          fileName,
          relativePath: `libs/modmind/${fileName}`,
          installedAt: new Date().toISOString(),
          environment: 'both',
          sha512: item.inspection.sha512,
          relationshipId: id,
          relationshipRole: item.role,
          provider: 'private'
        })
      }

      await fs.mkdir(backup, { recursive: true })
      for (const relationship of nextRelationships) {
        const staged = path.join(staging, relationship.fileName)
        if (!await fs.stat(staged).then((stat) => stat.isFile()).catch(() => false)) continue
        const target = path.join(targetRoot, relationship.fileName)
        await fs.mkdir(targetRoot, { recursive: true })
        if (await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) {
          await fs.rename(target, path.join(backup, relationship.fileName))
          backedUp.push(relationship.fileName)
        }
        await fs.rename(staged, target)
        moved.push(relationship.fileName)
      }
      const retained = new Set(nextRelationships.map((entry) => entry.fileName.toLowerCase()))
      for (const old of previousManifest.relationships) {
        if (retained.has(old.fileName.toLowerCase())) continue
        const source = path.join(project.path, ...old.relativePath.split('/'))
        if (!await fs.stat(source).then((stat) => stat.isFile()).catch(() => false)) continue
        const backupTarget = path.join(backup, `removed-${removedBackups.length}-${safeFileName(old.fileName)}`)
        await fs.rename(source, backupTarget)
        removedBackups.push({ source, backup: backupTarget })
      }
      await applyManagedDependencies(project, nextDependencies)
      await syncAddonDescriptor(project, nextRelationships, previousManifest.relationships)
      const written = await writeManifest(project, nextRelationships)
      for (const relationship of nextRelationships) await this.options.importRuntime(path.join(project.path, ...relationship.relativePath.split('/')))
      for (const old of previousManifest.relationships) {
        if (retained.has(old.fileName.toLowerCase())) continue
        await this.options.removeRuntime(old.fileName).catch(() => undefined)
      }
      return written
    } catch (error) {
      for (const name of moved) await fs.rm(path.join(targetRoot, name), { force: true }).catch(() => undefined)
      for (const name of backedUp) await fs.rename(path.join(backup, name), path.join(targetRoot, name)).catch(() => undefined)
      for (const entry of removedBackups) {
        await fs.mkdir(path.dirname(entry.source), { recursive: true }).catch(() => undefined)
        await fs.rename(entry.backup, entry.source).catch(() => undefined)
      }
      await applyManagedDependencies(project, previousDependencies).catch(() => undefined)
      if (descriptorBytes) await fs.writeFile(descriptor, descriptorBytes).catch(() => undefined)
      if (manifestBytes) await fs.writeFile(manifestPath(project), manifestBytes).catch(() => undefined)
      else await fs.rm(manifestPath(project), { force: true }).catch(() => undefined)
      for (const relationship of nextRelationships) await this.options.removeRuntime(relationship.fileName).catch(() => undefined)
      for (const relationship of previousManifest.relationships) await this.options.importRuntime(path.join(project.path, ...relationship.relativePath.split('/'))).catch(() => undefined)
      throw error
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private expireSessions(): void {
    const cutoff = Date.now() - 30 * 60_000
    for (const [id, session] of this.sessions) if (session.createdAt < cutoff) this.sessions.delete(id)
  }

  private async candidateMatches(inspection: InspectedModJar): Promise<AddonImportReviewItem['candidates']> {
    const project = this.project()
    const results = await this.options.registry().search({ query: inspection.profile.displayName || inspection.profile.primaryModId, minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind, limit: 8 })
    const candidates: AddonImportReviewItem['candidates'] = []
    for (const hit of results.flatMap((result) => result.hits).slice(0, 8)) {
      const versions = await this.options.registry().versions(hit.provider, hit.projectId, { minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind }).catch(() => [])
      const version = versions.find((entry) => entry.versionName === inspection.profile.version || entry.filename === inspection.fileName)
      if (!version) continue
      candidates.push({ provider: hit.provider, projectId: hit.projectId, versionId: version.versionId, name: hit.name, versionName: version.versionName, exact: false })
    }
    return candidates
  }

  async beginImport(filePaths: string[]): Promise<AddonImportReview | null> {
    const project = this.project()
    if (!filePaths.length) return null
    this.expireSessions()
    const items: ImportSessionItem[] = []
    for (const filePath of filePaths) {
      const inspection = await inspectModJar(filePath, project.loader as JavaLoaderKind)
      if (inspection.profile.loader !== project.loader) throw new Error(`${inspection.fileName} 与当前 ${project.loader} 项目不兼容`)
      const identified = await this.options.registry().identify(filePath, { sha1: inspection.sha1 }, { minecraftVersion: project.minecraftVersion, loader: project.loader as JavaLoaderKind })
      const candidates = identified.length ? [] : await this.candidateMatches(inspection)
      items.push({ id: randomUUID(), path: filePath, inspection, identified, candidates })
    }
    const batchId = randomUUID()
    this.sessions.set(batchId, { projectPath: project.path, createdAt: Date.now(), items })
    return {
      batchId,
      items: items.map((item) => {
        const exact = item.identified[0]
        return {
          id: item.id,
          fileName: item.inspection.fileName,
          size: item.inspection.size,
          detectedName: item.inspection.profile.displayName,
          detectedVersion: item.inspection.profile.version,
          primaryModId: item.inspection.profile.primaryModId,
          modIds: item.inspection.profile.modIds,
          loader: item.inspection.profile.loader,
          ...(exact ? { match: { provider: exact.file.provider, projectId: exact.file.projectId, versionId: exact.file.versionId, name: exact.candidate.name, versionName: exact.file.versionName, exact: true } } : {}),
          candidates: item.candidates,
          warnings: item.inspection.warnings
        }
      })
    }
  }

  async importExact(filePaths: string[], role: AddonRelationshipRole = 'required'): Promise<AddonRelationshipManifest> {
    const review = await this.beginImport(filePaths)
    if (!review) return this.list()
    try {
      const selections: AddonImportSelection[] = review.items.map((item) => {
        if (!item.match?.exact) {
          const candidates = item.candidates.map((candidate) => `${candidate.name} ${candidate.versionName}`).join('、')
          throw new Error(`${item.fileName} 无法准确匹配平台文件${candidates ? `；可选候选：${candidates}` : ''}，请在“前置与联动”页面批量确认`)
        }
        return { itemId: item.id, role, match: item.match }
      })
      return await this.confirmImport(review.batchId, selections)
    } catch (error) {
      this.cancelImport(review.batchId)
      throw error
    }
  }

  async describeForAi(): Promise<Record<string, unknown>> {
    const project = this.project()
    const manifest = await readAddonRelationships(project)
    return {
      minecraftVersion: manifest.minecraftVersion,
      loader: manifest.loader,
      relationships: manifest.relationships.map((entry) => ({
        id: entry.id,
        role: entry.role,
        automatic: Boolean(entry.automatic),
        provider: entry.provider,
        name: entry.name,
        version: entry.version,
        modId: entry.primaryModId,
        artifactPath: path.join(project.path, ...entry.relativePath.split('/')),
        sourceKind: entry.api.sourceKind,
        sourcePath: entry.api.sourcePath,
        sourceMatched: entry.api.sourceMatched,
        sourceLicense: entry.api.sourceLicense,
        classCount: entry.api.classCount,
        packages: entry.api.packages,
        dependencies: entry.dependencies
      })),
      policy: 'Prefer an exact-version sourcePath when present. Otherwise inspect the verified artifactPath. Source is reference-only: respect its license and do not copy code unless the license permits it.'
    }
  }

  async confirmImport(batchId: string, selections: AddonImportSelection[]): Promise<AddonRelationshipManifest> {
    const project = this.project()
    const session = this.sessions.get(batchId)
    if (!session || path.resolve(session.projectPath) !== path.resolve(project.path)) throw new Error('导入确认已过期，请重新选择 JAR')
    if (selections.length !== session.items.length) throw new Error('必须处理本次导入列表中的每个 JAR')
    const selectedById = new Map(selections.map((entry) => [entry.itemId, entry]))
    const additions: AddonPlatformInstallInput[] = []
    const overrides = new Map<string, string>()
    const privateImports: PrivateImport[] = []
    const selectedProjects = new Set<string>()
    for (const item of session.items) {
      const selection = selectedById.get(item.id)
      if (!selection) throw new Error(`尚未处理 ${item.inspection.fileName}`)
      const exact = item.identified[0]
      const match = selection.match ?? (exact ? { provider: exact.file.provider, projectId: exact.file.projectId, versionId: exact.file.versionId, name: exact.candidate.name, versionName: exact.file.versionName } : undefined)
      if (match) {
        const allowed = exact && match.provider === exact.file.provider && match.projectId === exact.file.projectId && match.versionId === exact.file.versionId
          || item.candidates.some((candidate) => candidate.provider === match.provider && candidate.projectId === match.projectId && candidate.versionId === match.versionId)
        if (!allowed) throw new Error(`${item.inspection.fileName} 的平台匹配未经本次识别确认`)
        const key = relationKey(match.provider, match.projectId)
        if (selectedProjects.has(key)) throw new Error(`本次导入包含同一个平台模组的多个文件：${match.name}`)
        selectedProjects.add(key)
        additions.push({ provider: match.provider, projectId: match.projectId, versionId: match.versionId, name: match.name, role: selection.role })
        overrides.set(key, item.path)
      } else if (selection.privateMod) {
        privateImports.push({ source: item.path, inspection: item.inspection, role: selection.role })
      } else throw new Error(`${item.inspection.fileName} 必须匹配平台项目或明确标记为私人定制模组`)
    }
    try {
      const current = await this.list()
      const plan = await this.planFor(this.platformSeeds(current.relationships, additions))
      return await this.applyPlan(plan, overrides, privateImports, this.roleMap(this.platformSeeds(current.relationships, additions)))
    } finally {
      this.sessions.delete(batchId)
    }
  }

  cancelImport(batchId: string): void {
    this.sessions.delete(batchId)
  }

  async linkProject(target: ProjectInfo, artifactPath: string): Promise<AddonRelationshipManifest> {
    const project = this.project()
    if (!isJavaLoader(target.loader) || target.kind === 'modpack') throw new Error('只能关联另一个 Java 模组项目')
    if (path.resolve(target.path) === path.resolve(project.path)) throw new Error('项目不能依赖自己')
    if (target.loader !== project.loader || target.minecraftVersion !== project.minecraftVersion) throw new Error('关联项目必须使用相同的 Minecraft 版本和加载器')
    const visited = new Set<string>()
    const identityPath = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    const inspectLinks = async (node: ProjectInfo): Promise<void> => {
      const key = identityPath(node.path)
      if (key === identityPath(project.path) || node.projectId && project.projectId && node.projectId === project.projectId) throw new Error('检测到项目循环依赖或复制项目身份冲突')
      if (visited.has(key)) return
      visited.add(key)
      for (const link of (await readAddonRelationships(node)).relationships) {
        if (link.provider !== 'modmind-project' || !link.linkedProjectPath) continue
        if (identityPath(link.linkedProjectPath) === identityPath(project.path)) throw new Error('检测到项目循环依赖')
        const child = await this.options.readProject(link.linkedProjectPath)
        if (child) await inspectLinks(child)
      }
    }
    await inspectLinks(target)
    const targetRelationships = await readAddonRelationships(target).catch(() => emptyManifest(target))
    if (targetRelationships.relationships.some((entry) => entry.provider === 'modmind-project' && entry.linkedProjectPath && path.resolve(entry.linkedProjectPath) === path.resolve(project.path))) {
      throw new Error('两个 ModMind 项目不能互相依赖')
    }
    const inspection = await inspectModJar(artifactPath, project.loader as JavaLoaderKind)
    const releaseSettings: Record<string, unknown> = await fs.readFile(path.join(target.path, 'modmind.release.json'), 'utf8').then((value) => JSON.parse(value) as Record<string, unknown>).catch(() => ({}))
    const platformLinks: NonNullable<AddonRelationship['platformLinks']> = {}
    if (typeof releaseSettings.modrinthProjectId === 'string' && releaseSettings.modrinthProjectId.trim()) {
      const projectId = releaseSettings.modrinthProjectId.trim()
      const details = await this.options.registry().details('modrinth', projectId).catch(() => null)
      platformLinks.modrinth = { projectId, ...(details?.slug ? { slug: details.slug } : {}) }
    }
    if (typeof releaseSettings.curseForgeProjectId === 'string' && /^\d+$/.test(releaseSettings.curseForgeProjectId.trim()) && this.options.registry().list().includes('curseforge')) {
      const projectId = releaseSettings.curseForgeProjectId.trim()
      const details = await this.options.registry().details('curseforge', projectId).catch(() => null)
      platformLinks.curseforge = { projectId, ...(details?.slug ? { slug: details.slug } : {}) }
    }
    const fileName = safeFileName(`modmind-linked-${target.namespace}.jar`)
    const previousManifestBytes = await fs.readFile(manifestPath(project)).catch(() => null)
    const current = await readAddonRelationships(project)
    const linkedProjectId = await ensureProjectIdentity(target)
    const id = `modmind-project:${linkedProjectId}`
    for (const entry of current.relationships) {
      if (entry.provider !== 'modmind-project' || entry.linkedProjectId !== linkedProjectId || !entry.linkedProjectPath || identityPath(entry.linkedProjectPath) === identityPath(target.path)) continue
      if (await this.options.readProject(entry.linkedProjectPath)) throw new Error('原路径仍存在同身份项目；请明确移除旧关联，或为副本创建独立身份后关联')
    }
    if (current.relationships.some(entry => entry.provider === 'modmind-project' && entry.linkedProjectId && entry.linkedProjectId !== linkedProjectId && entry.modIds.some(modId => inspection.profile.modIds.includes(modId)))) {
      throw new Error('另一个项目身份已提供相同 Mod ID；请先解除冲突关联')
    }
    const replacedIds = new Set(current.relationships.filter(entry => entry.provider === 'modmind-project' && (
      entry.linkedProjectId === linkedProjectId || entry.id === id || entry.modIds.some(modId => inspection.profile.modIds.includes(modId))
    )).map(entry => entry.id))
    const relationship: AddonRelationship = {
      id,
      role: 'required',
      provider: 'modmind-project',
      name: target.name,
      version: inspection.profile.version,
      primaryModId: inspection.profile.primaryModId,
      modIds: inspection.profile.modIds,
      fileName,
      relativePath: `libs/modmind/${fileName}`,
      linkedProjectPath: target.path,
      linkedProjectId,
      compatibilityRange: current.relationships.find(entry => replacedIds.has(entry.id) && entry.compatibilityRange)?.compatibilityRange,
      ...(Object.keys(platformLinks).length ? { platformLinks } : {}),
      installedAt: new Date().toISOString(),
      environment: 'both',
      sha256: inspection.sha256,
      dependencies: inspection.dependencies,
      api: { ...inspection.profile, sourceKind: 'project', sourcePath: target.path, sourceMatched: true }
    }
    const ownedBefore = current.relationships.filter((entry) => replacedIds.has(entry.id) || entry.parentRelationshipIds?.some(parent => replacedIds.has(parent)))
    const retained = current.relationships.filter((entry) => !replacedIds.has(entry.id) && !entry.parentRelationshipIds?.some(parent => replacedIds.has(parent)))
    const occupiedRelationships = new Map(retained.flatMap((entry) => entry.modIds.map((modId) => [modId, entry] as const)))
    relationship.modIds.forEach((modId) => occupiedRelationships.set(modId, relationship))
    const stagedRelationships: Array<{ relationship: AddonRelationship; source: string; sha512: string }> = [{ relationship, source: artifactPath, sha512: inspection.sha512 }]
    for (const dependency of targetRelationships.relationships.filter((entry) => entry.automatic || entry.role === 'required')) {
      const existing = dependency.modIds.map((modId) => occupiedRelationships.get(modId)).find(Boolean)
      if (existing) {
        if (existing.version !== 'unknown' && dependency.version !== 'unknown' && existing.version !== dependency.version) throw new Error(`${target.name} 需要 ${dependency.name} ${dependency.version}，但当前项目已经使用 ${existing.version}`)
        continue
      }
      const source = path.join(target.path, ...dependency.relativePath.split('/'))
      const dependencyInspection = await inspectModJar(source, project.loader as JavaLoaderKind)
      const suffix = dependency.fileName.slice(-120).replace(/[^A-Za-z0-9._-]+/g, '-')
      const linkedFileName = safeFileName(`modmind-linked-${target.namespace}-${createHash('sha1').update(dependency.id).digest('hex').slice(0, 8)}-${suffix}`)
      stagedRelationships.push({
        source,
        sha512: dependencyInspection.sha512,
        relationship: {
          ...dependency,
          id: `linked-dependency:${createHash('sha256').update(`${id}:${dependency.id}`).digest('hex').slice(0, 28)}`,
          role: 'required',
          automatic: true,
          parentRelationshipIds: [id],
          fileName: linkedFileName,
          relativePath: `libs/modmind/${linkedFileName}`,
          installedAt: new Date().toISOString(),
          sha256: dependencyInspection.sha256
        }
      })
      dependency.modIds.forEach((modId) => occupiedRelationships.set(modId, dependency))
    }
    const relationships = [relationship, ...stagedRelationships.slice(1).map((entry) => entry.relationship), ...retained]
    const descriptorTarget = path.join(project.path, ...descriptorPath(project.loader, project.minecraftVersion).split('/'))
    const descriptorBytes = await fs.readFile(descriptorTarget).catch(() => null)
    const previousDependencies = await readManagedDependencies(project)
    const ownedDependencyIds = new Set(ownedBefore.map((entry) => entry.id))
    const replacedPaths = new Set(stagedRelationships.map(entry => entry.relationship.relativePath.toLowerCase()))
    const dependencies = previousDependencies.filter((entry) => (!entry.relationshipId || !ownedDependencyIds.has(entry.relationshipId)) && !replacedPaths.has(entry.relativePath?.toLowerCase() ?? ''))
    for (const staged of stagedRelationships) {
      dependencies.push({
        projectId: staged.relationship.id,
        versionId: staged.relationship.sha256 ?? staged.relationship.version,
        slug: staged.relationship.primaryModId,
        name: staged.relationship.name,
        versionNumber: staged.relationship.version,
        fileName: staged.relationship.fileName,
        relativePath: staged.relationship.relativePath,
        installedAt: staged.relationship.installedAt,
        environment: staged.relationship.environment === 'unknown' ? 'both' : staged.relationship.environment,
        sha512: staged.sha512,
        relationshipId: staged.relationship.id,
        relationshipRole: staged.relationship.automatic ? 'transitive' : 'required',
        provider: staged.relationship.provider
      })
    }
    const stagingRoot = path.join(project.path, '.modmind', 'linked-project-staging', `${Date.now()}-${process.pid}`)
    const backupRoot = path.join(stagingRoot, 'backup')
    const moved: string[] = []
    const backedUp: string[] = []
    const removedBackups: Array<{ source: string; backup: string }> = []
    try {
      await fs.mkdir(backupRoot, { recursive: true })
      for (const staged of stagedRelationships) await fs.copyFile(staged.source, path.join(stagingRoot, staged.relationship.fileName))
      for (const staged of stagedRelationships) {
        const targetJar = path.join(project.path, ...staged.relationship.relativePath.split('/'))
        await fs.mkdir(path.dirname(targetJar), { recursive: true })
        if (await fs.stat(targetJar).then((stat) => stat.isFile()).catch(() => false)) {
          await fs.rename(targetJar, path.join(backupRoot, staged.relationship.fileName))
          backedUp.push(staged.relationship.fileName)
        }
        await fs.rename(path.join(stagingRoot, staged.relationship.fileName), targetJar)
        moved.push(staged.relationship.fileName)
      }
      const retainedFiles = new Set(relationships.map((entry) => entry.fileName.toLowerCase()))
      for (const old of ownedBefore) {
        if (retainedFiles.has(old.fileName.toLowerCase())) continue
        const source = path.join(project.path, ...old.relativePath.split('/'))
        if (!await fs.stat(source).then((stat) => stat.isFile()).catch(() => false)) continue
        const backupTarget = path.join(backupRoot, `removed-${removedBackups.length}-${safeFileName(old.fileName)}`)
        await fs.rename(source, backupTarget)
        removedBackups.push({ source, backup: backupTarget })
      }
      await applyManagedDependencies(project, dependencies)
      await syncAddonDescriptor(project, relationships, current.relationships)
      const manifest = await writeManifest(project, relationships)
      for (const staged of stagedRelationships) await this.options.importRuntime(path.join(project.path, ...staged.relationship.relativePath.split('/')))
      for (const old of ownedBefore) {
        if (retainedFiles.has(old.fileName.toLowerCase())) continue
        await this.options.removeRuntime(old.fileName).catch(() => undefined)
      }
      return manifest
    } catch (error) {
      for (const name of moved) await fs.rm(path.join(project.path, 'libs', 'modmind', name), { force: true }).catch(() => undefined)
      for (const name of backedUp) await fs.rename(path.join(backupRoot, name), path.join(project.path, 'libs', 'modmind', name)).catch(() => undefined)
      for (const entry of removedBackups) {
        await fs.mkdir(path.dirname(entry.source), { recursive: true }).catch(() => undefined)
        await fs.rename(entry.backup, entry.source).catch(() => undefined)
      }
      await applyManagedDependencies(project, previousDependencies).catch(() => undefined)
      if (descriptorBytes) await fs.writeFile(descriptorTarget, descriptorBytes).catch(() => undefined)
      if (previousManifestBytes) await fs.writeFile(manifestPath(project), previousManifestBytes).catch(() => undefined)
      else await fs.rm(manifestPath(project), { force: true }).catch(() => undefined)
      for (const staged of stagedRelationships) await this.options.removeRuntime(staged.relationship.fileName).catch(() => undefined)
      for (const old of ownedBefore) await this.options.importRuntime(path.join(project.path, ...old.relativePath.split('/'))).catch(() => undefined)
      throw error
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async refreshLinkedProjects(build: (project: ProjectInfo) => Promise<string>, stack: string[] = []): Promise<AddonRelationshipManifest> {
    const project = this.project()
    const current = await readAddonRelationships(project)
    const linked = current.relationships.filter((entry) => entry.provider === 'modmind-project' && entry.linkedProjectPath)
    let result = current
    for (const relationship of linked) {
      const targetPath = path.resolve(relationship.linkedProjectPath!)
      if (stack.map((entry) => path.resolve(entry)).includes(targetPath)) throw new Error(`检测到 ModMind 项目循环依赖：${[...stack, targetPath].join(' -> ')}`)
      const target = await this.options.readProject(targetPath)
      if (!target) throw new Error(`关联项目不存在：${relationship.linkedProjectPath}`)
      const artifact = await build(target)
      result = await this.linkProject(target, artifact)
    }
    return result
  }

  async importSource(relationshipId: string, sourcePath: string): Promise<AddonRelationshipManifest> {
    const project = this.project()
    const current = await readAddonRelationships(project)
    const relationship = current.relationships.find((entry) => entry.id === relationshipId)
    if (!relationship) throw new Error('找不到要关联源码的目标模组')
    const stat = await fs.stat(sourcePath)
    const root = path.join(this.options.cacheRoot, 'manual', createHash('sha256').update(`${relationship.id}:${relationship.version}`).digest('hex').slice(0, 24))
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
    if (stat.isDirectory()) await fs.cp(sourcePath, root, { recursive: true, errorOnExist: false })
    else {
      if (!/\.(?:jar|zip)$/i.test(sourcePath)) throw new Error('源码归档必须是 JAR 或 ZIP')
      await extractZip(sourcePath, { dir: root })
    }
    const source = await countSourceFiles(root)
    if (!source.javaFiles) {
      await fs.rm(root, { recursive: true, force: true })
      throw new Error('所选内容中没有找到 Java 源码')
    }
    const sourceMatched = relationship.version === 'unknown' || !source.versions.length
      ? false
      : source.versions.includes(relationship.version)
    const relationships = current.relationships.map((entry) => entry.id === relationshipId ? { ...entry, api: { ...entry.api, sourceKind: 'sources' as const, sourcePath: root, sourceMatched, packages: source.packages.length ? source.packages : entry.api.packages } } : entry)
    return writeManifest(project, relationships)
  }

  async setRole(relationshipId: string, role: AddonRelationshipRole): Promise<AddonRelationshipManifest> {
    const current = await this.list()
    const target = current.relationships.find((entry) => entry.id === relationshipId && !entry.automatic)
    if (!target) throw new Error('只能修改直接添加的目标模组')
    if (target.provider === 'modrinth' || target.provider === 'curseforge') {
      return this.installPlatform({ provider: target.provider, projectId: target.projectId!, versionId: target.versionId, name: target.name, role })
    }
    const relationships = current.relationships.map((entry) => entry.id === relationshipId ? { ...entry, role } : entry)
    const project = this.project()
    const previousDependencies = await readManagedDependencies(project)
    const dependencies = previousDependencies.map((entry) => entry.relationshipId === relationshipId ? { ...entry, relationshipRole: role } : entry)
    const descriptorTarget = path.join(project.path, ...descriptorPath(project.loader, project.minecraftVersion).split('/'))
    const descriptorBytes = await fs.readFile(descriptorTarget)
    const manifestBytes = await fs.readFile(manifestPath(project)).catch(() => null)
    try {
      await applyManagedDependencies(project, dependencies)
      await syncAddonDescriptor(project, relationships, current.relationships)
      return await writeManifest(project, relationships)
    } catch (error) {
      await applyManagedDependencies(project, previousDependencies).catch(() => undefined)
      await fs.writeFile(descriptorTarget, descriptorBytes).catch(() => undefined)
      if (manifestBytes) await fs.writeFile(manifestPath(project), manifestBytes).catch(() => undefined)
      throw error
    }
  }

  async remove(relationshipId: string): Promise<AddonRelationshipManifest> {
    const current = await this.list()
    const target = current.relationships.find((entry) => entry.id === relationshipId && !entry.automatic)
    if (!target) throw new Error('只能移除直接添加的目标模组')
    const remaining = current.relationships.filter((entry) => entry.id !== relationshipId)
    if (target.provider === 'modrinth' || target.provider === 'curseforge') {
      const seeds = this.platformSeeds(remaining)
      const plan = await this.planFor(seeds)
      return this.applyPlan(plan, new Map(), [], this.roleMap(seeds))
    }
    const project = this.project()
    const removed = current.relationships.filter((entry) => entry.id === relationshipId || entry.parentRelationshipIds?.includes(relationshipId))
    const removedIds = new Set(removed.map((entry) => entry.id))
    const relationships = current.relationships.filter((entry) => !removedIds.has(entry.id))
    const previousDependencies = await readManagedDependencies(project)
    const dependencies = previousDependencies.filter((entry) => !entry.relationshipId || !removedIds.has(entry.relationshipId))
    const descriptorTarget = path.join(project.path, ...descriptorPath(project.loader, project.minecraftVersion).split('/'))
    const descriptorBytes = await fs.readFile(descriptorTarget)
    const manifestBytes = await fs.readFile(manifestPath(project)).catch(() => null)
    const staging = path.join(project.path, '.modmind', 'relationship-removal', `${Date.now()}-${process.pid}`)
    const moved: Array<{ source: string; backup: string }> = []
    try {
      await fs.mkdir(staging, { recursive: true })
      for (const entry of removed) {
        const source = path.join(project.path, ...entry.relativePath.split('/'))
        if (!await fs.stat(source).then((stat) => stat.isFile()).catch(() => false)) continue
        const backup = path.join(staging, entry.fileName)
        await fs.rename(source, backup)
        moved.push({ source, backup })
      }
      await applyManagedDependencies(project, dependencies)
      await syncAddonDescriptor(project, relationships, current.relationships)
      const manifest = await writeManifest(project, relationships)
      for (const entry of removed) await this.options.removeRuntime(entry.fileName).catch(() => undefined)
      return manifest
    } catch (error) {
      for (const entry of moved) await fs.rename(entry.backup, entry.source).catch(() => undefined)
      await applyManagedDependencies(project, previousDependencies).catch(() => undefined)
      await fs.writeFile(descriptorTarget, descriptorBytes).catch(() => undefined)
      if (manifestBytes) await fs.writeFile(manifestPath(project), manifestBytes).catch(() => undefined)
      for (const entry of removed) await this.options.importRuntime(path.join(project.path, ...entry.relativePath.split('/'))).catch(() => undefined)
      throw error
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async audit(): Promise<AddonRelationshipAudit> {
    const project = this.project()
    const manifest = await readAddonRelationships(project)
    const errors: string[] = []
    const warnings: string[] = []
    const availableModIds = new Set(['minecraft', 'java', 'fabricloader', 'quilt_loader', 'forge', 'neoforge', ...manifest.relationships.flatMap((entry) => entry.modIds)])
    const descriptorText = await fs.readFile(path.join(project.path, ...descriptorPath(project.loader, project.minecraftVersion).split('/')), 'utf8').catch(() => '')
    for (const relationship of manifest.relationships) {
      const target = path.resolve(project.path, ...relationship.relativePath.split('/'))
      if (!target.startsWith(`${path.resolve(project.path)}${path.sep}`)) { errors.push(`${relationship.name} 的文件路径无效`); continue }
      const bytes = await fs.readFile(target).catch(() => null)
      if (!bytes) { errors.push(`${relationship.name} 的 JAR 已缺失`); continue }
      if (relationship.sha256 && createHash('sha256').update(bytes).digest('hex') !== relationship.sha256) errors.push(`${relationship.name} 的 JAR 校验失败`)
      if (relationship.provider === 'modmind-project' && relationship.linkedProjectPath && !await this.options.readProject(relationship.linkedProjectPath)) errors.push(`${relationship.name} 的 ModMind 项目已无法打开`)
      if (relationship.provider === 'private') warnings.push(`${relationship.name} 是私人定制模组，发布平台无法自动建立项目链接`)
      if (relationship.api.sourceKind === 'jar') warnings.push(`${relationship.name} 没有同版本源码，AI 将以 JAR 为准`)
      for (const dependency of relationship.dependencies ?? []) {
        if (dependency.kind === 'required' && dependency.modId && !availableModIds.has(dependency.modId)) errors.push(`${relationship.name} 还需要前置 ${dependency.modId}`)
        if (dependency.kind === 'incompatible' && dependency.modId && availableModIds.has(dependency.modId)) errors.push(`${relationship.name} 与 ${dependency.modId} 冲突`)
      }
      if (!relationship.automatic && relationship.role === 'required' && !descriptorText.includes(relationship.primaryModId)) errors.push(`${relationship.name} 尚未写入成品前置声明`)
    }
    return { success: !errors.length, checked: manifest.relationships.length, errors, warnings }
  }
}
