# mmfeature 功能包开发指南

`.mmfeature` 为已有工作台提供业务功能，例如编辑器、目录查询、预览、测试或导出。清单声明能力、页面、设置、动作和 MCP 工具，主程序统一发现和加载。先阅读 [开发入口与兼容基线](extensions-development.zh-CN.md)；增加项目领域时使用 [mmstudio 指南](mmstudio-development.zh-CN.md)。

## 1 开发目录与构建产物

开发环境沿用仓库的 Node.js 22 与锁定依赖。当前构建器在 ModMind 仓库内工作，目录名必须与包 ID 相同：

```text
feature-plugins/text-check/
  manifest.json
  main.ts
  renderer.tsx
  components/                 可选
  src/main/                  可选，共用业务服务
  main-contributions.json    可选，合并 actions 与 tools
```

`renderer.ts` 和 `renderer.tsx` 二选一；同时存在时构建器选择后者。`main.ts` 必须导出同步 `activate()`，纯界面包也需要它；无页面的后台包也需要 renderer 注册空页面列表。

```powershell
npm ci
node scripts/build-feature-plugins.mjs --only=text-check
```

产物为 `feature-plugin-dist/text-check/`、`feature-plugin-dist/text-check.mmfeature`。构建器生成 JS、CSS、SHA-256 和 ZIP，缺少样式时自动生成空 CSS；不要手工填写源码清单的 `files`。`build-inputs.json` 仅是目录中的构建报告，不进入 ZIP。

`--only` 接受单个 ID。即使只构建一包，仍收集全部源码清单并更新 `feature-plugin-dist/catalog.json` 和 `src/shared/featurePluginCatalog.json`。`npm run features:build` 构建全部包；它们都不会生成主程序安装器或上传文件。

## 2 最小示例

以下三段分别保存到对应文件，提供一个文本检查页面和同一动作的 MCP 工具。示例只统计输入内容，不读取项目文件、不写入数据。

### manifest.json

```json
{
  "format": "modmind-feature",
  "apiVersion": 2,
  "hostVersion": "1.5.0-plugintest",
  "id": "text-check",
  "name": "文本检查",
  "version": "1.0.0",
  "main": "main.cjs",
  "renderer": "renderer.js",
  "style": "renderer.css",
  "capabilities": [
    { "id": "text-check", "name": "文本检查", "description": "统计输入文本的字符、行数和 UTF-8 大小。" }
  ],
  "views": [
    { "id": "text-check", "label": "文本检查", "component": "TextCheckPage", "icon": "FileText", "group": "开发", "order": 50 }
  ],
  "actions": [
    {
      "id": "check",
      "handler": "check",
      "permission": "read",
      "projectRequired": false,
      "surfaces": ["workbench", "inspiration"],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text"],
        "properties": { "text": { "type": "string", "maxLength": 100000 } }
      }
    }
  ],
  "tools": [
    { "name": "modmind_text_check", "action": "check", "description": "Count characters, lines and UTF-8 bytes of supplied text. Does not read or write files." }
  ]
}
```

### main.ts

```ts
import type { FeaturePluginRuntime } from '../../src/shared/featurePlugins'

export function activate(): FeaturePluginRuntime {
  return {
    actions: {
      check(input) {
        const text = input.text as string
        return {
          status: 'completed',
          characters: Array.from(text).length,
          lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length,
          utf8Bytes: Buffer.byteLength(text, 'utf8')
        }
      }
    }
  }
}
```

### renderer.tsx

```tsx
import { useState } from 'react'
import { FileText } from 'lucide-react'
import { registerFeature } from '../sdk/renderer'

function TextCheckPage() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  async function check() {
    setBusy(true)
    try {
      const value = await window.modmind.featurePlugins.invoke('text-check', 'check', { text })
      const data = value as { characters: number; lines: number; utf8Bytes: number }
      setResult(`${data.characters} 个字符 · ${data.lines} 行 · ${data.utf8Bytes} 字节`)
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return <section className="settings-section">
    <textarea aria-label="待检查文本" value={text} maxLength={100000}
      onChange={event => setText(event.target.value)} />
    <button className="primary-button" disabled={busy} onClick={() => void check()}>
      {busy ? '检查中…' : '检查文本'}
    </button>
    <p role="status" style={{ minHeight: '1.5em' }}>{result}</p>
  </section>
}

registerFeature('text-check', {
  apiVersion: 2,
  pages: [{ id: 'text-check', exportName: 'TextCheckPage', label: '文本检查',
    group: '开发', icon: FileText, scope: 'application', component: TextCheckPage }]
})
```

构建后运行 `npm run dev`，在“功能”页使用本地安装入口选择 ZIP 包并确认来源信任，打开文本检查页面。工作台工具发现后调用 `modmind_text_check`，参数为 `{"text":"你好\nModMind"}`，应返回 10 个字符、2 行、14 字节。空文本返回三个 0。

## 3 清单贡献点

类型来源：[featurePlugins.ts](../src/shared/featurePlugins.ts)。包 ID 使用 `^[a-z][a-z0-9-]{0,63}$`；页面、设置、领域和工具应使用不冲突的标识，不能占用核心路由。

