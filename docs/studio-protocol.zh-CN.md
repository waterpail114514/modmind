# 领域工作台接入协议 v1

开发入口见 [mmfeature 与 mmstudio 开发文档](extensions-development.zh-CN.md)，新包的完整最小示例和接入步骤见 [mmstudio 工作台包开发指南](mmstudio-development.zh-CN.md)。本文保留详细协议与既有验收记录。

“领域工作台”（studio）是模组、整合包、服务端插件或自定义领域的创作环境；其中的“工作台”是实施与验证的 AI 页面，“灵感台”是讨论与研究的 AI 页面。每个领域必须同时声明两份 AI profile，分别提供提示词、skills、欢迎语和推荐问题。只读约束和项目边界由宿主执行，提示词不能扩大权限。

## 模块与安装

| 模块 ID | 领域 ID | 交付方式 |
| --- | --- | --- |
| `studio-mod` | `minecraft-mod` | 随软件内置，Java、基岩与网易模组 |
| `studio-modpack` | `minecraft-modpack` | 随软件内置，复用现有整合包服务 |
| `studio-server-plugin` | `minecraft-server-plugin` | 随软件内置，Paper、Spigot、Folia、Velocity |

三个模块保持源码和协议独立，运行时直接从应用资源目录加载。构建先生成 `resources/bundled-studios/<模块 ID>/`，安装器将目录及 schemaVersion 2 索引作为 extraResources 打包。宿主校验每个声明文件的 SHA-256。没有首次启动安装步骤、用户安装副本或预装历史文件；内置模块不能停用、卸载或用商店包替换，只随软件更新。旧用户目录中的同 ID 副本保留，但不加载。

自定义领域包使用 `.mmstudio`，继续复用 `.mmfeature` 的 ZIP 容器、API 2 加载器、信任确认、完整性校验、依赖、事件和动作权限通道。清单 `format` 为 `modmind-feature`，领域 `apiVersion` 为 1。旧 `.mmfeature` 也可声明领域；后缀不授予额外权限。所有领域保留两个 AI 页面，可按现有贡献接口增加业务页面、设置和工具。

安装提供领域能力，不会自动扫描或接管任何项目。图像、模型、声音、测试、发布等按需复用已有功能引擎；工作台内置或安装不意味着下载游戏、JDK 或其他功能。

## 声明与创建

类型定义位于 `src/shared/studios.ts`，SDK 从 `feature-plugins/sdk/studio.ts` 导出。清单需要名称、全局唯一领域 ID、projectKind、支持平台、默认目标、templateHandler、双 AI profile。完整基础示例见三个模块的 `manifest.json`。

新建页面只显示可用于创建项目的工作台，不再提供“自定义 +”安装入口。其他工作台统一在“功能”页安装，仍复用本地安装与信任确认流程；安装完成后可在新建项目中选择。选项较多时列表横向滚动，当前选项保持可见，切换工作台保留各自表单草稿。

`creation.fields` 完全声明新建项目表单，核心不按领域类型预设字段。新建页面只读取已安装、启用且就绪的模块清单；商店目录仅用于发现与缺失项目恢复，不提供未安装工作台的选项或表单。停用、卸载后对应选项立即消失。示例：

