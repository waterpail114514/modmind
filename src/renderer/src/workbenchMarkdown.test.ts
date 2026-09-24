import { describe, expect, it } from 'vitest'
import { renderWorkbenchMarkdown } from './workbenchMarkdown'

describe('workbench Markdown', () => {
  it('embeds explicit model references and bbmodel links without treating arbitrary JSON as models', () => {
    expect(renderWorkbenchMarkdown('[模型](modmind-model:?path=models%2Fstaff.bbmodel)')).toContain('data-reply-model="models/staff.bbmodel"')
    expect(renderWorkbenchMarkdown('[模型](<models/森林 法杖.bbmodel>)')).toContain('data-reply-model="models/森林 法杖.bbmodel"')
    expect(renderWorkbenchMarkdown('[模型](modmind-model:?path=assets%2Fdemo%2Fmodels%2Fstaff.json)')).toContain('data-reply-model=')
    expect(renderWorkbenchMarkdown('[配置](package.json)')).not.toContain('data-reply-model=')
    expect(renderWorkbenchMarkdown('[远程](https://example.com/a.bbmodel)')).not.toContain('data-reply-model=')
  })
  it('renders local image slots safely and preserves source citations in inspiration', () => {
    const html = renderWorkbenchMarkdown('![效果图](<.modmind/image-studio/generated/效果 图.png>)\n\n![远程](https://example.com/a.png)\n\n![注入](<bad%22%20onerror=%22x.png>)\n\n[来源](modmind-source:?path=src/Main.java&line=2)', true)
    expect(html).toContain('data-reply-image=".modmind/image-studio/generated/效果 图.png"')
    expect(html).toContain('bad&quot; onerror=&quot;x.png')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src="https:')
    expect(html).toContain('data-source="modmind-source:?path=src/Main.java&amp;line=2"')
    expect(renderWorkbenchMarkdown('[![图](image.png)](https://example.com)')).not.toContain('<a ')
  })
  it('preserves inline formatting and escapes link attributes', () => {
    const html = renderWorkbenchMarkdown('[**文档** & `代码`](https://example.com/?a=1&b=2)')
    expect(html).toContain('<strong>文档</strong> &amp; <code>代码</code>')
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
  it('renders emphasis before CJK text instead of exposing asterisks', () => {
    const html = renderWorkbenchMarkdown('你说得对。 **如果按《周易》经传所述的筮法来设计，蓍草比铜钱更贴切。**我之前把铜钱定为算卦材料。`**代码里的星号**` 应保持原样。')
    expect(html).toContain('<strong>如果按《周易》经传所述的筮法来设计，蓍草比铜钱更贴切。</strong>我')
    expect(html).toContain('<code>**代码里的星号**</code>')
    expect(renderWorkbenchMarkdown('**包含 *斜体* 和 `代码`。**继续')).toContain('<strong>包含 <em>斜体</em> 和 <code>代码</code>。</strong>继续')
    expect(renderWorkbenchMarkdown('**“中文标点”**继续')).toContain('<strong>“中文标点”</strong>继续')
    expect(renderWorkbenchMarkdown('这是**重点**内容')).toContain('这是<strong>重点</strong>内容')
  })
  it('preserves literal asterisks, code, incomplete replies and English delimiter rules', () => {
    expect(renderWorkbenchMarkdown('`**原样。**后文`')).toContain('<code>**原样。**后文</code>')
    expect(renderWorkbenchMarkdown('~~~text\n**原样。**后文\n~~~')).toContain('**原样。**后文')
    expect(renderWorkbenchMarkdown('\\*\\*原样。\\*\\*后文')).not.toContain('<strong>')
    expect(renderWorkbenchMarkdown('**尚未输出完成。')).toContain('**尚未输出完成。')
    expect(renderWorkbenchMarkdown('**word.**next')).not.toContain('<strong>')
    expect(renderWorkbenchMarkdown('[链接](https://example.com/**原样。**后文)')).toContain('href="https://example.com/**原样。**后文"')
  })
  it('hides spelled-out zero-width escapes in prose while preserving code', () => {
    const html = renderWorkbenchMarkdown('9. \\u200b坤\\u200b：降低冷却\n10. \\u200b震\\u200b：提高移速\n\n`\\u200b`\n\n```text\n\\u200b\n```')
    expect(html).toContain('<li>坤：降低冷却</li>')
    expect(html).toContain('<li>震：提高移速</li>')
    expect(html).toContain('<code>\\u200b</code>')
    expect(html).toContain('<pre><code class="language-text">\\u200b')
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
