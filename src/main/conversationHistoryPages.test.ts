import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversationStore'
import { WorkbenchDataStore } from './workbenchDataStore'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-history-pages-')); roots.push(root)
  const project = path.join(root, 'project'); await fs.mkdir(project)
  const data = new WorkbenchDataStore(path.join(root, 'user')), store = new ConversationStore(data)
  await store.create(project, { id: 'ws-test', surface: 'workspace' })
  const rows = Array.from({ length: 350 }, (_, i) => ({ id: `row-${i}`, kind: i % 2 ? 'answer' : 'user', turnId: `turn-${Math.floor(i / 2)}`, content: `message ${i}`, time: new Date(i * 1000).toISOString(), sequence: i + 1, status: 'done' }))
  await store.saveProjection(project, 'ws-test', 0, { timeline: rows })
  return { root, project, data, store, rows }
}

describe('bounded conversation history pages', () => {
  it('reads forward from an exact boundary without skipping byte-limited rows', async () => {
    const { project, store } = await fixture()
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `big-${i}`, kind: 'answer', content: 'x'.repeat(190_000) }))
    await store.saveProjection(project, 'ws-test', 0, { timeline: rows })
    let after = 0; const ids: string[] = []
    while (after < rows.length) {
      const page = (await store.historyPage(project, 'ws-test', { after }))!
      expect(page.start).toBe(after); expect(page.items.length).toBeGreaterThan(0)
      ids.push(...page.items.map((row: any) => row.id)); after = page.end
    }
    expect(ids).toEqual(rows.map(row => row.id))
    await expect(store.historyPage(project, 'ws-test', { after: -1 })).rejects.toThrow('位置')
    await expect(store.historyPage(project, 'ws-test', { before: 1, after: 0 })).rejects.toThrow('位置')
  })
  it('loads only the latest view rows without the whole-document read or full journal', async () => {
    const { project, data, store, rows } = await fixture()
    const read = vi.spyOn(data, 'read'), journal = vi.spyOn(data, 'readJournal')
    const latest = await store.historyPage(project, 'ws-test')
    expect(latest?.items).toEqual(rows.slice(-100)); expect(latest?.document.view).toEqual({})
    expect(latest?.nextBefore).toBe(250); expect(read).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled()
    const older = await store.historyPage(project, 'ws-test', { before: latest!.nextBefore!, token: latest!.token, generation: 0 })
    expect(older?.items).toEqual(rows.slice(150, 250))
  })
  it('keeps unloaded prefix rows and native resume identity when saving a window', async () => {
    const { project, store, rows } = await fixture()
    await store.setNativeState(project, 'ws-test', 0, 'codex', 'native-session', 'native-turn', 'turn-174')
    const latest = (await store.historyPage(project, 'ws-test'))!
    const next = [...latest.items, { id: 'new', kind: 'answer', content: 'new content', time: '', sequence: 351 }]
    const saved = await store.saveHistoryWindow(project, 'ws-test', 0, latest.token, latest.start, next)
    const complete = await store.readProjection(project, 'ws-test')
    expect(complete?.view.timeline).toEqual([...rows, next.at(-1)])
    expect(complete?.native.codex?.sessionId).toBe('native-session')
    expect(saved?.total).toBe(351)
    await expect(store.saveHistoryWindow(project, 'ws-test', 0, latest.token, latest.start, [])).rejects.toThrow('未覆盖')
    expect((await store.readProjection(project, 'ws-test'))?.view.timeline).toHaveLength(351)
  })
  it('preserves the page token across metadata-only native updates and streams those writes', async () => {
    const { project, data, store } = await fixture()
    const first = (await store.historyPage(project, 'ws-test'))!
    const read = vi.spyOn(data, 'read'), wholeWrite = vi.spyOn(data, 'write')
    await store.setNativeState(project, 'ws-test', 0, 'codex', 'native', 't', 'turn-1')
    expect(read.mock.calls.filter(([, key]) => key.includes('/ws-test.json'))).toEqual([])
    expect(wholeWrite.mock.calls.filter(([, key]) => key.includes('/ws-test.json'))).toEqual([])
    expect((await store.historyPage(project, 'ws-test', { before: first.start, token: first.token, generation: 0 }))?.token).toBe(first.token)
    expect((await store.readContext(project, 'ws-test'))?.native.codex?.sessionId).toBe('native')
  })
  it('rejects old generations, invalid boundaries and changed view tokens', async () => {
    const { project, store } = await fixture()
    const latest = (await store.historyPage(project, 'ws-test'))!
    await expect(store.historyPage(project, 'ws-test', { before: -1 })).rejects.toThrow('位置')
    await store.replaceView(project, 'ws-test', 0, { timeline: [] })
    await expect(store.historyPage(project, 'ws-test', { before: 100, token: latest.token, generation: 0 })).rejects.toThrow('已更新')
  })
  it('deletes an earlier turn without dropping the unloaded prefix or suffix', async () => {
    const { project, store, rows } = await fixture()
    await store.deleteHistoryItem(project, 'ws-test', 0, 'row-100')
    const complete = (await store.readProjection(project, 'ws-test'))!
    expect(complete.generation).toBe(1)
    expect(complete.view.timeline?.map((r: any) => r.id)).toEqual(rows.filter((_, i) => i < 100 || i >= 102).map(r => r.id))
    expect(complete.view.timeline?.every((r: any) => r.sequence === undefined)).toBe(true)
  })
  it('forks at an unloaded historical row and retains its native before-turn mapping', async () => {
    const { project, store, rows } = await fixture()
    await store.setNativeState(project, 'ws-test', 0, 'codex', 'session', 'native-50', 'turn-50')
    const branch = await store.fork(project, { sourceConversationId: 'ws-test', historyItemId: 'row-100', view: {}, backend: 'codex' })
    expect(branch.nativeForkPending).toBe(true); expect(branch.parent?.boundary).toBe('before')
    expect((await store.readProjection(project, branch.id))?.view.timeline?.map((r: any) => r.id)).toEqual(rows.slice(0, 100).map(r => r.id))
    expect((await store.readProjection(project, 'ws-test'))?.view.timeline).toHaveLength(350)
  })
  it('bounds pages by serialized bytes as well as row count, preserving full replies', async () => {
    const { project, store } = await fixture()
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `large-${i}`, content: 'x'.repeat(180_000) }))
    await store.saveProjection(project, 'ws-test', 0, { timeline: rows })
    const latest = (await store.historyPage(project, 'ws-test'))!
    expect(latest.items.length).toBeLessThan(25); expect(JSON.stringify(latest.items).length).toBeLessThan(2 * 1024 * 1024)
    expect((latest.items.at(-1) as any).content).toHaveLength(180_000)
  })
  it('removes a selected answer along with its steps, retaining its user turn', async () => {
    const { project, store, rows } = await fixture()
    await store.deleteHistoryItem(project, 'ws-test', 0, 'row-101')
    expect((await store.readProjection(project, 'ws-test'))?.view.timeline?.map((r: any) => r.id)).toEqual(rows.filter(r => r.id !== 'row-101').map(r => r.id))
  })
  it('blocks deletion before the journal tail is checkpointed and preserves those events', async () => {
    const { project, store } = await fixture()
    await store.appendUser(project, 'ws-test', 0, 'new-turn', { prompt: 'do not lose me' })
    await expect(store.deleteHistoryItem(project, 'ws-test', 0, 'row-100')).rejects.toThrow('最新消息尚未保存')
    expect((await store.eventsSince(project, 'ws-test', 0, 0, 10)).events.some(event => event.turnId === 'new-turn')).toBe(true)
    expect((await store.readProjection(project, 'ws-test'))?.view.timeline).toHaveLength(350)
  })
  it('finds a retried user request in either unloaded view rows or the journal', async () => {
    const { project, store, data } = await fixture()
    await store.appendUser(project, 'ws-test', 0, 'tail-turn', { prompt: 'retry' })
    const read = vi.spyOn(data, 'read')
    expect(await store.hasUserTurn(project, 'ws-test', 0, 'turn-3')).toBe(true)
    expect(await store.hasUserTurn(project, 'ws-test', 0, 'tail-turn')).toBe(true)
    expect(await store.hasUserTurn(project, 'ws-test', 0, 'missing')).toBe(false)
    expect(read.mock.calls.filter(([, key]) => key.includes('/ws-test.json'))).toEqual([])
  })
  it('does not mistake an optimistic user row for its durable journal event', async () => {
    const { project, store, rows } = await fixture()
    await store.saveProjection(project, 'ws-test', 0, { timeline: [...rows, { id: 'optimistic', kind: 'user', turnId: 'pending', content: 'new request', time: '' }] })
    expect(await store.hasUserTurn(project, 'ws-test', 0, 'pending')).toBe(false)
    await store.appendUser(project, 'ws-test', 0, 'pending', { prompt: 'new request' })
    expect(await store.hasUserTurn(project, 'ws-test', 0, 'pending')).toBe(true)
  })
  it('reports a degraded streamed save and permits a retry with its new token', async () => {
    const { project, store, data } = await fixture()
    const latest = (await store.historyPage(project, 'ws-test'))!
    const writeReplica = (data as any).writeReplica.bind(data)
    const spy = vi.spyOn(data as any, 'writeReplica').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).includes('workbench-mirror')) throw new Error('mirror unavailable')
      return writeReplica(...args)
    })
    const updated = await store.saveHistoryWindow(project, 'ws-test', 0, latest.token, latest.start, [...latest.items, { id: 'new', kind: 'answer', content: 'retained' }])
    expect(updated?.writeResult?.durability).toBe('degraded')
    spy.mockRestore()
    const retry = await store.saveHistoryWindow(project, 'ws-test', 0, updated!.token, updated!.start, [...latest.items, { id: 'new', kind: 'answer', content: 'retained' }])
    expect(retry?.writeResult?.durability).toBe('redundant')
    expect((await store.readProjection(project, 'ws-test'))?.view.timeline).toHaveLength(351)
  })
  it('retains unloaded dialogue in the bounded provider fallback prefix', async () => {
    const { project, store } = await fixture()
    const latest = (await store.historyPage(project, 'ws-test'))!
    expect(latest.items.some((row: any) => row.id === 'row-3')).toBe(false)
    expect(latest.dialoguePrefix).toContain('AI：message 3')
    expect(latest.dialoguePrefix).not.toContain('message 349')
    expect(latest.dialoguePrefix!.length).toBeLessThanOrEqual(120_000)
    const saved = await store.saveHistoryWindow(project, 'ws-test', 0, latest.token, latest.start, latest.items)
    expect(saved?.dialoguePrefix).toBe(latest.dialoguePrefix)
  })
  it('keeps durable history when both replicas and compatibility export fail', async () => {
    const { project, store, data } = await fixture()
    const latest = (await store.historyPage(project, 'ws-test'))!
    const replicas = vi.spyOn(data as any, 'writeReplica').mockRejectedValue(new Error('disk failure'))
    const compatibility = vi.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('disk failure'), { code: 'EIO' }))
    try {
      await expect(store.saveHistoryWindow(project, 'ws-test', 0, latest.token, latest.start, [])).rejects.toThrow('disk failure')
    } finally { replicas.mockRestore(); compatibility.mockRestore() }
    expect((await store.historyPage(project, 'ws-test'))?.token).toBe(latest.token)
    expect((await store.readProjection(project, 'ws-test'))?.view.timeline).toHaveLength(350)
  })
  it('migrates embedded legacy events when requesting an event page directly', async () => {
    const { project, store, data } = await fixture()
    const document = (await store.readProjection(project, 'ws-test'))!
    await data.write(project, '.modmind/conversations-v2/ws-test.json', JSON.stringify({ ...document, events: [{ eventId: 'legacy-user', conversationId: 'ws-test', generation: 0, turnId: 'legacy-turn', kind: 'user', sequence: 351, time: '2026-01-01T00:00:00Z', payload: { prompt: 'legacy' } }], lastSequence: 351 }))
    expect((await store.eventsSince(project, 'ws-test', 0, 350, 10)).events.map(e => e.eventId)).toEqual(['legacy-user'])
  })
})
