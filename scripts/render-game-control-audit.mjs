import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs/game-control-compatibility')
const read = async name => JSON.parse(await fs.readFile(path.join(output, name), 'utf8'))
const [summary, targetReport, versionReport, hookReport, profileReport, pinned] = await Promise.all([
  read('summary.json'), read('modmind-targets.json'), read('versions.json'), read('input-hook-inspection.json'), read('loader-profile-inspection.json'),
  fs.readFile(path.join(root, 'feature-plugins/testing/src/main/nativeMinecraftMcpCatalog.json'), 'utf8').then(JSON.parse)
])
const versions = versionReport.versions
const versionsById = new Map(versions.map(row => [row.id, row]))
const hooksByName = new Map(hookReport.artifacts.map(row => [row.name, row]))
const gameLoaders = new Set(['fabric', 'quilt', 'forge', 'neoforge'])
const serverLoaders = new Set(['paper', 'spigot', 'folia'])
const title = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', paper: 'Paper', spigot: 'Spigot', folia: 'Folia', velocity: 'Velocity', bedrock: '基岩版', 'netease-pc': '网易 PC', 'netease-mobile': '网易移动' }
const escape = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.map(escape).join(' | ') + ' |').join('\n')
const unique = values => [...new Set(values)]
const isInput = name => /^(org\.lwjgl\.lwjgl:lwjgl:|org\.lwjgl:lwjgl-(?:glfw|sdl):)/.test(name) && name.split(':').length === 3
function windowsAllowed(library) {
  if (!library.rules) return true
  let result = false
  for (const rule of library.rules) {
    if (rule.os?.name && rule.os.name !== 'windows') continue
    if (rule.os?.version && !new RegExp(rule.os.version).test('10.0')) continue
    if (rule.os?.arch && !new RegExp(rule.os.arch).test('x86_64')) continue
    result = rule.action === 'allow'
  }
  return result
}
function boot(main) {
  if (main?.includes('launchwrapper')) return 'LaunchWrapper'
  if (main?.includes('fabricmc')) return 'Fabric Knot'
  if (main?.includes('quiltmc')) return 'Quilt Knot'
  if (main === 'cpw.mods.modlauncher.Launcher') return 'ModLauncher'
  if (main === 'cpw.mods.bootstraplauncher.BootstrapLauncher') return 'CPW BootstrapLauncher'
  if (main === 'net.minecraftforge.bootstrap.ForgeBootstrap') return 'ForgeBootstrap'
  if (main === 'net.minecraftforge.bootstrap.BootstrapLauncher') return 'Forge BootstrapLauncher'
  if (main === 'net.neoforged.fml.startup.Client') return 'NeoForge Client'
  return main ?? '未解析'
}
function workFor(version, profiles) {
  const work = [version?.inputFamily === 'lwjgl2' ? 'L2：队列/轮询/Display 焦点/虚拟抓取' : version?.inputFamily === 'sdl' ? 'SDL3：事件/轮询/不激活窗口/游戏 GPU 回读' : 'G3：回调/轮询/虚拟焦点/相对鼠标']
  const input = version?.selectedInputLibraries.windowsX64 ?? []
  if (input.some(name => hooksByName.get(name)?.classes?.some(item => item.optionalMethods?.glfwRawMouseMotionSupported === false))) work.push('无 raw-mouse API：走光标增量分支')
  if (version?.java?.majorVersion >= 16) work.push(`J${version.java.majorVersion}：模块/类加载隔离`)
  if (version?.id === '1.6.4') work.push('官方未声明 Java：保留项目 Java 8 策略，启动待验')
  if (version?.requiredWork.includes('WORKSPACE_JAVA_COMPONENT_MISMATCH')) work.push('Java 17 组件别名需核验')
  for (const name of unique(profiles.map(row => boot(row.mainClass)))) work.push(name)
  work.push('后台持续出帧；MCP 实调用；取消释放')
  return work
}

