# ModMind

![ModMind Logo](resources/readme-logo.png)

ModMind 是一个面向 Minecraft Mod 开发的 AI 辅助工作台，帮助你管理项目、模组、资源包、整合包和服务器工作流。

## 当前版本：1.4.8

- 增强灵感台联网检索、项目知识引用和分析功能，支持查看来源与证据。
- 改进模型上下文配置、长任务保护和 AI 错误提示。
- 修复对话删除后的历史恢复问题，优化项目加载和消息回放。
- 改进 Codex 运行时缓存清理及界面细节。
- 移除 Herobrine。

## 下载

请前往 [GitHub Releases](https://github.com/waterpail114514/modmind/releases) 下载最新版本。Windows 安装包包含自动更新所需的 `latest.yml` 和 blockmap；未签名版本首次运行时可能显示 SmartScreen 安全提示。

macOS 预览包未进行 Apple 签名和公证，首次打开时请在系统设置中允许，或右键应用选择“打开”。

## 开源协议

ModMind 使用 GNU Affero General Public License v3.0 only（`AGPL-3.0-only`）。第三方组件和内置工具继续适用各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## MCP 服务

独立 MCP 服务维护在 [ModMind-MCP](https://github.com/waterpail114514/ModMind-MCP) 仓库。


## 本地开发

建议使用 Node.js 22。在项目目录执行：

```sh
npm ci
npm run dev
```

提交或打包前运行：

```sh
npm run typecheck
npm test
npm run build
```

ModMind 支持 Fabric、Quilt、Forge 和 NeoForge 项目的创建与迁移，提供 Monaco 文件编辑、VS Code Java 语言服务与调试工作区生成、本地及远程 Git 操作、可恢复的项目快照、Modrinth 与 Maven 依赖锁定、数据与资源 JSON 编辑、内嵌 Blockbench、客户端/服务端/GameTest 验证、CI 生成及发布预检。

Agent 可以按项目的 Minecraft 版本查询 `mappings.dev` 映射信息。类索引和已查看页面会缓存在本地，手动映射视图使用相同数据源。

新项目使用 `modmind.project.json` 与 `.modmind` 目录，同时兼容早期 ModTool 项目的 `modtool.project.json` 与 `.modtool` 布局。首次启动 ModMind 时会迁移旧应用数据。

## 运行与服务配置

设备授权网站由 `MODMIND_SITE_URL` 指定；发布构建也可在 `resources/service-config.json` 中设置 `siteUrl`。该值必须是 HTTPS 源地址，不能包含路径、查询参数或凭据。桌面协议为 `mcdev://`。

Windows 更新服务由同一配置文件的 `updateUrl` 或环境变量 `MODMIND_UPDATE_URL` 指定，必须使用 HTTPS。GitHub Release 附件和实际配置的更新服务是两个发布位置；使用对象存储更新源时，还需同步更新文件。

测试运行器按需下载托管 Java、Minecraft 资源和所选加载器。启动测试时执行真实的 Gradle Wrapper 构建，同步项目 JAR，保留用户自行添加的依赖模组，并使用确定性的离线游戏档案。

Windows 直接运行项目的 `gradlew.bat`，macOS/Linux 运行 `./gradlew`。Gradle 版本由项目 Wrapper 配置决定，ModMind 不会另行安装或回退到独立 Gradle 运行时。

## 构建安装包

| 平台 | 命令 | 说明 |
| --- | --- | --- |
| Windows 未签名 | `npm run dist:win:unsigned` | 在 Windows 上构建，用于未签名分发 |
| Windows 签名 | `npm run dist:win` | 需要有效的签名配置 |
| macOS 未签名 | `npm run dist:mac:unsigned` | 需要对应架构的 macOS；可运行 GitHub Actions 的 Validate macOS |
| macOS 签名 | `npm run dist:mac` | 需要 Apple 签名证书和公证凭据 |
| Linux | `npm run dist:linux` | 生成 AppImage 和 ZIP |

Windows 打包会生成 NSIS 安装包和更新元数据，并执行版本、体积及签名策略检查。自动更新文件位于 `release/update`：稳定版使用 `latest.yml`，预发布版使用 `beta.yml`，预发布版不能覆盖稳定版元数据。向更新服务上传时，先上传安装包和 blockmap，最后上传 YAML；保留旧安装包和 blockmap，以便跨版本更新。

当前版本为 `1.4.8`。以后发布补丁版本时，可使用 `npm run version:patch` 同步更新 `package.json` 与 `package-lock.json`，该命令不会自动创建 Git 标签。

## 参与开发

仓库默认分支为 `main`，远程地址为 `https://github.com/waterpail114514/modmind.git`。提交前检查 `git status`、`git diff` 和测试结果，只暂存本次修改涉及的源码及必要资源，避免上传本地缓存或测试运行数据。

提交说明建议使用 `feat`、`fix`、`docs`、`test`、`build` 或 `chore` 等类型。GitHub 凭据应保存在凭据管理器中，不要写入远程地址或受版本控制的文件。贡献条款见 [CONTRIBUTING.md](CONTRIBUTING.md)。

从 `1.4.4` 起，项目原创代码采用 AGPL-3.0-only；`1.4.3` 及更早版本已发布的 MIT 授权不被撤销。完整许可见 [LICENSE](LICENSE)。ModMind 名称与标志不随软件许可证授予商标权，详见 [TRADEMARKS.md](TRADEMARKS.md)。
