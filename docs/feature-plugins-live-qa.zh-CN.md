# 功能插件开发验收记录

## R7 交付与验证（2026-10-01）

`release/1.5.0-plugintest-r7/ModMind-Setup-1.5.0-plugintest-r7.exe`
为 223,129,506 字节（212.8 MiB），相对 R6 减少 31.8 MiB（13.0%）。
解压后的程序由 575,990,371 字节降为 467,606,633 字节，减少约 103.4 MiB。
同目录包含 17 个插件，新增 `media-runtime.mmfeature` 提供 FFmpeg，供声音和发布
插件共用。安装器和全部插件共 18 项 SHA-256 校验通过。

Blockbench 原生 WebContentsView 不受宿主 DOM z-index 控制。模型插件已通过 SDK
检测可见模态框，弹窗打开时隐藏原生视图，关闭后恢复边界和原模型；关闭确认及
账号弹窗、1280/390 px 窗口、弹窗期间尺寸变化与模型修订号保持均验证通过。
升级需替换同目录的 R7 模型、声音和发布插件，并先安装媒体处理支持。

最终实际 EXE 启动及 Sharp/7-Zip 验证：
`test-results/win-executable/1790822734516/result.json`，PASS。
最终 ASAR 和同目录 17 个插件的安装、实际调用、媒体导出、原生弹窗层级、独立窗口、
启停卸载验收：`test-results/feature-plugins-all/1790822948114/result.json`，PASS。
媒体插件单测另验证 FFmpeg 版本、生成 OGG、依赖停用保护和二进制篡改拒绝。
ASAR 审计确认 FFmpeg、Tone、MIDI、Three.js 等已移除的 npm 目录未进入核心包。

双端类型检查通过。全仓回归记录 `test-results/feature-suite-r7.json`：1544 通过、
13 跳过、1 项既有模型档位断言失败（同下文 R6 记录）。首次回归因 C: 无可用空间
中断，后续临时目录切至 E: 后完成。本次没有运行安装向导覆盖正式版或测试版目录，
没有进行真实账号对话或消耗额度，安装包仍未签名。

## 后续安装包交付（2026-10-01）

用户随后明确要求生成安装包并将插件放在同目录。已交付
`release/1.5.0-plugintest-r6/ModMind-Setup-1.5.0-plugintest-r6.exe`
（256,495,501 字节），同目录有 16 个 API 2 `.mmfeature` 包、使用说明、许可证及
`SHA256SUMS.txt`；17 个交付文件的 SHA-256 均校验通过。应用版本仍为
`1.5.0-plugintest`，r6 区别于旧 API 1 交付。

实际交付 EXE 启动、Sharp 图片回读、FFmpeg 和 7-Zip 验证通过，证据为
`test-results/win-executable/1790821128468/result.json`。最终 ASAR 加载同目录
16 个插件的完整窗口验收通过，证据为
`test-results/feature-plugins-all/1790821157087/result.json`。该 ASAR 验收使用开发
Electron 加载最终资源，实际 EXE 启动另行验证；本次未运行安装向导写入测试或正式版安装目录。

安装包未签名，本次未取得卡巴斯基复检结果。升级应保留检测到的原安装路径和范围；
覆盖升级可能保留旧版可选资源副本，新程序不加载这些副本。

## 本轮结果（2026-10-01）

核心导航仅保留工作台、灵感台、代码、测试、构建、设置和插件管理。16 个非核心功能已迁入独立 API 2 插件，开发包在 `feature-plugin-dist/<id>.mmfeature`。界面、业务实现和专用资源随插件安装；宿主统一读取清单并接入页面、设置、动作、事件及 MCP。该流程与原第三方 iframe 插件分开，完整清单及接口见 [功能插件说明](feature-plugins.zh-CN.md)。

本轮未生成安装器，未启动或修改正式版安装目录，也未启动或修改 `D:\Program Files (x86)\Modmindtest`。实际窗口测试使用仓库开发构建和独立 Electron 配置目录。

## 已验证

