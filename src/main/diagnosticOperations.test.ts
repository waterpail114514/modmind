import { describe, expect, it, vi } from 'vitest'
import { DiagnosticJournal } from './diagnosticLog'
import { DiagnosticOperations } from './diagnosticOperations'

describe('DiagnosticOperations', () => {
  it('correlates concurrent identical operations and preserves a pending call without cancelling it', async () => {
    vi.useFakeTimers()
    try {
      const journal = new DiagnosticJournal()
      const operations = new DiagnosticOperations(journal, 100)
      let complete!: (value: number) => void
      const pending = operations.run('ipc', 'same', { webContentsId: 7 }, () => new Promise<number>(resolve => { complete = resolve }))
      const failed = operations.run('ipc', 'same', { webContentsId: 8 }, () => { throw new Error('failure') })
      await expect(failed).rejects.toThrow('failure')
      await vi.advanceTimersByTimeAsync(100)
      expect(operations.snapshot()).toHaveLength(1)
      expect(journal.snapshot().filter(event => event.phase === 'pending')).toHaveLength(1)
      complete(42)
      await expect(pending).resolves.toBe(42)
      expect(operations.snapshot()).toHaveLength(0)
      const events = journal.snapshot()
      const starts = events.filter(event => event.phase === 'start')
      const ids = starts.map(event => (event.data as { requestId: string }).requestId)
      expect(new Set(ids).size).toBe(2)
      for (const id of ids) expect(events.filter(event => ['success', 'error'].includes(event.phase) && (event.data as { requestId: string }).requestId === id)).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })
})
