# Minecraft 后台真实交互测试

Java 客户端的默认 rendered 链路使用 ModMind 内置的 Java Agent。AI 读取游戏实际渲染画面，通过游戏进程内的虚拟键鼠操作；不占用桌面键鼠，不要求每个版本安装控制 Mod。模块化版本由 testing 功能包提供，1.4 内置同一业务服务。旧控制 Mod 仅保留在显式 `backend: legacy` 的路径中。

## 默认链路的使用

启用工作台“真实界面测试”后，使用以下现有 MCP 工具：

- `modmind_test_session` 的 `capabilities` 查询能力；`start` 配合 `mode: rendered` 构建并同步项目，启动隔离实例，随后用 `state` 等待 `ready: true`。`withoutProjectMod: true` 可启动不带项目产物的 Java 测试客户端。
- `modmind_test_capture` 返回真实 PNG 图片内容、帧号、逻辑与物理尺寸、坐标 `revision`。模型需要支持图片输入。
- `modmind_test_action` 支持按键、按住、组合键、文本、点击、双击、拖拽、滚轮和相对视角。像素动作必须使用最新截图的 `revision`；文本、滚轮和按键不依赖 GUI 按钮索引。`batch` 最多32步、累计10秒，按住租约最长5秒。
- 使用 `requestId` 查询/重试同一动作，避免超时后用新 ID 重放。动作完成仅表示输入与后续渲染已处理，游戏行为仍需读图判断。
- `pause` 暂停 AI；`takeover` 松键并交给用户；`resume` 清理旧物理状态并恢复 AI。`stop`、取消、项目切换和进程退出会释放受管会话。
- 后台链路没有游戏语义状态或自动寻路。多步像素操作使用 `test_action/batch`；不把旧后端 `test_scenario` 的文本匹配当作新链路的玩法断言。

`modmind_test_rendered` 是读取实际画面后停止客户端的短测试入口；持续互动使用会话工具。`headless` 的逻辑测试用途保留。

## 范围与运行边界

LWJGL2、GLFW 和26.3的 SDL3 分别适配。版本范围由 ModMind 当前 Java 项目目录决定，原版与各 Loader 的实机结果分开记录，见[兼容性目录](game-control-compatibility/README.md)和[持续验收记录](game-control-compatibility/overnight-progress.md)。API 的 `runtimeVerified`、`gameplayVerified` 不因目录存在就自动变为 true，也不代替对当前项目画面的检查。

窗口可被其他应用遮挡；最小化、隐藏、锁屏和替代渲染 Mod 的支持以独立实测为准。测试使用项目下的隔离实例，不复制用户存档和个人键位。服务器插件需要自己的服务端/进服验收，Velocity、基岩和网易目录不由 Java Agent 的客户端结果推断。

