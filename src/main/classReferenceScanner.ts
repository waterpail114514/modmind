import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extractZip from './safeExtractZip'
import type { DecompileReferenceReport, DecompileReferenceReportItem } from '../shared/decompile'

/**
 * Lightweight JVM class-file constant-pool scanner. Extracts UTF8 constants that look
 * like class references so ModMind can infer which third-party packages a mod actually
 * uses — even when the manifest omits them. Runs in pure Node without a JVM.
 */

const CLASS_MAGIC = 0xcafebabe

/** Package prefixes owned by Minecraft/JDK/tooling; never reported as third-party references. */
const BUILTIN_PACKAGE_PREFIXES = [
  'net/minecraft', 'com/mojang', 'net/minecraftforge', 'net/neoforged',
  'org/quiltmc', 'net/fabricmc', 'java/', 'javax/', 'jdk/', 'sun/', 'com/sun',
  'org/slf4j', 'org/apache/logging', 'org/jetbrains/annotations', 'org/objectweb/asm',
  'com/google/gson', 'com/google/common', 'org/intellij/lang/annotations'
]

const MINECRAFT_NAMESPACE_PACKAGES: Record<string, string> = {
  minecraft: 'net/minecraft'
}

interface ClassFileScan {
  className: string
  referencedClasses: string[]
}

export function isBuiltinPackage(internalPackage: string): boolean {
  return BUILTIN_PACKAGE_PREFIXES.some((prefix) => internalPackage === prefix || internalPackage.startsWith(prefix))
}

/** Parses the constant pool of one `.class` buffer and returns its class references. */
export function scanClassFile(buffer: Buffer): ClassFileScan | null {
  if (buffer.length < 10 || buffer.readUInt32BE(0) !== CLASS_MAGIC) return null
  const minor = buffer.readUInt16BE(4)
  const major = buffer.readUInt16BE(6)
  if (major < 45 || major > 70 || minor > 65535) return null
  const count = buffer.readUInt16BE(8)
  if (count < 1 || count > 65_535) return null
  let offset = 10
  // Constant pool entries are 1-indexed; long/double occupy two slots.
  const utf8Entries: Array<{ index: number; text: string }> = []
  const classNames: Array<{ nameIndex: number }> = []
  let index = 1
  while (index < count && offset + 3 <= buffer.length) {
    const tag = buffer.readUInt8(offset)
    offset += 1
    switch (tag) {
      case 1: { // Utf8
        const length = buffer.readUInt16BE(offset)
        offset += 2
        if (offset + length > buffer.length) return null
        utf8Entries.push({ index, text: buffer.toString('utf8', offset, offset + length) })
        offset += length
        break
      }
      case 7: // Class
        if (offset + 2 > buffer.length) return null
        classNames.push({ nameIndex: buffer.readUInt16BE(offset) })
        offset += 2
        break
      case 8: // String
      case 16: // MethodType
        offset += 2
        break
      case 15: // MethodHandle
        offset += 3
        break
      case 3: // Integer
      case 4: // Float
      case 9: case 10: case 11: // Field/Method/InterfaceMethod ref
      case 12: // NameAndType
      case 17: // Dynamic
      case 18: // InvokeDynamic
        offset += 4
        break
      case 5: // Long
      case 6: // Double
        offset += 8
        index += 1 // occupies two constant-pool slots
        break
      default:
        // Unknown tag: bail out rather than desynchronize.
        return null
    }
    index += 1
  }
  if (!classNames.length) return { className: '', referencedClasses: [] }
  const utf8ByIndex = new Map(utf8Entries.map((entry) => [entry.index, entry.text]))
  const ownNameIndex = classNames[0].nameIndex
  const selfName = utf8ByIndex.get(ownNameIndex) ?? ''
  const referencedClasses: string[] = []
  for (let position = 1; position < classNames.length; position += 1) {
    const name = utf8ByIndex.get(classNames[position].nameIndex)
    if (name && name !== selfName) referencedClasses.push(name)
  }
  return { className: selfName, referencedClasses }
}

