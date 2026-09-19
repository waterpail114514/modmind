import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import yauzl from 'yauzl'
import { load } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { ProjectInfo } from '../shared/types'
import { resolveReadablePath } from './projectTextRead'

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024
const localRequire = createRequire(import.meta.url)

async function readDocumentBytes(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('文档路径必须是文件；文件夹请使用 modmind_list_project_directory')
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('文档超过 50 MiB，请拆分后上传')
    const chunks: Buffer[] = []
    let length = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_DOCUMENT_BYTES + 1 - length))
      const { bytesRead } = await handle.read(chunk)
      if (!bytesRead) break
      length += bytesRead
      if (length > MAX_DOCUMENT_BYTES) throw new Error('文档超过 50 MiB，请拆分后上传')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks)
  } finally { await handle.close() }
}

async function docxText(bytes: Buffer): Promise<string> {
  const xml = await new Promise<string>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('无法打开 DOCX：文件损坏、已加密或并非 DOCX')); return }
      const fail = (error: Error): void => { zip.close(); reject(error) }
      let entries = 0
      zip.on('error', fail)
      zip.on('end', () => reject(new Error('DOCX 缺少 word/document.xml 正文')))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (++entries > 10000) { fail(new Error('DOCX 内部文件过多')); return }
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return }
        if (entry.uncompressedSize > MAX_DOCX_XML_BYTES) { fail(new Error('DOCX 正文解压后超过 8 MiB')); return }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(error ?? new Error('无法读取 DOCX 正文')); return }
          const chunks: Buffer[] = []; let length = 0
          stream.on('error', fail)
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > MAX_DOCX_XML_BYTES) { stream.destroy(new Error('DOCX 正文解压后超过 8 MiB')); return }
            chunks.push(chunk)
          })
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')) })
        })
      })
      zip.readEntry()
    })
  })
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 正文包含不支持的 XML 实体声明')
  const $ = load(xml, { xmlMode: true })
  const body = $('w\\:body').first()
  if (!body.length) throw new Error('DOCX 正文结构无效')
  const render = (node: AnyNode): string => {
    if (!('name' in node) || !('children' in node)) return ''
    if (node.name === 'w:t') return $(node).text()
    if (node.name === 'w:tab') return '\t'
    if (node.name === 'w:br' || node.name === 'w:cr') return '\n'
    if (node.name === 'w:del' || node.name === 'w:instrText') return ''
    const text = node.children.map(render).join('')
    if (node.name === 'w:tc') return `${text.trim()}\t`
    if (node.name === 'w:tr') return `${text.trimEnd()}\n`
    return text + (node.name === 'w:p' ? '\n' : '')
  }
  return body.toArray().map(render).join('').trim()
}

/** Extract document text locally; never runs document scripts, shell commands or OCR. */
export async function readProjectDocument(project: ProjectInfo, requestedPath: unknown, page: unknown = 1, offset: unknown = 0, maxChars: unknown = 20000) {
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1
    || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof maxChars !== 'number' || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 20000) {
    throw new Error('page 必须为正整数，offset 必须为非负整数，maxChars 必须为 1–20000')
  }
  const { root, target, realTarget } = await resolveReadablePath(project, requestedPath)
  const format = path.extname(target).slice(1).toLowerCase()
  if (format !== 'docx' && format !== 'pdf') throw new Error('仅支持 DOCX 和 PDF；文本文件请使用 modmind_read_project_file')
  const bytes = await readDocumentBytes(realTarget)
  let text = ''; let totalPages = 1
  if (format === 'docx') {
    if (page !== 1) throw new Error('DOCX 没有可靠的物理页码，请使用 page=1 和 offset 分段读取')
    text = await docxText(bytes)
  } else {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdfRoot = path.dirname(localRequire.resolve('pdfjs-dist/package.json'))
    const task = getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, useWorkerFetch: false,
      cMapUrl: path.join(pdfRoot, 'cmaps') + path.sep, cMapPacked: true,
      standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + path.sep,
      verbosity: 0
    })
    try {
      const pdf = await task.promise
      totalPages = pdf.numPages
      if (page > totalPages) throw new Error(`PDF 只有 ${totalPages} 页`)
      const pdfPage = await pdf.getPage(page)
      const content = await pdfPage.getTextContent()
      text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
      pdfPage.cleanup()
    } catch (error) {
      if (error instanceof Error && error.name === 'PasswordException') throw new Error('PDF 已加密，请上传解密后的副本')
      throw new Error(`PDF 文字提取失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { await task.destroy() }
  }
  if (offset > text.length) throw new Error(`offset 超出当前正文长度 ${text.length}`)
  let end = Math.min(offset + maxChars, text.length)
  // Do not split a UTF-16 surrogate pair across chunks.
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  if (end === offset && end < text.length) end = Math.min(offset + 2, text.length)
  const next = end < text.length ? { page, offset: end } : page < totalPages ? { page: page + 1, offset: 0 } : undefined
  return {
    path: path.relative(root, target).replaceAll('\\', '/'), format, page,
    ...(format === 'pdf' ? { totalPages } : {}),
    content: text.slice(offset, end), offset, totalCharacters: text.length,
    truncated: Boolean(next), ...(next ? { next } : {}),
    status: text ? 'text' : 'no-extractable-text',
    warnings: [format === 'pdf'
      ? '仅提取当前页文字；双栏、表格阅读顺序可能不完整，图片未识别。'
      : '仅提取 DOCX 正文段落与表格（单元格以制表符分隔）；页眉页脚、脚注和图片未提取。',
    ...(!text ? [format === 'pdf' ? '当前页没有可提取文字，可能是扫描页或空白页；扫描内容需要 OCR，当前工具未执行 OCR。' : '没有可提取的正文文字；图片中的文字需要 OCR。'] : [])]
  }
}
