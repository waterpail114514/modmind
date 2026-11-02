import { randomUUID } from 'node:crypto'
import type {
  AiOutputEvent,
  CodingBackend,
  ConversationCreateInput,
  ConversationDocument,
  ConversationEventRecord,
  ConversationEventsPage,
  ConversationForkInput,
  ConversationSummary,
  PipelineEvent
} from '../shared/types'
import { WorkbenchDataStore } from './workbenchDataStore'
import { ConversationProjectionPages } from './conversationProjectionPages'
import type { ConversationHistoryPage, ConversationHistoryPageInput } from '../shared/types'

const INDEX_KEY = '.modmind/conversations-v2/index.json'
const INDEX_CHECKPOINT_KEY = '.modmind/conversations-index-v1.json'
const INDEX_UPDATES_KEY = '.modmind/conversations-v3/index-updates.jsonl'
const PAGE_LIMIT = 5_000
type Surface = 'workspace' | 'inspiration'

function validId(value: string): boolean { return /^[a-z0-9][\w-]{0,127}$/iu.test(value) }
function documentKey(id: string): string {
  if (!validId(id)) throw new Error(`Invalid conversation id: ${id}`)
  return `.modmind/conversations-v2/${id}.json`
}
function journalKey(id: string): string {
  if (!validId(id)) throw new Error(`Invalid conversation id: ${id}`)
  return `.modmind/conversations-v3/${id}.jsonl`
}
function newId(surface: Surface): string { return `${surface === 'workspace' ? 'ws' : 'idea'}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}` }
function mergeStreamText(current: string, incoming: string): string {
  if (!current || incoming.startsWith(current)) return incoming
  if (!incoming || current.endsWith(incoming)) return current
  return `${current}${incoming}`
}
function summaryOf(document: ConversationDocument): ConversationSummary {
  const { id, surface, title, createdAt, updatedAt, generation, archived, parent, agentMode, pinned, titleSource } = document
  return { id, surface, title, createdAt, updatedAt, generation, ...(agentMode ? { agentMode } : {}), ...(pinned ? { pinned } : {}), ...(titleSource ? { titleSource } : {}), ...(archived ? { archived } : {}), ...(parent ? { parent } : {}) }
}
function normalizeSummary(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<ConversationSummary>
  if (typeof entry.id !== 'string' || !validId(entry.id) || (entry.surface !== 'workspace' && entry.surface !== 'inspiration')) return null
  return {
    id: entry.id, surface: entry.surface,
    ...(entry.agentMode === 'beginner' ? { agentMode: 'beginner' as const } : {}),
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : '新的对话',
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
    generation: Number.isSafeInteger(entry.generation) && Number(entry.generation) >= 0 ? Number(entry.generation) : 0,
    ...(entry.pinned === true ? { pinned: true } : {}),
    ...(entry.titleSource === 'ai' || entry.titleSource === 'manual' ? { titleSource: entry.titleSource } : {}),
    ...(entry.archived ? { archived: true } : {}),
    ...(entry.parent && typeof entry.parent === 'object' ? { parent: entry.parent } : {})
  }
}
function normalizeDocument(value: unknown): ConversationDocument | null {
  const summary = normalizeSummary(value)
  if (!summary || !value || typeof value !== 'object') return null
  const entry = value as Partial<ConversationDocument>
  const events = Array.isArray(entry.events)
    ? entry.events.filter((event): event is ConversationEventRecord => Boolean(event && typeof event === 'object'
      && typeof event.eventId === 'string' && event.conversationId === summary.id
      && event.generation === summary.generation && typeof event.turnId === 'string'
      && Number.isSafeInteger(event.sequence))).sort((left, right) => left.sequence - right.sequence)
    : []
  const lastSequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), Math.max(0, Number.isSafeInteger(entry.lastSequence) ? Number(entry.lastSequence) : 0))
  const native = entry.native && typeof entry.native === 'object' ? entry.native : {}
  const nativeTurns = entry.nativeTurns && typeof entry.nativeTurns === 'object' ? entry.nativeTurns : {}
  const view = entry.view && typeof entry.view === 'object' ? entry.view : {}
  const checkpointSequence = Number.isSafeInteger(entry.checkpointSequence) && Number(entry.checkpointSequence) >= 0 ? Number(entry.checkpointSequence) : 0
  return { ...summary, schemaVersion: 2, lastSequence, checkpointSequence, events, view, native, nativeTurns, ...(entry.nativeTurnStarts ? { nativeTurnStarts: entry.nativeTurnStarts } : {}), ...(entry.nativeForkPending ? { nativeForkPending: true } : {}) }
}

function parseJournalLines(lines: string[], conversationId: string, generation: number): ConversationEventRecord[] {
  const records = new Map<string, ConversationEventRecord>()
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Partial<ConversationEventRecord>
      if (typeof value.eventId !== 'string' || typeof value.conversationId !== 'string'
        || value.conversationId !== conversationId || value.generation !== generation
        || typeof value.turnId !== 'string' || !Number.isSafeInteger(value.sequence)
        || (value.kind !== 'user' && value.kind !== 'progress' && value.kind !== 'output' && value.kind !== 'system')
        || typeof value.time !== 'string') continue
      const prior = records.get(value.eventId)
      if (!prior || Number(value.sequence) >= prior.sequence) records.set(value.eventId, value as ConversationEventRecord)
    } catch { /* A torn final line is ignored; the other replica remains readable. */ }
  }
  return [...records.values()].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
}

function storedDocument(document: ConversationDocument): ConversationDocument { return { ...document, events: [] } }

function checkpointView(document: ConversationDocument, generation: number, view: ConversationDocument['view'], title?: string): ConversationDocument {
  if (document.generation !== generation) throw new Error('对话已产生新分支，已拒绝旧页面覆盖')
  const checkpointSequence = Math.max(document.checkpointSequence, Math.min(document.lastSequence, viewSequence(view)))
  // A renderer projection never replaces the original event truth.
  return { ...document, view, checkpointSequence, ...(!document.titleSource && title?.trim() ? { title: title.trim() } : {}), updatedAt: new Date().toISOString() }
}

