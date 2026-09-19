import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from 'extract-zip'
import type {
  DecompileFileEntry,
  DecompileInspectResult,
  DecompileObfuscationHint,
  DecompileProgressEvent,
  DecompileProvenance,
  DecompileReferenceReport,
  DecompileRunResult
} from '../shared/decompile'
import type { LoaderKind } from '../shared/types'
import { inspectDecompileJar } from './decompileJarInspection'
import { classifyObfuscation, decompileJarWithVineflower, summarizeDecompiledTree } from './jarDecompileService'
import { ensureYarnMappings, remapJarWithTinyRemapper, TINY_REMAPPER_VERSION, type YarnVersionEntry } from './jarRemapService'
import {
  createDecompileCacheStaging,
  DECOMPILE_OUTPUT_DIRECTORY,
  enforceDecompileCacheLimit,
  readDecompileCacheEntry
} from './decompileCache'
import { scanExtractedJarReferences } from './classReferenceScanner'

/** Default cache root under Electron userData; injectable for tests. */
export interface DecompilePipelineOptions {
  cacheRoot: string
  javaPath: string
  signal?: AbortSignal
  onProgress?: (event: DecompileProgressEvent) => void
  onOutput?: (output: string) => void
}

export interface DecompileRunRequest {
  jarPath: string
  /** Force skipping the Fabric remap step even when the manifest suggests it. */
  skipRemap?: boolean
  /** Minecraft version used to pick yarn mappings; defaults to the jar's declared version. */
  minecraftVersion?: string
}

function emit(options: DecompilePipelineOptions, jarSha256: string, phase: DecompileProgressEvent['phase'], message: string, ratio?: number): void {
  options.onProgress?.({ jarSha256, phase, message, ...(ratio !== undefined ? { ratio } : {}) })
}

async function extractJarToTemp(jarPath: string): Promise<string> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-scan-'))
  await extractZip(jarPath, { dir: temporary })
  return temporary
}

/**
 * Fast pre-flight: hashes the jar, reads its manifest, estimates obfuscation and decides
 * whether the Fabric remap step would help. Never runs Java.
 */
export async function inspectForDecompilation(
  jarPath: string,
  options: Pick<DecompilePipelineOptions, 'cacheRoot'>
): Promise<DecompileInspectResult> {
  if (path.extname(jarPath).toLowerCase() !== '.jar') throw new Error('只能分析 .jar 文件')
  const inspected = await inspectDecompileJar(jarPath)
  const sourceSha256 = inspected.sha256
  let extracted: string | null = null
  try {
    extracted = await extractJarToTemp(jarPath)
    const classNamesFull = await collectClassNames(extracted)
    const classification = classifyObfuscation(classNamesFull)
    const hasClasses = classNamesFull.length > 0
    const intermediaryEvidence = await hasIntermediaryClassNames(extracted)
    const cached = Boolean(await readDecompileCacheEntry(options.cacheRoot, sourceSha256))
    const loader = inspected.profile.loader
    return {
      filePath: jarPath,
      fileName: inspected.fileName,
      size: inspected.size,
      sha256: sourceSha256,
      loader,
      plugin: inspected.plugin,
      modId: inspected.profile.primaryModId,
      displayName: inspected.profile.displayName,
      version: inspected.profile.version,
      minecraftVersions: inspected.minecraftVersions,
      classCount: inspected.profile.classCount,
      obfuscationRatio: classification.obfuscationRatio,
      obfuscationHint: classification.hint,
      hasClasses,
      remapRecommended: shouldRemap(inspected.profile.loader, intermediaryEvidence),
      cached,
      warnings: [...inspected.warnings, ...obfuscationWarnings(classification.hint)]
    }
  } finally {
    if (extracted) await fs.rm(extracted, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function collectClassNames(root: string): Promise<string[]> {
  const names: string[] = []
  const queue = [root]
  while (queue.length && names.length < 50_000) {
    const directory = queue.shift()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && entry.name.endsWith('.class') && !absolute.includes(`${path.sep}META-INF${path.sep}versions${path.sep}`)) {
        names.push(entry.name.slice(0, -6))
      }
    }
  }
  return names
}

async function hasIntermediaryClassNames(root: string): Promise<boolean> {
  // Intermediary-named classes appear both as files (unmapped builds leak them at top level rarely)
  // and inside constant pools; a filename check plus a tiny sample of class content is enough for a hint.
  const queue = [root]
  let checked = 0
  while (queue.length) {
    const directory = queue.shift()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && entry.name.endsWith('.class')) {
        if (/^class_\d+\.class$/.test(entry.name)) return true
        if (checked < 400) {
          checked += 1
          const text = (await fs.readFile(absolute).catch(() => Buffer.alloc(0))).toString('latin1')
          if (/class_\d+/.test(text)) return true
        }
      }
    }
  }
  return false
}

