import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { FeaturePluginService, type FeaturePluginHost, type PreparedPlugin } from './featurePluginService'
import type { FeaturePluginManifest } from '../shared/featurePlugins'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function manager() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-feature-')); roots.push(root)
  const options: FeaturePluginHost = { requireFrom: path.resolve('package.json'), capabilities: {}, options: () => ({}), busy: () => false, changed: () => undefined }
  const manager = new FeaturePluginService(root, options); await manager.initialize()
  return { root, manager, options }
}
async function fixture(code = 'exports.activate = () => ({ hello: () => "ready" })', overrides: Partial<FeaturePluginManifest> = {}): Promise<PreparedPlugin> {
  const files = new Map([['main.cjs', Buffer.from(code)], ['renderer.js', Buffer.from('/* fixture renderer */')], ['renderer.css', Buffer.from('')]])
  const manifest: FeaturePluginManifest = { format: 'modmind-feature', apiVersion: 2, hostVersion: '1.5.0-plugintest', id: 'image-studio', name: '图像工坊', version: '1.5.0-plugintest', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', files: Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])), ...overrides }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  return { files, manifest }
}
describe('native application feature lifecycle', () => {
  it('rejects a testingV2 update on an earlier host and keeps the previous version usable', async () => {
    const { manager: service, options } = await manager()
    await service.install(await fixture(undefined, { version: '1.0.1' }))
    const next = await fixture(undefined, { version: '1.0.2', hostCapabilities: ['testingV2'] })
    await expect(service.update(next)).rejects.toThrow('宿主缺少')
    expect(service.list()[0].version).toBe('1.0.1')
    expect(service.service<{ hello: () => string }>('image-studio').hello()).toBe('ready')
    Object.assign(options.capabilities, { testingV2: true })
    await service.update(next)
    expect(service.list()[0].version).toBe('1.0.2')
    expect(service.service<{ hello: () => string }>('image-studio').hello()).toBe('ready')
  })
  it('installs atomically, serves only verified public assets, persists disabling and preserves unrelated user data', async () => {
    const { root, manager: service, options } = await manager()
    expect(service.list()).toEqual([])
    expect(() => service.service('image-studio')).toThrow('未启用')
    const prepared = await fixture()
    await service.install(prepared)
    expect(service.service<{ hello: () => string }>('image-studio').hello()).toBe('ready')
    expect((await service.serve(new Request('modmind-feature://image-studio/renderer.js'))).status).toBe(200)
    expect((await service.serve(new Request('modmind-feature://image-studio/main.cjs'))).status).toBe(404)
    await expect(service.install(prepared)).rejects.toThrow('已安装')
    await service.setEnabled('image-studio', false)
    const restarted = new FeaturePluginService(root, options); await restarted.initialize()
    expect(restarted.enabled('image-studio')).toBe(false)
    await restarted.setEnabled('image-studio', true)
    expect(restarted.service<{ hello: () => string }>('image-studio').hello()).toBe('ready')
    await fs.writeFile(path.join(root, 'user-history.json'), 'keep')
    await restarted.uninstall('image-studio')
    expect(await fs.readFile(path.join(root, 'user-history.json'), 'utf8')).toBe('keep')
    await restarted.install(prepared)
    expect(restarted.enabled('image-studio')).toBe(true)
  })
  it('refuses corrupt code, incompatible versions and path manipulation', async () => {
    const { root, manager: service, options } = await manager()
    const prepared = await fixture()
    prepared.files.set('renderer.js', Buffer.from('tampered'))
    await expect(service.install(prepared)).rejects.toThrow('损坏')
    expect(service.list()).toEqual([])
    const compatible = await fixture()
    compatible.manifest.hostVersion = '0.0.0'
    compatible.files.set('manifest.json', Buffer.from(JSON.stringify(compatible.manifest)))
    await expect(service.install(compatible)).rejects.toThrow('不兼容')
    await expect(service.uninstall('../outside')).rejects.toThrow('不存在')
    await expect(service.install(await fixture(undefined, { apiVersion: 1 }))).rejects.toThrow('API 2')
    await expect(service.install(await fixture(undefined, { target: { platform: 'unsupported', arch: process.arch } }))).rejects.toThrow('操作系统或架构')
    await service.install(await fixture())
    await fs.appendFile(path.join(root, 'image-studio/main.cjs'), '\n// tamper')
    const restarted = new FeaturePluginService(root, options); await restarted.initialize()
    expect(restarted.enabled('image-studio')).toBe(false)
    expect(restarted.list()[0].error).toContain('损坏')
  })
  it('prevents unloading a running task and invalidates cached service handles', async () => {
    const { manager: service } = await manager()
    await service.install(await fixture('exports.activate = () => ({ task: () => new Promise(resolve => setTimeout(resolve, 30)) })'))
    const active = service.service<{ task: () => Promise<void> }>('image-studio')
    const task = active.task()
    await expect(service.uninstall('image-studio')).rejects.toThrow('等待')
    await task
    await service.setEnabled('image-studio', false)
    expect(() => active.task()).toThrow('停用')
  })
  it('distinguishes the installable catalog from callable tools and enforces declared schema, permissions and project identity', async () => {
    const { manager: service, options, root } = await manager()
    expect(service.catalog().find(feature => feature.id === 'image-studio')).toMatchObject({ installed: false, available: false, state: 'not-installed' })
    expect(service.tools()).toEqual([])
    let project = root, approved = true
    options.projectRoot = () => project
    options.authorize = async () => approved
    const prepared = await fixture('exports.activate = () => ({ actions: { read: input => ({ value: input.value }), write: input => ({ saved: input.value }) } })', {
      apiVersion: 2, id: 'example-tools', name: 'Example tools',
      actions: [
        { id: 'read', handler: 'read', permission: 'read', projectRequired: true, inputSchema: { type: 'object', properties: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false } },
        { id: 'write', handler: 'write', permission: 'write', projectRequired: true, surfaces: ['workbench'], inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
      ],
      tools: [{ name: 'modmind_example_read', action: 'read', description: 'Read example' }, { name: 'modmind_example_write', action: 'write', description: 'Write example' }]
    })
    await service.install(prepared)
    expect(service.tools('workbench')).toHaveLength(2)
    expect(service.tools('inspiration').map(tool => tool.name)).toEqual(['modmind_example_read'])
    expect(await service.invoke('example-tools', 'read', { value: 'hello' }, { projectPath: root, readOnly: true })).toEqual({ value: 'hello' })
    await expect(service.invoke('example-tools', 'read', {})).rejects.toThrow('缺少参数')
    await expect(service.invoke('example-tools', 'read', { value: 'hello', extra: true })).rejects.toThrow('未知参数')
    await expect(service.invoke('example-tools', 'write', { value: 'hello' }, { readOnly: true })).rejects.toThrow('READ_ONLY')
    await expect(service.invoke('example-tools', 'write', { value: 'hello' }, { surface: 'inspiration' })).rejects.toThrow('SURFACE_DENIED')
    approved = false
    await expect(service.invoke('example-tools', 'write', { value: 'hello' })).rejects.toThrow('PERMISSION_DENIED')
    approved = true
    project = path.join(root, 'switched')
    await expect(service.invoke('example-tools', 'write', { value: 'hello' }, { projectPath: root })).rejects.toThrow('PROJECT_MISMATCH')
    await service.setEnabled('example-tools', false)
    expect(service.tools()).toEqual([])
    expect(service.snapshot().revision).toBe(2)
    expect(service.catalog().find(feature => feature.id === 'example-tools')).toMatchObject({ installed: true, state: 'disabled' })
  })
  it('blocks dependency removal and cyclic dependencies while releasing the runtime on disable', async () => {
    const { manager: service, options } = await manager()
    let disposed = 0
    options.options = () => ({ dispose: () => { disposed++ } })
    await service.install(await fixture('exports.activate = options => ({ hello: () => "ready", dispose: options.dispose })', { id: 'base-feature' }))
    await service.install(await fixture(undefined, { id: 'dependent-feature', dependencies: ['base-feature'] }))
    expect(service.enabled('dependent-feature')).toBe(true)
    await expect(service.uninstall('base-feature')).rejects.toThrow('先停用')
    await service.setEnabled('dependent-feature', false)
    service.service('base-feature')
    await service.setEnabled('base-feature', false)
    expect(disposed).toBe(1)
    await expect(service.setEnabled('dependent-feature', true)).rejects.toThrow('插件依赖')
    await service.install(await fixture(undefined, { id: 'cycle-first', dependencies: ['cycle-second'] }))
    expect(service.catalog().find(feature => feature.id === 'cycle-first')?.state).toBe('dependency-missing')
    await expect(service.install(await fixture(undefined, { id: 'cycle-second', dependencies: ['cycle-first'] }))).rejects.toThrow('循环')
  })
  it('rejects tool collisions and malformed declarations before writing plugin code', async () => {
    const { manager: service, root } = await manager()
    const contributions = { apiVersion: 2, actions: [{ id: 'hello', handler: 'hello', permission: 'read' as const, inputSchema: { type: 'object' } }], tools: [{ name: 'modmind_example', action: 'hello', description: 'Fixture example' }] }
    await service.install(await fixture(undefined, { ...contributions, id: 'first-feature' }))
    await expect(service.install(await fixture(undefined, { ...contributions, id: 'second-feature' }))).rejects.toThrow('冲突')
    await expect(fs.stat(path.join(root, 'second-feature'))).rejects.toThrow()
    await expect(service.install(await fixture(undefined, { ...contributions, id: 'bad-schema', actions: [{ ...contributions.actions[0], inputSchema: { type: 'object', unsupportedValidator: 'anything' } }] }))).rejects.toThrow('schema')
  })
  it('prevents project changes during permission approval and invalidates nested action handles', async () => {
    const { manager: service, root, options } = await manager()
    let project = root, executed = 0
    options.projectRoot = () => project
    options.options = () => ({ execute: () => { executed++; return 'saved' } })
    await service.install(await fixture('exports.activate = options => ({ actions: { save: options.execute } })', { id: 'project-action', apiVersion: 2, actions: [{ id: 'save', handler: 'save', permission: 'write', projectRequired: true, inputSchema: { type: 'object' } }] }))
    options.authorize = async () => { project = path.join(root, 'different'); return true }
    await expect(service.invoke('project-action', 'save', {}, { projectPath: root })).rejects.toThrow('PROJECT_MISMATCH')
    expect(executed).toBe(0)
    const handle = service.service<{ actions: { save: () => void } }>('project-action').actions.save
    await service.setEnabled('project-action', false)
    expect(() => handle()).toThrow('停用')
  })
  it('validates complete local JSON Schema and requires an explicit inspiration artifact exception', async () => {
    const { manager: service } = await manager()
    await service.install(await fixture('exports.activate = () => ({ actions: { concept: input => input } })', {
      id: 'concept-fixture', apiVersion: 2,
      actions: [{ id: 'concept', handler: 'concept', permission: 'network', inspirationOutput: true, surfaces: ['workbench', 'inspiration'],
        inputSchema: { type: 'object', properties: { color: { $ref: '#/$defs/color' } }, required: ['color'], additionalProperties: false, $defs: { color: { oneOf: [{ const: 'auto' }, { type: 'string', pattern: '^#[0-9a-f]{6}$' }] } } } }]
    }))
    await expect(service.invoke('concept-fixture', 'concept', { color: 'invalid' })).rejects.toThrow('参数无效')
    await expect(service.invoke('concept-fixture', 'concept', { color: 'auto' }, { readOnly: true, surface: 'inspiration' })).rejects.toThrow('READ_ONLY')
    await expect(service.invoke('concept-fixture', 'concept', { color: 'auto' }, { readOnly: true, surface: 'workbench', allowInspirationOutput: true })).rejects.toThrow('READ_ONLY')
    expect(await service.invoke('concept-fixture', 'concept', { color: '#22aabb' }, { readOnly: true, surface: 'inspiration', allowInspirationOutput: true })).toEqual({ color: '#22aabb' })
    expect(await service.invoke('concept-fixture', 'concept', { color: 'auto' })).toEqual({ color: 'auto' })
  })
  it('installs verified nested offline assets and rejects traversal and case-colliding filenames', async () => {
    const { root, manager: service, options } = await manager()
    const prepared = await fixture(undefined, { id: 'asset-fixture', apiVersion: 2 })
    const name = 'assets/editor/index.html', content = Buffer.from('<html>offline editor</html>')
    prepared.files.set(name, content)
    prepared.manifest.files[name] = createHash('sha256').update(content).digest('hex')
    prepared.files.set('manifest.json', Buffer.from(JSON.stringify(prepared.manifest)))
    await service.install(prepared)
    const response = await service.serve(new Request('modmind-feature://asset-fixture/assets/editor/index.html'))
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(await response.text()).toBe(content.toString())
    const restarted = new FeaturePluginService(root, options); await restarted.initialize()
    expect(restarted.enabled('asset-fixture')).toBe(true)
    await fs.writeFile(path.join(root, 'asset-fixture', name), 'tampered')
    expect((await service.serve(new Request('modmind-feature://asset-fixture/assets/editor/index.html'))).status).toBe(500)
    const bad = await fixture(undefined, { id: 'bad-asset', apiVersion: 2 })
    bad.files.set('assets/../escape', content); bad.manifest.files['assets/../escape'] = prepared.manifest.files[name]
    bad.files.set('manifest.json', Buffer.from(JSON.stringify(bad.manifest)))
    await expect(service.install(bad)).rejects.toThrow('清单无效')
    const collision = await fixture(undefined, { id: 'case-asset', apiVersion: 2 })
    for (const file of ['assets/Code.js', 'assets/code.js']) { collision.files.set(file, content); collision.manifest.files[file] = prepared.manifest.files[name] }
    collision.files.set('manifest.json', Buffer.from(JSON.stringify(collision.manifest)))
    await expect(service.install(collision)).rejects.toThrow('清单无效')
  })
  it('notifies loaded plugins on project changes and disposes every loaded runtime on shutdown', async () => {
    const { manager: service, options, root } = await manager()
    const changes: Array<string | null> = []
    let disposed = 0
    options.options = () => ({ changed: (value: string | null) => changes.push(value), dispose: () => { disposed++ } })
    await service.install(await fixture('exports.activate = options => ({ hello: () => "ready", projectChanged: options.changed, dispose: options.dispose })', { id: 'lifecycle-fixture' }))
    const runtime = service.service<{ hello: () => string }>('lifecycle-fixture')
    await service.projectChanged(root)
    await service.projectChanged(root)
    await service.projectChanged(null)
    expect(changes).toEqual([root, null])
    await service.shutdown()
    expect(disposed).toBe(1)
    expect(() => runtime.hello()).toThrow('更改')
  })
  it('delivers declared native events and drops stale emitters after reactivation', async () => {
    const { manager: service, options } = await manager()
    const events: unknown[] = [], emitters: Array<(name: string, value: unknown) => void> = []
    options.event = (id, name, value) => events.push({ id, name, value })
    options.options = () => ({ capture: (emit: (name: string, value: unknown) => void) => emitters.push(emit) })
    await service.install(await fixture('exports.activate=options=>{options.capture(options.emitEvent); return { hello:()=>options.emitEvent("progress",{done:true}) }}', { id: 'event-fixture', apiVersion: 2, events: ['progress'] }))
    service.service<{ hello: () => void }>('event-fixture').hello()
    expect(events).toEqual([{ id: 'event-fixture', name: 'progress', value: { done: true } }])
    expect(() => emitters[0]('undeclared', {})).toThrow('未声明')
    await service.setEnabled('event-fixture', false)
    await service.setEnabled('event-fixture', true)
    service.service('event-fixture')
    emitters[0]('progress', { stale: true })
    emitters[1]('progress', { latest: true })
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ id: 'event-fixture', name: 'progress', value: { latest: true } })
  })
  it('reports background plugin activity and forwards turn cleanup to loaded runtimes', async () => {
    const { manager: service, options } = await manager()
    const signals: AbortSignal[] = []; let busy = true
    options.options = () => ({ stop: (signal: AbortSignal) => { signals.push(signal); busy = false }, busy: () => busy })
    await service.install(await fixture('exports.activate=o=>({isBusy:o.busy,stopForSignal:o.stop})', { id: 'owned-session-fixture' }))
    service.service('owned-session-fixture')
    expect(service.hasBusyRuntime()).toBe(true)
    const controller = new AbortController()
    await service.stopForSignal(controller.signal)
    expect(signals).toEqual([controller.signal])
    expect(service.hasBusyRuntime()).toBe(false)
    await service.shutdown()
  })
  it('resolves plugin-local CommonJS assets and clears them when the plugin is replaced', async () => {
    const { manager: service, root } = await manager()
    async function prepared(value: number): Promise<PreparedPlugin> {
      const plugin = await fixture('exports.activate=()=>{const asset=require("./assets/helper.cjs");return {read:()=>asset.value,resolved:()=>require.resolve("./assets/helper.cjs")}}', { apiVersion: 2, id: 'local-module' })
      const bytes = Buffer.from(`exports.value=${value}`)
      plugin.files.set('assets/helper.cjs', bytes)
      plugin.manifest.files['assets/helper.cjs'] = createHash('sha256').update(bytes).digest('hex')
      plugin.files.set('manifest.json', Buffer.from(JSON.stringify(plugin.manifest)))
      return plugin
    }
    await service.install(await prepared(1))
    const runtime = service.service<{ read: () => number; resolved: () => string }>('local-module')
    expect(runtime.read()).toBe(1)
    expect(runtime.resolved()).toBe(path.join(root, 'local-module/assets/helper.cjs'))
    await service.uninstall('local-module')
    await service.install(await prepared(2))
    expect(service.service<{ read: () => number }>('local-module').read()).toBe(2)
  })
})
