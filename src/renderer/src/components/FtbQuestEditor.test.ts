import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearFtbIconClient, requestFtbIcon } from '../lib/ftbIconClient'
import { rewriteFtbQuestReferences } from '../../../shared/ftbQuestReferences'
import type { FtbQuestBook, FtbQuestIconInspection } from '../../../shared/types'

afterEach(() => { clearFtbIconClient(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const result = (reason = 'resolved', icon: FtbQuestIconInspection['icon'] = null): FtbQuestIconInspection => ({ icon, reason, sources: [], generation: 1 })
describe('FTB editor resource requests and references', () => {
  it('coalesces canonical descriptors and binds every request to its project', async () => {
    const inspect = vi.fn(async () => result())
    vi.stubGlobal('window', { modmind: { modpack: { inspectFtbQuestIcon: inspect } } })
    await Promise.all([
      requestFtbIcon('a', 'a:1.20.1:1', { id: 'test:a', tag: { x: 1, y: 2 } }),
      requestFtbIcon('a', 'a:1.20.1:1', { tag: { y: 2, x: 1 }, id: 'test:a' })
    ])
    expect(inspect).toHaveBeenCalledTimes(1)
    expect((inspect.mock.calls as unknown as unknown[][])[0][1]).toBe('a')
    await requestFtbIcon('b', 'b:1.20.1:1', 'test:a')
    await requestFtbIcon('a', 'a:1.20.1:2', 'test:a')
    expect(inspect).toHaveBeenCalledTimes(3)
  })
  it('uses unified remote models only when a local Minecraft resource is unavailable', async () => {
    const inspect = vi.fn().mockResolvedValueOnce(result('Model unavailable: assets/minecraft/models/item/book.json')).mockResolvedValueOnce(result('remote'))
    vi.stubGlobal('window', { modmind: { modpack: { inspectFtbQuestIcon: inspect } } })
    expect((await requestFtbIcon('a', 'a:1', 'minecraft:book')).reason).toBe('remote')
    expect(inspect).toHaveBeenNthCalledWith(2, 'minecraft:book', 'a', true)
    inspect.mockResolvedValue(result('builtin/entity requires renderer'))
    await requestFtbIcon('a', 'a:1', 'test:entity')
    expect(inspect).toHaveBeenCalledTimes(3)
  })
  it('retries network failures after their shorter negative cache lifetime', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const inspect = vi.fn(async () => result('Remote network failure'))
    vi.stubGlobal('window', { modmind: { modpack: { inspectFtbQuestIcon: inspect } } })
    await requestFtbIcon('a', 'a:1', 'test:a')
    now += 9000
    await requestFtbIcon('a', 'a:1', 'test:a')
    expect(inspect).toHaveBeenCalledTimes(1)
    now += 2000
    await requestFtbIcon('a', 'a:1', 'test:a')
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it('rewrites cross-chapter quest/task references and removes deleted links', () => {
    const book = { chapters: [
      { id: 'C1', raw: { quest_links: [{ id: 'L1', quest: 'Q1' }] }, quests: [] },
      { id: 'C2', raw: {}, quests: [{ id: 'Q2', dependencies: ['Q1', 'T1'] }] }
    ] } as unknown as FtbQuestBook
    const next = rewriteFtbQuestReferences(book, new Map([['Q1', 'Q3'], ['T1', null]]))
    expect(next.chapters[1].quests[0].dependencies).toEqual(['Q3'])
    expect(next.chapters[0].raw.quest_links).toEqual([{ id: 'L1', quest: 'Q3' }])
    expect(rewriteFtbQuestReferences(next, new Map([['Q3', null]])).chapters[0].raw.quest_links).toEqual([])
    expect(book.chapters[1].quests[0].dependencies).toEqual(['Q1', 'T1'])
  })
})
