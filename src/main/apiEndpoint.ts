/** Append an API route to the pathname, preserving provider query parameters. */
export function apiEndpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('AI 地址必须使用不含账号密码的 HTTP 或 HTTPS URL')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  url.hash = ''
  return url.toString()
}
