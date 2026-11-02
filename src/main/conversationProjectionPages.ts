import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSONParser } from '@streamparser/json'
import type { WorkbenchDataStore } from './workbenchDataStore'
import type { ConversationDocument, WorkbenchDataWriteResult } from '../shared/types'
import { normalizeAiTurnReplay, replayUserText } from '../shared/aiReplay'
import { splitDiscussionChoices } from '../shared/discussionChoices'

type Offset = { start: number; bytes: number }
type Snapshot = { signature: string; token: string; document: ConversationDocument; rows: Offset[]; embeddedEvents: number; file: string }
const fields = ['id', 'surface', 'title', 'createdAt', 'updatedAt', 'generation', 'schemaVersion', 'lastSequence', 'checkpointSequence', 'native', 'nativeTurns', 'nativeTurnStarts', 'nativeForkPending', 'parent', 'agentMode', 'pinned', 'titleSource', 'archived']

/** Disposable JSONL/offset projection. Original snapshots and journals remain authoritative. */
export class ConversationProjectionPages {
  private readonly entries = new Map<string, Snapshot>()
  private cleanup: Promise<void> | undefined
  constructor(private readonly data: WorkbenchDataStore, private readonly directory: string) {}

  private async prepareDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    this.cleanup ??= (async () => {
      const parent = path.dirname(this.directory)
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/u.test(entry.name) || entry.name === path.basename(this.directory)) continue
        const target = path.resolve(parent, entry.name)
        if (path.dirname(target) !== path.resolve(parent)) continue
        try { process.kill(Number(entry.name), 0); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue }
        // Only disposable caches from exited processes are removed.
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      }
    })().catch(() => undefined)
    await this.cleanup
  }

  async snapshot(project: string, id: string): Promise<Snapshot | null> {
    const key = `.modmind/conversations-v2/${id}.json`
    const signature = await this.data.documentSignature(project, key)
    const identity = createHash('sha256').update(`${path.resolve(project)}\n${id}`).digest('hex')
    const prior = this.entries.get(identity)
    if (prior?.signature === signature) { this.entries.delete(identity); this.entries.set(identity, prior); return prior }
    await this.prepareDirectory()
    const temporary = path.join(this.directory, `${identity}-${randomUUID()}.jsonl`)
    try {
      const result = await this.data.streamDocument(project, key, async chunks => {
        const handle = await fs.open(temporary, 'w', 0o600)
        const document: Record<string, unknown> = {}, rows: Offset[] = []
        let offset = 0, embeddedEvents = 0, pending: string[] = []
        const viewHash = createHash('sha256')
        const parser = new JSONParser({ paths: [...fields.map(name => `$.${name}`), '$.view.timeline.*', '$.view.messages.*', '$.events.*'], keepStack: false, stringBufferSize: 64 * 1024 })
        parser.onValue = ({ value, key: property, stack }) => {
          if (stack.length === 1 && typeof property === 'string') { Object.defineProperty(document, property, { value, enumerable: true, configurable: true }); return }
          if (stack.length === 2 && stack[1]?.key === 'events') { embeddedEvents++; return }
          if (stack.length !== 3 || stack[1]?.key !== 'view') return
          const line = JSON.stringify(value) + '\n', bytes = Buffer.byteLength(line)
          rows.push({ start: offset, bytes }); offset += bytes; pending.push(line); viewHash.update(line)
        }
        try {
          for await (const chunk of chunks) {
            parser.write(chunk)
            if (pending.length) { await handle.write(pending.join('')); pending = [] }
          }
          if (!parser.isEnded) parser.end()
          if (pending.length) await handle.write(pending.join(''))
        } finally { await handle.close() }
        if (document.id !== id || !['workspace', 'inspiration'].includes(String(document.surface)) || !Number.isSafeInteger(document.generation) || !Number.isSafeInteger(document.lastSequence)) throw new Error('对话数据无法通过完整性校验')
        return { signature, token: viewHash.digest('hex'), document: { ...document, events: [], view: {}, native: document.native ?? {}, nativeTurns: document.nativeTurns ?? {} } as unknown as ConversationDocument, rows, embeddedEvents, file: temporary }
      })
      if (!result) { await fs.rm(temporary, { force: true }); return null }
      if (signature !== await this.data.documentSignature(project, key)) throw new Error('对话保存状态已变化，请重新载入')
      if (prior) await fs.rm(prior.file, { force: true }).catch(() => undefined)
      this.entries.set(identity, result)
      while (this.entries.size > 8) {
        const oldest = this.entries.keys().next().value!, evicted = this.entries.get(oldest)!
        this.entries.delete(oldest); await fs.rm(evicted.file, { force: true }).catch(() => undefined)
      }
      return result
    } catch (error) { await fs.rm(temporary, { force: true }); throw error }
  }

  async *items(snapshot: Snapshot, end = snapshot.rows.length): AsyncGenerator<{ index: number; item: Record<string, unknown> }> {
    const handle = await fs.open(snapshot.file, 'r')
    try {
      for (let index = 0; index < end; index++) {
        const row = snapshot.rows[index], buffer = Buffer.allocUnsafe(row.bytes)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, row.start)
        if (bytesRead !== row.bytes) throw new Error('历史缓存不完整，请重新载入')
        yield { index, item: JSON.parse(buffer.toString('utf8')) }
      }
    } finally { await handle.close() }
  }

  async dialoguePrefix(snapshot: Snapshot, end: number): Promise<string> {
    let text = ''
    for await (const { item } of this.items(snapshot, end)) {
      if ((item.kind !== 'user' && item.kind !== 'answer') || typeof item.content !== 'string') continue
      const content = item.kind === 'user' ? replayUserText(item.content, normalizeAiTurnReplay(item.replay)) : splitDiscussionChoices(item.content).content
      text = `${text}${text ? '\n' : ''}${item.kind === 'user' ? '用户' : 'AI'}：${content}`.slice(-120_000)
    }
    return text
  }

  async write(project: string, id: string, snapshot: Snapshot, document: ConversationDocument, replacement?: { start: number; items: unknown[] }, transform?: (item: Record<string, unknown>, index: number) => unknown | null): Promise<WorkbenchDataWriteResult> {
    const end = replacement?.start ?? snapshot.rows.length
    if (!Number.isSafeInteger(end) || end < 0 || end > snapshot.rows.length) throw new Error('历史范围已变化，请重新载入')
    const field = document.surface === 'workspace' ? 'timeline' : 'messages'
    async function* chunks(): AsyncGenerator<string> {
      const { view: _view, events: _events, ...metadata } = document
      yield JSON.stringify(metadata).slice(0, -1) + `,"events":[],"view":{"${field}":[`
      const handle = await fs.open(snapshot.file, 'r')
      let count = 0, emitted = 0
      try {
        for (const row of snapshot.rows.slice(0, end)) {
          const buffer = Buffer.allocUnsafe(row.bytes), { bytesRead } = await handle.read(buffer, 0, buffer.length, row.start)
          if (bytesRead !== row.bytes) throw new Error('历史缓存不完整，保存已停止')
          const value = transform ? transform(JSON.parse(buffer.toString('utf8')), count) : undefined
          if (transform && value === null) { count++; continue }
          yield (emitted++ ? ',' : '') + (transform ? JSON.stringify(value) : buffer.toString('utf8').trimEnd()); count++
        }
        for (const item of replacement?.items ?? []) yield (emitted++ ? ',' : '') + JSON.stringify(item)
      } finally { await handle.close() }
      yield ']}}'
    }
    return this.data.writeDocumentStream(project, `.modmind/conversations-v2/${id}.json`, chunks())
  }

  async page(snapshot: Snapshot, before = snapshot.rows.length, limit = 100, after?: number): Promise<{ items: unknown[]; start: number; end: number }> {
    let end = Math.max(0, Math.min(snapshot.rows.length, Math.floor(before)))
    let start = after === undefined ? end : Math.min(snapshot.rows.length, after), bytes = 0
    if (after !== undefined) end = start
    while ((after === undefined ? start > 0 : end < snapshot.rows.length) && end - start < Math.max(1, Math.min(200, limit))) {
      const next = snapshot.rows[after === undefined ? start - 1 : end].bytes
      if (bytes && bytes + next > 2 * 1024 * 1024) break
      if (after === undefined) start--; else end++
      bytes += next
    }
    const items: unknown[] = [], handle = await fs.open(snapshot.file, 'r')
    try {
      for (const row of snapshot.rows.slice(start, end)) {
        const buffer = Buffer.allocUnsafe(row.bytes)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, row.start)
        if (bytesRead !== buffer.length) throw new Error('对话缓存不完整，请重新载入')
        items.push(JSON.parse(buffer.toString('utf8')))
      }
    } finally { await handle.close() }
    return { items, start, end }
  }
}
