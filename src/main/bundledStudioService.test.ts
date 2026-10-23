import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FeaturePluginService } from './featurePluginService'
import { builtinStudioDirectories } from './bundledStudioService'
import { featureHostRuntime } from './featureHostRuntime'
import { StudioRegistry } from './studioRegistry'
import type { StudioRuntime } from '../shared/studios'

const releases: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-bundled-studios-'))
  releases.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const options = { requireFrom: path.resolve('package.json'), capabilities: { studioV1: true, runtime: featureHostRuntime }, options: () => ({ host: { inspectBuiltinStudio: async () => null, adoptBuiltinStudio: async () => null } }), busy: () => false, changed: () => undefined }
  const service = new FeaturePluginService(path.join(root, 'features'), options)
  releases.push(() => service.shutdown())
  return { root, service, options, bundles: path.resolve('resources/bundled-studios') }
}
it('loads all domains directly from shipped resources offline without user installations', async () => {
  const f = await fixture()
  await f.service.initialize(await builtinStudioDirectories(f.bundles))
  const registry = new StudioRegistry(() => f.service.catalog(), id => f.service.service<StudioRuntime>(id))
  expect(registry.list().filter(record => record.available).map(record => record.definition.projectKind).sort()).toEqual(['mod', 'modpack', 'server-plugin'])
  expect(f.service.list().every(record => record.builtin && record.enabled)).toBe(true)
  expect(await fs.readdir(path.join(f.root, 'features'))).toEqual([])
  await expect(f.service.setEnabled('studio-mod', false)).rejects.toThrow('内置工作台')
  await expect(f.service.uninstall('studio-modpack')).rejects.toThrow('内置工作台')
})
it('ignores old same-ID user installs without modifying them', async () => {
  const f = await fixture(), old = path.join(f.root, 'features', 'studio-mod')
  await fs.mkdir(old, { recursive: true }); await fs.writeFile(path.join(old, 'disabled'), 'keep')
  await f.service.initialize(await builtinStudioDirectories(f.bundles))
  expect(f.service.enabled('studio-mod')).toBe(true)
  expect(await fs.readFile(path.join(old, 'disabled'), 'utf8')).toBe('keep')
  const record = f.service.list().find(record => record.id === 'studio-mod')!
  await expect(f.service.update({ manifest: { ...record.manifest!, files: {} }, files: new Map() })).rejects.toThrow()
})
it('reports a damaged bundled provider and never falls back to a user copy', async () => {
  const f = await fixture(), corrupted = path.join(f.root, 'corrupted')
  await fs.cp(f.bundles, corrupted, { recursive: true })
  await fs.writeFile(path.join(corrupted, 'studio-server-plugin', 'main.cjs'), 'corrupted')
  await f.service.initialize(await builtinStudioDirectories(corrupted))
  expect(f.service.enabled('studio-server-plugin')).toBe(false)
  expect(f.service.list().find(record => record.id === 'studio-server-plugin')).toMatchObject({ builtin: true, enabled: false, error: expect.any(String) })
})
