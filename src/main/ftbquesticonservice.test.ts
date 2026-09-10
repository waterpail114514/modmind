import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { ftbIconDescriptor, ftbIconKey } from '../shared/ftbIcon'
import { inspectFtbQuestIcon, refreshFtbQuestResources, resolveFtbQuestIcon } from './ftbquesticonservice'

const roots: string[] = []
beforeEach(() => { vi.stubEnv('APPDATA', path.join(os.tmpdir(), 'ftb-test-no-runtime')) })
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftb-icons-')); roots.push(root)
  const project = { path: root, minecraftVersion: '1.20.1', kind: 'modpack' } as ProjectInfo
  const write = async (entry: string, value: unknown, pack = 'kubejs') => {
    const file = path.join(root, pack, entry); await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, Buffer.isBuffer(value) ? value : JSON.stringify(value))
  }
  const png = (color: string, width = 2, height = 2) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
  const model = (name: string, texture: string) => write(`assets/test/models/${name}.json`, { parent: 'item/generated', textures: { layer0: texture } })
  return { root, project, write, png, model }
}
async function pixels(url: string) { return sharp(Buffer.from(url.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer() }

describe('FTB resource/model rendering', () => {
  it('retains NBT and canonicalizes description keys without merging appearances', () => {
    expect(ftbIconDescriptor('test:thing{CustomModelData:7}')).toEqual({ id: 'test:thing', tag: { CustomModelData: 7 } })
    expect(ftbIconKey({ id: 'test:a', tag: { a: 1, b: 2 } })).toBe(ftbIconKey({ tag: { b: 2, a: 1 }, id: 'test:a' }))
    expect(ftbIconKey('test:a')).not.toBe(ftbIconKey('test:a{CustomModelData:1}'))
    expect(ftbIconDescriptor('test:../a')).toBeNull()
  })
  it('uses model textures before same-name PNG and defaults unqualified textures to minecraft', async () => {
    const f = await fixture()
    await f.model('item/a', 'item/correct')
    await f.write('assets/minecraft/textures/item/correct.png', await f.png('#ff0000'))
    await f.write('assets/test/textures/item/a.png', await f.png('#0000ff'))
    const icon = await resolveFtbQuestIcon(f.project, 'test:a')
    expect(icon?.quality).toBe('resolved')
    expect([...(await pixels(icon!.url)).subarray(0, 4)]).toEqual([255, 0, 0, 255])
  })
  it('resolves arbitrary parents and last matching override without trying unmatched models', async () => {
    const f = await fixture()
    await f.write('assets/test/models/item/a.json', { parent: 'test:custom/base', overrides: [{ predicate: { custom_model_data: 1 }, model: 'test:special/one' }, { predicate: { custom_model_data: 3 }, model: 'test:special/two' }] })
    for (const [name, color] of [['custom/base', '#ff0000'], ['special/one', '#00ff00'], ['special/two', '#0000ff']]) {
      await f.model(name, `test:${name}`); await f.write(`assets/test/textures/${name}.png`, await f.png(color))
    }
    for (const [value, expected] of [[0, [255, 0, 0]], [2, [0, 255, 0]], [3, [0, 0, 255]]] as const) {
      const icon = await resolveFtbQuestIcon(f.project, { id: 'test:a', tag: { CustomModelData: value } })
      expect([...(await pixels(icon!.url)).subarray(0, 3)]).toEqual(expected)
    }
  })
  it('composites layers and applies explicit tint as RGB multiplication', async () => {
    const f = await fixture()
    await f.write('assets/test/models/item/a.json', { parent: 'item/generated', textures: { layer0: 'test:a', layer1: 'test:b' } })
    await f.write('assets/test/textures/a.png', await f.png('#ffffff'))
    await f.write('assets/test/textures/b.png', await f.png('#00000000'))
    const icon = await resolveFtbQuestIcon(f.project, { id: 'test:a', tint: [0xff0000] })
    expect([...(await pixels(icon!.url)).subarray(0, 4)]).toEqual([255, 0, 0, 255])
  })
  it('honors animation order, repeated frames, dimensions and per-frame duration', async () => {
    const f = await fixture()
    await f.model('item/a', 'test:a')
    const sheet = await sharp({ create: { width: 4, height: 2, channels: 4, background: '#ff0000' } }).composite([{ input: await f.png('#0000ff'), left: 2, top: 0 }]).png().toBuffer()
    await f.write('assets/test/textures/a.png', sheet)
    await f.write('assets/test/textures/a.png.mcmeta', { animation: { width: 2, height: 2, frames: [{ index: 1, time: 2 }, 0, 1] } })
    const icon = await resolveFtbQuestIcon(f.project, 'test:a')
    expect(icon).toMatchObject({ frameWidth: 2, frameHeight: 2, frameCount: 4, frametimeMs: 50, animated: true })
    const data = await pixels(icon!.url)
    expect([0, 16, 32, 48].map(offset => [...data.subarray(offset, offset + 3)])).toEqual([[0, 0, 255], [0, 0, 255], [255, 0, 0], [0, 0, 255]])
  })
  it('rejects truncated PNGs, bare strips and entity renderers without basename substitution', async () => {
    const f = await fixture()
    await f.model('item/a', 'test:a')
    await f.write('assets/test/textures/a.png', (await f.png('#ff0000')).subarray(0, 24))
    expect((await inspectFtbQuestIcon(f.project, 'test:a')).icon).toBeNull()
    await f.write('assets/test/textures/a.png', await f.png('#ff0000', 2, 4)); refreshFtbQuestResources(f.project)
    expect((await inspectFtbQuestIcon(f.project, 'test:a')).reason).toMatch(/Non-square/)
    await f.write('assets/test/models/item/a.json', { parent: 'builtin/entity' }); refreshFtbQuestResources(f.project)
    expect((await inspectFtbQuestIcon(f.project, 'test:a')).reason).toMatch(/entity renderer/)
  })
  it('uses only enabled packs in order, merges concurrent requests and invalidates on refresh', async () => {
    const f = await fixture()
    await f.model('item/a', 'test:a')
    for (const [pack, color] of [['low', '#ff0000'], ['high', '#00ff00'], ['disabled', '#0000ff']]) await f.write('assets/test/textures/a.png', await f.png(color), `resourcepacks/${pack}`)
    await fs.writeFile(path.join(f.root, 'options.txt'), 'resourcePacks:["file/low","file/high"]')
    const [a, b] = await Promise.all([inspectFtbQuestIcon(f.project, 'test:a'), inspectFtbQuestIcon(f.project, 'test:a')])
    expect(a).toBe(b)
    expect([...(await pixels(a.icon!.url)).subarray(0, 3)]).toEqual([0, 255, 0])
    await fs.writeFile(path.join(f.root, 'options.txt'), 'resourcePacks:["file/high","file/low"]')
    refreshFtbQuestResources(f.project)
    const c = await inspectFtbQuestIcon(f.project, 'test:a')
    expect(c.generation).not.toBe(a.generation)
    expect([...(await pixels(c.icon!.url)).subarray(0, 3)]).toEqual([255, 0, 0])
  })
})
