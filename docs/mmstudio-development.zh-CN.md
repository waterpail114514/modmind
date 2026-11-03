# mmstudio 工作台包开发指南

`.mmstudio` 定义一种创作领域：项目类型与目标、创建表单、工程模板、已有项目接管、工作台和灵感台两份 AI profile，以及领域任务。它在 [mmfeature API 2](mmfeature-development.zh-CN.md) 上增加 `studios` 贡献；先阅读 [开发入口与兼容基线](extensions-development.zh-CN.md)。

## 1 包身份与领域身份

| 标识 | 示例 | 使用位置 |
| --- | --- | --- |
| 包 ID | `studio-notes` | 安装、依赖、动作调用、资源目录 |
| 领域 ID | `notes-domain` | 项目 `studioId`、功能 `studioIds`、AI 上下文 |
| 项目类型 | `notes` | 项目 `kind` 与领域 `projectKind` |
| 平台 ID | `markdown` | 项目 `loader` 与领域 `loaders` |
| provider 名 | `notes` | `templateHandler` 与 runtime.studios 的键 |

这些值不必相同。后缀由清单非空 `studios` 决定；一个包可以声明多个领域。工作台包仍用 `format: "modmind-feature"`、包 `apiVersion: 2`、固定 `hostVersion: "1.5.0-plugintest"`，每个领域单独使用 `apiVersion: 1` 并要求宿主 `studioV1`。

三个 Minecraft 基础工作台随软件内置，源码位于 `studio-mod`、`studio-modpack`、`studio-server-plugin`；自定义包不要复用其包 ID 或固定领域 ID。新增工作台通常只增加包和贡献，不增加核心类型分支。

## 2 最小示例

在 `feature-plugins/studio-notes/` 创建以下三个文件。示例提供独立 Markdown 文稿领域，支持新建项目和两份 AI 上下文；接管与构建任务在后续章节按需加入。

### manifest.json

```json
{
  "format": "modmind-feature",
  "apiVersion": 2,
  "hostVersion": "1.5.0-plugintest",
  "id": "studio-notes",
  "name": "文稿工作台",
  "version": "1.0.0",
  "main": "main.cjs",
  "renderer": "renderer.js",
  "style": "renderer.css",
  "hostCapabilities": ["studioV1"],
  "capabilities": [
    { "id": "notes-authoring", "name": "文稿工作台", "description": "创建 Markdown 文稿项目，提供写作与研究的 AI 上下文。" }
  ],
  "views": [],
  "actions": [],
  "tools": [],
  "studios": [
    {
      "apiVersion": 1,
      "id": "notes-domain",
      "name": "文稿工作台",
      "projectKind": "notes",
      "loaders": ["markdown"],
      "defaultTarget": { "loader": "markdown", "version": "1" },
      "templateHandler": "notes",
      "navigation": { "hideCoreViews": ["build"] },
      "creation": {
        "fields": [
          { "id": "name", "title": "项目名称", "type": "input", "bind": "name", "required": true, "maxLength": 80 },
          { "id": "loader", "title": "文稿格式", "type": "options", "bind": "loader", "default": "markdown", "readOnly": true, "options": [{ "value": "markdown", "title": "Markdown" }] },
          { "id": "version", "title": "格式版本", "type": "input", "bind": "minecraftVersion", "default": "1", "readOnly": true },
          { "id": "style", "title": "文稿类型", "type": "select", "default": "essay", "options": [{ "value": "essay", "title": "文章" }, { "value": "notes", "title": "笔记" }] }
        ]
      },
      "ai": {
        "workbench": {
          "instructions": "Help write and revise the Markdown project {{name}}. Inspect existing files before edits, preserve drafts and verify saved content. Discover available tools before using them.",
          "skills": [],
          "greetings": ["开始整理这篇文稿。"],
          "starters": [{ "title": "整理结构", "prompt": "读取当前文稿，整理章节结构并保留原有内容。" }]
        },
        "inspiration": {
          "instructions": "Research and discuss the Markdown project {{name}}. Read files and cite evidence; keep project content unchanged.",
          "skills": [],
          "greetings": ["先把想法和资料理清楚。"],
          "starters": [{ "title": "讨论提纲", "prompt": "结合当前文稿讨论提纲与需要补充的资料。" }]
        }
      }
    }
  ]
}
```