const combinations = targetReport.targets.filter(row => gameLoaders.has(row.loader)).map(target => {
  const version = versionsById.get(target.minecraftVersion)
  assert.ok(version, `version metadata missing: ${target.key}`)
  const profiles = profileReport.profiles.filter(row => row.loader === target.loader && row.minecraft === target.minecraftVersion)
  assert.equal(profiles.length, new Set(target.profiles.map(profile => profile.loaderVersion)).size, `profile coverage: ${target.key}`)
  const resolvedProfiles = profiles.map(profile => {
    const replacements = profile.inputOverrides.filter(library => isInput(library.name) && windowsAllowed(library))
    const effectiveInput = replacements.length ? replacements.map(library => library.name) : version.selectedInputLibraries.windowsX64
    const inputHooks = effectiveInput.map(name => ({ name, staticStatus: hooksByName.get(name)?.staticStatus ?? 'not-inspected' }))
    return { ...profile, effectiveInputWindows: effectiveInput, inputHooks }
  })
  const entry = pinned.entries.find(entry => entry.minecraft === target.minecraftVersion && entry.loader === target.loader)
  return { ...target, versionMetadataSha1: version.metadataSha1, java: version.java ?? { majorVersion: null, note: 'not declared; ModMind selects Java 8' }, inputFamily: version.inputFamily, profiles: resolvedProfiles,
    existingControlAsset: entry ? { release: pinned.release, sha256: entry.sha256, runtimeVerified: false } : null,
    staticProfileStatus: resolvedProfiles.length > 0 && resolvedProfiles.every(profile => profile.status === 'profile-inspected' && profile.inputHooks.length > 0 && profile.inputHooks.every(hook => hook.staticStatus === 'required-methods-found')) ? 'static-hooks-found' : 'needs-investigation',
    requiredWork: workFor(version, profiles), implementation: 'shared-agent-integrated', runtimeAssessment: 'separate-runtime-reports', runtimeVerified: false, backgroundInputVerified: false, freshFramesVerified: false }
})
const servers = targetReport.targets.filter(target => serverLoaders.has(target.loader)).map(target => ({ ...target, clientVersion: target.minecraftVersion, clientInputFamily: versionsById.get(target.minecraftVersion)?.inputFamily ?? 'unresolved', clientJava: versionsById.get(target.minecraftVersion)?.java ?? null,
  topology: target.loader === 'folia' ? 'owned-server + real-client; region scheduling tested separately' : 'owned-server + real-client',
  note: 'Server API support is not proof of a ready server core, client join, permissions or game control.' }))
const outside = targetReport.targets.filter(target => !gameLoaders.has(target.loader) && !serverLoaders.has(target.loader)).map(target => ({ ...target, note: target.loader === 'velocity' ? 'API version, not Minecraft version; requires an explicitly selected backend server/client topology' : 'Existing non-Java authoring target; Java Agent route does not provide native-game control' }))
assert.equal(new Set(combinations.map(row => row.key)).size, combinations.length)
assert.equal(versions.length, summary.targetVersionCount)
assert.ok(versions.every(row => row.type === 'release' && row.metadataStatus === 'sha1-verified'))
assert.ok(combinations.every(row => row.staticProfileStatus === 'static-hooks-found'), 'all target profiles and input artifacts must be statically inspected')
assert.equal(combinations.length + servers.length + outside.length, targetReport.targets.length)
const result = { schemaVersion: 1, observedAt: new Date().toISOString(), primaryEnvironment: 'Windows x64; static class/launcher inspection only, no runtime guarantee', gameVersionCount: versions.length, javaLoaderCombinationCount: combinations.length, serverCombinationCount: servers.length, otherCatalogTargets: outside.length,
  selectedLoaderProfileCount: profileReport.profileCount, combinations, servers, outsideJavaGameControl: outside }
await fs.writeFile(path.join(output, 'compatibility-matrix.json'), JSON.stringify(result, null, 2) + '\n')

