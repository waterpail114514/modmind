import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ServerFixtureService, fixtureJarHash, fixtureVersionMatches } from './serverFixtureService'
import { createStoredZip } from './bedrockAddon'
import type { ProjectInfo } from '../shared/types'
import type { ServerFixtureInput } from '../shared/serverScenario'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-fixture-input-')); roots.push(root)
  const project: ProjectInfo = { path: path.join(root, 'project'), kind: 'modpack', name: 'Test', namespace: 'test', loader: 'forge', loaderVersion: '47.4.23', minecraftVersion: '1.20.1', createdAt: '' }
  await fs.mkdir(project.path)
  const jar = async (id: string, dependencies = '', directory = project.path) => {
    const file = path.join(directory, `${id}.jar`)
    await fs.writeFile(file, createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from(`modLoader="javafml"\n[[mods]]\nmodId="${id}"\nversion="1.0.0"\n${dependencies}`) }]))
    return { path: file, sha256: (await fixtureJarHash(file)).sha256 }
  }
  const service = new ServerFixtureService()
  const input: ServerFixtureInput = { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', jars: [] }
  return { root, project, jar, service, input, signal: new AbortController().signal }
}
it('selects exact fixture JARs and validates required dependencies and fixed versions', async () => {
  const f = await fixture()
  const main = await f.jar('main', '[[dependencies.main]]\nmodId="api"\nmandatory=true\nversionRange="[1.0,2.0)"\n[[dependencies.main]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.20.1]"\n[[dependencies.main]]\nmodId="forge"\nmandatory=true\nversionRange="[47,48)"')
  const api = await f.jar('api')
  const staged = await f.service.stage(f.project, { ...f.input, jars: [main, api] }, path.join(f.root, 'staged'), f.signal)
  expect(staged.mods.map(mod => mod.id)).toEqual(['main', 'api'])
  expect(await fs.readdir(path.join(f.root, 'staged/mods'))).toEqual(['api.jar', 'main.jar'])
  await expect(f.service.stage(f.project, { ...f.input, jars: [main] }, path.join(f.root, 'missing'), f.signal)).rejects.toThrow('缺少必需依赖 api')
  await expect(f.service.stage(f.project, { ...f.input, minecraftVersion: '1.21.1', jars: [main, api] }, path.join(f.root, 'wrong-version'), f.signal)).rejects.toThrow('依赖约束不匹配')
})
it('rejects unauthorized external inputs, hash changes and duplicate mod IDs', async () => {
  const f = await fixture()
  const outside = await f.jar('outside', '', f.root)
  await expect(f.service.stage(f.project, { ...f.input, jars: [outside] }, path.join(f.root, 'unauthorized'), f.signal)).rejects.toThrow('未通过文件选择器授权')
  await f.service.select(f.project, [outside.path])
  expect((await f.service.stage(f.project, { ...f.input, jars: [outside] }, path.join(f.root, 'authorized'), f.signal)).mods[0].id).toBe('outside')
  await expect(f.service.stage(f.project, { ...f.input, jars: [{ ...outside, sha256: 'a'.repeat(64) }] }, path.join(f.root, 'modified'), f.signal)).rejects.toThrow('未通过文件选择器授权')
  const main = await f.jar('main')
  await expect(f.service.stage(f.project, { ...f.input, jars: [{ ...main, sha256: 'a'.repeat(64) }] }, path.join(f.root, 'bad-hash'), f.signal)).rejects.toThrow('SHA-256 不符')
  const duplicate = path.join(f.project.path, 'duplicate.jar'); await fs.copyFile(main.path, duplicate)
  await expect(f.service.stage(f.project, { ...f.input, jars: [main, { ...main, path: duplicate }] }, path.join(f.root, 'duplicate'), f.signal)).rejects.toThrow('模组 ID 重复')
  f.service.remove(f.project, f.service.list(f.project)[0].path)
  expect(f.service.list(f.project)).toEqual([])
  await expect(f.service.stage(f.project, { ...f.input, jars: [outside] }, path.join(f.root, 'revoked'), f.signal)).rejects.toThrow('未通过文件选择器授权')
})
it('uses embedded Forge mods to satisfy dependencies without loading another top-level JAR', async () => {
  const f = await fixture()
  const nested = createStoredZip([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="api"\nversion="1.0.0"') }])
  const file = path.join(f.project.path, 'main.jar')
  await fs.writeFile(file, createStoredZip([
    { name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="main"\nversion="1.0.0"\n[[dependencies.main]]\nmodId="api"\nmandatory=true\nversionRange="[1,2)"') },
    { name: 'META-INF/jarjar/metadata.json', data: Buffer.from(JSON.stringify({ jars: [{ path: 'META-INF/jarjar/api.jar' }] })) },
    { name: 'META-INF/jarjar/api.jar', data: nested }
  ]))
  const staged = await f.service.stage(f.project, { ...f.input, jars: [{ path: file, sha256: (await fixtureJarHash(file)).sha256 }] }, path.join(f.root, 'embedded'), f.signal)
  expect(staged.mods).toContainEqual(expect.objectContaining({ id: 'api', embedded: true }))
})
it('supports numeric Maven bounds and mature semver predicates without guessing unsupported ranges', () => {
  expect(fixtureVersionMatches('47.4.23', '[47,48)', true)).toBe(true)
  expect(fixtureVersionMatches('48.0.0', '[47,48)', true)).toBe(false)
  expect(fixtureVersionMatches('1.20.1', '[1.20.1]', true)).toBe(true)
  expect(fixtureVersionMatches('1.20.2', '[1.20.1]', true)).toBe(false)
  expect(fixtureVersionMatches('0.16.0', '>=0.15.0')).toBe(true)
  expect(fixtureVersionMatches('1.0.0-beta', '>=1.0.0')).toBe(false)
  expect(() => fixtureVersionMatches('1.0.0', '[1,2),[3,4)', true)).toThrow('暂不支持')
  expect(() => fixtureVersionMatches('${version}', '[1,2)', true)).toThrow('无法校验')
})
