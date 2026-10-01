# 应用功能插件试验：1.5.0-plugintest

## 测试功能独立（2026-10-01）

游戏测试、服务端测试、玩家操作、自动检查与快速测试现已实际迁入
`feature-plugins/testing/`，不是仅用开关隐藏页面。测试专用的 XMCL Core 和
Installer 随插件打包；核心不再包含这些业务实现或分发 ServerPackCreator JAR。
核心保留构建、Java/JDK 准备、Gradle、项目与下载管理，未安装测试也能构建。

| 功能包 | 内容 |
| --- | --- |
| `testing` | 原客户端、服务端、自动检查界面与业务；13 个工作台 MCP 工具 |
| `server-pack-runtime` | ServerPackCreator 8.1.2 调用组件及第一段资源 |
| `server-pack-runtime-data` | 配套的第二段资源 |

安装 `testing` 会自动安装两个依赖；它们在功能页归入「支持组件」。上游 JAR
没有修改，只为维持每包 64 MiB 的下载限制拆为两段；使用时在应用数据目录拼合，
校验完整文件的大小和 SHA-256 后才调用。已验证的缓存可离线复用。游戏文件、
测试用模组和 HeadlessMC 仍按原有流程按需下载，不会随功能安装下载整个游戏。

专业模式缺少测试功能时进入「功能」页；小白模式点击测试会下载所需官方包，
然后打开原快速测试。停用或卸载后导航和 13 个测试工具消失，能力目录仍会告诉
AI 此功能可安装。灵感台不允许执行测试进程。运行中的测试阻止停用或卸载；
卸载保留项目内的日志、测试实例、产物和应用缓存。

这三个包需要新增的宿主能力 `testingV1`，必须使用本次修改后的主程序。
旧 R7 主程序即使版本字符串相同也不能加载它们；本轮未生成安装器。
既有 17 个正式功能的公开版本和包校验值在本次发布中保持原值。

复用已有 XMCL、HeadlessMC、Minecraft Mod MCP 与 ServerPackCreator 的逻辑、
锁定版本和许可证；本次只迁移所属模块，没有新增测试引擎。验收命令为
`node scripts/testing-feature-smoke.mjs`，覆盖隔离 Electron 窗口、实际公共 MCP
构建与服务端打包调用、包安装及依赖校验、离线状态、启停卸载和窄窗口截图。
完整 Minecraft 下载、实际玩家操作和所有游戏版本不属于此次实际窗口验收结果。
发布结果和具体边界见 [测试功能验收记录](testing-feature-qa.zh-CN.md)。

## R7：媒体依赖拆分与原生视图弹窗（2026-10-01）

R7 交付位于 `release/1.5.0-plugintest-r7/`。在原 16 个功能插件之外增加
`media-runtime.mmfeature`（媒体处理支持），FFmpeg 二进制与许可证随这个包提供。
声音和发布通过清单依赖它，共用一份已安装的转换器；核心不再分发 FFmpeg。
缺少依赖时页面/工具不激活，设置明确显示需要安装或启用的依赖名称。
另将已编译入 renderer 的 Tone、MIDI、Three.js 等 npm 副本改为构建依赖。

模型插件的 Blockbench 使用原生 WebContentsView，DOM 的 z-index 不能覆盖该视图。
新版通过 SDK 观察宿主可见模态框，弹窗打开时隐藏原生视图，关闭后恢复原位置及
原模型，不重新加载文档；关闭确认框、账号弹窗、缩放与窄窗均纳入实际窗口回归。
升级 R6 时须用同目录的新版模型、声音、发布包替换旧包，保存的数据保留。

含原生工具的构建输入可用 `nativeBinaries` 声明返回本机二进制路径的 npm 包。
构建器独立复制二进制和上游许可证、生成平台/架构及 SHA-256 索引；运行清单
`target` 会拒绝不匹配的系统或架构。为容纳媒体运行时，压缩包上限为 64 MiB，
解压内容上限为 128 MiB，512 个文件、路径与完整性检查保持生效。

## API 2 通用协议（2026-10-01）

