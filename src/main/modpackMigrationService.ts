import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  JavaLoaderKind,
  LoaderVersionOption,
  McmodSearchResult,
  ModpackContentItem,
  ModpackContentKind,
  ModpackMigrationAssessment,
  ModpackMigrationCandidate,
  ModpackMigrationContentAssessment,
  ModpackMigrationCreateInput,
  ModpackMigrationCreateResult,
  ModpackMigrationManualFile,
  ModpackMigrationModAssessment,
  ModpackMigrationProgress,
  ModpackMigrationStatus,
  ProjectInfo
} from '../shared/types'
import { compareMinecraftVersions } from './loaderCompatibility'
import { inspectModJar } from './jarInspection'
import { listModpackContent } from './modpackContentInventoryService'
import { readModpackLock } from './modpackLockService'
import { modpackModsRoot, modpackOverridesRoot } from './modpackPaths'
import { addModpackFiles, addModpackModule, createModpackTemplate, readModpackManifest, resolveModpackModuleRoot } from './modpackService'
import { applyModpackPlan, planModpack, type McmodQueryProvider } from './modpackPlanner'
import type { AutomaticModPlatform, ModCandidate, ModFile, ModProviderRegistry } from './modProviderService'
import { projectTemplateFiles } from './projectTemplates'
import { CURRENT_PROJECT_VERSION } from './projectVersion'
import { assertSeparateMigrationTrees } from './migrationPathSafety'

const DESCRIPTOR_PATHS = new Set([
  'main/resources/fabric.mod.json',
  'main/resources/quilt.mod.json',
  'main/resources/META-INF/mods.toml',
  'main/resources/META-INF/neoforge.mods.toml',
  'main/resources/mcmod.info'
])

