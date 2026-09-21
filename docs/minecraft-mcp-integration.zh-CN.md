# 模组真实交互测试

ModMind 使用 langyo/minecraft-mod-mcp 的正式发布版 v0.3.0 作为 Java 模组测试客户端的控制 Mod，通过其 HTTP API 接到 ModMind 的 MCP 工具。此接入为实验性，不能将上游发布包的存在视为稳定兼容保证。没有引入上游 npm 启动器；下载、构建、启动、取消和进程清理由 ModMind 管理。

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

当前目录包含 Fabric 31、Forge 51、NeoForge 8 个组合，有版本空缺，没有 Quilt。统一的是 ModMind 的工具接口，底层不是全版本通用。`supportTier: experimental` 和 `runtimeVerified: false` 明确区分目录支持与实测；启动后 `actionsVerified: false` 表示不能据此认定每个动作都有效。按钮列表为空时优先看截图，使用坐标点击，不猜按钮索引。

测试文件位于项目 `.modmind/player-tests/<sessionId>/game`，仅复制已同步模组及相关配置/资源，不复制用户存档和选项。控制 JAR 不写入发布产物或用户游戏实例。

上游 v0.3.0 默认监听所有网卡。安装时在已校验 JAR 的 `McpHttpServer.class` 常量池中，将唯一的 `0.0.0.0` 改为 `127.0.0.1`；结构不符则拒绝安装。保留其余条目，并附带修改声明和 MIT 许可。下载缓存保持上游原件。每次操作核对专用端口与受管客户端 PID，不扫描和接管其他游戏。

1.20.1 实测发现上游通过反射猜测尺寸会截断画面、错算点击坐标。因此替换截图助手为读取 OpenGL 实际窗口尺寸和完整显示帧的实现，并修正窗口尺寸查询。源文件位于 `resources/minecraft-mcp/`，生成字节码及源文件哈希保存在 `src/main/nativeMinecraftMcpHelper.json`；维护者使用 `node scripts/compile-minecraft-mcp-helper.mjs <javac> <已校验的1.20.1-Fabric-v0.3.0-JAR>` 重建，运行时无需编译。此适配不依赖具体方块、实体映射；状态读取和输入仍受上游版本实现限制。

插件和整合包项目仍走已有 HeadlessMC 玩家会话；Quilt 或无对应发布包的版本继续使用已有检查。新路径的能力和限制不会被泛化到这些后端。

## 实测范围

2026-09-21 在 Windows 上使用 Minecraft 1.20.1 / Fabric 0.19.3 和上述适配器，实际启动隔离客户端，验证 1280×720 原生标题画面截图，并点击 Singleplayer 进入创建世界界面、再次截图，最后关闭受管进程。测试使用本地编译的最小模组夹具，未对全部目录组合、具体业务模组或世界内建造进行验收。

上游 1.20.1 按钮列表仍为空，可用原生截图坐标操作。上游按键返回表示接收请求，不保证游戏处理完成；本次 F2 请求未产生游戏截图文件，ModMind 的截图走独立 framebuffer 适配器。不能把此实测扩大为生存移动、采集、建筑或所有 GUI 的完整保证。