/** Normalizes descriptors/signatures into bare internal names (`a/b/C`). */
export function normalizeClassReference(raw: string): string | null {
  let value = raw.trim()
  // Array prefixes and descriptor wrappers: `[Ljava/lang/String;`, `[[I`, `Lcom/example/Foo;`.
  value = value.replaceAll('[', '')
  const objectMatch = /^L([^;]+);$/.exec(value)
  if (objectMatch) value = objectMatch[1]
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*(\/[a-zA-Z0-9_$]+)*$/.test(value)) return null
  if (!value.includes('/') && /^[A-Z]/.test(value)) return null // unqualified default-package class: ambiguous
  return value
}

export interface ScanOptions {
  /** Known mod ids with their declared package hints (from manifests of installed mods). */
  knownModPackages?: Array<{ modId: string; packages: string[] }>
  maxFiles?: number
}

const MAX_CLASS_FILES_DEFAULT = 20_000

/** Scans every `.class` file inside an extracted jar tree and aggregates package-level references. */
export async function scanExtractedJarReferences(extractedRoot: string, options: ScanOptions = {}): Promise<{ items: DecompileReferenceReportItem[]; scannedClasses: number }> {
  const packageRefs = new Map<string, { count: number; samples: Set<string> }>()
  let scanned = 0
  const maxFiles = options.maxFiles ?? MAX_CLASS_FILES_DEFAULT
  const queue = [extractedRoot]
  outer: while (queue.length) {
    const directory = queue.shift()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        queue.push(absolute)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.class') || entry.name.startsWith('module-info') || entry.name.startsWith('package-info')) continue
      if (scanned >= maxFiles) break outer
      const parsed = scanClassFile(await fs.readFile(absolute))
      if (!parsed) continue
      scanned += 1
      for (const reference of parsed.referencedClasses) {
        const normalized = normalizeClassReference(reference)
        if (!normalized) continue
        const packageName = normalized.split('/').slice(0, -1).join('/')
        if (!packageName || isBuiltinPackage(packageName)) continue
        const bucket = packageRefs.get(packageName) ?? { count: 0, samples: new Set<string>() }
        bucket.count += 1
        if (bucket.samples.size < 5) bucket.samples.add(normalized.replaceAll('/', '.'))
        packageRefs.set(packageName, bucket)
      }
    }
  }
  const items = [...packageRefs.entries()]
    .map(([packageName, data]) => ({
      packageName,
      referenceCount: data.count,
      sampleClasses: [...data.samples],
      matchedModIds: matchModIdsForPackage(packageName, options.knownModPackages ?? [])
    }))
    .sort((left, right) => right.referenceCount - left.referenceCount || left.packageName.localeCompare(right.packageName))
  return { items, scannedClasses: scanned }
}

function matchModIdsForPackage(packageName: string, knownModPackages: Array<{ modId: string; packages: string[] }>): string[] {
  const matches: string[] = []
  for (const candidate of knownModPackages) {
    for (const hint of candidate.packages) {
      const normalizedHint = hint.replaceAll('.', '/')
      if (packageName === normalizedHint || packageName.startsWith(`${normalizedHint}/`)) {
        matches.push(candidate.modId)
        break
      }
    }
  }
  return matches
}

/** Convenience wrapper: extracts a jar to a temp dir and scans it in one call. */
export async function scanJarReferences(jarPath: string, options: ScanOptions & { signal?: AbortSignal } = {}): Promise<DecompileReferenceReport & { scannedClasses: number }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-classref-'))
  try {
    await extractZip(jarPath, { dir: temporary })
    const { items, scannedClasses } = await scanExtractedJarReferences(temporary, options)
    return {
      sha256: '',
      declaredModIds: [],
      items,
      warnings: [],
      scannedClasses
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { MINECRAFT_NAMESPACE_PACKAGES }
