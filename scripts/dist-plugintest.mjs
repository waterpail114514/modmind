import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { verifyWinNative } from './verify-win-native.mjs'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'release/1.5.0-plugintest-r7')
const installerName = 'ModMind-Setup-1.5.0-plugintest-r7.exe'
// Keep compiler/NSIS staging off the system volume, which may be nearly full.
const buildTemp = path.join(root, 'test-results', 'build-temp-r7')
await fs.mkdir(buildTemp, { recursive: true })
process.env.TEMP = buildTemp
process.env.TMP = buildTemp
const run = (script, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true, env: process.env })
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`)))
})
await run(path.join(root, 'scripts/build-feature-plugins.mjs'))
if (!process.argv.includes('--skip-build')) {
  await run(path.join(root, 'scripts/generate-theme-tokens.mjs'), ['--check'])
  await run(path.join(root, 'scripts/check-theme-colors.mjs'))
  await run(path.join(root, 'scripts/generate-plugin-templates.mjs'), ['--check'])
  await run(path.join(root, 'scripts/check-plugin-ui.mjs'))
  await run(path.join(root, 'scripts/clean-build-output.mjs'))
  await run(path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js'), ['build'])
}
const { build, Platform } = require('electron-builder')
await build({ targets: Platform.WINDOWS.createTarget(['nsis'], 1), config: {
  compression: 'normal',
  appId: 'dev.modmind.desktop.plugintest', productName: 'ModMind Plugin Test',
  extraMetadata: { name: 'modmind-plugintest', productName: 'ModMind Plugin Test', version: '1.5.0-plugintest' },
  directories: { output }, artifactName: installerName,
  publish: null, forceCodeSigning: process.argv.includes('--signed'), win: { signAndEditExecutable: true },
  // The default 7z path expands the complete app in %TEMP% before copying it.
  // Low space on C: can leave a truncated stage that NSIS reports as installed.
  // The ZIP path extracts directly into the selected installation directory
  // and checks the extraction result. This isolated test channel has no delta updates.
  nsis: { useZip: true, differentialPackage: false, include: path.join(root, 'resources/installer-plugintest.nsh'), runAfterFinish: false },
  afterPack: async context => {
    const report = await verifyWinNative(context.appOutDir)
    await fs.writeFile(path.join(output, 'native-verification.json'), JSON.stringify(report, null, 2))
  },
  protocols: [{ name: 'ModMind Plugin Test', schemes: ['modmind-plugintest'] }]
} })
await run(path.join(root, 'scripts/smoke-win-executable.mjs'), [path.join(output, 'win-unpacked')])
const sums = []
const catalog = JSON.parse(await fs.readFile(path.join(root, 'feature-plugin-dist/catalog.json'), 'utf8'))
const pluginNames = catalog.map(feature => `${feature.id}.mmfeature`)
for (const name of pluginNames) await fs.copyFile(path.join(root, 'feature-plugin-dist', name), path.join(output, name))
for (const name of [installerName, ...pluginNames]) sums.push(`${createHash('sha256').update(await fs.readFile(path.join(output, name))).digest('hex')}  ${name}`)
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
await fs.writeFile(path.join(output, '使用说明.md'), `# ModMind 1.5.0-plugintest r7\n\n` +
  `安装器：${installerName}。应用内版本为 1.5.0-plugintest；r7 修复模型原生视图遮挡弹窗，并拆出媒体运行依赖。\n\n` +
  `1. 升级时保留安装器检测到的原安装位置和安装范围。当前测试版位于 D:\\Program Files (x86)\\Modmindtest\\ModMind Plugin Test；全新安装请选择 Modmindtest 测试目录，启动 ModMind Plugin Test。它使用独立的应用标识和用户配置目录。\n` +
  `2. 首次不带功能插件，只保留工作台、灵感台、代码、测试、构建、设置和插件管理。\n` +
  `3. 在「设置 → 集成 → 应用功能插件 → 安装功能插件」选择本目录的 .mmfeature 文件，确认信任后即刻加载。它与原第三方插件管理分开。\n` +
  `   声音和发布需要先安装 media-runtime.mmfeature（媒体处理支持，包含 FFmpeg）。其他插件不需要它。已安装 R6 模型、声音或发布插件时，先卸载对应旧包，再装本目录新版，保存的数据会保留。\n` +
  `4. 可按需安装、停用或卸载。卸载保留已保存的数据；先保存未提交的编辑，并等待进行中的任务结束。\n\n` +
  `旧 API 1 图像工坊试验包不兼容此宿主，请卸载旧包后安装本目录的 image-studio.mmfeature。全部功能使用下列 ${catalog.length} 个 API 2 包：\n\n` +
  catalog.map(feature => `- ${feature.name}：${feature.id}.mmfeature`).join('\n') +
  `\n\nSHA256SUMS.txt 包含安装器及全部插件的完整性校验值。原生插件具有应用本地权限，仅安装可信来源。` +
  `\n\n覆盖升级会保留旧安装目录的文件，因此旧 resources/blockbench 或 resources/decompile-tools 副本可能仍在磁盘上，但新版不加载它们；实际运行使用已安装插件里的资源。安装器未做发布者数字签名。` +
  `\n\n已检查实际 EXE 启动及 Sharp、7-Zip；媒体转换随插件单独验收。未完成真实账号 AI 对话和线上生图计费验收，未消耗账户额度。\n`)
await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'))
await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'))
console.log(output)
