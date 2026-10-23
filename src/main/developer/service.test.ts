import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeveloperService } from './service'
import { developerBridge } from './tools'
import { prepareFeaturePlugin } from '../featurePluginService'
import { ModMindBridge } from '../externalAgents'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { ProjectInfo } from '../../shared/types'

const archiver = createRequire(import.meta.url)('archiver')

const services: DeveloperService[] = []
const roots: string[] = []
const links: string[] = []
async function fixture(kind: 'feature' | 'studio' = 'feature', portable = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-developer-')); roots.push(root)
  const kit = portable ? path.join(root, 'portable-kit') : path.resolve('resources/developer-kit')
  if (portable) await fs.cp(path.resolve('resources/developer-kit'), kit, { recursive: true })
  const service = new DeveloperService(kit, path.join(root, 'profile')); services.push(service)
  const state = await service.create(root, { id: 'test-authoring', name: '开发验收', kind })
  return { service, state, root, session: state.project.session }
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
  for (const link of links.splice(0)) await fs.unlink(link).catch(() => undefined)
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
describe('independent developer workspace', () => {
  it('forwards renderer events while an action waits and accepts a reply without deadlocking the preview', async () => {
    const { service, session } = await fixture()
    const file = await service.read(session, 'main.ts')
    await service.write(session, file.path, `import type { ActivateOptions } from '@modmind/sdk'
export function activate(options: ActivateOptions) {
  let finish: (() => void) | undefined
  return { actions: {
    wait: () => new Promise(resolve => { finish = () => resolve({ completed: true }); options.emitEvent('waiting', { ready: true }) }),
    reply: () => { if (!finish) throw Error('not waiting'); finish(); return { replied: true } }
  } }
}`, file.revision)
    const config = await service.read(session, 'manifest.json'), manifest = JSON.parse(config.content)
    manifest.events = ['waiting']; manifest.tools = []
    manifest.actions = ['wait','reply'].map(name => ({ id:name,handler:name,permission:'write',projectRequired:true,inputSchema:{type:'object',additionalProperties:false,properties:{}} }))
    await service.write(session, config.path, JSON.stringify(manifest), config.revision)
    await service.build(session)
    let timer: ReturnType<typeof setTimeout>
    const received = new Promise<unknown[]>((resolve,reject) => {
      timer = setTimeout(() => reject(new Error('preview event timeout')), 10000)
      service.onPreviewEvent((channel,args) => { if (channel === 'feature-plugins:event') { clearTimeout(timer); resolve(args) } })
    })
    const waiting = service.previewInvoke(session, 'feature-plugins:invoke', [manifest.id,'wait',{}])
    expect(await received).toEqual([manifest.id,'waiting',{ready:true}])
    expect((await service.previewInvoke(session,'feature-plugins:invoke',[manifest.id,'reply',{}])).result).toEqual({replied:true})
    expect((await waiting).result).toEqual({completed:true})
  }, 120_000)

  it('preserves native package resources above the source project limit through import, checkpoint, preview resources and export', async () => {
    const { service, session, root } = await fixture()
    await service.build(session)
    const prepared = await prepareFeaturePlugin((await service.artifact(session)).file)
    const bytes = Buffer.alloc(5 * 1024 * 1024)
    prepared.files.set('assets/runtime.bin', bytes)
    prepared.manifest.files['assets/runtime.bin'] = createHash('sha256').update(bytes).digest('hex')
    prepared.files.set('manifest.json', Buffer.from(JSON.stringify(prepared.manifest)))
    const archive = path.join(root, 'large-resources.mmfeature')
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(archive), zip = archiver('zip')
      output.on('close', resolve); output.on('error', reject); zip.on('error', reject); zip.pipe(output)
      for (const [name, data] of prepared.files) zip.append(data, { name })
      void zip.finalize().catch(reject)
    })
    const imported = await service.importPackage(archive, root), active = imported.project.session
    expect(imported.files.find(file => file.path === 'assets/runtime.bin')?.bytes).toBe(bytes.length)
    await expect(service.read(active, 'assets/runtime.bin')).rejects.toThrow('二进制')
    await service.checkpoint(active)
    const css = await service.read(active, 'renderer.css')
    await service.write(active, css.path, css.content + '\n.test{}', css.revision)
    await service.restoreCheckpoint(active)
    const build = await service.build(active)
    expect(await service.previewResource(active, build.id, build.manifest.id, 'assets/runtime.bin')).toEqual(bytes)
    await expect(service.previewResource(active, build.id, build.manifest.id, 'main.cjs')).rejects.toThrow('路径无效')
    const exported = await prepareFeaturePlugin((await service.artifact(active)).file)
    expect(exported.files.get('assets/runtime.bin')).toEqual(bytes)
  }, 120_000)

  it('creates a scoped sample project before rendering and shares runtime initialization for parallel preload calls without bypassing readonly', async () => {
    const { service, session } = await fixture()
    await service.build(session)
    const preview = await service.preview(session)
    const metadata = /window\.__devProject=c\.project/.test(preview.html)
    expect(metadata).toBe(true)
    const listed = await service.previewInvoke(session, 'project:current', [])
    const project = listed.result as ProjectInfo
    expect(project.path).toContain('.modmind-dev')
    expect(project).toMatchObject({ kind: 'mod', loader: 'fabric', studioId: 'minecraft-mod' })
    expect(JSON.parse(await fs.readFile(path.join(project.path, 'modmind.project.json'), 'utf8'))).toMatchObject({ path: project.path })
    const manifest = (await service.state(session)).manifest!
    const action = manifest.actions![0].id
    const results = await Promise.all(['你好', 'abcd', 'e'].map(text => service.previewInvoke(session, 'feature-plugins:invoke', [manifest.id, action, { text }])))
    expect(results.map(result => (result.result as { characters: number }).characters)).toEqual([2, 4, 1])
    await expect(service.previewInvoke(session, 'developer:open', ['C:/outside'])).rejects.toThrow('未开放')
    await expect(service.previewInvoke(session, 'feature-plugins:invoke', ['different-package', action, {}])).rejects.toThrow('当前开发包')
    const config = await service.read(session, 'manifest.json'), value = JSON.parse(config.content)
    value.actions[0].permission = 'write'
    await service.write(session, config.path, JSON.stringify(value), config.revision)
    await service.build(session)
    await expect(service.previewInvoke(session, 'feature-plugins:invoke', [manifest.id, action, { text: 'x' }], true)).rejects.toThrow('只读')
  }, 120_000)

  it.each(['feature', 'studio'] as const)('imports an existing %s without activating or changing it, edits compiled files, debugs and re-exports', async kind => {
    const { service, session, root, state } = await fixture(kind)
    const originalMain = await service.read(session, 'main.ts')
    const config = await service.read(session, 'manifest.json'), value = JSON.parse(config.content)
    value.assets = { samples: 'assets/samples' }
    await service.write(session, config.path, JSON.stringify(value), config.revision)
    await service.write(session, 'assets/samples/example.txt', 'imported asset', null)
    await service.build(session)
    const original = await service.artifact(session), archiveBytes = await fs.readFile(original.file)
    const imported = await service.importPackage(original.file, root), active = imported.project.session
    expect(imported.project).toMatchObject({ id: 'test-authoring', kind, sourceMode: 'package' })
    expect(imported.project.root).not.toBe(state.project.root)
    expect(imported.files.some(file => file.path === 'renderer.js')).toBe(true)
    expect(imported.files.some(file => file.path === 'main.ts')).toBe(false)
    expect(await fs.readdir(path.join(imported.project.root, '.modmind-dev/test-projects'))).toEqual([])
    const source = await service.read(active, 'main.cjs')
    const updated = source.content.replace('Array.from(text).length', 'Array.from(text).length + 3')
    expect(updated).not.toBe(source.content)
    await service.write(active, source.path, updated, source.revision)
    const css = await service.read(active, 'renderer.css')
    await service.write(active, css.path, css.content + '\n.imported-change { opacity: .9 }', css.revision)
    await service.build(active)
    const result = await service.debug(active, { operation: 'tool', name: value.tools[0].name, input: { text: '你好' } })
    expect(result.result).toMatchObject({ characters: 5 })
    expect((await service.preview(active)).html).toContain('.imported-change')
    if (kind === 'studio') expect((await service.debug(active, { operation: 'create-studio', input: { name: '导入文稿' } })).result).toMatchObject({ verified: true })
    const artifact = await service.artifact(active), checked = await prepareFeaturePlugin(artifact.file)
    expect(checked.files.get('assets/samples/example.txt')?.toString()).toBe('imported asset')
    expect(checked.files.get('main.cjs')?.toString()).toBe(updated)
    expect(await fs.readFile(original.file)).toEqual(archiveBytes)
    expect(await fs.readFile(path.join(state.project.root, 'main.ts'), 'utf8')).toBe(originalMain.content)
    await expect(service.remove(active, 'main.cjs', (await service.read(active, 'main.cjs')).revision)).rejects.toThrow('不可删除')
    const broken = await service.write(active, 'main.cjs', updated + '\nexports.broken = (', (await service.read(active, 'main.cjs')).revision)
    await expect(service.build(active)).rejects.toThrow('JavaScript 语法错误')
    await service.write(active, broken.path, updated, broken.revision)
    await service.build(active)
    const reopened = await service.open(imported.project.root)
    expect(reopened.project.sourceMode).toBe('package')
    expect((await service.read(reopened.project.session, 'main.cjs')).content).toBe(updated)
  }, 120_000)

  it('rejects corrupt and escaping packages before creating an import project and keeps the current project open', async () => {
    const { service, root, session, state } = await fixture()
    await service.build(session)
    const artifact = await service.artifact(session), prepared = await prepareFeaturePlugin(artifact.file)
    const writeZip = async (name: string, entries: Map<string, Buffer>): Promise<string> => {
      const file = path.join(root, name)
      await new Promise<void>((resolve, reject) => {
        const stream = createWriteStream(file), zip = archiver('zip')
        stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject); zip.pipe(stream)
        for (const [name, data] of entries) zip.append(data, { name })
        void zip.finalize().catch(reject)
      })
      return file
    }
    prepared.files.set('main.cjs', Buffer.from('throw new Error("must not execute")'))
    const corrupt = await writeZip('corrupt.mmfeature', prepared.files)
    await expect(service.importPackage(corrupt, root)).rejects.toThrow('损坏')
    const escaped = new Map(prepared.files); escaped.set('assets/CON.txt', Buffer.from('escape'))
    await expect(service.importPackage(await writeZip('escape.mmfeature', escaped), root)).rejects.toThrow('路径')
    expect(service.assert(session).root).toBe(state.project.root)
    expect((await fs.readdir(root)).some(name => name.includes('-import'))).toBe(false)
    expect(await fs.readFile(path.join(state.project.root, 'main.ts'), 'utf8')).toContain('activate')
  }, 90_000)

  it('discovers and invokes the real stdio MCP chain for edits, build, debug and export; denies readonly and stale sessions', async () => {
    const { service, session, state } = await fixture('feature', true)
    const project: ProjectInfo = { name: state.project.name, path: state.project.root, kind: 'developer', loader: 'extension', minecraftVersion: '1', namespace: 'test', createdAt: '' }
    const clients: { stop: () => Promise<void> }[] = []
    const connect = async (readonly = false) => {
      const bridge = new ModMindBridge(project, developerBridge(service, session, async () => ({ verified: true })), 'test', undefined, readonly)
      const files = await bridge.start()
      const child = spawn(process.execPath, [path.join(path.dirname(files.mcpConfigPath), 'modmind-mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
      let sequence = 0
      const pending = new Map<number, (response: any) => void>()
      const reader = createInterface({ input: child.stdout! })
      reader.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id) })
      const rpc = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')) }, 60_000)
        pending.set(id, response => { clearTimeout(timer); resolve(response) })
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'developer-test', version: '1' } })
      clients.push({ stop: async () => { child.kill(); reader.close(); await bridge.stop() } })
      return { rpc, call: (name: string, args: unknown = {}) => rpc('tools/call', { name, arguments: args }) }
    }
    try {
      const client = await connect()
      const list = await client.rpc('tools/list')
      expect(list.result.tools.map((item: any) => item.name)).toEqual(expect.arrayContaining(['modmind_dev_read', 'modmind_dev_write', 'modmind_dev_build', 'modmind_dev_debug', 'modmind_dev_preview', 'modmind_dev_export']))
      expect(list.result.tools.some((item: any) => item.name === 'modmind_project_setup')).toBe(false)
      const read = await client.call('modmind_dev_read', { operation: 'read', path: 'main.ts' }), source = JSON.parse(read.result.content[0].text)
      const written = await client.call('modmind_dev_write', { path: 'main.ts', content: source.content.replace('Array.from(text).length', 'Array.from(text).length + 2'), revision: source.revision })
      expect(written.result.isError).not.toBe(true)
      expect((await client.call('modmind_dev_build')).result.isError).not.toBe(true)
      const debug = await client.call('modmind_dev_debug', { operation: 'tool', name: 'modmind_test_authoring_check', input: { text: '你好' } })
      const result = JSON.parse(debug.result.content[0].text)
      expect(result.result).toEqual({ characters: 4, lines: 1 })
      expect(result.mcp.response.result.content[0].text).toContain('characters')
      expect(JSON.parse((await client.call('modmind_dev_export')).result.content[0].text).verified).toBe(true)
      expect((await client.call('modmind_dev_write', { path: '../outside', content: 'x', revision: null })).result.isError).toBe(true)
      const readonly = await connect(true)
      expect((await readonly.rpc('tools/list')).result.tools.map((item: any) => item.name)).not.toContain('modmind_dev_write')
      expect((await readonly.call('modmind_dev_write', { path: 'README.md', content: 'x', revision: null })).result.isError).toBe(true)
      await service.open(state.project.root)
      expect((await client.call('modmind_dev_read', { operation: 'info' })).result.isError).toBe(true)
    } finally { for (const client of clients) await client.stop() }
  }, 120_000)

  it('preserves unsaved drafts across reopen and restores AI changes with a reversible checkpoint', async () => {
    const { service, session, state } = await fixture()
    const original = await service.read(session, 'main.ts')
    await service.saveDrafts(session, [{ ...original, content: original.content + '\n// unsaved\n' }])
    const reopened = await service.open(state.project.root), next = reopened.project.session
    expect((await service.drafts(next))[0].content).toContain('unsaved')
    await service.checkpoint(next)
    await service.write(next, 'main.ts', original.content + '\n// AI change\n', original.revision)
    await service.write(next, 'created.ts', 'export const x = 1\n', null)
    await service.restoreCheckpoint(next)
    expect((await service.read(next, 'main.ts')).content).toBe(original.content)
    await expect(service.read(next, 'created.ts')).rejects.toThrow()
    await service.restoreCheckpoint(next)
    expect((await service.read(next, 'main.ts')).content).toContain('AI change')
    expect((await service.read(next, 'created.ts')).content).toContain('x = 1')
  })
  it('creates, edits, type-checks, builds, invokes actions/tools and exports an installable feature without a source repository', async () => {
    const { service, session, state } = await fixture()
    expect(await fs.stat(path.join(state.project.root, 'modmind.project.json')).catch(() => null)).toBeNull()
    const text = await service.read(session, 'main.ts')
    await service.write(session, 'main.ts', text.content.replace('Array.from(text).length', 'Array.from(text).length + 1'), text.revision)
    const build = await service.build(session)
    expect(build.manifest.files['main.cjs']).toMatch(/^[a-f0-9]{64}$/)
    const action = await service.debug(session, { operation: 'action', name: 'check', input: { text: '你好' } })
    expect(action.result).toEqual({ characters: 3, lines: 1 })
    const tool = await service.debug(session, { operation: 'tool', name: 'modmind_test_authoring_check', input: { text: '你好' }, readOnly: true })
    expect(tool.result).toEqual(action.result)
    await expect(service.debug(session, { operation: 'action', name: 'check', input: { text: 42 } })).rejects.toThrow('参数')
    const preview = await service.preview(session)
    expect(preview.html).toContain('Content-Security-Policy')
    expect(preview.pages[0].id).toBe('test-authoring-page')
    const artifact = await service.artifact(session)
    const prepared = await prepareFeaturePlugin(artifact.file)
    expect(prepared.manifest.id).toBe('test-authoring')
    expect(prepared.manifest.apiVersion).toBe(2)
    expect(prepared.files.get('renderer.js')?.toString()).not.toContain('__modmindIcons')
  }, 90_000)

  it('creates a studio test project, verifies files/profiles and produces a host-compatible mmstudio', async () => {
    const { service, session } = await fixture('studio')
    await service.build(session)
    const result = await service.debug(session, { operation: 'create-studio', name: 'test-authoring-domain', input: { name: '独立文稿', style: 'essay' } })
    expect(result.result).toMatchObject({ verified: true, project: { name: '独立文稿', kind: 'test-authoring-document', loader: 'markdown', studioValues: { style: 'essay' } } })
    expect(await fs.readFile(path.join(result.projectPath, 'draft.md'), 'utf8')).toBe('# 独立文稿\n\n')
    expect(JSON.parse(await fs.readFile(path.join(result.projectPath, 'notes-project.json'), 'utf8'))).toEqual({ style: 'essay' })
    expect((result.result as any).ai.inspiration.instructions).toContain('unchanged')
    const artifact = await service.artifact(session)
    expect(artifact.file).toMatch(/\.mmstudio$/)
    expect((await prepareFeaturePlugin(artifact.file)).manifest.studios?.[0].id).toBe('test-authoring-domain')
    await expect(service.debug(session, { operation: 'create-studio', input: { name: '错误版本', version: '2' } })).rejects.toThrow('只读')
  }, 90_000)

  it('keeps revisions, rejects stale builds, scopes tools to the active session and preserves data on reopen', async () => {
    const { service, session, state } = await fixture()
    await service.build(session)
    const file = await service.read(session, 'style.css')
    await service.write(session, 'style.css', file.content + '\n/* changed */', file.revision)
    await expect(service.write(session, 'style.css', 'overwrite', file.revision)).rejects.toThrow('修改')
    await expect(service.preview(session)).rejects.toThrow('源码已变化')
    const bridge = developerBridge(service, session, async () => ({}))
    await expect(bridge.featureInvoke!('developer', 'write', { path: '../outside.txt', content: 'x', revision: null }, { projectPath: state.project.root })).rejects.toThrow('工程内')
    await expect(bridge.featureInvoke!('developer', 'write', { path: 'README.md', content: 'x', revision: null }, { projectPath: state.project.root, readOnly: true })).rejects.toThrow('只读')
    await expect(service.write(session, 'sdk/index.d.ts', 'x', null)).rejects.toThrow('应用管理')
    await expect(service.write(session, 'SDK/index.d.ts', 'x', null)).rejects.toThrow('应用管理')
    await expect(service.write(session, '.MODMIND-DEV/checkpoint.json', 'x', null)).rejects.toThrow('工程内')
    await expect(service.write(session, 'C:/outside.txt', 'x', null)).rejects.toThrow('工程内')
    const reopened = await service.open(state.project.root)
    expect(reopened.project.session).not.toBe(session)
    await expect(bridge.featureTools!('workbench')).rejects.toThrow('切换')
    expect((await service.read(reopened.project.session, 'style.css')).content).toContain('changed')
  }, 90_000)

  it('reports type errors without losing source and retries after repair; validates readonly tools and linked paths', async () => {
    const { service, session, root } = await fixture()
    const source = await service.read(session, 'main.ts')
    const broken = await service.write(session, 'main.ts', source.content + '\nconst broken: number = "text"\n', source.revision)
    await expect(service.build(session)).rejects.toThrow('main.ts')
    expect((await service.read(session, 'main.ts')).content).toContain('broken')
    await service.write(session, 'main.ts', source.content, broken.revision)
    const manifest = await service.read(session, 'manifest.json'), value = JSON.parse(manifest.content)
    value.actions[0].permission = 'write'
    await service.write(session, manifest.path, JSON.stringify(value), manifest.revision)
    await service.build(session)
    await expect(service.debug(session, { operation: 'tool', name: 'modmind_test_authoring_check', input: { text: 'a' }, readOnly: true })).rejects.toThrow('只读')
    const outside = path.join(root, 'outside'); await fs.mkdir(outside)
    const target = path.join(service.assert(session).root, 'linked')
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(target)
    await expect(service.write(session, 'linked/file.txt', 'escape', null)).rejects.toThrow('链接')
    await expect(fs.stat(path.join(outside, 'file.txt'))).rejects.toThrow()
  }, 90_000)
})