const versionRows = versions.map(version => [version.id, version.java?.majorVersion ?? '未声明（项目选 8）', version.inputFamily === 'lwjgl2' ? 'LWJGL 2' : version.inputFamily === 'sdl' ? 'LWJGL 3 / SDL3' : 'LWJGL 3 / GLFW', version.selectedInputLibraries.windowsX64.map(name => name.split(':')[2]).join(', '), combinations.filter(row => row.minecraftVersion === version.id).map(row => title[row.loader]).join(' / '), version.requiredWork.includes('WORKSPACE_JAVA_COMPONENT_MISMATCH') ? 'Java 组件别名差异；实机见 runtime-status.md' : version.java ? '静态 Hook 已核对；实机另计' : 'Java 声明缺失；项目选择 Java 8，实机另计'])
await fs.writeFile(path.join(output, 'versions.md'), '# ModMind 逐游戏版本适配矩阵\n\n由 `node scripts/render-game-control-audit.mjs` 生成。只包含当前 ModMind Java 目录中的实际版本；每行均读取并校验了官方元数据。输入库按 Windows x64 规则选择。方法存在不等于后台控制已通过。\n\n' + table(['Minecraft', '客户端 Java', '输入后端', '输入库版本', 'ModMind Loader', '当前结论'], versionRows) + '\n')
const comboRows = combinations.map(row => [row.minecraftVersion, title[row.loader], row.profiles.map(profile => `${profile.origins.map(origin => origin === 'bundled' ? '内置' : '联网').join('/')} ${profile.loaderVersion}`).join('；'), unique(row.profiles.map(profile => boot(profile.mainClass))).join(' / '), unique(row.profiles.flatMap(profile => profile.effectiveInputWindows)).map(name => name.split(':').slice(1).join(':')).join(' / '), row.existingControlAsset ? '有固定上游包' : '无固定上游包', row.requiredWork.join('；')])
await fs.writeFile(path.join(output, 'loader-combinations.md'), '# ModMind 逐 Loader 组合适配矩阵\n\n每个组合的内置/联网版本分别检查实际启动 profile，共 ' + profileReport.profileCount + ' 份。Forge/NeoForge 只读取安装器的 ZIP 元数据与启动 JSON，未完整下载安装器、未执行安装器；完整安装器哈希未验证。已有固定上游包只表示目录存在，不表示自研后台控制已完成。\n\n全部组合的静态入口已核对，共享自研 Agent 已接入。L2/G3/SDL 工作项列出适配依据；每份配置的实际结果见 runtime-status.md，不从静态方法推断实机通过。\n\n' + table(['Minecraft', 'Loader', '检查的 Loader 版本', '启动入口', 'Windows 输入库', '现有控制目录', '必做适配'], comboRows) + '\n')
await fs.writeFile(path.join(output, 'server-and-other-targets.md'), '# 服务端与非 Java 目录边界\n\nJava 插件目标复用同版本真实客户端的后台输入和取帧，但必须另验证服务端启动、进服和对应插件行为。服务端 API 目录不等于游戏内操作已可用。\n\n' + table(['版本', '平台', '客户端输入', '服务器 Java（目录声明）', '附加工作'], servers.map(row => [row.minecraftVersion, title[row.loader], row.clientInputFamily, unique(row.profiles.map(profile => profile.javaVersion)).join('/'), row.loader === 'folia' ? '真实进服；区域调度；玩家权限，需独立服务端验收' : '真实进服；玩家权限，需独立服务端验收'])) + '\n\n以下是现有其他创作目录目标，单独列出以免混淆游戏版本覆盖：\n\n' + table(['版本', '目录平台', '处理方式'], outside.map(row => [row.minecraftVersion, title[row.loader], row.loader === 'velocity' ? '代理 API 版本；需指定后端服与客户端版本' : '基岩/网易原生引擎；Java Agent 不适用，单独适配'])) + '\n')

const artifactRows = hookReport.artifacts.map(artifact => [artifact.name, artifact.bytes, unique(artifact.classes.flatMap(item => item.classMajor)).join('/'), artifact.staticStatus === 'required-methods-found' ? '存在' : artifact.staticStatus, artifact.family === 'glfw' ? artifact.classes[0].optionalMethods.glfwRawMouseMotionSupported ? '有 API' : '无 API' : '不适用', versions.filter(row => row.selectedInputLibraries.windowsX64.includes(artifact.name)).length])
const bootCounts = Object.fromEntries(unique(profileReport.profiles.map(row => row.mainClass)).map(main => [main, profileReport.profiles.filter(row => row.mainClass === main).length]))
const sourceFiles = ['src/main/loaderCatalog.ts', 'src/main/loaderCompatibility.ts', 'src/main/serverPluginCatalog.ts', 'src/main/serverPluginTemplates.ts', 'src/shared/serverPluginCompatibility.ts']
const sourceHashes = await Promise.all(sourceFiles.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex') })))
const verification = { schemaVersion: 1, observedAt: new Date().toISOString(), coverage: { versions: versions.length, javaLoaderCombinations: combinations.length, loaderProfiles: profileReport.profileCount, inputArtifacts: hookReport.artifacts.length, serverCombinations: servers.length, otherCatalogTargets: outside.length }, noMissingVersions: true, noMissingLoaderProfiles: true, allRequiredLibraryMethodsFound: true, duplicateCombinationCount: 0, snapshotTargetsAdded: 0, gameDownloads: 0, gameProcessesStarted: 0, assessmentScope: 'this command performs static inspection only; runtime results are separate', sharedAgentIntegratedCombinations: combinations.length, runtimeVerifiedCombinations: null, runtimeReport: 'runtime-summary.json', bootEntryCounts: bootCounts, catalogSourceHashes: sourceHashes }
await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(verification, null, 2) + '\n')

