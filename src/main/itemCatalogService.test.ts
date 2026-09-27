import { expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listVanillaItems } from './itemCatalogService'

it('loads a versioned vanilla item catalog with localized names and caches it', async () => {
  const getJson = vi.fn(async (url: string) => url.includes('dataPaths.json') ? { pc: { '1.21.9': { items: 'pc/1.21.9', blocks: 'pc/1.21.9' } } } : url.includes('blocks.json') ? [{ name: 'stone' }] : url.includes('items.json') ? [
    { name: 'air', displayName: 'Air', stackSize: 64 },
    { name: 'iron_sword', displayName: 'Iron Sword', stackSize: 1, maxDurability: 250 },
    { name: 'diamond_chestplate', displayName: 'Diamond Chestplate', stackSize: 1, maxDurability: 528 },
    { name: 'stone', displayName: 'Stone', stackSize: 64 }
  ] : { 'item.minecraft.iron_sword': '铁剑', 'block.minecraft.stone': '石头' })

  const items = await listVanillaItems('1.21.9', getJson)
  expect(items).toEqual([
    { id: 'iron_sword', name: '铁剑', englishName: 'Iron Sword', kind: 'sword', stackSize: 1, maxDurability: 250 },
    { id: 'diamond_chestplate', name: 'Diamond Chestplate', englishName: 'Diamond Chestplate', kind: 'armor', stackSize: 1, maxDurability: 528 },
    { id: 'stone', name: '石头', englishName: 'Stone', kind: 'block', stackSize: 64 }
  ])
  expect(await listVanillaItems('1.21.9', getJson)).toBe(items)
  expect(getJson).toHaveBeenCalledTimes(4)
  expect(getJson.mock.calls[1][0]).toContain('/1.21.9/items.json')
})

it('follows upstream shared item data for supported patch versions', async () => {
  const getJson = vi.fn(async (url: string) => url.includes('dataPaths.json')
    ? { pc: { '1.20.2': { items: 'pc/1.20.1' }, '1.21.10': { items: 'pc/1.21.9' } } }
    : url.includes('items.json') ? [{ name: 'stone', displayName: 'Stone', stackSize: 64 }] : {})
  expect((await listVanillaItems('1.20.2', getJson))[0].id).toBe('stone')
  expect((await listVanillaItems('1.21.10', getJson))[0].id).toBe('stone')
  expect(getJson.mock.calls.map(([url]) => url).filter(url => url.includes('items.json'))).toEqual([
    'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data/pc/1.20.1/items.json',
    'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data/pc/1.21.9/items.json'
  ])
})

it('opens every supported catalog with no network or prior cache', async () => {
  const getJson = vi.fn(() => Promise.reject(new Error('offline')))
  const base = await listVanillaItems('1.20.1', getJson)
  const current = await listVanillaItems('1.21', getJson)
  expect(base).toHaveLength(1254)
  expect(current).toHaveLength(1332)
  expect(await listVanillaItems('1.21.1', getJson)).toBe(current)
  expect(base.find(item => item.id === 'stone')?.name).toBe('石头')
  expect(base.find(item => item.id === 'stone')?.kind).toBe('block')
  expect(base.some(item => item.id === 'grass')).toBe(true)
  expect(current.some(item => item.id === 'grass')).toBe(false)
  expect(current.find(item => item.id === 'tuff_slab')?.name).toBe('凝灰岩台阶')
  expect(current.find(item => item.id === 'tuff_slab')?.kind).toBe('block')
  expect(getJson).not.toHaveBeenCalled()
})

it('rejects invalid versions without a request', async () => {
  const getJson = vi.fn()
  await expect(listVanillaItems('../1.21.1', getJson)).rejects.toThrow('没有可用')
  expect(getJson).not.toHaveBeenCalled()
})

it('explains when a version has no published item catalog', async () => {
  await expect(listVanillaItems('1.22.7', async url => {
    if (url.includes('items.json')) throw new Error('returned HTTP 404')
    return {}
  })).rejects.toThrow('此 Minecraft 版本暂无原版物品目录')
})

it('uses a validated local catalog while offline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-item-catalog-'))
  try {
    const directory = path.join(root, 'item-catalog')
    await fs.mkdir(directory)
    const item = { id: 'iron_sword', name: '铁剑', englishName: 'Iron Sword', kind: 'sword', stackSize: 1, maxDurability: 250 }
    await fs.writeFile(path.join(directory, '1.22.8.json'), JSON.stringify([item]))
    const getJson = vi.fn()
    expect(await listVanillaItems('1.22.8', getJson, root)).toEqual([item])
    expect(getJson).not.toHaveBeenCalled()
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
