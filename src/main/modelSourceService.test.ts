import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { readYsmSource } from './modelSourceService'
import { createStoredZip } from './bedrockAddon'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ysm-source-')); roots.push(root)
  await fs.writeFile(path.join(root, 'ysm.json'), JSON.stringify({ metadata: { name: '中文模型' }, files: { player: { model: { main: 'model.json' }, texture: ['texture.png'], animation: { main: 'animation.json' } } } }))
  await fs.writeFile(path.join(root, 'model.json'), JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.test', texture_width: 16, texture_height: 16 }, bones: [{ name: 'body', pivot: [0,0,0], cubes: [{ origin: [-4,0,-4], size: [8,8,8], uv: [0,0] }] }] }] }))
  await fs.writeFile(path.join(root, 'animation.json'), JSON.stringify({ format_version: '1.8.0', animations: { 'animation.idle': { loop: true, animation_length: 1, bones: { body: { rotation: [0,10,0] } } } } }))
  await sharp({ create: { width: 16, height: 16, channels: 4, background: '#3ab482' } }).png().toFile(path.join(root, 'texture.png'))
  return root
}

it('loads the same editable YSM source from a directory and a wrapped ZIP', async () => {
  const root = await fixture()
  const source = await readYsmSource(path.join(root, 'ysm.json'))
  expect(source).toMatchObject({ name: '中文模型', format: 'bedrock' })
  expect(source.textures).toHaveLength(1)
  expect(source.animations).toHaveLength(1)
  const files = ['ysm.json','model.json','animation.json','texture.png']
  await fs.writeFile(path.join(root, 'source.zip'), createStoredZip(await Promise.all(files.map(async name => ({ name: `wrapped/${name}`, data: await fs.readFile(path.join(root, name)) })))))
  expect(await readYsmSource(path.join(root, 'source.zip'))).toEqual(source)
})

it('rejects encrypted YSM and references outside the source directory', async () => {
  await expect(readYsmSource('encrypted.ysm')).rejects.toThrow('加密')
  const root = await fixture()
  await fs.writeFile(path.join(root, 'ysm.json'), JSON.stringify({ files: { player: { model: { main: '../private.json' } } } }))
  await expect(readYsmSource(path.join(root, 'ysm.json'))).rejects.toThrow('路径')
})
