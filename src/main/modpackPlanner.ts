import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { McmodManualRequirement, McmodSearchResult } from '../shared/types'
import { addModpackFiles, readModpackManifest, writeModpackManifest } from './modpackService'
import { modpackModsRoot } from './modpackPaths'
import { auditModpackLock, lockedModFromFile, MODPACK_LOCK_FILE, readModpackLock, writeModpackLock, type ModpackLock } from './modpackLockService'
import { safeModJarFileName } from './modpackFilename'
import { withProjectMutation } from './projectMutation'
import { candidateRuntimeSide, type AutomaticModPlatform, type ModCandidate, type ModDependency, type ModDependencyKind, type ModFile, type ModProviderRegistry } from './modProviderService'

export interface ModpackConcept {
  required: string[]
  optional?: string[]
  excluded?: string[]
  providers?: AutomaticModPlatform[]
  maxMods?: number
  strictMatch?: boolean
  requiredProjects?: Array<{ provider: AutomaticModPlatform; projectId: string; versionId?: string; name?: string }>
  optionalProjects?: Array<{ provider: AutomaticModPlatform; projectId: string; versionId?: string; name?: string }>
}

export interface PlannedMod {
  request: string
  parent?: string
  dependencyKind?: ModDependencyKind
  blocking?: boolean
  candidate?: ModCandidate
  versions?: ModFile[]
  selected?: ModFile
  reason?: string
}

export interface ModpackDependencyEdge {
  from: string
  to: string
  kind: ModDependencyKind
  resolved: boolean
}

export interface ModpackPlan {
  success: boolean
  project: Pick<ProjectInfo, 'minecraftVersion' | 'loader'>
  required: PlannedMod[]
  optional: PlannedMod[]
  dependencies?: PlannedMod[]
  dependencyEdges?: ModpackDependencyEdge[]
  conflicts: string[]
  warnings: string[]
  manualRequired?: McmodManualRequirement[]
  review?: {
    requiresApproval: boolean
    installCount: number
    providers: AutomaticModPlatform[]
    unresolved: number
    optionalSuggestions?: number
    manualRequired?: number
  }
}

export interface McmodQueryProvider {
  search(query: string, limit?: number, signal?: AbortSignal): Promise<McmodSearchResult[]>
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim()
}

function candidateScore(candidate: ModCandidate, request: string): number {
  const query = normalizeSearchText(request)
  const name = normalizeSearchText(candidate.name)
  const slug = normalizeSearchText(candidate.slug)
  const exact = name === query || slug === query ? 1_000_000 : 0
  const prefix = name.startsWith(query) || slug.startsWith(query) ? 100_000 : 0
  const tokenMatches = query.split(/\s+/).filter(Boolean).filter((token) => name.includes(token) || slug.includes(token)).length * 1_000
  return exact + prefix + tokenMatches + Math.log10(Math.max(1, candidate.downloads))
}

function chooseCandidate(hits: ModCandidate[], request: string, excluded: Set<string>): ModCandidate | undefined {
  return hits
    .filter((hit) => !excluded.has(hit.slug.toLowerCase()) && !excluded.has(hit.name.toLowerCase()))
    .sort((left, right) => candidateScore(right, request) - candidateScore(left, request) || right.downloads - left.downloads || left.name.localeCompare(right.name))[0]
}

function exactCandidate(candidate: ModCandidate, request: string): boolean {
  const query = normalizeSearchText(request)
  return normalizeSearchText(candidate.name) === query || normalizeSearchText(candidate.slug) === query
}

interface ResolveEntryOptions {
  request: string
  projectId?: string
  provider?: AutomaticModPlatform
  versionId?: string
  parent?: string
  dependencyKind?: ModDependencyKind
  blocking?: boolean
  strictMatch?: boolean
}

function placeholderCandidate(provider: AutomaticModPlatform, projectId: string, request: string): ModCandidate {
  return { provider, projectId, slug: projectId, name: request || projectId, summary: 'Resolved as a transitive dependency', projectUrl: '', clientSide: 'unknown', serverSide: 'unknown', downloads: 0 }
}

