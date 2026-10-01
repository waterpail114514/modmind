import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const definitions = JSON.parse(await readFile(path.join(root, 'feature-plugins/renderer-contributions.json'), 'utf8'))
const host = (filter, contents) => ({ name: `host-${filter.source.replace(/\W/g, '')}`, setup(builder) {
  const namespace = `host-${filter.source.replace(/\W/g, '')}`
  builder.onResolve({ filter }, input => ({ path: input.path, namespace }))
  builder.onLoad({ filter: /.*/, namespace }, () => ({ contents, loader: 'js' }))
} })
const exportsOf = (name, key) => `const value = window.__modmindFeatureHost.${key}; export default value;\n` + Object.keys(require(name)).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key)).map(key => `export const ${key} = value.${key};`).join('\n')
const plugins = [
  host(/^react$/, exportsOf('react', 'React')),
  host(/^react-dom$/, exportsOf('react-dom', 'ReactDOM')),
  host(/^react\/jsx-runtime$/, exportsOf('react/jsx-runtime', 'jsxRuntime')),
  host(/InteractionDialogs$/, 'export const { useConfirmDialog, usePromptDialog } = window.__modmindFeatureHost.dialogs'),
  host(/MiniPaintEditor$/, 'export default window.__modmindFeatureHost.MiniPaintEditor')
]
for (const id of ['image-studio', ...Object.keys(definitions)]) {
  const directory = path.join(root, 'feature-plugins', id)
  const files = await readdir(directory)
  const entry = files.includes('renderer.tsx') ? 'renderer.tsx' : 'renderer.ts'
  const result = await build({ entryPoints: [path.join(directory, entry)], outfile: path.join(root, `test-results/renderer-build/${id}/renderer.js`), write: false, metafile: true, bundle: true, minify: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.hot': 'undefined', 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_IMAGE_TRACE': '"0"', 'import.meta.env.VITE_IMAGE_LOG_ENDPOINT': '""' }, plugins })
  const inputs = Object.keys(result.metafile.inputs)
  if (inputs.some(input => /monaco.*\?worker|src\/renderer\/src\/theme\.ts$/.test(input))) throw new Error(`${id} duplicated host theme/editor runtime`)
  console.log(`${id}: ${result.outputFiles.reduce((bytes, file) => bytes + file.contents.length, 0)} bytes; ${inputs.length} source inputs`)
}
