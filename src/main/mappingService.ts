import path from 'node:path'
import type {
  MappingClassDetail,
  MappingClassResult,
  MappingMember,
  MappingSearchResult
} from '../shared/mappings'
import { fetchTextWithRetry } from './networkRequest'
import { readValidatedTextCache } from './validatedTextCache'

const SOURCE_ROOT = 'https://mappings.dev'

interface MappingIndex {
  namespaces: string[]
  classes: MappingClassResult[]
}

function validateVersion(version: string): string {
  const value = version.trim()
  if (!/^[0-9A-Za-z._-]{1,40}$/.test(value)) throw new Error('无效的 Minecraft Mappings 版本')
  return value
}

function validateQuery(query: string, label = '查询词'): string {
  const value = query.trim()
  if (!value || value.length > 200) throw new Error(`${label}长度必须为 1-200 个字符`)
  return value
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
}

function htmlText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function normalizeClassName(value: string): string {
  return value.trim().replaceAll('.', '/').replace(/^\/+/, '').replace(/\.html$/i, '')
}

function parseIndexScript(version: string, script: string): MappingIndex {
  const start = script.indexOf('`')
  const end = script.lastIndexOf('`')
  if (start < 0 || end <= start) throw new Error(`Mappings ${version} 类索引格式无效`)
  const lines = script
    .slice(start + 1, end)
    .replaceAll('%nm', 'net/minecraft')
    .replaceAll('%cm', 'com/mojang')
    .split(/\r?\n/)
    .filter(Boolean)
  const header = lines.shift()
  if (!header) throw new Error(`Mappings ${version} 类索引为空`)
  const namespaces = header.split('\t').map((column) => column.split(':', 1)[0])
  const classes = lines.map((line): MappingClassResult => {
    const values = line.split('\t')
    const names: Record<string, string> = {}
    for (const [index, namespace] of namespaces.entries()) {
      if (values[index]) names[namespace] = values[index]
    }
    const pagePath = Object.values(names)[0]
    return { version, pagePath, names }
  }).filter((entry) => Boolean(entry.pagePath) && /^[A-Za-z0-9_$\/-]+$/.test(entry.pagePath) && !entry.pagePath.includes('..'))
  if (!classes.length) throw new Error(`Mappings ${version} 类索引未包含类`)
  return { namespaces, classes }
}

function mappingCells(value: string): Array<{ style: string; text: string }> {
  const cells: Array<{ style: string; text: string }> = []
  const pattern = /<tr><td class="D ([^"]+)"><\/td><td class="F">([\s\S]*?)<\/td><\/tr>/g
  for (const match of value.matchAll(pattern)) cells.push({ style: match[1].trim(), text: htmlText(match[2]) })
  return cells
}

function parseClassPage(
  result: MappingClassResult,
  html: string,
  sourceUrl: string,
  cached: boolean,
  memberQuery?: string
): MappingClassDetail {
  const titleMatch = html.match(/<div class="A"><p>([\s\S]*?)<\/p>/)
  const declaration = titleMatch ? htmlText(titleMatch[1]) : Object.values(result.names)[0]
  const classTable = html.match(/<p class="C"><\/p><table><tbody>([\s\S]*?)<\/tbody><\/table><p class="L"><\/p>/)
  const namespaceByStyle = new Map<string, string>()
  for (const cell of mappingCells(classTable?.[1] ?? '')) {
    const normalized = normalizeClassName(cell.text)
    const namespace = Object.entries(result.names).find(([, name]) => normalizeClassName(name) === normalized)?.[0]
    if (namespace) namespaceByStyle.set(cell.style, namespace)
  }

  const members: MappingMember[] = []
  const sectionPattern = /<h4>(Field|Constructor|Method) summary<\/h4>([\s\S]*?)(?=<p class="P"><\/p>|<\/main>)/g
  for (const section of html.matchAll(sectionPattern)) {
    const kind = section[1].toLowerCase() as MappingMember['kind']
    if (kind === 'constructor') {
      const constructorPattern = /<tr><td class="O">([\s\S]*?)<\/td><td class="Q">([\s\S]*?)<\/td><\/tr>/g
      for (const row of section[2].matchAll(constructorPattern)) {
        members.push({ kind, type: htmlText(row[1]), names: { Mojang: htmlText(row[2]) } })
      }
      continue
    }
    const rowPattern = /<tr><td class="O">([\s\S]*?)<\/td><td><table><tbody>([\s\S]*?)<\/tbody><\/table><\/td><\/tr>/g
    for (const row of section[2].matchAll(rowPattern)) {
      const names: Record<string, string> = {}
      for (const cell of mappingCells(row[2])) {
        const namespace = namespaceByStyle.get(cell.style)
        if (namespace) names[namespace] = cell.text
      }
      if (Object.keys(names).length) members.push({ kind, type: htmlText(row[1]), names })
    }
  }

  const query = memberQuery?.trim().toLowerCase()
  const filteredMembers = query
    ? members.filter((member) => `${member.type} ${Object.values(member.names).join(' ')}`.toLowerCase().includes(query))
    : members
  return { ...result, sourceUrl, declaration, cached, members: filteredMembers.slice(0, 250) }
}