function viewSequence(view: ConversationDocument['view']): number {
  const entries = Array.isArray(view.timeline) ? view.timeline : Array.isArray(view.messages) ? view.messages : []
  return entries.reduce<number>((maximum, entry) => Math.max(maximum, entry && typeof entry === 'object' && Number.isSafeInteger((entry as { sequence?: number }).sequence) ? Number((entry as { sequence?: number }).sequence) : 0), 0)
}

function viewTurnIds(view: ConversationDocument['view']): Set<string> {
  const entries = Array.isArray(view.timeline) ? view.timeline : Array.isArray(view.messages) ? view.messages : []
  return new Set(entries.flatMap((entry) => entry && typeof entry === 'object' && typeof (entry as { turnId?: unknown }).turnId === 'string'
    ? [String((entry as { turnId: string }).turnId)]
    : []))
}

function resetViewSequences(view: ConversationDocument['view']): ConversationDocument['view'] {
  const reset = (entries: unknown[] | undefined): unknown[] | undefined => entries?.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const next = { ...(entry as Record<string, unknown>) }
    delete next.sequence
    return next
  })
  return {
    ...(Array.isArray(view.timeline) ? { timeline: reset(view.timeline) } : {}),
    ...(Array.isArray(view.messages) ? { messages: reset(view.messages) as ConversationDocument['view']['messages'] } : {})
  }
}

