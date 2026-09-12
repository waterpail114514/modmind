import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parsePluginMetadata, ServerPluginCatalog } from './serverPluginCatalog'
import { PLUGIN_REPOSITORIES, pluginTemplateFiles } from './serverPluginTemplates'
import { pluginJavaVersion } from '../shared/serverPluginCompatibility'
import { fetchTextWithRetry } from './networkRequest'
import type { ServerPluginPlatform } from '../shared/types'

vi.mock('./networkRequest', () => ({ fetchTextWithRetry: vi.fn() }))
const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
function xml(platform: ServerPluginPlatform, versions: string[]): string {
  const [group, artifact] = PLUGIN_REPOSITORIES[platform].coordinate.split(':')
  return `<metadata><groupId>${group}</groupId><artifactId>${artifact}</artifactId><versioning><versions>${versions.map(v => `<version>${v}</version>`).join('')}</versions></versioning></metadata>`
}
async function directory(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-catalog-')); roots.push(root); return root }

it('keeps actual modern coordinates and prefers stable builds over previews', () => {
  expect(parsePluginMetadata('spigot', xml('spigot', ['1.21.11-R0.1-SNAPSHOT', '1.21.11-R0.2-SNAPSHOT']))[0].apiVersion).toBe('1.21.11-R0.2-SNAPSHOT')
  const result = parsePluginMetadata('paper', xml('paper', ['26.2.build.9-stable', '26.2.build.10-stable', '26.2.build.12-beta', '26.3-pre-2.build.0-alpha', '1.21.1-R0.1-SNAPSHOT']))
  expect(result.map(o => o.apiVersion)).toEqual(['26.2.build.10-stable', '1.21.1-R0.1-SNAPSHOT'])
  expect(result[0]).toMatchObject({ minecraftVersion: '26.2', javaVersion: 25, supportTier: 'experimental' })
  expect(parsePluginMetadata('folia', xml('folia', ['26.2.build.7-beta']))[0].channel).toBe('beta')
})

it('rejects HTML and metadata for another artifact', () => {
  expect(() => parsePluginMetadata('paper', '<html>login</html>')).toThrow('坐标')
  expect(() => parsePluginMetadata('paper', xml('spigot', ['1.21.1-R0.1-SNAPSHOT']))).toThrow('坐标')
})

it('refreshes an older cache revision when supported versions expand', async () => {
  const root = await directory()
  await fs.writeFile(path.join(root, 'spigot.json'), JSON.stringify({ at: Date.now(), options: [{ loader: 'spigot', minecraftVersion: '1.21.1', apiVersion: '1.21.1-R0.1-SNAPSHOT' }] }))
  vi.mocked(fetchTextWithRetry).mockResolvedValue(xml('spigot', ['1.8.8-R0.1-SNAPSHOT', '1.21.1-R0.1-SNAPSHOT']))
  await expect(new ServerPluginCatalog(root).resolve('spigot', '1.8.8')).resolves.toMatchObject({ javaVersion: 8 })
})

it('does not invent missing Folia versions and accepts published Velocity 4', async () => {
  vi.mocked(fetchTextWithRetry).mockImplementation(async url => url.includes('folia-api') ? xml('folia', ['1.21.4-R0.1-SNAPSHOT']) : xml('velocity', ['4.1.1', '4.1.2-SNAPSHOT']))
  const catalog = new ServerPluginCatalog(await directory())
  await expect(catalog.resolve('folia', '1.21.1')).rejects.toThrow('官方 API 目录没有')
  await expect(catalog.resolve('velocity', '4.1.1')).resolves.toMatchObject({ apiVersion: '4.1.1', javaVersion: 25 })
})

it('coalesces refreshes, isolates failures and restores last successful disk cache', async () => {
  const root = await directory()
  vi.mocked(fetchTextWithRetry).mockResolvedValue(xml('paper', ['26.2.build.123-stable']))
  const catalog = new ServerPluginCatalog(root)
  await Promise.all([catalog.listPlatform('paper', true), catalog.listPlatform('paper', true)])
  expect(fetchTextWithRetry).toHaveBeenCalledTimes(1)
  vi.mocked(fetchTextWithRetry).mockRejectedValue(new Error('HTTP 503'))
  const restarted = new ServerPluginCatalog(root)
  expect((await restarted.listPlatform('paper', true))[0].apiVersion).toBe('26.2.build.123-stable')
  expect((await restarted.listPlatform('folia', true)).some(o => o.minecraftVersion === '1.21.1')).toBe(false)
  const list = await restarted.list()
  expect(new Set(list.map(o => o.loader)).size).toBe(4)
})

it('uses Java boundaries independently from the build runner and preserves exact modern API in templates', () => {
  expect(pluginJavaVersion('spigot', '1.8.8')).toBe(8)
  const legacy = pluginTemplateFiles({ name: 'Legacy', namespace: 'legacy', path: '', kind: 'server-plugin', loader: 'spigot', minecraftVersion: '1.8.8', createdAt: '' })
  expect(legacy['src/main/resources/plugin.yml']).not.toContain('api-version')
  for (const [platform, version, expected] of [['paper', '1.20.4', 17], ['spigot', '1.20.5', 21], ['paper', '26.2', 25], ['velocity', '3.4.0', 17], ['velocity', '3.5.1', 21], ['velocity', '4.1.1', 25]] as const) expect(pluginJavaVersion(platform, version)).toBe(expected)
  const files = pluginTemplateFiles({ name: 'Test', namespace: 'test', path: '', kind: 'server-plugin', loader: 'paper', minecraftVersion: '26.2', apiVersion: '26.2.build.123-stable', createdAt: '' })
  expect(files['build.gradle']).toContain('paper-api:26.2.build.123-stable')
  expect(files['src/main/resources/plugin.yml']).toContain('api-version: "26.2"')
})
