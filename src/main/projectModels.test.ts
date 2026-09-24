import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { readProjectModel } from './projectModels'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => {
  await fs.unlink(path.join(root, 'project/linked')).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})) })
const fixture = async (): Promise<string> => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-model-')); roots.push(root); return root }
it('reads saved Blockbench geometry and embedded textures without changing the source', async () => {
  const root = await fixture()
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#729348' } }).png().toBuffer()
  const source = JSON.stringify({ meta: { model_format: 'free' }, resolution: { width: 32, height: 32 }, elements: [{ uuid: 'cube', type: 'cube', from: [0,0,0], to: [16,16,16], faces: { north: { texture: 0 } } }], outliner: [{ origin: [8,8,8], rotation: [0,45,0], children: ['cube'] }], textures: [{ uuid: 'texture', source: `data:image/png;base64,${png.toString('base64')}` }], animations: [{}] })
  await fs.writeFile(path.join(root, '森林 模型.bbmodel'), source)
  const result = await readProjectModel(root, 'modmind-model:?path=' + encodeURIComponent('森林 模型.bbmodel'))
  expect(result.blockbench?.elements[0].uuid).toBe('cube')
  expect(result.blockbench?.textures['0']).toBe(result.blockbench?.textures.texture)
  expect(result.blockbench?.textures['0']).toMatch(/^data:image\/png;base64,/)
  expect(result.warnings).toContain('显示静态姿态，暂不播放动画')
  expect(await fs.readFile(path.join(root, '森林 模型.bbmodel'), 'utf8')).toBe(source)
})
it('blocks outside models and external texture reads, including junctions', async () => {
  const root = await fixture(), project = path.join(root, 'project'), outside = path.join(root, 'outside')
  await fs.mkdir(project); await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.bbmodel'), '{}')
  await fs.writeFile(path.join(outside, 'secret.png'), 'private')
  await fs.symlink(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const reference of ['../outside/secret.bbmodel', 'linked/secret.bbmodel', 'https://example.com/a.bbmodel']) await expect(readProjectModel(project, reference)).rejects.toThrow()
  await fs.writeFile(path.join(project, 'model.bbmodel'), JSON.stringify({ elements: [{ from: [0,0,0], to: [1,1,1] }], textures: [{ name: '外部贴图', relative_path: 'linked/secret.png' }] }))
  const result = await readProjectModel(project, 'model.bbmodel')
  expect(result.blockbench?.textures).toEqual({})
  expect(result.warnings[0]).toContain('外部贴图')
})
it('resolves local Java model parents and aliases and rejects cycles', async () => {
  const root = await fixture(), models = path.join(root, 'assets/demo/models')
  await fs.mkdir(models, { recursive: true }); await fs.mkdir(path.join(root, 'assets/demo/textures'))
  await fs.writeFile(path.join(root, 'assets/demo/textures/wood.png'), await sharp({ create: { width: 1, height: 1, channels: 4, background: '#987654' } }).png().toBuffer())
  await fs.writeFile(path.join(models, 'base.json'), JSON.stringify({ elements: [{ from: [0,0,0], to: [16,16,16], faces: { north: { texture: '#side' } } }], textures: { side: '#all' } }))
  await fs.writeFile(path.join(models, 'child.json'), JSON.stringify({ parent: 'demo:base', textures: { all: 'demo:wood' } }))
  const result = await readProjectModel(root, 'assets/demo/models/child.json')
  expect(result.minecraft?.elements).toHaveLength(1)
  expect(result.minecraft?.textures['#side']).toMatch(/^data:image\/png;base64,/)
  await fs.writeFile(path.join(models, 'base.json'), JSON.stringify({ parent: 'demo:child' }))
  await expect(readProjectModel(root, 'assets/demo/models/child.json')).rejects.toThrow('循环')
})
