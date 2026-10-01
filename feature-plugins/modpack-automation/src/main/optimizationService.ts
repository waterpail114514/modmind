import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from "../../../../src/shared/types"
import { applyModpackPlan, planModpack, type ModpackConcept } from "../../../modpack-mods/src/main/modpackPlanner"
import type { ModProviderRegistry } from "../../../../src/main/modProviderService"

export interface OptimizationPatch {
  path: string
  format: 'json' | 'properties'
  values: Record<string, unknown>
}

export interface OptimizationProfile {
  id: string
  name: string
  description: string
  required: string[]
  optional: string[]
  excluded: string[]
  patches: OptimizationPatch[]
}

export interface OptimizationApplyResult {
  profile: OptimizationProfile
  plan: Awaited<ReturnType<typeof planModpack>>
  appliedPatches: string[]
  warnings: string[]
}

export const BUILTIN_OPTIMIZATION_PROFILES: OptimizationProfile[] = [
  {
    id: 'safe-client',
    name: 'Safe client performance',
    description: 'A conservative client profile. Every mod remains optional until the provider resolver confirms compatibility.',
    required: [],
    optional: ['Sodium', 'Lithium', 'FerriteCore', 'ModernFix', 'ImmediatelyFast', 'Entity Culling'],
    excluded: [],
    patches: []
  },
  {
    id: 'server-balanced',
    name: 'Balanced server performance',
    description: 'Server-side performance candidates with no client-only graphics assumptions.',
    required: [],
    optional: ['Lithium', 'FerriteCore', 'ModernFix', 'Noisium'],
    excluded: ['OptiFine'],
    patches: []
  },
]

function safeRelative(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || !/^(?:overrides\/|config\/|kubejs\/)/.test(normalized)) throw new Error(`unsafe optimization patch path: ${value}`)
  return normalized
}

function mergeObject(target: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const output = { ...target }
  for (const [key, value] of Object.entries(values)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) output[key] = mergeObject(output[key] as Record<string, unknown>, value as Record<string, unknown>)
    else output[key] = value
  }
  return output
}

async function applyPatch(project: ProjectInfo, patch: OptimizationPatch): Promise<void> {
  const relative = safeRelative(patch.path)
  const target = path.resolve(project.path, ...relative.split('/'))
  if (!target.startsWith(`${path.resolve(project.path)}${path.sep}`)) throw new Error('optimization patch escaped project root')
  const existing = await fs.readFile(target, 'utf8').catch(() => '')
  if (patch.format === 'json') {
    const parsed = existing ? JSON.parse(existing) as unknown : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`optimization target is not a JSON object: ${relative}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, `${JSON.stringify(mergeObject(parsed as Record<string, unknown>, patch.values), null, 2)}\n`, 'utf8')
    return
  }
  const lines = existing ? existing.split(/\r?\n/) : []
  const keys = new Set<string>()
  const next = lines.map((line) => {
    const match = line.match(/^\s*([^#:=\s]+)\s*[:=](.*)$/)
    if (!match || !(match[1] in patch.values)) return line
    keys.add(match[1])
    return `${match[1]}=${String(patch.values[match[1]])}`
  })
  for (const [key, value] of Object.entries(patch.values)) if (!keys.has(key)) next.push(`${key}=${String(value)}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${next.filter(Boolean).join('\n')}\n`, 'utf8')
}

export async function applyOptimizationProfile(registry: ModProviderRegistry, project: ProjectInfo, profile: OptimizationProfile, signal?: AbortSignal): Promise<OptimizationApplyResult> {
  if (project.kind !== 'modpack') throw new Error('a modpack project is required')
  const concept: ModpackConcept = { required: profile.required, optional: profile.optional, excluded: profile.excluded, maxMods: 100 }
  const plan = await planModpack(registry, project, concept)
  if (profile.required.length && !plan.success) throw new Error(`required optimization mods unresolved: ${plan.warnings.join('; ')}`)
  const appliedPatches: string[] = []
  const warnings = [...plan.warnings]
  if (plan.success && (plan.required.length || plan.optional.length)) {
    await applyModpackPlan(registry, project, plan, signal)
  }
  for (const patch of profile.patches) {
    try { await applyPatch(project, patch); appliedPatches.push(safeRelative(patch.path)) } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)) }
  }
  return { profile, plan, appliedPatches, warnings }
}
