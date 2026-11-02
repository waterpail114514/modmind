import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { InspirationKnowledgeStore } from './inspirationKnowledgeStore'
import { InspirationWorkflowStore } from './inspirationWorkflowStore'
import { normalizeInspirationFeatures } from '../shared/inspirationFeatures'
import { INSPIRATION_OPEN, INSPIRATION_CLOSE } from '../shared/inspirationWorkflow'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const identity = { conversationId: 'idea', turnId: 'turn', generation: 0 }
const response = (content = '雷鸣剑冷却 8 秒', sourceQuote = '冷却 8 秒') => INSPIRATION_OPEN + JSON.stringify({
  version: 1, reply: '已整理', prompt: { state: 'ready', text: content, blockingQuestionIds: [] }, questions: [], suggestions: [],
  knowledgeCandidates: [{ title: '雷鸣剑', content, scope: 'task', sourceMessageIds: ['turn:user'], sourceQuote }]
}) + INSPIRATION_CLOSE
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-inspiration-workflow-')); roots.push(root)
  const knowledge = new InspirationKnowledgeStore(path.join(root, 'knowledge'))
  return { root, knowledge, project: path.join(root, 'project'), store: new InspirationWorkflowStore(path.join(root, 'workflows'), knowledge) }
}

it.each([true, false])('saves and undoes fourteen notes atomically (autoSave=%s)', async autoSaveKnowledge => {
  const { knowledge, project, store } = await fixture()
  const input = { knowledge: Array.from({ length: 14 }, (_, index) => ({ title: `知识 ${index + 1}`, content: `冷却 8 秒，条目 ${index + 1}`, sourceQuote: '冷却 8 秒' })),
    prompt: { state: 'ready', text: '完整制作十四项' } }
  const staged = await store.submit(project, identity, input, normalizeInspirationFeatures({ autoSaveKnowledge }), '冷却 8 秒', [])
  expect(staged.changes).toHaveLength(14)
  expect(await knowledge.read(project)).toEqual([])
  const finalized = await store.finalize(project, identity)
  expect(finalized?.status).toBe(autoSaveKnowledge ? 'saved' : 'pending')
  if (!autoSaveKnowledge) await store.commit(project, identity, input.knowledge.map((note, index) => ({ index, title: note.title, content: note.content })))
  expect(await knowledge.read(project)).toHaveLength(14)
  expect((await store.read(project, identity))?.workflow?.prompt?.text).toBe('完整制作十四项')
  expect(await knowledge.read(project + '-other')).toEqual([])
  await store.commit(project, identity, [], true)
  expect(await knowledge.read(project)).toEqual([])
})

it('automatically saves once, reopens without replay writes, and undoes only its own changes', async () => {
  const { root, knowledge, project, store } = await fixture()
  const features = normalizeInspirationFeatures()
  const first = await store.register(project, identity, response(), features, '做雷鸣剑，冷却 8 秒', [])
  expect(first?.status).toBe('saved')
  const note = (await knowledge.read(project))[0]
  expect(note.sourceMessageIds).toEqual(['turn:user'])
  expect(await store.register(project, identity, response(), features, '冷却 8 秒', [])).toEqual(first)
  const reopened = new InspirationWorkflowStore(path.join(root, 'workflows'), knowledge)
  expect((await reopened.read(project, identity))?.status).toBe('saved')
  expect((await reopened.commit(project, identity, [], true)).status).toBe('undone')
  expect(await knowledge.read(project)).toEqual([])
  expect(await knowledge.read(path.join(root, 'other'))).toEqual([])
})
it('requires manual confirmation when auto-save is disabled and retains user edits', async () => {
  const { knowledge, project, store } = await fixture()
  const record = await store.register(project, identity, response(), normalizeInspirationFeatures({ autoSaveKnowledge: false }), '冷却 8 秒', [])
  expect(record?.status).toBe('pending')
  expect(await knowledge.read(project)).toEqual([])
  await store.commit(project, identity, [{ index: 0, title: '技能设定', content: '冷却 9 秒，由用户编辑' }])
  expect((await knowledge.read(project))[0].content).toBe('冷却 9 秒，由用户编辑')
})
it('rejects fabricated sources and stale baselines without partial writes', async () => {
  const { knowledge, project, store } = await fixture()
  const invalid = await store.register(project, identity, response('内容', '并不存在'), normalizeInspirationFeatures(), '冷却 8 秒', [])
  expect(invalid?.status).toBe('error')
  expect(await knowledge.read(project)).toEqual([])
  const baseline = [await knowledge.save(project, { title: '雷鸣剑', content: '冷却 10 秒' })]
  await knowledge.save(project, { id: baseline[0].id, title: '雷鸣剑', content: '另一会话：冷却 20 秒' })
  const stale = await store.register(project, { ...identity, turnId: 'another' }, response().replace('turn:user', 'another:user'), normalizeInspirationFeatures(), '冷却 8 秒', baseline)
  expect(stale?.status).toBe('error')
  expect((await knowledge.read(project))[0].content).toContain('20 秒')
})
it('refuses undo after a later manual edit and never saves incomplete or forbidden candidates', async () => {
  const { knowledge, project, store } = await fixture()
  expect(await store.register(project, identity, response().slice(0, -10), normalizeInspirationFeatures(), '冷却 8 秒', [])).toBeNull()
  await store.register(project, identity, response(), normalizeInspirationFeatures(), '冷却 8 秒', [])
  const note = (await knowledge.read(project))[0]
  await knowledge.update(project, { id: note.id, title: note.title, content: '手动修改' })
  await expect(store.commit(project, identity, [], true)).rejects.toThrow('其他操作')
  await store.register(project, { ...identity, turnId: 'disabled' }, response().replace('turn:user', 'disabled:user'), normalizeInspirationFeatures({ knowledgeOrganization: false }), '冷却 8 秒', [])
  expect(await knowledge.read(project)).toHaveLength(1)
})

