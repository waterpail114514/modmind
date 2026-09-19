import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageStudioJournal } from './imageStudioJournal'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function createJournal() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-journal-'))
  roots.push(root)
  return new ImageStudioJournal(root)
}

describe('image studio operation journal', () => {
  it('preserves concurrent operation order, complete prompts, graph IDs and errors', async () => {
    const journal = await createJournal()
    const prompt = '描述'.repeat(16000)
    await Promise.all([
      journal.record({ type: 'workflow.run.start', data: { prompt, nodeIds: ['g1', 'g2'], count: 3 } }),
      journal.record({ type: 'node.delete', data: { deletedIds: ['g2'], selectedIds: ['g1', 'g2'] } }),
      journal.record({ type: 'api.error', data: { error: { message: 'failure', stack: 'original stack' } } })
    ])
    const events = (await fs.readFile(path.join(journal.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(events.map(item => item.sequence)).toEqual([1, 2, 3])
    expect(events[0].event.data.prompt).toBe(prompt)
    expect(events[1].event.data.deletedIds).toEqual(['g2'])
    expect(events[2].event.data.error.stack).toBe('original stack')
  })

  it('deduplicates retried events and stores repeated images once without exposing credentials', async () => {
    const journal = await createJournal()
    const event = { eventId: 'client:1', type: 'api.start', data: { apiKey: 'private', Authorization: 'Bearer private', referenceImage: 'data:image/png;base64,AA==', prompt: 'cat' } }
    await Promise.all([journal.record(event), journal.record(event), journal.record({ ...event, eventId: 'client:2' })])
    const text = await fs.readFile(path.join(journal.directory, 'events.jsonl'), 'utf8')
    const lines = text.trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(text).not.toContain('private')
    expect(text).not.toContain('base64')
    expect(lines[0].event.data.referenceImage).toMatchObject({ bytes: 1 })
    expect(await fs.readdir(path.join(journal.directory, 'images'))).toHaveLength(1)
    expect(await fs.readFile(path.join(journal.directory, lines[0].event.data.referenceImage.file))).toEqual(Buffer.from([0]))
  })

  it('reports failed writes and can resume when storage becomes available', async () => {
    const journal = await createJournal()
    await fs.writeFile(journal.directory, 'temporarily blocked')
    await expect(journal.record({ eventId: 'retry', type: 'event' })).rejects.toThrow()
    await fs.unlink(journal.directory)
    await journal.record({ eventId: 'retry', type: 'event' })
    expect(await fs.readFile(path.join(journal.directory, 'events.jsonl'), 'utf8')).toContain('retry')
  })
})