```json
{
  "creation": {
    "fields": [
      { "id": "name", "title": "项目名称", "type": "input", "bind": "name", "required": true, "maxLength": 80 },
      { "id": "loader", "title": "语言", "type": "options", "bind": "loader", "default": "glsl", "options": [{ "value": "glsl", "title": "GLSL" }] },
      { "id": "version", "title": "格式版本", "type": "input", "bind": "minecraftVersion", "default": "1", "required": true },
      { "id": "quality", "title": "品质", "type": "select", "default": "balanced", "options": [{ "value": "balanced", "title": "均衡" }, { "value": "cinematic", "title": "电影" }] }
    ]
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `id`, `title`, `type` | 唯一字段 ID、显示标题、`input` 输入框 / `options` 选项框 / `select` 下拉框 |
| `bind` | 绑定项目 `name`、`loader` 或 `minecraftVersion`；未绑定字段作为领域自定义配置 |
| `default`, `required`, `placeholder`, `maxLength` | 默认值、必填、输入占位与长度限制 |
| `readOnly` | 固定显示默认值，控件不可修改；必须声明有效 `default`，不可使用动态来源。IPC / MCP 同样拒绝修改 |
| `options` | 静态选项，每项有 `value`、`title`，可带 `when` |
| `when` | 字段或选项的条件，如 `{ "edition": ["java"] }`；全部条件满足时显示 |
| `source` | 现有动态版本目录，例如 `{ "kind": "loader-versions", "loaderField": "loader" }` |

自定义目标可以使用新的平台 ID；静态版本可用输入框或自定义下拉选项。`minecraftVersion` 为兼容原项目数据保留的目标版本字段，并不强制自定义领域采用 Minecraft 版本格式。只有现有 Minecraft 平台调用原兼容目录；独立平台由工作台自身验证和执行领域任务。

整合包与服务端插件的清单各自声明 `{ "id": "edition", "title": "游戏版本", "type": "options", "default": "java", "readOnly": true, "options": [{ "value": "java", "title": "Java 版" }] }`。宿主不按 projectKind 添加游戏版本字段；非 Minecraft 工作台可以完全省略这些控件。

UI 按声明渲染三种控件及标题，依赖改变时重选有效选项。动态目录按需调用既有缓存服务，提供失败提示和刷新重试，断网可使用已有内置基线。表单值保存为 `ProjectInfo.studioValues` 并传给创建实现。宿主分别校验清单、重复 ID / 绑定、条件引用、选项来源及提交值；未知字段、无效选项、缺少必填和目标不一致均拒绝。为兼容早期 v1 包，creation 可省略，但省略的包不提供 UI 新建表单。

`activate()` 返回 `{ studios: { <handler>: provider } }`。创建 provider 提供 `templateFiles(project, includeStarter)` 或异步 `scaffold(project)`。文本模板在写入前统一校验路径和总大小；异步实现只能操作传入目录。草稿创建在暂存目录生成，检查冲突后发布，项目元数据最后提交。

## 接管协议

领域声明可增加：

```json
{ "adoption": { "handler": "shader", "priority": 100, "markers": ["shader-project.json"] } }
```

markers 是项目根目录内的相对文件路径，任一命中后调用识别器；空数组用于需要内容分析的识别器。禁止绝对路径、父目录与链接文件。识别按 priority 从高到低执行，ID 用于同优先级的稳定排序。声明过接管但模块未就绪且标记命中时，返回对应工作台名称和不可用状态，不交给其他领域错误接管。卸载后未知领域仍可通过已有项目元数据显示恢复名称；宿主不会为未声明的陌生文件推测远端工作台名称。

对应 runtime handler 必须实现：

```ts
interface AdoptionProvider {
  inspectExisting(sourcePath: string): Promise<ExistingProjectAnalysis | null>
  adoptExisting(input: ExistingProjectAdoptInput, analysis: ExistingProjectAnalysis): Promise<StudioAdoptionPlan>
}
```

识别器返回 null 表示不匹配；返回值包括 sourcePath、sourceName、kind、文件数量、关键文件、识别理由和 inferred 目标。宿主限制返回目录在选定来源内、核对数量、结果类型及所属领域，然后补上 studio ID、名称与安装状态。执行前重新识别并校验目标，避免提交旧识别结果。自定义识别器不得执行来源中的代码。

自定义领域目前返回 `{ mode: 'in-place' }`，适用于完整项目文件夹；宿主独占创建 `modmind.project.json`，保留原源码与构建文件，写入工作台身份，再回读验证。已有 ModMind 项目要求直接打开，重复接管不会覆盖它。自定义包暂不支持压缩包接管、参考资料生成新目录或自由指定其他输出路径；扩展这些能力需要额外宿主策略。

三个内置模块复用现有识别、导入和整合包业务服务，返回 host-managed 结果。该模式只向内置模块开放。Mod / 服务端插件完整工程保留源码和构建，压缩来源或残缺源码按原流程选择目标目录；整合包沿用清单解析、下载活动及失败重试。后续领域不需要修改核心类型分支便能接入识别与原地接管。

安装并不自动接管；“接管现有项目”仍要求选择来源、核对识别结果并执行。只有 JAR 等产物不等于拥有原工程，反编译与源码恢复属于另一个功能。接管完整工程不等于构建或实际游戏验证成功。

## AI、技能与任务

两份 profile 分别提供 instructions、skills，可声明 greetings、starters，以及按 loaders 覆盖技能列表并追加指引的 variants。同一 profile 的平台分支不能重复。提示词支持 `{{name}}`、`{{loader}}`、`{{version}}`、`{{apiVersion}}`、`{{javaVersion}}`。

skillAssetGroup 引用包资源组，目录为 `<skill-name>/SKILL.md`。构建按两份 profile 及平台分支复制所需技能，实际运行按页面同步；草稿初始化后刷新领域技能，保留用户独立 skills。正文按需读取，不整体塞进提示词。

`tasks.check/build/test/export` 指向已有 action，可为 `{ action: 'check' }` 或 `{ pluginId: 'dependency', action: 'check' }`，可用 `input` 指定默认参数，例如 `{ action: 'query', input: { operation: 'validate' } }`。调用参数覆盖默认值，合并后仍通过目标 action schema 校验。必需组件声明包级依赖；可选功能可以仅作跨包任务引用，调用时仍要求目标包就绪，不得为任务引用引入循环依赖。任务复用既有参数 schema、只读、项目与审批边界，不复制构建引擎；宿主构建 / 导出优先派发已声明的领域任务。需要 AI 调用的业务继续声明 tools，通过既有发现与动作路由接入。

可选 `navigation.hideCoreViews: ['build']` 隐藏不适用的通用构建页，两个 AI 页面和项目代码编辑器始终保留；`navigation.compactSidebar: true` 在窄窗口的领域功能页优先显示可展开紧凑导航。动作可声明 `studioIds` 限定领域，工具发现会过滤，实际调用仍需核对当前项目领域。

## MCP 与项目状态

- `modmind_feature_catalog` 返回领域身份、创建字段、接管声明与可用状态。
- `modmind_project_setup` 接受 studioId、kind、目标与 studioValues，复用校验和创建服务初始化当前草稿。灵感台禁止创建。
- `modmind_project_info` 返回当前项目领域、页面指引、技能与状态。
- `modmind_studio_inspect` 识别当前项目内的完整工程子目录，路径必须为相对目录，禁止越过项目及真实路径边界。
- `modmind_studio_adopt` 复用同一接管接口，在子目录写入并回读元数据，返回 verified 和项目路径，保持前台项目及会话。需要操作审批，灵感台禁止写入。MCP 不接管外部目录、压缩包、整合包或残缺参考资料，这些使用 UI 入口。
- UI 查询使用 `window.modmind.studios.list()` / `context(surface, projectPath)`；上下文查询拒绝切换后的旧项目路径。

新项目保存 studioId、studioName 和 studioValues。旧三种 kind 解析到固定领域 ID；自定义领域不会抢占旧项目。未知 ID 不降级为模组。缺失工作台时最近项目灰显，显示需要下载的名称及恢复入口；打开和 AI 操作在宿主端同样拒绝。恢复模块后项目可继续使用，源码、会话和保存数据保留。

模块安装、停用、卸载沿用活动任务保护；异步创建与接管调用计入活动调用。原生插件拥有应用本地权限，这些校验是集成边界，并非代码安全沙箱；安装始终保留来源信任确认。

## 构建与维护

```powershell
node scripts/prepare-bundled-studios.mjs
npm run typecheck
npx vitest run src/main/studioRegistry.test.ts src/main/bundledStudioService.test.ts src/main/draftProjectService.test.ts src/main/externalAgents.test.ts
npm run build
node scripts/studio-protocol-smoke.mjs
```


复用 [Ajv 8.20.0](https://github.com/ajv-validator/ajv)（MIT）、React、Electron 和已有 ZIP 加载器；参考 [VS Code](https://github.com/microsoft/vscode)（MIT）的声明贡献点。选用现有结构是因为已有校验、生命周期与离线加载能力，无须另加前端模块联邦或 IDE。表单和派发属于小型集成逻辑，不重复实现领域引擎。

## 验证与边界

隔离且首次离线的 Electron 验证三个内置模块无需用户安装副本；三类实际创建、Mod / 插件原地接管、双 AI profile、不同技能及 Velocity 目标均有回读证据。临时测试光影包验证自定义平台、三种声明控件、安装信任取消后重试、输入保留、自定义原地接管、缺失模块项目灰显及恢复。真实 MCP 走过发现、声明查询、识别、接管、文件回读、越界拒绝及保持前台项目；只读拒绝另有真实 MCP 回归。

测试会在 `test-results/studio-protocol/<时间>/` 保存结果和深浅主题、1280px / 390px 实际截图。协议阶段的临时光影包仅为测试；后续实际开发的独立光影模块见 [光影工作台](shader-studio.zh-CN.md)。尚未提供可视化工作台编辑器、任意布局编辑器或自定义领域通用游戏测试引擎；自定义领域需声明并实现自己的领域动作。没有生成或安装新的安装器，安装包资源配置已接入；实际游戏玩法仍需单独验收。

实施前源码检查点为 `48eedcd0`。旧安装包、浏览器数据和测试输出保留，未纳入该提交。

2026-10-05 表单修正验收：类型检查、主程序构建、主题及插件界面检查通过；创建贡献、工作台注册与内置加载 11 项测试通过，其中真实 MCP 验证固定 Java 字段不可篡改。隔离 Electron 协议 12 条场景及光影 7 条场景通过，无页面脚本错误。新记录为 `test-results/studio-protocol/1791206723458/result.json`、`test-results/shader-studio/1791206723462/result.json`；已检查桌面及 390px 的 Java 固定选项和非 Minecraft 文稿表单实际截图，验证未安装光影不显示、文稿三种字段创建与回读、停用输入保留及卸载后选项消失。测试文稿包仅用于验收，不随软件发布。未生成新安装器。

2026-10-05 最终验收：双端类型检查、主程序构建、主题与插件界面检查通过。协议 / 草稿 / 内置 / 外部 Agent 回归 207 项通过、1 项原有跳过；插件服务、商店等定向回归 39 项通过；发布器及固定范围移除回归 12 项通过。最后补充的默认值与草稿回归 16 项通过。真实 Electron 和 MCP 共 11 条场景通过，无页面脚本错误，记录为 `test-results/studio-protocol/1791167088551/result.json`，包含 Windows 路径别名、ZIP 持久目录、旧 .modtool 数据保留及默认值回读。远端与本地发布目录复查均为 20 项功能、0 项基础工作台，发布目录内也没有三个基础工作台的安装包。
