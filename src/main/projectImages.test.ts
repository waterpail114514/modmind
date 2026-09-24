import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readProjectImage } from './projectImages'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
describe('project reply images', () => {
  it('loads generated files, screenshots, Unicode paths and absolute project paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-images-')); roots.push(root)
    const relative = '.modmind/image-studio/generated/效果 图.png'
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await fs.writeFile(path.join(root, relative), Buffer.from('image'))
    for (const reference of [relative, encodeURI(relative), path.join(root, relative), `modmind-image:?path=${encodeURIComponent(relative)}`]) {
      expect(await readProjectImage(root, reference)).toBe('data:image/png;base64,aW1hZ2U=')
    }
  })
  it('rejects remote images, traversal, oversized files and junctions outside the project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-images-')); roots.push(root)
    const project = path.join(root, 'project'); const outside = path.join(root, 'outside')
    await fs.mkdir(project); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.png'), 'secret')
    await fs.symlink(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const reference of ['https://example.com/a.png', 'data:image/png;base64,AAAA', '../outside/secret.png', '%2e%2e/outside/secret.png', path.join(outside, 'secret.png'), 'linked/secret.png', 'file:///etc/a.png', 'test.svg']) {
      await expect(readProjectImage(project, reference)).rejects.toThrow()
    }
    const file = await fs.open(path.join(project, 'large.png'), 'w')
    await file.truncate(20 * 1024 * 1024 + 1); await file.close()
    await expect(readProjectImage(project, 'large.png')).rejects.toThrow('20 MB')
  })
})
