export interface InspirationEvidenceRequest {
  path: string
  line: number
  file?: string
  kind?: 'source' | 'resource'
}
export interface InspirationEvidence {
  source: string
  file?: string
  sha256?: string
  lines: Array<{ line: number; text: string }>
  totalLines: number
  nextStartLine?: number
}

export function parseInspirationEvidenceLink(href: string): InspirationEvidenceRequest {
  const url = new URL(href)
  if (url.protocol !== 'modmind-source:') throw new Error('来源链接无效')
  const source = url.searchParams.get('path') ?? ''
  const line = Number(url.searchParams.get('line') ?? 1)
  if (!source || !Number.isSafeInteger(line) || line < 1) throw new Error('来源路径或行号无效')
  const file = url.searchParams.get('file') ?? undefined
  return { path: source, line, ...(file ? { file, kind: url.searchParams.get('kind') === 'resource' ? 'resource' : 'source' } : {}) }
}
