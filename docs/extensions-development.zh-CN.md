# mmfeature 与 mmstudio 开发文档

ModMind 的原生扩展分为功能包 `.mmfeature` 和领域工作台包 `.mmstudio`。二者共享安装器、API 2 运行时、完整性校验、动作调用和 MCP 接入；工作台包额外声明项目领域、创建方式与 AI 上下文。本文是开发入口，接口和示例按 2026-10-07 的仓库源码整理。

## 选择包类型

应用内开发可从项目选择页进入 [ModMind 开发者工作台](developer-workbench.zh-CN.md)，使用内置 SDK 完成创作、预览、调试和导出；以下源码仓库路径与命令用于仓库开发方式。

| 需求 | 包类型 | 开发指南 |
| --- | --- | --- |
| 给已有项目增加编辑、查询、预览、测试、导出或设置 | `.mmfeature` | [功能包开发](mmfeature-development.zh-CN.md) |
| 增加一种创作领域，定义项目创建、接管与两份 AI profile | `.mmstudio` | [工作台包开发](mmstudio-development.zh-CN.md) |
| 新领域需要多个能分别安装、停用的工具 | 一个 `.mmstudio` 加若干 `.mmfeature` | [光影工作台与五个功能包](shader-studio-development.zh-CN.md) |
| 开发第三方 iframe 面板或 `plugin.json` 扩展 | 第三方插件系统 | [第三方插件开发](plugin-development.zh-CN.md) |

工作台包可以同时贡献页面、设置、动作和工具；按用户是否需要独立安装与启停决定拆分。构建器根据 `studios` 是否非空选择包后缀，改文件名不会改变权限或能力。

## 阅读顺序

1. 阅读 [ModMind 设计规范](design-spec.zh-CN.md)，确定任务范围、已有能力、复用方案与 MCP 需求。
2. 按上表选择指南，完成其中的最小示例。
3. 对照类型、校验器和相近源码扩展业务逻辑；UI 与 MCP 共用业务服务。
4. 单包构建、本地安装，再验证真实交互、MCP 调用与异常恢复。

## 当前兼容基线

| 项目 | 当前值或规则 |
| --- | --- |
| 主程序仓库版本 | `package.json` 的 `1.5.0-preview.3` |
| 包 `format` | `modmind-feature`，两类包相同 |
| 包 `apiVersion` | `2`；API 1 原生功能包会被拒绝 |
| 包 `hostVersion` | 精确匹配 `1.5.0-plugintest`，这是协议标识 |
| 包发行 `version` | 构建与官方发布要求三段数字，例如 `1.0.0` |
| `studios[].apiVersion` | `1`，与包 API 版本分开 |
| 领域能力标记 | 工作台包声明 `hostCapabilities: ["studioV1"]` |
| 包体限制 | ZIP 64 MiB；解压总内容 128 MiB；最多 512 个被校验文件，另加清单 |
| 执行权限 | 可信原生代码拥有应用本地权限；安装须确认来源信任 |

不要用应用版本替换 `hostVersion`，也不要从旧试验交付记录复制 API 1 清单或 32 MiB 包体限制。新增宿主接口应增加对应能力标记，并在目标主程序中验证；相同版本字符串不能证明接口存在。

三个基础工作台 `studio-mod`、`studio-modpack`、`studio-server-plugin` 随软件内置，只随主程序更新，不能停用、卸载或作为商店包替换。自定义工作台和其他功能包按需安装。

## 源码与维护文档

| 查什么 | 来源 |
| --- | --- |
| 包清单、动作、事件、前端 API 类型 | [featurePlugins.ts](../src/shared/featurePlugins.ts) |
| 领域、表单、AI profile、任务与 provider 类型 | [studios.ts](../src/shared/studios.ts) |
| 领域 JSON Schema | [studioSchema.ts](../src/shared/studioSchema.ts) |
| 领域与平台适用范围 | [featureApplicability.ts](../src/shared/featureApplicability.ts) |
| 安装、校验、激活、动作调用与资源访问 | [featurePluginService.ts](../src/main/featurePluginService.ts) |
| 项目创建 provider、领域任务与接管注册 | [studioRegistry.ts](../src/main/studioRegistry.ts) |
| 前端页面与设置类型 | [featurePluginTypes.ts](../src/renderer/src/featurePluginTypes.ts) |
| 共享宿主运行时 | [featureHostRuntime.ts](../src/main/featureHostRuntime.ts) |
| 构建与后缀选择 | [build-feature-plugins.mjs](../scripts/build-feature-plugins.mjs) |
| 英文 API 2 合同 | [HOST-CONTRACT.md](../feature-plugins/HOST-CONTRACT.md) |
| 领域协议与既有验收记录 | [studio-protocol.zh-CN.md](studio-protocol.zh-CN.md) |
| 功能拆分和历史交付记录 | [feature-plugins.zh-CN.md](feature-plugins.zh-CN.md) |

开发指南说明如何接入，历史文档记录某次交付的结果。更改协议时同步指南、类型、校验器和测试；真实游戏兼容、在线服务和发布状态仍需针对目标版本单独验证。
