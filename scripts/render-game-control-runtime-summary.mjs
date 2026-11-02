import { promises as fs } from 'node:fs'
import path from 'node:path'

// Keep static launcher inspection separate from observed runtime acceptance.
// In particular, a vanilla pass never becomes a Loader pass by inference.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const sourceRoot = process.cwd(), hostRoot = path.resolve(arg('host-root') || '.')
const directory = path.join(hostRoot, 'docs/game-control-compatibility')
const json = file => fs.readFile(file, 'utf8').then(JSON.parse)
const matrix = await json(path.join(directory, 'compatibility-matrix.json'))
const versions = (await json(path.join(directory, 'versions.json'))).versions
const artifactFile = await fs.access(path.join(hostRoot, 'src/main/gameControlAgent.json')).then(() => 'src/main/gameControlAgent.json', () => 'feature-plugins/testing/src/main/gameControlAgent.json')
const artifact = await json(path.join(hostRoot, artifactFile))
const vanilla = await json(path.join(sourceRoot, 'docs/game-control-compatibility/runtime-results.json'))
const evidenceRoot = path.resolve(vanilla.evidenceRoot || sourceRoot)
if (hostRoot !== sourceRoot) await fs.writeFile(path.join(directory, 'runtime-results.json'), JSON.stringify({ ...vanilla, evidenceRoot }, null, 2))
const runtimeSource = path.resolve(arg('runtime-source-root') || hostRoot)
const loadReport = name => json(path.join(runtimeSource, 'docs/game-control-compatibility', name)).catch(() => ({ rows: [] }))
const loaders = await loadReport('loader-runtime-results.json')
const variants = await loadReport('loader-profile-runtime-results.json')
const regression = await json(path.join(evidenceRoot, 'test-results/game-control-full-regression-summary.json'))
const vanillaMap = new Map(vanilla.rows.map(row => [row.minecraftVersion, row]))
const loaderMap = new Map(loaders.rows.map(row => [row.key, row]))
const profileMap = new Map([...loaders.rows, ...variants.rows].map(row => [`${row.key.split('@')[0]}@${row.loaderVersion}`, row]))
const verified = row => row?.status === 'runtime-verified' && row.agentSha256 === artifact.jarSha256
const reportRows = []
for (const version of versions) {
  const targets = matrix.combinations.filter(row => row.minecraftVersion === version.id)
  const combinations = targets.map(target => {
    const row = loaderMap.get(target.key)
    const profiles = target.profiles.map(profile => {
      const evidence = profileMap.get(`${target.key}@${profile.loaderVersion}`)
      return { loaderVersion: profile.loaderVersion, status: verified(evidence) ? 'runtime-verified' : evidence?.status || 'pending', report: evidence?.report }
    })
    return { key: target.key, loader: target.loader, status: verified(row) ? 'runtime-verified' : row?.status || 'pending', testedLoaderVersion: row?.loaderVersion, report: row?.report, profiles }
  })
  const native = vanillaMap.get(version.id)
  reportRows.push({ minecraftVersion: version.id, inputFamily: version.inputFamily, vanilla: verified(native) ? 'runtime-verified' : native?.status || 'not-run', vanillaReport: native?.report, combinations })
}
const scopeKeys = new Set(matrix.combinations.map(row => row.key))
const runtimeRows = [...vanilla.rows, ...loaders.rows, ...variants.rows].filter(row => verified(row) && (!row.key || scopeKeys.has(row.key.split('@')[0])))
let startupObserved = 0, resized = 0, projectModLoaded = 0, sharedViewerPassed = 0
for (const row of runtimeRows) {
  const report = await json(path.resolve(evidenceRoot, row.report))
  if (report.desktop?.scope === 'before-launch-through-actions') startupObserved++
  if (report.resize?.staleRejected) resized++
  if (report.projectModLoaded) projectModLoaded++
  if (report.assertions?.sharedViewerRevision) sharedViewerPassed++
}
const result = { updatedAt: new Date().toISOString(), agentSha256: artifact.jarSha256, hostRoot, evidenceRoot,
  scope: 'all selected catalog Loader profiles, including bundled and downloaded selections; every catalog Minecraft version retained',
  targetVersions: versions.length, targetLoaderCombinations: matrix.javaLoaderCombinationCount,
  targetLoaderProfiles: matrix.selectedLoaderProfileCount,
  loaderProfilesPassed: reportRows.flatMap(row => row.combinations).flatMap(combo => combo.profiles).filter(profile => profile.status === 'runtime-verified').length,
  vanillaPassed: vanilla.rows.filter(verified).length, vanillaTargetVersions: vanilla.targetVersions,
  loaderPassed: matrix.combinations.filter(target => verified(loaderMap.get(target.key))).length,
  startupObserved, resizeProbesPassed: resized, projectModLoadsPassed: projectModLoaded, sharedViewerPassed,
  versionsWithActualGame: reportRows.filter(row => row.vanilla === 'runtime-verified' || row.combinations.some(combo => combo.status === 'runtime-verified')).length,
  regression, rows: reportRows }
