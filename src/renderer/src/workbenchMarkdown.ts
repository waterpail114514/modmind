import { marked, Marked } from 'marked'
import { projectImageReference } from '../../shared/projectImages'
import { projectModelReference } from '../../shared/projectModels'

const renderer = new marked.Renderer()
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
renderer.html = ({ text }) => escapeHtml(text)
renderer.link = function ({ href, tokens, text }) {
  const label = this.parser.parseInline(tokens)
  if (/data-reply-(image|model)=/.test(label)) return label
  const model = projectModelReference(href)
  if (model) return `<span class="reply-model-slot" data-reply-model="${escapeHtml(model)}" data-image-caption="${escapeHtml(text)}"></span>`
  return /^https?:\/\//i.test(href)
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label
}
renderer.image = ({ href, text }) => {
  const model = projectModelReference(href)
  if (model) return `<span class="reply-model-slot" data-reply-model="${escapeHtml(model)}" data-image-caption="${escapeHtml(text)}"></span>`
  const reference = projectImageReference(href)
  return reference
    ? `<span class="reply-image-slot" data-reply-image="${escapeHtml(reference)}" data-image-caption="${escapeHtml(text)}"></span>`
    : `<span class="reply-image-unavailable">${escapeHtml(text || '图片')}（仅支持项目内图片）</span>`
}
const renderText = renderer.text
renderer.text = function (token) {
  if ('tokens' in token && token.tokens) return renderText.call(this, token)
  // Some model replies spell zero-width Unicode escapes literally in prose.
  // Hide them in text only; code spans, code blocks and stored source stay raw.
  return renderText.call(this, { ...token, text: token.text.replace(/\\u(?:200[bcd]|feff)/gi, '') })
}

const sourceRenderer = new marked.Renderer()
Object.assign(sourceRenderer, renderer)
sourceRenderer.link = function (token) {
  if (token.href.startsWith('modmind-source:')) return `<button type="button" class="inspiration-source-link" data-source="${escapeHtml(token.href)}">${this.parser.parseInline(token.tokens)}</button>`
  return renderer.link.call(this, token)
}

const replyMarkdown = new Marked({
  tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      if (!src.startsWith('**') || src.startsWith('***')) return false
      const cjkPrefix = !!prevChar && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(prevChar)
      // Markdown considers both `中文**重点**正文` and `**重点。**正文`
      // ambiguous word boundaries. Relax those boundaries for CJK prose while
      // preserving Marked's handling of code, escapes and link destinations.
      const cjkMasked = maskedSrc.replace(/(?![*_\\])\p{P}(?=\*\*(?!\*)[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, punctuation => 'a'.repeat(punctuation.length))
      if (!cjkPrefix && cjkMasked === maskedSrc) return false
      return marked.Tokenizer.prototype.emStrong.call(this, src, cjkMasked, cjkPrefix ? ' ' : prevChar)
    }
  }
})

export function renderWorkbenchMarkdown(content: string, sources = false): string {
  return replyMarkdown.parse(content, { async: false, gfm: true, breaks: true, renderer: sources ? sourceRenderer : renderer })
}
