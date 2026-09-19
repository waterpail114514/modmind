import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { redactDiagnosticText } from './diagnosticLog'

/** Dedicated, append-only image-workbench recording. Images live outside JSONL. */
export class ImageStudioJournal {
  readonly sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  readonly directory: string
  private sequence = 0
  private pending = Promise.resolve()
  private images = new Set<string>()
  private eventIds = new Set<string>()

  constructor(root: string) { this.directory = path.join(root, this.sessionId) }

  record(event: unknown): Promise<void> {
    const sequence = ++this.sequence
    const receivedAt = new Date().toISOString()
    const write = this.pending.then(async () => {
      const eventId = event && typeof event === 'object' && 'eventId' in event && typeof event.eventId === 'string' ? event.eventId : undefined
      if (eventId && this.eventIds.has(eventId)) return
      await fs.mkdir(this.directory, { recursive: true })
      const data = await this.normalize(event)
      await fs.appendFile(path.join(this.directory, 'events.jsonl'), `${JSON.stringify({ sequence, receivedAt, sessionId: this.sessionId, event: data })}\n`, 'utf8')
      if (eventId) this.eventIds.add(eventId)
    })
    // A failed disk write must not poison later writes; callers still see its failure.
    this.pending = write.catch(() => {})
    return write
  }

  flush(): Promise<void> { return this.pending }

  private async normalize(value: unknown, key = '', depth = 0): Promise<unknown> {
    if (/api[-_]?key|authorization|cookie|password|secret|token|encryptedKey/i.test(key)) return '[REDACTED]'
    if (depth > 30) return '[MAX_DEPTH]'
    if (typeof value === 'string') {
      const image = /^data:image\/(png|jpeg|webp|gif|bmp);base64,([A-Za-z0-9+/=]+)$/i.exec(value)
      if (image) {
        const bytes = Buffer.from(image[2], 'base64')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const file = `images/${sha256}.${image[1].toLowerCase()}`
        if (!this.images.has(file)) {
          await fs.mkdir(path.join(this.directory, 'images'), { recursive: true })
          await fs.writeFile(path.join(this.directory, file), bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
          this.images.add(file)
        }
        return { file, sha256, bytes: bytes.length }
      }
      return redactDiagnosticText(value)
    }
    if (Array.isArray(value)) return Promise.all(value.map(item => this.normalize(item, '', depth + 1)))
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {}
      for (const [name, item] of Object.entries(value)) output[name] = await this.normalize(item, name, depth + 1)
      return output
    }
    return value
  }
}
