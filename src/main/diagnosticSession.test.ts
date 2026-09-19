import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticJournal } from './diagnosticLog'
import { DiagnosticSession } from './diagnosticSession'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

describe('DiagnosticSession', () => {
  it('distinguishes first launch, unconfirmed interruption, and clean exit across restarts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-session-'))
    roots.push(root)
    const start = (): DiagnosticSession => {
      const journal = new DiagnosticJournal()
      journal.configure(root)
      return new DiagnosticSession(root, journal)
    }
    expect(start().previous.outcome).toBe('first-run')
    const interrupted = start()
    expect(interrupted.previous.outcome).toBe('unconfirmed-exit')
    interrupted.finish()
    expect(start().previous.outcome).toBe('clean-exit')
    await fs.writeFile(path.join(root, 'diagnostic-session.json'), '{broken')
    expect(start().previous.outcome).toBe('unreadable')
  })
})
