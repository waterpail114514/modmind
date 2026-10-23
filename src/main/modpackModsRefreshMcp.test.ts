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

it('refreshes disk mods through the packaged feature and workbench MCP with schema, read-only and project checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-mod-refresh-mcp-'))
  const project: ProjectInfo = { path: root, kind: 'modpack', name: 'Pack', namespace: 'pack', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
  const bridges: ModMindBridge[] = []
  const children: ChildProcessWithoutNullStreams[] = []
  const plugins = new FeaturePluginService(path.join(root, 'features'), {
    requireFrom: path.resolve('package.json'),
    capabilities: { runtime: { modpackService, downloadService, networkRequest, curseForgePackMetadata, downloadActivityService } },
    options: () => ({ host: { requireProject: () => project } }), busy: () => false, changed: () => {}, project: () => project, projectRoot: () => project.path
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
    const runtime = { modpackService, downloadService, networkRequest, curseForgePackMetadata, downloadActivityService }
    await build({ entryPoints: ['feature-plugins/modpack-mods/main.ts'], outfile: path.join(directory, 'main.cjs'), platform: 'node', format: 'cjs', bundle: true, packages: 'external', external: ['@modmind/host'], plugins: [{ name: 'host-runtime', setup(builder) {
      builder.onResolve({ filter: /\/(?:modpackService|downloadService|networkRequest|curseForgePackMetadata|downloadActivityService)$/ }, args => ({ path: path.basename(args.path), namespace: 'host-runtime' }))
      builder.onLoad({ filter: /.*/, namespace: 'host-runtime' }, args => {
        const key = args.path as keyof typeof runtime
        return { contents: `const value = require('@modmind/host').runtime.${key};\n` + Object.keys(runtime[key]).map(name => `export const ${name} = value.${name};`).join('\n'), loader: 'js' }
      })
    } }] })
    await fs.writeFile(path.join(directory, 'renderer.js'), '')
    await fs.writeFile(path.join(directory, 'renderer.css'), '')
    const manifest = JSON.parse(await fs.readFile('feature-plugins/modpack-mods/manifest.json', 'utf8'))
    const contributions = JSON.parse(await fs.readFile('feature-plugins/modpack-mods/main-contributions.json', 'utf8'))
    const files = Object.fromEntries(await Promise.all(['main.cjs', 'renderer.js', 'renderer.css'].map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')])))
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, ...contributions, hostCapabilities: ['runtime'], files }))
    await plugins.initialize([{ id: 'modpack-mods', directory }])
    expect(plugins.catalog().find(entry => entry.id === 'modpack-mods')?.enabled).toBe(true)
    const child = await connect()
    const name = 'modmind_modpack_refresh_mods'
    expect((await rpc(child, ++id, 'tools/list')).result.tools.some((tool: any) => tool.name === name)).toBe(true)
    await fs.writeFile(path.join(root, 'mods', 'manual.jar'), Buffer.alloc(2048, 7))
    const reply = await rpc(child, ++id, 'tools/call', { name, arguments: {} })
    expect(reply.result.isError).not.toBe(true)
    expect(JSON.parse(reply.result.content[0].text).mods).toEqual([expect.objectContaining({ fileName: 'manual.jar', size: 2048 })])
    expect((await modpackService.readModpackManifest(project)).mods).toHaveLength(1)
    const reader = await connect(true)
    expect((await rpc(reader, ++id, 'tools/call', { name, arguments: {} })).result.isError).toBe(true)
    await expect(plugins.invoke('modpack-mods', 'modpack:refreshMods', { args: ['invalid'] }, { projectPath: root, surface: 'workbench' })).rejects.toThrow()
    await expect(plugins.invoke('modpack-mods', 'modpack:refreshMods', {}, { projectPath: path.join(root, 'other'), surface: 'workbench' })).rejects.toThrow('PROJECT_MISMATCH')
    await fs.writeFile(path.join(root, 'mods', 'second.jar'), Buffer.alloc(2048, 8))
    await expect(plugins.invoke('modpack-mods', 'modpack:refreshMods', { args: [] })).resolves.toMatchObject({ mods: expect.arrayContaining([expect.objectContaining({ fileName: 'second.jar' })]) })
    expect((await modpackService.readModpackManifest(project)).mods).toHaveLength(2)
  } finally {
    for (const child of children) if (child.exitCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill(); await closed }
    for (const bridge of bridges) await bridge.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20000)
