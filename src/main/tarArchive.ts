import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import type { ZipExpansionEntry } from './archiveImportPolicy'

export type ArchiveEntryCallback = (entry: ZipExpansionEntry) => void

function text(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/\0+$/, '').trim()
}

function octal(buffer: Buffer): number {
  const value = text(buffer).replace(/^\x00+/, '')
  if (!value) return 0
  const parsed = Number.parseInt(value.replace(/[^0-7].*$/, ''), 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('TAR entry has an invalid size')
  return parsed
}

function safeEntryPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part) => !part || part === '..')) {
    throw new Error(`TAR entry path is unsafe: ${value}`)
  }
  return normalized
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function parsePaxPath(payload: Buffer): string | undefined {
  const value = payload.toString('utf8')
  for (const record of value.split(/(?=\d+ )/)) {
    const match = record.match(/^\d+ path=(.*?)(?:\n|$)/s)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** Detects POSIX/GNU tar, including tar streams compressed with gzip. */
export function archiveSignature(buffer: Buffer): 'tar' | 'gzip' | 'zip' | 'unknown' {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gzip'
  if (buffer.length >= 262 && buffer.subarray(257, 262).toString('ascii') === 'ustar') return 'tar'
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'PK\x03\x04') return 'zip'
  return 'unknown'
}

export async function archiveSignatureForFile(filePath: string): Promise<'tar' | 'gzip' | 'zip' | 'unknown'> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return archiveSignature(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

export async function extractTar(filePath: string, destination: string, onEntry?: ArchiveEntryCallback): Promise<void> {
  const signature = await archiveSignatureForFile(filePath)
  const source = createReadStream(filePath)
  const input = signature === 'gzip' ? source.pipe(createGunzip()) : source
  source.on('error', (error) => input.destroy(error))
  let pending = Buffer.alloc(0)
  let longPath: string | undefined
  let paxPath: string | undefined
  let finished = false
  let entry: { type: string; remaining: number; padding: number; metadata: Buffer[]; file?: Awaited<ReturnType<typeof fs.open>>; target?: string } | undefined
  try {
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk])
    while (!finished) {
      if (entry) {
        const count = Math.min(pending.length, entry.remaining)
        if (count) {
          const payload = pending.subarray(0, count)
          if (entry.file) {
            let offset = 0
            while (offset < payload.length) {
              const { bytesWritten } = await entry.file.write(payload, offset, payload.length - offset)
              if (!bytesWritten) throw new Error('TAR output write made no progress')
              offset += bytesWritten
            }
          } else if (entry.type === 'x' || entry.type === 'L') entry.metadata.push(Buffer.from(payload))
          pending = pending.subarray(count)
          entry.remaining -= count
        }
        if (entry.remaining) break
        const skip = Math.min(pending.length, entry.padding)
        pending = pending.subarray(skip)
        entry.padding -= skip
        if (entry.padding) break
        if (entry.file) await entry.file.close()
        if (entry.type === 'x') paxPath = parsePaxPath(Buffer.concat(entry.metadata))
        if (entry.type === 'L') longPath = Buffer.concat(entry.metadata).toString('utf8').replace(/\0+$/, '')
        entry = undefined
        continue
      }
      if (pending.length < 512) break
      const header = pending.subarray(0, 512)
      pending = pending.subarray(512)
      if (isZeroBlock(header)) {
        finished = true
        break
      }
      const type = text(header.subarray(156, 157)) || '0'
      const name = text(header.subarray(0, 100))
      const prefix = text(header.subarray(345, 500))
      const headerPath = prefix ? `${prefix}/${name}` : name
      const size = octal(header.subarray(124, 136))
      entry = { type, remaining: size, padding: (512 - size % 512) % 512, metadata: [] }
      if (type === 'x' || type === 'L') {
        if (size > 64 * 1024) throw new Error('TAR path metadata exceeds 64 KiB')
        continue
      }
      const entryPath = safeEntryPath(paxPath ?? longPath ?? headerPath)
      paxPath = undefined
      longPath = undefined
      onEntry?.({ fileName: entryPath, uncompressedSize: size })
      const target = path.resolve(destination, ...entryPath.split('/'))
      const root = path.resolve(destination)
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`TAR entry escapes extraction directory: ${entryPath}`)
      if (type === '5') {
        await fs.mkdir(target, { recursive: true })
      } else if (type === '0') {
        await fs.mkdir(path.dirname(target), { recursive: true })
        entry.target = target
        entry.file = await fs.open(target, 'w')
      }
    }
    if (finished) break
  }
  if (!finished) throw new Error('TAR archive ended before its end-of-archive marker')
  } finally {
    if (entry?.file) {
      await entry.file.close().catch(() => undefined)
      if (entry.target) await fs.rm(entry.target, { force: true }).catch(() => undefined)
    }
    input.destroy()
    source.destroy()
  }
}
