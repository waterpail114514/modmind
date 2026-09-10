# macOS 适配实施与验收记录

日期：2026-09-09–2026-09-10。依据 `macos-adaptation-development-plan.zh-CN.md` 检查；原状态未完成。本次补齐源码及发布验证入口，不生成 DMG/ZIP，不执行发布，不改动本机 macOS 配置。

## 本次实施

| 计划项 | 结果及入口 |
|---|---|
| MAC-101 | Codex 0.146.0 按 OS/CPU 解析固定 descriptor；npm 官方 SHA-512，普通文件/根目录校验，POSIX 执行位，版本探测，暂存后替换及失败恢复。显式配置的 CLI 同样探测；Windows cmd/ps1 保留支持。 |
| MAC-102 | 外部 Agent 检测 Homebrew、用户 npm/bin；Finder/Dock 的 PATH 补齐；提示词按实际平台给出 shell 指令。 |
| MAC-103 | HeadlessMC 自动下载 launcher 后打开 Terminal，0700 临时脚本、POSIX 参数编码、退出清理与启动时清理遗留脚本。 |
| MAC-104 | JDK 缓存增加 OS 隔离，Java/javac/javap 权限；FFmpeg 修正 asar unpack 路径；7-Zip 在签名前校正执行位并剔除其他平台/架构。实际 `.app` smoke 入口见 `scripts/smoke-macos-app.mjs`。 |
| MAC-201/202 | 长运行 Gradle、Minecraft、HeadlessMC、ServerPackCreator、本地服务端（通过 ServerProcess）、Agent 使用独立 POSIX 进程组。终止等待 TERM，再升级 KILL；负 PID 仅允许注册的自有进程组；Windows taskkill 等待完成。 |
| MAC-203 | 退出阻止新进程、下载及 AI 任务，取消活动任务及远程连接，等待服务、进程树、下载与日志；总超时 20 秒，替代 750ms 强退。 |
| MAC-204 | argv、second-instance、open-url 统一有限队列；就绪后顺序消费；一分钟去重、队列上限与长度限制。 |
| MAC-301/302 | shared 平台类型，preload 同步只读平台信息；主窗口/分离窗口共用 hiddenInset 原生交通灯；首帧不渲染 Windows 控件；CSS 安全区。 |
| MAC-303/304 | 标准应用/Edit/View/Window/Help role；Cmd+, 设置；Mac 红色关闭隐藏窗口、Dock 恢复、Cmd+Q 统一退出；Windows 关闭设置不套用到 Mac。 |
| MAC-305 | 1024 源图生成完整 ICNS；单色 1x/2x 模板菜单栏图标与 Template Image 标记。 |
| MAC-401–404 | 原生 arm64/x64 runner 矩阵及运行时架构断言；架构命名；Hardened Runtime 与最小 JIT entitlement；独立受保护签名/公证工作流；DMG/ZIP 实际展开后的版本/架构/协议/签名/票据/哈希验证。 |
| MAC-501/502 | 诊断包包含平台、架构、原生工具版本、Mac 签名摘要；下方记录故障分类与验收方法。 |

Codex 的固定目标位于 `src/main/codexRuntimeDescriptors.json`。本次已读取官方 npm integrity，实际下载、校验并解包确认 darwin-arm64、darwin-x64、win32-x64、linux-arm64、linux-x64 的二进制位置；Windows arm64 元数据已固定，本机不运行其二进制。Linux 官方包实际目录为 `*-unknown-linux-musl`，也一并修正原先的 gnu 假设。`scripts/inspect-codex-packages.mjs [target]` 只产生检查证据，不自动更改可信 descriptor。Mac 检查记录保存在 `test-results/codex-package-inspection-*.json`。

## 自动检查

Windows 本地最终通过 typecheck、629 项应用测试、5 项 MCP 测试、2 项发布策略测试及 electron-vite build（8 项依环境跳过）；日志位于 `test-results/macos-adaptation-tests.log` 和 `test-results/macos-adaptation-build.log`。构建仅输出 out，无安装包。原基线出现一次 Git 测试 5 秒超时，后续全量测试通过。

新测试覆盖：目标矩阵与不支持的目标、固定哈希、缓存复用/失败保护、符号链接边界、版本探测、POSIX 注入防护/脚本清理、平台窗口、菜单 role、深链队列和进程组。POSIX 专项在 Windows 明确跳过，在 Mac CI 执行，不计为本机通过。

CI 从固定提交检出原仓库忽略的独立 ModMind-MCP 测试仓库，避免干净 checkout 中 `npm test` 因该目录不存在失败。runner 配置为 macos-14 (arm64) / macos-15-intel (x64)，每个 job 实际核验 Node 与 uname 架构；标签在当前 GitHub 套餐中的可用性仍须首次 CI 确认。

## 尚需真实环境验收（不能标记原计划全部完成）

- MAC-001、MAC-104、MAC-405：本次未运行 Mac CI 或打包；`.app` smoke 代码包括窗口/preload 隔离、资源存在、Sharp 图像、FFmpeg 音频、7-Zip 往返、当前架构 Codex/JDK 下载与 Gradle 构建，尚无 Mac 执行结果。
- MAC-402/403/404：需要仓库管理员配置 `macos-release` 受保护 environment、Developer ID 证书、App Store Connect key、Team ID。electron-builder 管理临时签名 keychain，工作流始终删除临时 API key。未配置或验证失败不能作为正式产物。这里没有读取、创建或提交签名凭据。
- 需分别在 arm64/x64 真机验证 Gatekeeper 首次启动、下载后 Codex 最小 AI 任务、Microsoft/HeadlessMC 交互登录、Terminal 关闭/退出状态、Minecraft/服务端启动停止和 Cmd+Q 无残留；验证 Monaco 与普通输入框快捷键、分离窗口全屏/交通灯、冷启动 mcdev 授权。交互登录 Terminal 是外部终端会话，需单独确认关闭后 Java 的行为。
- 路径回归用含中文/空格/单引号的目录；在默认 APFS 和大小写敏感 APFS 卷分别执行创建、导入、构建与资源加载；复制 Windows 项目后确认 Java 探测失败时回退本机托管 JDK。
- MAC-503：两个 beta 的失败率观察属于发布后工作，本次未执行，也不把它标为完成。
- 用户明确排除了安装包产出，因此本次不执行 Windows/Mac 打包及 DMG 安装回归。

## 手工验收步骤与故障分类

1. 在两个架构各使用 `~/ModMind 验收/项目 '一'`，创建 Fabric/Forge/NeoForge 项目、构建、启动游戏和本地服务端，停止后用系统进程查看器确认没有对应 Java/Gradle/Agent。
2. 从 Finder 启动，自动准备 Codex；打开 HeadlessMC 登录 Terminal，完成登录、关闭会话、再次检测/重试；在真实签名应用中重复。
3. 主窗口和分离窗口测试 Cmd+C/V/X/A/Z/Shift+Z/W/M/,、全屏、红色关闭、Dock 恢复和 Cmd+Q；没有任务和有活动任务两种状态均测试。
4. 应用未启动/已启动分别打开有效 `mcdev://` 授权链接；重复同一链接不启动重复授权。
5. 使用受保护 workflow 完成签名版验收，再记录两个 beta 的启动/构建/AI/游戏失败数与样本数。

故障分类：Gatekeeper（签名/公证/票据）、架构（Electron/原生工具/JDK）、权限（执行位/只读目录）、路径（中文/空格/APFS 大小写/归档）、进程（取消/退出/残留）、图形（窗口/交通灯/全屏/资源）。每次记录 OS 版本、CPU、commit、操作步骤及应用导出的诊断包。
