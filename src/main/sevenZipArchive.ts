import { execFile } from 'node:child_process'
import { chmodSync, constants, accessSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { path7za } from '7zip-bin'
import type { ZipExpansionEntry } from './archiveImportPolicy'

const execFileAsync = promisify(execFile)
const LISTING_LIMIT = 64 * 1024 * 1024
const MAX_NESTED_LAYERS = 3
const NESTED_ARCHIVE_EXTENSIONS = new Set([
  '.tar', '.cpio', '.gz', '.bz2', '.tbz', '.tbz2', '.xz', '.txz', '.zst', '.lz', '.lzma', '.lzh', '.z'
])

function executablePath(): string {
  // electron-builder places native binaries under app.asar.unpacked.
  const executable = path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  if (process.platform !== 'win32') {
    try { accessSync(executable, constants.X_OK) } catch { chmodSync(executable, 0o755) }
  }
  return executable
}

function safeArchivePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part) => !part || part === '..')) {
    throw new Error(`Archive entry path is unsafe: ${value}`)
  }
  return normalized
}

interface ListedEntry {
  path: string
  size: number
}

function parseListing(output: string): ListedEntry[] {
  const entries: ListedEntry[] = []
  for (const block of output.split(/\r?\n\r?\n/)) {
    const entryPath = block.match(/^Path = (.+)$/m)?.[1]?.trim()
    const folder = block.match(/^Folder = (.)$/m)?.[1]
    const rawSize = block.match(/^Size = (\d+)$/m)?.[1]
    // The outer gzip/bzip2/xz layer lists its single tar payload without a
    // `Folder` field. Archive metadata blocks always contain `Type` and are
    // skipped; regular archive entries either have `Folder = -` or no folder.
    if (!entryPath || block.match(/^Type = /m) || (folder && folder !== '-') || !rawSize) continue
    const size = Number(rawSize)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Archive entry has an invalid size: ${entryPath}`)
    entries.push({ path: safeArchivePath(entryPath), size })
  }
  return entries
}

async function listArchive(source: string): Promise<ListedEntry[]> {
  try {
    const result = await execFileAsync(executablePath(), ['l', '-slt', '-sccUTF-8', source], { windowsHide: true, maxBuffer: LISTING_LIMIT })
    const entries = parseListing(result.stdout)
    if (!entries.length) throw new Error('Archive contains no regular files')
    return entries
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to inspect archive with 7-Zip: ${detail}`)
  }
}

async function extractOne(source: string, destination: string, onEntry?: (entry: ZipExpansionEntry) => void): Promise<ListedEntry[]> {
  const entries = await listArchive(source)
  for (const entry of entries) onEntry?.({ fileName: entry.path, uncompressedSize: entry.size })
  await fs.mkdir(destination, { recursive: true })
  try {
    await execFileAsync(executablePath(), ['x', '-y', '-bd', '-sccUTF-8', source, `-o${destination}`], { windowsHide: true, maxBuffer: LISTING_LIMIT })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to extract archive with 7-Zip: ${detail}`)
  }
  return entries
}

async function singleNestedArchive(root: string): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  if (files.length !== 1 || entries.some((entry) => entry.isDirectory())) return undefined
  const candidate = files[0]
  return NESTED_ARCHIVE_EXTENSIONS.has(path.extname(candidate.name).toLowerCase()) ? path.join(root, candidate.name) : undefined
}

/** Extracts formats supported by the bundled 7za binary (7z, RAR, CAB, ISO, ARJ, LZH, WIM, and compressed tar variants). */
export async function extractSevenZipArchive(source: string, destination: string, onEntry?: (entry: ZipExpansionEntry) => void): Promise<void> {
  let current = path.resolve(source)
  const temporaryArchives: string[] = []
  try {
    for (let layer = 0; layer < MAX_NESTED_LAYERS; layer += 1) {
      const entries = await extractOne(current, destination, onEntry)
      const nested = await singleNestedArchive(destination)
      if (!nested) {
        void entries
        return
      }
      temporaryArchives.push(nested)
      current = nested
    }
    throw new Error(`Archive nesting exceeds ${MAX_NESTED_LAYERS} layers`)
  } finally {
    await Promise.all(temporaryArchives.map((file) => fs.rm(file, { force: true }).catch(() => undefined)))
  }
}
