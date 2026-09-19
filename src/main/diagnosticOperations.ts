import { randomUUID } from 'node:crypto'
import { isExpectedCancellation } from '../shared/diagnostics'
import type { DiagnosticJournal } from './diagnosticLog'

export class DiagnosticOperations {
  private readonly active = new Map<string, { operation: string; startedAt: string; data: Record<string, unknown> }>()

  constructor(private readonly journal: DiagnosticJournal, private readonly slowMs = 30_000) {}

  snapshot(): unknown[] {
    return [...this.active].map(([requestId, operation]) => ({ requestId, ...operation }))
  }

  async run<T>(subsystem: string, operation: string, data: Record<string, unknown>, action: () => T | Promise<T>): Promise<T> {
    const requestId = randomUUID()
    const started = Date.now()
    const context = { ...data, requestId }
    this.active.set(requestId, { operation, startedAt: new Date(started).toISOString(), data })
    this.journal.record({ subsystem, operation, phase: 'start', message: `Operation started: ${operation}`, data: context })
    const timer = setTimeout(() => {
      this.journal.record({ subsystem, operation, phase: 'pending', level: 'warning', durationMs: Date.now() - started,
        message: `Operation is still pending; it has not been cancelled: ${operation}`, data: context })
    }, this.slowMs)
    timer.unref()
    try {
      const result = await action()
      this.journal.record({ subsystem, operation, phase: 'success', durationMs: Date.now() - started, message: `Operation completed: ${operation}`, data: context })
      return result
    } catch (error) {
      const cancelled = isExpectedCancellation(error)
      this.journal.record({ subsystem, operation, phase: cancelled ? 'cancelled' : 'error', level: cancelled ? 'warning' : 'error',
        durationMs: Date.now() - started, message: `Operation ${cancelled ? 'cancelled' : 'failed'}: ${operation}`, data: context, error })
      throw error
    } finally {
      clearTimeout(timer)
      this.active.delete(requestId)
    }
  }
}