it('does not overwrite unread knowledge or commit a cancelled answer', async () => {
  const { knowledge, project, store } = await fixture()
  const note = await knowledge.save(project, { title: '雷鸣剑', content: '保留旧设定' })
  const denied = await store.register(project, identity, response(), normalizeInspirationFeatures({ projectKnowledge: false }), '冷却 8 秒', [note])
  expect(denied?.status).toBe('error')
  expect(await knowledge.read(project)).toEqual([note])
  const cancelled = new AbortController(); cancelled.abort()
  await expect(store.register(project, { ...identity, turnId: 'cancelled' }, response().replace('turn:user', 'cancelled:user'), normalizeInspirationFeatures(), '冷却 8 秒', [note], cancelled.signal)).rejects.toThrow()
  expect(await knowledge.read(project)).toEqual([note])
})

it('keeps the draft when completion is cancelled during its asynchronous read', async () => {
  const { knowledge, project, store } = await fixture()
  await store.submit(project, identity, { knowledge: [{ title: '雷鸣剑', content: '冷却 8 秒', sourceQuote: '冷却 8 秒' }] }, normalizeInspirationFeatures(), '冷却 8 秒', [])
  const controller = new AbortController()
  const read = store.read.bind(store)
  const spy = vi.spyOn(store, 'read').mockImplementationOnce(async (...args) => {
    const value = await read(...args)
    controller.abort()
    return value
  })
  await expect(store.finalize(project, identity, controller.signal)).rejects.toThrow()
  spy.mockRestore()
  expect((await store.read(project, identity))?.status).toBe('staged')
  expect(await knowledge.read(project)).toEqual([])
})

it('stages and corrects tool artifacts, finalizes once, then supports undo and project isolation', async () => {
  const { knowledge, project, store } = await fixture()
  const features = normalizeInspirationFeatures()
  const input = { knowledge: [{ title: '雷鸣剑', content: '冷却 8 秒', sourceQuote: '冷却 8 秒' }], prompt: { state: 'ready', text: '制作雷鸣剑' } }
  const staged = await store.submit(project, identity, input, features, '冷却 8 秒', [])
  expect(staged.status).toBe('staged')
  expect(staged.workflow?.knowledgeCandidates[0].sourceMessageIds).toEqual(['turn:user'])
  expect(await knowledge.read(project)).toEqual([])
  await expect(store.commit(project, identity, [{ index: 0, title: '雷鸣剑', content: '绕过完成' }])).rejects.toThrow('尚未完成')
  await expect(store.submit(project, identity, { knowledge: [{ ...input.knowledge[0], sourceQuote: '伪造引用' }] }, features, '冷却 8 秒', [])).rejects.toThrow('sourceQuote')
  expect((await store.read(project, identity))?.workflow?.prompt?.text).toBe('制作雷鸣剑')
  const saved = await store.finalize(project, identity)
  expect(saved?.status).toBe('saved')
  expect(await store.finalize(project, identity)).toEqual(saved)
  expect(await store.submit(project, identity, input, features, '冷却 8 秒', [])).toEqual(saved)
  expect(await knowledge.read(project)).toHaveLength(1)
  expect(await knowledge.read(project + '-other')).toEqual([])
  await store.commit(project, identity, [], true)
  expect(await knowledge.read(project)).toEqual([])
})

it('retains cancelled drafts without saving and respects manual confirmation and version conflicts', async () => {
  const { knowledge, project, store } = await fixture()
  const input = { knowledge: [{ title: '雷鸣剑', content: '冷却 8 秒', sourceQuote: '冷却 8 秒' }] }
  await store.submit(project, identity, input, normalizeInspirationFeatures(), '冷却 8 秒', [])
  await expect(store.finalize(project, identity, AbortSignal.abort())).rejects.toThrow()
  expect((await store.read(project, identity))?.status).toBe('staged')
  expect(await knowledge.read(project)).toEqual([])
  const next = { ...identity, turnId: 'manual' }
  await store.submit(project, next, input, normalizeInspirationFeatures({ autoSaveKnowledge: false }), '冷却 8 秒', [])
  expect((await store.finalize(project, next))?.status).toBe('pending')
  expect(await knowledge.read(project)).toEqual([])
  await store.commit(project, next, [{ index: 0, title: '雷鸣剑', content: '冷却 9 秒' }])
  const baseline = await knowledge.read(project)
  const conflict = { ...identity, turnId: 'conflict' }
  await store.submit(project, conflict, { knowledge: [{ ...input.knowledge[0], scope: 'project', id: baseline[0].id, expectedUpdatedAt: baseline[0].updatedAt }] },
    normalizeInspirationFeatures(), '冷却 8 秒', baseline)
  await knowledge.update(project, { id: baseline[0].id, title: baseline[0].title, content: '另一个会话修改' })
  expect((await store.finalize(project, conflict))?.status).toBe('error')
  expect((await knowledge.read(project))[0].content).toBe('另一个会话修改')
})
