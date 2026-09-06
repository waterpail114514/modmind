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

const INDEX_KEY = '.modmind/conversations-v2/index.json'
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
  const { id, surface, title, createdAt, updatedAt, generation, archived, parent } = document
  return { id, surface, title, createdAt, updatedAt, generation, ...(archived ? { archived } : {}), ...(parent ? { parent } : {}) }
}
function normalizeSummary(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<ConversationSummary>
  if (typeof entry.id !== 'string' || !validId(entry.id) || (entry.surface !== 'workspace' && entry.surface !== 'inspiration')) return null
  return {
    id: entry.id, surface: entry.surface,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : '新的对话',
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
    generation: Number.isSafeInteger(entry.generation) && Number(entry.generation) >= 0 ? Number(entry.generation) : 0,
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
  const lastSequence = Math.max(Number.isSafeInteger(entry.lastSequence) ? Number(entry.lastSequence) : 0, ...events.map((event) => event.sequence), 0)
  const native = entry.native && typeof entry.native === 'object' ? entry.native : {}
  const nativeTurns = entry.nativeTurns && typeof entry.nativeTurns === 'object' ? entry.nativeTurns : {}
  const view = entry.view && typeof entry.view === 'object' ? entry.view : {}
  const checkpointSequence = Number.isSafeInteger(entry.checkpointSequence) && Number(entry.checkpointSequence) >= 0 ? Number(entry.checkpointSequence) : 0
  return { ...summary, schemaVersion: 2, lastSequence, checkpointSequence, events, view, native, nativeTurns, ...(entry.nativeForkPending ? { nativeForkPending: true } : {}) }
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

function viewSequence(view: ConversationDocument['view']): number {
  const entries = Array.isArray(view.timeline) ? view.timeline : Array.isArray(view.messages) ? view.messages : []
  return Math.max(0, ...entries.map((entry) => entry && typeof entry === 'object' && Number.isSafeInteger((entry as { sequence?: number }).sequence) ? Number((entry as { sequence?: number }).sequence) : 0))
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
  private readonly eventBatches = new Map<string, {
    projectPath: string
    conversationId: string
    generation: number
    updateIndex: boolean
    items: Array<{ turnId: string; kind: ConversationEventRecord['kind']; payload: unknown; runId?: string; resolve: (event: ConversationEventRecord) => void; reject: (error: unknown) => void }>
    timer: ReturnType<typeof setTimeout>
  }>()
  constructor(private readonly data: WorkbenchDataStore) {}

  async list(projectPath: string, surface?: Surface, includeArchived = false): Promise<ConversationSummary[]> {
    await this.wait(projectPath, '$conversation-index')
    const stored = await this.data.read(projectPath, INDEX_KEY)
    if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话索引当前无法读取')
    if (stored.status !== 'ok' || !stored.content) return []
    let parsed: unknown
    try { parsed = JSON.parse(stored.content) } catch { throw new Error('对话索引格式无效') }
    if (!Array.isArray(parsed)) throw new Error('对话索引格式无效')
    return parsed.map(normalizeSummary).filter((entry): entry is ConversationSummary => Boolean(entry))
      .filter((entry) => (!surface || entry.surface === surface) && (includeArchived || !entry.archived))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async read(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    await this.wait(projectPath, conversationId)
    return this.readUnlocked(projectPath, conversationId)
  }

  async create(projectPath: string, input: ConversationCreateInput): Promise<ConversationDocument> {
    const id = input.id?.trim() || newId(input.surface)
    if (!validId(id)) throw new Error('对话标识无效')
    return this.enqueue(projectPath, id, async () => {
      const existing = await this.readUnlocked(projectPath, id)
      if (existing) return existing
      const now = new Date().toISOString()
      const document: ConversationDocument = {
        schemaVersion: 2, id, surface: input.surface,
        title: input.title?.trim() || '新的对话', createdAt: now, updatedAt: now,
        generation: 0, lastSequence: 0, checkpointSequence: 0, events: [], view: input.view ?? {}, native: {}, nativeTurns: {}
      }
      await this.writeDocumentUnlocked(projectPath, document)
      return document
    })
  }

  saveView(projectPath: string, conversationId: string, generation: number, view: ConversationDocument['view'], title?: string): Promise<ConversationDocument> {
    return this.update(projectPath, conversationId, (document) => {
      if (document.generation !== generation) throw new Error('对话已产生新分支，已拒绝旧页面覆盖')
      const checkpointSequence = Math.max(document.checkpointSequence, Math.min(document.lastSequence, viewSequence(view)))
      // The view is a renderer projection, never the source of truth. Keep the
      // complete event journal so a repaired projection can be rebuilt after a
      // crash or an older client has written an incomplete view.
      return { ...document, view, checkpointSequence, ...(title?.trim() ? { title: title.trim() } : {}), updatedAt: new Date().toISOString() }
    })
  }

  appendUser(projectPath: string, conversationId: string, generation: number, turnId: string, payload: unknown, runId?: string): Promise<ConversationEventRecord> {
    return this.appendEvent(projectPath, conversationId, generation, turnId, 'user', payload, runId, true)
  }
  appendProgress(projectPath: string, event: PipelineEvent): Promise<PipelineEvent> { return this.appendRouted(projectPath, 'progress', event) as Promise<PipelineEvent> }
  appendOutput(projectPath: string, event: AiOutputEvent): Promise<AiOutputEvent> { return this.appendRouted(projectPath, 'output', event) as Promise<AiOutputEvent> }

  eventsSince(projectPath: string, conversationId: string, generation: number, afterSequence = 0, limit = PAGE_LIMIT): Promise<ConversationEventsPage> {
    return this.read(projectPath, conversationId).then((document) => {
      if (!document || document.generation !== generation) return { conversationId, generation, checkpointSequence: 0, events: [], nextSequence: null }
      const bounded = Math.min(10_000, Math.max(1, Math.floor(limit)))
      const remaining = document.events.filter((event) => event.sequence > afterSequence)
      const events = remaining.slice(0, bounded)
      return { conversationId, generation, checkpointSequence: document.checkpointSequence, events, nextSequence: remaining.length > events.length ? events.at(-1)!.sequence : null }
    })
  }

  async fork(projectPath: string, input: ConversationForkInput): Promise<ConversationDocument> {
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
    const mappedNativeTurn = branchTurnId && input.backend ? source.nativeTurns[branchTurnId]?.[input.backend] : sourceNative?.lastTurnId
    const claudeAtHead = Boolean(input.throughTurnId && !input.beforeTurnId && input.throughTurnId === sourceNative?.lastModmindTurnId)
    const nativeMode = Boolean(sourceNative?.sessionId)
      && (input.backend === 'claude' ? !branchTurnId || claudeAtHead : !branchTurnId || Boolean(mappedNativeTurn))
      ? 'native'
      : 'visible-history-rebuild'
    const document: ConversationDocument = {
      schemaVersion: 2, id, surface: source.surface,
      title: input.title?.trim() || `${source.title}（分支）`, createdAt: now, updatedAt: now,
      generation: source.generation + 1, lastSequence: 0, checkpointSequence: 0, events: [],
      view: forkView,
      native: sourceNative && nativeMode === 'native' && input.backend ? { [input.backend]: { ...sourceNative, ...(mappedNativeTurn ? { lastTurnId: mappedNativeTurn } : {}) } } : {},
      nativeTurns: Object.fromEntries(Object.entries(source.nativeTurns).filter(([turnId]) => retainedTurnIds.has(turnId))),
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
  async delete(projectPath: string, conversationId: string): Promise<void> {
    await this.enqueue(projectPath, conversationId, async () => {
      await this.data.delete(projectPath, documentKey(conversationId))
      await this.data.deleteJournal(projectPath, journalKey(conversationId))
      await this.mutateIndex(projectPath, (entries) => entries.filter((entry) => entry.id !== conversationId))
    })
  }
  setNativeState(projectPath: string, conversationId: string, generation: number, backend: CodingBackend, sessionId: string, lastTurnId?: string, modmindTurnId?: string, sessionHome?: string): Promise<ConversationDocument> {
    return this.update(projectPath, conversationId, (document) => {
      if (document.generation !== generation) return document
      const prior = document.native[backend]
      return { ...document, nativeForkPending: false, updatedAt: new Date().toISOString(), native: { ...document.native, [backend]: { sessionId, ...(sessionHome || prior?.sessionHome ? { sessionHome: sessionHome ?? prior?.sessionHome } : {}), ...(modmindTurnId || prior?.lastModmindTurnId ? { lastModmindTurnId: modmindTurnId ?? prior?.lastModmindTurnId } : {}), ...(lastTurnId || prior?.lastTurnId ? { lastTurnId: lastTurnId ?? prior?.lastTurnId } : {}), updatedAt: new Date().toISOString() } }, nativeTurns: modmindTurnId && lastTurnId ? { ...document.nativeTurns, [modmindTurnId]: { ...document.nativeTurns[modmindTurnId], [backend]: lastTurnId } } : document.nativeTurns }
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
      ? (value as AiOutputEvent).kind !== 'delta'
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
        const document = await this.readUnlocked(batch.projectPath, batch.conversationId)
        if (!document) throw new Error('瀵硅瘽涓嶅瓨鍦?')
        if (document.generation !== batch.generation) throw new Error('事件属于旧对话分支，已拒绝写入')
        let sequence = Math.max(document.lastSequence, ...document.events.map((event) => event.sequence), 0)
        for (const item of batch.items) {
          sequence += 1
          const record: ConversationEventRecord = { eventId: randomUUID(), conversationId: batch.conversationId, generation: batch.generation, turnId: item.turnId, ...(item.runId ? { runId: item.runId } : {}), sequence, kind: item.kind, time: new Date().toISOString(), payload: item.payload }
          appended.push(record)
        }
        await this.data.appendJournal(batch.projectPath, journalKey(batch.conversationId), `${appended.map((record) => JSON.stringify(record)).join('\n')}\n`)
        if (batch.updateIndex) await this.writeDocumentUnlocked(batch.projectPath, { ...document, lastSequence: sequence, events: [], updatedAt: appended.at(-1)?.time ?? document.updatedAt })
      })
      batch.items.forEach((item, index) => item.resolve(appended[index]))
    } catch (error) {
      batch.items.forEach((item) => item.reject(error))
    }
  }
  private update(projectPath: string, conversationId: string, update: (document: ConversationDocument) => ConversationDocument | Promise<ConversationDocument>, updateIndex = true): Promise<ConversationDocument> {
    return this.enqueue(projectPath, conversationId, async () => {
      const document = await this.readUnlocked(projectPath, conversationId)
      if (!document) throw new Error('对话不存在')
      const next = await update(document)
      if (next !== document) await this.writeDocumentUnlocked(projectPath, next, updateIndex)
      return next
    })
  }
  private async writeDocument(projectPath: string, document: ConversationDocument): Promise<void> { await this.enqueue(projectPath, document.id, () => this.writeDocumentUnlocked(projectPath, document)) }
  private async writeDocumentUnlocked(projectPath: string, document: ConversationDocument, updateIndex = true): Promise<void> {
    await this.data.write(projectPath, documentKey(document.id), JSON.stringify(storedDocument(document)))
    if (updateIndex) await this.mutateIndex(projectPath, (entries) => [summaryOf(document), ...entries.filter((entry) => entry.id !== document.id)])
  }
  private async readUnlocked(projectPath: string, conversationId: string): Promise<ConversationDocument | null> {
    const stored = await this.data.read(projectPath, documentKey(conversationId))
    if (stored.status === 'missing') return null
    if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话当前无法读取')
    let parsed: unknown
    try { parsed = JSON.parse(stored.content ?? 'null') } catch { throw new Error('对话数据格式无效') }
    const document = normalizeDocument(parsed)
    if (!document) throw new Error('对话数据无法通过完整性校验')
    const journal = parseJournalLines(await this.data.readJournal(projectPath, journalKey(conversationId)), conversationId, document.generation)
    const merged = new Map(journal.map((event) => [event.eventId, event]))
    for (const event of document.events) if (!merged.has(event.eventId)) {
      merged.set(event.eventId, event)
      await this.data.appendJournal(projectPath, journalKey(conversationId), `${JSON.stringify(event)}\n`)
    }
    const events = [...merged.values()].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    return { ...document, events, lastSequence: Math.max(document.lastSequence, ...events.map((event) => event.sequence), 0) }
  }

  private mutateIndex(projectPath: string, transform: (entries: ConversationSummary[]) => ConversationSummary[]): Promise<void> {
    return this.enqueue(projectPath, '$conversation-index', () => this.rewriteIndex(projectPath, transform))
  }
  private async rewriteIndex(projectPath: string, transform: (entries: ConversationSummary[]) => ConversationSummary[]): Promise<void> {
    const stored = await this.data.read(projectPath, INDEX_KEY)
    if (stored.status === 'unavailable') throw new Error(stored.message ?? '对话索引当前无法读取')
    let parsed: unknown = []
    if (stored.status === 'ok' && stored.content) { try { parsed = JSON.parse(stored.content) } catch { throw new Error('对话索引格式无效') } }
    const entries = Array.isArray(parsed) ? parsed.map(normalizeSummary).filter((entry): entry is ConversationSummary => Boolean(entry)) : []
    await this.data.write(projectPath, INDEX_KEY, JSON.stringify(transform(entries).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))))
  }
  private laneKey(projectPath: string, conversationId: string): string { return `${projectPath.toLowerCase()}\n${conversationId}` }
  private wait(projectPath: string, conversationId: string): Promise<unknown> { return this.lanes.get(this.laneKey(projectPath, conversationId)) ?? Promise.resolve() }
  private enqueue<T>(projectPath: string, conversationId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.laneKey(projectPath, conversationId)
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tracked = current.then(() => undefined, () => undefined).finally(() => { if (this.lanes.get(key) === tracked) this.lanes.delete(key) })
    this.lanes.set(key, tracked)
    return current
  }
}
