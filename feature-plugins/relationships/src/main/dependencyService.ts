import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  DependencyInstallInput,
  DependencyAuditResult,
  MavenDependencyInput,
  DependencyProject,
  DependencySearchResult,
  DependencyVersion,
  ManagedDependency
} from "../../../../src/shared/production"
import type { ProjectInfo } from "../../../../src/shared/types"
import { isJavaLoader, isServerPluginPlatform, platformLabel } from "../../../../src/shared/projectPlatform"
import { verifiedDownload } from "../../../../src/main/downloadService"
import { fetchJsonWithRetry } from "../../../../src/main/networkRequest"

const MODRINTH_API = 'https://api.modrinth.com/v2'
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
const START_MARKER = '// MODMIND DEPENDENCIES START'
const END_MARKER = '// MODMIND DEPENDENCIES END'
const REPOSITORY_START_MARKER = '// MODMIND REPOSITORIES START'
const REPOSITORY_END_MARKER = '// MODMIND REPOSITORIES END'

interface ModrinthSearchHit {
  project_id?: unknown
  slug?: unknown
  title?: unknown
  description?: unknown
  icon_url?: unknown
  downloads?: unknown
  follows?: unknown
  client_side?: unknown
  server_side?: unknown
  categories?: unknown
}

interface ModrinthVersionFile {
  hashes?: { sha512?: string; sha1?: string }
  url?: string
  filename?: string
  primary?: boolean
  size?: number
}

interface ModrinthVersionRecord {
  id?: unknown
  project_id?: unknown
  name?: unknown
  version_number?: unknown
  version_type?: unknown
  date_published?: unknown
  game_versions?: unknown
  loaders?: unknown
  files?: ModrinthVersionFile[]
}

interface DependencyManifest {
  version: 1
  dependencies: ManagedDependency[]
}

function safeSegment(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new Error(`${label} 无效`)
  return value
}

function groovySingleQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function normalizedRepositoryUrl(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error('Maven 仓库地址无效')
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('Maven 仓库必须使用有效的 HTTPS 地址')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Maven 仓库必须使用无凭据的 HTTPS 地址')
  return parsed.toString().replace(/\/+$/, '')
}

function side(value: unknown): DependencyProject['clientSide'] {
  return value === 'required' || value === 'optional' || value === 'unsupported' ? value : 'unknown'
}

async function fetchJson<T>(url: string, productVersion: string): Promise<T> {
  return await fetchJsonWithRetry<T>(url, { headers: { 'User-Agent': `ModMind/${productVersion} (dependency-center)` } })
}

function toProject(value: ModrinthSearchHit): DependencyProject | null {
  if (typeof value.project_id !== 'string' || typeof value.slug !== 'string' || typeof value.title !== 'string') return null
  return {
    projectId: value.project_id,
    slug: value.slug,
    title: value.title,
    description: typeof value.description === 'string' ? value.description : '',
    ...(typeof value.icon_url === 'string' ? { iconUrl: value.icon_url } : {}),
    downloads: typeof value.downloads === 'number' ? value.downloads : 0,
    followers: typeof value.follows === 'number' ? value.follows : 0,
    clientSide: side(value.client_side),
    serverSide: side(value.server_side),
    categories: Array.isArray(value.categories) ? value.categories.filter((entry): entry is string => typeof entry === 'string') : []
  }
}

function toVersion(value: ModrinthVersionRecord): DependencyVersion | null {
  if (typeof value.id !== 'string' || typeof value.project_id !== 'string' || typeof value.version_number !== 'string') return null
  const versionType = value.version_type === 'alpha' || value.version_type === 'beta' ? value.version_type : 'release'
  return {
    id: value.id,
    projectId: value.project_id,
    name: typeof value.name === 'string' ? value.name : value.version_number,
    versionNumber: value.version_number,
    versionType,
    datePublished: typeof value.date_published === 'string' ? value.date_published : '',
    gameVersions: Array.isArray(value.game_versions) ? value.game_versions.filter((entry): entry is string => typeof entry === 'string') : [],
    loaders: Array.isArray(value.loaders) ? value.loaders.filter((entry): entry is string => typeof entry === 'string') : []
  }
}