以下 API 2 说明优先于本文保留的 API 1 交付历史。功能插件通过清单的 `capabilities`、`views`、`settings`、`actions`、`tools` 声明贡献；主程序统一注册页面和设置，实际 MCP 工具目录来自当前已启用插件的动作声明。主程序不需要逐个添加插件页面判断。声明与具体业务代码分离，未安装时只保留可安装的能力说明，不公布不可调用的工具。

`src/shared/featurePlugins.ts` 是协议类型来源。`src/shared/featurePluginCatalog.json` 仅包含构建时收集的清单元数据，`FeaturePluginService.catalog()` 将此目录与实际安装状态合并；`snapshot()` 提供状态变化序号，供每轮对话说明本轮工具链变化。安装/停用/卸载在有工作台或插件任务时拒绝，依赖未就绪时不发现工具，停用依赖前必须先停用依赖方。清单内的页面、设置和工具标识重复时拒绝安装，依赖循环同样拒绝。

通用动作调用为 `invoke(pluginId, actionId, input, context)`。插件必须声明输入 schema、读取/写入/联网/进程权限、所需项目和可用工作区。主进程校验参数、只读状态和当前项目，复用工作台审批后执行插件自身 handler。schema 使用 Ajv 8.20.0 校验完整的本地 JSON Schema，包括 `$ref`、`oneOf`、`const`、`pattern` 等原工具约束，不远程获取 schema。采用既有成熟实现，是为了保留原工具完整参数及错误语义；Ajv 为 MIT 许可证，开发构建和离线校验均已验证。

`activate(options)` 同步返回插件服务，动作可以位于 `actions` 对象中；`dispose()` 释放运行时资源，`projectChanged(path)` 清理跨项目状态。`service<T>()` 是复用原业务方法的兼容入口，原 UI API 经清单发现转到统一调用通道，未保留原功能的专用 IPC 实现。上一轮 API 1 试验包不能用于这版通用宿主，安装时明确拒绝；需使用本次构建的 API 2 包，卸载旧包不删除保存的数据。插件具有宿主本地权限，声明和校验是集成边界，不构成不可信原生代码的安全沙箱。

插件还可声明 `events`，通过注入的 `emitEvent(name, value, windowId?)` 发送进度，由界面的 `featurePlugins.onEvent(id, name, callback)` 订阅。启停和重新安装会使旧发送器失效，事件限制为 1 MiB。后台界面组件通过通用贡献加载，声音合成无需先打开声音页面。独立窗口使用同一协议，模型编辑器按窗口隔离并在切换项目、关窗及卸载时清理。

`assets` 声明随包资源目录；所有 `assets/...` 文件同样校验 SHA-256。R7 的压缩包限制 64 MiB、解压总内容限制 128 MiB、最多 512 个文件，拒绝路径穿越、重复大小写路径和链接。运行时得到 `pluginDirectory` 与 `assetBaseUrl`，离线网页通过已启用插件的专用协议提供。Blockbench、BeepBox 和反编译 JAR 均已移入各自插件；账号、主题、React、Monaco、通用预览、项目 I/O、快照恢复、下载/进程管理及构建基础设施仍由核心共享。

`npm run features:build` 逐个构建 `feature-plugins/<id>/manifest.json` 与主进程、界面入口，开发产物在 `feature-plugin-dist/<id>/` 和 `feature-plugin-dist/<id>.mmfeature`。每个包独立附带源码依赖的许可证，清单保留 SHA-256 完整性检查。`--only=<id>` 可单独构建，纯界面功能自动生成空样式文件。此命令不生成安装器、不写入旧 `release` 交付目录。实际页面与业务迁移的覆盖及真实账号对话验收见本次最终交付记录；不能仅以通用 host 单测通过视作功能已全部迁移。

本次解决的问题是：在不重装主程序、不重写工坊界面的情况下，把原本内置的图像工坊作为独立本地包安装、停用和重新装回。它与现有第三方插件的 iframe、插件市场、`plugin.json`、项目插件目录完全分开。

## 本次拆分

核心导航保留工作台、灵感台、代码、构建、设置和插件管理。测试导航由已安装的测试功能提供。独立功能目录及开发插件如下：