export class MappingService {
  private readonly indexes = new Map<string, MappingIndex>()

  constructor(private readonly cacheRoot: string, private readonly productVersion = 'development') {}

  private cachePath(version: string, name: string): string {
    return path.join(this.cacheRoot, version, name)
  }

  private async readOrDownload(version: string, name: string, url: string, validate: (content: string) => void): Promise<{ content: string; cached: boolean }> {
    const target = this.cachePath(version, name)
    return readValidatedTextCache(target, async () => {
      try {
        return await fetchTextWithRetry(url, { headers: { 'User-Agent': `ModMind/${this.productVersion} (mappings)` } })
      } catch (error) {
        throw new Error(`无法连接 mappings.dev：${error instanceof Error ? error.message : String(error)}`)
      }
    }, validate)
  }

  private async getIndex(versionInput: string): Promise<{ index: MappingIndex; cached: boolean }> {
    const version = validateVersion(versionInput)
    const memory = this.indexes.get(version)
    if (memory) return { index: memory, cached: true }
    const loaded = await this.readOrDownload(version, 'class-index.js', `${SOURCE_ROOT}/${version}/class-index.js`, content => { parseIndexScript(version, content) })
    const index = parseIndexScript(version, loaded.content)
    this.indexes.set(version, index)
    return { index, cached: loaded.cached }
  }

  async search(versionInput: string, queryInput: string, limitInput = 30): Promise<MappingSearchResult> {
    const version = validateVersion(versionInput)
    const query = validateQuery(queryInput)
    const limit = Math.max(1, Math.min(50, Math.trunc(limitInput) || 30))
    const { index, cached } = await this.getIndex(version)
    const normalizedQuery = normalizeClassName(query).toLowerCase()
    const hasPackage = normalizedQuery.includes('/')
    const ranked = index.classes.flatMap((entry) => {
      let best = Number.POSITIVE_INFINITY
      for (const name of Object.values(entry.names)) {
        const normalized = normalizeClassName(name).toLowerCase()
        const simple = normalized.slice(normalized.lastIndexOf('/') + 1)
        const target = hasPackage ? normalized : simple
        const position = target.indexOf(normalizedQuery)
        if (position < 0) continue
        const score = (position === 0 ? 0 : 10_000 + position) + target.length - normalizedQuery.length
        best = Math.min(best, score)
      }
      return Number.isFinite(best) ? [{ entry, score: best }] : []
    })
    ranked.sort((left, right) => left.score - right.score)
    return {
      version,
      query,
      source: `${SOURCE_ROOT}/${version}/index.html`,
      cached,
      results: ranked.slice(0, limit).map(({ entry }) => entry)
    }
  }

  async getClass(versionInput: string, classNameInput: string, memberQuery?: string): Promise<MappingClassDetail> {
    const version = validateVersion(versionInput)
    const className = validateQuery(classNameInput, '类名')
    if (memberQuery && memberQuery.length > 200) throw new Error('成员查询词不能超过 200 个字符')
    const { index } = await this.getIndex(version)
    const normalized = normalizeClassName(className).toLowerCase()
    const result = index.classes.find((entry) =>
      Object.values(entry.names).some((name) => normalizeClassName(name).toLowerCase() === normalized)
    )
    if (!result) throw new Error(`Minecraft ${version} 中未找到类：${className}`)
    const pageName = `${result.pagePath}.html`
    const sourceUrl = `${SOURCE_ROOT}/${version}/${pageName}`
    const loaded = await this.readOrDownload(version, path.join('pages', pageName), sourceUrl, content => {
      if (!/<div class="A"><p>[\s\S]+?<\/p>/.test(content) || !/<\/main>/.test(content)) throw new Error(`Mappings ${version} 类详情格式无效`)
    })
    return parseClassPage(result, loaded.content, sourceUrl, loaded.cached, memberQuery)
  }
}
