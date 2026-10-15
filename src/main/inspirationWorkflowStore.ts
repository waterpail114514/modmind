import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { InspirationFeatures } from '../shared/inspirationFeatures'
import type { InspirationNote, InspirationWorkflowRecord } from '../shared/inspirationKnowledge'
import { parseInspirationWorkflow } from '../shared/inspirationWorkflow'
import { InspirationKnowledgeStore } from './inspirationKnowledgeStore'

export interface InspirationWorkflowIdentity { conversationId: string; turnId: string; generation: number }
interface StoredRecord extends InspirationWorkflowRecord { response: string; features: InspirationFeatures }

/** Host-owned final-answer registration; replay reads records but never reapplies them. */
export class InspirationWorkflowStore {
  private queues = new Map<string, Promise<unknown>>()
  constructor(private readonly root: string, private readonly knowledge: InspirationKnowledgeStore) {}
  private directory(projectPath: string): string {
    const resolved = path.resolve(projectPath)
    return path.join(this.root, createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex'))
  }
  private file(projectPath: string, identity: InspirationWorkflowIdentity): string {
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    return path.join(this.directory(projectPath), `${id}.json`)
  }
  private async persist(file: string, record: StoredRecord): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temporary, JSON.stringify(record), 'utf8'); await fs.rename(temporary, file) }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }
  private async prune(directory: string, keep: string): Promise<void> {
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json'))
    if (names.length <= 100) return
    const files = await Promise.all(names.map(async name => ({ file: path.join(directory, name), modified: (await fs.stat(path.join(directory, name))).mtimeMs })))
    const oldest = files.filter(item => item.file !== keep && !this.queues.has(item.file)).sort((a, b) => a.modified - b.modified)
    for (const item of oldest.slice(0, names.length - 100)) await fs.rm(item.file, { force: true })
  }
  private async queued<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.queues.set(file, task)
    try { return await task }
    finally { if (this.queues.get(file) === task) this.queues.delete(file) }
  }
  async read(projectPath: string, identity: InspirationWorkflowIdentity): Promise<StoredRecord | null> {
    try { return JSON.parse(await fs.readFile(this.file(projectPath, identity), 'utf8')) as StoredRecord }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async register(projectPath: string, identity: InspirationWorkflowIdentity, response: string, features: InspirationFeatures,
    question: string, baseline: InspirationNote[], signal?: AbortSignal): Promise<InspirationWorkflowRecord | null> {
    const parsed = parseInspirationWorkflow(response, features)
    if (!parsed.complete || !parsed.value) return null
    const file = this.file(projectPath, identity)
    return this.queued(file, async () => {
      const previous = await this.read(projectPath, identity)
      if (previous) return previous
      const record: StoredRecord = { ...identity, id: path.basename(file, '.json'), response, features, status: 'pending', changes: [] }
      const sourceId = `${identity.turnId}:user`
      try {
        for (const [index, candidate] of parsed.value!.knowledgeCandidates.entries()) {
          if (candidate.sourceMessageIds.length !== 1 || candidate.sourceMessageIds[0] !== sourceId || !question.includes(candidate.sourceQuote)) {
            throw new Error('知识来源无法核对，请重新整理或手动编辑项目知识')
          }
          const matches = candidate.id ? baseline.filter(n => n.id === candidate.id) : baseline.filter(n => n.title === candidate.title && (n.scope ?? 'task') === candidate.scope)
          if (!features.projectKnowledge && matches.length) throw new Error('已有同名知识，请启用引用项目知识后重新整理，避免覆盖原内容')
          if (matches.length > 1 || candidate.id && !matches.length) throw new Error('知识条目不明确，请重新整理')
          const before = matches[0]
          if (candidate.expectedUpdatedAt && before?.updatedAt !== candidate.expectedUpdatedAt) throw new Error('知识版本已变化，请重新整理')
          record.changes.push({ id: before?.id ?? `inspiration-${record.id}-${index}`, title: candidate.title, content: candidate.content,
            scope: candidate.scope, sourceMessageIds: candidate.sourceMessageIds, ...(before ? { before } : {}) })
        }
        if (new Set(record.changes.map(c => c.id)).size !== record.changes.length
          || new Set(record.changes.map(c => `${c.scope}:${c.title}`)).size !== record.changes.length) throw new Error('知识候选重复，请重新整理')
      } catch (error) { record.status = 'error'; record.error = error instanceof Error ? error.message : String(error); record.changes = [] }
      signal?.throwIfAborted()
      // Durable intent precedes the atomic knowledge transaction; deterministic IDs make retry safe.
      await this.persist(file, record)
      await this.prune(path.dirname(file), file).catch(() => undefined)
      if (record.status !== 'error' && features.knowledgeOrganization && features.autoSaveKnowledge && record.changes.length) {
        try { signal?.throwIfAborted(); await this.knowledge.applyChanges(projectPath, record.changes, record.id); record.status = 'saved' }
        catch (error) { record.status = 'error'; record.error = error instanceof Error ? error.message : String(error) }
        await this.persist(file, record)
      }
      return record
    })
  }
  async commit(projectPath: string, identity: InspirationWorkflowIdentity, edits: Array<{ index: number; title: string; content: string }>, undo = false): Promise<InspirationWorkflowRecord> {
    const file = this.file(projectPath, identity)
    return this.queued(file, async () => {
      const record = await this.read(projectPath, identity)
      if (!record) throw new Error('未找到完整的知识预览，请重新整理')
      if (undo) {
        if (record.status === 'undone') return record
        if (record.status !== 'saved') throw new Error('当前变更尚未保存')
        await this.knowledge.applyChanges(projectPath, record.changes, record.id, true)
        record.status = 'undone'
      } else {
        if (record.status === 'saved') return record
        if (record.status === 'undone') throw new Error('此版本已撤销，请重新整理')
        if (!record.features.knowledgeOrganization || !record.changes.length) throw new Error('没有可保存的知识变更')
        if (!edits.length || edits.length > 8 || new Set(edits.map(e => e.index)).size !== edits.length) throw new Error('请选择有效知识变更')
        const changes = edits.map(edit => {
          const original = record.changes[edit.index]
          if (!original || !Number.isInteger(edit.index) || typeof edit.title !== 'string' || typeof edit.content !== 'string') throw new Error('知识变更参数无效')
          return { ...original, title: edit.title, content: edit.content }
        })
        // Persist selected edits before the transaction so crash recovery retains the exact user choice.
        const previousChanges = record.changes
        record.changes = changes
        await this.persist(file, record)
        try { await this.knowledge.applyChanges(projectPath, changes, record.id) }
        catch (error) { record.changes = previousChanges; await this.persist(file, record); throw error }
        record.status = 'saved'
      }
      delete record.error
      await this.persist(file, record)
      return record
    })
  }
}
