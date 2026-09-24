import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { InspirationNote } from '../shared/inspirationKnowledge'

/** User-owned notes live in app data, separate from the project's source tree. */
export class InspirationKnowledgeStore {
  private queues = new Map<string, Promise<unknown>>()
  constructor(private readonly root: string, private readonly onChanged?: (projectPath: string, notes: InspirationNote[]) => void) {}
  private key(projectPath: string): string {
    const resolved = path.resolve(projectPath)
    return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex')
  }
  async read(projectPath: string): Promise<InspirationNote[]> {
    const file = path.join(this.root, `${this.key(projectPath)}.json`)
    try {
      const items: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!Array.isArray(items)) throw new Error('项目知识文件损坏')
      return items.filter((item): item is InspirationNote => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.content === 'string' && typeof item.updatedAt === 'string'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  async update(projectPath: string, input: { id?: string; title?: string; content?: string; remove?: boolean }): Promise<InspirationNote[]> {
    return this.write(projectPath, input, false)
  }
  /** Agent saves cannot delete notes or select another project's storage. */
  async save(projectPath: string, input: Record<string, unknown>): Promise<InspirationNote> {
    if (Object.keys(input).some(key => !['id', 'title', 'content'].includes(key))
      || input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim())) throw new Error('知识保存参数无效')
    const notes = await this.write(projectPath, input as { id?: string; title?: string; content?: string }, true)
    return notes[0]
  }
  private async write(projectPath: string, input: { id?: string; title?: string; content?: string; remove?: boolean }, agentSave: boolean): Promise<InspirationNote[]> {
    const key = this.key(projectPath)
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const items = await this.read(projectPath)
      if (input.remove) {
        if (typeof input.id !== 'string') throw new Error('缺少知识条目 ID')
      } else if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 20000) {
        throw new Error('标题需为 1–120 字符，内容需为 1–20000 字符')
      }
      if (agentSave && input.id && !items.some(item => item.id === input.id)) throw new Error('知识条目不存在，请重新读取项目知识')
      const matches = agentSave && !input.id ? items.filter(item => item.title === input.title!.trim()) : []
      if (matches.length > 1) throw new Error('存在多个同名知识条目，请读取后指定条目 ID')
      const id = typeof input.id === 'string' ? input.id : matches[0]?.id ?? randomUUID()
      const next = items.filter(item => item.id !== id)
      if (!input.remove) next.unshift({ id, title: input.title!.trim(), content: input.content!.trim(), updatedAt: new Date().toISOString() })
      if (next.length > 100) throw new Error('最多保存 100 条项目知识，请先整理已有条目')
      await fs.mkdir(this.root, { recursive: true })
      const file = path.join(this.root, `${key}.json`)
      const temporary = `${file}.${randomUUID()}.tmp`
      try { await fs.writeFile(temporary, JSON.stringify(next), 'utf8'); await fs.rename(temporary, file) }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
      this.onChanged?.(projectPath, next)
      return next
    })
    this.queues.set(key, task)
    try { return await task }
    finally { if (this.queues.get(key) === task) this.queues.delete(key) }
  }
}
