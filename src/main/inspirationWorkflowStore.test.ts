import { afterEach, expect, it } from 'vitest'
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
