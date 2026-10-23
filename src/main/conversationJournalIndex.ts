import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import type { ConversationEventRecord } from '../shared/types'
import { isMissingFileError } from './fileLockRetry'

// Derived data only. The JSONL files remain the source of truth, including events
// before a view checkpoint. A fingerprint change rebuilds this index by streaming.
const BLOCK_LINES = 256
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024
type Block = { start: number; end: number; lines: number; min: number; max: number; generation: number | null; conversationId: string | null }
type Recency = { sequence: number; time: string }
type Entry = { signature: string; size: number; contentChecksum?: string; blocks: Block[]; tails: Record<string, number>; recencies: Record<string, Recency>; bytes: number; versions: Buffer; versionChecksum: string; overlay: Map<string, number> }

export function journalSignature(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

export function journalEvent(line: string): ConversationEventRecord | null {
  try {
    const value = JSON.parse(line) as Partial<ConversationEventRecord>
    return typeof value.eventId === 'string' && typeof value.conversationId === 'string'
      && typeof value.turnId === 'string' && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
      && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0
      && (value.kind === 'user' || value.kind === 'progress' || value.kind === 'output' || value.kind === 'system')
      && typeof value.time === 'string' ? value as ConversationEventRecord : null
  } catch { return null }
}

function streamKey(conversationId: string, generation: number): string { return JSON.stringify([conversationId, generation]) }
function checksum(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function conversationEventVersionKey(eventId: string, conversationId: string, generation: number): string { return createHash('sha256').update(JSON.stringify([conversationId, generation, eventId])).digest('hex') }
const eventKey = conversationEventVersionKey
export type JournalVersionReader = { table: Buffer; lookup: (key: string, buffered: Buffer, includeTable: boolean) => number }
const VERSION_BYTES = 40
function isRecency(event: ConversationEventRecord): boolean {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
  return event.kind === 'user' || (event.kind === 'output' && payload.kind !== 'delta')
    || (event.kind === 'progress' && (payload.stage === 'complete' || payload.stage === 'error'))
}

async function versionTable(entries: Iterable<[string, number]>): Promise<Buffer> {
  let sorted = [...entries]
  const compare = ([a]: [string, number], [b]: [string, number]): number => a < b ? -1 : a > b ? 1 : 0
  for (let start = 0; start < sorted.length; start += 4096) {
    const chunk = sorted.slice(start, start + 4096).sort(compare)
    for (let index = 0; index < chunk.length; index += 1) sorted[start + index] = chunk[index]
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  for (let width = 4096; width < sorted.length; width *= 2) {
    const merged: Array<[string, number]> = new Array(sorted.length)
    for (let start = 0; start < sorted.length; start += width * 2) {
      let left = start, right = Math.min(start + width, sorted.length), end = Math.min(start + width * 2, sorted.length), offset = start
      const middle = right
      while (offset < end) {
        merged[offset++] = right >= end || (left < middle && compare(sorted[left], sorted[right]) <= 0) ? sorted[left++] : sorted[right++]
        if (offset % 4096 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    sorted = merged
  }
  const buffer = Buffer.allocUnsafe(sorted.length * VERSION_BYTES)
  for (let index = 0; index < sorted.length; index += 1) {
    const [hash, sequence] = sorted[index]
    Buffer.from(hash, 'hex').copy(buffer, index * VERSION_BYTES); buffer.writeDoubleBE(sequence, index * VERSION_BYTES + 32)
    if (index % 4096 === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return buffer
}

function lookupVersionKey(entry: Entry, key: string, buffered: Buffer, includeTable = true): number {
  let maximum = entry.overlay.get(key) ?? 0, low = 0, high = entry.versions.length / VERSION_BYTES - 1
  if (!includeTable) return maximum
  while (low <= high) {
    const index = Math.floor((low + high) / 2), offset = index * VERSION_BYTES
    const comparison = entry.versions.compare(buffered, 0, 32, offset, offset + 32)
    if (!comparison) return Math.max(maximum, entry.versions.readDoubleBE(index * VERSION_BYTES + 32))
    if (comparison < 0) low = index + 1; else high = index - 1
  }
  return maximum
}

export class ConversationJournalIndex {
  private readonly entries = new Map<string, Entry>()
  private readonly versionBuffers = new Map<string, { buffer: Buffer; references: number }>()
  private readonly tableBuilds = new Map<string, Promise<{ versions: Buffer; versionChecksum: string }>>()
  private readonly contentVersions = new Map<string, string>()
  private readonly coldBuilds = new Map<number, Promise<Entry>>()
  private bytes = 0

  clear(target?: string): void {
    if (target) {
      const prior = this.entries.get(target)
      if (prior) {
        this.bytes -= prior.bytes
        const version = this.versionBuffers.get(prior.versionChecksum)
        if (version && --version.references === 0) {
          this.bytes -= version.buffer.length; this.versionBuffers.delete(prior.versionChecksum)
        }
      }
      this.entries.delete(target)
    } else { this.entries.clear(); this.versionBuffers.clear(); this.bytes = 0 }
  }

  private remember(target: string, entry: Entry): Entry {
    this.clear(target)
    if (entry.bytes <= MAX_CACHE_BYTES) {
      // Replicas normally have identical event versions. Charge their shared
      // checksummed table once, so a large active journal does not thrash its
      // own three replicas out of the bounded cache.
      let version = this.versionBuffers.get(entry.versionChecksum)
      if (!version) {
        version = { buffer: entry.versions, references: 0 }; this.versionBuffers.set(entry.versionChecksum, version)
        this.bytes += version.buffer.length
      }
      version.references += 1
      entry = { ...entry, versions: version.buffer, bytes: entry.bytes - entry.versions.length }
      this.entries.set(target, entry); this.bytes += entry.bytes
      while (this.bytes > MAX_CACHE_BYTES && this.entries.size) this.clear(this.entries.keys().next().value!)
    }
    return entry
  }

  private async persist(target: string, entry: Entry): Promise<void> {
    const payload = JSON.stringify({ schemaVersion: 4, signature: entry.signature, size: entry.size, contentChecksum: entry.contentChecksum, blocks: entry.blocks, tails: entry.tails, recencies: entry.recencies, versionChecksum: entry.versionChecksum, overlay: [...entry.overlay] })
    if (Buffer.byteLength(payload) > MAX_SIDECAR_BYTES) return
    const temporary = `${target}.offsets.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ checksum: checksum(payload), payload }), { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, `${target}.offsets.json`)
    } catch { /* Losing an index never loses an event; rebuild on the next read. */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }

  // Caller holds the same file lock as append/delete. In-memory fingerprints are
  // never reused after an unobserved external append, truncate, or replacement.
  async get(target: string): Promise<Entry | null> {
    let stat: Stats
    try { stat = await fs.stat(target) } catch (error) { if (isMissingFileError(error)) { this.clear(target); return null }; throw error }
    const signature = journalSignature(stat)
    const cached = this.entries.get(target)
    if (cached?.signature === signature) { this.entries.delete(target); this.entries.set(target, cached); return cached }
    try {
      const sidecar = `${target}.offsets.json`
      if ((await fs.stat(sidecar)).size <= MAX_SIDECAR_BYTES * 2) {
        const stored = JSON.parse(await fs.readFile(sidecar, 'utf8')) as { checksum?: string; payload?: string }
        if (typeof stored.payload === 'string' && stored.checksum === checksum(stored.payload)) {
          const parsed = JSON.parse(stored.payload) as Omit<Entry, 'overlay'> & { schemaVersion?: number; overlay: Array<[string, number]> }
          let end = 0
          if (parsed.schemaVersion === 4 && parsed.signature === signature && parsed.size === stat.size
            && Array.isArray(parsed.blocks) && parsed.tails && typeof parsed.tails === 'object'
            && parsed.recencies && typeof parsed.recencies === 'object'
            && Object.values(parsed.recencies).every(value => Number.isSafeInteger(value.sequence) && typeof value.time === 'string')
            && Array.isArray(parsed.overlay) && parsed.overlay.every(item => Array.isArray(item) && /^[a-f0-9]{64}$/u.test(item[0]) && Number.isSafeInteger(item[1]) && item[1] >= 0)
            && Object.values(parsed.tails).every(value => Number.isSafeInteger(value) && value >= 0)
            && parsed.blocks.every(block => {
              const valid = Number.isSafeInteger(block.start) && block.start === end && Number.isSafeInteger(block.end)
                && block.end > block.start && block.end <= stat.size
                && Number.isSafeInteger(block.lines) && block.lines > 0 && block.lines <= BLOCK_LINES
                && Number.isSafeInteger(block.min) && Number.isSafeInteger(block.max) && block.min >= 0 && block.max >= block.min
                && (block.generation === null || Number.isSafeInteger(block.generation))
                && (block.conversationId === null || typeof block.conversationId === 'string')
              end = block.end; return valid
            }) && (end === stat.size || (!parsed.blocks.length && !stat.size))) {
            const versionsPath = `${target}.offsets.bin`
            const versionStat = await fs.stat(versionsPath)
            if (versionStat.size <= 64 * 1024 * 1024 && versionStat.size % VERSION_BYTES === 0) {
              const versions = await fs.readFile(versionsPath)
              if (createHash('sha256').update(versions).digest('hex') === parsed.versionChecksum) {
                return this.remember(target, { ...parsed, versions, overlay: new Map(parsed.overlay), bytes: Buffer.byteLength(stored.payload) * 2 + versions.length })
              }
            }
          }
        }
      }
    } catch { /* A missing, torn, old, or malformed sidecar is disposable. */ }
    return this.buildShared(target, stat, signature)
  }

  private async buildShared(target: string, stat: Stats, signature: string): Promise<Entry> {
    // Replica bytes are still read and hashed independently. Only after an exact
    // content match may another replica reuse the parsed offsets/version table.
    const previous = this.coldBuilds.get(stat.size)
    if (previous) {
      const shared = await previous.catch(() => null)
      if (shared?.contentChecksum) {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer)
        if (journalSignature(await fs.stat(target)) !== signature) throw new Error('Conversation journal changed during index validation')
        if (hash.digest('hex') === shared.contentChecksum) {
          const entry: Entry = { ...shared, signature, bytes: shared.blocks.length * 160 + Object.keys(shared.tails).length * 320 + shared.versions.length + shared.overlay.size * 160 }
          const temporary = `${target}.offsets.${process.pid}.${randomUUID()}.tmp`
          try { await fs.writeFile(temporary, entry.versions); await fs.rename(temporary, `${target}.offsets.bin`) }
          catch { /* A missing derived file is rebuilt on the next read. */ }
          finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
          await this.persist(target, entry)
          return this.remember(target, entry)
        }
      }
    }
    const build = this.build(target, stat, signature)
    this.coldBuilds.set(stat.size, build)
    try { return await build }
    finally { if (this.coldBuilds.get(stat.size) === build) this.coldBuilds.delete(stat.size) }
  }

  private async build(target: string, stat: Stats, signature: string): Promise<Entry> {
    const blocks: Block[] = [], tails: Record<string, number> = Object.create(null), recencies: Record<string, Recency> = Object.create(null), seen = new Map<string, number>()
    const contentHash = createHash('sha256')
    let start = 0, position = 0, lines = 0, block: Block | undefined
    let pending: Buffer = Buffer.alloc(0)
    const consume = (raw: Buffer, end: number): void => {
      const event = journalEvent(raw.toString('utf8'))
      if (!block) block = { start, end, lines: 0, min: Number.MAX_SAFE_INTEGER, max: 0, generation: event?.generation ?? null, conversationId: event?.conversationId ?? null }
      block.end = end; block.lines += 1
      if (event) {
        block.min = Math.min(block.min, event.sequence); block.max = Math.max(block.max, event.sequence)
        if (block.generation !== event.generation) block.generation = null
        if (block.conversationId !== event.conversationId) block.conversationId = null
        const key = streamKey(event.conversationId, event.generation)
        tails[key] = Math.max(tails[key] ?? 0, event.sequence)
        if (isRecency(event) && event.sequence >= (recencies[key]?.sequence ?? 0)) recencies[key] = { sequence: event.sequence, time: event.time }
        const hash = eventKey(event.eventId, event.conversationId, event.generation)
        seen.set(hash, Math.max(seen.get(hash) ?? 0, event.sequence))
      }
      if (++lines >= BLOCK_LINES) {
        // Invalid-only blocks must still cover the file, but never match a query.
        if (block.min === Number.MAX_SAFE_INTEGER) block.min = block.max = 0
        blocks.push(block); start = end; lines = 0; block = undefined
      }
    }
    for await (const chunk of createReadStream(target)) {
      contentHash.update(chunk as Buffer)
      const buffer = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer
      let offset = 0, newline: number
      while ((newline = buffer.indexOf(10, offset)) >= 0) {
        const consumed = newline + 1 - offset
        position += consumed; consume(buffer.subarray(offset, newline), position); offset = newline + 1
      }
      pending = buffer.subarray(offset)
    }
    // readJournal has always allowed a valid last line without a final newline.
    if (pending.length) { position += pending.length; consume(pending, position) }
    if (block) { if (block.min === Number.MAX_SAFE_INTEGER) block.min = block.max = 0; blocks.push(block) }
    const contentChecksum = contentHash.digest('hex'), priorChecksum = this.contentVersions.get(contentChecksum)
    const shared = priorChecksum ? this.versionBuffers.get(priorChecksum) : undefined
    let build = this.tableBuilds.get(contentChecksum)
    const ownsBuild = !build && !shared
    if (!build && !shared) {
      build = versionTable(seen).then(versions => ({ versions, versionChecksum: createHash('sha256').update(versions).digest('hex') }))
      this.tableBuilds.set(contentChecksum, build)
    }
    const { versions, versionChecksum } = shared ? { versions: shared.buffer, versionChecksum: priorChecksum! } : await build!
    const entry: Entry = { signature, size: stat.size, contentChecksum, blocks, tails, recencies, versions, versionChecksum, overlay: new Map(), bytes: blocks.length * 160 + Object.keys(tails).length * 320 + versions.length }
    const temporary = `${target}.offsets.${process.pid}.${randomUUID()}.tmp`
    try { await fs.writeFile(temporary, versions); await fs.rename(temporary, `${target}.offsets.bin`) }
    catch { /* Derived version tables can always be rebuilt. */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    await this.persist(target, entry)
    const remembered = this.remember(target, entry)
    this.contentVersions.set(contentChecksum, versionChecksum)
    while (this.contentVersions.size > 256) this.contentVersions.delete(this.contentVersions.keys().next().value!)
    if (ownsBuild) this.tableBuilds.delete(contentChecksum)
    return remembered
  }

  async tail(target: string, conversationId: string, generation: number): Promise<number> {
    return (await this.get(target))?.tails[streamKey(conversationId, generation)] ?? 0
  }

  async state(target: string, conversationId: string, generation: number): Promise<{ lastSequence: number; recency?: Recency }> {
    const entry = await this.get(target), key = streamKey(conversationId, generation)
    return { lastSequence: entry?.tails[key] ?? 0, recency: entry?.recencies[key] }
  }

  async versions(target: string, _conversationId: string, _generation: number): Promise<JournalVersionReader | null> {
    const entry = await this.get(target)
    return entry && (entry.versions.length || entry.overlay.size)
      ? { table: entry.versions, lookup: (key, buffered, includeTable) => lookupVersionKey(entry, key, buffered, includeTable) } : null
  }

  async appended(target: string, content: string, before: Stats, after: Stats): Promise<void> {
    const entry = this.entries.get(target)
    if (!entry || entry.signature !== journalSignature(before)) { this.clear(target); return }
    // Reuse full blocks and rebuild at most the final 255 lines. A stream of
    // one-event batches must not produce one offset block per token forever.
    const blocks = [...entry.blocks], tails = { ...entry.tails }, recencies = { ...entry.recencies }, overlay = new Map(entry.overlay)
    let buffer = Buffer.from(content, 'utf8'), baseOffset = before.size
    const tail = blocks.at(-1)
    if (tail && tail.lines < BLOCK_LINES) {
      blocks.pop(); baseOffset = tail.start
      const prefix = Buffer.allocUnsafe(before.size - baseOffset), handle = await fs.open(target, 'r')
      try { await handle.read(prefix, 0, prefix.length, baseOffset) } finally { await handle.close() }
      buffer = Buffer.concat([prefix, buffer])
    }
    let start = baseOffset, offset = 0, count = 0, block: Block | undefined
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset), end = newline < 0 ? buffer.length : newline + 1
      const event = journalEvent(buffer.subarray(offset, newline < 0 ? end : newline).toString('utf8'))
      if (!block) block = { start, end: baseOffset + end, lines: 0, min: Number.MAX_SAFE_INTEGER, max: 0, generation: event?.generation ?? null, conversationId: event?.conversationId ?? null }
      block.end = baseOffset + end; block.lines += 1
      if (event) {
        block.min = Math.min(block.min, event.sequence); block.max = Math.max(block.max, event.sequence)
        if (block.generation !== event.generation) block.generation = null
        if (block.conversationId !== event.conversationId) block.conversationId = null
        const key = streamKey(event.conversationId, event.generation)
        tails[key] = Math.max(tails[key] ?? 0, event.sequence)
        if (isRecency(event) && event.sequence >= (recencies[key]?.sequence ?? 0)) recencies[key] = { sequence: event.sequence, time: event.time }
        const hash = eventKey(event.eventId, event.conversationId, event.generation)
        overlay.set(hash, Math.max(overlay.get(hash) ?? 0, event.sequence))
      }
      offset = end
      if (++count >= BLOCK_LINES) {
        if (block.min === Number.MAX_SAFE_INTEGER) block.min = block.max = 0
        blocks.push(block); start = block.end; count = 0; block = undefined
      }
    }
    if (block) { if (block.min === Number.MAX_SAFE_INTEGER) block.min = block.max = 0; blocks.push(block) }
    // Bound overlay cost. A derived-table merge is occasional, never per token.
    let versions = entry.versions, versionChecksum = entry.versionChecksum
    if (overlay.size >= 2_048) {
      for (let offset = 0; offset < versions.length; offset += VERSION_BYTES) {
        const hash = versions.subarray(offset, offset + 32).toString('hex')
        overlay.set(hash, Math.max(overlay.get(hash) ?? 0, versions.readDoubleBE(offset + 32)))
        if (offset % (4096 * VERSION_BYTES) === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      versions = await versionTable(overlay); overlay.clear()
      versionChecksum = createHash('sha256').update(versions).digest('hex')
      const temporary = `${target}.offsets.${process.pid}.${randomUUID()}.tmp`
      try { await fs.writeFile(temporary, versions); await fs.rename(temporary, `${target}.offsets.bin`) }
      catch { /* An old table/sidecar pair will fail validation and be rebuilt. */ }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    }
    const next = this.remember(target, { signature: journalSignature(after), size: after.size, blocks, tails, recencies, versions, versionChecksum, overlay, bytes: blocks.length * 160 + Object.keys(tails).length * 320 + versions.length + overlay.size * 160 })
    await this.persist(target, next)
  }

  async page(target: string, conversationId: string, generation: number, afterSequence: number, limit: number, latest?: (eventId: string) => number): Promise<ConversationEventRecord[]> {
    const entry = await this.get(target)
    if (!entry) return []
    const blocks = entry.blocks.filter(block => block.max > afterSequence
      && (block.generation === null || block.generation === generation)
      && (block.conversationId === null || block.conversationId === conversationId))
      .sort((a, b) => a.min - b.min || a.start - b.start)
    const records = new Map<string, ConversationEventRecord>()
    const handle = await fs.open(target, 'r')
    try {
      let threshold = Number.POSITIVE_INFINITY
      for (let index = 0; index < blocks.length;) {
        const block = blocks[index++]
        if (records.size > limit && block.min > threshold) break
        let end = block.end, lines = block.lines
        while (index < blocks.length && blocks[index].start === end && blocks[index].end - block.start <= 4 * 1024 * 1024 && lines + blocks[index].lines <= limit + BLOCK_LINES) {
          lines += blocks[index].lines; end = blocks[index++].end
        }
        const buffer = Buffer.allocUnsafe(end - block.start)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, block.start + offset)
          if (!bytesRead) throw new Error('Conversation journal changed during a page read')
          offset += bytesRead
        }
        for (const line of buffer.toString('utf8').split('\n')) {
          const event = journalEvent(line)
          if (!event || event.conversationId !== conversationId || event.generation !== generation || event.sequence <= afterSequence) continue
          let version: number
          if (latest) version = latest(event.eventId)
          else { const key = eventKey(event.eventId, conversationId, generation); version = lookupVersionKey(entry, key, Buffer.from(key, 'hex')) }
          if (event.sequence < version) continue
          const prior = records.get(event.eventId)
          if (!prior || event.sequence >= prior.sequence) records.set(event.eventId, event)
        }
        if (records.size > limit) threshold = [...records.values()].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))[limit].sequence
      }
    } finally { await handle.close() }
    return [...records.values()].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId)).slice(0, limit + 1)
  }
}
