import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Run only after both sequential game matrices and independent evidence audits.
const main = process.cwd(), branch = path.resolve(process.argv[2] || 'D:/Codex/UserData/worktrees/modmind-1-4-14/modmind')
const read = file => fs.readFile(file, 'utf8').then(JSON.parse)
const doc = 'docs/game-control-compatibility'
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: branch, encoding: 'utf8' }).trim(), '1.4')
const artifact = await read(path.join(main, 'feature-plugins/testing/src/main/gameControlAgent.json'))
assert.equal((await read(path.join(branch, 'src/main/gameControlAgent.json'))).jarSha256, artifact.jarSha256)
const compatibility = await read(path.join(main, 'feature-plugins/testing/src/main/legacyForgeJavaCompatibilityArtifact.json'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(digest(Buffer.from(artifact.data, 'base64')), artifact.jarSha256)
for (const [file, hash] of Object.entries(artifact.sourceHashes)) assert.equal(digest(await fs.readFile(path.join(main, 'resources/game-control', file))), hash)
for (const name of ['gameControlSession', 'gameControlActions', 'backgroundMinecraftTestService', 'legacyForgeJavaCompatibility']) {
  const source = (await fs.readFile(path.join(main, `feature-plugins/testing/src/main/${name}.ts`), 'utf8')).replaceAll('../../../../src/shared/', '../shared/').replaceAll('../../../../src/main/', './')
  assert.equal(await fs.readFile(path.join(branch, `src/main/${name}.ts`), 'utf8'), source, 'Shared service drift in 1.4: ' + name)
}
const matrix = await read(path.join(branch, doc, 'compatibility-matrix.json'))
const regression = await read(path.join(main, 'test-results/game-control-full-regression-summary.json'))
assert(regression.results.every(row => row.exitCode === 0 && row.failed === 0))
const reportNames = ['runtime-results.json', 'loader-runtime-results.json', 'loader-profile-runtime-results.json']
const reportRoots = [main, branch, branch]
const reports = await Promise.all(reportNames.map((name, index) => read(path.join(reportRoots[index], doc, name))))
for (const [index, report] of reports.entries()) {
  const expected = index === 0 ? 63 : index === 1 ? matrix.javaLoaderCombinationCount : matrix.selectedLoaderProfileCount - matrix.javaLoaderCombinationCount
  assert.equal(report.completed, expected); assert.equal(report.passed, expected)
  assert(report.rows.every(row => row.status === 'runtime-verified' && row.agentSha256 === artifact.jarSha256))
}
const projectMods = await read(path.join(main, 'test-results/game-control-project-mod-runtime.json'))
assert.equal(projectMods.completed, 2); assert.equal(projectMods.passed, 2)
const auditNames = ['game-control-evidence.json', 'game-control-loader-evidence.json', 'game-control-loader-profile-evidence.json', 'game-control-project-mod-evidence.json']
const audits = await Promise.all(auditNames.map(name => read(path.join(main, 'test-results', name))))
for (const audit of audits) assert.equal(audit.verified, audit.expected)
const classpath = await read(path.join(main, 'test-results/game-control-runtime-libraries.json'))
assert.equal(classpath.verified, matrix.selectedLoaderProfileCount)
const packageDirectories = (await fs.readdir(path.join(main, 'test-results/game-control-package'))).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))
const packageProof = await read(path.join(main, 'test-results/game-control-package', packageDirectories[0], 'verification.json'))
assert.equal(packageProof.agentSha256, artifact.jarSha256)
assert.equal(packageProof.legacyJavaCompatibilitySha256, compatibility.upstream.sha256)
assert.equal(packageProof.concurrentViewersIncluded, true)
const proofCases = [
  { name: 'sdl-vulkan-26.3', root: branch, report: 'test-results/game-control-mcp/26.3-vulkan-final2/verification.json' },
  { name: 'glfw-raw-mouse-off', root: branch, report: 'test-results/game-control-mcp/1.20.1-raw-mouse-off-final/verification.json' },
  { name: 'legacy-forge-java8', root: main, report: 'test-results/game-control-legacy-java-runtime-proof/forge-1.7.2/verification.json' },
  { name: 'shared-viewers-lwjgl2', root: main, report: 'test-results/game-control-loader-matrix-v2/forge-1.7.10/verification.json' },
  { name: 'quilt-title-fade', root: main, report: 'test-results/game-control-loader-matrix-v2/quilt-1.21/verification.json' },
  { name: 'neo-experimental-world', root: main, report: 'test-results/game-control-loader-matrix-v2/neoforge-1.20.5/verification.json' },
  { name: 'forge-project-mod', root: branch, report: 'test-results/game-control-project-mod-forge/verification.json' },
  { name: 'neo-project-mod', root: branch, report: 'test-results/game-control-project-mod-neo/verification.json' }
]
const selectedProofs = []
for (const item of proofCases) {
  const report = await read(path.join(item.root, item.report))
  assert.equal(report.agentSha256, artifact.jarSha256)
  assert.equal(report.worldLoaded, true)
  if (item.name.includes('vulkan')) assert.equal(report.graphicsBackend, 'Vulkan')
  if (item.name.includes('raw-mouse')) assert.equal(report.rawMouseInput, false)
  if (item.name.includes('shared-viewers')) assert.equal(report.assertions.sharedViewerRevision, true)
  if (item.name.includes('project-mod')) { assert.equal(report.projectModLoaded, true); assert(report.projectModArtifact?.sha256) }
  selectedProofs.push({ ...item, reportData: report })
}
const sourceFiles = ['feature-plugins/testing/main.ts', 'feature-plugins/testing/src/main/gameControlSession.ts', 'feature-plugins/testing/src/main/gameControlActions.ts', 'feature-plugins/testing/src/main/backgroundMinecraftTestService.ts', 'feature-plugins/testing/src/main/minecraftRuntime.ts', 'feature-plugins/testing/src/main/legacyForgeJavaCompatibility.ts', 'src/shared/gameControl.ts', 'feature-plugins/testing/components/BackgroundGamePanel.tsx']
const sourceHashes = await Promise.all(sourceFiles.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(main, file))).digest('hex') })))
const branchFiles = ['src/main/gameControlSession.ts', 'src/main/gameControlActions.ts', 'src/main/backgroundMinecraftTestService.ts', 'src/main/minecraftRuntime.ts', 'src/main/legacyForgeJavaCompatibility.ts', 'src/main/index.ts', 'src/main/externalAgents.ts', 'src/preload/index.ts', 'src/shared/gameControl.ts', 'src/renderer/src/components/BackgroundGamePanel.tsx']
const branchSourceHashes = await Promise.all(branchFiles.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(branch, file))).digest('hex') })))
const packageBytes = await fs.readFile(path.join(main, 'feature-plugin-dist/testing.mmfeature'))
const common = { completedAt: new Date().toISOString(), agentSha256: artifact.jarSha256, legacyJavaCompatibilitySha256: compatibility.upstream.sha256, evidenceRoot: main, branchRoot: branch, catalogVersions: matrix.gameVersionCount, loaderCombinations: matrix.javaLoaderCombinationCount, loaderProfiles: matrix.selectedLoaderProfileCount, vanilla: { passed: reports[0].passed, expected: reports[0].targetVersions }, independentEvidence: audits.map(audit => ({ expected: audit.expected, verified: audit.verified })), classpath: { verified: classpath.verified, distinctInputJars: classpath.distinctInputJars.length }, regression, package: { path: 'feature-plugin-dist/testing.mmfeature', bytes: packageBytes.length, sha256: createHash('sha256').update(packageBytes).digest('hex'), activation: packageProof }, sourceHashes, branchSourceHashes, specialProofs: selectedProofs.map(({ reportData: _, ...item }) => item), deployedToInstalledApp: false }
for (const root of [main, branch]) {
  const directory = path.join(root, doc), evidence = path.join(directory, 'phase4-evidence')
  await fs.mkdir(evidence, { recursive: true })
  for (let index = 0; index < reportNames.length; index++) await fs.writeFile(path.join(directory, reportNames[index]), JSON.stringify({ ...reports[index], evidenceRoot: main }, null, 2))
  for (let index = 0; index < audits.length; index++) await fs.writeFile(path.join(evidence, auditNames[index]), JSON.stringify(audits[index], null, 2))
  await fs.writeFile(path.join(evidence, 'effective-runtime-libraries.json'), JSON.stringify(classpath, null, 2))
  for (const item of selectedProofs) {
    const target = path.join(evidence, item.name), source = path.dirname(path.join(item.root, item.report))
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'verification.json'), JSON.stringify({ ...item.reportData, originalEvidenceDirectory: source }, null, 2))
    for (const name of ['after', 'inventory', 'replaced', 'resized', 'shared-view', 'preview-refresh', ...(item.name === 'neo-experimental-world' ? ['world-starting', 'world-confirmed'] : [])]) if (item.reportData.captures[name]) await fs.copyFile(path.join(source, item.reportData.captures[name].path), path.join(target, item.reportData.captures[name].path))
  }
  await fs.writeFile(path.join(directory, 'delivery-verification.json'), JSON.stringify(common, null, 2))
  const lines = regression.results.map(row => `| ${row.cwd === branch ? '1.4' : '主分支'} | ${row.passed} | ${row.failed} | ${row.skipped} |`).join('\n')
  const completedLocal = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai', hourCycle: 'h23' }).format(new Date(common.completedAt))
  const markdown = `# 自研后台游戏控制交付

完成时间：${completedLocal}（北京时间）。主分支与 1.4 的 AI rendered 测试默认链路已替换为自研 Agent；AI 能通过实际游戏截图进行键鼠操作，无需抢占桌面前台。旧控制 Mod 链路仅通过显式 backend=legacy 使用，headless 保留原用途。

## 覆盖与验收

- 1.4 当前目录 **${matrix.gameVersionCount} 个 Java Minecraft 版本、${matrix.javaLoaderCombinationCount} 个加载器组合、${matrix.selectedLoaderProfileCount} 份内置/联网选版配置全部实机通过**。主分支目录止于26.2，为63版本、133组合、185配置，按各自目录筛选的逐行结果见 [runtime-status.md](runtime-status.md)。不是每个加载器所有历史发布版。
- 加载器191配置的实机宿主是1.4；主分支的185项是按共同目录筛选，未声称另在主分支重跑185次。主分支另外运行原版63矩阵和实际功能包激活，公共Agent字节一致，宿主差异由各自完整回归和构建覆盖。
- 另有原版 **63/63**；逐份PNG哈希、帧号、尺寸、输入释放及桌面采样的独立文件检查全部通过。11种实际Windows输入JAR的SDK解析与SHA1/大小核对覆盖191/191。
- LWJGL2、GLFW、SDL3；Java8/17/21/25；8种加载器启动入口均有真实游戏证据。Java16要求的版本使用现有Java17，不冒称独立Java16测试。
- 26.3 **Vulkan**、1.20.1 **rawMouseInput=false**、窗口960×540→800×450→恢复和旧坐标拒绝另有专项实机证明。启动前到动作结束的桌面采样证明对应样本未抢前台；较早原版部分样本只观察进入世界后的动作。
- 点击、双击、拖拽、滚轮、相对视角、键盘、中文字符、组合键、批次、去重、取消、超时松键、暂停/接管/恢复均接入同一业务服务。AI与预览并行读图凭据修复经过故障复现、回归和后续实机验证；不将较早样本计入该新增断言。
- Fabric 的矩阵样本实际加载自有项目Mod；另外 Forge1.20.1、NeoForge1.21.1 分别通过自有项目Mod复制、加载标记、进入世界和完整MCP操作，并记录该Mod的SHA256。测试Mod替代Gradle构建，不把它写成所有版本的项目构建均已通过。
- 验收中曾遇到Quilt1.21标题淡入期误判、Neo1.20.5实验性世界确认页等待超时；按真实截图修复验收流程后完整重跑通过，未为这两项修改生产Agent或绕过游戏输入。第一轮失败证据保留在原始目录的history子目录。
- Forge项目Mod的首次补验只查latest.log而漏掉真实启动控制台中的加载标记；补验改为核对两份实际进程日志，并独立检查游戏实例中的Mod JAR哈希后重跑通过，同样没有为此修改生产代码。

| 完整src回归 | 通过 | 失败 | 原有跳过 |
| --- | --- | --- | --- |
${lines}

两分支 Node/Web 类型检查、主题检查、独立MCP各5项、Node脚本各54项、App构建通过。主分支实际 testing.mmfeature 包安装到隔离宿主，工具发现、能力调用、非法参数拒绝及停止调用通过；确认携带最终Agent、离线LegacyJavaFixer和并行读图实现。UI实际组件覆盖1080×680深浅主题、1440×900、启动/输入/点选/拖拽/接管/失败重试/释放/停止；该UI夹具使用模拟传输，真实游戏证据另计。

## 1.4 接入

1.4 保留单体架构，窄幅移植Runtime、MCP工具定义与校验、IPC/preload、页面及共享服务，未用主分支整份文件覆盖。项目切换、代理取消、会话过期和权限校验复用已有宿主边界；已发现的Fabric类加载、Java17 socket目录、旧Forge安装URL和inheritsFrom问题同步修复。普通手动启动游戏按钮仍按原有人工用途工作。

## 选型与离线成本

复用仓库 XMCL 的安装/启动/进程管理、sharp图片处理、工具发现与权限服务。采用 [ASM](https://asm.ow2.io/) 的BSD许可小型字节码核心并重定位包名，避免每个Minecraft版本维护一份控制Mod；没有引入整套原生注入框架。Agent为${artifact.jarBytes || 179630}字节，随包内嵌，游戏控制时不联网、不需要javac。许可证见 THIRD_PARTY_NOTICES.md。

Forge1.7.2的Java8排序问题复用官方 [LegacyJavaFixer](https://github.com/MinecraftForge/LegacyJavaFixer)，MIT许可、6630字节，固定官方SHA256；仅向受管实例写入兼容补丁，保留用户已有补丁，拒绝符号链接并修复自有损坏文件。它用于启动兼容，不承担游戏控制。

## 证据与复现

最终Agent SHA256：\`${artifact.jarSha256}\`。兼容补丁：\`${compatibility.upstream.sha256}\`。

[交付清单](delivery-verification.json) 保存最终源码与功能包哈希、完整回归计数和证据索引。完整原图/调用记录/桌面采样位于清单的 evidenceRoot；本目录保留 [Vulkan](phase4-evidence/sdl-vulkan-26.3/verification.json)、[关闭原始鼠标](phase4-evidence/glfw-raw-mouse-off/verification.json)、[旧Forge](phase4-evidence/legacy-forge-java8/verification.json)、[多查看者](phase4-evidence/shared-viewers-lwjgl2/verification.json) 的报告和代表原图。部分报告引用的其他帧保留在 originalEvidenceDirectory。

重跑使用 scripts/verify-game-control-loaders.mjs 与 scripts/verify-game-control-evidence.mjs；额外配置通过 --profile-variants 指定准备报告，串行运行避免多游戏并发。资源准备脚本单独执行，不为目录预览自动下载整套游戏资源。具体命令与历史故障见 overnight-progress.md。

## 已知边界

验证环境为本机Windows x64。普通后台窗口可遮挡，最小化/隐藏/锁屏持续出帧、全屏/跨DPI、多系统、替代渲染Mod和人工连续打字未被本轮证明。接口对隐藏模式明确拒绝，不用旧图假装新帧。动作完成表示输入被消费并发生后续渲染，游戏语义结果仍需AI读图判断；空槽拖动不记录为物品已移动。

Java服务端API目录的82项不等于服务端启动/进服/插件行为已逐项测试；Velocity、基岩与网易创作目录不属于此Java Agent适配。测试使用隔离项目/存档和已有Java，有限字体复用仅用于中文视觉专项，没有补齐完整游戏资产。

源码、构建与功能包已就绪；未提交、推送、发布或覆盖用户已安装的软件。
`
  await fs.writeFile(path.join(directory, 'phase4.md'), markdown)
}
console.log(JSON.stringify({ completed: true, versions: matrix.gameVersionCount, combinations: matrix.javaLoaderCombinationCount, profiles: matrix.selectedLoaderProfileCount, agentSha256: artifact.jarSha256 }))
