import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'release/1.5.0-plugintest')
const app = path.join(output, 'win-unpacked')
const archive = path.join(output, 'ModMind-1.5.0-plugintest-unpacked.zip')
const sevenZip = require('7zip-bin').path7za
const run = args => new Promise((resolve, reject) => {
  const child = spawn(sevenZip, args, { cwd: app, windowsHide: true, stdio: 'inherit' })
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('ZIP packaging failed: ' + code)))
})
await fs.rm(archive, { force: true })
await run(['a', '-tzip', '-mx=5', archive, '.'])
await run(['t', archive])
const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex')
await fs.writeFile(path.join(output, 'ZIP-SHA256SUMS.txt'), `${digest}  ${path.basename(archive)}\n`)
await fs.writeFile(path.join(output, 'ZIP-使用说明.txt'), '解压 ZIP 后打开 ModMind Plugin Test.exe。它使用与安装版相同的应用配置目录。请先关闭安装版，避免同时运行两个副本。\n此包只包含原应用文件，不运行安装、升级卸载或注册流程，仍受杀毒软件正常检查。没有代码签名，不能保证不会误报。\n图像工坊插件仍从 设置 → 集成 → 应用功能插件 安装。\n')
console.log(archive)
