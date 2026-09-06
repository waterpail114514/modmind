import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from './conversationStore'
import { WorkbenchDataStore } from './workbenchDataStore'

const roots: string[] = []
const stores: ConversationStore[] = []
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.flush()))
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try { await fs.rm(root, { recursive: true, force: true }); break }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
        if (!['ENOTEMPTY', 'EPERM', 'EBUSY'].includes(code) || attempt === 5) throw error
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
})

async function fixture(): Promise<{ project: string; userData: string; data: WorkbenchDataStore; store: ConversationStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-conversation-'))
  roots.push(root)
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  const userData = path.join(root, 'userdata')
  const data = new WorkbenchDataStore(userData)
  const store = new ConversationStore(data)
  stores.push(store)
  return { project, userData, data, store }
}

describe('ConversationStore', () => {
  it('persists routed events in sequence and replays only missing events', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    await store.appendUser(project, 'ws-a', 0, 'turn-a', { prompt: 'hello' }, 'run-a')
    const output = await store.appendOutput(project, { kind: 'delta', content: 'ok', time: new Date().toISOString(), conversationId: 'ws-a', generation: 0, turnId: 'turn-a', runId: 'run-a' })
    expect(output.sequence).toBe(2)
    const page = await store.eventsSince(project, 'ws-a', 0, 1)
    expect(page.events.map((event) => event.sequence)).toEqual([2])
  })

  it('retains consecutive persisted deltas for complete recovery', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    const base = { kind: 'delta' as const, time: new Date().toISOString(), conversationId: 'ws-a', generation: 0, turnId: 'turn-a', runId: 'run-a' }
    await store.appendOutput(project, { ...base, content: 'hello' })
    await store.appendOutput(project, { ...base, content: ' world' })
    const document = await store.read(project, 'ws-a')
    expect(document?.events).toHaveLength(2)
    expect(document?.events.map((event) => event.sequence)).toEqual([1, 2])
  })

  it('migrates v2 events to the journal once and ignores a torn replica', async () => {
    const { project, userData, data, store } = await fixture()
    const created = await store.create(project, { id: 'ws-a', surface: 'workspace' })
    const event = { eventId: 'legacy-event', conversationId: 'ws-a', generation: 0, turnId: 'turn-a', sequence: 1, kind: 'user' as const, time: 'T1', payload: { prompt: 'keep' } }
    await data.write(project, '.modmind/conversations-v2/ws-a.json', JSON.stringify({ ...created, lastSequence: 1, events: [event] }))
    expect((await store.read(project, 'ws-a'))?.events).toEqual([event])
    await fs.writeFile(path.join(project, '.modmind', 'workbench-journal', 'ws-a', 'events.jsonl'), '{torn', 'utf8')
    await fs.writeFile(path.join(project, '.modmind', 'conversations-v3', 'ws-a.jsonl'), '{torn', 'utf8')
    const recovered = await new ConversationStore(new WorkbenchDataStore(userData)).read(project, 'ws-a')
    expect(recovered?.events).toEqual([event])
  })

  it('deduplicates replicated events and deletes their journal', async () => {
    const { project, data, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    await store.appendUser(project, 'ws-a', 0, 'turn-a', { prompt: 'once' })
    const [event] = (await store.read(project, 'ws-a'))!.events
    await data.appendJournal(project, '.modmind/conversations-v3/ws-a.jsonl', `${JSON.stringify(event)}\n`)
    expect((await store.read(project, 'ws-a'))?.events).toHaveLength(1)
    await store.delete(project, 'ws-a')
    expect(await data.readJournal(project, '.modmind/conversations-v3/ws-a.jsonl')).toEqual([])
  })

  it('checkpoints rendered events without truncating the saved view', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    const output = await store.appendOutput(project, { kind: 'answer', content: 'complete', time: 'T1', conversationId: 'ws-a', generation: 0, turnId: 'turn-a' })
    const saved = await store.saveView(project, 'ws-a', 0, { timeline: [{ id: 'answer', kind: 'answer', content: 'complete', time: 'T1', sequence: output.sequence }] })
    expect(saved.view.timeline).toHaveLength(1)
    expect(saved.events).toHaveLength(1)
    expect(saved.checkpointSequence).toBe(output.sequence)
  })

  it('forks a checkpointed view without losing native turn mappings or reusing old sequences', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    const firstUser = await store.appendUser(project, 'ws-a', 0, 'turn-a', { prompt: 'keep' })
    await store.setNativeState(project, 'ws-a', 0, 'codex', 'thread-a', 'native-turn-a', 'turn-a')
    const secondUser = await store.appendUser(project, 'ws-a', 0, 'turn-b', { prompt: 'replace' })
    await store.setNativeState(project, 'ws-a', 0, 'codex', 'thread-a', 'native-turn-b', 'turn-b')
    await store.saveView(project, 'ws-a', 0, { timeline: [
      { id: 'user-a', kind: 'user', turnId: 'turn-a', content: 'keep', sequence: firstUser.sequence },
      { id: 'user-b', kind: 'user', turnId: 'turn-b', content: 'replace', sequence: secondUser.sequence }
    ] })

    const fork = await store.fork(project, {
      sourceConversationId: 'ws-a', id: 'ws-b', beforeTurnId: 'turn-b', backend: 'codex',
      view: { timeline: [{ id: 'user-a', kind: 'user', turnId: 'turn-a', content: 'keep', sequence: firstUser.sequence }] }
    })
    expect(fork.parent).toMatchObject({ nativeMode: 'native', boundary: 'before', nativeTurnId: 'native-turn-b' })
    expect(fork.nativeTurns).toEqual({ 'turn-a': { codex: 'native-turn-a' } })
    expect(fork.events).toEqual([])
    expect(fork.lastSequence).toBe(0)
    expect((fork.view.timeline?.[0] as { sequence?: number }).sequence).toBeUndefined()
    const next = await store.appendOutput(project, { kind: 'delta', content: 'new', time: 'T3', conversationId: 'ws-b', generation: fork.generation, turnId: 'turn-c' })
    expect(next.sequence).toBe(1)
  })

  it('updates index recency for terminal events without waiting for a view checkpoint', async () => {
    const { project, store } = await fixture()
    const created = await store.create(project, { id: 'ws-a', surface: 'workspace' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.appendOutput(project, { kind: 'answer', content: 'done', time: 'T1', conversationId: 'ws-a', generation: 0, turnId: 'turn-a' })
    const document = await store.read(project, 'ws-a')
    const summary = (await store.list(project, 'workspace'))[0]
    expect(summary.updatedAt).toBe(document?.updatedAt)
    expect(summary.updatedAt > created.updatedAt).toBe(true)
  })

  it('rejects late events from an old generation', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    const fork = await store.fork(project, { sourceConversationId: 'ws-a', id: 'ws-b', view: { timeline: [] }, backend: 'codex' })
    await expect(store.appendOutput(project, { kind: 'delta', content: 'late', time: new Date().toISOString(), conversationId: fork.id, generation: 0, turnId: 'turn-a' })).rejects.toThrow('旧对话分支')
  })

  it('marks historical Claude branches as visible-history rebuilds', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'idea-a', surface: 'inspiration' })
    await store.appendUser(project, 'idea-a', 0, 'turn-a', { prompt: 'a' })
    const fork = await store.fork(project, { sourceConversationId: 'idea-a', id: 'idea-b', throughTurnId: 'turn-a', view: { messages: [] }, backend: 'claude' })
    expect(fork.parent?.nativeMode).toBe('visible-history-rebuild')
    expect(fork.native).toEqual({})
  })

  it('uses Claude native HEAD fork only for the latest completed turn', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'idea-a', surface: 'inspiration' })
    await store.appendUser(project, 'idea-a', 0, 'turn-a', { prompt: 'a' })
    await store.setNativeState(project, 'idea-a', 0, 'claude', 'claude-session', undefined, 'turn-a')
    const head = await store.fork(project, { sourceConversationId: 'idea-a', id: 'idea-head', throughTurnId: 'turn-a', view: { messages: [] }, backend: 'claude' })
    const before = await store.fork(project, { sourceConversationId: 'idea-a', id: 'idea-before', beforeTurnId: 'turn-a', view: { messages: [] }, backend: 'claude' })
    expect(head.parent?.nativeMode).toBe('native')
    expect(before.parent?.nativeMode).toBe('visible-history-rebuild')
  })

  it('serializes the shared index across concurrent conversations', async () => {
    const { project, store } = await fixture()
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.create(project, { id: `ws-${index}`, surface: 'workspace', title: `Conversation ${index}` })))
    const listed = await store.list(project, 'workspace')
    expect(new Set(listed.map((entry) => entry.id)).size).toBe(12)
  })

  it('forks before a deleted turn so native history cannot retain it', async () => {
    const { project, store } = await fixture()
    await store.create(project, { id: 'ws-a', surface: 'workspace' })
    await store.appendUser(project, 'ws-a', 0, 'turn-a', { prompt: 'keep' })
    await store.appendUser(project, 'ws-a', 0, 'turn-b', { prompt: 'delete' })
    await store.setNativeState(project, 'ws-a', 0, 'codex', 'thread-a', 'native-turn-b', 'turn-b')
    const fork = await store.fork(project, { sourceConversationId: 'ws-a', id: 'ws-b', beforeTurnId: 'turn-b', view: { timeline: [{ id: 'user-a', turnId: 'turn-a', kind: 'user', content: 'keep' }] }, backend: 'codex' })
    expect(fork.events).toEqual([])
    expect(fork.nativeTurns).toEqual({})
    expect(fork.parent).toMatchObject({ boundary: 'before', nativeTurnId: 'native-turn-b', nativeMode: 'native' })
    expect(fork.nativeForkPending).toBe(true)
    const consumed = await store.setNativeState(project, fork.id, fork.generation, 'codex', 'thread-fork')
    expect(consumed.nativeForkPending).toBe(false)
  })
})
