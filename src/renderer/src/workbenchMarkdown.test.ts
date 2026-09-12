import { describe, expect, it } from 'vitest'
import { renderWorkbenchMarkdown } from './workbenchMarkdown'

describe('workbench Markdown', () => {
  it('preserves inline formatting and escapes link attributes', () => {
    const html = renderWorkbenchMarkdown('[**文档** & `代码`](https://example.com/?a=1&b=2)')
    expect(html).toContain('<strong>文档</strong> &amp; <code>代码</code>')
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
  it('keeps unsafe links inert and raw HTML escaped, including within link labels', () => {
    const html = renderWorkbenchMarkdown('[**打开**](javascript:alert%281%29)\n\n[<img src=x onerror=alert(1)>](https://example.com)\n\n<script>alert(1)</script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<strong>打开</strong>')
    expect(html).toContain('&lt;img')
  })
})
