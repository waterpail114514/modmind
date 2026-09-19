import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compiled = await build({ entryPoints: [path.join(root, 'src/shared/pluginUi.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
const context = { module: { exports: {} } }
vm.runInNewContext(compiled.outputFiles[0].text, context)
const { createPluginPanelHtml, createPluginOverlayHtml } = context.module.exports
const templates = {
  'panel-only/panel/index.html': createPluginPanelHtml('项目信息'),
  'panel-and-tools/panel/index.html': createPluginPanelHtml('项目摘要', 'summarize_project'),
  'overlay-pet/overlay/index.html': createPluginOverlayHtml()
}
for (const [relative, html] of Object.entries(templates)) {
  const file = path.join(root, 'resources/plugin-templates', relative)
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== html.replaceAll('\r\n', '\n')) throw new Error(`${relative} is stale. Run npm run plugins:generate.`)
  } else fs.writeFileSync(file, html)
}
console.log(`PASS: ${Object.keys(templates).length} plugin templates ${process.argv.includes('--check') ? 'match' : 'generated from'} the shared UI source.`)
