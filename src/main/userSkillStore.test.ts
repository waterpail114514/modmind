import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseUserSkill, readSkillResource, UserSkillStore } from './userSkillStore'

const roots: string[] = []
async function fixture(): Promise<{ root: string; store: UserSkillStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-user-skills-'))
  roots.push(root)
  return { root, store: new UserSkillStore(path.join(root, 'store')) }
}
const body = (name = 'test-skill', instruction = 'Use only when requested.'): string => `---\nname: ${name}\ndescription: |\n  A custom workflow.\n  Read when relevant.\n---\n\n${instruction}\n`
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })

it('creates, reloads, edits, disables and removes skills with conflict protection', async () => {
  const { root, store } = await fixture()
  expect(await store.list()).toEqual([])
  const first = await store.save({ content: body() })
  expect(first).toMatchObject({ name: 'test-skill', enabled: true })
  expect((await new UserSkillStore(path.join(root, 'store')).list())[0].revision).toBe(first.revision)
  await expect(store.save({ content: body() })).rejects.toThrow('同名')
  const edited = await store.save({ name: first.name, revision: first.revision, content: body(first.name, 'Changed instructions.') })
  await expect(store.save({ name: first.name, revision: first.revision, content: body() })).rejects.toThrow('其他窗口')
  await expect(store.remove(first.name, first.revision)).rejects.toThrow('已被修改')
  await store.setEnabled(first.name, false)
  expect((await store.list())[0].enabled).toBe(false)
  await store.remove(first.name, edited.revision)
  expect(await store.list()).toEqual([])
  expect((await store.save({ content: body() })).enabled).toBe(true)
})

it('imports a folder with resources, while file import copies only SKILL.md', async () => {
  const { root, store } = await fixture()
  const source = path.join(root, 'original')
  await fs.mkdir(path.join(source, 'references'), { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), body())
  await fs.writeFile(path.join(source, 'references', 'guide.md'), 'Reference evidence')
  await store.import(source)
  await expect(store.import(source)).rejects.toThrow('同名')
  await fs.writeFile(path.join(source, 'SKILL.md'), body('single-file'))
  await store.import(path.join(source, 'SKILL.md'))
  expect(await fs.readdir(path.join(root, 'store', 'single-file'))).toEqual(['SKILL.md'])
  await fs.rm(source, { recursive: true })
  const target = path.join(root, 'run', 'user-skills')
  expect((await store.snapshot(target)).map(skill => skill.name)).toEqual(['single-file', 'test-skill'])
  expect(await readSkillResource(target, 'test-skill', 'references/guide.md')).toMatchObject({ content: 'Reference evidence' })
  await store.setEnabled('test-skill', false)
  expect((await store.snapshot(target)).map(skill => skill.name)).toEqual(['single-file'])
  expect(await fs.readdir(target)).toEqual(['single-file'])
})

it('rejects malformed metadata, reserved names, oversized files and traversal', async () => {
  const { root, store } = await fixture()
  for (const name of ['../outside', 'UPPER', 'con', 'bad--name', 'minecraft-build-repair']) expect(() => parseUserSkill(body(name))).toThrow()
  expect(() => parseUserSkill('missing header')).toThrow('YAML')
  expect(() => parseUserSkill('---\nname: test\ndescription: a\ndescription: b\n---\nbody')).toThrow('无效')
  expect(() => parseUserSkill(body().replace('description: |\n  A custom workflow.\n  Read when relevant.', 'description:'))).toThrow('description')
  expect(() => parseUserSkill(body('test', 'x'.repeat(256 * 1024)))).toThrow('256 KiB')
  await store.save({ content: body() })
  await expect(store.read('../outside')).rejects.toThrow()
  const target = path.join(root, 'run')
  await store.snapshot(target)
  for (const resource of ['../outside', '/outside', 'C:\\outside', 'references/../../outside']) await expect(readSkillResource(target, 'test-skill', resource)).rejects.toThrow('相对路径')
  await expect(store.snapshot(path.join(root, 'store'))).rejects.toThrow('分离')
  await expect(store.snapshot(root)).rejects.toThrow('分离')
  expect((await store.read('test-skill')).content).toBe(body())
})

it('rejects linked resources and rolls back failed imports', async () => {
  const { root, store } = await fixture()
  const source = path.join(root, 'source')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'SKILL.md'), body())
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(store.import(source)).rejects.toThrow('符号链接')
    expect(await store.list()).toEqual([])
  } finally { await fs.unlink(path.join(source, 'linked')) }
})

it('serializes simultaneous creates without overwriting the first skill', async () => {
  const { store } = await fixture()
  const results = await Promise.allSettled([store.save({ content: body('same', 'First') }), store.save({ content: body('same', 'Second') })])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect((await store.read('same')).content).toContain('First')
})
