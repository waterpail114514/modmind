import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { gzip, gunzip, createGunzip, createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import * as lockfile from 'proper-lockfile'
import type { ConversationEventRecord, WorkbenchDataReadResult, WorkbenchDataWriteResult } from '../shared/types'
import { isMissingFileError, retryTransientFileLock } from './fileLockRetry'
import { ConversationJournalIndex, conversationEventVersionKey } from './conversationJournalIndex'
import { validateLargeWorkbenchJson } from './workbenchJsonValidation'

const STORE_SCHEMA_VERSION = 1
const MAX_CONTENT_BYTES = 256 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = MAX_CONTENT_BYTES + 64 * 1024
const RETAINED_REVISIONS = 8
const WORKBENCH_DATA_PATH = /^\.modmind\/(?:workbench-conversations|workbench-timeline(?:-[\w-]+)?|conversations-index-v1|conversations-v2\/(?:index|[a-z0-9][\w-]*))\.json$/iu
const WORKBENCH_JOURNAL_PATH = /^\.modmind\/conversations-v3\/[a-z0-9][\w-]{0,127}\.jsonl$/iu

type ReplicaName = 'project' | 'mirror'

type SnapshotMetadata = {
  schemaVersion: number
  key: string
  revision: number
  checksum: string
  contentBytes: number
  committedAt: string
  deleted?: boolean
}

type HeadRecord = SnapshotMetadata & { file: string }

type SnapshotCandidate = {
  replica: ReplicaName
  root: string
  file: string
  advertisedRevision: number
  fromHead: boolean
}

type ValidSnapshot = {
  candidate: SnapshotCandidate
  metadata: SnapshotMetadata
  content: string
  compressed: Buffer
}

type PendingWrite = {
  projectPath: string
  key: string
  content?: string
  deleted: boolean
  validation?: Promise<{ bytes: number; checksum: string }>
  waiters: Array<{
    resolve: (result: WorkbenchDataWriteResult) => void
    reject: (error: unknown) => void
  }>
}

type WriteLane = {
  running: boolean
  pending?: PendingWrite
  drain?: Promise<void>
}

export type WorkbenchStoreDiagnostic = (entry: {
  level: 'info' | 'warning' | 'error'
  operation: string
  message: string
  data?: Record<string, unknown>
  error?: unknown
}) => void

function normalizeWorkbenchKey(relativePath: string): string {
  const normalized = relativePath.trim().replaceAll('\\', '/').replace(/^\.\//u, '')
  if (!WORKBENCH_DATA_PATH.test(normalized)) throw new Error(`Invalid workbench data path: ${relativePath}`)
  return normalized
}

function normalizeJournalKey(relativePath: string): string {
  const normalized = relativePath.trim().replaceAll('\\', '/').replace(/^\.\//u, '')
  if (!WORKBENCH_JOURNAL_PATH.test(normalized)) throw new Error(`Invalid conversation journal path: ${relativePath}`)
  return normalized
}

function normalizedProjectIdentity(projectPath: string): string {
  const resolved = path.resolve(projectPath).replaceAll('\\', '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function documentDirectoryName(key: string): string {
  const label = path.posix.basename(key, '.json').replaceAll(/[^a-z0-9_-]+/gi, '-').slice(0, 80)
  return `${label}-${sha256(key).slice(0, 12)}`
}

function snapshotFileName(revision: number, checksum: string): string {
  return `${String(revision).padStart(16, '0')}-${checksum.slice(0, 16)}.snapshot.gz`
}

function snapshotRevision(fileName: string): number {
  const match = /^(\d{16})-[a-f0-9]{16}\.snapshot\.gz$/u.exec(fileName)
  if (!match) return -1
  const revision = Number(match[1])
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : -1
}

async function validateContent(key: string, content: string): Promise<{ bytes: number; checksum: string }> {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_CONTENT_BYTES) throw new Error('工作台对话数据超过 256 MB 安全上限')
  const isConversationDocument = key === '.modmind/conversations-index-v1.json' || (key.startsWith('.modmind/conversations-v2/') && !key.endsWith('/index.json'))
  if (bytes > 1024 * 1024) {
    try { await validateLargeWorkbenchJson(content, isConversationDocument) }
    catch (error) {
      if (error instanceof Error && error.message === 'shape') throw new Error(`工作台数据文件 ${path.posix.basename(key)} 格式无效`)
      throw new Error('工作台对话数据不是有效 JSON', { cause: error })
    }
  } else {
    let parsed: unknown
    try { parsed = JSON.parse(content) as unknown } catch (error) { throw new Error('工作台对话数据不是有效 JSON', { cause: error }) }
    if (isConversationDocument) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`对话数据文件 ${path.posix.basename(key)} 必须是对象`)
    } else if (!Array.isArray(parsed)) throw new Error(`工作台数据文件 ${path.posix.basename(key)} 必须是数组`)
  }
  return { bytes, checksum: sha256(content) }
}

function compressSnapshot(metadata: SnapshotMetadata, content: string): Promise<Buffer> {
  const payload = Buffer.concat([
    Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'),
    Buffer.from(content, 'utf8')
  ])
  return new Promise((resolve, reject) => {
    gzip(payload, { level: 6 }, (error, output) => error ? reject(error) : resolve(output))
  })
}

function decompressSnapshot(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(input, { maxOutputLength: MAX_SNAPSHOT_BYTES }, (error, output) => error ? reject(error) : resolve(output))
  })
}

async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true).catch(() => false)
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const JOURNAL_LOCK_OPTIONS = { stale: 31_000, update: 10_000, realpath: false, retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 1_000 } } as const

async function withJournalLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const release = await lockfile.lock(target, JOURNAL_LOCK_OPTIONS)
  try { return await operation() } finally { await release().catch(() => undefined) }
}

