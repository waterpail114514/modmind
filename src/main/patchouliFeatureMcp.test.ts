import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { ModMindBridge, type ExternalAgentBridgeHandlers } from './externalAgents'
import { FeaturePluginService } from './featurePluginService'
import * as modpackService from './modpackService'
import * as downloadService from './downloadService'
import * as networkRequest from './networkRequest'
import * as curseForgePackMetadata from './curseForgePackMetadata'
import * as downloadActivityService from './downloadActivityService'
import * as projectMutation from './projectMutation'
import type { ProjectInfo } from '../shared/types'

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { clean(); reject(new Error('MCP response timed out')) }, 10000)
    const onClose = (): void => { clean(); reject(new Error('MCP process exited')) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clean()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    const clean = (): void => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose) }
    child.stdout.on('data', onData); child.once('close', onClose)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

it('reads and edits existing Patchouli books through the packaged feature and MCP with revision and project checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-patchouli-feature-mcp-'))
  const project: ProjectInfo = { path: root, kind: 'modpack', name: 'Pack', namespace: 'pack', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  const bridges: ModMindBridge[] = []
  const children: ChildProcessWithoutNullStreams[] = []
  const plugins = new FeaturePluginService(path.join(root, 'features'), {
    requireFrom: path.resolve('package.json'),
    capabilities: { runtime: { modpackService, downloadService, networkRequest, curseForgePackMetadata, downloadActivityService, projectMutation } },
    options: () => ({ host: { requireProject: () => project, event: () => ({}) } }), busy: () => false, changed: () => {}, project: () => project, projectRoot: () => project.path
  })
  let id = 0
  const connect = async (readOnly = false) => {
    const handlers = { featureCatalog: async () => plugins.catalog(), featureTools: async (surface: 'workbench' | 'inspiration') => plugins.tools(surface, project), featureInvoke: (feature: string, action: string, input: Record<string, unknown>, context: any) => plugins.invoke(feature, action, input, context) } as unknown as ExternalAgentBridgeHandlers
    const bridge = new ModMindBridge(project, handlers, 'test', undefined, readOnly, readOnly ? 'readonly' : 'write')
    bridges.push(bridge)
    const { mcpConfigPath } = await bridge.start(); await bridge.writeMcpConfig(mcpConfigPath)
    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')).mcpServers.modmind
    const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    return child
  }
  try {
    await modpackService.createModpackTemplate(project)
    const directory = path.join(root, 'packaged-feature')
    await fs.mkdir(directory)
    const runtime = { modpackService, downloadService, networkRequest, curseForgePackMetadata, downloadActivityService, projectMutation }
    await build({ entryPoints: ['feature-plugins/patchouli/main.ts'], outfile: path.join(directory, 'main.cjs'), platform: 'node', format: 'cjs', bundle: true, packages: 'external', external: ['@modmind/host'], plugins: [{ name: 'host-runtime', setup(builder) {
      builder.onResolve({ filter: /\/(?:modpackService|downloadService|networkRequest|curseForgePackMetadata|downloadActivityService|projectMutation)$/ }, args => ({ path: path.basename(args.path), namespace: 'host-runtime' }))
      builder.onLoad({ filter: /.*/, namespace: 'host-runtime' }, args => {
        const key = args.path as keyof typeof runtime
        return { contents: `const value = require('@modmind/host').runtime.${key};\n` + Object.keys(runtime[key]).map(name => `export const ${name} = value.${name};`).join('\n'), loader: 'js' }
      })
    } }] })
    await fs.writeFile(path.join(directory, 'renderer.js'), '')
    await fs.writeFile(path.join(directory, 'renderer.css'), '')
    const manifest = JSON.parse(await fs.readFile('feature-plugins/patchouli/manifest.json', 'utf8'))
    const contributions = JSON.parse(await fs.readFile('feature-plugins/patchouli/main-contributions.json', 'utf8'))
    const files = Object.fromEntries(await Promise.all(['main.cjs', 'renderer.js', 'renderer.css'].map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')])))
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, ...contributions, hostCapabilities: ['runtime'], files }))
    await plugins.initialize([{ id: 'patchouli', directory }])
    expect(plugins.catalog().find(entry => entry.id === 'patchouli')?.enabled).toBe(true)
    const jars = await Promise.all(['patchouli.jar', 'kubejs.jar'].map(async name => {
      const file = path.join(root, name); await fs.writeFile(file, Buffer.from('test jar'.repeat(512))); return file
    }))
    await modpackService.addModpackFiles(project, jars)
    const child = await connect(), reader = await connect(true)
    const readName = 'modmind_modpack_read_patchouli_books', writeName = 'modmind_modpack_write_patchouli_book'
    const listed = (await rpc(child, ++id, 'tools/list')).result.tools
    expect(listed.some((tool: any) => tool.name === readName)).toBe(true)
    const input = { bookId: 'guide', name: 'Guide', landingText: 'Start here', categories: [{ id: 'start', name: 'Start', icon: 'minecraft:book', entries: [{ id: 'one', name: 'One', icon: 'minecraft:book', text: 'Original' }] }] }
    expect((await rpc(child, ++id, 'tools/call', { name: writeName, arguments: input })).result.isError).not.toBe(true)
    const read = await rpc(reader, ++id, 'tools/call', { name: readName, arguments: {} })
    expect(read.result.isError).not.toBe(true)
    const books = JSON.parse(read.result.content[0].text)
    expect(books[0]).toMatchObject({ name: 'Guide', baseline: expect.any(String) })
    expect((await rpc(reader, ++id, 'tools/call', { name: writeName, arguments: books[0] })).result.isError).toBe(true)
    const edited = { ...books[0], name: 'Revised guide' }
    expect((await rpc(child, ++id, 'tools/call', { name: writeName, arguments: edited })).result.isError).not.toBe(true)
    const reread = JSON.parse((await rpc(child, ++id, 'tools/call', { name: readName, arguments: {} })).result.content[0].text)
    expect(reread[0].name).toBe('Revised guide')
    expect((await rpc(child, ++id, 'tools/call', { name: writeName, arguments: books[0] })).result.isError).toBe(true)
    await expect(plugins.invoke('patchouli', 'modpack_read_patchouli_books', { unexpected: true }, { projectPath: root, surface: 'workbench' })).rejects.toThrow()
    await expect(plugins.invoke('patchouli', 'modpack_read_patchouli_books', {}, { projectPath: path.join(root, 'other'), surface: 'workbench' })).rejects.toThrow('PROJECT_MISMATCH')
    expect(await plugins.invoke('patchouli', 'modpack:readPatchouliBooks', { args: [] })).toEqual(reread)
  } finally {
    for (const child of children) if (child.exitCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill(); await closed }
    for (const bridge of bridges) await bridge.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20000)