await fs.writeFile(path.join(directory, 'runtime-summary.json'), JSON.stringify(result, null, 2))
const label = status => ({ 'runtime-verified': '实机通过', failed: '失败待修', pending: '等待', 'not-run': '不在63项原版矩阵（另见专项）' })[status] || status
const table = reportRows.map(row => `| ${row.minecraftVersion} | ${row.inputFamily} | ${label(row.vanilla)} | ${row.combinations.map(combo => `${combo.loader}：${combo.profiles.map(profile => `${profile.loaderVersion} ${label(profile.status)}`).join(' / ')}`).join('；')} |`).join('\n')
const full = result.loaderPassed === result.targetLoaderCombinations && result.loaderProfilesPassed === result.targetLoaderProfiles && result.versionsWithActualGame === result.targetVersions
const markdown = `# 后台游戏控制实机验收

更新：${result.updatedAt}。状态：${full ? '目录内全部 Loader 组合及选版配置通过' : '验收继续进行，未宣称完整通过'}。

Agent SHA256：\`${result.agentSha256}\`。

- 当前宿主目录 ${result.targetVersions} 个 Minecraft 版本、${result.targetLoaderCombinations} 个 Java Loader 组合；已有 ${result.versionsWithActualGame} 个版本的实际游戏证据。
- 原版 ${result.vanillaPassed}/${result.vanillaTargetVersions}；Loader 组合 ${result.loaderPassed}/${result.targetLoaderCombinations}，内置/联网选版配置 ${result.loaderProfilesPassed}/${result.targetLoaderProfiles}。原版和 Loader 分开计数。
- ${result.startupObserved} 次从启动前到动作完成的前台采样；${result.resizeProbesPassed} 次 resize/旧坐标拒绝；${result.projectModLoadsPassed} 次自有 Fabric 项目 Mod 加载；${result.sharedViewerPassed} 次 AI 与预览并行读图凭据验证。较早原版样本只观察进入世界后的动作。
- 覆盖本次目录实际选择的全部配置，不包含每个 Loader 的所有历史发布版。Java 16 要求的 1.17 系列使用现有 Java 17 运行，未宣称测试过独立 Java 16。

| Minecraft | 输入后端 | 原版 | Loader 配置实机结果 |
| --- | --- | --- | --- |
${table}

完整逐行索引见 [runtime-summary.json](runtime-summary.json)，原版见 [runtime-results.json](runtime-results.json)，基本组合见 [loader-runtime-results.json](loader-runtime-results.json)，额外选版见 [loader-profile-runtime-results.json](loader-profile-runtime-results.json)。完整截图保留在 JSON 的 evidenceRoot 下；独立文件校验使用 verify-game-control-evidence.mjs。1.4 含 26.3，主分支的目录止于 26.2，报告按各自目录筛选。

真实游戏验收使用隔离项目/存档和已有客户端/Java，资源准备独立进行，运行阶段跳过重复安装并选择明确的 Java；Fabric 项目 Mod 使用编译的自有小型夹具替代 Gradle 构建。中文字体仅为专项视觉验收复用，其余资产未补齐。没有注入系统键鼠，也未安装或发布到用户当前 App。26.3 Vulkan 与 1.20.1 rawMouseInput=false 另有专项实机记录，见 phase4.md。

最小化/隐藏/锁屏、跨 DPI、替代渲染 Mod 和人工持续打字尚未证明；服务器 ${matrix.serverCombinationCount} 个 API 目标的启动、进服与插件行为不由客户端结果推断。Velocity API、基岩/网易目录不计入 Java Agent 覆盖。
`
await fs.writeFile(path.join(directory, 'runtime-status.md'), markdown)
console.log(JSON.stringify({ hostRoot, vanillaPassed: result.vanillaPassed, loaderPassed: result.loaderPassed, loaderProfilesPassed: result.loaderProfilesPassed, targetLoaderProfiles: result.targetLoaderProfiles, versionsWithActualGame: result.versionsWithActualGame, targetLoaderCombinations: result.targetLoaderCombinations, full }))