async function appendDurable(target: string, content: string, indexed?: ConversationJournalIndex): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await withJournalLock(target, async () => {
    const handle = await fs.open(target, 'a+', 0o600)
    try {
      const before = await handle.stat()
      // A torn last line must not swallow the next successfully committed event.
      let addition = content
      if (before.size) {
        const last = Buffer.allocUnsafe(1)
        await handle.read(last, 0, 1, before.size - 1)
        if (last[0] !== 10) addition = `\n${content}`
      }
      await handle.writeFile(addition, 'utf8')
      await handle.sync()
      if (indexed) await indexed.appended(target, addition, before, await handle.stat())
    } finally {
      await handle.close()
    }
  })
  await syncDirectory(path.dirname(target))
}

async function durableReplace(target: string, content: string | Buffer, keepPrevious = true): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const previous = `${target}.previous`
  try {
    await retryTransientFileLock(async () => {
      if (keepPrevious && await pathExists(target)) {
        await fs.rm(previous, { force: true })
        await fs.rename(target, previous)
      } else if (!keepPrevious) {
        await fs.rm(target, { force: true })
      }
      await fs.rename(temporary, target)
    })
    await syncDirectory(path.dirname(target))
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function durableWriteImmutable(target: string, content: Buffer): Promise<void> {
  if (await pathExists(target)) return
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await retryTransientFileLock(() => fs.rename(temporary, target))
    await syncDirectory(path.dirname(target))
  } catch (error) {
    if (!(await pathExists(target))) throw error
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function appendCommit(root: string, head: HeadRecord): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  const handle = await fs.open(path.join(root, 'commits.jsonl'), 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(head)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readJsonFile<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await retryTransientFileLock(() => fs.readFile(target, 'utf8'))) as T
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

export class WorkbenchDataStore {
  private readonly lanes = new Map<string, WriteLane>()
  private readonly revisions = new Map<string, number>()
  private readonly journalLanes = new Map<string, Promise<unknown>>()
  private readonly journalIndex = new ConversationJournalIndex()
  private readonly readCache = new Map<string, { fingerprint: string; result: WorkbenchDataReadResult; bytes: number }>()
  private readonly snapshotNames = new Map<string, string>()
  private readCacheBytes = 0

  constructor(
    private readonly userDataPath: string,
    private readonly diagnostic: WorkbenchStoreDiagnostic = () => undefined
  ) {}

  private journalRoots(projectPath: string, relativePath: string): { project: string; mirror: string; compatibility: string } {
    const projectIdentity = sha256(normalizedProjectIdentity(projectPath)).slice(0, 24)
    const label = path.posix.basename(relativePath, '.jsonl')
    return {
      project: path.join(projectPath, '.modmind', 'workbench-journal', label),
      mirror: path.join(this.userDataPath, 'workbench-journal', projectIdentity, label),
      compatibility: path.join(projectPath, ...relativePath.split('/'))
    }
  }

  appendJournal(projectPath: string, relativePath: string, line: string): Promise<{ durability: 'redundant' | 'degraded'; copies: { project: boolean; mirror: boolean; compatibility: boolean } }> {
    const key = normalizeJournalKey(relativePath)
    if (!line.endsWith('\n')) throw new Error('Conversation journal records must end with a newline')
    if (Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024) throw new Error('Conversation journal record exceeds 8 MB')
    const laneKey = `${this.laneKey(projectPath, key)}\njournal`
    const previous = this.journalLanes.get(laneKey) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const roots = this.journalRoots(path.resolve(projectPath), key)
      const copies = { project: false, mirror: false, compatibility: false }
      const results = await Promise.allSettled([
        appendDurable(path.join(roots.project, 'events.jsonl'), line, this.journalIndex).then(() => 'project' as const),
        appendDurable(path.join(roots.mirror, 'events.jsonl'), line, this.journalIndex).then(() => 'mirror' as const),
        appendDurable(roots.compatibility, line, this.journalIndex).then(() => 'compatibility' as const)
      ])
      const errors: unknown[] = []
      for (const result of results) {
        if (result.status === 'fulfilled') copies[result.value] = true
        else errors.push(result.reason)
      }
      if (!copies.project && !copies.mirror && !copies.compatibility) throw new AggregateError(errors, 'Conversation journal could not be appended')
      return { durability: copies.project && copies.mirror ? 'redundant' as const : 'degraded' as const, copies }
    })
    const tracked = current.then(() => undefined, () => undefined).finally(() => {
      if (this.journalLanes.get(laneKey) === tracked) this.journalLanes.delete(laneKey)
    })
    this.journalLanes.set(laneKey, tracked)
    return current
  }

  async readJournal(projectPath: string, relativePath: string, strict = false): Promise<string[]> {
    const key = normalizeJournalKey(relativePath)
    const laneKey = `${this.laneKey(projectPath, key)}\njournal`
    const pending = this.journalLanes.get(laneKey)
    if (pending) await pending
    const roots = this.journalRoots(path.resolve(projectPath), key)
    const targets = [path.join(roots.project, 'events.jsonl'), path.join(roots.mirror, 'events.jsonl'), roots.compatibility]
    const unique = new Set<string>()
    const failures: unknown[] = []
    for (const target of targets) {
      await withJournalLock(target, () => retryTransientFileLock(async () => {
        const input = createReadStream(target, { encoding: 'utf8' })
        const reader = createInterface({ input, crlfDelay: Infinity })
        try { for await (const line of reader) if (line.trim()) unique.add(`${line}\n`) }
        finally { reader.close(); input.destroy() }
      })).catch((error) => { if (!isMissingFileError(error)) failures.push(error) })
    }
    if (failures.length && (strict || !unique.size)) throw new AggregateError(failures, 'Conversation journal replicas could not be read')
    return [...unique]
  }

  async conversationJournalTail(projectPath: string, relativePath: string, conversationId: string, generation: number): Promise<number> {
    const results = await this.indexedJournalRead(projectPath, relativePath, target => this.journalIndex.tail(target, conversationId, generation), value => value > 0, true)
    return results.reduce((maximum, sequence) => Math.max(maximum, sequence), 0)
  }

  async conversationJournalState(projectPath: string, relativePath: string, conversationId: string, generation: number): Promise<{ lastSequence: number; updatedAt?: string }> {
    const states = await this.indexedJournalRead(projectPath, relativePath, target => this.journalIndex.state(target, conversationId, generation), value => value.lastSequence > 0, true)
    let lastSequence = 0, recency: { sequence: number; time: string } | undefined
    for (const state of states) {
      lastSequence = Math.max(lastSequence, state.lastSequence)
      if (state.recency && (!recency || state.recency.sequence >= recency.sequence)) recency = state.recency
    }
    return { lastSequence, ...(recency ? { updatedAt: recency.time } : {}) }
  }

  async journalLastLines(projectPath: string, relativePath: string, limit = 16): Promise<string[]> {
    const pages = await this.indexedJournalRead(projectPath, relativePath, async target => {
      let handle
      try { handle = await fs.open(target, 'r') } catch (error) { if (isMissingFileError(error)) return []; throw error }
      try {
        const { size } = await handle.stat()
        let length = Math.min(size, 16 * 1024)
        while (length) {
          const buffer = Buffer.allocUnsafe(length)
          await handle.read(buffer, 0, length, size - length)
          const lines = buffer.toString('utf8').split('\n')
          if (length < size) lines.shift()
          const nonempty = lines.filter(line => line.trim())
          if (nonempty.length >= limit || length === size || length >= 8 * 1024 * 1024) return nonempty.slice(-limit)
          length = Math.min(size, length * 2, 8 * 1024 * 1024)
        }
        return []
      } finally { await handle.close() }
    }, value => value.length > 0)
    return [...new Set(pages.flat())]
  }

  async journalByteSize(projectPath: string, relativePath: string): Promise<number> {
    const sizes = await this.indexedJournalRead(projectPath, relativePath, async target => {
      try { return (await fs.stat(target)).size } catch (error) { if (isMissingFileError(error)) return 0; throw error }
    }, value => value > 0)
    return sizes.reduce((maximum, size) => Math.max(maximum, size), 0)
  }

  async conversationJournalPage(projectPath: string, relativePath: string, conversationId: string, generation: number, afterSequence: number, limit: number): Promise<ConversationEventRecord[]> {
    const versions = await this.indexedJournalRead(projectPath, relativePath, target => this.journalIndex.versions(target, conversationId, generation), value => value !== null)
    const versionCache = new Map<string, number>()
    const latest = (eventId: string): number => {
      const cached = versionCache.get(eventId)
      if (cached !== undefined) return cached
      const key = conversationEventVersionKey(eventId, conversationId, generation), buffered = Buffer.from(key, 'hex'), checked = new Set<Buffer>()
      let maximum = 0
      for (const reader of versions) {
        if (!reader) continue
        maximum = Math.max(maximum, reader.lookup(key, buffered, !checked.has(reader.table)))
        checked.add(reader.table)
      }
      if (versionCache.size >= Math.max(1024, limit * 2 + 512)) versionCache.clear()
      versionCache.set(eventId, maximum)
      return maximum
    }
    const pages = await this.indexedJournalRead(projectPath, relativePath,
      target => this.journalIndex.page(target, conversationId, generation, afterSequence, limit, latest), value => value.length > 0)
    const records = new Map<string, ConversationEventRecord>()
    for (const event of pages.flat()) {
      const prior = records.get(event.eventId)
      if (!prior || event.sequence >= prior.sequence) records.set(event.eventId, event)
    }
    return [...records.values()].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId)).slice(0, limit + 1)
  }

  private async indexedJournalRead<T>(projectPath: string, relativePath: string, read: (target: string) => Promise<T>, hasData: (value: T) => boolean, strict = false): Promise<T[]> {
    const key = normalizeJournalKey(relativePath)
    await this.journalLanes.get(`${this.laneKey(projectPath, key)}\njournal`)
    const roots = this.journalRoots(path.resolve(projectPath), key)
    const results = await Promise.allSettled([path.join(roots.project, 'events.jsonl'), path.join(roots.mirror, 'events.jsonl'), roots.compatibility]
      .map(target => withJournalLock(target, () => read(target))))
    const values: T[] = []
    for (const result of results) if (result.status === 'fulfilled') values.push(result.value)
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (!values.length || (failures.length && (strict || !values.some(hasData)))) throw new AggregateError(failures.map(result => result.reason), 'Conversation journal replicas could not be read')
    return values
  }

  async deleteJournal(projectPath: string, relativePath: string): Promise<void> {
    const key = normalizeJournalKey(relativePath)
    const laneKey = `${this.laneKey(projectPath, key)}\njournal`
    const previous = this.journalLanes.get(laneKey) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const roots = this.journalRoots(path.resolve(projectPath), key)
      for (const target of [path.join(roots.project, 'events.jsonl'), path.join(roots.mirror, 'events.jsonl'), roots.compatibility]) this.journalIndex.clear(target)
      await Promise.allSettled([
        withJournalLock(path.join(roots.project, 'events.jsonl'), () => fs.rm(roots.project, { recursive: true, force: true })),
        withJournalLock(path.join(roots.mirror, 'events.jsonl'), () => fs.rm(roots.mirror, { recursive: true, force: true })),
        withJournalLock(roots.compatibility, async () => {
          await fs.rm(roots.compatibility, { force: true })
          await fs.rm(`${roots.compatibility}.offsets.json`, { force: true })
          await fs.rm(`${roots.compatibility}.offsets.bin`, { force: true })
        })
      ])
    })
    const tracked = current.then(() => undefined, () => undefined).finally(() => {
      if (this.journalLanes.get(laneKey) === tracked) this.journalLanes.delete(laneKey)
    })
    this.journalLanes.set(laneKey, tracked)
    await current
  }

  async read(projectPath: string, relativePath: string): Promise<WorkbenchDataReadResult> {
    const key = normalizeWorkbenchKey(relativePath)
    await this.waitForLane(this.laneKey(projectPath, key))
    return this.readCached(path.resolve(projectPath), key)
  }

  /** Fingerprint for rebuildable, streamed projections; never a validity substitute. */
  conversationProjectionCacheDirectory(): string { return path.join(this.userDataPath, 'conversation-page-cache', String(process.pid)) }

  /** The caller holds the conversation lock; preserve redundant snapshots without a giant JSON string. */
  async writeDocumentStream(projectPath: string, relativePath: string, chunks: AsyncIterable<string>): Promise<WorkbenchDataWriteResult> {
    const key = normalizeWorkbenchKey(relativePath)
    if (!key.startsWith('.modmind/conversations-v2/') || key.endsWith('/index.json')) throw new Error('Invalid streamed conversation key')
    await this.waitForLane(this.laneKey(projectPath, key))
    const directory = this.conversationProjectionCacheDirectory()
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `${randomUUID()}.document.tmp`), handle = await fs.open(temporary, 'wx', 0o600)
    const digest = createHash('sha256'); let bytes = 0
    try {
      try {
        for await (const text of chunks) {
          const chunk = Buffer.from(text, 'utf8'); bytes += chunk.length
          if (bytes > MAX_CONTENT_BYTES) throw new Error('工作台对话数据超过 256 MB 安全上限')
          digest.update(chunk); await handle.write(chunk)
        }
        await handle.sync()
      } finally { await handle.close() }
      const roots = this.roots(projectPath, key)
      const revisions = await Promise.all(Object.entries(roots).map(([replica, root]) => this.discoverCandidates(replica as ReplicaName, root)))
      const revision = Math.max(this.revisions.get(this.laneKey(projectPath, key)) ?? 0, ...revisions.map(r => r.maxRevision)) + 1
      const metadata: SnapshotMetadata = { schemaVersion: STORE_SCHEMA_VERSION, key, revision, checksum: digest.digest('hex'), contentBytes: bytes, committedAt: new Date().toISOString() }
      async function* payload(): AsyncGenerator<Buffer> { yield Buffer.from(JSON.stringify(metadata) + '\n'); yield* createReadStream(temporary) }
      const source = Readable.from(payload()), zipper = createGzip({ level: 6 }), compressed: Buffer[] = []
      source.on('error', error => zipper.destroy(error)); source.pipe(zipper)
      try { for await (const chunk of zipper) compressed.push(chunk as Buffer) } finally { source.destroy(); zipper.destroy() }
      const archive = Buffer.concat(compressed)
      const results = await Promise.allSettled(Object.values(roots).map(root => this.writeReplica(root, metadata, archive)))
      let compatibilityWritten = false
      try {
        const target = this.compatibilityPath(projectPath, key), copy = `${target}.${randomUUID()}.tmp`
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(temporary, copy)
        const durable = await fs.open(copy, 'r+'); try { await durable.sync() } finally { await durable.close() }
        try {
          await retryTransientFileLock(async () => {
            if (await pathExists(target)) { await fs.rm(`${target}.previous`, { force: true }); await fs.rename(target, `${target}.previous`) }
            await fs.rename(copy, target)
          })
          await syncDirectory(path.dirname(target)); compatibilityWritten = true
        } finally { await fs.rm(copy, { force: true }).catch(() => undefined) }
      } catch (error) { if (results.every(r => r.status === 'rejected')) throw error }
      if (!compatibilityWritten || results.some(r => r.status === 'rejected')) this.diagnostic({ level: 'warning', operation: 'commit-degraded', message: '对话已保存，部分冗余副本未同步', data: { key, revision, compatibilityWritten } })
      this.revisions.set(this.laneKey(projectPath, key), revision)
      this.snapshotNames.set(this.laneKey(projectPath, key), snapshotFileName(revision, metadata.checksum))
      this.dropReadCache(this.laneKey(projectPath, key))
      const copies = { project: results[0].status === 'fulfilled', mirror: results[1].status === 'fulfilled', compatibility: compatibilityWritten }
      return { revision, bytes, copies, durability: copies.project && copies.mirror ? 'redundant' : 'degraded', ...(copies.project && copies.mirror ? {} : { warning: '对话已保存到至少一个位置，但冗余备份未全部完成' }) }
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }

  async documentSignature(projectPath: string, relativePath: string): Promise<string> {
    const key = normalizeWorkbenchKey(relativePath)
    await this.waitForLane(this.laneKey(projectPath, key))
    return this.fingerprint(path.resolve(projectPath), key)
  }

  /** Read a verified snapshot incrementally without materializing/healing its entire JSON. */
  async streamDocument<T>(projectPath: string, relativePath: string, consume: (chunks: AsyncIterable<Buffer>) => Promise<T>): Promise<T | null> {
    const key = normalizeWorkbenchKey(relativePath)
    await this.waitForLane(this.laneKey(projectPath, key))
    const discovered = await Promise.all(Object.entries(this.roots(projectPath, key)).map(([replica, root]) => this.discoverCandidates(replica as ReplicaName, root)))
    const candidates = discovered.flatMap(item => item.candidates).sort((a, b) => b.advertisedRevision - a.advertisedRevision || Number(b.fromHead) - Number(a.fromHead))
    const failures: unknown[] = discovered.flatMap(item => item.errors)
    for (const candidate of candidates) {
      const source = createReadStream(path.join(candidate.root, 'revisions', candidate.file))
      const unzip = createGunzip()
      source.on('error', error => unzip.destroy(error))
      source.pipe(unzip)
      let metadata: SnapshotMetadata | undefined, bytes = 0
      const digest = createHash('sha256')
      async function* content(): AsyncGenerator<Buffer> {
        let header = Buffer.alloc(0)
        for await (const raw of unzip) {
          let chunk = raw as Buffer
          if (!metadata) {
            const separator = chunk.indexOf(10)
            if (separator < 0) { header = Buffer.concat([header, chunk]); if (header.length > 64 * 1024) throw new Error('Snapshot header too large'); continue }
            header = Buffer.concat([header, chunk.subarray(0, separator)])
            metadata = JSON.parse(header.toString('utf8')) as SnapshotMetadata
            if (metadata.schemaVersion !== STORE_SCHEMA_VERSION || metadata.key !== key || metadata.revision !== candidate.advertisedRevision) throw new Error('Invalid snapshot metadata')
            chunk = chunk.subarray(separator + 1)
          }
          bytes += chunk.length
          if (bytes > MAX_CONTENT_BYTES) throw new Error('工作台对话数据超过 256 MB 安全上限')
          digest.update(chunk)
          if (chunk.length) yield chunk
        }
      }
      try {
        // The JSON consumer validates the whole document before its derived result is published.
        const iterator = content(), first = await iterator.next()
        if (!metadata) throw new Error('Snapshot metadata missing')
        if (metadata.deleted) {
          while (!(await iterator.next()).done) { /* Validate the entire deletion record too. */ }
          if (metadata.contentBytes !== bytes || bytes !== 0 || metadata.checksum !== digest.digest('hex')) throw new Error('Invalid deletion snapshot')
          return null
        }
        async function* chunks(): AsyncGenerator<Buffer> { if (!first.done) yield first.value; yield* iterator }
        const result = await consume(chunks())
        if (metadata.contentBytes !== bytes || metadata.checksum !== digest.digest('hex')) throw new Error('Snapshot checksum mismatch')
        return result
      } catch (error) { failures.push(error) }
      finally { source.destroy(); unzip.destroy() }
    }
    const compatibility = this.compatibilityPath(projectPath, key)
    try {
      const stat = await fs.stat(compatibility)
      if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) throw new Error('Invalid conversation document')
      const source = createReadStream(compatibility)
      try { return await consume(source) } finally { source.destroy() }
    } catch (error) {
      if (isMissingFileError(error) && !candidates.length && !failures.length) return null
      failures.push(error)
      throw new AggregateError(failures, '工作台对话数据当前无法通过完整性校验，已阻止覆盖')
    }
  }

  withConversationLock<T>(projectPath: string, conversationId: string, operation: () => Promise<T>): Promise<T> {
    return withJournalLock(path.join(path.resolve(projectPath), '.modmind', 'workbench-store', `.conversation-${sha256(conversationId).slice(0, 24)}`), operation)
  }

  private dropReadCache(key: string): void {
    const prior = this.readCache.get(key)
    if (prior) this.readCacheBytes -= prior.bytes
    this.readCache.delete(key)
  }

  private async fingerprint(projectPath: string, key: string): Promise<string> {
    const roots = this.roots(projectPath, key), file = this.snapshotNames.get(this.laneKey(projectPath, key))
    const targets = [this.compatibilityPath(projectPath, key), ...Object.values(roots).flatMap(root => [path.join(root, 'HEAD.json'), path.join(root, 'HEAD.json.previous'), path.join(root, 'revisions'), ...(file ? [path.join(root, 'revisions', file)] : [])])]
    const tokens = await Promise.all(targets.map(async target => {
      try { const stat = await fs.stat(target); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }
      catch (error) { if (isMissingFileError(error)) return '-'; throw error }
    }))
    return tokens.join('|')
  }

  private async rememberRead(projectPath: string, key: string, result: WorkbenchDataReadResult): Promise<WorkbenchDataReadResult> {
    const laneKey = this.laneKey(projectPath, key)
    this.dropReadCache(laneKey)
    const bytes = Buffer.byteLength(result.content ?? '', 'utf8') * 2 + 1024
    if (bytes <= 64 * 1024 * 1024 && result.status !== 'unavailable') {
      this.readCache.set(laneKey, { result, bytes, fingerprint: await this.fingerprint(projectPath, key) })
      this.readCacheBytes += bytes
      while (this.readCacheBytes > 64 * 1024 * 1024 || this.readCache.size > 256) this.dropReadCache(this.readCache.keys().next().value!)
    }
    return result
  }

  private async readCached(projectPath: string, key: string): Promise<WorkbenchDataReadResult> {
    const laneKey = this.laneKey(projectPath, key), cached = this.readCache.get(laneKey)
    if (cached && cached.fingerprint === await this.fingerprint(projectPath, key)) {
      this.readCache.delete(laneKey); this.readCache.set(laneKey, cached)
      return cached.result
    }
    this.dropReadCache(laneKey)
    return this.rememberRead(projectPath, key, await this.readNow(projectPath, key, true))
  }

  write(projectPath: string, relativePath: string, content: string): Promise<WorkbenchDataWriteResult> {
    const key = normalizeWorkbenchKey(relativePath)
    const validation = validateContent(key, content)
    const written = this.enqueue({ projectPath: path.resolve(projectPath), key, content, deleted: false, validation, waiters: [] })
    // A coalesced malformed request must still reject its own caller even when
    // a later valid snapshot replaces it in the pending write lane.
    return Promise.all([validation, written]).then(([, result]) => result)
  }

  delete(projectPath: string, relativePath: string): Promise<WorkbenchDataWriteResult> {
    const key = normalizeWorkbenchKey(relativePath)
    return this.enqueue({ projectPath: path.resolve(projectPath), key, deleted: true, waiters: [] })
  }

  async flush(): Promise<void> {
    while (this.lanes.size || this.journalLanes.size) {
      const drains = [
        ...[...this.lanes.values()].map((lane) => lane.drain).filter((value): value is Promise<void> => Boolean(value)),
        ...this.journalLanes.values()
      ]
      if (!drains.length) break
      await Promise.allSettled(drains)
    }
  }

  async clearProjectMirror(projectPath: string): Promise<void> {
    const identity = normalizedProjectIdentity(projectPath)
    const projectIdentity = sha256(identity).slice(0, 24)
    await this.flush()
    await Promise.all([
      fs.rm(path.join(this.userDataPath, 'workbench-mirror', projectIdentity), { recursive: true, force: true }),
      fs.rm(path.join(this.userDataPath, 'workbench-journal', projectIdentity), { recursive: true, force: true })
    ])
    for (const key of this.revisions.keys()) if (key.startsWith(`${identity}\n`)) this.revisions.delete(key)
    for (const key of this.readCache.keys()) if (key.startsWith(`${identity}\n`)) this.dropReadCache(key)
    for (const key of this.snapshotNames.keys()) if (key.startsWith(`${identity}\n`)) this.snapshotNames.delete(key)
    this.journalIndex.clear()
  }

  private laneKey(projectPath: string, key: string): string {
    return `${normalizedProjectIdentity(projectPath)}\n${key}`
  }

  private async waitForLane(key: string): Promise<void> {
    const drain = this.lanes.get(key)?.drain
    if (drain) await drain
  }

  private enqueue(request: PendingWrite): Promise<WorkbenchDataWriteResult> {
    const key = this.laneKey(request.projectPath, request.key)
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { running: false }
      this.lanes.set(key, lane)
    }
    const result = new Promise<WorkbenchDataWriteResult>((resolve, reject) => {
      const waiter = { resolve, reject }
      if (lane!.pending) {
        lane!.pending = {
          ...request,
          waiters: [...lane!.pending.waiters, waiter]
        }
      } else {
        lane!.pending = { ...request, waiters: [waiter] }
      }
    })
    if (!lane.running) this.startLane(key, lane)
    return result
  }

  private startLane(key: string, lane: WriteLane): void {
    if (lane.running) return
    lane.running = true
    const drain = this.drainLane(key, lane).finally(() => {
      lane.running = false
      lane.drain = undefined
      if (lane.pending) this.startLane(key, lane)
      else this.lanes.delete(key)
    })
    lane.drain = drain
  }

  private async drainLane(key: string, lane: WriteLane): Promise<void> {
    while (lane.pending) {
      const request = lane.pending
      lane.pending = undefined
      try {
        const checked = request.validation ? await request.validation : undefined
        const result = await this.commit(request.projectPath, request.key, request.content ?? '', request.deleted, checked)
        for (const waiter of request.waiters) waiter.resolve(result)
      } catch (error) {
        for (const waiter of request.waiters) waiter.reject(error)
      }
    }
    this.diagnostic({ level: 'info', operation: 'flush', message: 'Workbench data write lane drained', data: { key } })
  }

  private roots(projectPath: string, key: string): Record<ReplicaName, string> {
    const document = documentDirectoryName(key)
    const projectIdentity = sha256(normalizedProjectIdentity(projectPath)).slice(0, 24)
    return {
      project: path.join(projectPath, '.modmind', 'workbench-store', document),
      mirror: path.join(this.userDataPath, 'workbench-mirror', projectIdentity, document)
    }
  }

  private compatibilityPath(projectPath: string, key: string): string {
    return path.join(projectPath, ...key.split('/'))
  }

  private async commit(projectPath: string, key: string, content: string, deleted: boolean, validated?: { bytes: number; checksum: string }): Promise<WorkbenchDataWriteResult> {
    const laneKey = this.laneKey(projectPath, key)
    const current = await this.readCached(projectPath, key)
    if (current.status === 'unavailable') throw new Error(current.message || '工作台对话数据当前无法安全写入')
    const currentRevision = current.revision
    const checked = deleted ? { bytes: 0, checksum: sha256('') } : validated ?? await validateContent(key, content)
    const revision = currentRevision + 1
    const metadata: SnapshotMetadata = {
      schemaVersion: STORE_SCHEMA_VERSION,
      key,
      revision,
      checksum: checked.checksum,
      contentBytes: checked.bytes,
      committedAt: new Date().toISOString(),
      ...(deleted ? { deleted: true } : {})
    }
    const compressed = await compressSnapshot(metadata, deleted ? '' : content)
    const roots = this.roots(projectPath, key)
    const replicaResults = await Promise.allSettled((Object.entries(roots) as Array<[ReplicaName, string]>).map(async ([replica, root]) => {
      await this.writeReplica(root, metadata, compressed)
      return replica
    }))
    const copies = { project: false, mirror: false, compatibility: false }
    const errors: unknown[] = []
    for (const result of replicaResults) {
      if (result.status === 'fulfilled') copies[result.value] = true
      else errors.push(result.reason)
    }
    try {
      const compatibility = this.compatibilityPath(projectPath, key)
      if (deleted) {
        if (await pathExists(compatibility)) {
          const deletedBackup = `${compatibility}.deleted-backup`
          await fs.rm(deletedBackup, { force: true })
          await retryTransientFileLock(() => fs.rename(compatibility, deletedBackup))
        }
      } else {
        await durableReplace(compatibility, content, true)
      }
      copies.compatibility = true
    } catch (error) {
      errors.push(error)
    }
    if (!copies.project && !copies.mirror && !copies.compatibility) {
      throw new AggregateError(errors, '工作台对话无法写入任何持久化副本')
    }
    this.revisions.set(laneKey, revision)
    this.snapshotNames.set(laneKey, snapshotFileName(revision, checked.checksum))
    await this.rememberRead(projectPath, key, deleted
      ? { status: 'missing', revision, source: 'tombstone' }
      : { status: 'ok', content, revision, source: copies.project ? 'project-store' : copies.mirror ? 'user-mirror' : 'legacy' })
    const redundant = copies.project && copies.mirror
    if (!redundant) {
      this.diagnostic({
        level: 'warning',
        operation: 'commit-degraded',
        message: '工作台对话已保存，但部分冗余副本写入失败',
        data: { key, revision, copies },
        error: errors[0]
      })
    }
    if (redundant && !copies.compatibility) {
      this.diagnostic({
        level: 'warning',
        operation: 'compatibility-export',
        message: '工作台对话已双重保存，但兼容 JSON 导出失败',
        data: { key, revision, copies },
        error: errors[0]
      })
    }
    return {
      revision,
      bytes: checked.bytes,
      durability: redundant ? 'redundant' : 'degraded',
      copies,
      ...(redundant ? {} : { warning: '对话已保存到至少一个位置，但冗余备份未全部完成' })
    }
  }

  private async writeReplica(root: string, metadata: SnapshotMetadata, compressed: Buffer): Promise<void> {
    const file = snapshotFileName(metadata.revision, metadata.checksum)
    const snapshotPath = path.join(root, 'revisions', file)
    await durableWriteImmutable(snapshotPath, compressed)
    const head: HeadRecord = { ...metadata, file }
    await durableReplace(path.join(root, 'HEAD.json'), `${JSON.stringify(head)}\n`, true)
    await appendCommit(root, head).catch((error) => {
      this.diagnostic({ level: 'warning', operation: 'commit-journal', message: '工作台提交日志写入失败', data: { root, revision: metadata.revision }, error })
    })
    await this.pruneReplica(root)
  }

  private async pruneReplica(root: string): Promise<void> {
    const directory = path.join(root, 'revisions')
    const entries = await fs.readdir(directory).catch(() => [])
    const snapshots = entries
      .map((file) => ({ file, revision: snapshotRevision(file) }))
      .filter((entry) => entry.revision >= 0)
      .sort((left, right) => right.revision - left.revision)
    for (const entry of snapshots.slice(RETAINED_REVISIONS)) {
      await fs.rm(path.join(directory, entry.file), { force: true }).catch(() => undefined)
    }
  }

  private async readNow(projectPath: string, key: string, heal: boolean): Promise<WorkbenchDataReadResult> {
    const roots = this.roots(projectPath, key)
    const discovered = await Promise.all((Object.entries(roots) as Array<[ReplicaName, string]>).map(([replica, root]) => this.discoverCandidates(replica, root)))
    const candidates = discovered.flatMap((item) => item.candidates).sort((left, right) => right.advertisedRevision - left.advertisedRevision || Number(right.fromHead) - Number(left.fromHead))
    const maxAdvertisedRevision = Math.max(0, ...discovered.map((item) => item.maxRevision))
    const failures: unknown[] = discovered.flatMap((item) => item.errors)
    let selected: ValidSnapshot | null = null
    for (const candidate of candidates) {
      try {
        const valid = await this.readSnapshot(candidate, key)
        if (!selected || valid.metadata.revision > selected.metadata.revision) selected = valid
      } catch (error) {
        failures.push(error)
      }
      if (selected && selected.metadata.revision >= candidate.advertisedRevision) break
    }
    if (selected) {
      const laneKey = this.laneKey(projectPath, key)
      this.revisions.set(laneKey, selected.metadata.revision)
      this.snapshotNames.set(laneKey, snapshotFileName(selected.metadata.revision, selected.metadata.checksum))
      if (heal) await this.heal(projectPath, key, selected, roots).catch((error) => {
        this.diagnostic({ level: 'warning', operation: 'read-heal', message: '工作台对话冗余副本自愈失败', data: { key, revision: selected!.metadata.revision }, error })
      })
      if (selected.metadata.deleted) return { status: 'missing', revision: selected.metadata.revision, source: 'tombstone' }
      const recovered = !selected.candidate.fromHead || discovered.some((item) => item.maxRevision < selected!.metadata.revision)
      return {
        status: 'ok',
        content: selected.content,
        revision: selected.metadata.revision,
        source: selected.candidate.replica === 'project' ? 'project-store' : 'user-mirror',
        recovered,
        ...(recovered ? { warning: '已从冗余副本或历史 revision 恢复对话' } : {})
      }
    }

    const compatibility = this.compatibilityPath(projectPath, key)
    try {
      const stat = await retryTransientFileLock(() => fs.stat(compatibility))
      if (!stat.isFile()) throw new Error('工作台对话数据不是普通文件')
      if (stat.size > MAX_CONTENT_BYTES) throw new Error('工作台对话数据超过 256 MB 安全上限')
      const content = await retryTransientFileLock(() => fs.readFile(compatibility, 'utf8'))
      await validateContent(key, content)
      const imported = await this.importCompatibility(projectPath, key, content, maxAdvertisedRevision + 1)
      return { status: 'ok', content, revision: imported.revision, source: 'legacy', recovered: maxAdvertisedRevision > 0, ...(maxAdvertisedRevision > 0 ? { warning: '已从兼容副本恢复对话' } : {}) }
    } catch (error) {
      if (isMissingFileError(error)) {
        if (!candidates.length && failures.length === 0) {
          this.revisions.set(this.laneKey(projectPath, key), maxAdvertisedRevision)
          return { status: 'missing', revision: maxAdvertisedRevision, source: 'none' }
        }
      } else {
        failures.push(error)
      }
    }
    const message = failures.length
      ? '工作台对话数据存在但无法通过完整性校验，已阻止覆盖'
      : '工作台对话数据当前无法读取，已阻止覆盖'
    this.diagnostic({ level: 'error', operation: 'read-unavailable', message, data: { key, candidates: candidates.length }, error: failures[0] })
    return { status: 'unavailable', revision: maxAdvertisedRevision, source: 'none', message }
  }

  private async importCompatibility(projectPath: string, key: string, content: string, revision: number): Promise<WorkbenchDataWriteResult> {
    const checked = await validateContent(key, content)
    const metadata: SnapshotMetadata = {
      schemaVersion: STORE_SCHEMA_VERSION,
      key,
      revision,
      checksum: checked.checksum,
      contentBytes: checked.bytes,
      committedAt: new Date().toISOString()
    }
    const compressed = await compressSnapshot(metadata, content)
    const roots = this.roots(projectPath, key)
    const results = await Promise.allSettled(Object.values(roots).map((root) => this.writeReplica(root, metadata, compressed)))
    const copies = {
      project: results[0]?.status === 'fulfilled',
      mirror: results[1]?.status === 'fulfilled',
      compatibility: true
    }
    if (!copies.project && !copies.mirror) {
      throw new AggregateError(results.filter((result) => result.status === 'rejected').map((result) => result.reason), '无法建立工作台对话冗余副本')
    }
    this.revisions.set(this.laneKey(projectPath, key), revision)
    this.snapshotNames.set(this.laneKey(projectPath, key), snapshotFileName(revision, checked.checksum))
    return { revision, bytes: checked.bytes, durability: copies.project && copies.mirror ? 'redundant' : 'degraded', copies }
  }

  private async discoverCandidates(replica: ReplicaName, root: string): Promise<{ candidates: SnapshotCandidate[]; maxRevision: number; errors: unknown[] }> {
    const candidates: SnapshotCandidate[] = []
    const errors: unknown[] = []
    let maxRevision = 0
    for (const headName of ['HEAD.json', 'HEAD.json.previous']) {
      try {
        const head = await readJsonFile<HeadRecord>(path.join(root, headName))
        if (!head || typeof head.file !== 'string' || !Number.isSafeInteger(head.revision)) continue
        maxRevision = Math.max(maxRevision, head.revision)
        candidates.push({ replica, root, file: head.file, advertisedRevision: head.revision, fromHead: true })
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      const entries = await fs.readdir(path.join(root, 'revisions'))
      for (const file of entries) {
        const revision = snapshotRevision(file)
        if (revision < 0) continue
        maxRevision = Math.max(maxRevision, revision)
        candidates.push({ replica, root, file, advertisedRevision: revision, fromHead: false })
      }
    } catch (error) {
      if (!isMissingFileError(error)) errors.push(error)
    }
    const unique = new Map(candidates.map((candidate) => [`${candidate.root}\n${candidate.file}`, candidate]))
    return { candidates: [...unique.values()], maxRevision, errors }
  }

  private async readSnapshot(candidate: SnapshotCandidate, expectedKey: string): Promise<ValidSnapshot> {
    const target = path.join(candidate.root, 'revisions', candidate.file)
    const stat = await retryTransientFileLock(() => fs.stat(target))
    if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) throw new Error(`Invalid workbench snapshot: ${candidate.file}`)
    const compressed = await retryTransientFileLock(() => fs.readFile(target))
    const payload = await decompressSnapshot(compressed)
    const separator = payload.indexOf(10)
    if (separator <= 0) throw new Error(`Workbench snapshot metadata is missing: ${candidate.file}`)
    const metadata = JSON.parse(payload.subarray(0, separator).toString('utf8')) as SnapshotMetadata
    const contentBuffer = payload.subarray(separator + 1)
    if (metadata.schemaVersion !== STORE_SCHEMA_VERSION || metadata.key !== expectedKey || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0) {
      throw new Error(`Workbench snapshot metadata is invalid: ${candidate.file}`)
    }
    if (metadata.revision !== candidate.advertisedRevision || metadata.contentBytes !== contentBuffer.byteLength || metadata.checksum !== sha256(contentBuffer)) {
      throw new Error(`Workbench snapshot checksum mismatch: ${candidate.file}`)
    }
    const content = contentBuffer.toString('utf8')
    if (!metadata.deleted) await validateContent(expectedKey, content)
    return { candidate, metadata, content, compressed }
  }

  private async heal(projectPath: string, key: string, selected: ValidSnapshot, roots: Record<ReplicaName, string>): Promise<void> {
    const file = snapshotFileName(selected.metadata.revision, selected.metadata.checksum)
    const head: HeadRecord = { ...selected.metadata, file }
    await Promise.allSettled((Object.entries(roots) as Array<[ReplicaName, string]>).map(async ([, root]) => {
      await durableWriteImmutable(path.join(root, 'revisions', file), selected.compressed)
      const currentHead = await readJsonFile<HeadRecord>(path.join(root, 'HEAD.json')).catch(() => null)
      if (!currentHead || currentHead.revision < selected.metadata.revision || currentHead.checksum !== selected.metadata.checksum) {
        await durableReplace(path.join(root, 'HEAD.json'), `${JSON.stringify(head)}\n`, true)
        await appendCommit(root, head).catch(() => undefined)
      }
    }))
    if (!selected.metadata.deleted) {
      const compatibility = this.compatibilityPath(projectPath, key)
      const current = await fs.readFile(compatibility, 'utf8').catch(() => '')
      if (sha256(Buffer.from(current, 'utf8')) !== selected.metadata.checksum) await durableReplace(compatibility, selected.content, true)
    }
  }
}
