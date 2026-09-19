import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DiagnosticJournal } from './diagnosticLog'

interface SessionState {
  sessionId: string
  pid: number
  startedAt: string
  lastSeenAt: string
  state: 'running' | 'clean-exit'
  endedAt?: string
}

/** Only the single-instance lock owner may create or finish a session. */
export class DiagnosticSession {
  private readonly file: string
  private readonly current: SessionState
  private timer?: ReturnType<typeof setInterval>
  readonly previous: { outcome: 'first-run' | 'clean-exit' | 'unconfirmed-exit' | 'unreadable'; session?: SessionState }

  constructor(directory: string, private readonly journal: DiagnosticJournal) {
    this.file = path.join(directory, 'diagnostic-session.json')
    const now = new Date().toISOString()
    this.current = { sessionId: journal.sessionId, pid: process.pid, startedAt: now, lastSeenAt: now, state: 'running' }
    try {
      const previous: SessionState = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!previous || typeof previous.sessionId !== 'string' || !['running', 'clean-exit'].includes(previous.state)
        || typeof previous.startedAt !== 'string' || typeof previous.lastSeenAt !== 'string') throw new Error('Invalid diagnostic session marker')
      this.previous = { outcome: previous.state === 'clean-exit' ? 'clean-exit' : 'unconfirmed-exit', session: previous }
    } catch (error) {
      this.previous = { outcome: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'first-run' : 'unreadable' }
      if (this.previous.outcome === 'unreadable') journal.recordCritical({ subsystem: 'app', operation: 'session-marker', phase: 'error', message: 'Previous session marker could not be read', error })
    }
    journal.recordCritical({ subsystem: 'app', operation: 'session', phase: 'start',
      level: this.previous.outcome === 'unconfirmed-exit' || this.previous.outcome === 'unreadable' ? 'warning' : 'info',
      message: `Previous session: ${this.previous.outcome}; an unconfirmed exit is not proof of a crash`, data: this.previous })
    this.persist()
  }

  startHeartbeat(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.persist(), 30_000)
    this.timer.unref()
  }

  finish(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.current.state = 'clean-exit'
    this.current.endedAt = new Date().toISOString()
    this.persist()
    this.journal.recordCritical({ subsystem: 'app', operation: 'session', phase: 'clean-exit', message: 'Application reached normal quit', data: this.current })
  }

  private persist(): void {
    this.current.lastSeenAt = new Date().toISOString()
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.current)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (error) {
      this.journal.recordCritical({ subsystem: 'app', operation: 'session-marker', phase: 'error', message: 'Session marker write failed', error })
    }
  }
}
