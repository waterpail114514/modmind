import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** A separate bounded incident history survives ordinary log rotation and process restarts. */
export class DiagnosticHistory {
  private rotations = 0
  private failures = 0
  private lastError = ''
  private lastPersistedAt = 0
  private lastPrunedDay = ''
  constructor(private readonly root: string, private readonly maxFileBytes = 2 * 1024 * 1024, private readonly now = () => Date.now()) {
    try {
      const previous = JSON.parse(readFileSync(path.join(root, 'retention.json'), 'utf8'))
      this.rotations = Number(previous.rotations) || 0
      this.failures = Number(previous.failures) || 0
    } catch { /* Missing/corrupt index never blocks application startup. */ }
    this.prune()
  }
  record(event: { time: string }): void {
    try {
      mkdirSync(this.root, { recursive: true })
      const date = new Date(this.now()).toISOString().slice(0, 10)
      if (date !== this.lastPrunedDay) { this.prune(); this.lastPrunedDay = date }
      const file = path.join(this.root, `${date}.jsonl`)
      const raw = JSON.stringify(event)
      const lineLimit = Math.min(this.maxFileBytes, 128 * 1024)
      const text = (Buffer.byteLength(raw) < lineLimit ? raw : JSON.stringify({ time: event.time, truncated: true, originalBytes: Buffer.byteLength(raw), preview: raw.slice(0, Math.floor(lineLimit / 24)) })) + '\n'
      let rotated = false
      let size = 0
      try { size = statSync(file).size } catch { /* first event of this day */ }
      if (size && size + Buffer.byteLength(text) > this.maxFileBytes) {
        const previous = path.join(this.root, `${date}.previous.jsonl`)
        rmSync(previous, { force: true }); renameSync(file, previous)
        this.rotations++
        rotated = true
      }
      appendFileSync(file, text, { mode: 0o600 })
      if (rotated || this.now() - this.lastPersistedAt > 5000) { this.persist(); this.lastPersistedAt = this.now() }
    } catch (error) { this.failures++; this.lastError = String(error).slice(0, 1000) }
  }
  status(): { retentionDays: number; maxBytes: number; rotations: number; failures: number; lastError?: string } {
    return { retentionDays: 14, maxBytes: 56 * 1024 * 1024, rotations: this.rotations, failures: this.failures, ...(this.lastError ? { lastError: this.lastError } : {}) }
  }
  private persist(): void {
    const file = path.join(this.root, 'retention.json')
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify({ ...this.status(), updatedAt: new Date(this.now()).toISOString(), completeness: this.rotations || this.failures ? 'has-known-gaps' : 'no-recorded-loss' }), { mode: 0o600 })
    renameSync(temp, file)
  }
  private prune(): void {
    try {
      const files = readdirSync(this.root).filter(name => /^\d{4}-\d{2}-\d{2}(?:\.previous)?\.jsonl$/.test(name)).sort().reverse()
      let bytes = 0
      for (const file of files) {
        const stat = statSync(path.join(this.root, file))
        bytes += stat.size
        if (Date.parse(file.slice(0, 10)) < this.now() - 14 * 86400_000 || bytes > 56 * 1024 * 1024) {
          rmSync(path.join(this.root, file)); this.rotations++
        }
      }
    } catch { /* The journal separately reports disk failures. */ }
  }
}
