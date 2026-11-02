import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { bundledLoaderCatalog, LoaderCatalog } from './loaderCatalog'
import { fetchTextWithRetry } from './networkRequest'

vi.mock('./networkRequest', () => ({ fetchTextWithRetry: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

it('adds bundled 26.3 targets when an older fresh cache cannot be refreshed offline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-catalog-263-')); roots.push(root)
  const cachePath = path.join(root, 'catalog.json')
  const options = bundledLoaderCatalog().filter(option => option.minecraftVersion !== '26.3')
  options.find(option => option.loader === 'fabric' && option.minecraftVersion === '26.2')!.loaderVersion = 'cached-loader'
  await fs.writeFile(cachePath, JSON.stringify({ updatedAt: new Date().toISOString(), options }))
  vi.mocked(fetchTextWithRetry).mockRejectedValue(new Error('offline'))
  const catalog = new LoaderCatalog(cachePath)
  for (const loader of ['fabric', 'forge', 'neoforge'] as const) {
    await expect(catalog.resolve(loader, '26.3')).resolves.toMatchObject({ minecraftVersion: '26.3', javaVersion: 25 })
  }
  await expect(catalog.resolve('fabric', '26.2')).resolves.toMatchObject({ loaderVersion: 'cached-loader' })
  await expect(catalog.resolve('quilt', '26.3')).rejects.toThrow('不支持')
  await expect(catalog.resolve('fabric', '26.4')).rejects.toThrow('不支持')
  const returned = await catalog.list()
  returned[0].minecraftVersion = 'corrupted'
  expect((await catalog.list())[0].minecraftVersion).toBe('26.3')
})
