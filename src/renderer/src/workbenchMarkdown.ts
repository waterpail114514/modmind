import { marked } from 'marked'

const renderer = new marked.Renderer()
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
renderer.html = ({ text }) => escapeHtml(text)
renderer.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens)
  return /^https?:\/\//i.test(href)
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label
}

export function renderWorkbenchMarkdown(content: string): string {
  return marked.parse(content, { async: false, gfm: true, breaks: true, renderer })
}