| 插件 ID | 功能 |
| --- | --- |
| `image-studio` | 图像工坊、节点工作流、生成与处理、图片设置 |
| `item-editor` | 物品与装备、原版物品参照 |
| `model-studio` | Blockbench、模型编辑、视觉验收 |
| `sound-studio` | 声音库、事件、音效与音乐、离线 BeepBox |
| `resource-packs` | 资源包编辑、预览、导出与部署 |
| `relationships` | 依赖、前置与联动、源码与项目交接 |
| `mappings` | 游戏映射查询 |
| `decompile` | 受控反编译、缓存读取与项目恢复 |
| `versions` | 版本记录、快照与 Git |
| `publishing` | 发布、发布平台设置与预检 |
| `modpack-mods` | 模组列表、下载、整合包规划 |
| `modpack-content` | 清单、配置、脚本、数据包、光影、界面、存档、玩家与服务端内容 |
| `modpack-migration` | 整合包版本迁移、预览、历史与撤销 |
| `modpack-automation` | 依赖与优化 |
| `ftb-quests` | FTB 任务书 |
| `patchouli` | Patchouli 指南书 |

所有插件声明复用原业务的工作台工具。物品、版本和受控反编译新增任务级查询/操作工具，避免 AI 依赖界面按钮。灵感台仍禁止项目源码写入；仅用户勾选的图像概念产物通过显式例外写入项目工具数据目录。

## AI 能力目录

每轮会向 AI 提供当前可安装能力、插件状态、可执行工具及相对此对话上轮的工具变化。目录让 AI 知道 ModMind 有图像生成、声音和模型等功能，即使尚未安装；这不是可执行工具。未安装、停用或依赖不足时工具不出现在实时 MCP 目录，旧调用也会被拒绝。需要这些功能时应说明安装或启用位置，不扫描本机其他软件作为替代。用户未勾选与未安装分别说明，不混为工具掉线。

`modmind_feature_catalog` 返回精简能力与状态，完整执行参数由实际工具发现提供，避免把所有界面动作 schema 重复送进对话。已有项目图片的读取是核心能力，不代表图像工坊已安装。

本轮未生成安装器。开发文件在 `feature-plugin-dist/`；本轮验收结果及真实账号对话的待确认项见 [开发验收记录](feature-plugins-live-qa.zh-CN.md)。

## API 1 历史交付

交付目录为 `release/1.5.0-plugintest/`：

1. 安装 `ModMind-Setup-1.5.0-plugintest-r5.exe`。应用名为 **ModMind Plugin Test**，与正式版使用不同的应用标识、默认安装位置和用户配置目录。也可解压 `ModMind-1.5.0-plugintest-unpacked.zip` 后直接运行其中的 EXE。
2. 首次启动不包含图像工坊，侧栏、图像设置、相关快捷入口和 AI 生图工具不可用。
3. 打开 **设置 → 集成 → 应用功能插件 → 安装功能插件**，选择 `ModMind-ImageStudio-1.5.0-plugintest.mmfeature`。
4. 确认信任后立即加载。在专业模式下，原来的图像工坊入口、工作流、处理、编辑、设置和工作台图像工具恢复，不需要重启。
5. 同一设置入口可以停用、重新启用、卸载。重新安装保留当前测试版中的已保存工作流、图像历史和加密 API 配置。卸载前保存编辑器中尚未导出的图片。

测试版不自动迁移正式版配置，不注册正式版 `mcdev` 登录链接，不接入正式版更新/清理重装通道。网页设备同步仍可通过应用原有的授权轮询流程使用；本次未实测线上账户与计费。正式版项目文件可以由用户主动打开，建议使用项目副本进行试验。

Windows 测试安装包未做 Authenticode 签名。`SHA256SUMS.txt` 用于检查下载或复制是否完整，不代表发布者签名。

## 模块边界

