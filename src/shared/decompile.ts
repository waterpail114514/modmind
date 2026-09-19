/** Shared contract for the controlled JAR decompilation feature (受控反编译). */
import type { JavaLoaderKind, ServerPluginPlatform } from './types'
import type { PluginDescriptor } from './serverPlugin'

export type DecompilePlatform = JavaLoaderKind | ServerPluginPlatform

export function decompileTargetPlatforms(plugin?: PluginDescriptor): DecompilePlatform[] {
  if (!plugin) return ['fabric', 'quilt', 'forge', 'neoforge']
  if (plugin.platform === 'velocity') return ['velocity']
  return [...(plugin.platform === 'paper' ? ['paper'] as const : ['spigot', 'paper'] as const), ...(plugin.foliaSupported ? ['folia'] as const : [])]
}

export type DecompileEngineId = 'vineflower'

export type DecompileObfuscationHint = 'clear' | 'obfuscated' | 'unknown'

export interface DecompileRemapInfo {
  tool: 'tiny-remapper'
  toolVersion: string
  mappingsKind: 'yarn'
  mappingsVersion: string
  minecraftVersion: string
  fromNamespace: string
  toNamespace: string
}

/** Written as provenance.json next to every cached decompilation output. */
export interface DecompileProvenance {
  schemaVersion: 1
  sourceSha256: string
  sourceFileName: string
  sourceSize: number
  createdAt: string
  engine: DecompileEngineId
  engineVersion: string
  engineArgs: string[]
  remap?: DecompileRemapInfo
  plugin?: PluginDescriptor
  obfuscationHint: DecompileObfuscationHint
  /** Controlled outputs are always read-only views; never project sources. */
  readOnly: true
}

export interface DecompileFileEntry {
  /** Slash-separated path inside the decompiled tree, e.g. `com/example/Foo.java`. */
  relativePath: string
  size: number
  /** True when Vineflower could not fully recover this class (inline error markers present). */
  hasErrors: boolean
}

export interface DecompileInspectResult {
  filePath: string
  fileName: string
  size: number
  sha256: string
  loader?: DecompilePlatform
  plugin?: PluginDescriptor
  modId?: string
  displayName?: string
  version?: string
  minecraftVersions: string[]
  classCount: number
  /** Single-letter class-name ratio observed in the JAR; high values mean obfuscated input. */
  obfuscationRatio: number
  obfuscationHint: DecompileObfuscationHint
  hasClasses: boolean
  /** Fabric/Quilt jars ship intermediary names and benefit from remapping before decompilation. */
  remapRecommended: boolean
  cached: boolean
  warnings: string[]
}

export type DecompilePhase =
  | 'hashing'
  | 'inspecting'
  | 'downloading-mappings'
  | 'remapping'
  | 'decompiling'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface DecompileProgressEvent {
  jarSha256: string
  phase: DecompilePhase
  message: string
  /** 0..1 estimate when known, otherwise omitted. */
  ratio?: number
}

export interface DecompileRunResult {
  sha256: string
  entryPath: string
  provenance: DecompileProvenance
  files: DecompileFileEntry[]
  /** Reused an existing cache entry instead of running the pipeline again. */
  reused: boolean
}

export interface DecompileReferenceReportItem {
  packageName: string
  /** Mod ids whose manifest declares or whose packages plausibly match this reference. */
  matchedModIds: string[]
  referenceCount: number
  sampleClasses: string[]
}

export interface DecompileReferenceReport {
  sha256: string
  declaredModIds: string[]
  items: DecompileReferenceReportItem[]
  warnings: string[]
}
