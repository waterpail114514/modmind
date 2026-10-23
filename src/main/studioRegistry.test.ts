import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { FeaturePluginService, prepareFeaturePlugin, type PreparedPlugin } from './featurePluginService'
import { configureStudios, StudioRegistry, validateStudioTemplateFiles } from './studioRegistry'
import { featureHostRuntime } from './featureHostRuntime'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { createDraftProject, initializeDraftProject } from './draftProjectService'
import { pluginVersionOption } from './serverPluginMetadata'
import { workbenchSkillNames } from './workbenchSkillPolicy'
import type { ProjectInfo } from '../shared/types'
import type { FeaturePluginManifest } from '../shared/featurePlugins'
import type { StudioRuntime } from '../shared/studios'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })

async function host() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-studios-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const service = new FeaturePluginService(path.join(root, 'features'), {
    requireFrom: path.resolve('package.json'), capabilities: { runtime: featureHostRuntime, studioV1: true },
    options: () => ({}), busy: () => false, changed: () => undefined
  })
  await service.initialize()
  cleanup.push(() => service.shutdown())
  const registry = new StudioRegistry(() => service.catalog(), id => service.service<StudioRuntime>(id), (id, group) => service.assetDirectory(id, group))
  configureStudios(registry)
  return { root, service, registry }
}
const archive = (id: string) => prepareFeaturePlugin(path.resolve(`feature-plugin-dist/${id}.mmstudio`))
const project = (root: string, kind = 'mod', loader: ProjectInfo['loader'] = 'fabric'): ProjectInfo => ({ name: 'Studio test', path: root, kind, loader, minecraftVersion: '1.21.1', namespace: 'studio_test', createdAt: '2026-10-04T00:00:00.000Z' })

