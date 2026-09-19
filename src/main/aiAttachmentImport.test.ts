import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importAiAttachmentSources } from './aiAttachmentImport'
import { MAX_INLINE_ATTACHMENT_BYTES } from '../shared/aiAttachments'

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-attachments-'))
  roots.push(root)
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  return { root, project }
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe('AI attachment imports', () => {
  it('persists clipboard bytes, files and nested folders without changing their sources', async () => {
    const { root, project } = await fixture()
    const file = path.join(root, 'notes.txt')
    const folder = path.join(root, 'textures')
    await fs.writeFile(file, 'reference text')
    await fs.mkdir(path.join(folder, 'nested'), { recursive: true })
    await fs.writeFile(path.join(folder, 'nested', 'tile.png'), new Uint8Array([1, 2, 3]))
    const copied = await importAiAttachmentSources(project, [
      { name: '../../screenshot.png', bytes: new Uint8Array([137, 80, 78, 71]) },
      { path: file }, { path: folder }
    ])
    expect(copied.map((item) => [item.name, item.isImage, item.isDirectory])).toEqual([
      ['screenshot.png', true, false], ['notes.txt', false, false], ['textures', false, true]
    ])
    expect(await fs.readFile(path.join(project, copied[0].path))).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(await fs.readFile(path.join(project, copied[1].path), 'utf8')).toBe('reference text')
    expect(await fs.readFile(path.join(project, copied[2].path, 'nested', 'tile.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(await fs.readFile(file, 'utf8')).toBe('reference text')
  })

  it('rejects a batch with a missing file before copying any valid files', async () => {
    const { root, project } = await fixture()
    await expect(importAiAttachmentSources(project, [{ name: 'valid.txt', bytes: new Uint8Array([1]) }, { path: path.join(root, 'missing') }])).rejects.toThrow()
    expect(await fs.readdir(project)).toEqual([])
  })

  it('rejects attachment directory recursion, including a directory alias', async () => {
    const { root, project } = await fixture()
    const directory = path.join(project, '.modmind', 'attachments')
    await fs.mkdir(directory, { recursive: true })
    const alias = path.join(root, 'alias')
    await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
    for (const source of [project, directory, alias]) {
      await expect(importAiAttachmentSources(project, [{ path: source }])).rejects.toThrow('不能上传')
    }
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('enforces count and clipboard size limits while allowing empty files', async () => {
    const { project } = await fixture()
    await expect(importAiAttachmentSources(project, Array.from({ length: 9 }, () => ({ name: 'a.txt', bytes: new Uint8Array() })))).rejects.toThrow('8')
    await expect(importAiAttachmentSources(project, [{ name: 'huge.png', bytes: new Uint8Array(MAX_INLINE_ATTACHMENT_BYTES + 1) }])).rejects.toThrow('32 MB')
    const [empty] = await importAiAttachmentSources(project, [{ name: 'empty.txt', bytes: new Uint8Array() }])
    expect((await fs.stat(path.join(project, empty.path))).size).toBe(0)
  })
})
