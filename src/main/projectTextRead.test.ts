import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProjectDirectory, readProjectTextFile } from './projectTextRead'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
const links: string[] = []
afterEach(async () => {
  // Remove Windows junctions explicitly before recursively removing test roots.
  await Promise.all(links.splice(0).map(link => fs.unlink(link)))
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('readProjectTextFile', () => {
  it.each(['.modmind', 'custom/tool-data'])('browses nested folder attachments with pagination in %s', async toolDataDirectory => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-folder-read-')); roots.push(root)
    const folder = `${toolDataDirectory}/attachments/1234-代码 文件夹`
    await fs.mkdir(path.join(root, folder, 'nested'), { recursive: true })
    await fs.mkdir(path.join(root, folder, 'empty'), { recursive: true })
    await fs.writeFile(path.join(root, folder, 'WaxEvents.java'), '// 涂蜡事件\nclass WaxEvents {}', 'utf8')
    await fs.writeFile(path.join(root, folder, 'nested', 'Effect.java'), 'class Effect {}', 'utf8')
    const project = { path: root, toolDataDirectory } as ProjectInfo
    const first = await listProjectDirectory(project, folder.replaceAll('/', '\\'), 0, 2)
    expect(first).toMatchObject({ path: folder, totalEntries: 3, truncated: true, nextOffset: 2,
      entries: [{ path: `${folder}/empty`, type: 'directory' }, { path: `${folder}/nested`, type: 'directory' }] })
    const second = await listProjectDirectory(project, folder, first.nextOffset, 2)
    expect(second).toMatchObject({ truncated: false, entries: [{ path: `${folder}/WaxEvents.java`, type: 'file' }] })
    expect(second).not.toHaveProperty('nextOffset')
    await expect(readProjectTextFile(project, second.entries[0].path)).resolves.toMatchObject({ content: '// 涂蜡事件\nclass WaxEvents {}' })
    const nested = await listProjectDirectory(project, first.entries[1].path)
    await expect(readProjectTextFile(project, nested.entries[0].path)).resolves.toMatchObject({ content: 'class Effect {}' })
    await expect(listProjectDirectory(project, first.entries[0].path)).resolves.toMatchObject({ entries: [], truncated: false })
    await expect(readProjectTextFile(project, folder)).rejects.toThrow('modmind_list_project_directory')
    await expect(listProjectDirectory(project, second.entries[0].path)).rejects.toThrow('modmind_read_project_file')
  })

  it('keeps directory browsing inside the read scope, including through junctions', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-folder-scope-')); roots.push(parent)
    const root = path.join(parent, 'project')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(path.join(root, '.modmind', 'attachments', 'folder'), { recursive: true })
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'private.txt'), 'private')
    const link = path.join(root, '.modmind', 'attachments', 'folder', 'link')
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(link)
    const project = { path: root } as ProjectInfo
    await expect(listProjectDirectory(project, '.')).resolves.toMatchObject({ entries: [], skippedEntries: 2 })
    await expect(listProjectDirectory(project, '.modmind/attachments/folder')).resolves.toMatchObject({ entries: [], skippedEntries: 1 })
    await expect(listProjectDirectory(project, '.modmind/attachments/folder/link')).rejects.toThrow('allowed project scope')
    await expect(readProjectTextFile(project, '.modmind/attachments/folder/link/private.txt')).rejects.toThrow('allowed project scope')
    for (const requested of ['../outside', '.git', '.modmind', '.modmind/attachments/../external-agents']) {
      await expect(listProjectDirectory(project, requested)).rejects.toThrow('inside the project')
    }
    for (const requested of [root, 'C:\\outside', '\\\\server\\share', 'bad\0path', 'file:stream']) {
      await expect(listProjectDirectory(project, requested)).rejects.toThrow('project-relative')
    }
    await expect(listProjectDirectory(project, '.', -1)).rejects.toThrow('offset')
    await expect(listProjectDirectory(project, '.', 0, 501)).rejects.toThrow('limit')
  })

  it('reads paged source text and attachments while excluding unrelated tool data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-text-read-')); roots.push(root)
    await fs.mkdir(path.join(root, '.modmind', 'attachments'), { recursive: true })
    await fs.mkdir(path.join(root, '.modmind', 'logs'), { recursive: true })
    await fs.writeFile(path.join(root, 'WaxEvents.java'), 'one\ntwo\nthree\n', 'utf8')
    await fs.writeFile(path.join(root, '.modmind', 'attachments', 'upload.java'), 'class Upload {}\n', 'utf8')
    const project = { name: 'Read', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'read', createdAt: '' } as ProjectInfo
    await expect(readProjectTextFile(project, '.modmind/attachments/upload.java')).resolves.toMatchObject({ content: 'class Upload {}\n', totalLines: 2 })
    await expect(readProjectTextFile(project, 'WaxEvents.java', 2, 1)).resolves.toMatchObject({ content: 'two', startLine: 2, endLine: 2, truncated: true, nextStartLine: 3 })
    await expect(readProjectTextFile(project, '.modmind/logs/nope.txt')).rejects.toThrow('inside the project')
  })

  it('rejects traversal, binary content, and oversized files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-text-read-')); roots.push(root)
    await fs.mkdir(path.join(root, '.modmind', 'attachments'), { recursive: true })
    await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 1, 2]))
    await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
    const project = { name: 'Read', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'read', createdAt: '' } as ProjectInfo
    await expect(readProjectTextFile(project, '../outside.txt')).rejects.toThrow('inside the project')
    await expect(readProjectTextFile(project, 'binary.txt')).rejects.toThrow('UTF-8 text')
    await expect(readProjectTextFile(project, 'large.txt')).rejects.toThrow('1 MiB')
  })
})