const readme = `# ModMind 当前版本后台操控适配调查

静态来源采集于 2026-10-29；本页由当前生成器重新整理。范围：当前工作区内置与联网项目目录的并集。后台要求为 AI 看见真实画面并独立操作，用户可同时使用前台软件。

## 覆盖范围与结论

已逐项调查 **${versions.length} 个 Java 游戏版本、${combinations.length} 个 Fabric/Quilt/Forge/NeoForge 组合**，并检查它们实际选择的 **${profileReport.profileCount} 份 Loader 启动配置**。范围从当前目录中的 1.6.4 到 ${versions[0].id}；没有额外纳入旧 Alpha/Beta 或周快照。当前目录包含实验性目标，这些也保留。

对 ${hookReport.artifacts.length} 种相关输入库 JAR 做了 SHA-1 校验和 class 方法检查，基础接入点均存在。Windows 选中的后端为 ${versions.filter(row => row.inputFamily === 'lwjgl2').length} 个 LWJGL 2、${versions.filter(row => row.inputFamily === 'glfw').length} 个 GLFW、${versions.filter(row => row.inputFamily === 'sdl').length} 个 SDL3 版本。方法签名支持相应适配器的设计，不能证明后台行为相同。

**本目录的版本/Loader 矩阵是独立的静态调查快照。** 实际运行结果另存为 runtime-results.json、loader-runtime-results.json；原版样本不计为 Loader 组合通过。持续进度见 overnight-progress.md。

| 交付文件 | 内容 |
| --- | --- |
| [逐版本矩阵](versions.md) | 每个游戏版本的 Java、实际输入库和已有 Loader |
| [逐 Loader 组合矩阵](loader-combinations.md) | 每个组合的精确 Loader 版本、真实启动入口、输入声明与必做适配 |
| [服务端与其他目标](server-and-other-targets.md) | ${servers.length} 个插件目标、Velocity API 与基岩/网易目录的边界 |
| [结构化完整矩阵](compatibility-matrix.json) | 逐组合数据、profile 来源、证据及未完成项 |
| [输入库检查](input-hook-inspection.json) | JAR 哈希、class 哈希、方法描述符和可选 API |
| [启动配置检查](loader-profile-inspection.json) | 精确 profile URL、启动类、JVM 参数及部分 ZIP 读取证据 |
| [完整性检查](verification.json) | 静态命令的计数、覆盖断言和仓库选版规则哈希 |
| [真实运行状态](runtime-status.md) | 逐版本、逐加载器配置的实际运行记录，与静态调查独立计数 |

## 确认的差异与实施安排

1. **1.6.4—1.12.2 的已有目标**走 LWJGL 2 队列/轮询及 Display 分支，处理虚拟按住、字符、鼠标抓取和焦点。1.6.4 的官方 JSON 没有声明 Java 版本，保留项目 Java 8 策略，必须实际验证。
2. **1.13.2、1.14—1.14.2**的所查 GLFW 绑定没有 glfwRawMouseMotionSupported 方法，采用光标增量分支；不能无条件调用新版 raw-mouse API。
3. **1.14.3—现代版本**按实查绑定探测 raw-mouse 能力。Java 8/16/17/21/25 分别验收桥接 class 格式、模块访问和 Loader 类加载，不强行替换项目原有 Java。
4. **1.18/1.18.1/1.18.2**官方声明 java-runtime-beta，仓库选择 gamma，Java 大版本均为 17。这是组件选择差异，尚未证明它是运行故障；需要核对实际运行时，不将它误报为 Java 大版本错误。
5. Loader profile 实际出现 **${Object.keys(bootCounts).length} 种启动类**。除 Knot、LaunchWrapper、ModLauncher 外，还有不同 BootstrapLauncher、ForgeBootstrap 与 NeoForge Client。需要按真实启动链验证 Agent 可见性，不能只用 Fabric 的启动成功推断全部 Loader。
6. Forge 1.6.4/1.7.2 在启动 JSON 中重新声明 LWJGL 及 OS 规则；逐组合对照 Windows 分支后仍可落到已检查的坐标。运行时最终 JAR 哈希仍需核对，因为坐标相同并不保证不同分发源的字节相同。
7. 后台焦点、失焦清键、锁鼠标、用户物理输入隔离、普通遮挡、最小化/隐藏后的新帧是**每个组合的共同验收项**。替代渲染 Mod 需根据实际后端额外验收，元数据不能证明加载后的 OpenGL 路径。

L2、GLFW 与 SDL 公共桥已实现并接入默认链路。实际运行按矩阵逐行验证各启动链和 Java 档位；覆盖完成以全部 ${combinations.length} 个现有组合逐项通过为门槛。每次新建测试会话检查实际加载的库和后端；版本目录变化时重新生成矩阵。

## 库层检查

${table(['输入库', 'JAR 字节', 'class major', '必需方法', 'raw-mouse 查询', 'Windows 游戏版本数'], artifactRows)}

class major 49/52 是被检查的库 class 格式，不是 Minecraft 对 Java 的要求。少数历史 macOS 分支的 JAR 也检查了，它们不会扩大游戏版本范围或代表 macOS 后台行为通过。

## 方法与验证边界

范围由实际执行仓库 bundledLoaderCatalog、downloadLoaderCatalog 与 ServerPluginCatalog 的选择逻辑得到；只将网络传输换为审计缓存，没有替换筛选逻辑。原始官方 manifest 元数据按 SHA-1 校验。Fabric/Quilt 读取官方 profile；Forge/NeoForge 使用已有 yauzl 的随机访问能力，只以 HTTP Range 读取 ZIP 目录和 version.json/install_profile.json，未执行安装器，未验证完整安装器哈希。

字节码检查复用仓库 @xmcl/asm 1.0.1，归档读取复用 archiveInspection，不新增依赖。这组静态调查命令没有下载游戏客户端、贴图、Java 或完整安装器，也不启动游戏或调用 MCP；后续实现和真实运行证据另见 runtime-status.md、phase4.md，不能把本段解释为项目尚未实现或测试。输入库 JAR 缓存在忽略目录，文档不分发第三方二进制。

服务端 API 目标共有 ${servers.length} 个：复用同版本真实客户端，但仍需测试服启动/进服及插件行为。Velocity 的 29 项是代理 API 版本，不能当作 29 个游戏版本。现有基岩/网易 5 个创作目标单列；它们不属于 Java Agent 路线，不能宣传已由该桥覆盖。

来源包括 [Mojang 版本目录](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)、[Fabric Meta](https://meta.fabricmc.net/v2/versions/game)、[Quilt Meta](https://meta.quiltmc.org/v3/versions/game)、Forge/NeoForge 官方 Maven，以及各 profile 中记录的精确 URL。本地快照哈希见 summary.json 和 verification.json。

## 重跑

在仓库根目录依次执行：

\`\`\`powershell
node scripts/audit-game-control-versions.mjs
node scripts/inspect-game-input-artifacts.mjs
node scripts/inspect-game-loader-profiles.mjs
node scripts/render-game-control-audit.mjs
\`\`\`

前三条加 --offline 可使用本轮本地证据缓存重跑；缓存缺失时明确失败，不把联网失败当无对应版本。报告完整性断言检查版本、组合、启动 profile 和库层证据是否缺失。一次调查只有静态证据，后台输入、画面及真实 MCP 验收仍是实施交付的一部分。
`
await fs.writeFile(path.join(output, 'README.md'), readme.replaceAll('\\`', '`'))
console.log(JSON.stringify({ versions: versions.length, combinations: combinations.length, profiles: profileReport.profileCount, artifacts: hookReport.artifacts.length, servers: servers.length, existingPinnedAssets: combinations.filter(row => row.existingControlAsset).length, staticComplete: true, assessmentScope: 'static-inspection-only' }))
