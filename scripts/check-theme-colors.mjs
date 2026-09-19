import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import ts from 'typescript'

const root = 'src/renderer/src'
const literals = /#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black|red|blue|green|yellow|orange|gray|grey)\b/i
const failures = []
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { walk(file); continue }
    if (file.endsWith('.tsx')) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = node => {
        if (ts.isJsxAttribute(node) && ['style','color','fill','stroke'].includes(node.name.getText(source))) {
          const scan = child => {
            if (ts.isStringLiteral(child) && /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i.test(child.text)) failures.push(`${file}:${source.getLineAndCharacterOfPosition(child.getStart()).line + 1} JSX color must reference a theme token`)
            ts.forEachChild(child, scan)
          }
          ts.forEachChild(node, scan)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    if (!file.endsWith('.css') || entry.name === 'theme-tokens.css') continue
    postcss.parse(fs.readFileSync(file, 'utf8'), { from: file }).walkDecls(declaration => {
      if (['scrollbar-width', 'scrollbar-color'].includes(declaration.prop) || declaration.parent?.selector?.includes('::-webkit-scrollbar')) failures.push(`${file}:${declaration.source.start.line} Scrollbar appearance belongs in src/shared/scrollbars.ts`)
      // Mask colors encode alpha coverage, not visible application colors.
      if (/^(?:-webkit-)?mask(?:-image)?$/.test(declaration.prop)) return
      if (declaration.value.includes('url(')) return
      if (literals.test(declaration.value)) failures.push(`${file}:${declaration.source.start.line} ${declaration.prop}: ${declaration.value}`)
      if (declaration.prop.startsWith('--theme-')) failures.push(`${file}: Theme colors may only be defined by the generated token file`)
    })
  }
}
walk(root)
// UI adapters must consume the shared palette too. Asset renderers have content
// colors (Minecraft formatting, pixels, meshes), so they are not blanket-scanned.
for (const file of ['src/renderer/src/monaco.ts', 'src/renderer/src/components/PluginFrame.tsx', 'resources/renderer-public/minipaint/modmind-bridge.js']) {
  if (/#[\da-f]{3,8}\b|rgba?\(/i.test(fs.readFileSync(file, 'utf8'))) failures.push(`${file}: adapter contains a literal color`)
}
if (failures.length) throw new Error(`Use semantic theme variables instead of local colors:\n${failures.join('\n')}`)
console.log('PASS: all renderer CSS and UI theme adapters use centralized colors.')