export class ConversationStore {
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly documents = new Map<string, { content: string; document: ConversationDocument; bytes: number }>()
  private documentBytes = 0
  private indexClock = 0
  private readonly indexWrites = new Map<string, number>()
  private readonly checkpoints = new Map<string, { content: string; throughOrder: string; entries: ConversationSummary[]; bytes: number }>()
  private checkpointBytes = 0
  private readonly eventBatches = new Map<string, {
    projectPath: string
    conversationId: string
    generation: number
    updateIndex: boolean
    items: Array<{ turnId: string; kind: ConversationEventRecord['kind']; payload: unknown; runId?: string; resolve: (event: ConversationEventRecord) => void; reject: (error: unknown) => void }>
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly projectionPages: ConversationProjectionPages
  constructor(private readonly data: WorkbenchDataStore) { this.projectionPages = new ConversationProjectionPages(data, data.conversationProjectionCacheDirectory()) }

  /** Native resume only needs metadata; it must not allocate the saved view/journal. */
  async readContext(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    if (!validId(conversationId)) throw new Error('对话标识无效')
    return this.enqueue(projectPath, conversationId, async () => {
      const snapshot = await this.projectionPages.snapshot(projectPath, conversationId)
      return snapshot ? snapshot.document : null
    })
  }

  hasUserTurn(projectPath: string, id: string, generation: number, turnId: string): Promise<boolean> {
    return this.enqueue(projectPath, id, async () => {
      let snapshot = await this.projectionPages.snapshot(projectPath, id)
      if (snapshot?.embeddedEvents) { await this.readProjectionUnlocked(projectPath, id); snapshot = await this.projectionPages.snapshot(projectPath, id) }
      if (!snapshot || snapshot.document.generation !== generation) return false
      // An optimistic renderer row has no event sequence yet and still needs its journal boundary.
      for await (const { item } of this.projectionPages.items(snapshot)) if (item.kind === 'user' && item.turnId === turnId && Number.isSafeInteger(item.sequence)) return true
      let after = 0
      while (true) {
        const events = await this.data.conversationJournalPage(projectPath, journalKey(id), id, generation, after, 100)
        if (events.some(event => event.kind === 'user' && event.turnId === turnId)) return true
        if (!events.length || events.at(-1)!.sequence <= after) return false
        after = events.at(-1)!.sequence
      }
    })
  }

  saveHistoryWindow(projectPath: string, conversationId: string, generation: number, token: string, start: number, items: unknown[]): Promise<ConversationHistoryPage | null> {
    if (!validId(conversationId)) throw new Error('对话标识无效')
    return this.enqueue(projectPath, conversationId, async () => {
      const snapshot = await this.projectionPages.snapshot(projectPath, conversationId)
      if (!snapshot || snapshot.document.generation !== generation || snapshot.token !== token) throw new Error('对话已变化，未覆盖旧历史，请重新载入')
      const field = snapshot.document.surface === 'workspace' ? 'timeline' : 'messages'
      const state = await this.data.conversationJournalState(projectPath, journalKey(conversationId), conversationId, generation)
      const current = { ...snapshot.document, lastSequence: Math.max(state.lastSequence, snapshot.document.lastSequence) }
      const document = checkpointView(current, generation, { [field]: items })
      const writeResult = await this.projectionPages.write(projectPath, conversationId, snapshot, document, { start, items })
      this.forgetDocument(this.laneKey(projectPath, conversationId))
      await this.writeIndexChange(projectPath, conversationId, summaryOf(document))
      const updated = await this.projectionPages.snapshot(projectPath, conversationId)
      if (!updated) throw new Error('对话保存后无法回读')
      return { document: updated.document, items: [], start, end: updated.rows.length, total: updated.rows.length, token: updated.token, nextBefore: start > 0 ? start : null, writeResult, dialoguePrefix: await this.projectionPages.dialoguePrefix(updated, start) }
    })
  }

  async historyPage(projectPath: string, conversationId: string, input: ConversationHistoryPageInput = {}): Promise<ConversationHistoryPage | null> {
    if (!validId(conversationId)) throw new Error('对话标识无效')
    if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0)) throw new Error('历史位置无效')
    if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0 || input.before !== undefined)) throw new Error('历史位置无效')
    return this.enqueue(projectPath, conversationId, async () => {
      let snapshot = await this.projectionPages.snapshot(projectPath, conversationId)
      if (!snapshot) return null
      if (snapshot.embeddedEvents) {
        // One-time legacy migration retains the existing authoritative-event behavior.
        await this.readProjectionUnlocked(projectPath, conversationId)
        snapshot = await this.projectionPages.snapshot(projectPath, conversationId)
        if (!snapshot) return null
      }
      if (input.token && input.token !== snapshot.token || input.generation !== undefined && input.generation !== snapshot.document.generation) throw new Error('对话已更新，请重新载入历史')
      const page = await this.projectionPages.page(snapshot, input.before, input.limit, input.after)
      const state = await this.data.conversationJournalState(projectPath, journalKey(conversationId), conversationId, snapshot.document.generation)
      return { document: { ...snapshot.document, lastSequence: Math.max(snapshot.document.lastSequence, state.lastSequence) },
        items: page.items, start: page.start, end: page.end, total: snapshot.rows.length, token: snapshot.token, nextBefore: page.start > 0 ? page.start : null,
        ...(input.before === undefined && input.after === undefined ? { dialoguePrefix: await this.projectionPages.dialoguePrefix(snapshot, page.start) } : {}) }
    })
  }

  async list(projectPath: string, surface?: Surface, includeArchived = false): Promise<ConversationSummary[]> {
    await this.wait(projectPath, '$conversation-index')
    return (await this.readIndex(projectPath))
      .filter((entry) => (!surface || entry.surface === surface) && (includeArchived || !entry.archived))
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.updatedAt.localeCompare(left.updatedAt))
  }

  private async readIndex(projectPath: string): Promise<ConversationSummary[]> {
    const checkpoint = await this.readIndexCheckpoint(projectPath)
    let parsed: unknown = checkpoint?.entries ?? []
    if (!checkpoint) {
      const stored = await this.data.read(projectPath, INDEX_KEY)
      if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话索引当前无法读取')
      if (stored.status === 'ok' && stored.content) {
        try { parsed = JSON.parse(stored.content) } catch { throw new Error('对话索引格式无效') }
      }
    }
    if (!Array.isArray(parsed)) throw new Error('对话索引格式无效')
    const entries = new Map(parsed.map(normalizeSummary).filter((entry): entry is ConversationSummary => Boolean(entry)).map(entry => [entry.id, entry]))
    const changes = new Map<string, { order: string; summary: ConversationSummary | null }>()
    for (const line of await this.data.readJournal(projectPath, INDEX_UPDATES_KEY, true)) {
      try {
        const value = JSON.parse(line) as { id?: string; order?: string; summary?: unknown; deleted?: boolean }
        if (!value.id || !validId(value.id) || typeof value.order !== 'string') continue
        if (checkpoint && value.order <= checkpoint.throughOrder) continue
        const summary = value.deleted ? null : normalizeSummary(value.summary)
        if (!value.deleted && (!summary || summary.id !== value.id)) continue
        if (!changes.has(value.id) || changes.get(value.id)!.order < value.order) changes.set(value.id, { order: value.order, summary })
      } catch { /* Recover valid records from the other replicas after a torn write. */ }
    }
    for (const [id, value] of changes) { if (value.summary) entries.set(id, value.summary); else entries.delete(id) }
    return [...entries.values()]
  }

  private async readIndexCheckpoint(projectPath: string): Promise<{ throughOrder: string; entries: ConversationSummary[] } | null> {
    const stored = await this.data.read(projectPath, INDEX_CHECKPOINT_KEY), key = this.laneKey(projectPath, '$conversation-index')
    const prior = this.checkpoints.get(key)
    if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话索引当前无法读取')
    if (stored.status === 'ok' && prior && prior.content === stored.content) {
      this.checkpoints.delete(key); this.checkpoints.set(key, prior); return prior
    }
    if (prior) { this.checkpointBytes -= prior.bytes; this.checkpoints.delete(key) }
    if (stored.status !== 'ok' || !stored.content) return null
    let parsed: { schemaVersion?: number; throughOrder?: string; entries?: unknown }
    try { parsed = JSON.parse(stored.content) } catch { throw new Error('对话索引格式无效') }
    if (parsed.schemaVersion !== 1 || typeof parsed.throughOrder !== 'string' || !Array.isArray(parsed.entries)) throw new Error('对话索引格式无效')
    const entries = parsed.entries.map(normalizeSummary).filter((entry): entry is ConversationSummary => Boolean(entry))
    const checkpoint = { content: stored.content, throughOrder: parsed.throughOrder, entries, bytes: Buffer.byteLength(stored.content, 'utf8') * 4 + 1024 }
    if (checkpoint.bytes <= 64 * 1024 * 1024) {
      this.checkpoints.set(key, checkpoint); this.checkpointBytes += checkpoint.bytes
      while (this.checkpointBytes > 64 * 1024 * 1024 || this.checkpoints.size > 16) {
        const oldest = this.checkpoints.keys().next().value!, entry = this.checkpoints.get(oldest)!
        this.checkpointBytes -= entry.bytes; this.checkpoints.delete(oldest)
      }
    }
    return checkpoint
  }

  async read(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    await this.wait(projectPath, conversationId)
    return this.readUnlocked(projectPath, conversationId)
  }

  async readProjection(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    await this.wait(projectPath, conversationId)
    const document = await this.readProjectionUnlocked(projectPath, conversationId)
    return document ? { ...document, events: [] } : null
  }

  ensureProjection(projectPath: string, input: ConversationCreateInput): Promise<ConversationDocument> {
    return this.createInternal(projectPath, input, false)
  }

  async create(projectPath: string, input: ConversationCreateInput): Promise<ConversationDocument> {
    return this.createInternal(projectPath, input, true)
  }

  private async createInternal(projectPath: string, input: ConversationCreateInput, full: boolean): Promise<ConversationDocument> {
    const id = input.id?.trim() || newId(input.surface)
    if (!validId(id)) throw new Error('对话标识无效')
    return this.enqueue(projectPath, id, async () => {
      const existing = await (full ? this.readUnlocked(projectPath, id) : this.readProjectionUnlocked(projectPath, id))
      if (existing) {
        if (input.agentMode === 'beginner' && existing.surface === 'workspace' && !existing.agentMode) {
          existing.agentMode = 'beginner'
          await this.writeDocumentUnlocked(projectPath, existing)
        }
        return existing
      }
      const now = new Date().toISOString()
      const document: ConversationDocument = {
        schemaVersion: 2, id, surface: input.surface,
        ...(input.surface === 'workspace' && input.agentMode === 'beginner' ? { agentMode: 'beginner' as const } : {}),
        title: input.title?.trim() || '新的对话', createdAt: now, updatedAt: now,
        generation: 0, lastSequence: 0, checkpointSequence: 0, events: [], view: input.view ?? {}, native: {}, nativeTurns: {}
      }
      await this.writeDocumentUnlocked(projectPath, document)
      return document
    })
  }

  saveView(projectPath: string, conversationId: string, generation: number, view: ConversationDocument['view'], title?: string): Promise<ConversationDocument> {
    return this.update(projectPath, conversationId, document => checkpointView(document, generation, view, title), true, true)
  }

  saveProjection(projectPath: string, conversationId: string, generation: number, view: ConversationDocument['view'], title?: string): Promise<ConversationDocument> {
    return this.update(projectPath, conversationId, document => checkpointView(document, generation, view, title))
  }

  replaceView(projectPath: string, conversationId: string, generation: number, view: ConversationDocument['view']): Promise<ConversationDocument> {
    return this.enqueue(projectPath, conversationId, async () => {
      const document = await this.readUnlocked(projectPath, conversationId)
      if (!document) throw new Error('对话不存在')
      if (document.generation !== generation) throw new Error('对话已更新，请重新载入后再删除')
      const next: ConversationDocument = {
        ...document, generation: generation + 1, updatedAt: new Date().toISOString(),
        view: resetViewSequences(view), events: [], lastSequence: 0, checkpointSequence: 0,
        native: {}, nativeTurns: {}, nativeTurnStarts: {}, nativeForkPending: false,
        parent: undefined
      }
      // Commit the new generation first: even after a crash, old journal replicas
      // and delayed renderer saves cannot restore the removed history.
      await this.writeDocumentUnlocked(projectPath, next)
      await this.data.deleteJournal(projectPath, journalKey(conversationId))
      return next
    })
  }

  appendUser(projectPath: string, conversationId: string, generation: number, turnId: string, payload: unknown, runId?: string): Promise<ConversationEventRecord> {
    return this.appendEvent(projectPath, conversationId, generation, turnId, 'user', payload, runId, true)
  }
  appendProgress(projectPath: string, event: PipelineEvent): Promise<PipelineEvent> { return this.appendRouted(projectPath, 'progress', event) as Promise<PipelineEvent> }
  appendOutput(projectPath: string, event: AiOutputEvent): Promise<AiOutputEvent> { return this.appendRouted(projectPath, 'output', event) as Promise<AiOutputEvent> }

  eventsSince(projectPath: string, conversationId: string, generation: number, afterSequence = 0, limit = PAGE_LIMIT): Promise<ConversationEventsPage> {
    return this.enqueue(projectPath, conversationId, async () => {
      let snapshot = await this.projectionPages.snapshot(projectPath, conversationId)
      if (snapshot?.embeddedEvents) { await this.readProjectionUnlocked(projectPath, conversationId); snapshot = await this.projectionPages.snapshot(projectPath, conversationId) }
      const document = snapshot?.document
      if (!document) return { conversationId, generation, checkpointSequence: 0, events: [], nextSequence: null }
      if (document.generation !== generation) throw new Error('对话已更新，请重新载入历史')
      const bounded = Math.min(10_000, Math.max(1, Math.floor(limit)))
      const remaining = await this.data.conversationJournalPage(projectPath, journalKey(conversationId), conversationId, generation, afterSequence, bounded)
      const events = remaining.slice(0, bounded)
      return { conversationId, generation, checkpointSequence: document.checkpointSequence, events, nextSequence: remaining.length > events.length ? events.at(-1)!.sequence : null }
    })
  }

  async fork(projectPath: string, input: ConversationForkInput): Promise<ConversationDocument> {
    if (input.historyItemId) return this.forkPagedHistory(projectPath, input)
    return this.enqueue(projectPath, '$conversation-lifecycle', () => this.forkUnlocked(projectPath, input))
  }

  deleteHistoryItem(projectPath: string, id: string, generation: number, itemId: string): Promise<ConversationDocument> {
    if (!validId(id)) return Promise.reject(new Error('对话标识无效'))
    return this.enqueue(projectPath, id, async () => {
      const snapshot = await this.projectionPages.snapshot(projectPath, id)
      if (!snapshot || snapshot.document.generation !== generation) throw new Error('对话已更新，请重新载入后再删除')
      const state = await this.data.conversationJournalState(projectPath, journalKey(id), id, generation)
      if (state.lastSequence > snapshot.document.checkpointSequence || snapshot.embeddedEvents) throw new Error('最新消息尚未保存，请重新载入后再删除')
      let start = -1, end = -1, lastUser = -1, found = false
      for await (const { index, item } of this.projectionPages.items(snapshot)) {
        if (found && item.kind === 'user') { end = index; break }
        if (item.id === itemId) {
          found = true
          if (item.kind === 'user') { start = index; end = snapshot.rows.length }
          else { start = lastUser + 1; end = index + 1; break }
        }
        if (item.kind === 'user') lastUser = index
      }
      if (!found) throw new Error('这条消息尚未保存，请稍后重试')
      const document: ConversationDocument = { ...snapshot.document, generation: generation + 1, updatedAt: new Date().toISOString(), lastSequence: 0, checkpointSequence: 0, events: [], view: {}, native: {}, nativeTurns: {}, nativeTurnStarts: {}, nativeForkPending: false, parent: undefined }
      await this.projectionPages.write(projectPath, id, snapshot, document, undefined, (item, index) => {
        if (index >= start && index < end) return null
        const { sequence: _sequence, ...rest } = item; return rest
      })
      await this.data.deleteJournal(projectPath, journalKey(id)); this.forgetDocument(this.laneKey(projectPath, id))
      await this.writeIndexChange(projectPath, id, summaryOf(document))
      return document
    })
  }

  private forkPagedHistory(projectPath: string, input: ConversationForkInput): Promise<ConversationDocument> {
    if (!validId(input.sourceConversationId)) return Promise.reject(new Error('对话标识无效'))
    return this.enqueue(projectPath, '$conversation-lifecycle', () => this.enqueue(projectPath, input.sourceConversationId, async () => {
      const snapshot = await this.projectionPages.snapshot(projectPath, input.sourceConversationId)
      if (!snapshot || snapshot.document.surface !== 'workspace') throw new Error('原对话不存在')
      const source = snapshot.document, id = input.id?.trim() || newId(source.surface)
      if (!validId(id) || await this.projectionPages.snapshot(projectPath, id)) throw new Error('分支对话标识无效或已存在')
      const retained = new Set<string>(); let end = -1, selected: Record<string, unknown> | undefined
      for await (const { index, item } of this.projectionPages.items(snapshot)) {
        if (item.id === input.historyItemId) { selected = item; end = item.kind === 'user' ? index : index + 1; if (item.kind !== 'user' && typeof item.turnId === 'string') retained.add(item.turnId); break }
        if (typeof item.turnId === 'string') retained.add(item.turnId)
      }
      if (!selected || end < 0) throw new Error('分支边界消息尚未保存，请稍后重试')
      const turnId = typeof selected.turnId === 'string' ? selected.turnId : undefined
      const before = selected.kind === 'user', native = input.backend ? source.native[input.backend] : undefined
      const nativeTurn = input.backend && turnId ? (before ? source.nativeTurnStarts?.[turnId]?.[input.backend] : undefined) ?? source.nativeTurns[turnId]?.[input.backend] : undefined
      const nativeMode = native?.sessionId && nativeTurn ? 'native' : 'visible-history-rebuild'
      const document: ConversationDocument = { schemaVersion: 2, id, surface: source.surface, ...(source.agentMode ? { agentMode: source.agentMode } : {}), title: input.title?.trim() || `${source.title}（分支）`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), generation: source.generation + 1, lastSequence: 0, checkpointSequence: 0, events: [], view: {},
        native: nativeMode === 'native' && input.backend ? { [input.backend]: { ...native!, lastTurnId: nativeTurn } } : {},
        nativeTurns: nativeMode === 'native' ? Object.fromEntries(Object.entries(source.nativeTurns).filter(([turn]) => retained.has(turn))) : {},
        nativeTurnStarts: nativeMode === 'native' ? Object.fromEntries(Object.entries(source.nativeTurnStarts ?? {}).filter(([turn]) => retained.has(turn))) : {},
        ...(nativeMode === 'native' ? { nativeForkPending: true } : {}),
        parent: { conversationId: source.id, generation: source.generation, ...(turnId ? { turnId } : {}), ...(nativeTurn ? { nativeTurnId: nativeTurn, boundary: before ? 'before' as const : 'through' as const } : {}), nativeMode } }
      await this.projectionPages.write(projectPath, id, snapshot, document, { start: end, items: [] }, item => { const { sequence: _sequence, ...rest } = item; return rest })
      await this.writeIndexChange(projectPath, id, summaryOf(document))
      return document
    }))
  }

  private async forkUnlocked(projectPath: string, input: ConversationForkInput): Promise<ConversationDocument> {
    const source = await this.read(projectPath, input.sourceConversationId)
    if (!source) throw new Error('要分支的原对话不存在')
    const id = input.id?.trim() || newId(source.surface)
    if (!validId(id)) throw new Error('分支对话标识无效')
    if (input.beforeTurnId && input.throughTurnId) throw new Error('分支只能指定一个 turn 边界')
    const sequence = Number.isSafeInteger(input.throughSequence) ? Number(input.throughSequence) : undefined
    const retainedTurnIds = viewTurnIds(input.view)
    const knownTurnIds = new Set([
      ...viewTurnIds(source.view),
      ...source.events.map((event) => event.turnId),
      ...Object.keys(source.nativeTurns),
      ...Object.values(source.native).flatMap((state) => state?.lastModmindTurnId ? [state.lastModmindTurnId] : [])
    ])
    if (input.throughTurnId && !knownTurnIds.has(input.throughTurnId)) throw new Error('分支终点不在原对话中')
    if (input.beforeTurnId && !knownTurnIds.has(input.beforeTurnId)) throw new Error('分支边界不在原对话中')
    const forkView = resetViewSequences(input.view)
    const now = new Date().toISOString()
    const sourceNative = input.backend ? source.native[input.backend] : undefined
    const branchTurnId = input.beforeTurnId ?? input.throughTurnId
    const mappedNativeTurn = branchTurnId && input.backend
      ? (input.beforeTurnId ? source.nativeTurnStarts?.[branchTurnId]?.[input.backend] : undefined) ?? source.nativeTurns[branchTurnId]?.[input.backend]
      : sourceNative?.lastTurnId
    const nativeMode = Boolean(sourceNative?.sessionId)
      && (!branchTurnId || Boolean(mappedNativeTurn))
      ? 'native'
      : 'visible-history-rebuild'
    const document: ConversationDocument = {
      schemaVersion: 2, id, surface: source.surface,
      ...(source.agentMode ? { agentMode: source.agentMode } : {}),
      title: input.title?.trim() || `${source.title}（分支）`, createdAt: now, updatedAt: now,
      generation: source.generation + 1, lastSequence: 0, checkpointSequence: 0, events: [],
      view: forkView,
      native: sourceNative && nativeMode === 'native' && input.backend ? { [input.backend]: { ...sourceNative, ...(mappedNativeTurn ? { lastTurnId: mappedNativeTurn } : {}) } } : {},
      nativeTurns: nativeMode === 'native' ? Object.fromEntries(Object.entries(source.nativeTurns).filter(([turnId]) => retainedTurnIds.has(turnId))) : {},
      nativeTurnStarts: nativeMode === 'native' ? Object.fromEntries(Object.entries(source.nativeTurnStarts ?? {}).filter(([turnId]) => retainedTurnIds.has(turnId))) : {},
      ...(nativeMode === 'native' ? { nativeForkPending: true } : {}),
      parent: { conversationId: source.id, generation: source.generation,
        ...((input.beforeTurnId || input.throughTurnId) ? { turnId: input.beforeTurnId ?? input.throughTurnId } : {}),
        ...(mappedNativeTurn ? { nativeTurnId: mappedNativeTurn, boundary: input.beforeTurnId ? 'before' as const : 'through' as const } : {}),
        ...(sequence !== undefined ? { sequence } : {}), nativeMode }
    }
    await this.writeDocument(projectPath, document)
    return document
  }

  archive(projectPath: string, conversationId: string, archived: boolean): Promise<ConversationDocument> {
    return this.update(projectPath, conversationId, (document) => ({ ...document, archived, updatedAt: new Date().toISOString() }))
  }
  rename(projectPath: string, conversationId: string, title: string): Promise<ConversationDocument> {
    const clean = title.replaceAll(/\s+/gu, ' ').trim()
    if (!clean || clean.length > 120) throw new Error('对话名称须为 1 至 120 个字符')
    return this.update(projectPath, conversationId, (document) => ({ ...document, title: clean, titleSource: 'manual' }))
  }
  pin(projectPath: string, conversationId: string, pinned: boolean): Promise<ConversationDocument> {
    return this.update(projectPath, conversationId, (document) => ({ ...document, pinned }))
  }
  setGeneratedTitle(projectPath: string, conversationId: string, title: string): Promise<ConversationDocument> {
    const clean = title.replaceAll(/\s+/gu, ' ').trim().slice(0, 60)
    if (!clean) throw new Error('AI 未返回有效对话名称')
    return this.update(projectPath, conversationId, (document) => document.titleSource
      ? document : { ...document, title: clean, titleSource: 'ai' })
  }
  async delete(projectPath: string, conversationId: string, deleteNative?: (sessions: ConversationDocument['native']) => Promise<void>): Promise<void> {
    // A branch must not borrow a native session after it has been selected for
    // deletion. Keep the ownership check, external deletion, and document
    // removal in the same project lane used by the complete fork operation.
    await this.enqueue(projectPath, '$conversation-lifecycle', async () => {
      if (deleteNative) await deleteNative(await this.nativeSessionsForDeletion(projectPath, conversationId))
      await this.enqueue(projectPath, conversationId, async () => {
        await this.data.delete(projectPath, documentKey(conversationId))
        await this.data.deleteJournal(projectPath, journalKey(conversationId))
        this.forgetDocument(this.laneKey(projectPath, conversationId))
        await this.writeIndexChange(projectPath, conversationId, null)
      })
    })
  }
  async nativeSessionsForDeletion(projectPath: string, conversationId: string): Promise<ConversationDocument['native']> {
    const document = await this.read(projectPath, conversationId)
    // An unmaterialized branch borrows its parent's native session.
    if (!document || document.nativeForkPending) return {}
    const others = await Promise.all((await this.list(projectPath, undefined, true))
      .filter(entry => entry.id !== conversationId).map(entry => this.read(projectPath, entry.id)))
    return Object.fromEntries(Object.entries(document.native).filter(([, state]) => state?.sessionId
      && !others.some(other => Object.values(other?.native ?? {}).some(candidate => candidate?.sessionId === state.sessionId
        && candidate.sessionHome === state.sessionHome))))
  }
  setNativeState(projectPath: string, conversationId: string, generation: number, backend: CodingBackend, sessionId: string, lastTurnId?: string, modmindTurnId?: string, sessionHome?: string): Promise<ConversationDocument> {
    return this.updateContext(projectPath, conversationId, (document) => {
      if (document.generation !== generation) return document
      const prior = document.native[backend]
      const changedThread = Boolean(prior && prior.sessionId !== sessionId && !document.nativeForkPending)
      const withoutBackend = (values: ConversationDocument['nativeTurns']): ConversationDocument['nativeTurns'] =>
        Object.fromEntries(Object.entries(values).map(([id, mappings]) => {
          const next = { ...mappings }; delete next[backend]; return [id, next]
        }))
      const nativeTurns = changedThread ? withoutBackend(document.nativeTurns) : document.nativeTurns
      const nativeTurnStarts = changedThread ? withoutBackend(document.nativeTurnStarts ?? {}) : document.nativeTurnStarts ?? {}
      const retained = changedThread ? undefined : prior
      return {
        ...document, nativeForkPending: false, updatedAt: new Date().toISOString(),
        native: { ...document.native, [backend]: {
          sessionId,
          ...(sessionHome || retained?.sessionHome ? { sessionHome: sessionHome ?? retained?.sessionHome } : {}),
          ...(modmindTurnId || retained?.lastModmindTurnId ? { lastModmindTurnId: modmindTurnId ?? retained?.lastModmindTurnId } : {}),
          ...(lastTurnId || retained?.lastTurnId ? { lastTurnId: lastTurnId ?? retained?.lastTurnId } : {}),
          updatedAt: new Date().toISOString()
        } },
        nativeTurns: modmindTurnId && lastTurnId ? { ...nativeTurns, [modmindTurnId]: { ...nativeTurns[modmindTurnId], [backend]: lastTurnId } } : nativeTurns,
        nativeTurnStarts: modmindTurnId && lastTurnId ? { ...nativeTurnStarts, [modmindTurnId]: { ...nativeTurnStarts[modmindTurnId], [backend]: nativeTurnStarts[modmindTurnId]?.[backend] ?? lastTurnId } } : nativeTurnStarts
      }
    })
  }

  private updateContext(projectPath: string, id: string, update: (document: ConversationDocument) => ConversationDocument): Promise<ConversationDocument> {
    return this.enqueue(projectPath, id, async () => {
      const snapshot = await this.projectionPages.snapshot(projectPath, id)
      if (!snapshot) throw new Error('对话不存在')
      if (snapshot.embeddedEvents) {
        const document = await this.readProjectionUnlocked(projectPath, id)
        if (!document) throw new Error('对话不存在')
        const next = update(document); if (next !== document) await this.writeDocumentUnlocked(projectPath, next)
        return next
      }
      const next = update(snapshot.document)
      if (next !== snapshot.document) {
        await this.projectionPages.write(projectPath, id, snapshot, next)
        this.forgetDocument(this.laneKey(projectPath, id))
        await this.writeIndexChange(projectPath, id, summaryOf(next))
      }
      return next
    })
  }
  async flush(): Promise<void> {
    await Promise.allSettled([...this.eventBatches.keys()].map((key) => this.flushEventBatch(key)))
    await Promise.allSettled([...this.lanes.values()])
    await this.data.flush()
  }

  private async appendRouted(projectPath: string, kind: 'progress' | 'output', value: PipelineEvent | AiOutputEvent): Promise<PipelineEvent | AiOutputEvent> {
    if (!value.conversationId || !value.turnId || !Number.isSafeInteger(value.generation)) return value
    const immediate = kind === 'output'
      ? (value as AiOutputEvent).kind !== 'delta' && !((value as AiOutputEvent).kind === 'reasoning' && (value as AiOutputEvent).reasoning?.phase === 'delta')
      : (value as PipelineEvent).stage === 'complete' || (value as PipelineEvent).stage === 'error'
    const record = await this.appendEvent(projectPath, value.conversationId, Number(value.generation), value.turnId, kind, value, value.runId, immediate)
    return { ...value, sequence: record.sequence, eventId: record.eventId }
  }
  private appendEvent(projectPath: string, conversationId: string, generation: number, turnId: string, kind: ConversationEventRecord['kind'], payload: unknown, runId?: string, immediate = false): Promise<ConversationEventRecord> {
    const key = this.laneKey(projectPath, conversationId)
    const result = new Promise<ConversationEventRecord>((resolve, reject) => {
      let batch = this.eventBatches.get(key)
      if (!batch) {
        const timer = setTimeout(() => { void this.flushEventBatch(key) }, 75)
        timer.unref?.()
        batch = { projectPath, conversationId, generation, updateIndex: immediate, items: [], timer }
        this.eventBatches.set(key, batch)
      }
      if (batch.generation !== generation) { reject(new Error('事件属于旧对话分支，已拒绝写入')); return }
      if (immediate) batch.updateIndex = true
      batch.items.push({ turnId, kind, payload, ...(runId ? { runId } : {}), resolve, reject })
    })
    if (immediate) void this.flushEventBatch(key)
    return result
  }
  private async flushEventBatch(key: string): Promise<void> {
    const batch = this.eventBatches.get(key)
    if (!batch) return
    this.eventBatches.delete(key)
    clearTimeout(batch.timer)
    const appended: ConversationEventRecord[] = []
    try {
      await this.enqueue(batch.projectPath, batch.conversationId, async () => {
        const snapshot = await this.projectionPages.snapshot(batch.projectPath, batch.conversationId)
        const document = snapshot?.embeddedEvents ? await this.readProjectionUnlocked(batch.projectPath, batch.conversationId) : snapshot?.document
        if (!document) throw new Error('对话不存在')
        if (document.generation !== batch.generation) throw new Error('事件属于旧对话分支，已拒绝写入')
        let sequence = Math.max(0, document.lastSequence, await this.data.conversationJournalTail(batch.projectPath, journalKey(batch.conversationId), batch.conversationId, batch.generation))
        for (const item of batch.items) {
          sequence += 1
          const record: ConversationEventRecord = { eventId: randomUUID(), conversationId: batch.conversationId, generation: batch.generation, turnId: item.turnId, ...(item.runId ? { runId: item.runId } : {}), sequence, kind: item.kind, time: new Date().toISOString(), payload: item.payload }
          appended.push(record)
        }
        const serialized = appended.map(record => `${JSON.stringify(record)}\n`)
        const sizes = serialized.map(line => Buffer.byteLength(line, 'utf8'))
        if (sizes.some(bytes => bytes > 8 * 1024 * 1024)) throw new Error('Conversation journal record exceeds 8 MB')
        let chunk: string[] = [], bytes = 0
        for (let index = 0; index < serialized.length; index += 1) {
          if (bytes && bytes + sizes[index] > 4 * 1024 * 1024) {
            await this.data.appendJournal(batch.projectPath, journalKey(batch.conversationId), chunk.join(''))
            chunk = []; bytes = 0
          }
          chunk.push(serialized[index]); bytes += sizes[index]
        }
        if (chunk.length) await this.data.appendJournal(batch.projectPath, journalKey(batch.conversationId), chunk.join(''))
        if (batch.updateIndex) await this.writeIndexChange(batch.projectPath, document.id, summaryOf({ ...document, lastSequence: sequence, updatedAt: appended.at(-1)?.time ?? document.updatedAt }))
      })
      batch.items.forEach((item, index) => item.resolve(appended[index]))
    } catch (error) {
      batch.items.forEach((item) => item.reject(error))
    }
  }
  private update(projectPath: string, conversationId: string, update: (document: ConversationDocument) => ConversationDocument | Promise<ConversationDocument>, updateIndex = true, full = false): Promise<ConversationDocument> {
    return this.enqueue(projectPath, conversationId, async () => {
      const document = await (full ? this.readUnlocked(projectPath, conversationId) : this.readProjectionUnlocked(projectPath, conversationId))
      if (!document) throw new Error('对话不存在')
      const next = await update(document)
      if (next !== document) await this.writeDocumentUnlocked(projectPath, next, updateIndex)
      return next
    })
  }
  private async writeDocument(projectPath: string, document: ConversationDocument): Promise<void> { await this.enqueue(projectPath, document.id, () => this.writeDocumentUnlocked(projectPath, document)) }
  private async writeDocumentUnlocked(projectPath: string, document: ConversationDocument, updateIndex = true): Promise<void> {
    await this.data.write(projectPath, documentKey(document.id), JSON.stringify(storedDocument(document)))
    this.forgetDocument(this.laneKey(projectPath, document.id))
    if (updateIndex) await this.writeIndexChange(projectPath, document.id, summaryOf(document))
  }
  private forgetDocument(key: string): void {
    const prior = this.documents.get(key)
    if (prior) this.documentBytes -= prior.bytes
    this.documents.delete(key)
  }
  private async readMetadataUnlocked(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    const stored = await this.data.read(projectPath, documentKey(conversationId))
    const key = this.laneKey(projectPath, conversationId)
    if (stored.status === 'missing') { this.forgetDocument(key); return null }
    if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话当前无法读取')
    const cached = this.documents.get(key)
    if (cached && cached.content === stored.content) {
      this.documents.delete(key); this.documents.set(key, cached)
      return cached.document
    }
    this.forgetDocument(key)
    let parsed: unknown
    try { parsed = JSON.parse(stored.content ?? 'null') } catch { throw new Error('对话数据格式无效') }
    const document = normalizeDocument(parsed)
    if (!document) throw new Error('对话数据无法通过完整性校验')
    const bytes = Buffer.byteLength(stored.content ?? '', 'utf8') * 4 + 1024
    if (bytes <= 128 * 1024 * 1024) {
      this.documents.set(key, { content: stored.content!, document, bytes }); this.documentBytes += bytes
      while (this.documentBytes > 128 * 1024 * 1024 || this.documents.size > 128) this.forgetDocument(this.documents.keys().next().value!)
    }
    return document
  }
  private async readProjectionUnlocked(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    let document = await this.readMetadataUnlocked(projectPath, conversationId)
    if (!document) return null
    // Migrate embedded v2 events before a projection-only caller relies on pages.
    if (document.events.length) {
      document = (await this.readUnlocked(projectPath, conversationId))!
      await this.writeDocumentUnlocked(projectPath, document, false)
    }
    const state = await this.data.conversationJournalState(projectPath, journalKey(conversationId), conversationId, document.generation)
    const lastSequence = Math.max(document.lastSequence, state.lastSequence)
    const updatedAt = state.updatedAt && Date.parse(state.updatedAt) > Date.parse(document.updatedAt) ? state.updatedAt : document.updatedAt
    return { ...document, events: [], lastSequence, updatedAt }
  }
  private async readUnlocked(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    const document = await this.readMetadataUnlocked(projectPath, conversationId)
    if (!document) return null
    const journal = parseJournalLines(await this.data.readJournal(projectPath, journalKey(conversationId)), conversationId, document.generation)
    const merged = new Map(journal.map((event) => [event.eventId, event]))
    for (const event of document.events) if (!merged.has(event.eventId)) {
      merged.set(event.eventId, event)
      await this.data.appendJournal(projectPath, journalKey(conversationId), `${JSON.stringify(event)}\n`)
    }
    const events = [...merged.values()].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    const updatedAt = events.reduce((latest, event) => {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
      const terminal = event.kind === 'user' || (event.kind === 'output' && payload.kind !== 'delta' && !(payload.kind === 'reasoning' && (payload as Partial<AiOutputEvent>).reasoning?.phase === 'delta')) || (event.kind === 'progress' && (payload.stage === 'complete' || payload.stage === 'error'))
      return terminal && Date.parse(event.time) > Date.parse(latest) ? event.time : latest
    }, document.updatedAt)
    return { ...document, events, updatedAt, lastSequence: events.reduce((maximum, event) => Math.max(maximum, event.sequence), Math.max(0, document.lastSequence)) }
  }

  private writeIndexChange(projectPath: string, id: string, summary: ConversationSummary | null): Promise<void> {
    return this.enqueue(projectPath, '$conversation-index', async () => {
      // The old index remains a compatible baseline. Single-object changes use
      // the existing durable three-copy journal instead of recompressing it.
      const checkpoint = await this.readIndexCheckpoint(projectPath)
      if (checkpoint) this.indexClock = Math.max(this.indexClock, Number(checkpoint.throughOrder.split('-')[0]) || 0)
      for (const line of await this.data.journalLastLines(projectPath, INDEX_UPDATES_KEY)) {
        try {
          const order = (JSON.parse(line) as { order?: unknown }).order
          if (typeof order === 'string') this.indexClock = Math.max(this.indexClock, Number(order.split('-')[0]) || 0)
        } catch { /* Ignore a torn last record. */ }
      }
      this.indexClock = Math.max(Date.now(), this.indexClock + 1)
      const change = { id, order: `${String(this.indexClock).padStart(16, '0')}-${randomUUID()}`, ...(summary ? { summary } : { deleted: true }) }
      await this.data.appendJournal(projectPath, INDEX_UPDATES_KEY, `${JSON.stringify(change)}\n`)
      const key = this.laneKey(projectPath, '$conversation-index'), count = (this.indexWrites.get(key) ?? 0) + 1
      this.indexWrites.set(key, count)
      if (count >= 1_024 || ((count === 1 || count % 64 === 0) && await this.data.journalByteSize(projectPath, INDEX_UPDATES_KEY) >= 4 * 1024 * 1024)) {
        const entries = await this.readIndex(projectPath)
        // Entries and watermark form one checksummed atomic snapshot. Even if
        // cleanup leaves an older replica behind, its absorbed summaries cannot
        // resurrect a deleted conversation after restart.
        await this.data.write(projectPath, INDEX_CHECKPOINT_KEY, JSON.stringify({ schemaVersion: 1, throughOrder: change.order, entries }))
        await this.data.write(projectPath, INDEX_KEY, JSON.stringify(entries))
        await this.data.deleteJournal(projectPath, INDEX_UPDATES_KEY)
        this.indexWrites.set(key, 0)
      }
    })
  }
  private laneKey(projectPath: string, conversationId: string): string { return `${projectPath.toLowerCase()}\n${conversationId}` }
  private wait(projectPath: string, conversationId: string): Promise<unknown> { return this.lanes.get(this.laneKey(projectPath, conversationId)) ?? Promise.resolve() }
  private enqueue<T>(projectPath: string, conversationId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.laneKey(projectPath, conversationId)
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.data.withConversationLock(projectPath, conversationId, operation))
    const tracked = current.then(() => undefined, () => undefined).finally(() => { if (this.lanes.get(key) === tracked) this.lanes.delete(key) })
    this.lanes.set(key, tracked)
    return current
  }
}
