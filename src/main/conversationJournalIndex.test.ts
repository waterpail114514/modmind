import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
import { ConversationJournalIndex } from './conversationJournalIndex'

it('shares cold replica parsing only after independently matching all bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-journal-replicas-'))
  const targets = ['a', 'b', 'c'].map(name => path.join(root, `${name}.jsonl`)), index = new ConversationJournalIndex()
  const event = { eventId: 'one', conversationId: 'ws-replicas', generation: 0, sequence: 1, turnId: 'turn', kind: 'system', time: 'T', payload: 'a' }
  const internal = index as unknown as { build: (...args: unknown[]) => Promise<unknown>; buildShared: (...args: unknown[]) => Promise<unknown> }
  const originalBuild = internal.build.bind(index), originalShared = internal.buildShared.bind(index)
  let entered = 0, release!: () => void, started!: () => void
  const overlapping = new Promise<void>(resolve => { release = resolve })
  const firstStarted = new Promise<void>(resolve => { started = resolve })
  // The contract concerns overlapping cold reads, so control the overlap
  // instead of relying on three filesystem callbacks being scheduled together.
  const shared = vi.spyOn(internal, 'buildShared').mockImplementation((...args) => { if (++entered === targets.length) release(); return originalShared(...args) })
  const build = vi.spyOn(internal, 'build').mockImplementation(async (...args) => { started(); await overlapping; return originalBuild(...args) })
  try {
    await Promise.all(targets.map((target, offset) => fs.writeFile(target, JSON.stringify({ ...event, payload: offset === 2 ? 'b' : 'a' }) + '\n')))
    const first = index.get(targets[0]); await firstStarted
    await Promise.all([first, ...targets.slice(1).map(target => index.get(target))])
    expect(build).toHaveBeenCalledTimes(2)
    expect((await index.page(targets[0], 'ws-replicas', 0, 0, 1))[0].payload).toBe('a')
    expect((await index.page(targets[2], 'ws-replicas', 0, 0, 1))[0].payload).toBe('b')
  } finally { build.mockRestore(); shared.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

it('reads adjacent blocks for a 5,000-event page in one range', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-journal-page-'))
  const target = path.join(root, 'events.jsonl'), index = new ConversationJournalIndex()
  try {
    await fs.writeFile(target, Array.from({ length: 10_000 }, (_, offset) => JSON.stringify({ eventId: `e-${offset}`, conversationId: 'ws-page', generation: 0, sequence: offset + 1, turnId: 'turn', kind: 'system', time: 'T', payload: offset })).join('\n') + '\n')
    await index.get(target)
    const original = fs.open.bind(fs)
    let reads = 0
    const mock = vi.spyOn(fs, 'open').mockImplementation((async (...args) => {
      const handle = await original(...args)
      if (String(args[0]) === target && args[1] === 'r') {
        const read = handle.read.bind(handle)
        handle.read = ((...readArgs: Parameters<typeof read>) => { reads += 1; return read(...readArgs) }) as typeof handle.read
      }
      return handle
    }) as typeof fs.open)
    try {
      const events = await index.page(target, 'ws-page', 0, 0, 5_000)
      expect(events).toHaveLength(5_001)
      expect([events[0].sequence, events.at(-1)?.sequence]).toEqual([1, 5_001])
      expect(reads).toBe(1)
    } finally { mock.mockRestore() }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30_000)

it('keeps sparse blocks bounded during thousands of one-event appends', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-journal-index-'))
  const target = path.join(root, 'events.jsonl'), index = new ConversationJournalIndex()
  const line = (sequence: number): string => JSON.stringify({ eventId: `e-${sequence}`, conversationId: 'ws-small-batches', generation: 0, sequence, turnId: 'turn', kind: 'system', time: 'T', payload: sequence }) + '\n'
  try {
    await fs.writeFile(target, line(1))
    await index.get(target)
    // Keep the real JSONL/offset reads and version-table merge, but avoid 2,100
    // redundant cache-sidecar renames in a correctness regression test.
    const persist = vi.spyOn(index as unknown as { persist: (...args: unknown[]) => Promise<void> }, 'persist').mockResolvedValue(undefined)
    for (let sequence = 2; sequence <= 2_100; sequence += 1) {
      const before = await fs.stat(target), content = line(sequence)
      await fs.appendFile(target, content)
      await index.appended(target, content, before, await fs.stat(target))
    }
    const entry = await index.get(target)
    expect(entry?.blocks.length).toBe(Math.ceil(2_100 / 256))
    expect((await index.page(target, 'ws-small-batches', 0, 2_099, 1)).map(event => event.sequence)).toEqual([2_100])
    persist.mockRestore()
    const reopened = new ConversationJournalIndex()
    expect(await reopened.tail(target, 'ws-small-batches', 0)).toBe(2_100)
    expect((await reopened.get(target))?.blocks.length).toBe(9)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 60_000)
