import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPluginBridgeTarget, getPluginService, initializePlugins, refreshPluginRegistry, shutdownPlugins } from './pluginBridgeIntegration'
import type { PluginRecord } from '../shared/plugins'
import type { PluginRuntimeOptions } from './pluginRuntime'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, clipboard: { writeText: vi.fn() }, net: { fetch: vi.fn() } }))
vi.mock('./pluginProtocol', () => ({ registerPluginProtocol: vi.fn(), registerPluginProtocolScheme: vi.fn() }))
vi.mock('./pluginImportConfirmation', () => ({ requestPluginImportConfirmation: vi.fn() }))
vi.mock('./pluginRuntime', () => ({ PluginRuntime: class {
  records = new Map<string, PluginRecord>()
  constructor(private options: PluginRuntimeOptions) {}
  syncRecords(records: Map<string, PluginRecord>): void { this.records = records }
  terminateAll(): void {}
  static isReadOnlyAllowed(): boolean { return true }
  listToolDescriptors(): unknown[] { return [...this.records.values()].map(record => record.directory) }
  findTool(): unknown { return this.records.get('shared-plugin')?.enabled ? { descriptor: { pluginId: 'shared-plugin', toolName: 'inspect' } } : undefined }
  async callTool(id: string): Promise<unknown> { return { directory: this.records.get(id)?.directory, project: this.options.projectInfo() } }
} }))

let root = ''
afterEach(async () => { shutdownPlugins(); if (root) await fs.rm(root, { recursive: true, force: true }) })

it('keeps background plugin tools and file writes attached to A while B is active', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-background-'))
  const a = path.join(root, 'A'), b = path.join(root, 'B'), userData = path.join(root, 'app')
  for (const project of [a, b]) {
    const directory = path.join(project, '.modmind/plugins/shared-plugin')
    await fs.mkdir(path.join(directory, 'backend'), { recursive: true })
    await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ id: 'shared-plugin', name: 'Fixture', version: '1.0.0', description: '', permissions: ['project.read'], backend: { entry: 'backend/main.mjs', tools: [{ name: 'inspect', description: 'read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyLocal: true } }] } }))
    await fs.writeFile(path.join(directory, 'backend/main.mjs'), `// ${path.basename(project)}`)
  }
  let current = a
  initializePlugins({ userDataDirectory: userData, projectRoot: () => current, projectInfo: () => ({ name: path.basename(current), path: current, kind: 'mod' }), onSnapshotChanged: () => {} })
  await refreshPluginRegistry(); getPluginService()!.setEnabled('shared-plugin', true); await refreshPluginRegistry()
  const bridge = createPluginBridgeTarget(a)!
  current = b
  await refreshPluginRegistry(); getPluginService()!.setEnabled('shared-plugin', true); await refreshPluginRegistry()
  expect(await bridge.callTool('shared-plugin.inspect', {}, true)).toMatchObject({ directory: path.join(a, '.modmind/plugins/shared-plugin'), project: { path: a } })
  await bridge.writeFiles!({ pluginId: 'shared-plugin', files: [{ path: 'backend/main.mjs', content: '// background A edit' }] })
  expect(await fs.readFile(path.join(a, '.modmind/plugins/shared-plugin/backend/main.mjs'), 'utf8')).toBe('// background A edit')
  expect(await fs.readFile(path.join(b, '.modmind/plugins/shared-plugin/backend/main.mjs'), 'utf8')).toBe('// B')
})
