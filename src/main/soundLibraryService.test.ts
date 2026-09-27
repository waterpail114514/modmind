import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SoundLibraryService } from './soundLibraryService'
import { SoundVanilla } from './soundVanilla'
import { bundledSoundCatalog } from './soundCatalogBundled'
import { ContentService } from './contentService'
import type { ProjectInfo } from '../shared/types'
import { newStudioDraft } from '../shared/soundStudio'

const roots: string[] = []
async function fixture(): Promise<{ service: SoundLibraryService; root: string; assets: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modmind-sounds-'))
  roots.push(root)
  const assets = path.join(root, 'src', 'main', 'resources', 'assets', 'testmod')
  await mkdir(path.join(assets, 'sounds'), { recursive: true })
  const project = { name: 'Test', path: root, namespace: 'testmod', minecraftVersion: '1.20.1', loader: 'fabric', createdAt: '' } as ProjectInfo
  return { root, assets, service: new SoundLibraryService(project, path.join(root, 'no-minecraft'), path.join(root, 'cache')) }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('sound library', () => {
  it('uses the verified local Minecraft index and previews installed audio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'modmind-vanilla-sounds-'))
    roots.push(root)
    const minecraft = path.join(root, 'minecraft')
    const cache = path.join(root, 'cache')
    const audio = Buffer.from('OggSinstalled-sound')
    const soundName = 'minecraft/sounds/ambient/cave/cave1.ogg'
    const audioHash = createHash('sha1').update(audio).digest('hex')
    const index = Buffer.from(JSON.stringify({ objects: { [soundName]: { hash: audioHash, size: audio.length } } }))
    const indexHash = createHash('sha1').update(index).digest('hex')
    const indexDirectory = path.join(minecraft, 'assets', 'indexes')
    const objectDirectory = path.join(minecraft, 'assets', 'objects', audioHash.slice(0, 2))
    await mkdir(path.join(minecraft, 'versions', '1.20.1'), { recursive: true })
    await mkdir(indexDirectory, { recursive: true })
    await mkdir(objectDirectory, { recursive: true })
    await writeFile(path.join(minecraft, 'versions', '1.20.1', '1.20.1.json'), JSON.stringify({ id: '1.20.1', assetIndex: { id: '5', sha1: indexHash, url: 'https://example.test/index' } }))
    await writeFile(path.join(indexDirectory, '5.json'), '{}')
    await writeFile(path.join(indexDirectory, indexHash + '.json'), index)
    await writeFile(path.join(objectDirectory, audioHash), audio)

    const vanilla = new SoundVanilla('1.20.1', cache, [minecraft])
    expect((await vanilla.localIndex())?.objects[soundName]).toEqual({ hash: audioHash, size: audio.length })
    expect(await vanilla.hasLocalAudio(soundName)).toBe(true)
    expect(await vanilla.bytes(soundName, false)).toEqual(audio)
    const project = { name: 'Test', path: root, namespace: 'testmod', minecraftVersion: '1.20.1', loader: 'fabric', createdAt: '' } as ProjectInfo
    const service = new SoundLibraryService(project, minecraft, cache)
    const item = (await service.list()).items.find(value => value.source === 'vanilla' && value.path.endsWith('/ambient/cave/cave1.ogg'))
    expect(item?.available).toBe(true)
    expect((await service.readAudio(item!.id)).dataUrl).toContain(audio.toString('base64'))
    await rm(path.join(objectDirectory, audioHash))
    expect(await vanilla.hasLocalAudio(soundName)).toBe(false)
    expect((await service.list(true)).items.find(value => value.id === item!.id)?.available).toBe(false)
    await expect(vanilla.bytes(soundName, false)).rejects.toThrow('此音频尚未下载')

    await rm(path.join(indexDirectory, indexHash + '.json'))
    vanilla.refreshLocal()
    await expect(vanilla.bytes(soundName, false)).rejects.toThrow('原版资源索引不存在')
  })
  it('bundles complete versioned vanilla events without bundling audio', () => {
    const legacy = bundledSoundCatalog('1.20.1')!
    const modern = bundledSoundCatalog('1.21.1')!
    expect(Object.keys(legacy.definitions)).toHaveLength(1471)
    expect(Object.keys(modern.definitions)).toHaveLength(1612)
    expect(legacy.definitions['music.game'].sounds.length).toBeGreaterThan(10)
    expect(modern.definitions['block.stone.break'].sounds.length).toBeGreaterThan(1)
    expect(bundledSoundCatalog('1.19.4')).toBeNull()
  })
  it('indexes project audio, saves changes and undoes them', async () => {
    const { service, assets } = await fixture()
    await writeFile(path.join(assets, 'sounds.json'), JSON.stringify({ 'ambient/wind': { sounds: [{ name: 'testmod:ambient/wind', weight: 2 }] } }))
    await mkdir(path.join(assets, 'sounds', 'ambient'), { recursive: true })
    await writeFile(path.join(assets, 'sounds', 'ambient', 'wind.ogg'), Buffer.from('OggSfixture'))
    const before = await service.list()
    const event = before.events.find(item => item.id === 'ambient/wind' && item.editable)!
    const item = before.items.find(value => value.eventKey === event.key)!
    expect(item.available).toBe(true)
    expect((await service.readAudio(item.id)).dataUrl).toContain('T2dnU2ZpeHR1cmU=')
    await service.saveEvent({ key: event.key, revision: event.revision, namespace: 'testmod', id: 'ambient/wind', definition: { ...event.definition, sounds: [{ name: 'testmod:ambient/wind', weight: 5 }] } })
    expect(JSON.parse(await readFile(path.join(assets, 'sounds.json'), 'utf8'))['ambient/wind'].sounds[0].weight).toBe(5)
    await service.undo()
    expect(JSON.parse(await readFile(path.join(assets, 'sounds.json'), 'utf8'))['ambient/wind'].sounds[0].weight).toBe(2)
  })
  it('rejects stale edits and circular event references', async () => {
    const { service, assets } = await fixture()
    await writeFile(path.join(assets, 'sounds.json'), JSON.stringify({ first: { sounds: [] } }))
    const current = (await service.list()).events.find(item => item.id === 'first' && item.editable)!
    await writeFile(path.join(assets, 'sounds.json'), JSON.stringify({ first: { sounds: [], subtitle: 'changed' } }))
    await expect(service.saveEvent({ key: current.key, revision: current.revision, namespace: 'testmod', id: 'first', definition: current.definition })).rejects.toThrow('已被其他操作修改')
    await expect(service.saveEvent({ namespace: 'testmod', id: 'second', definition: { sounds: [{ name: 'testmod:second', type: 'event' }] } })).rejects.toThrow('循环引用')
  })
  it('exports a made sound as Vorbis, keeps the source event and supports undo', async () => {
    const { service, assets } = await fixture()
    const samples = 4410, wav = new Uint8Array(44 + samples * 2), view = new DataView(wav.buffer)
    for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let index = 0; index < label.length; index++) wav[offset + index] = label.charCodeAt(index)
    view.setUint32(4, wav.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples * 2, true)
    for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.sin(index * Math.PI / 10) * 10000, true)
    await service.saveRendered('ui/confirm', wav, false)
    const imported = JSON.parse(await readFile(path.join(assets, 'sounds.json'), 'utf8'))
    expect(imported['ui/confirm'].sounds[0].name).toBe('testmod:ui/confirm')
    const bytes = await readFile(path.join(assets, 'sounds', 'ui', 'confirm.ogg'))
    expect(bytes.subarray(0, 4).toString()).toBe('OggS')
    await service.undo()
    await expect(readFile(path.join(assets, 'sounds.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(assets, 'sounds', 'ui', 'confirm.ogg'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20000)
  it('mixes a generated sound with a project audio layer', async () => {
    const { service, assets } = await fixture()
    const samples = 4410, wav = new Uint8Array(44 + samples * 2), view = new DataView(wav.buffer)
    for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let index = 0; index < label.length; index++) wav[offset + index] = label.charCodeAt(index)
    view.setUint32(4, wav.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples * 2, true)
    await service.saveRendered('ui/layer', wav, false)
    const layer = (await service.list()).items.find(item => item.eventId === 'testmod:ui/layer')!
    const draft = newStudioDraft()
    draft.effect.layers = [{ sourceId: layer.id, name: layer.name, offset: .1, gain: .5, rate: 1.1 }]
    const rendered = await service.renderEffect(draft)
    expect(rendered.subarray(0, 4).toString()).toBe('RIFF')
    await service.saveRendered('ui/mixed', rendered, false)
    expect((await readFile(path.join(assets, 'sounds', 'ui', 'mixed.ogg'))).subarray(0, 4).toString()).toBe('OggS')
  }, 20000)
  it('validates event references without demanding an OGG with the event name', async () => {
    const { root, assets } = await fixture()
    await writeFile(path.join(assets, 'sounds.json'), JSON.stringify({ first: { sounds: [{ name: 'testmod:second', type: 'event' }] }, second: { sounds: ['minecraft:block/stone1'] } }))
    const project = { name: 'Test', path: root, namespace: 'testmod', minecraftVersion: '1.20.1', loader: 'fabric', createdAt: '' } as ProjectInfo
    const result = await new ContentService(() => project).validate()
    expect(result.errors).toEqual([])
  })
})
