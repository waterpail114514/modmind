import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureCatalog, captureIcons, captureSources } from '../../feature-plugins/mc-pull/src/main/captureCatalogService'
const roots: string[] = []
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-catalog-')); roots.push(root); const pack = path.join(root, '.modmind/mc-capture/packs/fixture'); await fs.mkdir(path.join(pack, 'icons'), { recursive: true }); await fs.writeFile(path.join(root, '.modmind/mc-capture/active.txt'), 'fixture'); return { root, pack } }
afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('modmind-catalog-')) throw Error('Unexpected cleanup path'); await fs.rm(root, { recursive: true, force: true }) } })
it('invalidates a changed catalog and recovers after corrupt data without a permanently rejected cache', async () => {
  const { root, pack } = await fixture(), file = path.join(pack, 'items.json')
  await fs.writeFile(file, JSON.stringify({ ids: ['fixture:ore'], names: ['矿石'], icons: ['ore.png'], attrProvenance: 'unknown' }))
  expect((await captureCatalog(root)).items[0].name).toBe('矿石'); expect((await captureCatalog(root)).warning).not.toBe('')
  await fs.writeFile(file, '{broken'); await expect(captureCatalog(root)).rejects.toThrow()
  await fs.writeFile(file, JSON.stringify({ ids: ['fixture:ore'], names: ['新的矿石名称'], icons: ['ore.png'] }))
  expect((await captureCatalog(root)).items[0].name).toBe('新的矿石名称')
})
it('returns no inherited source in a different project, and bounds malformed icon paths', async () => {
  const a = await fixture(), b = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-catalog-')); roots.push(b)
  await fs.writeFile(path.join(a.pack, 'items.json'), JSON.stringify({ ids: ['fixture:ore'], names: ['矿石'], icons: ['../outside.png'] }))
  expect((await captureCatalog(b)).items).toEqual([]); expect(await captureIcons(a.root, ['fixture:ore'])).toEqual({})
  await fs.writeFile(path.join(a.pack, 'meta.json'), JSON.stringify({ title: '实例 A', count: 1 }))
  expect((await captureSources(a.root)).packs[0].title).toBe('实例 A')
})
