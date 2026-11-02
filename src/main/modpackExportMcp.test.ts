import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { build } from 'esbuild'
import extractZip from 'extract-zip'
import { expect, it, vi } from 'vitest'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { FeaturePluginService, prepareFeaturePlugin } from './featurePluginService'
import { createStoredZip } from './bedrockAddon'
import * as modpackService from './modpackService'
import * as modpackContentMetadata from './modpackContentMetadata'
import * as projectMutation from './projectMutation'
import * as projectTemplates from './projectTemplates'
import * as processTree from './processTree'
import * as networkRequest from './networkRequest'
import * as downloadService from './downloadService'
import type { ProjectInfo } from '../shared/types'
import type { FeaturePluginInvocationContext } from '../shared/featurePlugins'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '1.5.0-preview.5' } }))

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const clean = (): void => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose) }
    const timer = setTimeout(() => { clean(); reject(new Error('MCP response timed out')) }, 10_000)
    const onClose = (): void => { clean(); reject(new Error('MCP process exited')) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clean()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    child.stdout.on('data', onData); child.once('close', onClose)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

it('exports through the actual publishing plugin and stdio MCP with host capability, schema, project and read-only checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-export-feature-mcp-'))
  let bridge: ModMindBridge | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  const stop = async (): Promise<void> => {
    if (child && child.exitCode === null) { const closed = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill(); await closed }
    child = undefined
    await bridge?.stop()
  }
  try {
    const project: ProjectInfo = { path: path.join(root, 'a'), name: 'A', namespace: 'a', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.16.5', createdAt: '' }
    const other: ProjectInfo = { ...project, path: path.join(root, 'b'), name: 'B', namespace: 'b' }
    for (const item of [project, other]) { await fs.mkdir(item.path); await modpackService.createModpackTemplate(item) }
    await fs.writeFile(path.join(project.path, 'mods/private.jar'), Buffer.alloc(2048, 9))
    await fs.writeFile(path.join(project.path, 'overrides/config/pack.json'), '{"value":"A"}')
    let active = project
    const scoped = new AsyncLocalStorage<ProjectInfo>()
    const current = (): ProjectInfo => scoped.getStore() ?? active
    const runtime = { modpackService, modpackContentMetadata, projectMutation, projectTemplates, processTree, networkRequest, downloadService }
    const capabilities: Record<string, unknown> = { runtime }
    const plugins = new FeaturePluginService(path.join(root, 'features'), {
      requireFrom: path.resolve('package.json'), capabilities,
      options: () => ({ host: { requireProject: current, readReleaseSecrets: async () => ({ githubToken: '', modrinthToken: '', curseForgeToken: '' }), writeReleaseSecrets: async () => {} } }),
      project: current, projectRoot: () => current().path, busy: () => false, changed: () => {}
    })
    const directory = path.join(root, 'publishing')
    await fs.mkdir(directory)
    const compiled = await build({ entryPoints: ['feature-plugins/publishing/main.ts'], write: false, platform: 'node', format: 'cjs', bundle: true, packages: 'external', external: ['@modmind/host'], plugins: [{ name: 'host-runtime', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-fixture' }, () => ({ contents: "export const app = { getVersion: () => '1.5.0-preview.5' }; export const dialog = {};", loader: 'js' }))
      builder.onResolve({ filter: /\/(?:modpackService|modpackContentMetadata|projectMutation|projectTemplates|processTree|networkRequest|downloadService)$/ }, args => ({ path: path.basename(args.path), namespace: 'host-runtime' }))
      builder.onLoad({ filter: /.*/, namespace: 'host-runtime' }, args => {
        const key = args.path as keyof typeof runtime
        return { contents: `const value = require('@modmind/host').runtime.${key};\n` + Object.keys(runtime[key]).map(name => `export const ${name} = value.${name};`).join('\n'), loader: 'js' }
      })
    } }] })
    await fs.writeFile(path.join(directory, 'main.cjs'), compiled.outputFiles[0].contents)
    await fs.writeFile(path.join(directory, 'renderer.js'), '')
    await fs.writeFile(path.join(directory, 'renderer.css'), '')
    const manifest = JSON.parse(await fs.readFile('feature-plugins/publishing/manifest.json', 'utf8'))
    const contributions = JSON.parse(await fs.readFile('feature-plugins/publishing/main-contributions.json', 'utf8'))
    const files = Object.fromEntries(await Promise.all(['main.cjs', 'renderer.js', 'renderer.css'].map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')])))
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, ...contributions, hostCapabilities: [...manifest.hostCapabilities, 'runtime'], files }))
    // Audio processing is unrelated to exporting; provide its declared dependency without downloading it.
    const media = path.join(root, 'media-runtime')
    await fs.mkdir(media)
    for (const [name, content] of Object.entries({ 'main.cjs': 'exports.activate = () => ({})', 'renderer.js': '', 'renderer.css': '' })) await fs.writeFile(path.join(media, name), content)
    const mediaFiles = Object.fromEntries(await Promise.all(['main.cjs', 'renderer.js', 'renderer.css'].map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(media, name))).digest('hex')])))
    await fs.writeFile(path.join(media, 'manifest.json'), JSON.stringify({ format: 'modmind-feature', apiVersion: 2, hostVersion: manifest.hostVersion, id: 'media-runtime', name: 'Media fixture', version: '1.5.0', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', files: mediaFiles }))
    await plugins.initialize([{ id: 'media-runtime', directory: media }])
    const archive = path.join(root, 'publishing.mmfeature')
    await fs.writeFile(archive, createStoredZip(await Promise.all(['manifest.json', 'main.cjs', 'renderer.js', 'renderer.css'].map(async name => ({ name, data: await fs.readFile(path.join(directory, name)) })))))
    const prepared = await prepareFeaturePlugin(archive)
    const legacyCode = Buffer.from('exports.activate = () => ({ legacy: true })')
    const legacyManifest = { format: manifest.format, apiVersion: manifest.apiVersion, hostVersion: manifest.hostVersion, id: manifest.id, name: manifest.name, version: '1.5.1', main: manifest.main, renderer: manifest.renderer, style: manifest.style, files: { 'main.cjs': createHash('sha256').update(legacyCode).digest('hex'), 'renderer.js': mediaFiles['renderer.js'], 'renderer.css': mediaFiles['renderer.css'] } }
    const legacyFiles = new Map([['manifest.json', Buffer.from(JSON.stringify(legacyManifest))], ['main.cjs', legacyCode], ['renderer.js', Buffer.alloc(0)], ['renderer.css', Buffer.alloc(0)]])
    await plugins.install({ manifest: legacyManifest, files: legacyFiles })
    await expect(plugins.update(prepared)).rejects.toThrow('宿主缺少')
    expect(plugins.list().find(entry => entry.id === 'publishing')?.version).toBe('1.5.1')
    expect(plugins.service<{ legacy: boolean }>('publishing').legacy).toBe(true)
    capabilities.modpackExportV2 = true
    await expect(plugins.update(prepared)).rejects.toThrow('宿主缺少')
    expect(plugins.service<{ legacy: boolean }>('publishing').legacy).toBe(true)
    capabilities.diagnosticsV1 = true
    await plugins.update(prepared)
    const service = plugins.service<{ requireReleaseService: () => import('../../feature-plugins/publishing/src/main/releaseService').ReleaseService }>('publishing').requireReleaseService()
    await service.saveSettings({ ...await service.getSettings(), autoBump: false })
    const reviewAction = vi.fn(async () => ({ approved: true }))
    const handlers = {
      featureCatalog: async () => plugins.catalog(),
      featureTools: async (surface: 'workbench' | 'inspiration') => plugins.tools(surface, project),
      featureInvoke: (feature: string, action: string, input: Record<string, unknown>, context: FeaturePluginInvocationContext) => scoped.run(project, () => plugins.invoke(feature, action, input, context)), reviewAction
    } as unknown as ExternalAgentBridgeHandlers
    const start = async (readOnly: boolean): Promise<void> => {
      bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly)
      const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
      const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
      child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    }
    await start(false)
    const tools = (await rpc(child!, 1, 'tools/list')).result.tools
    const tool = tools.find((item: { name: string }) => item.name === 'modmind_modpack_export')
    expect(tool.inputSchema.properties.mode.enum).toEqual(['bundled', 'download'])
    active = other
    for (const [i, mode] of ['bundled', 'download'].entries()) {
      const reply = await rpc(child!, i + 2, 'tools/call', { name: tool.name, arguments: { mode } })
      expect(reply.result.isError).not.toBe(true)
      const result = JSON.parse(reply.result.content[0].text)
      expect(result).toMatchObject({ success: true, mode, version: '0.1.0', size: expect.any(Number) })
      expect(path.relative(project.path, result.path)).toBe(path.join('.modmind/exports', `a-0.1.0-${mode}.mrpack`))
      const extracted = path.join(root, mode)
      await extractZip(result.path, { dir: extracted })
      expect(JSON.parse(await fs.readFile(path.join(extracted, 'modrinth.index.json'), 'utf8')).files).toEqual([])
      expect(await fs.readFile(path.join(extracted, 'overrides/mods/private.jar'))).toEqual(Buffer.alloc(2048, 9))
      expect(await fs.readFile(path.join(extracted, 'overrides/config/pack.json'), 'utf8')).toContain('A')
    }
    await expect(fs.access(path.join(other.path, '.modmind/exports'))).rejects.toThrow()
    expect(reviewAction).toHaveBeenCalled()
    expect((await rpc(child!, 4, 'tools/call', { name: tool.name, arguments: { mode: 'unknown' } })).result.isError).toBe(true)
    expect((await rpc(child!, 5, 'tools/call', { name: tool.name, arguments: { path: path.join(root, 'outside.mrpack') } })).result.isError).toBe(true)
    await expect(plugins.invoke('publishing', 'modpack_export', {}, { projectPath: project.path, surface: 'workbench' })).rejects.toThrow('PROJECT_MISMATCH')
    await expect(plugins.invoke('publishing', 'modpack_export', {}, { projectPath: other.path, surface: 'inspiration', readOnly: true })).rejects.toThrow('READ_ONLY')
    await stop(); await start(true)
    expect((await rpc(child!, 6, 'tools/call', { name: tool.name, arguments: { mode: 'bundled' } })).result.isError).toBe(true)
    active = project
    await plugins.setEnabled('publishing', false)
    expect(plugins.tools('workbench', project).some(tool => tool.name === 'modmind_modpack_export')).toBe(false)
  } finally {
    await stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
