import { randomUUID } from 'node:crypto'
import { isExpectedCancellation } from '../shared/diagnostics'
import { diagnosticJournal, type DiagnosticJournal } from './diagnosticLog'
import { diagnosticContext, diagnosticValue } from './diagnosticContext'

export class DiagnosticOperations {
  private readonly active = new Map<string, { operation: string; startedAt: string; data: Record<string, unknown> }>()
  private readonly metricListeners = new Set<(metric: { operation: string; outcome: 'returned' | 'failed' | 'cancelled'; durationMs: number }) => void>()

  subscribeMetrics(listener: (metric: { operation: string; outcome: 'returned' | 'failed' | 'cancelled'; durationMs: number }) => void): () => void {
    this.metricListeners.add(listener)
    return () => this.metricListeners.delete(listener)
  }

  constructor(private readonly journal: DiagnosticJournal, private readonly slowMs = 30_000) {}

  snapshot(): unknown[] {
    return [...this.active].map(([requestId, operation]) => ({ requestId, ...operation }))
  }

  async run<T>(subsystem: string, operation: string, data: Record<string, unknown>, action: () => T | Promise<T>): Promise<T> {
    const requestId = randomUUID()
    const started = Date.now()
    let outcome: 'returned' | 'failed' | 'cancelled' = 'returned'
    const parentRequestId = diagnosticContext.getStore()?.requestId
    const context = { ...data, requestId, ...(parentRequestId ? { parentRequestId } : {}) }
    this.active.set(requestId, { operation, startedAt: new Date(started).toISOString(), data })
    const recordStart = subsystem === 'startup' ? this.journal.recordCritical.bind(this.journal) : this.journal.record.bind(this.journal)
    recordStart({ subsystem, operation, phase: 'start', message: `Operation started: ${operation}`, data: context })
    const timer = setTimeout(() => {
      this.journal.record({ subsystem, operation, phase: 'pending', level: 'warning', durationMs: Date.now() - started,
        message: `Operation is still pending; it has not been cancelled: ${operation}`, data: context })
    }, this.slowMs)
    timer.unref()
    try {
      const result = await diagnosticContext.run({ requestId, parentRequestId, operation, projectPath: typeof data.projectPath === 'string' ? data.projectPath : diagnosticContext.getStore()?.projectPath }, action)
      const failed = result && typeof result === 'object' && ('success' in result && result.success === false || 'status' in result && ['failed', 'error'].includes(String(result.status)))
      if (failed) outcome = 'failed'
      const record = subsystem === 'startup' || /(?:write|save|rename|delete|restore|commit|publish|install|apply|remove|migrat|create)/i.test(operation) ? this.journal.recordCritical.bind(this.journal) : this.journal.record.bind(this.journal)
      record({ subsystem, operation, phase: failed ? 'result-error' : 'success', level: failed ? 'warning' : 'info', durationMs: Date.now() - started, message: `Operation returned: ${operation}`, data: { ...context, result: diagnosticValue(result) } })
      return result
    } catch (error) {
      const cancelled = isExpectedCancellation(error)
      outcome = cancelled ? 'cancelled' : 'failed'
      this.journal.record({ subsystem, operation, phase: cancelled ? 'cancelled' : 'error', level: cancelled ? 'warning' : 'error',
        durationMs: Date.now() - started, message: `Operation ${cancelled ? 'cancelled' : 'failed'}: ${operation}`, data: context, error })
      throw error
    } finally {
      clearTimeout(timer)
      this.active.delete(requestId)
      for (const listener of this.metricListeners) {
        try { listener({ operation, outcome, durationMs: Date.now() - started }) } catch { /* Optional statistics cannot affect the operation. */ }
      }
    }
  }
}

export const diagnosticIpcOperations = new DiagnosticOperations(diagnosticJournal)