| 部分 | 所在位置 | 责任 |
| --- | --- | --- |
| 插件源码 | `feature-plugins/image-studio/` | 原图像工作流组件、节点与存储逻辑、图像设置、生成服务、PerfectPixel 与去背实现 |
| 主进程加载器 | `src/main/featurePluginService.ts` | 解析包、检查完整性与版本、安装目录、启用状态、按需创建服务、运行任务期间拒绝卸载、提供受控界面资源 |
| 界面加载器 | `src/renderer/src/featurePlugins.tsx` | 加载插件脚本/CSS、共享 React 实例与宿主组件、错误恢复、卸载界面 |
| 宿主协议 | `src/shared/featurePlugins.ts`、`src/shared/imageStudio.ts` | 清单、状态和图像后端接口，宿主不导入插件实现 |
| 原有宿主能力 | 主程序 | 主题、导航位置、项目边界、IPC、账户额度、系统加密、下载活动、资源保存、miniPaint 与 MCP 审批 |

主程序保留薄的集成入口和共享样式；图像工坊的组件与后端算法没有编进主程序。`@xyflow/react` 改为构建依赖，画布运行代码进入独立插件包。miniPaint 同时用于资源包编辑，继续作为共享能力随宿主提供。

界面直接挂在原 React 树里，共用主题、窗口和 React 实例，不新增工坊 iframe。插件样式放在全局主题覆盖之前，保持原先样式优先级；原有 miniPaint 编辑器本身仍使用 iframe。

## 包和生命周期

`.mmfeature` 是 ZIP，当前格式严格包含 `manifest.json`、`main.cjs`、`renderer.js`、`renderer.css`。清单声明 `format: modmind-feature`、API 版本 1、宿主版本、插件 ID、显示名、版本、入口文件和三个运行文件的 SHA-256。

- 当前只接受精确匹配 `1.5.0-plugintest` 的宿主协议，避免把尚不稳定的接口当作长期兼容承诺。
- 包和解压总内容上限为 32 MiB，拒绝额外路径、目录、重复文件、链接和错误校验值；先验证全部文件，再通过目录重命名完成安装。
- 安装在当前应用用户目录的 `feature-plugins/<id>`，与原 `plugins` 目录分开。停用状态随应用重启保留。
- 主进程服务按需激活。卸载/停用使旧服务句柄失效，服务调用或工作台任务尚在进行时拒绝更改插件。
- 资源协议只暴露启用插件的 `renderer.js` 和 `renderer.css`，不提供凭据或后端代码下载接口。
- 原生应用功能插件具有宿主权限，不是安全沙箱插件。安装会明确确认来源信任；SHA-256 只提供完整性，不提供可信发布者认证。

这是第一项真实功能的插拔试验。加载器可管理多个 ID，但导航槽位、设置参数和业务接口仍由宿主明确集成。下一项功能需要提取其接口并接入宿主槽位；当前没有实现任意插件自动新增页面、插件市场、依赖求解、签名分发或跨宿主版本升级。

## 复用与选型

实际使用版本：esbuild 0.25.12、React 18.3.1、React Flow 12.11.2、yauzl 2.10.0，均复用现有锁文件和上游实现，不新增生产依赖。图像生成、PerfectPixel、工作流存储和 miniPaint 保留原实现，避免重新实现领域能力。

