import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readProjectDocument } from './documentRead'
import { readProjectTextFile } from './projectTextRead'
import type { ProjectInfo } from '../shared/types'

const fixtures = fileURLToPath(new URL('./__fixtures__/documents/', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-documents-')); roots.push(root)
  await fs.mkdir(path.join(root, '.modmind', 'attachments', '讲义'), { recursive: true })
  await fs.cp(fixtures, path.join(root, '.modmind', 'attachments', '讲义'), { recursive: true })
  return { path: root } as ProjectInfo
}
const attachment = (name: string) => `.modmind/attachments/讲义/${name}`

describe('document reading', () => {
  it('extracts DOCX Chinese paragraphs and table cells with lossless chunk continuation', async () => {
    const p = await project()
    const first = await readProjectDocument(p, attachment('paragraphs-table.docx'), 1, 0, 6)
    expect(first).toMatchObject({ format: 'docx', content: '阅读答案 &', truncated: true, next: { page: 1, offset: 6 } })
    const rest = await readProjectDocument(p, first.path, first.next!.page, first.next!.offset)
    expect(first.content + rest.content).toBe('阅读答案 & 讲义\n第一段：测试中文。\n第二行。\n问题\t答案\n1\tA')
    expect(rest.truncated).toBe(false)
    await expect(readProjectTextFile(p, first.path)).rejects.toThrow('modmind_read_document')
  })

  it('extracts Chinese PDF pages, flags blank/scanned pages, and continues to the next page', async () => {
    const p = await project()
    const name = attachment('text-and-empty.pdf')
    // A normal document over the old plain-text limit must still be readable.
    await fs.appendFile(path.join(p.path, name), '\n%' + ' '.repeat(1024 * 1024))
    const first = await readProjectDocument(p, name, 1, 0, 5)
    const rest = await readProjectDocument(p, name, first.next!.page, first.next!.offset)
    expect(first.content + rest.content).toContain('高三阅读专题指导讲义')
    expect(first.content + rest.content).toContain('第一题答案：理解文章主题。')
    expect(rest).toMatchObject({ totalPages: 3, next: { page: 2, offset: 0 } })
    const blank = await readProjectDocument(p, name, 2)
    expect(blank).toMatchObject({ content: '', status: 'no-extractable-text', next: { page: 3, offset: 0 } })
    expect(blank.warnings.join(' ')).toContain('OCR')
    const last = await readProjectDocument(p, name, 3)
    expect(last).toMatchObject({ content: 'Third page: answer B.', truncated: false })
    await expect(readProjectDocument(p, name, 4)).rejects.toThrow('只有 3 页')
  })

  it('reports encryption, invalid documents, size limits and path boundaries', async () => {
    const p = await project()
    await expect(readProjectDocument(p, attachment('encrypted.pdf'))).rejects.toThrow('已加密')
    await fs.writeFile(path.join(p.path, 'broken.docx'), 'not a document')
    await fs.writeFile(path.join(p.path, 'broken.pdf'), 'not a document')
    await expect(readProjectDocument(p, 'broken.docx')).rejects.toThrow('无法打开 DOCX')
    await expect(readProjectDocument(p, 'broken.pdf')).rejects.toThrow('PDF 文字提取失败')
    await fs.writeFile(path.join(p.path, 'large.pdf'), '')
    await fs.truncate(path.join(p.path, 'large.pdf'), 50 * 1024 * 1024 + 1)
    await expect(readProjectDocument(p, 'large.pdf')).rejects.toThrow('50 MiB')
    await expect(readProjectDocument(p, '../outside.docx')).rejects.toThrow('inside the project')
    await expect(readProjectDocument(p, '.modmind/private.pdf')).rejects.toThrow('internal tool data')
    await expect(readProjectDocument(p, attachment('paragraphs-table.docx'), 2)).rejects.toThrow('page=1')
    await expect(readProjectDocument(p, attachment('paragraphs-table.docx'), 1, 99999)).rejects.toThrow('offset')
  })
})