| 项目 | 证据与范围 |
| --- | --- |
| 类型与构建 | `npm run typecheck` 通过；核心 main/preload/renderer 与全部 16 个插件分别构建通过，最终 main/preload 已重建。 |
| 全仓单元及集成回归 | `npx vitest run src --maxWorkers=2 --reporter=json --outputFile=test-results/feature-suite.json`：1543 通过、13 跳过、1 失败，共 1557 项。唯一失败是 `preferenceSave.integration.test.ts:82` 仍期望 `gpt-5.6-sol` 的最高档位为 `ultra`，现有模型档位实现返回 `max`；与功能插件迁移无关，本轮没有修改模型档位规则。 |
| 任意新插件 | `featurePluginGenericMcp.test.ts`：创建宿主没有专用 handler 的 palette 插件，经真实 stdio MCP 安装后发现、保存、回读；校验非法参数、灵感台只读、停用与卸载。 |
| 生命周期与权限 | `featurePluginService.test.ts`：12 项通过，覆盖清单/schema、包资源、局部 require 缓存、事件与旧发送器失效、项目切换、关闭、依赖和调用边界。 |
| AI 上下文 | `featurePluginAgentContext.test.ts` 及实际工作台桥接回归通过。未安装仍知道可安装能力；没有虚构可执行工具；逐对话记录本轮工具、插件状态与用户勾选变化，恢复旧对话也能比较。 |
| 全插件实际窗口 | `test-results/feature-plugins-all/1790800466659/result.json`：PASS，16 个插件经真实安装确认加载，Java/整合包页面和 MCP 查询可用，未访问声音页面即可导出音乐，离线 BeepBox、模型编辑与 PNG 回读、独立图像/模型窗口、深浅主题与 390 px 设置窗口通过；停用卸载后恢复纯核心界面。 |
| 图像工坊闭环 | `test-results/feature-plugins/1790795748131/result.json`：PASS，首次断网、安装后即时加载、工作流保存、测试 API 生图、PerfectPixel、保存与 MCP 回读、处理/编辑、失败重试、深浅主题/窄窗、重启、启停、卸载重装保留数据。 |
| 原版界面对照 | `test-results/feature-parity/1790797907697/result.json`：PASS。与原版 `release/win-unpacked` 对比 1280/760 px 的工作流、处理和编辑界面，六组控件几何/样式相同，五幅截图完全一致；760 px 工作流仅 16 个边缘抗锯齿像素有差异，通道差异约 0.0025%。不延伸为全部操作状态逐像素一致的承诺。 |
| 反编译边界 | `src/main/decompilePluginQuery.test.ts` 与 `src/main/featurePluginSelections.test.ts`：通过。缓存查询必须绑定当前项目或附件中的原始 JAR；灵感台按 JAR 分析、兼容性和版本对比勾选限制 inspect/files/read/references。 |

现有模型、声音、反编译等成熟实现保持复用，Blockbench、BeepBox 与反编译 JAR 已随插件搬出核心资源。共享账户、主题、React、Monaco、预览、项目 I/O、快照恢复、下载/进程管理及测试构建基础服务留在宿主。插件是受信任的本地代码，清单权限边界不是不可信代码沙箱。

## 真实账号对话仍待验收

此前独立开发实例名为 `ModMind Feature Live QA`，数据目录为 `test-results/feature-plugins-live/profile`，测试项目在系统临时目录的 `modmind-feature-live-project`。已点击“连接账号”和“打开浏览器连接”，设备接口成功申请授权，状态从 `disconnected` 转为 `authorizing`，默认 Edge 打开设备授权网页。

浏览器自动化当时返回 `Codex auth token is unavailable`，Computer Use 随后无法确定浏览器 URL 并停止。没有绕过限制。用户明确回复“暂时无法确认，继续其余开发”，随后要求睡觉期间不再提问，因此没有再次要求确认，也没有继续依赖授权的步骤。

尚未取得账号已连接状态，使用额度为零。真实模型在工作台及灵感台识别功能、调用在线生图、显示产物的对话体验，以及线上登录与计费，均不能标为已通过。上面的测试 API 结果只证明程序调用链和保存/回读正确，不证明线上模型实际响应。

## 独立开发预览

```powershell
npm run features:preview
```

此入口加载 `out/` 开发构建，设置独立应用名、测试版应用标识和配置目录，不读取正式版配置。设置中的“应用功能插件”可以安装 `feature-plugin-dist/` 的 API 2 包。当前 API 1 历史包会被明确拒绝，需要本次开发包；保存的数据不因卸载而删除。

账户验收脚本保留 `node scripts/feature-plugins-live-qa.mjs --interactive`。stdin 的 `{"command":"connect"}` 操作开发界面的连接按钮，`{"command":"account"}` 仅返回脱敏连接状态及额度，不读取或输出凭证。该记录保留后续继续入口，本轮不请求用户操作。