- [yauzl](https://github.com/thejoshwolfe/yauzl)：MIT，支持逐条流式 ZIP 读取、大小验证，适合限制路径与解压体积；上游仍有维护活动。本次复用已安装的 2.10.0，不顺带升级全仓 ZIP 行为。
- [esbuild](https://github.com/evanw/esbuild)：MIT，已有构建依赖，可输出浏览器包和 Node CommonJS 包；插件构建成本仅发生在开发端，用户安装无需编译器或网络。
- [Vite Module Federation](https://github.com/originjs/vite-plugin-federation)：适合远程前端模块共享，但不能单独解决 Electron 后端插件、权限信任、本地安装和版本边界。对本次单功能试验，会增加另一套运行时与构建配置，因此未引入。
- [extract-zip](https://github.com/max-mapper/extract-zip)：BSD-2-Clause，仓库已有；本次要求在写入之前核对每个文件和总大小，直接使用现有 yauzl 更合适。

联网依赖仅限原有在线生图与账号服务。安装、启停、工作流编辑、本地图片处理和 miniPaint 可离线使用；不下载游戏资源。

## 工作台与验证

复用 `modmind_image_studio_info`、`modmind_image_generate`、`modmind_image_perfect_pixel` 和 `modmind_image_remove_background`。`tools/list` 每次读取当前启用状态，停用后旧连接也不再列出这些工具；直接调用同样在宿主端拒绝。项目已有图片查询和回读仍为共享能力。保留现有参数规范、只读限制、功能选择与审批路由。

验证命令：

```powershell
npm run features:build
npm run typecheck
npx vitest run src/main/featurePluginService.test.ts src/main/featurePluginMcp.test.ts src/main/imageStudioService.test.ts src/main/perfectPixel.test.ts src/renderer/src/lib/imageWorkflow.test.ts src/renderer/src/lib/imageWorkflowPresentation.test.ts src/renderer/src/navigationDefinitions.test.ts src/renderer/src/settingsDefinitions.test.ts
npm run build
npm run features:smoke
npm run dist:plugintest
$env:MODMIND_FEATURE_PACKAGED = (Resolve-Path 'release/1.5.0-plugintest/win-unpacked').Path
npm run features:smoke
```

`features:smoke` 使用隔离的用户目录和临时项目；外部网络被拦截，生图请求由本机测试 HTTP 服务响应，未使用真实账户或消耗额度。测试真实窗口、IPC、插件包、MCP 子进程、图片保存与回读、工作流生成保存、编辑器、启停、重启、卸载重装和失败重试。屏幕截图及结果在 `test-results/feature-plugins/<时间戳>/`。

不把测试服务器生成图片当作真实在线模型效果验收，也不把复用原组件当作所有页面所有状态已逐像素比对的证明。测试范围之外的模型服务、线上登录计费、其他平台安装器和以后版本的插件兼容性仍需独立验证。


### 本次交付验收记录

- TypeScript 双端类型检查通过；图像服务、工作流、导航、设置、插件生命周期与实际 MCP 插件调用共 202 项相关测试通过。另已运行原工作台桥接回归（176 项通过、1 项原有跳过）。
- 最终打包文件运行验证：`test-results/feature-plugins/1790773492648/result.json`，包含插件安装/启停/卸载重装、离线本地功能、工作流保存恢复、模拟服务错误后重试；使用隔离配置，未安装到正式版目录。
- 与原有 1.4.13 打包版对照：`test-results/feature-parity/1790773562261/result.json`。1280 和 760 像素窗口下的工作流、处理、编辑三个初始界面，六组控件几何/颜色/字号相同，截图原始像素通道完全一致。该结果限于这六个测试状态，不延伸为全部操作状态的像素一致承诺。
- 最终主包 ASAR 检查不包含 `ImageStudioService` 类、PerfectPixel 实现、插件源码目录或 `@xyflow/react` 生产依赖。原图像类型、MCP schema、共享样式与资源编辑器留在宿主作为公共契约/能力。
- 安装器构建与 SHA-256 校验通过，未实测 Windows 安装向导写入系统的过程；应用验证使用最终打包 ASAR 和原生依赖。

### r2 安装完整性修复（2026-09-30）

用户报告首次启动时 `sharp` 加载失败。比对原安装包、构建目录和实际安装目录确认：包内文件完整，安装目录中的 `libvips-42.dll` 从 18,956,288 字节截断到 17,039,360 字节，且缺失 `libvips-cpp.dll`、FFmpeg、elevate 和两个 Vulkan DLL。总共 6 个运行文件受影响。

当时 C 盘可用空间约 700 MiB。electron-builder 25.1.8 的默认 7z 安装路径先把压缩包及约 563 MiB 完整程序一起展开到 `%TEMP%`，然后复制到目标盘；其 Nsis7z 分支未检查解压成功就继续复制。空间不足会留下部分临时文件，随后安装仍可能结束。r2 使用现成的 ZIP 安装分支，直接解压到所选安装目录并检查解压结果；测试通道关闭差分包。系统临时目录仍需要容纳压缩包及少量安装器文件，但不再要求额外容纳整套解压后的程序。

本次已从校验通过的构建文件修复用户测试版目录的 6 个文件，并用该目录真正的 `ModMind Plugin Test.exe` 完成启动验证、Sharp PNG 缩放回读、FFmpeg 和 7-Zip 调用。用户数据目录和插件未被覆盖。

新增 `scripts/verify-win-native.mjs` 与 `scripts/smoke-win-executable.mjs`。打包流程在 afterPack 使用将交付的 EXE 检查原生模块，并在安装器构建完成后实际启动 EXE 验证主界面。此前仅借助开发 Electron 加载打包 ASAR 的测试不能覆盖安装目录缺文件问题，现不再将其视作可替代真实 EXE 启动验收。

r2 应用版本仍为 `1.5.0-plugintest`，插件协议与原 `.mmfeature` 包不变；已修复的现有安装可以直接使用，无需为了替换图像工坊插件再次安装。后续安装请使用带 `-r2.exe` 后缀的新安装器。

### r3 工具发现与安装确认修复（2026-09-30）

工作台模型线路切换代理会把普通 handler 包装成 Promise。r2 将图像工坊状态回调视为同步布尔值，用 Promise 与 false 比较，导致 tools/list 错误地列出生图工具；实际业务层仍拒绝未启用插件的调用。独立公共 MCP 的直接回调测试未覆盖此包装链路。

r3 将状态回调排除出任务执行代理，并在桥接层兼容和等待异步状态结果。新增真正走 runExternalAgent + LiveConfiguration 的回归，另验证异步状态回调下 tools/list、直接调用、只读审批、停用重启用。每轮上下文、制作功能提示、备用 skill 目录及托管 Codex skill 目录都按插件状态过滤；旧对话文字不会被删除，每轮会明确当前未启用状态。已有项目图片的列表和读取属于共享项目能力，继续可用；不能据此判断生图插件可用。

MCP 的薄接口定义仍留在宿主，用来接入插件业务服务。图像工坊的界面、设置、工作流和生成/处理实现位于独立包内。当前是显式槽位的应用功能插件试验，不是任意第三方代码即插即用的通用市场。插件未安装/停用时不向 AI 宣告其生成/处理接口；安装启用后接回同一业务服务。

安装信任提示从 Windows 原生 MessageBox 改为应用内模态对话框，共享主题与现有弹窗组件样式。只保留插件信息、真实权限后果及取消/信任并安装按钮；支持 Esc、模态焦点、深浅主题和 390 px 窄窗。后端仍保管经校验的插件字节，仅接受原请求窗口及 requestId 的明确确认，关闭或重载取消，不把信任校验移到前端。

相关验证：`test-results/feature-plugins/1790778531156/`（真实窗口、确认取消及焦点、深浅/窄窗、启停卸载及 MCP），`src/main/featurePluginMcp.test.ts`（真实工作台模型线路包装回归）。安装器继续使用 r2 的直接解压策略，图像工坊插件协议不变。

### r4 升级卸载临时目录修复（2026-09-30）

用户升级日志记录旧卸载器两次返回退出码 2。electron-builder 25.1.8 的旧卸载器在 `--updated` 模式下，会将旧程序文件移入子进程的 `$PLUGINSDIR/old-install`，完成后才更新注册信息。安装目录与系统临时目录在不同盘时，这一步需要跨盘复制，临时盘空间不足会触发卸载中止。此前改用 ZIP 解决的是新文件安装阶段，尚未覆盖旧版本卸载阶段。

r4 在旧安装目录旁创建唯一临时目录，仅在调用旧卸载器期间修改安装器进程的 TEMP/TMP，确保旧卸载器的临时区与旧程序位于同盘。调用结束后恢复进程环境，不修改用户或系统的持久环境变量；不取消 `--updated` 与保留用户数据参数，也不忽略卸载失败。成功后清理空临时目录，失败时不递归删除可能保留旧文件的临时区。原有备份、回滚、链接目录和安装范围保护继续生效。

验收包括 `scripts/installer-upgrade-smoke.mjs` 的 15 个隔离场景，尤其是使用旧卸载器原本文件迁移函数的 512 MiB 文件同盘迁移、临时区清理及进程环境恢复。证据目录：`test-results/installer-upgrade/nsis-05jIxb/`。

新增 `scripts/installer-full-upgrade-smoke.mjs`，使用真实 electron-builder 安装器、旧卸载器及生产升级 hook，在隔离的测试身份下完成首次安装、升级、版本注册回读和清理。测试将系统临时目录放在 C 盘，安装目录放在 E 盘；实际升级日志为 `uninstall attempt=1 result=0`。证据目录：`test-results/installer-full-upgrade/1790780481514/`。测试没有卸载用户的 ModMind。

r4 安装器文件与 SHA-256 已校验，打包程序真实 EXE 的启动及 Sharp/FFmpeg/7-Zip 检查通过。应用版本仍为 `1.5.0-plugintest`，可以继续使用现有图像工坊插件包。遇到旧安装器的失败确认时取消该安装器，改用 r4 重新运行升级。

### r5 安装行为简化与杀毒复核（2026-09-30）

本机卡巴斯基的检测数据库记录 r4 为 `PDM:Trojan.Win32.Generic`，对象 SHA-256 为 `71148ed1a68dae11eba19b6bbbd034220a6ef575903c9431f9d1d72a1fd78466`，与原交付校验值一致。PDM 为行为检测记录；仅凭此记录无法确认具体触发动作，也不能自行认定厂商已经确认误报。主包源码与本地构建一致。

卡巴斯基对 `win-unpacked` 应用目录的完整文件扫描报告为：处理 47,419 个对象，检测 0、可疑 0、错误 0。报告位于 `test-results/kaspersky-app-scan.log`，扫描结束时间 2026-09-30 23:18:33。静态文件扫描通过不等于安装运行行为一定不被阻止。

r5 为本次测试渠道增加独立 NSIS include。同目录、同安装范围且存在完整应用标记时，直接更新应用文件并保留已有额外文件，不再复制启动旧卸载器或为该路径重定向 TEMP/TMP；安装完成后不自动启动程序。路径不同、范围改变或链接目录拒绝该更新。正式版的升级备份恢复机制不受该测试渠道开关影响。原应用未改名、混淆或隐藏；这些改动是简化安装职责，不是关闭或绕过杀毒检查。

`scripts/installer-full-upgrade-smoke.mjs --in-place` 使用真实 NSIS 安装器验证首次安装、同目录升级、版本注册回读、保留额外文件，以及不调用旧卸载器。证据目录：`test-results/installer-full-upgrade/1790781671593/`。同目录更新保留旧布局中的多余应用文件；这不是带完整事务回滚与旧文件清理的长期更新协议。

`scripts/package-plugintest-zip.mjs` 同时提供普通 ZIP 分发，含原应用全部运行文件，无安装、升级卸载或注册操作。ZIP 解压版与安装版使用同一个 ModMind Plugin Test 用户目录；启动前关闭另一个副本，项目和插件设置沿用。杀毒软件仍可扫描和拦截 ZIP 内文件。不要覆盖正式版安装目录，也不要为了运行关闭杀毒或添加排除。

本机没有可用的发布者代码签名证书，r5 仍未签名，无法保证卡巴斯基未来放行。构建已取消强制禁用签名发现，提供 `node scripts/dist-plugintest.mjs --signed` 在持有可信证书时要求签名成功；不使用自签证书假冒可信发布者。长期应取得代码签名证书并通过 [Kaspersky OpenTIP](https://opentip.kaspersky.com/) 提交厂商复核。本次未上传安装包或私有项目到外部服务，未恢复隔离区样本，未修改杀毒设置。

r5 安装器本机卡巴斯基扫描完成于 23:24:17：500 个对象，检测 0、可疑 0、错误 0，见 `test-results/kaspersky-r5-scan.log`。这不包含用户实际安装路径下的所有行为场景。ZIP 完整性校验通过，解压到独立目录后真实 EXE 启动、Sharp PNG 缩放、FFmpeg 与 7-Zip 调用通过，见 `test-results/win-executable/1790781998501/result.json`。
