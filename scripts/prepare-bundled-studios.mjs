import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const ids = JSON.parse(await fs.readFile(path.join(root, 'src/shared/bundledStudios.json'), 'utf8'))
const output = path.join(root, 'resources/bundled-studios')
if (!process.argv.includes('--skip-build')) for (const id of ids) await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/build-feature-plugins.mjs'), `--only=${id}`], { cwd: root, stdio: 'inherit', windowsHide: true })
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`预装工作台构建失败：${id}`)))
})
await fs.mkdir(output, { recursive: true })
const temporary = path.join(output, '.verify.cjs')
await require('esbuild').build({ stdin: { contents: "export { prepareFeaturePlugin } from './src/main/featurePluginService';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: temporary })
try {
  const { prepareFeaturePlugin } = require(temporary), packages = []
  for (const id of ids) {
    const file = `${id}.mmstudio`, source = path.join(root, 'feature-plugin-dist', file)
    const prepared = await prepareFeaturePlugin(source)
    if (prepared.manifest.id !== id || !prepared.manifest.studios?.length) throw new Error(`预装工作台身份不一致：${id}`)
    const directory = path.join(output, id)
    await fs.rm(directory, { recursive: true, force: true })
    for (const [name, content] of prepared.files) {
      const target = path.join(directory, name)
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content)
    }
    await fs.rm(path.join(output, file), { force: true })
    packages.push({ id, directory: id })
  }
  await fs.writeFile(path.join(output, 'index.json'), JSON.stringify({ format: 'modmind-bundled-studios', schemaVersion: 2, packages }, null, 2) + '\n')
  console.log(`已准备 ${packages.length} 个随包内置工作台：${output}`)
} finally { await fs.rm(temporary, { force: true }) }