| 字段 | 用途与约束 |
| --- | --- |
| `capabilities` | 未安装时仍可展示的能力说明，不等于可调用工具 |
| `views` | `id`、`label`、`component`、图标名称 `icon`，可带 `group`、`order` 和适用范围 |
| `settings` | 组件声明；`category` 为 `general`、`ai`、`development`、`integrations`、`about` 之一 |
| `actions` | 统一调用入口，声明 handler、schema、权限、项目要求、工作区及适用范围 |
| `tools` | `name`、`action`、`description`；工具名匹配 `modmind_[a-z0-9_]+`，指向本包动作 ID |
| `events` | 可发送的事件名称，不声明就不能发送 |
| `dependencies` | 必需包的 ID，无版本范围求解；依赖缺失或停用会使本包不可用 |
| `hostCapabilities` | 需要的宿主能力标记；构建器自动补 `runtime`，新接口须显式声明适当标记 |
| `studioIds`、`loaders` | 包级及页面、设置、动作级范围；写领域 ID，如 `minecraft-shader`，不是包 ID `studio-shader` |
| `assets` | 构建资源组到仓库内目录的映射，运行时内容在 `assets/<组名>/` |
| `target` | 系统与架构限制；有本机二进制时构建器自动生成 |

包级范围和贡献级范围共同约束适用对象。动作声明 `studioIds` 时必须同时声明 `projectRequired: true`；真实调用也检查当前领域，不能只靠 UI 的 `supports()` 隐藏按钮。跨包必需依赖不得形成循环。

`main-contributions.json` 只合并 `actions`、`tools`，相同标识会导致构建失败。它适合迁移已有大量工具声明，普通小包直接在 `manifest.json` 中声明即可。

## 4 主进程与共享业务

`activate(options)` 同步返回服务对象，动作本身可以异步。对象型 options 会增加 `pluginId`、`pluginDirectory`、`assetBaseUrl`、`emitEvent`；当前主程序还提供 `host`、`userDataDir`、`projectRoot()` 等，具体接口见 [宿主初始化](../src/main/index.ts) 和 [Native Feature API](../feature-plugins/HOST-CONTRACT.md)。不要运行时导入 `src/main/index.ts`；需要 `NativeFeatureHost` 时仅作 `import type`。

`actions[].handler` 对应 `runtime.actions[handler]` 或服务同名方法。激活时每个声明必须有实现。数据读写、校验、版本冲突、撤销与结果生成放在业务服务中，页面经 `featurePlugins.invoke()` 调用，MCP 经同一 action 调用。

构建器会把已有公共主进程模块替换成 `@modmind/host` 运行时桥，前端共享 React、ReactDOM、JSX runtime、对话框、Monaco 和 MiniPaint。参考 [共享模块清单](../scripts/build-feature-plugins.mjs) 与 [featureHostRuntime.ts](../src/main/featureHostRuntime.ts)，避免另建下载、进程、项目锁或构建管理器。

`service<T>()` 和 `sdk/native.ts` 的 `nativeActions()` 用于内部业务复用与既有 IPC 迁移。新增 AI 动作应有可理解的参数 schema，通过统一 invoke 通道；内部服务句柄不能替代 MCP 权限和参数校验。

| 生命周期接口 | 插件责任 |
| --- | --- |
| `dispose()` | 释放进程、窗口、定时器、监听器与缓存引用，可异步 |
| `projectChanged(pathOrNull)` | 清理前一项目状态，禁止将旧缓存当作新项目数据 |
| `stopForSignal(signal)` | 按需实现任务取消清理；动作同时应配合 `context.signal` |
| `isBusy()` | 按需报告插件后台任务；业务仍须正确管理任务生命周期 |

宿主在调用或已知工作台任务运行时阻止安装、启停和卸载；停用后旧服务与事件发送器失效。卸载删除包目录，保存在项目或应用数据目录的业务数据由业务策略管理。

## 5 页面、设置、事件与资源

用 [sdk/renderer.tsx](../feature-plugins/sdk/renderer.tsx) 的 `registerFeature()` 注册 `FeatureRendererModule`。清单 `component` 必须与 renderer 的 `exportName` 对齐；不写 `exportName` 时 SDK 用页面或设置的 `id` 作为导出名。

页面接收 [FeaturePageContext](../src/renderer/src/featurePluginTypes.ts)：当前项目、可见状态、主题、UI 模式、导航、文件变更通知、忙碌状态及恢复钩子。默认按项目管理页面实例；应用级页面声明 `scope: 'application'`。`keepAlive` 用于需要保留草稿的页面，但不应使隐藏页面持续执行昂贵任务。无页面服务用 `pages: []`；必要的合成器或订阅用 `backgroundComponents`。

页面样式遵守 [设计规范](design-spec.zh-CN.md) 与 [主题系统](theme-system.zh-CN.md)，复用宿主组件。异步结果留稳定空间，错误保留输入并支持重试；至少检查深浅主题和窄窗口。原生 WebContentsView 需要处理宿主模态框遮挡，可复用 [hostModals.ts](../feature-plugins/sdk/hostModals.ts)。