describe('studio protocol and real installed providers', () => {
  it('validates declared values and dispatches custom recognition/adoption while preserving unavailable identity', async () => {
    const { root, service, registry } = await host()
    const prepared = await archive('studio-mod'), studio = prepared.manifest.studios![0]
    prepared.manifest.id = 'custom-adoption'
    Object.assign(studio, { id: 'custom-adoption-domain', projectKind: 'shader', templateHandler: 'shader', loaders: ['glsl'], defaultTarget: { loader: 'glsl', version: '1' },
      ai: { workbench: { instructions: 'Engineering', skills: [] }, inspiration: { instructions: 'Discussion', skills: [] } },
      creation: { fields: [{ id: 'name', title: '名称', type: 'input', required: true, bind: 'name', maxLength: 80 }, { id: 'quality', title: '品质', type: 'select', default: 'balanced', options: [{ value: 'balanced', title: '均衡' }] }] },
      adoption: { handler: 'shader', priority: 100, markers: ['shader-project.json'] } })
    const bytes = Buffer.from('exports.activate=()=>({studios:{shader:{templateFiles:()=>({"shader-project.json":"{}"}),inspectExisting:async root=>({sourcePath:root,sourceName:"Shader",kind:"complete",fileCount:1,sourceFileCount:0,documentCount:0,detectedFiles:["shader-project.json"],reasons:["Custom shader"],inferred:{name:"Shader",namespace:"shader",kind:"shader",loader:"glsl",minecraftVersion:"1"}}),adoptExisting:async()=>({mode:"in-place"})}}})')
    prepared.files.set('main.cjs', bytes); prepared.manifest.files['main.cjs'] = createHash('sha256').update(bytes).digest('hex')
    prepared.files.set('manifest.json', Buffer.from(JSON.stringify(prepared.manifest)))
    await service.install(prepared)
    const target = { name: 'Shader', loader: 'glsl', minecraftVersion: '1', kind: 'shader', studioId: studio.id }
    expect(() => registry.select({ ...target, studioValues: { quality: 'unknown' } })).toThrow('选项无效')
    expect(() => registry.select({ ...target, studioValues: { name: 'Other' } })).toThrow('不一致')
    expect(() => registry.select({ ...target, studioValues: { undeclared: 'x' } })).toThrow('字段无效')
    await fs.writeFile(path.join(root, 'shader-project.json'), '{"preserve":true}')
    const analysis = await registry.inspectExisting(root)
    expect(analysis.studio).toMatchObject({ id: studio.id, available: true })
    await expect(registry.adoptExisting({ ...target, sourcePath: root, namespace: 'shader' }, { ...analysis, inferred: { ...analysis.inferred, loader: 'other' } })).rejects.toThrow('TARGET_MISMATCH')
    expect(await registry.adoptExisting({ ...target, sourcePath: root, namespace: 'shader' }, analysis)).toEqual({ mode: 'in-place' })
    const draft = await createDraftProject(root, 'Shader draft')
    const initialized = await initializeDraftProject(draft.path, {
      resolve: async () => { throw new Error('Custom target must not resolve Minecraft versions') },
      scaffold: candidate => registry.scaffold(candidate, async files => {
        for (const [relative, content] of Object.entries(files)) { const destination = path.join(candidate.path, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content) }
      })
    }, { kind: 'shader', loader: 'glsl', minecraftVersion: '1', studioId: studio.id })
    expect(initialized.studioValues).toEqual({ name: initialized.name, quality: 'balanced' })
    expect(JSON.parse(await fs.readFile(path.join(initialized.path, 'modmind.project.json'), 'utf8')).studioValues.quality).toBe('balanced')
    await service.setEnabled(prepared.manifest.id, false)
    expect((await registry.inspectExisting(root)).studio).toMatchObject({ id: studio.id, available: false })
    await expect(registry.adoptExisting({ ...target, sourcePath: root, namespace: 'shader' }, analysis)).rejects.toThrow('UNAVAILABLE')
    expect(await fs.readFile(path.join(root, 'shader-project.json'), 'utf8')).toBe('{"preserve":true}')
  })
  it('creates through three independent packages, resolves legacy metadata, and preserves files when disabled', async () => {
    const { root, service, registry } = await host()
    expect(registry.list().filter(record => ['minecraft-mod', 'minecraft-modpack', 'minecraft-server-plugin'].includes(record.definition.id))).toHaveLength(3)
    expect(() => registry.templateFiles(project(root))).toThrow('STUDIO_UNAVAILABLE')
    for (const id of ['studio-mod', 'studio-server-plugin', 'studio-modpack']) await service.install(await archive(id))
    const mod = project(root), plugin = project(root, 'server-plugin', 'paper'), pack = project(root, 'modpack')
    expect(registry.templateFiles(mod)).toHaveProperty('src/main/resources/fabric.mod.json')
    expect(registry.templateFiles(plugin)).toHaveProperty('src/main/resources/plugin.yml')
    expect(registry.context(mod, 'workbench').skills).toContain('minecraft-mod-development')
    expect(registry.context(mod, 'inspiration').skills).not.toContain('minecraft-mod-development')
    expect(registry.context(plugin, 'workbench').skills).toContain('minecraft-server-plugin-development')
    expect(registry.context(plugin, 'workbench').skills).not.toContain('minecraft-modpack-authoring')
    for (const target of [plugin, pack]) {
      const record = registry.select({ ...target })
      expect(record.definition.creation?.fields.find(field => field.id === 'edition')).toMatchObject({ default: 'java', readOnly: true })
      expect(() => registry.select({ ...target, studioValues: { edition: 'bedrock' } })).toThrow('固定值')
    }
    expect(registry.context(pack, 'workbench').instructions).toContain('modmind_modpack_delegate_module')
    expect(registry.context(pack, 'inspiration').instructions).toContain('MODPACK INSPIRATION')
    expect(await fs.readFile(path.join(registry.skillDirectories(plugin)[0], 'minecraft-server-plugin-development/SKILL.md'), 'utf8')).toContain('minecraft-server-plugin-development')
    await registry.scaffold(pack, async () => { throw new Error('wrong template path') })
    expect(JSON.parse(await fs.readFile(path.join(root, 'modmind.pack.json'), 'utf8')).loader).toBe('fabric')
    await service.setEnabled('studio-mod', false)
    expect(registry.context(mod, 'workbench')).toMatchObject({ available: false, instructions: '', skills: [] })
    expect(() => registry.templateFiles(mod)).toThrow('STUDIO_UNAVAILABLE')
    expect(() => registry.templateFiles({ ...mod, studioId: 'minecraft-server-plugin' })).toThrow('STUDIO_NOT_FOUND')
    expect(() => registry.templateFiles({ ...mod, studioId: 'unknown-studio' })).toThrow('STUDIO_NOT_FOUND')
    await service.setEnabled('studio-mod', true)
    expect(registry.templateFiles(mod)).toHaveProperty('build.gradle')
    expect(await fs.readFile(path.join(root, 'modmind.pack.json'), 'utf8')).toContain('Studio test')
  })

  it('rejects missing AI surfaces, incompatible protocols, duplicate ids and unimplemented providers', async () => {
    const { service } = await host()
    const make = async (change: (manifest: FeaturePluginManifest) => void, code?: string): Promise<PreparedPlugin> => {
      const prepared = await archive('studio-mod')
      change(prepared.manifest)
      if (code) {
        const bytes = Buffer.from(code)
        prepared.files.set('main.cjs', bytes)
        prepared.manifest.files['main.cjs'] = createHash('sha256').update(bytes).digest('hex')
      }
      prepared.files.set('manifest.json', Buffer.from(JSON.stringify(prepared.manifest)))
      return prepared
    }
    await expect(service.install(await make(manifest => { delete (manifest.studios![0].ai as { inspiration?: unknown }).inspiration }))).rejects.toThrow('缺少参数')
    await expect(service.install(await make(manifest => { Object.assign(manifest.studios![0], { apiVersion: 999 }) }))).rejects.toThrow('参数无效')
    await expect(service.install(await make(manifest => { Object.assign(manifest.studios![0].creation!.fields[0], { readOnly: true }) }))).rejects.toThrow('固定默认值')
    await service.install(await make(manifest => { manifest.id = 'broken-provider'; manifest.studios![0].id = 'broken-domain' }, 'exports.activate=()=>({})'))
    expect(() => service.service('broken-provider')).toThrow('创建实现')
    await service.uninstall('broken-provider')
    await service.install(await archive('studio-mod'))
    await expect(service.install(await make(manifest => { manifest.id = 'duplicate-studio' }))).rejects.toThrow('冲突')
  })

  it('validates template paths before publishing and does not expose another domain on target mismatch', async () => {
    for (const file of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'NUL.txt', 'folder/file.']) expect(() => validateStudioTemplateFiles({ [file]: 'x' })).toThrow('文件路径')
    expect(validateStudioTemplateFiles({ '.gitignore': 'build/', 'src/main.java': 'class Main {}' })).toHaveProperty('.gitignore')
    const { root, service, registry } = await host()
    await service.install(await archive('studio-server-plugin'))
    expect(registry.context({ ...project(root), studioId: 'minecraft-server-plugin' }, 'workbench')).toMatchObject({ available: false, instructions: '' })
  })

  it('registers another domain without host branches and routes tasks through the existing permission and project checks', async () => {
    const { root, service } = await host()
    const prepared = await archive('studio-mod')
    prepared.manifest.id = 'custom-studio'
    delete prepared.manifest.studios![0].adoption
    Object.assign(prepared.manifest.studios![0], { id: 'custom-domain', projectKind: 'custom-project', templateHandler: 'custom', tasks: { check: { action: 'check' } } })
    prepared.manifest.actions = [{ id: 'check', handler: 'check', permission: 'write', projectRequired: true, surfaces: ['workbench'], inputSchema: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] } }]
    prepared.manifest.tools = [{ name: 'modmind_custom_check', action: 'check', description: 'Check a custom domain project' }]
    const bytes = Buffer.from('exports.activate=()=>({studios:{custom:{templateFiles:()=>({"custom.txt":"custom domain"})}},actions:{check:input=>({status:"completed",value:input.value})}})')
    prepared.files.set('main.cjs', bytes); prepared.manifest.files['main.cjs'] = createHash('sha256').update(bytes).digest('hex')
    prepared.files.set('manifest.json', Buffer.from(JSON.stringify(prepared.manifest)))
    await service.install(prepared)
    const registry = new StudioRegistry(() => service.catalog(), id => service.service(id), undefined, (id, action, input, context) => service.invoke(id, action, input, context))
    const custom = { ...project(root), kind: 'custom-project', studioId: 'custom-domain' }
    expect(registry.select({ name: 'Custom', kind: custom.kind, loader: custom.loader, minecraftVersion: custom.minecraftVersion, studioId: custom.studioId }).definition.id).toBe('custom-domain')
    expect(registry.templateFiles(custom)).toEqual({ 'custom.txt': 'custom domain' })
    expect(service.tools().map(tool => tool.name)).toContain('modmind_custom_check')
    expect(await registry.invokeTask(custom, 'check', { value: 'verified' }, { surface: 'workbench' })).toEqual({ status: 'completed', value: 'verified' })
    await expect(registry.invokeTask(custom, 'check', { value: 'denied' }, { surface: 'inspiration', readOnly: true })).rejects.toThrow('READ_ONLY')
    await expect(registry.invokeTask(custom, 'check', {}, { surface: 'workbench' })).rejects.toThrow('缺少参数')
    await expect(registry.invokeTask(custom, 'test', {}, { surface: 'workbench' })).rejects.toThrow('TASK_UNAVAILABLE')
    expect(registry.resolve(project(root))?.definition.id).toBe('minecraft-mod')
  })

  it('creates a plugin and reads its domain back through actual MCP, including read-only rejection', async () => {
    const { root, service, registry } = await host()
    await service.install(await archive('studio-server-plugin'))
    const active = await createDraftProject(root, '我想制作一个签到插件')
    const handlers: Pick<ExternalAgentBridgeHandlers, 'projectInfo' | 'featureCatalog' | 'projectSetup'> = {
      get projectInfo() { return { ...active, studio: registry.context(active, 'workbench') } },
      featureCatalog: async () => service.catalog(),
      projectSetup: async input => {
        const updated = await initializeDraftProject(active.path, {
          resolve: async (loader, version) => pluginVersionOption(loader as 'paper', version),
          scaffold: async candidate => registry.scaffold(candidate, async files => {
            for (const [relative, content] of Object.entries(files)) {
              const destination = path.join(candidate.path, relative)
              await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content)
            }
          })
        }, input as { kind: string; loader: 'paper'; minecraftVersion: string; studioId: string })
        Object.assign(active, updated); delete active.draft
        return { project: updated }
      }
    }
    const connect = async (readOnly = false) => {
      const bridge = new ModMindBridge(active, handlers as ExternalAgentBridgeHandlers, 'test', path.resolve('resources/codex-skills'), readOnly, readOnly ? 'inspiration' : 'workbench')
      cleanup.push(() => bridge.stop())
      const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
      const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
      const child: ChildProcessWithoutNullStreams = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      cleanup.push(async () => { if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() }) })
      let sequence = 0, buffer = ''
      const pending = new Map<number, (value: any) => void>()
      child.stdout.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
          pending.get(value.id)?.(value); pending.delete(value.id)
        }
      })
      return (method: string, params?: object): Promise<any> => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Studio MCP timeout')) }, 10000)
        pending.set(id, value => { clearTimeout(timer); resolve(value) })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    }
    const rpc = await connect()
    const tools = await rpc('tools/list')
    expect(tools.result.tools.find((tool: { name: string }) => tool.name === 'modmind_project_setup').inputSchema.properties).toHaveProperty('studioId')
    const input = { kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.21.1', studioId: 'minecraft-server-plugin' }
    const invalidEdition = await rpc('tools/call', { name: 'modmind_project_setup', arguments: { ...input, studioValues: { edition: 'bedrock' } } })
    expect(invalidEdition.result.isError).toBe(true)
    expect(JSON.stringify(invalidEdition)).toContain('固定值')
    const created = await rpc('tools/call', { name: 'modmind_project_setup', arguments: input })
    expect(created.result.isError, JSON.stringify(created)).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(active.path, 'modmind.project.json'), 'utf8')).studioId).toBe(input.studioId)
    expect(await fs.readFile(path.join(active.path, 'src/main/resources/plugin.yml'), 'utf8')).toContain('.PluginEntry')
    const info = await rpc('tools/call', { name: 'modmind_project_info', arguments: {} })
    expect(JSON.stringify(info.result)).toContain('minecraft-server-plugin-development')
    const skillRoot = path.join(active.path, '.modmind/external-agents/runs/workbench/skills')
    expect(await fs.readdir(skillRoot)).toContain('minecraft-server-plugin-development')
    expect(await fs.readdir(skillRoot)).not.toContain('minecraft-mod-development')
    await service.setEnabled('studio-server-plugin', false)
    const disabledInfo = await rpc('tools/call', { name: 'modmind_project_info', arguments: {} })
    expect(JSON.parse(disabledInfo.result.content[0].text).studio).toMatchObject({ available: false, skills: [] })
    await service.setEnabled('studio-server-plugin', true)
    const inspiration = await connect(true)
    const denied = await inspiration('tools/call', { name: 'modmind_project_setup', arguments: input })
    expect(JSON.stringify(denied)).toContain('只读')
    expect(workbenchSkillNames(active, false, 'inspiration')).not.toContain('minecraft-mod-development')
  }, 20000)
})
