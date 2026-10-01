import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import { createStoredZip } from './bedrockAddon'
import { activate } from '../../feature-plugins/decompile/main'
import { createDecompileCacheStaging } from '../../feature-plugins/decompile/src/main/decompileCache'
import type { NativeFeatureHost } from './index'
import type { ProjectInfo } from '../shared/types'
import type { FeaturePluginAction } from '../shared/featurePlugins'

const environment = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => environment.userData } }))

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-decompile-query-'))
  roots.push(root)
  environment.userData = path.join(root, 'user-data')
  const project = (name: string): ProjectInfo => ({ name, path: path.join(root, name), namespace: name, loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' })
  const current = project('current'), other = project('other')
  const cache = path.join(environment.userData, 'decompile')
  const seed = async (project: ProjectInfo, name: string) => {
    await fs.mkdir(path.join(project.path, '.modmind', 'attachments'), { recursive: true })
    const bytes = createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: project.namespace, version: '1.0.0' })) }])
    await fs.writeFile(path.join(project.path, 'original.jar'), bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const staging = await createDecompileCacheStaging(cache, sha256)
    const text = `class ${name} {}`
    await fs.writeFile(path.join(staging.staging, 'sources', `${name}.java`), text)
    await staging.finalize({ schemaVersion: 1, readOnly: true, sourceSha256: sha256, sourceFileName: 'original.jar', sourceSize: bytes.length,
      createdAt: new Date().toISOString(), engine: 'vineflower', engineVersion: '1.11.1', engineArgs: [], obfuscationHint: 'clear' })
    return { sha256, text, bytes }
  }
  const a = await seed(current, 'Current'), b = await seed(other, 'Foreign')
  await fs.writeFile(path.join(current.path, '.modmind', 'attachments', 'original.jar'), a.bytes)
  const runtime = activate({ host: { requireProject: () => current, event: () => ({}) } as unknown as NativeFeatureHost })
  const query = (input: Record<string, unknown>) => runtime.actions.query(input, { projectPath: current.path, readOnly: true, surface: 'inspiration' })
  return { current, other, a, b, query }
}

describe('decompile plugin project-bound cache queries', () => {
  it('reads only the cache identified by an original project or attachment JAR', async () => {
    const { a, query } = await fixture()
    for (const sourcePath of ['original.jar', '.modmind/attachments/original.jar']) {
      expect(await query({ operation: 'files', sourcePath })).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: 'Current.java' })]))
      expect(await query({ operation: 'read', sourcePath, path: 'Current.java', sourceSha256: a.sha256 })).toBe(a.text)
    }
  })

  it('rejects another project hash and another project original JAR path', async () => {
    const { b, other, query } = await fixture()
    for (const operation of ['files', 'read']) {
      await expect(query({ operation, sourcePath: 'original.jar', path: 'Foreign.java', sourceSha256: b.sha256 })).rejects.toThrow('来源哈希')
      await expect(query({ operation, sourcePath: '../other/original.jar', path: 'Foreign.java' })).rejects.toThrow('inside the project')
      await expect(query({ operation, sourcePath: path.join(other.path, 'original.jar'), path: 'Foreign.java' })).rejects.toThrow('project-relative')
    }
    await expect(query({ operation: 'read', sourceSha256: b.sha256, path: 'Foreign.java' })).rejects.toThrow('project-relative')
  })

  it('refuses a cached hash after the current original JAR changes', async () => {
    const { current, a, b, query } = await fixture()
    await fs.writeFile(path.join(current.path, 'original.jar'), b.bytes)
    await expect(query({ operation: 'read', sourcePath: 'original.jar', path: 'Current.java', sourceSha256: a.sha256 })).rejects.toThrow('来源哈希')
    expect(await query({ operation: 'read', sourcePath: 'original.jar', path: 'Foreign.java' })).toBe(b.text)
  })

  it('requires operation-specific fields in the declared schema', async () => {
    const contributions = JSON.parse(await fs.readFile(path.resolve('feature-plugins/decompile/main-contributions.json'), 'utf8')) as { actions: FeaturePluginAction[] }
    const schema = contributions.actions.find(action => action.id === 'query')!.inputSchema
    const validate = new Ajv({ strictSchema: true, strictTypes: false }).compile(schema)
    expect(validate({ operation: 'terms' })).toBe(true)
    for (const operation of ['inspect', 'files', 'read', 'references']) {
      expect(validate({ operation })).toBe(false)
      expect(validate({ operation, sourceSha256: 'a'.repeat(64) })).toBe(false)
      expect(validate({ operation, sourcePath: 'original.jar', ...(operation === 'read' ? { path: 'Current.java' } : {}) })).toBe(true)
    }
    expect(validate({ operation: 'read', sourcePath: 'original.jar' })).toBe(false)
    expect(validate({ operation: 'read', sourcePath: 'original.jar', path: '' })).toBe(false)
  })
})
