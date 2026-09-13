export function editorLanguage(relativePath: string): string {
  const extension = relativePath.split('.').at(-1)?.toLowerCase() ?? ''
  return {
    java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'groovy', groovy: 'groovy',
    json: 'json', json5: 'json', mcmeta: 'json', md: 'markdown', html: 'html', htm: 'html',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', css: 'css', scss: 'scss', properties: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    lang: 'plaintext', mcfunction: 'plaintext', snbt: 'plaintext', toml: 'plaintext', zs: 'plaintext'
  }[extension] ?? 'plaintext'
}
