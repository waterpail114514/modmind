import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(fs.readFileSync('src/shared/appTheme.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const context = { exports: {} }
vm.runInNewContext(code, context)
const { themePresets, themeCssVariables } = context.exports
let css = '/* Generated from src/shared/appTheme.ts. Run npm run theme:generate. */\n'
for (const { id } of themePresets) for (const mode of ['light', 'dark']) {
  const selector = id === 'neutral' && mode === 'light' ? ':root' : `:root[data-theme-preset="${id}"][data-theme-mode="${mode}"]`
  css += `${selector} {\n${Object.entries(themeCssVariables(id, mode)).map(([key, value]) => `  ${key}: ${value};`).join('\n')}\n  color-scheme: ${mode};\n}\n`
}
const target = 'src/renderer/src/theme-tokens.css'
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== css) throw new Error('Theme tokens are stale. Run npm run theme:generate.')
} else fs.writeFileSync(target, css)
