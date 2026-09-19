import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { captureCreationRequest } from './creationEvidence'
import { projectSearchFiles, searchProjectText } from './projectSearch'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<ProjectInfo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-creation-'))
  roots.push(root)
  return { path: root, loader: 'paper', namespace: 'test', name: 'Test', minecraftVersion: '1.20.1', createdAt: '' }
}
it('archives repeated feedback once and never appends it to existing requirements', async () => {
  const project = await fixture()
  await captureCreationRequest(project, 'Make a skill')
  const target = path.join(project.path, 'docs/idea.md')
  const initial = await fs.readFile(target, 'utf8')
  const log = 'java.lang.IllegalStateException: failed\n    at example.Skill.run(Skill.java:10)\n'.repeat(64)
  await captureCreationRequest(project, log)
  await captureCreationRequest(project, log)
  expect(await fs.readFile(target, 'utf8')).toBe(initial)
  const evidence = path.join(project.path, '.modmind/request-evidence')
  const files = await fs.readdir(evidence)
  expect(files).toHaveLength(2)
  expect(await Promise.all(files.map(file => fs.readFile(path.join(evidence, file), 'utf8')))).toContain(log.trim())
})
it('does not turn an initial crash log into a specification', async () => {
  const project = await fixture()
  await captureCreationRequest(project, 'java.lang.IllegalStateException: failed\n    at example.run(Test.java:1)')
  const idea = await fs.readFile(path.join(project.path, 'docs/idea.md'), 'utf8')
  expect(idea).toContain('request-evidence/')
  expect(idea).not.toContain('IllegalStateException')
})
it('searches code/config with bounded snippets while excluding history and builds', async () => {
  const project = await fixture()
  for (const file of ['src/Skill.java', 'config/test.yml', '.modmind/chat.json', '.modmind/request-evidence/chat.txt', 'build/test.java', 'target/test.java', 'logs/latest.log', 'src/old.bak']) {
    const target = path.join(project.path, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'needle\n' + 'x'.repeat(1500) + 'needle')
  }
  expect((await projectSearchFiles(project)).files).toEqual(['config/test.yml', 'src/Skill.java'])
  const result = await searchProjectText(project, 'needle', 3)
  expect(result.matches).toHaveLength(3)
  expect(result.truncated).toBe(true)
  expect(result.matches.every(m => m.text.length <= 802)).toBe(true)
  expect(result.matches[1].line).toBe(2)
})
