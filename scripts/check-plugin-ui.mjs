import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'
import postcss from 'postcss'

// Repository template checks, not an installation gate for third-party plugins.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
for (const relative of ['panel-only/panel/index.html', 'panel-and-tools/panel/index.html', 'overlay-pet/overlay/index.html']) {
  const file = path.join(root, 'resources/plugin-templates', relative)
  const $ = load(fs.readFileSync(file, 'utf8'))
  const fail = message => failures.push(`${relative}: ${message}`)
  if (!$('meta[name=viewport]').length) fail('Missing viewport for small windows')
  if (!$('main').length) fail('Missing main landmark')
  $('button').each((_, element) => {
    const button = $(element)
    if (!button.text().trim() && !button.attr('aria-label')) fail('Button needs an accessible name')
  })
  $('style').each((_, element) => {
    const style = $(element)
    // Both blocks are generated from the application's authoritative theme/scrollbar functions.
    if (['modmind-theme-fallback', 'modmind-scrollbars'].includes(style.attr('id'))) return
    postcss.parse(style.text(), { from: file }).walkDecls(declaration => {
      if (declaration.parent.selector?.includes('.mm-artwork')) return
      if (/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black|red|blue|green|yellow|orange|gray|grey)\b/i.test(declaration.value)) fail(`Use semantic theme colors: ${declaration.prop}: ${declaration.value}`)
      if (declaration.prop.startsWith('--theme-')) fail('Do not override host theme tokens')
      if (declaration.prop === 'transition' && /\ball\b/.test(declaration.value)) fail('Name transition properties explicitly')
    })
  })
  if ($('.mm-primary').length > 1) fail('Template should have one primary action')
}
if (failures.length) throw new Error(failures.join('\n'))
console.log('PASS: plugin templates use semantic chrome colors, named controls, and responsive page foundations.')
