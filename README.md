<div align="center">

<img src="resources/readme-logo.png" alt="ModMind" width="820" />

### 从一个想法，到可以进入游戏的 Minecraft 项目

AI 辅助开发 · 模组与整合包 · 资源创作 · 游戏测试

**[官网与客户端下载](https://ether-studio.top/)** · **[GitHub 最新版](https://github.com/waterpail114514/modmind/releases/latest)** · **[更新日志](https://github.com/waterpail114514/modmind/releases)**

[功能一览](#功能一览) · [开始使用](#开始使用) · [本地开发](#本地开发) · [文档与社区](#文档与社区)

</div>

---

ModMind 是面向 Minecraft 创作者的桌面工作台。你可以先在灵感台整理想法，再让 AI 协助编写代码、制作资源、处理依赖，并在项目中构建和测试。编辑器、对话、图片、模型、整合包和服务端工具都集中在同一个工作区。

## 开始使用

**[访问官网 ether-studio.top](https://ether-studio.top/)** 即可下载客户端，查看使用流程，并使用账号管理、桌面授权、模型服务接入、额度与用量查询、兑换充值等功能。官网不只是下载页，更多功能可在登录后查看。

也可以从 **[GitHub Releases](https://github.com/waterpail114514/modmind/releases/latest)** 下载。具体版本与更新内容以发布页为准，仓库中的开发版本可能领先于正式版。

| 你的设备 | 选择的安装包 |
| --- | --- |
| Windows | `ModMind-Setup-<版本>.exe` |
| Mac · Apple Silicon（M 系列） | 文件名包含 `arm64` 的 `.dmg` 或 `.zip` |
| Mac · Intel | 文件名包含 `x64` 的 `.dmg` 或 `.zip` |

macOS 最低版本按当前构建配置为 **macOS 13**。Linux 提供源码构建命令，是否有预构建下载请以对应 Release 的附件为准。

> 当前发布包未进行代码签名，macOS 也未进行 Apple 公证，首次安装或打开时可能出现系统安全提示。请从官网或本仓库发布页获取文件；Mac 安装遇到拦截时，可按系统“隐私与安全性”中的提示处理。

下载后，按官网流程连接账号，或在应用设置中配置所需的 AI 服务，然后创建或导入项目。官网模型服务按实际使用计费，开源软件许可证不包含模型服务额度。

## 功能一览

| 工作区 | 可以做什么 |
| --- | --- |
| **灵感台** | 讨论玩法与实现方案，引用项目知识，按需联网检索、分析日志、检查 JAR，并查看来源与证据。 |
| **AI 开发工作台** | 接入 Codex、Claude 等 Agent，结合文件与文档附件处理任务，管理对话、历史恢复与任务状态。 |
| **项目与代码** | 创建或导入项目，编辑文件，处理依赖、Git、快照、版本迁移与构建问题。 |
| **图像与模型** | 使用图片生成预设和节点工作流，编辑贴图，通过 MiniPaint 与 Blockbench 处理图片和模型资源。 |
| **整合包与内容** | 导入 Modrinth / CurseForge 整合包，管理模组、配置、资源包、自制模块、FTB Quests 与 Patchouli 内容。 |
| **测试与服务端** | 执行构建、客户端/服务端检查、GameTest 和玩家测试，查看运行日志与诊断结果。 |
| **插件与外观** | 安装扩展面板和工具，使用主题配色、自定义颜色及图片/视频背景。 |

### 项目类型

- **Java 模组**：Fabric、Quilt、Forge、NeoForge。
- **服务端插件**：Paper、Spigot、Folia、Velocity。
- **Add-on 与网易项目**：国际基岩版、网易 PC 和网易手游。
- **整合包与资源**：整合包、资源包、任务书、图片和模型相关工作流。

不同平台与 Minecraft 版本的构建和测试能力有所区别，以项目界面中的可用功能为准。

### 真实游戏交互测试

Java 模组的真实界面测试实验性接入 [Minecraft Mod MCP](https://github.com/langyo/minecraft-mod-mcp)。支持的版本与加载器组合可以启动隔离客户端，获取原生截图和状态，并执行点击、输入、按键等玩家操作。

该能力不是全版本通用；目录中有适配包不代表已经实测兼容，启动成功也不等于玩法验收通过。完整能力、实测范围和限制见 [接入与验证说明](docs/minecraft-mcp-integration.zh-CN.md)。

## 本地开发

使用 **Node.js 22**。首次克隆后执行：

```sh
git clone https://github.com/waterpail114514/modmind.git
cd modmind
npm ci
npm run dev
```

### 检查与测试

`npm test` 包含独立 MCP 仓库的测试，因此首次运行前还需检出该仓库。下面的提交与当前 macOS CI 固定版本一致：

```sh
git clone https://github.com/waterpail114514/ModMind-MCP.git modmind-mcp-open-source
git -C modmind-mcp-open-source checkout f21d65950f255243e941554d1463729ad1056b41
```

```sh
npm run typecheck
npm test
npm run build
```

构建前会自动检查主题颜色与插件模板是否和源码一致。部分集成测试需要 Java 或额外运行环境，请同时查看测试输出中的跳过项。

### 构建安装包

| 平台 | 命令 | 构建条件 |
| --- | --- | --- |
| Windows 未签名 | `npm run dist:win:unsigned` | 在 Windows 上运行 |
| Windows 签名 | `npm run dist:win` | 配置有效签名身份 |
| macOS 未签名 | `npm run dist:mac:unsigned` | 在对应架构的 Mac 上运行 |
| macOS 签名与公证 | `npm run dist:mac` | 对应架构的 Mac，以及 Apple 签名和公证凭据 |
| Linux | `npm run dist:linux` | 输出 AppImage 和 ZIP |

**没有 Mac 也可以构建。** 在 GitHub Actions 中运行 [Validate macOS](https://github.com/waterpail114514/modmind/actions/workflows/build-macos.yml)，云端会分别构建 arm64 和 x64，执行测试、打包应用启动检查和归档校验。通过后可从运行页面下载附件。

<details>
<summary><strong>维护者配置与更新分发</strong></summary>

设备授权网站由 `MODMIND_SITE_URL` 或 `resources/service-config.json` 的 `siteUrl` 指定，必须是 HTTPS 源地址，不能包含路径、查询参数或凭据。桌面协议为 `mcdev://`。

Windows 更新地址由 `MODMIND_UPDATE_URL` 或同一文件中的 `updateUrl` 指定，必须使用 HTTPS。**GitHub 发布附件与应用配置的更新源是两个位置**；使用对象存储时，还需单独同步更新文件。

Windows 更新文件位于 `release/update`。稳定版使用 `latest.yml`，预发布版使用 `beta.yml`。上传顺序为安装包、blockmap、最后 YAML；不要用预发布元数据覆盖稳定版。保留旧安装包和 blockmap，以便跨版本差分更新。

`npm run version:patch` 会同步更新 `package.json` 与 `package-lock.json`，不会自动创建 Git 标签。

测试运行器按需下载 Java、Minecraft 资源和加载器。Java 模组构建使用项目固定的 Gradle Wrapper：Windows 为 `gradlew.bat`，macOS/Linux 为 `./gradlew`，Gradle 版本由项目配置决定。

新项目使用 `modmind.project.json` 与 `.modmind`，同时兼容旧版 ModTool 的 `modtool.project.json` 与 `.modtool` 布局。

</details>

## 文档与社区

| 入口 | 内容 |
| --- | --- |
| [ModMind 官网](https://ether-studio.top/) | 客户端下载、使用流程、账号与模型服务 |
| [发布记录](https://github.com/waterpail114514/modmind/releases) | 安装包、更新日志与校验文件 |
| [问题反馈](https://github.com/waterpail114514/modmind/issues) | 报告问题与提出建议 |
| [插件开发指南](docs/plugin-development.zh-CN.md) | 插件清单、面板、工具与权限 |
| [真实交互测试说明](docs/minecraft-mcp-integration.zh-CN.md) | 支持范围、测试方式与限制 |
| [Fabric API 测试策略](docs/fabric-api-test-policy.zh-CN.md) | 测试实例的 API 管理配置 |
| [ModMind-MCP](https://github.com/waterpail114514/ModMind-MCP) | 独立维护的 MCP 服务 |

参与开发前请阅读 [贡献说明](CONTRIBUTING.md)。提交时只包含相关源码与必要资源，避免上传本地缓存、凭据和测试运行数据。

## 开源与授权

项目原创代码自 `1.4.4` 起采用 **[AGPL-3.0-only](LICENSE)**；`1.4.3` 及更早版本已发布的 MIT 授权不被撤销。

第三方组件与内置工具适用各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。ModMind 名称与标志的商标权不随软件许可证授予，见 [商标说明](TRADEMARKS.md)。