async function planEntry(registry: ModProviderRegistry, options: ResolveEntryOptions, project: ProjectInfo, excluded: Set<string>, providers?: AutomaticModPlatform[]): Promise<PlannedMod> {
  const { request, projectId, provider, versionId, parent, dependencyKind, blocking, strictMatch } = options
  try {
    let candidate: ModCandidate | undefined
    if (projectId && provider) candidate = placeholderCandidate(provider, projectId, request)
    else {
      const results = await registry.search({ query: request, minecraftVersion: project.minecraftVersion, loader: project.loader as 'fabric' | 'quilt' | 'forge' | 'neoforge', limit: 20 }, providers)
      candidate = chooseCandidate(results.flatMap((result) => result.hits), request, excluded)
      if (!candidate) {
        const providerErrors = results.map((result) => result.error).filter(Boolean)
        return { request, ...(parent ? { parent } : {}), ...(dependencyKind ? { dependencyKind } : {}), ...(blocking !== undefined ? { blocking } : {}), reason: providerErrors.length ? providerErrors.join('; ') : 'no compatible provider result' }
      }
      if (strictMatch && !exactCandidate(candidate, request)) {
        return { request, ...(parent ? { parent } : {}), ...(dependencyKind ? { dependencyKind } : {}), ...(blocking !== undefined ? { blocking } : {}), reason: `没有找到名称或短名称与“${request}”完全一致的平台模组` }
      }
    }
    const versions = await registry.versions(candidate.provider, candidate.projectId, { minecraftVersion: project.minecraftVersion, loader: project.loader as 'fabric' | 'quilt' | 'forge' | 'neoforge' })
    const selected = versionId ? versions.find((version) => version.versionId === versionId) : versions.find((version) => version.primary) ?? versions[0]
    if (!selected) return { request, ...(parent ? { parent } : {}), ...(dependencyKind ? { dependencyKind } : {}), ...(blocking !== undefined ? { blocking } : {}), candidate, versions, reason: versionId ? `required version ${versionId} is not compatible` : 'compatible project has no downloadable JAR' }
    return { request, ...(parent ? { parent } : {}), ...(dependencyKind ? { dependencyKind } : {}), ...(blocking !== undefined ? { blocking } : {}), candidate, versions, selected: selected.side === 'unknown' ? { ...selected, side: candidateRuntimeSide(candidate) } : selected }
  } catch (error) {
    return { request, ...(parent ? { parent } : {}), ...(dependencyKind ? { dependencyKind } : {}), ...(blocking !== undefined ? { blocking } : {}), reason: error instanceof Error ? error.message : String(error) }
  }
}

function dependencyKey(dependency: Pick<ModDependency, 'provider' | 'projectId'>): string {
  return `${dependency.provider}:${dependency.projectId}`
}

function entryKey(entry: PlannedMod): string | null {
  return entry.selected && entry.candidate ? `${entry.selected.provider}:${entry.selected.projectId}` : null
}

function selectedDependencies(entry: PlannedMod): ModDependency[] {
  return entry.selected?.dependencies ?? []
}

function allPlanEntries(plan: Pick<ModpackPlan, 'required' | 'optional' | 'dependencies'>): PlannedMod[] {
  return [...plan.required, ...plan.optional, ...(plan.dependencies ?? [])]
}

