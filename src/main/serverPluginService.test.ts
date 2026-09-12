import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parsePluginDescriptor, inspectPluginJar } from './serverPluginService'
import { pluginTemplateFiles } from './serverPluginTemplates'
import { createStoredZip } from './bedrockAddon'
import { validateServerProfile, defaultServerProfile } from './serverCoreService'
import type { ProjectInfo } from '../shared/types'

const project: ProjectInfo = { name: '测试插件', path: '', namespace: 'test', kind: 'server-plugin', loader: 'paper', minecraftVersion: '1.21.1', createdAt: '' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('generates a standard plugin and preserves dependency roles', () => {
  const files = pluginTemplateFiles(project)
  const descriptor = parsePluginDescriptor(files['src/main/resources/plugin.yml'], 'plugin.yml')
  expect(descriptor.name).toBe('test')
  expect(descriptor.main).toBe('dev.modmind.test.PluginEntry')
  expect(files['build.gradle']).toContain('compileOnly')
  expect(files['build.gradle']).not.toContain('fabric-loom')
  const parsed = parsePluginDescriptor('name: Test\nversion: "1"\nmain: example.Main\ndepend: [Vault]\nsoftdepend: [PlaceholderAPI]\n', 'plugin.yml')
  expect(parsed.dependencies).toEqual([{ name: 'Vault', optional: false }, { name: 'PlaceholderAPI', optional: true }])
})

it('does not accept a descriptor with a missing entry class', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-jar-')); roots.push(root)
  const file = path.join(root, 'plugin.jar')
  await fs.writeFile(file, createStoredZip([{ name: 'plugin.yml', data: Buffer.from('name: Test\nversion: "1"\nmain: example.Missing\n') }]))
  await expect(inspectPluginJar(file)).rejects.toThrow('入口类不存在')
})

it('rejects incompatible targets and unsafe profile paths', () => {
  expect(() => validateServerProfile(project, { ...defaultServerProfile(project), core: 'spigot' })).toThrow('Spigot')
  expect(() => validateServerProfile(project, { ...defaultServerProfile(project), localJar: '../server.jar' })).toThrow('路径')
  expect(() => validateServerProfile(project, { ...defaultServerProfile(project), core: 'velocity' })).toThrow('Velocity')
})