function automaticProvider(value: string): value is AutomaticModPlatform {
  return value === 'modrinth' || value === 'curseforge'
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function candidateFromFile(file: ModFile, name: string, relation: ModpackMigrationCandidate['relation']): ModpackMigrationCandidate {
  return {
    provider: file.provider,
    projectId: file.projectId,
    versionId: file.versionId,
    versionName: file.versionName,
    fileName: file.filename,
    name,
    side: file.side,
    relation,
    confidence: relation === 'same-project' ? 'exact' : 'candidate'
  }
}

function selectedFile(files: ModFile[]): ModFile | undefined {
  return files.find((file) => file.primary) ?? files[0]
}

interface AlternativeSearchResult {
  candidates: ModpackMigrationCandidate[]
  mcmodMatches: McmodSearchResult[]
  viaMcmod: boolean
}

function mcmodAliases(matches: McmodSearchResult[]): string[] {
  const aliases = new Set<string>()
  for (const match of matches.slice(0, 5)) {
    const parenthetical = match.name.match(/\(([A-Za-z][A-Za-z0-9 ._':-]{1,100})\)/)?.[1]
    const chineseName = match.name.replace(/\s*\([^)]*\)\s*$/, '').trim()
    for (const value of [match.englishName, parenthetical, match.name, chineseName]) {
      const alias = value?.trim()
      if (alias) aliases.add(alias.slice(0, 120))
    }
  }
  return [...aliases].slice(0, 8)
}

async function mcmodMatchesFor(mcmod: McmodQueryProvider | undefined, queries: string[]): Promise<McmodSearchResult[]> {
  if (!mcmod) return []
  const matches = new Map<string, McmodSearchResult>()
  for (const query of [...new Set(queries.map((value) => value.trim()).filter(Boolean))].slice(0, 2)) {
    const results = await mcmod.search(query, 5).catch(() => [])
    for (const result of results) matches.set(result.projectId, result)
    if (matches.size >= 5) break
  }
  return [...matches.values()].slice(0, 5)
}

async function platformAlternativesForQueries(
  registry: ModProviderRegistry,
  queries: string[],
  target: LoaderVersionOption,
  excluded: Set<string>,
  relation: ModpackMigrationCandidate['relation']
): Promise<ModpackMigrationCandidate[]> {
  const uniqueQueries = [...new Set(queries.map((value) => value.trim().slice(0, 120)).filter(Boolean))].slice(0, 8)
  if (!uniqueQueries.length) return []
  const results = (await Promise.all(uniqueQueries.map((query) => registry.search({
    query,
    minecraftVersion: target.minecraftVersion,
    loader: target.loader as JavaLoaderKind,
    limit: 12
  }).catch(() => [])))).flat()
  const exactNames = new Set(uniqueQueries.map(normalizedName))
  const hits = results.flatMap((result) => result.hits)
    .filter((hit) => !excluded.has(`${hit.provider}:${hit.projectId}`))
    .sort((left, right) => {
      const leftExact = exactNames.has(normalizedName(left.name)) || exactNames.has(normalizedName(left.slug)) ? 1 : 0
      const rightExact = exactNames.has(normalizedName(right.name)) || exactNames.has(normalizedName(right.slug)) ? 1 : 0
      return rightExact - leftExact || right.downloads - left.downloads
    })
  const unique = new Map<string, ModCandidate>()
  for (const hit of hits) {
    const key = `${hit.provider}:${hit.projectId}`
    if (!unique.has(key)) unique.set(key, hit)
    if (unique.size >= 8) break
  }
  const candidates: ModpackMigrationCandidate[] = []
  for (const hit of unique.values()) {
    const files = await registry.versions(hit.provider, hit.projectId, {
      minecraftVersion: target.minecraftVersion,
      loader: target.loader as JavaLoaderKind
    }).catch(() => [])
    const file = selectedFile(files)
    if (file) candidates.push(candidateFromFile(file, hit.name, relation))
    if (candidates.length >= 3) break
  }
  return candidates
}

async function alternativesFor(
  registry: ModProviderRegistry,
  query: string,
  target: LoaderVersionOption,
  excluded: Set<string>,
  mcmod?: McmodQueryProvider,
  knownMcmodMatches: McmodSearchResult[] = []
): Promise<AlternativeSearchResult> {
  const direct = await platformAlternativesForQueries(registry, [query], target, excluded, 'search-candidate')
  if (direct.length) return { candidates: direct, mcmodMatches: knownMcmodMatches, viaMcmod: false }
  const mcmodMatches = knownMcmodMatches.length ? knownMcmodMatches : await mcmodMatchesFor(mcmod, [query])
  const candidates = await platformAlternativesForQueries(registry, mcmodAliases(mcmodMatches), target, excluded, 'mcmod-alias')
  return { candidates, mcmodMatches, viaMcmod: candidates.length > 0 }
}

async function assessKnownProject(
  registry: ModProviderRegistry,
  source: { provider: AutomaticModPlatform; projectId: string; name: string; sourceUrl?: string; license?: string },
  target: LoaderVersionOption,
  base: Omit<ModpackMigrationModAssessment, 'status' | 'reason' | 'compatible' | 'alternatives'>,
  mcmod?: McmodQueryProvider
): Promise<ModpackMigrationModAssessment> {
  const files = await registry.versions(source.provider, source.projectId, {
    minecraftVersion: target.minecraftVersion,
    loader: target.loader as JavaLoaderKind
  }).catch(() => [])
  const compatible = selectedFile(files)
  if (compatible) {
    return {
      ...base,
      status: 'compatible',
      reason: '同一平台项目提供目标版本文件',
      compatible: candidateFromFile(compatible, source.name, 'same-project'),
      alternatives: []
    }
  }
  const alternativeSearch = await alternativesFor(registry, source.name, target, new Set([`${source.provider}:${source.projectId}`]), mcmod)
  const alternatives = alternativeSearch.candidates
  return {
    ...base,
    ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
    ...(source.license ? { sourceLicense: source.license } : {}),
    ...(alternativeSearch.mcmodMatches.length ? { mcmodMatches: alternativeSearch.mcmodMatches } : {}),
    status: alternatives.length ? 'replacement' : source.sourceUrl ? 'source-port' : 'missing',
    reason: alternatives.length
      ? alternativeSearch.viaMcmod
        ? '官方项目没有目标构建；MC百科命中别名后，已优先在 Modrinth/CurseForge 找到目标版本候选'
        : '官方项目没有目标构建，已找到需要人工确认的候选平替'
      : source.sourceUrl
        ? '官方项目没有目标构建，但存在公开源码；可创建目标版本移植模块'
        : alternativeSearch.mcmodMatches.length
          ? 'MC百科找到了相关条目，但 Modrinth/CurseForge 没有可验证的目标版本文件'
          : '官方项目没有目标构建，也没有找到可验证的平替或公开源码',
    alternatives
  }
}

async function platformSourceMatch(
  registry: ModProviderRegistry,
  project: ProjectInfo,
  inspection: Awaited<ReturnType<typeof inspectModJar>>,
  queries: string[]
): Promise<{ candidate: ModCandidate; file: ModFile } | null> {
  const hits = new Map<string, ModCandidate>()
  for (const query of [...new Set(queries.map((value) => value.trim()).filter(Boolean))].slice(0, 8)) {
    const results = await registry.search({
      query,
      minecraftVersion: project.minecraftVersion,
      loader: project.loader as JavaLoaderKind,
      limit: 10
    }).catch(() => [])
    for (const hit of results.flatMap((result) => result.hits)) hits.set(`${hit.provider}:${hit.projectId}`, hit)
  }
  const expectedName = normalizedName(inspection.profile.displayName)
  const expectedId = normalizedName(inspection.profile.primaryModId)
  const matches: Array<{ score: number; candidate: ModCandidate; file: ModFile }> = []
  for (const hit of [...hits.values()].slice(0, 8)) {
    const files = await registry.versions(hit.provider, hit.projectId, {
      minecraftVersion: project.minecraftVersion,
      loader: project.loader as JavaLoaderKind
    }).catch(() => [])
    for (const file of files) {
      const filenameMatch = file.filename.toLowerCase() === inspection.fileName.toLowerCase()
      const versionMatch = inspection.profile.version !== 'unknown' && file.versionName === inspection.profile.version
      if (!filenameMatch && !versionMatch) continue
      const identityMatch = normalizedName(hit.name) === expectedName || normalizedName(hit.slug) === expectedName || normalizedName(hit.slug) === expectedId
      matches.push({ score: (filenameMatch ? 100 : 50) + (identityMatch ? 10 : 0), candidate: hit, file })
    }
  }
  matches.sort((left, right) => right.score - left.score || right.candidate.downloads - left.candidate.downloads)
  if (!matches[0] || (matches[1] && matches[1].score === matches[0].score)) return null
  return matches[0]
}

interface SourceProjectInference {
  match: { candidate: ModCandidate; file: ModFile } | null
  mcmodMatches: McmodSearchResult[]
  viaMcmod: boolean
}

async function inferSourceProject(
  registry: ModProviderRegistry,
  project: ProjectInfo,
  inspection: Awaited<ReturnType<typeof inspectModJar>>,
  mcmod?: McmodQueryProvider
): Promise<SourceProjectInference> {
  const directQueries = [inspection.profile.displayName, inspection.profile.primaryModId]
  const direct = await platformSourceMatch(registry, project, inspection, directQueries)
  if (direct) return { match: direct, mcmodMatches: [], viaMcmod: false }
  const mcmodMatches = await mcmodMatchesFor(mcmod, directQueries)
  const match = await platformSourceMatch(registry, project, inspection, mcmodAliases(mcmodMatches))
  return { match, mcmodMatches, viaMcmod: Boolean(match) }
}

async function assessMod(
  registry: ModProviderRegistry,
  project: ProjectInfo,
  target: LoaderVersionOption,
  filePath: string,
  mod: { fileName: string; sha256: string; size: number },
  locked: Awaited<ReturnType<typeof readModpackLock>>['mods'][number] | undefined,
  mcmod?: McmodQueryProvider
): Promise<ModpackMigrationModAssessment> {
  const id = locked ? `${locked.provider}:${locked.projectId}` : `file:${mod.sha256}`
  const lockedInspection = locked && automaticProvider(locked.provider)
    ? await inspectModJar(filePath, project.loader as JavaLoaderKind).catch(() => null)
    : null
  const lockedJarEvidence = lockedInspection ? {
    sha1: lockedInspection.sha1,
    sha512: lockedInspection.sha512,
    loader: lockedInspection.profile.loader as JavaLoaderKind,
    classCount: lockedInspection.profile.classCount,
    packages: lockedInspection.profile.packages,
    dependencies: lockedInspection.dependencies,
    warnings: lockedInspection.warnings
  } : undefined
  if (locked && automaticProvider(locked.provider)) {
    const details = await registry.details(locked.provider, locked.projectId).catch(() => null)
    const name = details?.name || mod.fileName
    return assessKnownProject(registry, {
      provider: locked.provider,
      projectId: locked.projectId,
      name,
      ...(details?.sourceUrl ? { sourceUrl: details.sourceUrl } : {}),
      ...(details?.license ? { license: details.license } : {})
    }, target, {
      id,
      sourceFileName: mod.fileName,
      sourceName: name,
      sourceVersion: locked.versionName,
      sourceSha256: mod.sha256,
      sourceSize: mod.size,
      ...(lockedJarEvidence ? { sourceJar: lockedJarEvidence } : {}),
      sourceProvider: locked.provider,
      sourceProjectId: locked.projectId,
      identityEvidence: 'lock'
    }, mcmod)
  }

  try {
    const inspection = await inspectModJar(filePath, project.loader as JavaLoaderKind)
    const sourceJar = {
      sha1: inspection.sha1,
      sha512: inspection.sha512,
      loader: inspection.profile.loader as JavaLoaderKind,
      classCount: inspection.profile.classCount,
      packages: inspection.profile.packages,
      dependencies: inspection.dependencies,
      warnings: inspection.warnings
    }
    const identified = await registry.identify(filePath, { sha1: inspection.sha1 }, {
      minecraftVersion: project.minecraftVersion,
      loader: project.loader as JavaLoaderKind
    })
    const exact = identified[0]
    if (exact) {
      return assessKnownProject(registry, {
        provider: exact.file.provider,
        projectId: exact.file.projectId,
        name: exact.candidate.name
      }, target, {
        id,
        sourceFileName: mod.fileName,
        sourceName: exact.candidate.name,
        sourceVersion: inspection.profile.version,
        sourceSha256: mod.sha256,
        sourceSize: mod.size,
        sourceJar,
        sourceProvider: exact.file.provider,
        sourceProjectId: exact.file.projectId,
        sourceModIds: inspection.profile.modIds,
        identityEvidence: 'hash'
      }, mcmod)
    }
    const inference = await inferSourceProject(registry, project, inspection, mcmod)
    const inferred = inference.match
    if (inferred) {
      const details = await registry.details(inferred.file.provider, inferred.file.projectId).catch(() => null)
      return assessKnownProject(registry, {
        provider: inferred.file.provider,
        projectId: inferred.file.projectId,
        name: inferred.candidate.name,
        ...(details?.sourceUrl ? { sourceUrl: details.sourceUrl } : {}),
        ...(details?.license ? { license: details.license } : {})
      }, target, {
        id,
        sourceFileName: mod.fileName,
        sourceName: inferred.candidate.name,
        sourceVersion: inspection.profile.version,
        sourceSha256: mod.sha256,
        sourceSize: mod.size,
        sourceJar,
        sourceProvider: inferred.file.provider,
        sourceProjectId: inferred.file.projectId,
        sourceModIds: inspection.profile.modIds,
        identityEvidence: inference.viaMcmod ? 'mcmod' : 'metadata',
        ...(inference.mcmodMatches.length ? { mcmodMatches: inference.mcmodMatches } : {})
      }, mcmod)
    }
    const alternativeSearch = await alternativesFor(registry, inspection.profile.displayName, target, new Set(), mcmod, inference.mcmodMatches)
    const alternatives = alternativeSearch.candidates
    return {
      id,
      sourceFileName: mod.fileName,
      sourceName: inspection.profile.displayName,
      sourceVersion: inspection.profile.version,
      sourceSha256: mod.sha256,
      sourceSize: mod.size,
      sourceJar,
      ...(locked ? { sourceProvider: locked.provider } : {}),
      sourceModIds: inspection.profile.modIds,
      identityEvidence: 'unknown',
      ...(alternativeSearch.mcmodMatches.length ? { mcmodMatches: alternativeSearch.mcmodMatches } : {}),
      status: alternatives.length ? 'replacement' : 'unknown',
      reason: alternatives.length
        ? alternativeSearch.viaMcmod
          ? 'MC百科命中别名后，已优先在 Modrinth/CurseForge 找到目标版本候选；采用前必须人工核对'
          : '无法确认平台身份，已按名称找到候选；采用前必须人工核对'
        : alternativeSearch.mcmodMatches.length
          ? 'MC百科找到了相关条目，但 Modrinth/CurseForge 没有可验证的目标文件；需手工导入、源码移植或移除'
          : '无法确认平台身份或目标版本，需手工导入、源码移植或移除',
      alternatives
    }
  } catch (error) {
    const filenameQuery = mod.fileName.replace(/\.jar$/i, '').replace(/[-_]+/g, ' ').trim()
    const alternativeSearch = await alternativesFor(registry, filenameQuery, target, new Set(), mcmod)
    return {
      id,
      sourceFileName: mod.fileName,
      sourceName: mod.fileName,
      sourceVersion: locked?.versionName ?? 'unknown',
      sourceSha256: mod.sha256,
      sourceSize: mod.size,
      ...(locked ? { sourceProvider: locked.provider } : {}),
      identityEvidence: 'unknown',
      ...(alternativeSearch.mcmodMatches.length ? { mcmodMatches: alternativeSearch.mcmodMatches } : {}),
      status: alternativeSearch.candidates.length ? 'replacement' : 'unknown',
      reason: alternativeSearch.candidates.length
        ? `无法分析 JAR，但已${alternativeSearch.viaMcmod ? '通过 MC百科别名' : '按文件名'}在 Modrinth/CurseForge 找到候选；采用前必须人工核对`
        : `无法分析 JAR：${error instanceof Error ? error.message : String(error)}`,
      alternatives: alternativeSearch.candidates
    }
  }
}

async function mapLimit<T, R>(values: T[], limit: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      output[index] = await action(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return output
}

function contentAssessment(kind: ModpackContentKind, items: ModpackContentItem[], downgrade: boolean): ModpackMigrationContentAssessment {
  const sensitive = new Set<ModpackContentKind>(['config', 'scripts', 'datapacks', 'quests', 'resourcepacks', 'ui', 'worlds', 'server'])
  const blocked = kind === 'worlds' && downgrade
  return {
    kind,
    count: items.length,
    paths: items.map((item) => item.path).slice(0, 8),
    status: blocked ? 'blocked' : sensitive.has(kind) ? 'review' : 'compatible',
    reason: blocked
      ? '世界降级不可逆，默认不复制；只能在副本上人工验证'
      : sensitive.has(kind)
        ? '会复制到目标包，但格式、注册 ID 和配置键仍需启动后验证'
        : '可作为普通覆盖内容复制，仍会保留在迁移报告中',
    copyByDefault: !blocked
  }
}

export async function assessModpackMigration(
  registry: ModProviderRegistry,
  project: ProjectInfo,
  target: LoaderVersionOption,
  onProgress?: (progress: ModpackMigrationProgress) => void,
  mcmod?: McmodQueryProvider
): Promise<ModpackMigrationAssessment> {
  if (project.kind !== 'modpack') throw new Error('只有整合包项目可以执行整合包迁移评估')
  if (project.loader === target.loader && project.minecraftVersion === target.minecraftVersion) throw new Error('目标版本与当前整合包相同')
  onProgress?.({ phase: 'inventory', completed: 0, total: 1, message: '正在读取整合包清单和锁定记录' })
  const [manifest, lock, inventory] = await Promise.all([
    readModpackManifest(project),
    readModpackLock(project),
    listModpackContent(project, true)
  ])
  const lockedByName = new Map(lock.mods.map((entry) => [entry.fileName.toLowerCase(), entry]))
  const root = modpackModsRoot(project, manifest)
  let completed = 0
  onProgress?.({ phase: 'identifying', completed, total: manifest.mods.length, message: `正在识别 0 / ${manifest.mods.length} 个 Mod${mcmod ? '（Modrinth / CurseForge / MC百科）' : ''}` })
  const mods = await mapLimit(manifest.mods, 4, async (mod) => {
    const result = await assessMod(
      registry,
      project,
      target,
      path.join(root, mod.fileName),
      mod,
      lockedByName.get(mod.fileName.toLowerCase()),
      mcmod
    )
    completed += 1
    onProgress?.({ phase: 'identifying', completed, total: manifest.mods.length, message: `已识别 ${completed} / ${manifest.mods.length}：${result.sourceName}` })
    return result
  })
  const direction = project.loader !== target.loader
    ? 'loader-change'
    : compareMinecraftVersions(target.minecraftVersion, project.minecraftVersion) < 0 ? 'downgrade' : 'upgrade'
  const grouped = new Map<ModpackContentKind, ModpackContentItem[]>()
  onProgress?.({ phase: 'content', completed: 0, total: inventory.items.length, message: '正在汇总配置、脚本、资源和世界内容' })
  for (const item of inventory.items) grouped.set(item.kind, [...(grouped.get(item.kind) ?? []), item])
  const content = [...grouped.entries()].map(([kind, items]) => contentAssessment(kind, items, direction === 'downgrade'))
  const summary = { compatible: 0, replacement: 0, 'source-port': manifest.modules.length, missing: 0, unknown: 0 } satisfies Record<ModpackMigrationStatus, number>
  for (const mod of mods) summary[mod.status] += 1
  const warnings = [
    ...(direction === 'downgrade' ? ['向下迁移不会自动转换世界；世界内容默认排除'] : []),
    ...(direction === 'loader-change' ? ['跨 Loader 迁移会改变事件、注册、网络和配置 API；候选平替必须人工确认'] : []),
    ...(mods.some((mod) => mod.status === 'unknown') ? ['存在无法确认平台身份的本地或私有 JAR'] : [])
  ]
  const result: ModpackMigrationAssessment = {
    source: { loader: project.loader, minecraftVersion: project.minecraftVersion, loaderVersion: project.loaderVersion },
    target,
    direction,
    mods,
    modules: manifest.modules.map((module) => ({
      id: module.namespace,
      name: module.name,
      namespace: module.namespace,
      path: module.path,
      status: 'source-port',
      reason: '将创建目标版本模块工程并保留源码；API 修复和重新构建仍需继续完成'
    })),
    content,
    summary,
    warnings
  }
  onProgress?.({ phase: 'complete', completed: manifest.mods.length, total: manifest.mods.length, message: '目标版本扫描完成' })
  return result
}

export async function inspectModpackMigrationJar(filePath: string, targetLoader: JavaLoaderKind): Promise<ModpackMigrationManualFile> {
  const inspection = await inspectModJar(filePath, targetLoader)
  if (inspection.profile.loader !== targetLoader) throw new Error(`所选 JAR 使用 ${inspection.profile.loader}，目标整合包使用 ${targetLoader}`)
  return {
    filePath: inspection.filePath,
    fileName: inspection.fileName,
    displayName: inspection.profile.displayName,
    version: inspection.profile.version,
    loader: inspection.profile.loader,
    modIds: inspection.profile.modIds,
    sha256: inspection.sha256,
    warnings: inspection.warnings
  }
}

function inside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function copyTree(source: string, destination: string, relative = '', skip: ReadonlySet<string> = new Set()): Promise<void> {
  if (!relative) assertSeparateMigrationTrees(source, destination)
  const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => [])
  await fs.mkdir(destination, { recursive: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    if (skip.has(childRelative)) continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to, childRelative, skip)
    else if (entry.isFile()) {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(from, to)
    }
  }
}

function minimalContentRoots(items: ModpackContentItem[]): ModpackContentItem[] {
  const ordered = [...items].sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path))
  const roots: ModpackContentItem[] = []
  for (const item of ordered) {
    if (roots.some((root) => root.directory && (item.path === root.path || item.path.startsWith(`${root.path}/`)))) continue
    roots.push(item)
  }
  return roots
}

async function writeTemplate(project: ProjectInfo): Promise<void> {
  for (const [relative, content] of Object.entries(projectTemplateFiles(project, true))) {
    const target = path.join(project.path, ...relative.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

function sameCandidate(left: ModpackMigrationCandidate, right: ModpackMigrationCandidate): boolean {
  return left.provider === right.provider && left.projectId === right.projectId && left.versionId === right.versionId
}

export async function createModpackMigration(
  registry: ModProviderRegistry,
  source: ProjectInfo,
  target: LoaderVersionOption,
  input: ModpackMigrationCreateInput,
  destination: string,
  installWrapper: (projectRoot: string) => Promise<void>,
  mcmod?: McmodQueryProvider
): Promise<ModpackMigrationCreateResult> {
  if (input.loader !== target.loader || input.minecraftVersion !== target.minecraftVersion) throw new Error('迁移方案与目标版本不一致')
  assertSeparateMigrationTrees(source.path, destination)
  const assessment = await assessModpackMigration(registry, source, target, undefined, mcmod)
  const decisionById = new Map(input.mods.map((decision) => [decision.modId, decision]))
  if (decisionById.size !== input.mods.length) throw new Error('迁移方案包含重复的 Mod 决策')
  const moduleDecisionById = new Map(input.modules.map((decision) => [decision.moduleId, decision]))
  if (moduleDecisionById.size !== assessment.modules.length || assessment.modules.some((module) => !moduleDecisionById.has(module.id))) {
    throw new Error('每个自制模块都必须选择保留源码或从目标包移除')
  }
  const contentDecisionByKind = new Map(input.content.map((decision) => [decision.kind, decision.action]))
  if (assessment.content.some((entry) => !contentDecisionByKind.has(entry.kind))) throw new Error('每类魔改内容都必须选择复制或排除')

  const providerSelections: ModpackMigrationCandidate[] = []
  const manualPaths: string[] = []
  const compatibilityModules: ModpackMigrationModAssessment[] = []
  const removed: string[] = []
  const deferred: string[] = []
  for (const mod of assessment.mods) {
    const decision = decisionById.get(mod.id) ?? { modId: mod.id, action: 'defer' as const }
    if (decision.action === 'defer') { deferred.push(mod.sourceFileName); continue }
    if (decision.action === 'remove') { removed.push(mod.sourceFileName); continue }
    if (decision.action === 'manual-file') {
      await inspectModpackMigrationJar(decision.filePath, target.loader as JavaLoaderKind)
      manualPaths.push(decision.filePath)
      continue
    }
    if (decision.action === 'create-compat-module') {
      compatibilityModules.push(mod)
      continue
    }
    const allowed = decision.action === 'use-compatible'
      ? Boolean(mod.compatible && sameCandidate(mod.compatible, decision.candidate))
      : mod.alternatives.some((candidate) => sameCandidate(candidate, decision.candidate))
    if (!allowed) throw new Error(`${mod.sourceName} 的平台候选已经变化，请重新扫描目标版本`)
    const currentFiles = await registry.versions(decision.candidate.provider, decision.candidate.projectId, {
      minecraftVersion: target.minecraftVersion,
      loader: target.loader as JavaLoaderKind
    })
    if (!currentFiles.some((file) => file.versionId === decision.candidate.versionId)) throw new Error(`${mod.sourceName} 选中的目标文件已经不可用`)
    providerSelections.push(decision.candidate)
  }

  const root = path.resolve(destination)
  if (await fs.stat(root).then(() => true).catch(() => false)) throw new Error(`迁移目标已经存在：${root}`)
  const targetProject: ProjectInfo = {
    kind: 'modpack',
    name: source.name,
    path: root,
    loader: target.loader,
    minecraftVersion: target.minecraftVersion,
    loaderVersion: target.loaderVersion,
    apiVersion: target.apiVersion,
    qslVersion: target.qslVersion,
    javaVersion: target.javaVersion,
    namespace: source.namespace,
    createdAt: new Date().toISOString(),
    projectVersion: CURRENT_PROJECT_VERSION,
    toolDataDirectory: '.modmind'
  }
  const warnings = [...assessment.warnings]
  const installed: string[] = []
  const manualFiles: string[] = []
  const copiedContent: string[] = []
  const portedModules: string[] = []
  await fs.mkdir(root, { recursive: true })
  try {
    await createModpackTemplate(targetProject)
    await fs.writeFile(path.join(root, 'modmind.project.json'), `${JSON.stringify(targetProject, null, 2)}\n`, 'utf8')
    await fs.mkdir(path.join(root, '.modmind'), { recursive: true })

    const uniqueSelections = new Map(providerSelections.map((candidate) => [`${candidate.provider}:${candidate.projectId}`, candidate]))
    if (uniqueSelections.size) {
      const plan = await planModpack(registry, targetProject, {
        required: [],
        requiredProjects: [...uniqueSelections.values()].map((candidate) => ({
          provider: candidate.provider,
          projectId: candidate.projectId,
          versionId: candidate.versionId,
          name: candidate.name
        }))
      })
      if (!plan.success) throw new Error(`目标依赖无法闭合：${[...plan.conflicts, ...plan.warnings].join('；')}`)
      const applied = await applyModpackPlan(registry, targetProject, plan)
      installed.push(...applied.installed)
    }

    if (manualPaths.length) {
      const names = manualPaths.map((file) => path.basename(file).toLowerCase())
      if (new Set(names).size !== names.length) throw new Error('手工导入的目标 JAR 存在重复文件名')
      const installedNames = new Set(installed.map((file) => file.toLowerCase()))
      const collision = names.find((name) => installedNames.has(name))
      if (collision) throw new Error(`手工导入文件与平台文件重名：${collision}`)
      await addModpackFiles(targetProject, manualPaths)
      manualFiles.push(...manualPaths.map((file) => path.basename(file)))
      warnings.push(`${manualFiles.length} 个手工 JAR 没有平台锁定记录，必须通过启动测试验证`)
    }

    const inventory = await listModpackContent(source, true)
    const sourceOverrides = modpackOverridesRoot(source, await readModpackManifest(source))
    const selectedContent = minimalContentRoots(inventory.items.filter((item) => contentDecisionByKind.get(item.kind) === 'copy'))
    for (const item of selectedContent) {
      const from = path.resolve(sourceOverrides, ...item.path.split('/'))
      const to = path.resolve(root, 'overrides', ...item.path.split('/'))
      if (!inside(sourceOverrides, from) || !inside(path.join(root, 'overrides'), to)) throw new Error(`魔改内容路径无效：${item.path}`)
      const stat = await fs.stat(from).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) await copyTree(from, to)
      else if (stat.isFile()) {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.copyFile(from, to)
      }
      copiedContent.push(item.path)
    }

    const sourceManifest = await readModpackManifest(source)
    const reservedNamespaces = new Set(sourceManifest.modules.map((module) => module.namespace))
    for (const mod of compatibilityModules) {
      const base = (mod.sourceModIds?.[0] || mod.sourceProjectId || mod.sourceName)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 42) || 'missing_mod'
      let namespace = `compat_${base}`.slice(0, 64)
      let suffix = 2
      while (reservedNamespaces.has(namespace)) {
        namespace = `compat_${base.slice(0, 54)}_${suffix}`.slice(0, 64)
        suffix += 1
      }
      reservedNamespaces.add(namespace)
      const moduleRoot = path.join(root, 'modules', namespace)
      const moduleProject: ProjectInfo = {
        ...targetProject,
        kind: 'mod',
        name: `${mod.sourceName} Compatibility`,
        namespace,
        path: moduleRoot,
        createdAt: new Date().toISOString()
      }
      await writeTemplate(moduleProject)
      await installWrapper(moduleRoot)
      const specification = [
        '# Compatibility module specification',
        '',
        `- Replaces source file: ${mod.sourceFileName}`,
        `- Source project: ${mod.sourceProvider ?? 'unknown'}:${mod.sourceProjectId ?? 'unknown'}`,
        `- Source version: ${mod.sourceVersion}`,
        `- Source Mod IDs: ${mod.sourceModIds?.join(', ') || 'unknown'}`,
        `- Target: ${target.loader} ${target.minecraftVersion}`,
        `- Source repository: ${mod.sourceUrl ?? 'not found'}`,
        `- Declared license: ${mod.sourceLicense ?? 'unknown; review before using source code or assets'}`,
        '',
        '## Required work',
        '',
        '- Review the source license and preserve all required notices before importing code.',
        '- Implement only behavior required by this pack; do not copy closed-source code or assets.',
        '- Decide whether legacy registry IDs need placeholders or data conversion.',
        '- Repair scripts, recipes, quests, configs, and saved data that reference the old Mod IDs.',
        '- Build and pass client, dedicated-server, and client-join verification.'
      ]
      const specificationPath = path.join(moduleRoot, 'docs', 'compatibility-spec.md')
      await fs.mkdir(path.dirname(specificationPath), { recursive: true })
      await fs.writeFile(specificationPath, `${specification.join('\n')}\n`, 'utf8')
      await addModpackModule(targetProject, {
        name: moduleProject.name,
        namespace,
        path: `modules/${namespace}`,
        createdAt: moduleProject.createdAt,
        side: 'both'
      })
      portedModules.push(moduleProject.name)
    }
    for (const module of sourceManifest.modules) {
      if (moduleDecisionById.get(module.namespace)?.action === 'remove') continue
      const sourceRoot = resolveModpackModuleRoot(source, module)
      const moduleRoot = path.join(root, 'modules', module.namespace)
      const moduleProject: ProjectInfo = {
        ...targetProject,
        kind: 'mod',
        name: module.name,
        namespace: module.namespace,
        path: moduleRoot,
        createdAt: new Date().toISOString()
      }
      await writeTemplate(moduleProject)
      await installWrapper(moduleRoot)
      const sourceCode = path.join(sourceRoot, 'src')
      if (await fs.stat(sourceCode).then((stat) => stat.isDirectory()).catch(() => false)) {
        await copyTree(sourceCode, path.join(moduleRoot, 'src'), '', DESCRIPTOR_PATHS)
      }
      await addModpackModule(targetProject, {
        name: module.name,
        namespace: module.namespace,
        path: `modules/${module.namespace}`,
        createdAt: moduleProject.createdAt,
        side: module.side ?? 'both'
      })
      portedModules.push(module.name)
    }
    if (portedModules.length) warnings.push(`${portedModules.length} 个自制模块已生成目标工程并保留源码，但仍需修复 API 后重新构建`)

    const evidenceRoot = path.join(root, 'docs', 'migration-evidence', 'mods')
    await fs.mkdir(evidenceRoot, { recursive: true })
    for (const mod of assessment.mods) {
      const decision = decisionById.get(mod.id) ?? { modId: mod.id, action: 'defer' as const }
      const safeId = mod.id.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) || mod.sourceSha256.slice(0, 16)
      await fs.writeFile(path.join(evidenceRoot, `${safeId}.json`), `${JSON.stringify({
        source: {
          fileName: mod.sourceFileName,
          displayName: mod.sourceName,
          version: mod.sourceVersion,
          sha256: mod.sourceSha256,
          size: mod.sourceSize,
          jar: mod.sourceJar,
          provider: mod.sourceProvider,
          projectId: mod.sourceProjectId,
          modIds: mod.sourceModIds,
          sourceUrl: mod.sourceUrl,
          sourceLicense: mod.sourceLicense,
          identityEvidence: mod.identityEvidence
        },
        assessment: { status: mod.status, reason: mod.reason, compatible: mod.compatible, alternatives: mod.alternatives, mcmodMatches: mod.mcmodMatches },
        decision
      }, null, 2)}\n`, 'utf8')
    }

    if (deferred.length) warnings.push(`${deferred.length} 个源 Mod 已暂缓处理；它们未进入目标运行时，详细证据保存在 docs/migration-evidence`)
    const reportLines = [
      '# ModMind modpack migration report',
      '',
      `- Source: ${source.loader} ${source.minecraftVersion}`,
      `- Target: ${target.loader} ${target.minecraftVersion}`,
      `- Generated: ${new Date().toISOString()}`,
      '',
      '## Result',
      '',
      `- Platform files installed: ${installed.length}`,
      `- Manual files imported: ${manualFiles.length}`,
      `- Source mods removed: ${removed.length}`,
      `- Source mods deferred: ${deferred.length}`,
      `- Source modules scaffolded: ${portedModules.length}`,
      `- Content roots copied: ${copiedContent.length}`,
      '',
      '## Removed source mods',
      '',
      ...(removed.length ? removed.map((name) => `- ${name}`) : ['- None']),
      '',
      '## Deferred source mods',
      '',
      ...(deferred.length ? deferred.map((name) => `- ${name}`) : ['- None']),
      '',
      '## Verification required',
      '',
      '- Review every replacement selected by the user.',
      '- Build every source module and repair target API errors.',
      '- Run lock audit, client launch, dedicated server launch, and client join verification.',
      '- Open worlds only from a disposable copy.',
      '',
      '## Warnings',
      '',
      ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ['- None'])
    ]
    const reportPath = path.join(root, 'docs', 'modpack-migration-report.md')
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, `${reportLines.join('\n')}\n`, 'utf8')
    const needsFurtherWork = deferred.length > 0
      || portedModules.length > 0
      || manualFiles.length > 0
      || input.mods.some((decision) => decision.action === 'use-replacement')
      || assessment.content.some((entry) => entry.status !== 'compatible' && contentDecisionByKind.get(entry.kind) === 'copy')
    return {
      project: targetProject,
      migrationId: '',
      mode: input.mode ?? 'backup',
      status: needsFurtherWork ? 'incomplete' : 'complete',
      canUndo: false,
      reportPath,
      installed,
      manualFiles,
      removed,
      deferred,
      portedModules,
      copiedContent,
      warnings
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
