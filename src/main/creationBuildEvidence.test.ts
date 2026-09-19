import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CreationFeedbackService } from './creationFeedbackService'
import { currentVerification } from './creationBuildEvidence'
import type { ProjectInfo } from '../shared/types'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'build-evidence-')); roots.push(root)
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'build'))
  await fs.writeFile(path.join(root, 'src/Main.java'), 'original')
  const project: ProjectInfo = { path: root, name: 'test', namespace: 'test', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  const service = new CreationFeedbackService(project)
  const artifact = { path: path.join(root, 'build/test.jar') }
  const build = async () => { await fs.writeFile(artifact.path, 'compiled'); return artifact }
  return { root, service, build, artifact }
}
it('a failed or cancelled attempt cannot leave a previous build certified', async () => {
  const { service, build } = await fixture()
  await service.build(build); expect(await service.verifyLatestBuild()).toBe(true)
  await expect(service.build(async () => { throw new Error('compiler failed') })).rejects.toThrow('compiler failed')
  expect(await service.verifyLatestBuild()).toBe(false)
  expect((await service.state()).builds.at(-1)?.status).toBe('failed')
  const controller = new AbortController(); controller.abort()
  await expect(service.build(async () => { throw new Error('aborted') }, controller.signal)).rejects.toThrow()
  expect((await service.state()).builds.at(-1)?.status).toBe('cancelled')
})
it('detects changed source, replaced artifact and inputs changed during a build', async () => {
  const { service, build, artifact, root } = await fixture()
  await service.build(build)
  await fs.writeFile(path.join(root, 'src/Main.java'), 'modified')
  expect(await service.verifyLatestBuild()).toBe(false)
  expect((await service.state()).builds.at(-1)?.status).toBe('stale')
  await service.build(build); await fs.writeFile(artifact.path, 'different artifact')
  expect(await service.verifyLatestBuild()).toBe(false)
  await service.build(async () => { await fs.writeFile(path.join(root, 'src/Main.java'), 'changed during compilation'); return build() })
  expect((await service.state()).builds.at(-1)?.status).toBe('stale')
})
it('does not request builds for simple edits and ignores generated diagnostic changes', async () => {
  const { service, build, root } = await fixture()
  await service.begin('wording', '把说明改成中文', 'thread')
  expect((await service.state()).builds).toEqual([])
  expect((await service.state()).tasks[0].delivery).toBeUndefined()
  await service.build(build)
  await fs.mkdir(path.join(root, 'docs')); await fs.writeFile(path.join(root, 'docs/last-ai-response.txt'), 'done')
  expect(await service.verifyLatestBuild()).toBe(true)
  const verified = new Map([['src/Main.java', 'a']])
  expect(currentVerification(true, verified, new Map([...verified, ['logs/latest.log', 'b']]))).toBe(true)
  expect(currentVerification(true, verified, new Map([['src/Main.java', 'new']]))).toBe(false)
  expect(currentVerification(true, null, verified)).toBe(false)
})
