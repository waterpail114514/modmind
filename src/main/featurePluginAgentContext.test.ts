import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { featurePluginCapabilityPrompt, featurePluginTurnPrompt } from './featurePluginAgentContext'
import type { FeaturePluginCatalogEntry, FeaturePluginDiscoveredTool } from '../shared/featurePlugins'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const catalog = (state: FeaturePluginCatalogEntry['state']): FeaturePluginCatalogEntry[] => [{
  id: 'image-studio', name: '图像工坊', version: 'test', installed: state !== 'not-installed', enabled: state === 'ready',
  available: state === 'ready', state, installHint: '设置 → 集成 → 应用功能插件',
  manifest: { format: 'modmind-feature', apiVersion: 2, hostVersion: 'test', id: 'image-studio', name: '图像工坊', version: 'test',
    main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', capabilities: [{ id: 'images', name: 'AI 图像生成', description: '生成、像素化与去背景' }] }
}]
const tool = { pluginId: 'image-studio', name: 'modmind_image_generate', action: 'image_generate', description: 'Generate', inputSchema: { type: 'object' }, permission: 'network', projectRequired: true } as FeaturePluginDiscoveredTool

it('keeps product capability knowledge when the executable plugin is absent', () => {
  const prompt = featurePluginCapabilityPrompt(catalog('not-installed'))
  expect(prompt).toContain('图像工坊')
  expect(prompt).toContain('AI 图像生成')
  expect(prompt).toContain('not-installed')
  expect(prompt).toContain('Do not scan the computer')
  expect(prompt).not.toContain('modmind_image_generate')
})

it('reports plugin removal and selection changes on resumed turns without leaking other conversation scopes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-toolchain-')); roots.push(directory)
  const base = { directory, scope: 'conversation-a', surface: 'workbench' as const }
  const first = await featurePluginTurnPrompt({ ...base, catalog: catalog('ready'), tools: [tool], selections: { imageGeneration: true } })
  expect(first).toContain('"firstTurn":true')
  const removed = await featurePluginTurnPrompt({ ...base, catalog: catalog('disabled'), tools: [], selections: { imageGeneration: false } })
  expect(removed).toContain('"removed":["modmind_image_generate"]')
  expect(removed).toContain('"from":"ready","to":"disabled"')
  expect(removed).toContain('"id":"imageGeneration","enabled":false')
  const stable = await featurePluginTurnPrompt({ ...base, catalog: catalog('disabled'), tools: [], selections: { imageGeneration: false } })
  expect(stable).toContain('"featureStates":[],"userSelections":[]')
  const separate = await featurePluginTurnPrompt({ ...base, scope: 'conversation-b', catalog: catalog('ready'), tools: [tool] })
  expect(separate).toContain('"firstTurn":true')
  const inspiration = await featurePluginTurnPrompt({ ...base, surface: 'inspiration', catalog: catalog('ready'), tools: [tool] })
  expect(inspiration).toContain('"firstTurn":true')
})

it('requests a task-specific recommendation table and distinguishes automatic beginner installation from manual and read-only modes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-recommendation-')); roots.push(directory)
  const base = { directory, scope: 'recommendations', surface: 'workbench' as const, catalog: catalog('not-installed'), tools: [] }
  const manual = await featurePluginTurnPrompt(base)
  expect(manual).toContain('推荐功能｜推荐原因｜安装状态')
  expect(manual).toContain('不擅自安装')
  const automatic = await featurePluginTurnPrompt({ ...base, installationMode: 'automatic' })
  expect(automatic).toContain('不再询问用户确认')
  expect(automatic).toContain('modmind_feature_call')
  const inspiration = await featurePluginTurnPrompt({ ...base, surface: 'inspiration', installationMode: 'automatic' })
  expect(inspiration).not.toContain('不再询问用户确认')
})