function manifestPath(project: ProjectInfo): string {
  return path.join(project.path, 'modmind.dependencies.json')
}

async function readManifest(project: ProjectInfo): Promise<DependencyManifest> {
  try {
    const value = JSON.parse(await fs.readFile(manifestPath(project), 'utf8')) as DependencyManifest
    return { version: 1, dependencies: Array.isArray(value.dependencies) ? value.dependencies : [] }
  } catch {
    return { version: 1, dependencies: [] }
  }
}

export async function readManagedDependencies(project: ProjectInfo): Promise<ManagedDependency[]> {
  return (await readManifest(project)).dependencies
}

async function writeManifest(project: ProjectInfo, dependencies: ManagedDependency[]): Promise<void> {
  await atomicWriteFile(manifestPath(project), JSON.stringify({ version: 1, dependencies }, null, 2))
}

async function atomicWriteFile(target: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(temporary, content)
  try {
    await fs.rename(temporary, target)
  } catch {
    await fs.rm(target, { force: true })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function gradleLine(project: ProjectInfo, dependency: ManagedDependency, kotlin: boolean): string {
  if (dependency.source === 'maven' && dependency.coordinate) {
    const configuration = dependency.configuration ?? (project.loader === 'fabric' || project.loader === 'quilt' ? 'modImplementation' : 'implementation')
    if (kotlin) return `    ${configuration}("${dependency.coordinate}")`
    if (project.loader === 'forge' && configuration === 'implementation') return `    implementation fg.deobf('${dependency.coordinate}')`
    return `    ${configuration} '${dependency.coordinate}'`
  }
  const relative = dependency.relativePath.replaceAll('\\', '/')
  if (kotlin) {
    if (project.loader === 'forge') return `    implementation(fg.deobf(files("${relative}")))`
    return `    ${project.loader === 'fabric' || project.loader === 'quilt' ? 'modImplementation' : 'implementation'}(files("${relative}"))`
  }
  if (project.loader === 'forge') return `    implementation fg.deobf(files('${relative}'))`
  return `    ${project.loader === 'fabric' || project.loader === 'quilt' ? 'modImplementation' : 'implementation'} files('${relative}')`
}

function gradleBlockClosing(source: string, name: 'dependencies' | 'repositories', kotlin: boolean): number | null {
  const invalid = (): Error => new Error(`无法安全更新 Gradle ${name} 块`)

  function stringEnd(start: number, delimiter: string): number {
    const closing = delimiter === '$/' ? '/$' : delimiter
    const slashy = delimiter === '/' || delimiter === '$/'
    const raw = kotlin && delimiter === '"""'
    const interpolated = delimiter.startsWith('"') || slashy
    for (let index = start + delimiter.length; index < source.length;) {
      if (source.startsWith(closing, index)) return index + closing.length
      if (interpolated && source.startsWith('${', index)) {
        // An interpolation may itself contain quoted strings and closures.
        const expression = tokens(index + 2, true)
        let token = expression.next()
        while (!token.done) token = expression.next()
        index = token.value
      } else if (delimiter === '$/' && source[index] === '$' && /[$/]/.test(source[index + 1] ?? '')) {
        index += 2
      } else if (source[index] === '\\' && !raw && delimiter !== '$/' && (!slashy || source[index + 1] === '/')) {
        index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2
      } else {
        if (!slashy && delimiter.length === 1 && /[\r\n]/.test(source[index])) throw invalid()
        index += 1
      }
    }
    throw invalid()
  }

  function* tokens(start = 0, interpolation = false): Generator<{ value: string; offset: number }, number> {
    const pattern = /[\p{ID_Start}_$][\p{ID_Continue}$]*|\d[\w.]*|\+\+|--|[^\s]/uy
    let braces = 1
    let expressionNesting = 0
    let slashyAllowed = true
    for (let index = start; index < source.length;) {
      const character = source[index]
      if (/\s/.test(character)) {
        if (/[\r\n]/.test(character) && expressionNesting === 0) slashyAllowed = true
        index += 1
        continue
      }
      if (source.startsWith('//', index)) {
        while (index < source.length && !/[\r\n]/.test(source[index])) index += 1
        continue
      }
      if (source.startsWith('/*', index)) {
        let depth = 1
        index += 2
        while (index < source.length && depth) {
          if (kotlin && source.startsWith('/*', index)) { depth += 1; index += 2 }
          else if (source.startsWith('*/', index)) { depth -= 1; index += 2 }
          else index += 1
        }
        if (depth) throw invalid()
        continue
      }
      let delimiter = ''
      if (character === '"' || character === "'") {
        delimiter = (!kotlin || character === '"') && source.startsWith(character.repeat(3), index) ? character.repeat(3) : character
      } else if (kotlin && character === '`') delimiter = character
      else if (!kotlin && source.startsWith('$/', index)) delimiter = '$/'
      else if (!kotlin && character === '/' && slashyAllowed) delimiter = '/'
      if (delimiter) {
        const end = stringEnd(index, delimiter)
        // Keep a token so dependencies "text" { cannot become dependencies {.
        yield { value: '', offset: index }
        slashyAllowed = false
        index = end
        continue
      }
      pattern.lastIndex = index
      const value = pattern.exec(source)![0]
      const offset = index
      index += value.length
      if (interpolation) {
        if (value === '{') braces += 1
        else if (value === '}' && --braces === 0) return index
      }
      if (value === '(' || value === '[') expressionNesting += 1
      else if (value === ')' || value === ']') expressionNesting -= 1
      slashyAllowed = !/^(?:[\p{ID_Start}_$]|\d)/u.test(value) && ![')', ']', '}', '++', '--'].includes(value)
        || /^(?:return|throw|case|assert|in|instanceof|else|yield)$/.test(value)
      yield { value, offset }
    }
    if (interpolation) throw invalid()
    return source.length
  }

  const stack: Array<{ closing: string; target: boolean }> = []
  const closingFor: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  let candidate = false
  let previous = ''
  let closing: number | null = null
  for (const token of tokens()) {
    const value = token.value
    if (value === '{' || value === '(' || value === '[') {
      stack.push({ closing: closingFor[value], target: value === '{' && candidate && stack.length === 0 })
    } else if (['}', ')', ']'].includes(value)) {
      const opening = stack.pop()
      if (opening?.closing !== value) throw invalid()
      if (opening.target && closing === null) closing = token.offset
    }
    // Only the project's block is eligible, not buildscript/plugin closures
    // or a qualified call such as anotherProject.dependencies { ... }.
    candidate = stack.length === 0 && value === name && previous !== '.'
    previous = value
  }
  if (stack.length) throw invalid()
  return closing
}

function gradleNewline(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

function removeManagedGradleBlock(source: string, start: string, end: string): string {
  return source.replace(new RegExp(`(?:\\r?\\n)?${start}[\\s\\S]*?${end}(?:\\r?\\n)?`, 'g'), gradleNewline(source))
}

function insertManagedGradleBlock(source: string, name: 'dependencies' | 'repositories', block: string, kotlin: boolean): string {
  const closing = gradleBlockClosing(source, name, kotlin)
  const newline = gradleNewline(source)
  if (closing === null) return `${source.trimEnd()}${newline}${newline}${name} {${newline}${block}${newline}}${newline}`
  const prefix = source.slice(0, closing)
  return `${prefix}${prefix.endsWith('\n') ? '' : newline}${block}${newline}${source.slice(closing)}`
}

export function updateManagedGradleDependencies(source: string, project: ProjectInfo, dependencies: ManagedDependency[], kotlin: boolean): string {
  const withoutManaged = removeManagedGradleBlock(source, START_MARKER, END_MARKER)
  if (!dependencies.length) return withoutManaged
  const block = [START_MARKER, ...dependencies.map((entry) => gradleLine(project, entry, kotlin)), END_MARKER].join(gradleNewline(source))
  return insertManagedGradleBlock(withoutManaged, 'dependencies', block, kotlin)
}

function updateManagedGradleRepositories(source: string, dependencies: ManagedDependency[], kotlin: boolean): string {
  const withoutManaged = removeManagedGradleBlock(source, REPOSITORY_START_MARKER, REPOSITORY_END_MARKER)
  const repositories = [...new Set(dependencies.filter((entry) => entry.source === 'maven').map((entry) => entry.repository).filter((value): value is string => Boolean(value)))]
  if (!repositories.length) return withoutManaged
  const lines = repositories.map((url) => kotlin ? `    maven(${JSON.stringify(url)})` : `    maven { url = '${groovySingleQuoted(url)}' }`)
  const block = [REPOSITORY_START_MARKER, ...lines, REPOSITORY_END_MARKER].join(gradleNewline(source))
  return insertManagedGradleBlock(withoutManaged, 'repositories', block, kotlin)
}

async function gradleFile(project: ProjectInfo): Promise<{ target: string; source: string; kotlin: boolean }> {
  const groovy = path.join(project.path, 'build.gradle')
  const kotlin = path.join(project.path, 'build.gradle.kts')
  const target = await fs.access(groovy).then(() => groovy).catch(() => kotlin)
  const isKotlin = target.endsWith('.kts')
  const source = await fs.readFile(target, 'utf8')
  return { target, source, kotlin: isKotlin }
}

export async function applyManagedDependencies(project: ProjectInfo, dependencies: ManagedDependency[]): Promise<void> {
  const manifestTarget = manifestPath(project)
  const previousManifest = await fs.readFile(manifestTarget).catch(() => null)
  const gradle = await gradleFile(project)
  try {
    await writeManifest(project, dependencies)
    const withDependencies = updateManagedGradleDependencies(gradle.source, project, dependencies, gradle.kotlin)
    await atomicWriteFile(gradle.target, updateManagedGradleRepositories(withDependencies, dependencies, gradle.kotlin))
  } catch (error) {
    if (previousManifest) await atomicWriteFile(manifestTarget, previousManifest)
    else await fs.rm(manifestTarget, { force: true })
    await atomicWriteFile(gradle.target, gradle.source)
    throw error
  }
}

export class DependencyService {
  constructor(
    private readonly getProject: () => ProjectInfo,
    private readonly importRuntime: (filePath: string) => Promise<unknown>,
    private readonly removeRuntime: (fileName: string) => Promise<unknown>,
    private readonly productVersion = 'development'
  ) {}

  private javaProject(): ProjectInfo {
    const project = this.getProject()
    if (!isJavaLoader(project.loader) && !isServerPluginPlatform(project.loader)) throw new Error(`${platformLabel(project.loader)} 不使用 Maven/Gradle 依赖中心`)
    return project
  }

  async search(query: string, offset = 0): Promise<DependencySearchResult> {
    const project = this.javaProject()
    const normalized = query.trim().slice(0, 100)
    if (!normalized) return { query: '', total: 0, offset: 0, hits: [] }
    const facets = JSON.stringify([[`categories:${project.loader}`], [`versions:${project.minecraftVersion}`], ['project_type:mod']])
    const url = `${MODRINTH_API}/search?query=${encodeURIComponent(normalized)}&limit=20&offset=${Math.max(0, Math.floor(offset))}&facets=${encodeURIComponent(facets)}`
    const payload = await fetchJson<{ hits?: ModrinthSearchHit[]; total_hits?: number; offset?: number }>(url, this.productVersion)
    return {
      query: normalized,
      total: typeof payload.total_hits === 'number' ? payload.total_hits : 0,
      offset: typeof payload.offset === 'number' ? payload.offset : 0,
      hits: (payload.hits ?? []).map(toProject).filter((entry): entry is DependencyProject => Boolean(entry))
    }
  }

  async versions(projectId: string): Promise<DependencyVersion[]> {
    const project = this.javaProject()
    const id = safeSegment(projectId, '项目 ID')
    const query = new URLSearchParams({
      loaders: JSON.stringify([project.loader]),
      game_versions: JSON.stringify([project.minecraftVersion])
    })
    const payload = await fetchJson<ModrinthVersionRecord[]>(`${MODRINTH_API}/project/${id}/version?${query}`, this.productVersion)
    return payload.map(toVersion).filter((entry): entry is DependencyVersion => Boolean(entry))
      .sort((a, b) => b.datePublished.localeCompare(a.datePublished))
  }

  async list(): Promise<ManagedDependency[]> {
    return (await readManifest(this.javaProject())).dependencies
  }

  async install(input: DependencyInstallInput): Promise<ManagedDependency> {
    const project = this.javaProject()
    if (project.kind === 'server-plugin') throw new Error('运行插件请使用插件依赖工具；编译 API 使用 Maven 坐标')
    const projectId = safeSegment(input.projectId, '项目 ID')
    const available = await this.versions(projectId)
    const selected = input.versionId
      ? available.find((entry) => entry.id === input.versionId)
      : available.find((entry) => entry.versionType === 'release') ?? available[0]
    if (!selected) throw new Error(`没有找到兼容 ${project.loader} ${project.minecraftVersion} 的版本`)
    const rawVersion = await fetchJson<ModrinthVersionRecord>(`${MODRINTH_API}/version/${safeSegment(selected.id, '版本 ID')}`, this.productVersion)
    const projectInfo = await fetchJson<{ slug?: unknown; title?: unknown; client_side?: unknown; server_side?: unknown }>(`${MODRINTH_API}/project/${projectId}`, this.productVersion)
    const file = rawVersion.files?.find((entry) => entry.primary) ?? rawVersion.files?.[0]
    if (!file || typeof file.url !== 'string' || typeof file.filename !== 'string') throw new Error('该版本没有可下载的主 JAR')
    if (!file.filename.toLowerCase().endsWith('.jar')) throw new Error('依赖主文件不是 JAR')
    const fileName = path.basename(file.filename)
    if (fileName !== file.filename || fileName.length > 180) throw new Error('依赖文件名无效')
    const directory = path.join(project.path, 'libs', 'modmind')
    await fs.mkdir(directory, { recursive: true })
    const target = path.join(directory, fileName)
    const temporary = `${target}.partial-${process.pid}-${Date.now()}`
    const previousTarget = await fs.readFile(target).catch(() => null)
    const expectedHash = file.hashes?.sha512
      ? { algorithm: 'sha512' as const, value: file.hashes.sha512 }
      : file.hashes?.sha1
        ? { algorithm: 'sha1' as const, value: file.hashes.sha1 }
        : undefined
    await verifiedDownload.download({
      sources: [{ id: 'modrinth-cdn', label: 'Modrinth CDN', url: file.url, headers: { 'User-Agent': `ModMind/${this.productVersion} (dependency-center)` } }],
      destination: temporary,
      ...(expectedHash ? { expectedHash } : {}),
      maxBytes: MAX_DOWNLOAD_BYTES,
      stallTimeoutMs: 180_000,
      resume: true,
      retriesPerSource: 2
    })

    const manifest = await readManifest(project)
    const previous = manifest.dependencies.find((entry) => entry.projectId === projectId)
    const dependency: ManagedDependency = {
      projectId,
      versionId: selected.id,
      slug: typeof projectInfo.slug === 'string' ? projectInfo.slug : projectId,
      name: typeof projectInfo.title === 'string' ? projectInfo.title : selected.name,
      versionNumber: selected.versionNumber,
      fileName,
      relativePath: `libs/modmind/${fileName}`,
      installedAt: new Date().toISOString(),
      environment: input.environment ?? (side(projectInfo.client_side) === 'unsupported' ? 'server' : side(projectInfo.server_side) === 'unsupported' ? 'client' : 'both'),
      source: 'modrinth',
      ...(file.hashes?.sha512 ? { sha512: file.hashes.sha512 } : {})
    }
    const dependencies = [dependency, ...manifest.dependencies.filter((entry) => entry.projectId !== projectId)]
    try {
      await fs.rm(target, { force: true })
      await fs.rename(temporary, target)
      await applyManagedDependencies(project, dependencies)
      await this.importRuntime(target)
    } catch (error) {
      await applyManagedDependencies(project, manifest.dependencies).catch(() => undefined)
      if (previousTarget) await atomicWriteFile(target, previousTarget)
      else await fs.rm(target, { force: true })
      await this.removeRuntime(fileName).catch(() => undefined)
      if (previous) await this.importRuntime(path.join(project.path, ...previous.relativePath.split('/'))).catch(() => undefined)
      throw error
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
    if (previous && previous.fileName !== fileName) {
      await fs.rm(path.join(project.path, ...previous.relativePath.split('/')), { force: true })
      await this.removeRuntime(previous.fileName).catch(() => undefined)
    }
    return dependency
  }

  async installMaven(input: MavenDependencyInput): Promise<ManagedDependency> {
    const project = this.javaProject()
    const coordinate = input.coordinate.trim()
    const match = coordinate.match(/^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+\-]+)$/)
    if (!match) throw new Error('Maven 坐标必须使用 group:artifact:version 格式')
    const repository = normalizedRepositoryUrl(input.repository)
    const allowedConfigurations = ['implementation', 'modImplementation', 'compileOnly', 'runtimeOnly'] as const
    const configuration = allowedConfigurations.includes(input.configuration as typeof allowedConfigurations[number])
      ? input.configuration
      : project.loader === 'fabric' || project.loader === 'quilt' ? 'modImplementation' : 'implementation'
    const id = `maven-${createHash('sha1').update(coordinate).digest('hex').slice(0, 16)}`
    const dependency: ManagedDependency = {
      projectId: id,
      versionId: coordinate,
      slug: match[2],
      name: `${match[1]}:${match[2]}`,
      versionNumber: match[3],
      fileName: '',
      relativePath: '',
      installedAt: new Date().toISOString(),
      environment: 'both',
      source: 'maven',
      coordinate,
      ...(repository ? { repository } : {}),
      configuration
    }
    const manifest = await readManifest(project)
    const dependencies = [dependency, ...manifest.dependencies.filter((entry) => entry.projectId !== id)]
    await applyManagedDependencies(project, dependencies)
    return dependency
  }

  async audit(): Promise<DependencyAuditResult> {
    const project = this.javaProject()
    const dependencies = (await readManifest(project)).dependencies
    const errors: string[] = []
    const warnings: string[] = []
    const ids = new Set<string>()
    const coordinates = new Set<string>()
    for (const dependency of dependencies) {
      if (ids.has(dependency.projectId)) errors.push(`重复依赖 ID：${dependency.projectId}`)
      ids.add(dependency.projectId)
      if (dependency.source === 'maven') {
        if (!dependency.coordinate) errors.push(`Maven 依赖缺少坐标：${dependency.name}`)
        else if (coordinates.has(dependency.coordinate)) errors.push(`重复 Maven 坐标：${dependency.coordinate}`)
        else coordinates.add(dependency.coordinate)
        continue
      }
      if (!dependency.relativePath) {
        errors.push(`Modrinth 依赖缺少锁定文件路径：${dependency.name}`)
        continue
      }
      const target = path.resolve(project.path, ...dependency.relativePath.split('/'))
      const relative = path.relative(project.path, target)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`依赖路径越界：${dependency.relativePath}`)
        continue
      }
      const bytes = await fs.readFile(target).catch(() => null)
      if (!bytes) {
        errors.push(`依赖文件缺失：${dependency.relativePath}`)
        continue
      }
      if (dependency.sha512) {
        const actual = createHash('sha512').update(bytes).digest('hex')
        if (actual !== dependency.sha512) errors.push(`依赖校验失败：${dependency.fileName}`)
      } else {
        warnings.push(`旧依赖没有 SHA-512 锁定值，建议重新安装：${dependency.name}`)
      }
    }
    return { success: !errors.length, checked: dependencies.length, errors, warnings }
  }

  async remove(projectId: string): Promise<ManagedDependency[]> {
    const project = this.javaProject()
    const id = safeSegment(projectId, '项目 ID')
    const manifest = await readManifest(project)
    const removed = manifest.dependencies.find((entry) => entry.projectId === id)
    const dependencies = manifest.dependencies.filter((entry) => entry.projectId !== id)
    if (!removed) return dependencies
    const target = removed.relativePath ? path.join(project.path, ...removed.relativePath.split('/')) : ''
    const previousTarget = target ? await fs.readFile(target).catch(() => null) : null
    try {
      await applyManagedDependencies(project, dependencies)
      if (target) await fs.rm(target, { force: true })
    } catch (error) {
      await applyManagedDependencies(project, manifest.dependencies).catch(() => undefined)
      if (target && previousTarget) await atomicWriteFile(target, previousTarget)
      throw error
    }
    if (removed.fileName) await this.removeRuntime(removed.fileName).catch(() => undefined)
    return dependencies
  }
}
