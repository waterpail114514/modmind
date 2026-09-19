import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CreationFeedbackService } from './creationFeedbackService'
import { summarizeLog } from '../shared/creationFeedback'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-feedback-')); roots.push(root)
  return new CreationFeedbackService({ path: root, loader: 'paper', minecraftVersion: '1.20.1', namespace: 'test' } as ProjectInfo)
}
it('groups repeated full causal chains without dropping prose or independent errors', async () => {
  const service = await fixture()
  const chain = 'java.lang.IllegalStateException: failed\n    at test.Skill.run(Skill.java:12)\nCaused by: java.lang.IllegalArgumentException: bad\n    at test.API.call(API.java:2)'
  const text = '左键后没有效果，请保留声音\n' + Array.from({ length: 64 }, (_, i) => `[12:34:${String(i % 60).padStart(2, '0')} ERROR] ${chain}`).join('\n') + '\njava.io.IOException: separate\n    at test.Other.run(Other.java:3)\n仍然不行'
  const digest = summarizeLog(text)
  expect(digest.issues).toHaveLength(2)
  expect(digest.issues[0].count).toBe(64)
  expect(digest.issues[0].stack).toContain('Caused by:')
  expect(digest.observations).toContain('请保留声音')
  const result = await service.evidence(text, 'user')
  expect(result.prompt.length).toBeLessThan(text.length / 5)
  expect((await service.read(result.id, 1, 300)).text).toContain('Skill.java:12')
  await expect(service.read('../state')).rejects.toThrow()
})
it('preserves changed requirements, failures, raw evidence and conversation boundaries on recovery', async () => {
  const service = await fixture()
  await service.begin('first', '禁止假人', 'a')
  let state = await service.state()
  await service.requirement(state.revision, { id: 'old', text: '禁止假人', sourceMessageId: 'first', author: 'user', status: 'active' })
  await service.begin('second', '允许视觉假人，但不修改真实玩家位移', 'a')
  state = await service.state()
  await service.requirement(state.revision, { id: 'new', text: '允许视觉假人，但不修改真实玩家位移', sourceMessageId: 'second', replaces: 'old', author: 'user', status: 'active' })
  await service.begin('other', '不相关的另一个对话', 'b')
  await service.begin('failed1', '还是不行', 'a'); await service.begin('failed2', '还是不行', 'a')
  const restored = await new CreationFeedbackService(service.project).recover('继续', 'a', '早期旧记录')
  expect(restored).toContain('允许视觉假人')
  expect(restored).not.toContain('不相关的另一个对话')
  expect((await service.state()).tasks.filter(task => task.failure)).toHaveLength(2)
  await expect(service.requirement(0, { id: 'bad', text: 'bad', sourceMessageId: 'first', author: 'user', status: 'active' })).rejects.toThrow('刷新')
})
it('ties checks to explicit builds without promoting compilation to gameplay success', async () => {
  const service = await fixture(); const file = path.join(service.project.path, 'test.jar')
  await fs.writeFile(file, 'artifact'); await service.built({ path: file })
  let state = await service.state()
  expect(state.builds[0].sha256).toHaveLength(64)
  expect(state.checks).toEqual([])
  await service.check({ stage: 'interaction', passed: false, detail: '点击没有生效', buildId: state.builds[0].id })
  state = await service.state()
  expect(state.checks[0]).toMatchObject({ passed: false, stage: 'interaction', buildId: state.builds[0].id })
})
it('keeps explicit partial delivery after a final answer and across later turns', async () => {
  const service = await fixture()
  await service.begin('cards', '制作七套可玩的卡组', 'a')
  await service.delivery('cards', { status: 'partial', remaining: ['实现七套卡表与展开'], evidenceIds: [] })
  await service.mutate(state => { state.tasks[0].answer = '已完成预览框架，玩法未完成' })
  for (let i = 0; i < 7; i++) { await service.begin(`later-${i}`, '其他修改', 'a'); await service.mutate(state => { state.tasks.at(-1)!.answer = '完成' }) }
  expect(await service.recover('继续', 'a')).toContain('实现七套卡表与展开')
  await expect(service.delivery('cards', { status: 'complete', remaining: ['还未实现'], evidenceIds: [] })).rejects.toThrow()
  await service.delivery('cards', { status: 'complete', remaining: [], evidenceIds: [] })
  expect(await service.recover('继续', 'a')).not.toContain('实现七套卡表与展开')
})