Forge1.7.2在Java8下的旧排序崩溃使用内置的[Forge官方 LegacyJavaFixer](https://github.com/MinecraftForge/LegacyJavaFixer)修复，固定SHA256并保留MIT许可。它只处理启动兼容性，不提供输入或取帧。其他 Loader 使用同一自研控制桥。

# 旧控制 Mod 后端记录

以下历史说明只适用于显式 `backend: legacy` 的保留路径；不再描述默认 rendered 链路。

Java 客户端的默认 rendered 链路使用 ModMind 内置的 Java Agent。AI 读取游戏实际渲染画面，通过游戏进程内的虚拟键鼠操作；不占用桌面键鼠，不要求每个版本安装控制 Mod。模块化版本由 testing 功能包提供，1.4 内置同一业务服务。旧控制 Mod 仅保留在显式 `backend: legacy` 的路径中。

## 默认链路的使用

启用工作台“真实界面测试”后，使用以下现有 MCP 工具：

- `modmind_test_session` 的 `capabilities` 查询能力；`start` 配合 `mode: rendered` 构建并同步项目，启动隔离实例，随后用 `state` 等待 `ready: true`。`withoutProjectMod: true` 可启动不带项目产物的 Java 测试客户端。
- `modmind_test_capture` 返回真实 PNG 图片内容、帧号、逻辑与物理尺寸、坐标 `revision`。模型需要支持图片输入。
- `modmind_test_action` 支持按键、按住、组合键、文本、点击、双击、拖拽、滚轮和相对视角。像素动作必须使用最新截图的 `revision`；文本、滚轮和按键不依赖 GUI 按钮索引。`batch` 最多32步、累计10秒，按住租约最长5秒。
- 使用 `requestId` 查询/重试同一动作，避免超时后用新 ID 重放。动作完成仅表示输入与后续渲染已处理，游戏行为仍需读图判断。
- `pause` 暂停 AI；`takeover` 松键并交给用户；`resume` 清理旧物理状态并恢复 AI。`stop`、取消、项目切换和进程退出会释放受管会话。
- 后台链路没有游戏语义状态或自动寻路。多步像素操作使用 `test_action/batch`；不把旧后端 `test_scenario` 的文本匹配当作新链路的玩法断言。

`modmind_test_rendered` 是读取实际画面后停止客户端的短测试入口；持续互动使用会话工具。`headless` 的逻辑测试用途保留。

## 范围与运行边界

LWJGL2、GLFW 和26.3的 SDL3 分别适配。版本范围由 ModMind 当前 Java 项目目录决定，原版与各 Loader 的实机结果分开记录，见[兼容性目录](game-control-compatibility/README.md)和[持续验收记录](game-control-compatibility/overnight-progress.md)。API 的 `runtimeVerified`、`gameplayVerified` 不因目录存在就自动变为 true，也不代替对当前项目画面的检查。

窗口可被其他应用遮挡；最小化、隐藏、锁屏和替代渲染 Mod 的支持以独立实测为准。测试使用项目下的隔离实例，不复制用户存档和个人键位。服务器插件需要自己的服务端/进服验收，Velocity、基岩和网易目录不由 Java Agent 的客户端结果推断。

Forge1.7.2在Java8下的旧排序崩溃使用内置的[Forge官方 LegacyJavaFixer](https://github.com/MinecraftForge/LegacyJavaFixer)修复，固定SHA256并保留MIT许可。它只处理启动兼容性，不提供输入或取帧。其他 Loader 使用同一自研控制桥。

# 旧控制 Mod 后端记录

以下历史说明只适用于显式 `backend: legacy` 的保留路径；不再描述默认 rendered 链路。

ModMind 使用 langyo/minecraft-mod-mcp 的固定正式发布版作为 Java 模组测试客户端的控制 Mod，通过其 HTTP API 接到 ModMind 的 MCP 工具。旧版本沿用 v0.3.0，Minecraft 26.3 使用 v0.4.8 与专用适配器。此接入为实验性，不能将上游发布包的存在视为稳定兼容保证。没有引入上游 npm 启动器；下载、构建、启动、取消和进程清理由 ModMind 管理。

## 使用

在模组工作台启用“真实界面测试”，可要求 AI：“构建这个模组，启动真实客户端，进入测试世界，验证新增方块的界面和交互，截图并报告结果。”

- `modmind_test_session` / `capabilities`：查询项目版本、加载器的精确匹配情况。目录支持不代表已经通过运行时验证。
- `modmind_test_session` / `start`，`mode: rendered`：构建并打开隔离客户端，返回 `sessionId` 与界面、玩家、世界状态。初始为标题界面，由 AI 操作创建测试世界。
- `modmind_test_observe`：读取当前状态；`operation: logs` 返回客户端日志证据。
- `modmind_test_capture`：返回并保存原始 PNG，以 MCP 图片内容传给模型，不使用网页重绘或网格图替代真实画面。
- `modmind_test_action`：点击、文字、按键、背包、关闭界面、视角、滚轮、右键交互、游戏命令。点击/文字/滚轮需要最新 GUI revision。`slot` 指 GUI 按钮索引；背包格子可用截图像素坐标点击。
- `modmind_test_scenario`：每组 1–20 步，在新读取的状态中检查预期文本，失败即停止。命令发送成功不算行为验证成功。
- `modmind_test_session` / `stop`：结束自己的客户端。任务取消、项目切换、应用退出也会清理。

`modmind_test_rendered` 是短测试入口：支持的 Java 模组版本返回原生截图和状态后关闭客户端；需要继续进入世界操作时使用上述会话入口。其他版本和整合包保留已有启动稳定性检查，不会把启动成功写成视觉或玩法验证成功。

有权限的测试世界可通过 `command` 执行 `/setblock`、`/fill` 等建筑命令。该接口不提供自动寻路或生存采集算法。需要模型支持图片输入才能分析截图。

## 依赖与隔离

发布资产目录在 `src/main/nativeMinecraftMcpCatalog.json`，只接受精确的 MC / Loader 组合，固定 URL 与 SHA-256；不使用 latest 或相近版本兜底。上游同一 JAR 可能覆盖多个版本，仍需实际启动验证。

当前目录包含 Fabric 32、Forge 52、NeoForge 9 个组合，有版本空缺，没有 Quilt。能力查询返回当前条目所用的发布版。统一的是 ModMind 的工具接口，底层不是全版本通用。`supportTier: experimental` 和 `runtimeVerified: false` 明确区分目录支持与实测；启动后 `actionsVerified: false` 表示不能据此认定每个动作都有效。按钮列表为空时优先看截图，使用坐标点击，不猜按钮索引。

测试文件位于项目 `.modmind/player-tests/<sessionId>/game`，仅复制已同步模组及相关配置/资源，不复制用户存档和选项。控制 JAR 不写入发布产物或用户游戏实例。

上述上游发布包默认监听所有网卡。安装时在已校验 JAR 的 `McpHttpServer.class` 常量池中，将唯一的 `0.0.0.0` 改为 `127.0.0.1`；结构不符则拒绝安装。保留其余条目，并附带修改声明和 MIT 许可。下载缓存保持上游原件。每次操作核对专用端口与受管客户端 PID，不扫描和接管其他游戏。

1.20.1 实测发现上游通过反射猜测尺寸会截断画面、错算点击坐标。因此替换截图助手为读取 OpenGL 实际窗口尺寸和完整显示帧的实现，并修正窗口尺寸查询。源文件位于 `resources/minecraft-mcp/`，生成字节码及源文件哈希保存在 `feature-plugins/testing/src/main/nativeMinecraftMcpHelper.json`；维护者使用 `node scripts/compile-minecraft-mcp-helper.mjs <javac> <已校验的1.20.1-Fabric-v0.3.0-JAR>` 重建，运行时无需编译。此适配不依赖具体方块、实体映射；状态读取和输入仍受上游版本实现限制。

插件和整合包项目仍走已有 HeadlessMC 玩家会话；Quilt 或无对应发布包的版本继续使用已有检查。新路径的能力和限制不会被泛化到这些后端。

## Minecraft 26.3 适配

2026-10-19 核对 [上游 v0.4.8](https://github.com/langyo/minecraft-mod-mcp/releases/tag/v0.4.8) 的 Fabric、Forge、NeoForge 26.3 发布包，并逐个固定 SHA-256。上游采用 MIT 许可，已有完整 HTTP 服务、状态协议和三种加载器入口；复用这些能力不增加 npm 依赖或另一套启动器。公共输入仍有 GLFW 编号与旧渲染接口依赖，因而仅对 26.3 注入 `ModMind263InputHandler`，旧版本适配器保持原样。

- 截图调用原版 `Screenshot.takeScreenshot(gameRenderer.mainRenderTarget(), callback)`，使用原版后端选择、异步 GPU 读回及行方向处理，再编码原始 PNG。HTTP 线程等待结果，游戏线程不等待回调；超时后仍释放返回的 NativeImage。不会读取桌面截图或复用旧帧。
- 界面通过 `mc.gui.screen()` 读取；递归收集可见控件，返回稳定索引、标签、GUI 坐标和实际截图尺寸。坐标点击按当前 GUI 缩放换算，按钮使用 SDL 的左 1 / 中 2 / 右 3；越界、无控件接收、禁用按钮均返回错误。像素坐标来自完整原图，控件坐标属于 GUI 空间，二者不可混用。
- 文字、按键、滚轮、关闭界面、视角、命令、玩家和世界状态使用 26.3 的公开 API。仍保留实验性与按动作验证要求；未把菜单验收扩大为世界内移动、采集和建造保证。
- 安装前要求目录中已审核条目及原件哈希均匹配，再将加载器入口常量池中唯一的 `ReflectedInputHandler` 类引用改为子类。保留上游控制模式、HTTP 协议、仅本机监听补丁、进程身份校验和操作前 revision 校验。

源码为 `resources/minecraft-mcp/ModMind263InputHandler.java`（AGPL-3.0-only），运行时直接注入 `src/main/nativeMinecraftMcp263Helper.json` 中已校验的 Java 25 字节码，无需现场编译。维护者重建命令：`node scripts/compile-minecraft-mcp-263-helper.mjs <JDK25 javac> <官方26.3 client.jar> <已校验的26.3 Fabric v0.4.8 JAR> <依赖缓存目录>`。脚本校验原版客户端、上游 JAR 和六个编译依赖的固定哈希，并记录源文件及 class 哈希。

## 实测范围

2026-10-19 在 Windows / Java 25 上，分别以 Fabric 0.19.5、Forge 26.3-66.0.13、NeoForge 26.3.0.94 启动真实 26.3 客户端，使用实际 stdio MCP 工具完成：查询精确能力、启动隔离实例、读取 GUI/玩家/世界状态、获取 1280×720 原始 PNG、按原图坐标打开选项、拒绝旧 revision、按按钮索引返回标题页并关闭受管进程。Forge / NeoForge 还验证 Escape 关闭选项页。已检查实际截图，未创建测试世界或验收全部游戏动作。

证据分别位于 `test-results/minecraft-26.3/live-project/`、`live-forge/`、`live-neoforge/` 下的 `mcp-live-result.json`，日志为 `mcp-live.log`、`mcp-live-forge-final.log`、`mcp-live-neoforge-final.log`；复现使用 `live.vitest.config.mjs` 运行 `mcp-live.test.ts`，通过 `MODMIND_MCP_LIVE_LOADER` 指定加载器。`adapter-jars.log` 逐条确认三个发布包仅修改服务器监听类与初始化入口、加入专用适配器，并保留其他原始条目和许可。

首次下载暴露 XMCL 在 Undici 7 中创建已移除 `ResponseStatusCodeError` 的异常路径。Minecraft 下载 dispatcher 增加 Undici 官方 `responseError()` 拦截器，让 HTTP 失败通过正常 Promise 拒绝进入换源；本地真实 XMCL 测试覆盖 404 错误、下一源 302 跳转、内容校验及原有系统代理。未修改依赖版本。冷缓存阶段的旧失败日志保留；上述三个最终实机验收均独立通过。

2026-09-21 在 Windows 上使用 Minecraft 1.20.1 / Fabric 0.19.3 和上述适配器，实际启动隔离客户端，验证 1280×720 原生标题画面截图，并点击 Singleplayer 进入创建世界界面、再次截图，最后关闭受管进程。测试使用本地编译的最小模组夹具，未对全部目录组合、具体业务模组或世界内建造进行验收。

上游 1.20.1 按钮列表仍为空，可用原生截图坐标操作。上游按键返回表示接收请求，不保证游戏处理完成；本次 F2 请求未产生游戏截图文件，ModMind 的截图走独立 framebuffer 适配器。不能把此实测扩大为生存移动、采集、建筑或所有 GUI 的完整保证。