### main.ts

```ts
import type { StudioRuntime } from '../sdk/studio'

export function activate(): StudioRuntime {
  return {
    studios: {
      notes: {
        templateFiles(project, includeStarter) {
          return {
            'notes-project.json': JSON.stringify({
              format: 1,
              style: project.studioValues?.style ?? 'essay'
            }, null, 2) + '\n',
            ...(includeStarter ? { 'draft.md': `# ${project.name}\n\n` } : {})
          }
        }
      }
    }
  }
}
```

### renderer.ts

```ts
import { registerFeature } from '../sdk/renderer'

registerFeature('studio-notes', { apiVersion: 2, pages: [] })
```

```powershell
node scripts/build-feature-plugins.mjs --only=studio-notes
npm run dev
```

在“功能”页本地安装 `feature-plugin-dist/studio-notes.mmstudio` 并确认来源信任，新建项目选择“文稿工作台”。成功后应有 `notes-project.json`、`draft.md` 和宿主生成的 `modmind.project.json`；元数据保存领域 `notes-domain`、项目类型 `notes`、平台 `markdown`、版本 `1` 与表单值。两个 AI 页面和代码编辑器由宿主保留，无须重复声明。

## 3 领域声明与表单

类型来源为 [studios.ts](../src/shared/studios.ts)，完整校验来源为 [studioSchema.ts](../src/shared/studioSchema.ts)。必填项是 `apiVersion`、`id`、`name`、`projectKind`、`loaders`、`defaultTarget`、`templateHandler`、`ai`。默认 loader 必须在支持列表中。

`creation.fields` 让宿主渲染表单，不需要修改新建页面。只有已安装、启用且就绪，并声明 creation 的领域会成为新建选项；在线目录中的元数据不提供未安装领域的表单。省略 creation 的旧 v1 包仍可兼容，但没有 UI 新建表单。

| 字段 | 行为 |
| --- | --- |
| `id`、`title`、`type` | 唯一字段名、标题、`input` / `options` / `select` |
| `bind` | 绑定项目 `name`、`loader`、`minecraftVersion`；未绑定项作为自定义配置 |
| `default`、`required`、`maxLength` | 字符串默认值、必填与长度限制；按实际格式设置 |
| `readOnly` | 固定默认值，UI、IPC 和 MCP 均拒绝篡改；不能使用动态来源 |
| `options` | `{ value, title, when? }` 静态选项；值不能重复 |
| `when` | `{ "其他字段ID": ["允许值"] }`，所有条件同时满足才可见 |
| `source` | `select` 可用 `{ "kind": "loader-versions", "loaderField": "loader" }`，被引用字段必须绑定 loader |
| `placeholder` | 必要的输入占位，不承担长篇说明 |

字段 ID 和绑定不得重复；条件只能引用已声明的其他字段，不能引用自身。`options` / `select` 必须提供选项或支持的动态来源；动态来源不能和静态 options 并用。字段值均为字符串，保存到 `ProjectInfo.studioValues` 并传给 provider。实际提交还会核对必填、只读、条件、选项和项目目标的一致性。

自定义 loader 可使用新的平台 ID。兼容名称 `minecraftVersion` 对自定义领域表示目标版本，不要求使用 Minecraft 版本格式；自定义平台也不会自动获得 Minecraft 动态版本目录、Gradle 或游戏测试能力。

## 4 创建 provider

`activate()` 返回 `{ studios: { [templateHandler]: provider } }`，provider 必须提供以下至少一个入口：

```ts
templateFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string>
scaffold(project: ProjectInfo): Promise<void>
```

小型文本模板优先用 `templateFiles()`，由宿主统一验证并写入。当前限制为最多 4096 个文件、合计 32 MiB 文本；路径使用相对路径和 `/`，拒绝父目录、非法字符和 Windows 保留名称。不要由 provider 自行写入 ModMind 项目元数据。

需要异步生成时用 `scaffold()`，只能操作传入项目目录并复用已有下载、进程与构建设施。草稿在暂存目录生成，检查冲突后发布，项目元数据最后提交；自定义异步代码仍负责自己的文件范围、失败清理与资源验证。

新建与接管不同：安装包只注册领域，不扫描已有目录，不自动下载游戏、JDK 或其他可选工具。新领域不需要增加另一套通用工程创建引擎。

## 5 已有项目接管

在领域声明中加入以下片段，并在对应 provider 实现两个接口；片段不是完整清单。

```json
{
  "adoption": {
    "handler": "notes",
    "priority": 80,
    "markers": ["notes-project.json"]
  }
}
```

```ts
inspectExisting(sourcePath: string): Promise<ExistingProjectAnalysis | null>
adoptExisting(input: ExistingProjectAdoptInput, analysis: ExistingProjectAnalysis): Promise<StudioAdoptionPlan>
```

类型可从 [SDK](../feature-plugins/sdk/studio.ts) 和 [项目类型定义](../src/shared/types.ts) 导入，完整实现可参考 [shaderAdoption.ts](../feature-plugins/studio-shader/src/main/shaderAdoption.ts)。

`markers` 是相对文件路径，任一命中才调用识别器；空数组适合必须分析内容的工程。优先级范围为 0–100，按数值降序、同级按领域 ID 排序。标记不能越界或为链接；已命中但模块不可用时应显示对应工作台恢复信息。

识别器不匹配时返回 null；匹配时返回真实的来源路径、来源名、`kind`（识别结果的 `complete` / `partial` / `api-docs` / `modpack`，与项目类型分开）、文件统计、关键文件、识别理由和 `inferred` 目标。宿主核对来源范围、数量、领域和 loader，再补领域身份。识别阶段只读，不执行来源代码。

自定义领域当前只支持完整工程文件夹的 `{ mode: 'in-place' }` 接管。宿主执行前重新识别并校验目标，独占创建和回读 `modmind.project.json`，保留原源码、文件和构建配置。已有 ModMind 工程直接打开；重复接管不能覆盖元数据。

`host-managed` 仅供三个内置模块复用现有导入服务。自定义包不能通过它接管 ZIP、残缺参考资料或任意输出目录；接管完成也不证明构建或领域运行成功。

## 6 AI profile 与 skills

`ai.workbench` 和 `ai.inspiration` 均必填，每份至少有非空 `instructions` 和 `skills` 数组。提示词说明领域目标、工具使用顺序与验证方式；权限、只读和项目边界由宿主执行。

可选 `greetings` 提供欢迎语，`starters` 提供 `{ title, prompt }` 推荐问题。`variants` 按 loaders 匹配：追加 instructions，使用匹配分支的 skills 替换基础技能列表；同一 profile 不能重复覆盖一个 loader。

提示词占位符为 `{{name}}`、`{{loader}}`、`{{version}}`、`{{apiVersion}}`、`{{javaVersion}}`。它们提供上下文，不表示相应 API 或运行环境已经可用。

随包技能需要同时声明包 `assets` 和领域 `skillAssetGroup`：

```json
{
  "assets": { "skills": "feature-plugins/studio-notes/skills" }
}
```

在领域中设置 `"skillAssetGroup": "skills"`，profile 的 skills 填技能名，源码目录为 `skills/<技能名>/SKILL.md`。构建只复制两份 profile 与 variants 引用的技能；宿主按页面和项目同步并按需读取正文，保留用户独立技能。最小示例使用空技能列表，不需要资源组。

## 7 领域任务与功能拆分

`tasks` 为 `check`、`build`、`test`、`export` 绑定已有 action：

```json
{
  "tasks": {
    "check": { "action": "validate", "input": { "operation": "check" } },
    "export": { "pluginId": "notes-export", "action": "export" }
  }
}
```

这段要求本包已声明并实现 `validate`，且使用 export 时目标包提供 `export`。省略 pluginId 调用本包动作，跨包填写包 ID；默认 input 与调用参数合并，调用参数覆盖默认值，最终仍经过目标 schema 与权限校验。绑定任务不会自动注册 MCP 工具，需要 AI 调用时仍声明相应 `tools`。

必需组件用包级 `dependencies` 保证可用；可选功能的跨包任务引用不强制形成硬依赖，调用时目标未就绪会返回不可用。当前 `studio-shader` 的导出和测试任务正是可选引用，而各 `shader-*` 功能依赖领域包；领域包再硬依赖它们会形成循环。

领域基础包建议承载身份、创建、接管和上下文，体积大的编辑器、预览、测试与导出按任务拆成 `.mmfeature`。附属包的 `dependencies` 填领域包 ID，`studioIds` 填领域 ID，页面/设置/动作声明适用范围。这样停用一个工具不会让整个领域项目失去身份。

`navigation.hideCoreViews` 当前只支持 `build`；两个 AI 页面与代码编辑器始终保留。`compactSidebar: true` 可让窄窗口的领域功能页使用紧凑导航。它不是任意页面布局编辑器。

## 8 MCP 与项目恢复

| 接口 | 当前能力 |
| --- | --- |
| `modmind_feature_catalog` | 查询安装能力、领域声明、创建字段、接管声明和状态 |
| `modmind_project_setup` | 用 `studioId`、kind、目标和 studioValues 初始化当前草稿；灵感台禁止 |
| `modmind_project_info` | 回读当前领域、AI 上下文与状态 |
| `modmind_studio_inspect` | 识别当前项目内的完整工程子目录；只接受项目内相对目录 |
| `modmind_studio_adopt` | 同一接管服务写入和回读子目录元数据，返回 verified 和项目路径，保持前台项目与会话 |
| `window.modmind.studios.list()` | UI 查询领域列表与可用状态 |
| `window.modmind.studios.context(surface, projectPath)` | UI 查询当前项目上下文，拒绝旧项目路径 |

MCP 接管需要审批，灵感台禁止写入。它不接管外部目录、压缩包、整合包或残缺参考资料，这些使用 UI 接管入口。领域自定义业务继续通过 mmfeature 的 actions/tools 接入，无须增加另一套 MCP 服务。

新项目保存 `studioId`、`studioName`、`studioValues`。旧三种项目按类型和平台映射到固定 Minecraft 领域；显式未知 ID 不降级为模组。领域缺失时项目保留并显示恢复入口，不能继续 AI 写入；重新安装或启用后继续使用原源码、会话和数据。启停与卸载同样受活动任务保护。

## 9 验证与分发

单包构建命令见最小示例；修改公共协议或内置模块时可运行已有定向回归：

```powershell
npm run typecheck
npx vitest run src/shared/studios.test.ts src/main/studioRegistry.test.ts src/main/bundledStudioService.test.ts src/main/draftProjectService.test.ts
```

部分回归读取 `feature-plugin-dist/` 中的已构建包，应先按需构建相关包。`node scripts/studio-protocol-smoke.mjs` 提供较完整的隔离 Electron 与实际 MCP 验收，使用现有主程序构建和领域产物；涉及创建 UI 时还应检查实际画面。

至少走通：首次离线安装/创建；表单三种控件、默认值与只读防篡改；两份 profile 和 skills；真实工程识别、接管与元数据回读；MCP 发现、调用、只读和路径越界；停用/卸载后项目恢复；深浅主题与窄窗口。结构与静态检查成功不能写成游戏或其他领域运行成功。

自定义 `.mmstudio` 使用功能包的本地构建、导入与安装验证流程。内置模块构建用 `node scripts/prepare-bundled-studios.mjs`，输出 `resources/bundled-studios/` 和 schemaVersion 2 校验索引，随主程序 extraResources 发布；开发启动与主程序构建会自动准备它们。

应用内可使用 [ModMind 开发者工作台](developer-workbench.zh-CN.md) 编辑创建字段与 AI 上下文，通过 AI 或源码设计页面，预览、调试并导出工作台包。第一版暂不提供任意布局拖拽或自定义领域通用运行引擎。更详细的既有协议与验收证据见 [领域工作台协议](studio-protocol.zh-CN.md)，真实多包案例见 [光影工作台](shader-studio-development.zh-CN.md)。