function shouldRemap(loader: LoaderKind | undefined, intermediaryEvidence: boolean): boolean {
  return Boolean(loader === 'fabric' || loader === 'quilt') && intermediaryEvidence
}

function obfuscationWarnings(hint: DecompileObfuscationHint): string[] {
  if (hint === 'obfuscated') {
    return ['此模组经过混淆，反编译结果可读性有限（类名/方法名不可恢复，需对应映射表）']
  }
  return []
}

/**
 * Full pipeline: hash → cache check → (remap) → decompile → provenance → cache finalize.
 * Results are cached by source sha256 so re-opening is instant.
 */
export async function runDecompilation(request: DecompileRunRequest, options: DecompilePipelineOptions): Promise<DecompileRunResult> {
  if (path.extname(request.jarPath).toLowerCase() !== '.jar') throw new Error('只能反编译 .jar 文件')
  const sourceStat = await fs.stat(request.jarPath).catch(() => null)
  if (!sourceStat?.isFile()) throw new Error(`JAR 文件不存在：${request.jarPath}`)
  emit(options, '', 'hashing', '正在计算 JAR 哈希')
  const inspected = await inspectDecompileJar(request.jarPath)
  const sourceSha256 = inspected.sha256
  const cacheHit = await readDecompileCacheEntry(options.cacheRoot, sourceSha256)
  if (cacheHit?.provenance) {
    const files = await summarizeDecompiledTree(path.join(cacheHit.directory, DECOMPILE_OUTPUT_DIRECTORY), cacheHit.directory)
    emit(options, sourceSha256, 'done', '命中缓存，直接复用已有反编译结果', 1)
    return { sha256: sourceSha256, entryPath: cacheHit.directory, provenance: cacheHit.provenance, files, reused: true }
  }
  emit(options, sourceSha256, 'inspecting', `正在分析 ${inspected.fileName}（${inspected.profile.loader ?? '未知加载器'}）`)
  const staging = await createDecompileCacheStaging(options.cacheRoot, sourceSha256)
  const working = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-work-'))
  let remapInfo: DecompileProvenance['remap']
  try {
    let decompileInput = request.jarPath
    let extracted: string | null = null
    try {
      extracted = await extractJarToTemp(request.jarPath)
      const intermediaryEvidence = await hasIntermediaryClassNames(extracted)
      const wantsRemap = !request.skipRemap && shouldRemap(inspected.profile.loader, intermediaryEvidence)
      if (wantsRemap) {
        const minecraftVersion = request.minecraftVersion?.trim()
        if (!minecraftVersion) throw new Error('Fabric 模组重映射需要指定 Minecraft 版本')
        emit(options, sourceSha256, 'downloading-mappings', `正在获取 Minecraft ${minecraftVersion} 的 yarn 映射`)
        const mappingsPath = await ensureYarnMappings(options.cacheRoot, minecraftVersion, {
          download: (req) => import('./downloadService').then(({ verifiedDownload }) => verifiedDownload.download(req)),
          listVersions: defaultYarnLister(options.signal)
        })
        emit(options, sourceSha256, 'remapping', '正在运行 tiny-remapper 还原可读名称')
        const remappedJar = path.join(working, 'remapped.jar')
        await remapJarWithTinyRemapper({
          inputJar: request.jarPath,
          outputJar: remappedJar,
          mappingsPath,
          javaPath: options.javaPath,
          signal: options.signal,
          onOutput: options.onOutput
        })
        decompileInput = remappedJar
        remapInfo = {
          tool: 'tiny-remapper',
          toolVersion: TINY_REMAPPER_VERSION,
          mappingsKind: 'yarn',
          mappingsVersion: `${minecraftVersion}`,
          minecraftVersion,
          fromNamespace: 'intermediary',
          toNamespace: 'named'
        }
      }
      const classNames = await collectClassNames(extracted)
      const classification = classifyObfuscation(classNames)
      emit(options, sourceSha256, 'decompiling', '正在启动 Vineflower 反编译引擎', 0.05)
      await decompileJarWithVineflower({
        inputJar: decompileInput,
        outputDirectory: path.join(staging.staging, DECOMPILE_OUTPUT_DIRECTORY),
        javaPath: options.javaPath,
        totalClasses: classNames.length,
        signal: options.signal,
        onProgress: (message, ratio) => emit(options, sourceSha256, 'decompiling', message, ratio),
        onOutput: options.onOutput
      })
      const files = await summarizeDecompiledTree(path.join(staging.staging, DECOMPILE_OUTPUT_DIRECTORY), staging.staging)
      if (!files.length) throw new Error('反编译完成但没有生成任何源码文件；该 JAR 可能不包含 Java 字节码')
      if (inspected.plugin) {
        // Preserve resources from the original archive, independent of decompiler output.
        await fs.cp(extracted, path.join(staging.staging, 'resources'), {
          recursive: true,
          filter: source => !/\.(?:class|java)$/i.test(source)
        })
      }
      emit(options, sourceSha256, 'finalizing', '正在写入受控缓存')
      const provenance: DecompileProvenance = {
        schemaVersion: 1,
        readOnly: true,
        createdAt: new Date().toISOString(),
        sourceSha256,
        sourceFileName: inspected.fileName,
        sourceSize: inspected.size,
        engine: 'vineflower',
        engineVersion: '1.11.1',
        engineArgs: [],
        ...(inspected.plugin ? { plugin: inspected.plugin } : {}),
        ...(remapInfo ? { remap: remapInfo } : {}),
        obfuscationHint: classification.hint
      }
      const entry = await staging.finalize(provenance)
      await enforceDecompileCacheLimit(options.cacheRoot, undefined, sourceSha256).catch(() => [])
      emit(options, sourceSha256, 'done', '反编译完成', 1)
      return { sha256: sourceSha256, entryPath: entry.directory, provenance, files, reused: false }
    } finally {
      if (extracted) await fs.rm(extracted, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (error) {
    await staging.abandon()
    const aborted = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
    emit(options, sourceSha256, aborted ? 'cancelled' : 'error', error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    await fs.rm(working, { recursive: true, force: true }).catch(() => undefined)
  }
}

function defaultYarnLister(signal?: AbortSignal): (base: string) => Promise<YarnVersionEntry[]> {
  return async (base) => {
    const response = await fetch(base, { signal: signal ?? AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`yarn 元数据请求失败（HTTP ${response.status}）`)
    const payload = await response.json() as unknown
    return Array.isArray(payload) ? payload as YarnVersionEntry[] : []
  }
}

/** Reads one decompiled file from the cache; paths are validated against the cache entry root. */
export async function readCachedSourceFile(cacheRoot: string, sourceSha256: string, relativePath: string): Promise<string> {
  const entry = await readDecompileCacheEntry(cacheRoot, sourceSha256)
  if (!entry) throw new Error('该 JAR 尚无反编译缓存')
  const resolvedRoot = path.resolve(entry.directory, DECOMPILE_OUTPUT_DIRECTORY)
  const target = path.resolve(resolvedRoot, relativePath)
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('非法的文件路径')
  return fs.readFile(target, 'utf8')
}

export async function listCachedSourceFiles(cacheRoot: string, sourceSha256: string): Promise<DecompileFileEntry[]> {
  const entry = await readDecompileCacheEntry(cacheRoot, sourceSha256)
  if (!entry) throw new Error('该 JAR 尚无反编译缓存')
  return summarizeDecompiledTree(path.join(entry.directory, DECOMPILE_OUTPUT_DIRECTORY), entry.directory)
}

/**
 * Reference analysis over the ORIGINAL jar bytes (not the remapped copy) so evidence
 * reflects what actually ships. Combines constant-pool scanning with manifest mod ids.
 */
export async function scanReferencesForJar(jarPath: string, knownModPackages: Array<{ modId: string; packages: string[] }>): Promise<DecompileReferenceReport & { scannedClasses: number }> {
  const inspected = await inspectDecompileJar(jarPath)
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-ref-'))
  try {
    await extractZip(jarPath, { dir: temporary })
    const { items, scannedClasses } = await scanExtractedJarReferences(temporary, { knownModPackages })
    return {
      sha256: inspected.sha256,
      declaredModIds: inspected.profile.modIds,
      items,
      warnings: inspected.warnings,
      scannedClasses
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}
