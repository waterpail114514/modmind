import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InspirationKnowledgeStore } from './inspirationKnowledgeStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('serializes repeated agent saves, updates by title or id, and notifies only after persistence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-knowledge-')); roots.push(root)
  const changed = vi.fn()
  const store = new InspirationKnowledgeStore(root, changed)
  const project = path.join(root, 'project')
  const [first, second] = await Promise.all([
    store.save(project, { title: '  玩法  ', content: '雷电剑' }),
    store.save(project, { title: '玩法', content: '冷却 10 秒' })
  ])
  expect(second.id).toBe(first.id)
  expect(await store.read(project)).toEqual([second])
  const renamed = await store.save(project, { id: first.id, title: '武器设定', content: '冷却 10 秒；伤害待定' })
  expect(renamed.id).toBe(first.id)
  expect(await new InspirationKnowledgeStore(root).read(project)).toEqual([renamed])
  expect(changed).toHaveBeenLastCalledWith(project, [renamed])
  await expect(store.save(project, { id: 'missing', title: '设定', content: '不可新建' })).rejects.toThrow('不存在')
  await expect(store.save(project, { title: ' ', content: '无标题' })).rejects.toThrow()
  await expect(store.save(project, { title: '设定', content: 'a'.repeat(20001) })).rejects.toThrow()
  await expect(store.save(project, { title: '设定', content: 123 })).rejects.toThrow()
  expect(changed).toHaveBeenCalledTimes(3)
  expect(await store.read(project)).toEqual([renamed])
})

it('requires an id for ambiguous titles and rejects ids belonging to other projects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-knowledge-')); roots.push(root)
  const store = new InspirationKnowledgeStore(root)
  const project = path.join(root, 'project')
  await store.update(project, { title: '设定', content: '甲' })
  await store.update(project, { title: '设定', content: '乙' })
  await expect(store.save(project, { title: '设定', content: '丙' })).rejects.toThrow('多个同名')
  const foreign = await store.save(path.join(root, 'other'), { title: '设定', content: '其他项目' })
  await expect(store.save(project, { id: foreign.id, title: '设定', content: '丙' })).rejects.toThrow('不存在')
  expect(await store.read(project)).toHaveLength(2)
})
