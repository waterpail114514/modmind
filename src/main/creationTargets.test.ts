import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CreationFeedbackService } from './creationFeedbackService'
import type { ProjectInfo } from '../shared/types'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
it('records real child-project changes and missing delivery inputs, not only active-project files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-project-')); roots.push(root)
  const project: ProjectInfo = { path: root, name: 'engine', namespace: 'engine', loader: 'neoforge', minecraftVersion: '1.21.1', createdAt: '' }
  const service = new CreationFeedbackService(project)
  await fs.mkdir(path.join(root, 'cards'))
  await fs.writeFile(path.join(root, 'cards/card.json'), '{}')
  await fs.writeFile(path.join(root, 'cards/settings.gradle'), "include(':missing')\nproject(':missing').projectDir = file('data-pack')\n")
  await service.begin('batch', '改造卡牌子项目', 'a')
  await service.target('batch', 'cards')
  await fs.writeFile(path.join(root, 'cards/card.json'), '{"effect":1}')
  await fs.mkdir(path.join(root, 'cards/build')); await fs.writeFile(path.join(root, 'cards/build/cards.jar'), 'cards')
  const target = await service.target('batch', 'cards', ['build/cards.jar']) as { changedFiles: string[]; artifacts: Array<{ sha256: string }>; missing: string[] }
  expect(target.changedFiles).toEqual(['card.json'])
  expect(target.artifacts[0].sha256).toHaveLength(64)
  expect(target.missing[0]).toContain('data-pack')
  await expect(service.delivery('batch', { status: 'complete', remaining: [], evidenceIds: [] })).rejects.toThrow('缺失')
  await expect(service.target('batch', os.tmpdir())).rejects.toThrow('目标必须')
  await expect(service.target('batch', 'cards', ['../../outside.jar'])).rejects.toThrow()
  await fs.mkdir(path.join(root, 'cards/data-pack'))
  const finished = await service.finishTargets('batch')
  expect(finished[0].missing).toEqual([])
  expect(finished[0].changedFiles).toEqual(['card.json'])
  await service.delivery('batch', { status: 'complete', remaining: [], evidenceIds: [] })
  await fs.writeFile(path.join(root, 'cards/build/cards.jar'), 'replaced artifact')
  await service.finishTargets('batch')
  expect((await service.state()).tasks[0].delivery?.status).toBe('blocked')
  await fs.writeFile(path.join(root, 'cards/build.gradle'), "dependencies { implementation files('libs/missing.jar') }")
  const checked = await service.finishTargets('batch')
  expect(checked[0].missing?.join('\n')).toContain('libs/missing.jar')
})