export async function planMods(registry: ModProviderRegistry, project: ProjectInfo, concept: ModpackConcept, mcmod?: McmodQueryProvider, signal?: AbortSignal): Promise<ModpackPlan> {
  const maxMods = Math.max(1, Math.min(concept.maxMods ?? 200, 500))
  const required = [...new Set((concept.required ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, maxMods)
  const optional = [...new Set((concept.optional ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, Math.max(0, maxMods - required.length))
  const excluded = new Set((concept.excluded ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))
  const requiredPlan: PlannedMod[] = []
  const optionalPlan: PlannedMod[] = []
  const dependencyPlan: PlannedMod[] = []
  const dependencyEdges: ModpackDependencyEdge[] = []
  const optionalDependencyWarnings: string[] = []
  for (const request of required) requiredPlan.push(await planEntry(registry, { request, blocking: true, strictMatch: concept.strictMatch }, project, excluded, concept.providers))
  for (const request of optional) optionalPlan.push(await planEntry(registry, { request, blocking: false, strictMatch: concept.strictMatch }, project, excluded, concept.providers))
  for (const selected of concept.requiredProjects ?? []) {
    requiredPlan.push(await planEntry(registry, { request: selected.name || selected.projectId, projectId: selected.projectId, provider: selected.provider, versionId: selected.versionId, blocking: true }, project, excluded, concept.providers))
  }
  for (const selected of concept.optionalProjects ?? []) {
    optionalPlan.push(await planEntry(registry, { request: selected.name || selected.projectId, projectId: selected.projectId, provider: selected.provider, versionId: selected.versionId, blocking: false }, project, excluded, concept.providers))
  }

  const selected = [...requiredPlan, ...optionalPlan].filter((entry) => entry.selected)
  const seen = new Map<string, string>()
  const selectedVersionIds = new Map<string, string>()
  const conflicts: string[] = []
  for (const entry of selected) {
    const key = entryKey(entry)!
    const previous = seen.get(key)
    if (previous) conflicts.push(`duplicate request ${previous} and ${entry.request} resolved to ${key}`)
    seen.set(key, entry.request)
    selectedVersionIds.set(key, entry.selected!.versionId)
  }

  const pending: Array<{ dependency: ModDependency; parent: PlannedMod; blocking: boolean }> = []
  for (const entry of selected) {
    for (const dependency of selectedDependencies(entry)) {
      const edge = { from: entry.request, to: dependencyKey(dependency), kind: dependency.kind, resolved: dependency.kind === 'embedded' }
      dependencyEdges.push(edge)
      if (dependency.kind === 'required') pending.push({ dependency, parent: entry, blocking: entry.blocking !== false })
      else if (dependency.kind === 'optional') optionalDependencyWarnings.push(`${entry.request} optionally supports ${dependencyKey(dependency)}`)
      else if (dependency.kind === 'incompatible' && seen.has(dependencyKey(dependency))) conflicts.push(`${entry.request} is incompatible with ${dependencyKey(dependency)}`)
    }
  }

  const visited = new Set<string>()
  while (pending.length && dependencyPlan.length < maxMods) {
    const next = pending.shift()!
    const key = dependencyKey(next.dependency)
    if (visited.has(key)) {
      const selectedVersion = selectedVersionIds.get(key)
      if (next.dependency.versionId && selectedVersion && selectedVersion !== next.dependency.versionId) conflicts.push(`${next.parent.request} requires ${key}@${next.dependency.versionId}, but ${selectedVersion} is already selected`)
      continue
    }
    visited.add(key)
    if (seen.has(key)) {
      const selectedVersion = selectedVersionIds.get(key)
      if (next.dependency.versionId && selectedVersion && selectedVersion !== next.dependency.versionId) conflicts.push(`${next.parent.request} requires ${key}@${next.dependency.versionId}, but ${selectedVersion} is already selected`)
      dependencyEdges.filter((edge) => edge.from === next.parent.request && edge.to === key).forEach((edge) => { edge.resolved = true })
      continue
    }
    const entry = await planEntry(registry, { request: next.dependency.fileName || next.dependency.projectId, projectId: next.dependency.projectId, provider: next.dependency.provider, versionId: next.dependency.versionId, parent: next.parent.request, dependencyKind: next.dependency.kind, blocking: next.blocking }, project, excluded, concept.providers)
    dependencyPlan.push(entry)
    const edge = dependencyEdges.find((candidate) => candidate.from === next.parent.request && candidate.to === key && candidate.kind === next.dependency.kind)
    if (entry.selected) {
      seen.set(key, entry.request)
      selectedVersionIds.set(key, entry.selected.versionId)
      if (edge) edge.resolved = true
      for (const dependency of selectedDependencies(entry)) {
        const childKey = dependencyKey(dependency)
        dependencyEdges.push({ from: entry.request, to: childKey, kind: dependency.kind, resolved: dependency.kind === 'embedded' })
        if (dependency.kind === 'required') pending.push({ dependency, parent: entry, blocking: next.blocking })
        else if (dependency.kind === 'incompatible' && seen.has(childKey)) conflicts.push(`${entry.request} is incompatible with ${childKey}`)
      }
    }
  }
  if (pending.length) conflicts.push(`dependency resolution exceeded the ${maxMods} mod limit`)

  const unresolvedEntries = [...requiredPlan, ...optionalPlan, ...dependencyPlan].filter((entry) => !entry.selected)
  const manualRequired: McmodManualRequirement[] = []
  const mcmodDiagnostics: string[] = []
  if (mcmod) {
    for (const entry of unresolvedEntries) {
      try {
        const matches = await mcmod.search(entry.request, 5, signal)
        if (matches.length) manualRequired.push({ request: entry.request, reason: entry.reason ?? 'Modrinth 与 CurseForge 没有兼容结果', matches })
      } catch (error) {
        const diagnostic = error && typeof error === 'object' && 'diagnostic' in error ? String((error as { diagnostic?: unknown }).diagnostic ?? '') : ''
        mcmodDiagnostics.push(`${entry.request}: ${diagnostic || (error instanceof Error ? error.message : String(error))}`)
      }
    }
  }
  const manualRequests = new Set(manualRequired.map((entry) => entry.request))
  const unresolvedWithoutManual = unresolvedEntries.filter((entry) => !manualRequests.has(entry.request))
  const warnings = [
    ...optionalDependencyWarnings,
    ...unresolvedWithoutManual.map((entry) => `${entry.request}: ${entry.reason ?? 'unresolved'}`),
    ...manualRequired.map((entry) => `${entry.request}: 需要用户在“第三方 Mod”中完成 MC百科验证码下载`),
    ...mcmodDiagnostics
  ]
  const all = { required: requiredPlan, optional: optionalPlan, dependencies: dependencyPlan }
  const blockingEntries = allPlanEntries(all).filter((entry) => entry.blocking !== false)
  const installEntries = allPlanEntries(all).filter((entry) => entry.selected)
  const providers = [...new Set(installEntries.map((entry) => entry.selected!.provider))]
  return {
    success: blockingEntries.every((entry) => Boolean(entry.selected) || manualRequests.has(entry.request)) && !conflicts.length,
    project: { minecraftVersion: project.minecraftVersion, loader: project.loader as ModpackPlan['project']['loader'] },
    required: requiredPlan,
    optional: optionalPlan,
    dependencies: dependencyPlan,
    dependencyEdges,
    conflicts,
    warnings,
    ...(manualRequired.length ? { manualRequired } : {}),
    review: { requiresApproval: true, installCount: installEntries.length, providers, unresolved: unresolvedWithoutManual.length, ...(manualRequired.length ? { manualRequired: manualRequired.length } : {}), ...(optionalDependencyWarnings.length ? { optionalSuggestions: optionalDependencyWarnings.length } : {}) }
  }
}

export async function planModpack(registry: ModProviderRegistry, project: ProjectInfo, concept: ModpackConcept, mcmod?: McmodQueryProvider, signal?: AbortSignal): Promise<ModpackPlan> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required')
  return planMods(registry, project, concept, mcmod, signal)
}

export interface ApplyPlanResult {
  lock: ModpackLock
  installed: string[]
  skipped: string[]
  audit: { success: boolean; checked: number; errors: string[] }
}

function safeModFileName(value: string): string {
  try { return safeModJarFileName(value) } catch { throw new Error(`provider returned an unsafe mod filename: ${value}`) }
}

export async function applyModpackPlan(registry: ModProviderRegistry, project: ProjectInfo, plan: ModpackPlan, signal?: AbortSignal): Promise<ApplyPlanResult> {
  return withProjectMutation(project.path, () => applyModpackPlanUnlocked(registry, project, plan, signal))
}

async function applyModpackPlanUnlocked(registry: ModProviderRegistry, project: ProjectInfo, plan: ModpackPlan, signal?: AbortSignal): Promise<ApplyPlanResult> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required')
  if (!plan.success) throw new Error(`cannot apply an unresolved modpack plan: ${[...plan.conflicts, ...plan.warnings].join('; ')}`)
  const current = await readModpackLock(project)
  const originalLockBytes = await fs.readFile(path.join(project.path, MODPACK_LOCK_FILE)).catch(() => null)
  const originalManifest = await readModpackManifest(project)
  const modsRoot = modpackModsRoot(project, originalManifest)
  const stagedRoot = path.join(project.path, '.modmind', 'modpack-staging', `${Date.now()}-${process.pid}`)
  const backupRoot = path.join(stagedRoot, 'backup')
  await fs.mkdir(stagedRoot, { recursive: true })
  const installed: string[] = []
  const skipped: string[] = []
  const nextMods = new Map(current.mods.map((mod) => [`${mod.provider}:${mod.projectId}`, mod]))
  const movedTargets: string[] = []
  const backedUpTargets: string[] = []
  const replacedTargets: string[] = []
  try {
    for (const entry of allPlanEntries(plan)) {
      if (!entry.selected || !entry.candidate) { skipped.push(entry.request); continue }
      if ((entry.selected as { provider: string }).provider === 'mcmod') {
        throw new Error('MC百科文件只能由用户在“第三方 Mod”中完成验证码下载')
      }
      const key = `${entry.selected.provider}:${entry.selected.projectId}`
      const targetName = safeModFileName(entry.selected.filename)
      const target = path.join(modsRoot, targetName)
      const existing = current.mods.find((mod) => mod.provider === entry.selected!.provider && mod.projectId === entry.selected!.projectId && mod.versionId === entry.selected!.versionId)
      if (existing && await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) { skipped.push(targetName); continue }
      const previous = current.mods.find((mod) => mod.provider === entry.selected!.provider && mod.projectId === entry.selected!.projectId)
      if (previous && previous.fileName !== targetName) replacedTargets.push(previous.fileName)
      const staged = path.join(stagedRoot, targetName)
      const result = await registry.install(entry.selected, staged, signal)
      await fs.mkdir(path.dirname(target), { recursive: true })
      nextMods.set(key, lockedModFromFile(entry.selected, result, targetName))
      installed.push(targetName)
    }
    await fs.mkdir(backupRoot, { recursive: true })
    for (const name of [...new Set([...installed, ...replacedTargets])]) {
      const target = path.join(modsRoot, name)
      if (await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) {
        await fs.rename(target, path.join(backupRoot, name))
        backedUpTargets.push(name)
      }
    }
    for (const name of installed) {
      const staged = path.join(stagedRoot, name)
      const target = path.join(modsRoot, name)
      await fs.rename(staged, target)
      movedTargets.push(name)
    }
    const obsolete = new Set(replacedTargets.map((name) => name.toLowerCase()))
    const refreshedManifest = { ...originalManifest, mods: originalManifest.mods.filter((mod) => !obsolete.has(mod.fileName.toLowerCase()) && !installed.some((name) => name.toLowerCase() === mod.fileName.toLowerCase())) }
    await writeModpackManifest(project, refreshedManifest)
    const added = installed.map((name) => path.join(modsRoot, name))
    if (added.length) await addModpackFiles(project, added)
    const lock = await writeModpackLock(project, { ...current, mods: [...nextMods.values()].sort((left, right) => left.fileName.localeCompare(right.fileName)) })
    const audit = await auditModpackLock(project)
    if (!audit.success) throw new Error(`modpack lock audit failed: ${audit.errors.join('; ')}`)
    return { lock, installed, skipped, audit }
  } catch (error) {
    for (const name of movedTargets) await fs.rm(path.join(modsRoot, name), { force: true }).catch(() => undefined)
    for (const name of backedUpTargets) {
      await fs.mkdir(modsRoot, { recursive: true })
      await fs.rename(path.join(backupRoot, name), path.join(modsRoot, name)).catch(() => undefined)
    }
    await writeModpackManifest(project, originalManifest).catch(() => undefined)
    if (originalLockBytes) await fs.writeFile(path.join(project.path, MODPACK_LOCK_FILE), originalLockBytes).catch(() => undefined)
    else await fs.rm(path.join(project.path, MODPACK_LOCK_FILE), { force: true }).catch(() => undefined)
    throw error
  } finally {
    await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