主进程调用注入的 `emitEvent(name, payload, windowId?)`，页面用 `window.modmind.featurePlugins.onEvent(pluginId, name, callback)` 订阅并保存返回的取消订阅函数。仅接受声明事件及不超过 1 MiB 的 JSON；组件卸载与切换项目时清理订阅。

`assetBaseUrl` 指向 `modmind-feature://<包ID>/assets/`，文件 URL 需包含资源组。协议只提供可用包中已校验的 renderer/CSS/assets，不提供后端入口或清单。资源不得包含凭据。

构建专用字段 `assetFiles` 限定资源组文件，`assetChunks` 声明源文件切片，`nativeBinaries` 声明导出二进制路径的 npm 包；它们在运行清单中被移除。二进制和上游许可证随包复制，并产生平台、架构与校验索引。普通图片或文本资源只需 `assets`。

## 6 动作权限与 MCP

一次调用经过参数复制与 Ajv 校验、可用性、只读与工作区检查、当前项目和领域检查，再按调用入口执行已有审批与业务 handler。审批后会再次核对项目。`projectRequired` 只要求存在有效项目，不能替业务代码检查每个文件路径。

| 声明 | 含义 |
| --- | --- |
| `permission: "read"` | 只读查询，适合工作台与灵感台 |
| `permission: "write"` | 修改项目或业务数据，灵感台通常禁止 |
| `permission: "network"` | 发起联网操作，受工作区与已有策略约束 |
| `permission: "process"` | 启动构建、测试等进程，需完整生命周期管理 |
| `surfaces` | `workbench`、`inspiration`；省略时允许两个入口参与发现，再由宿主限制 |
| `inspirationOutput` | 仅是申请显式产物例外；宿主额外授权仍必需，目前只开放指定图像工具 |

schema 根节点必须为 object；建议使用 `additionalProperties: false`、`required`、长度与数量上限及必要的条件校验。支持本地 `$ref`、`oneOf`、`const`、`pattern` 等；不获取远程 schema，不校验 `format` 注解，不自动注入默认值。输入 JSON 上限为 32 MiB。

handler 应使用调用上下文中的项目身份，校验相对路径和真实路径、符号链接、文件 revision 与写入范围；参数里有 `projectPath` 时也要核对，不能让它成为任意目录入口。权限声明是集成边界，原生代码没有文件系统沙箱。

返回业务可判断的对象，例如 `status`、变更文件、revision、产物路径、验证证据或可恢复错误；没有统一强制的成功结果 schema。长任务返回任务 ID，提供状态查询和必要取消；预览用于 AI 判断时返回实际图片或可读资源。

实际工作台先发现可用 `tools`，再从公共 MCP 调用链执行。未安装、停用、缺依赖、不适用或用户未选择的功能不会获得相同的可调用状态；`modmind_feature_catalog` 的安装能力说明也不是执行授权。核心 `modmind_feature_call` 可转调本轮已就绪工具，插件无需另开 MCP 服务器。

## 7 安装、验证与发布

本地包通过“功能”页安装；安装前核对清单、完整性和来源信任，安装失败不会作为成功状态发布。停用与卸载后页面和工具应消失，重装应按业务策略保留已保存数据。

以下是已有协议回归入口。只改业务时选择相关测试；修改公共协议时扩大到对应回归，不必为文档或简单视觉调整新增重复测试。

```powershell
npm run typecheck
npx vitest run src/main/featurePluginService.test.ts src/main/featurePluginGenericMcp.test.ts src/main/featurePluginSelections.test.ts
```

交付至少验证：正常任务的 UI 与 MCP 同一结果；无效参数、只读、项目切换和范围拒绝；依赖缺失与恢复；安装取消后重试、启停卸载；首次离线状态；深浅主题和窄窗口。工具出现在列表中不代表业务和 MCP 已验收。


## 8 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 包被拒绝 | 包 API、固定 hostVersion、目标架构、清单 hash 和路径；API 1 包需要重构建 |
| 页面不出现 | 包/依赖是否可用，清单 component 与 exportName 是否对应，领域范围和 supports 是否匹配 |
| 工具不出现 | tools 是否指向本包 action，工作区、项目范围、只读和用户选择是否允许 |
| 安装后首次调用失败 | activate 是否同步返回对象，handler 和宿主能力是否存在 |
| 动作参数被拒绝 | schema 的必填项、额外属性、字符串长度和条件约束 |
| 停用或卸载被拒绝 | 活动调用、工作台任务、测试进程或仍启用的依赖方 |
| 资源 404 | 包是否可用、组名是否正确、文件是否在 hash map 中；后端文件不会被提供 |
| 切换项目出现旧数据 | 清理 projectChanged、订阅、异步返回和按项目缓存 |

相近完整实现可从 [shader-source](../feature-plugins/shader-source/manifest.json)、[image-studio](../feature-plugins/image-studio/manifest.json)、[testing](../feature-plugins/testing/manifest.json) 开始；先复用其业务与宿主设施，再按具体任务扩展。
