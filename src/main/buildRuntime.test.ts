import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BuildRuntimeManager } from './buildRuntime'
import { CreationFeedbackService } from './creationFeedbackService'
import { archiveRead } from './archiveInspection'
import type { ProjectInfo } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })

it('builds a real modpack artifact and records evidence without a testing plugin or game runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-core-build-')); roots.push(root)
  const project = { path: root, kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', name: 'Core pack', namespace: 'core_pack', createdAt: '' } as ProjectInfo
  await fs.writeFile(path.join(root, 'modmind.project.json'), JSON.stringify(project))
  await fs.writeFile(path.join(root, 'modmind.pack.json'), JSON.stringify({ version: 1, name: project.name, loader: project.loader, minecraftVersion: project.minecraftVersion, mods: [], modules: [] }))
  const manager = new BuildRuntimeManager({ getProject: () => project, onState: () => undefined, onEvent: () => undefined })
  const feedback = new CreationFeedbackService(project)
  const artifact = await feedback.build(() => manager.buildProject())
  expect(artifact.path).toMatch(/\.mrpack$/)
  expect((await fs.stat(artifact.path)).isFile()).toBe(true)
  expect((await archiveRead(artifact.path, 'modrinth.index.json')).toString('utf8')).toContain('Core pack')
  expect((await feedback.state()).builds.at(-1)).toMatchObject({ status: 'built', path: artifact.path })
  expect(await feedback.verifyLatestBuild()).toBe(true)
  await expect(fs.stat(path.join(root, '.modmind', 'minecraft'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await manager.refresh()).stage).toBe('idle')
  await manager.stop()
})
