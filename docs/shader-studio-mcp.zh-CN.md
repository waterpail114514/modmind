# 光影工作台 MCP 调用参考

光影工具按五个功能包发现，共 10 个 MCP 工具。领域包 `studio-shader` 本身不贡献业务工具。调用前查询实际工具目录和功能状态，确认当前项目是 `kind: shader`、`studioId: minecraft-shader`、`loader: iris`；能力、页面与源码位置见 [光影开发指南](shader-studio-development.zh-CN.md)。

## 1 工具与 action 对照

| 包 | MCP 工具 | action | operation / 参数 | 权限 |
| --- | --- | --- | --- | --- |
| `shader-source` | `modmind_shader_query` | `query` | `inventory`；`read` 需 path | read |
| `shader-source` | `modmind_shader_edit` | `edit` | `save` 需 path、content、文件 revision；`undo` | write |
| `shader-options` | `modmind_shader_options_query` | `query` | `inventory` | read |
| `shader-options` | `modmind_shader_options_edit` | `edit` | `options` 需工程 revision、values，可带 programValues；`undo` | write |
| `shader-preview` | `modmind_shader_preview` | `query` | `inventory`、`preview`、`preview-image` | read |
| `shader-testing` | `modmind_shader_test_query` | `query` | `inventory`、`test-state`、`capabilities`、`session-state`、`observe` | read |
| `shader-testing` | `modmind_shader_test` | `test` | `deploy`、`reveal`；bind / bind-runtime 仅 UI | write |
| `shader-testing` | `modmind_shader_session` | `session` | `start` 需 versionId；`reload` / `stop` 需 sessionId | process |
| `shader-export` | `modmind_shader_validate` | `query` | `inventory`、`validate` | read |
| `shader-export` | `modmind_shader_export` | `package` | 空参数对象 | write |

所有动作都要求当前项目，拒绝额外参数，允许可选 `projectPath`（最多 1024 字符）；通常由宿主提供项目身份，无须额外填写。带 projectPath 时必须与当前项目一致，它不是任意外部路径入口。

read 工具可用于工作台和灵感台，write / process 只在工作台开放，并经过宿主既有操作审查与项目锁。未安装、停用、缺依赖、领域不匹配或用户未选择时应先恢复对应功能，不能将产品能力目录当作执行授权。

UI 同一动作入口为 `window.modmind.featurePlugins.invoke(pluginId, actionId, input)`。`shader-export.export` 是保存对话框动作，MCP 的 `modmind_shader_export` 绑定的是 `package`，直接写项目 build，不弹另存窗口。

## 2 读取与结果类型

以下 JSON 是 MCP `tools/call` 的 params，不包含外层 JSON-RPC 包装：

```json
{ "name": "modmind_shader_query", "arguments": { "operation": "inventory" } }
```

```json
{ "name": "modmind_shader_query", "arguments": { "operation": "read", "path": "shaders/final.fsh" } }
```

```json
{ "name": "modmind_shader_validate", "arguments": { "operation": "validate" } }
```

```json
{ "name": "modmind_shader_preview", "arguments": { "operation": "preview" } }
```

| 结果 | 关键字段与含义 |
| --- | --- |
| `ShaderInventory` | 工程 revision、files、programs、options、profiles、profilePrograms、profileIssues、optionGroups、optionIssues、programConditions、configurationConditional |
| `ShaderDocument` | path、content、文件 revision；用于保存同一文件 |
| preview | 展开的 source、涉及 files、`scope: final-only`、`gameVerified: false`；这是源码查询，不是图片 |
| preview-image | sourceHash、PNG dataUrl、final-only 范围；公共 MCP 转图像内容块 |
| `ShaderValidation` | status、工程 revision、issues、parsed、skipped、`gameVerified: false` |
| export | `status: exported`、path、bytes、sha256、工程 revision、validation |
| `ShaderTestState` | 实例路径、Iris 检测、部署记录、日志时效、截图名及图像 |
| `ShaderRuntimeCapabilities` | supported、ready、versions、java、iris、issues、`runtimeVerified: false` |
| `ShaderRuntimeSession` | sessionId、taskId、status、running、artifact、observation、shutdown、logTail、`gameVerified: false` |

完整类型以 [shaderStudio.ts](../src/shared/shaderStudio.ts) 为准。MCP 有 `isError` 时先处理错误；需要查看图像时保留完整 content 数组，不能只 JSON.parse 第一项文字后丢弃 image 内容块。

## 3 保存已有源码与应用预设

下面的 TypeScript 示例使用一个由调用方提供的 `call<T>(tool, input)`：它从真实 MCP 调用结果检查 isError，再返回文字中的结构化业务对象。导入路径按示例保存于仓库 `docs/` 中计算。此适配函数不替代真实工具发现、审批或图像处理。

```ts
import type { ShaderDocument, ShaderInventory } from '../src/shared/shaderStudio'

type CallTool = <T>(tool: string, input: Record<string, unknown>) => Promise<T>

export async function saveExistingShader(call: CallTool, before: ShaderDocument, content: string) {
  const path = before.path
  await call<ShaderDocument>('modmind_shader_edit', {
    operation: 'save', path, content, revision: before.revision
  })
  const after = await call<ShaderDocument>('modmind_shader_query', { operation: 'read', path })
  if (after.content !== content) throw new Error('保存后回读不一致')
  return after
}

export async function applyShaderProfile(call: CallTool, name: string) {
  const inventory = await call<ShaderInventory>('modmind_shader_options_query', {
    operation: 'inventory'
  })
  const issues = inventory.profileIssues[name] ?? []
  if (issues.length) throw new Error(issues.join('；'))
  if (!Object.hasOwn(inventory.profiles, name)) throw new Error('预设不存在')
  const values = inventory.profiles[name]
  const programValues = inventory.profilePrograms[name] ?? {}
  if (inventory.configurationConditional && Object.keys(programValues).length) {
    throw new Error('条件配置中的程序覆盖需要在 Iris 中确认')
  }
  await call<ShaderInventory>('modmind_shader_options_edit', {
    operation: 'options', revision: inventory.revision, values, programValues
  })
  const after = await call<ShaderInventory>('modmind_shader_options_query', {
    operation: 'inventory'
  })
  for (const [option, value] of Object.entries(values)) {
    if (after.options.find(item => item.name === option)?.value !== value) {
      throw new Error(`选项回读不一致：${option}`)
    }
  }
  for (const [program, enabled] of Object.entries(programValues)) {
    if (after.programConditions[program] !== String(enabled)) {
      throw new Error(`程序覆盖回读不一致：${program}`)
    }
  }
  return after
}
```

先通过 read 取得 `ShaderDocument`，以该快照为基线编辑，再将 before 和用户已审阅的 content 传给 `saveExistingShader`。提交保留编辑前的 revision；不能临提交才换成新读取的 revision 来覆盖更晚修改。

选项 `values` 的值全部为字符串；布尔宏填 `"true"` / `"false"`，值必须来自该选项的 values。`programValues` 的值为 boolean，键名是 `final` 或 `world-1/composite` 等程序名，不含 `shaders/` 和扩展名。每个对象最多 128 项。

文件保存拒绝新建文件、越界、链接、NUL 和超过 2 MiB 的 UTF-8 文本；单文件 revision 与工程 revision 都是 64 位十六进制 SHA-256，但不能互换。来源发生变化时重读、重新比较草稿，不能盲目换新 revision 强行重试。

```json
{ "name": "modmind_shader_edit", "arguments": { "operation": "undo" } }
```

```json
{ "name": "modmind_shader_options_edit", "arguments": { "operation": "undo" } }
```

两个 undo 共用恢复历史，撤销最近的光影提交，不按页面分别维护栈；没有历史或当前内容已被外部改写时会失败。

## 4 预览、检查与导出

```json
{ "name": "modmind_shader_preview", "arguments": { "operation": "preview-image" } }
```

前置条件是已打开当前项目预览页面，画布可见、编译成功、没有模态框遮挡，展开的 final sourceHash 与当前源码一致。该工具不打开页面、不截取其他 UI。返回 PNG 是示例场景的 final 输出，不是游戏截图。

```json
{ "name": "modmind_shader_export", "arguments": {} }
```

导出会再次检查，静态 error 阻断，warning 仍保留在 validation 中；回读实际 ZIP 的 SHA-256。报告 `syntax-checked` 时仍需查看 skipped 和 diagnostics，不能把未解析阶段当成完整编译通过。公共工具没有 `structureOnly` 或导出到任意路径的参数。

工程 revision 绑定扫描到的发行内容，preview sourceHash 只绑定展开的 final 源码，导出 sha256 绑定 ZIP 字节。三者不能互相替代；与截图、运行 observation 或用户画质认可关联时分别记录。

## 5 手动部署与实例证据

先在游戏验证页面选择已安装 Iris 的实例；调用 `bind` / `bind-runtime` 需要交互窗口且没有 MCP surface 标记。即使 MCP 带 windowId，也不能绕过这个限制。

```json
{ "name": "modmind_shader_test", "arguments": { "operation": "deploy" } }
```

```json
{ "name": "modmind_shader_test_query", "arguments": { "operation": "test-state" } }
```

deploy 复制并验证 ZIP，返回部署记录；用户自行启动游戏、选择包并截图。test-state 返回部署后日志和实例已有截图，公共 MCP 以 captures 输出图像内容块，截图名称仍保留。

读取范围为日志尾部最多 128 KiB、最多 80 条错误候选、按文件名排序最多四张截图。截图原 PNG 超过 4 MiB 会跳过，图像以最大 1024×768 的 JPEG 缩略图返回；这不是完整原生 PNG 证据。分别核对 log.fresh、log.packMentioned、deployed.revision 和 sha256；截图没有自动包哈希或同帧设置绑定。

`reveal` 只打开已绑定实例目录，不启动游戏。没有部署记录、旧日志、空截图或日志轮换都是可理解的状态，不能从“无错误候选”推出游戏通过。

## 6 隔离会话调用顺序

实例和含 versions / libraries / assets 的运行库必须已交互绑定。能力检测需要当前项目目标 26.2、Iris 1.11.2 和本地 Java 25，不自动下载缺失资源。

```json
{ "name": "modmind_shader_test_query", "arguments": { "operation": "capabilities" } }
```

`capabilities.ready` 表示本地准备条件满足；`versions[].id` 是可选的实际配置 ID，不等于固定 Minecraft 版本字符串。以下函数返回已接收的 preparing 会话，调用方随后轮询状态：

```ts
import type { ShaderRuntimeCapabilities, ShaderRuntimeSession } from '../src/shared/shaderStudio'

type CallTool = <T>(tool: string, input: Record<string, unknown>) => Promise<T>

export async function startShaderSession(call: CallTool, versionId: string) {
  const capabilities = await call<ShaderRuntimeCapabilities>('modmind_shader_test_query', {
    operation: 'capabilities'
  })
  if (!capabilities.ready) throw new Error(capabilities.issues.join('；'))
  if (!capabilities.versions.some(version => version.id === versionId)) {
    throw new Error('请选择 capabilities 返回的已安装版本')
  }
  return call<ShaderRuntimeSession>('modmind_shader_session', { operation: 'start', versionId })
}
```

| 步骤 | 工具、参数 | 应核对结果 |
| --- | --- | --- |
| 启动 | session：`{ operation: 'start', versionId }` | 保存实际返回的 sessionId、taskId；preparing 仅表示接收 |
| 等待就绪 | test_query：`{ operation: 'session-state', sessionId }` | 有界轮询 status / message / running / logTail，遇 failed 或 stopped 停止等待 |
| 进入世界 | 用户在独立可见游戏窗口进入或创建测试世界 | 当前没有自动世界、机位或场景操作工具 |
| 观察 | test_query：`{ operation: 'observe', sessionId }` | ready 后调用，读取 observation 与当前 artifact |
| 重载 | session：`{ operation: 'reload', sessionId }` | 导出当前源码、核对部署 hash、请求 Iris.reload 并回读状态 |
| 收尾 | session：`{ operation: 'stop', sessionId }` | 检查 stopped、running false 和 shutdown；异常时重试所属会话停止 |

session-state 省略 sessionId 时查询当前服务持有的会话，可能返回 null；observe 必须有 sessionId。state / observe 的 sessionId 以及 reload / stop 的 sessionId 都使用实际返回值，拒绝过期或其他项目的会话。status 为 failed 也可能仍有所属进程，需结合 running 判断并保留停止入口。

observation 返回 packName、pipeline、pipelineError、shaderPackLoaded、effectiveOptions、profile、gameReady 和 observedAt。应将 packName 与 artifact.name 对比，并查看是否真正进入世界、是否有错误；只看到 IrisRenderingPipeline 或 ready 不足以证明画质。

启动总租约为 20 分钟，adapter 还限制无控制指令的空闲时间。请求断连后可在同一应用进程内查询所属会话；应用重启不能恢复历史 PID。任务取消、项目变化、卸载或关闭会清理所属会话，调用方也应在完成或失败后主动 stop。

## 7 状态与证据边界

| 状态或字段 | 可支持的结论 |
| --- | --- |
| syntax-checked / structure-checked | 本地限定范围检查完成，分别查看 parsed / skipped |
| exported 与 sha256 | ZIP 已生成且整包完整性一致 |
| deployed | 已复制到指定实例并核对包 hash |
| capabilities.ready | 本地依赖与适配条件满足 |
| session.status ready / running | adapter 已响应 / 所属进程活着；不是画面验收 |
| observation | 运行接口读取的包、管线、错误与有效配置 |
| preview-image | 当前源码匹配的 final 样例画布 |
| test-state captures | 绑定实例已有截图的缩略图，不自动证明当前包或场景 |
| runtimeVerified / gameVerified | 当前接口固定 false，不自行提升为 true |

当前没有场景自动化、隔离会话原生截图、GPU 计时、完整帧诊断或冻结证据导出工具。单次接口成功和 JVM 夹具通过不能写成真实 Minecraft / Iris 兼容验证完成。

## 8 常见失败与恢复

| 失败 | 恢复路径 |
| --- | --- |
| 工具缺失或不可用 | 查询功能状态，安装 / 启用相应包和领域依赖，核对用户选择与项目范围 |
| 文件 / 工程已变化 | 读取正确 revision，比较新旧内容与草稿，再决定保存 |
| 预设不可用、条件程序配置 | 查看 profileIssues / optionIssues，不部分套用；需要实际 Iris 确认 |
| 预览未打开、旧画面或不支持的 uniform | 打开 / 刷新可用预览，或转游戏验证 |
| 静态导出失败但桌面语法可能合法 | 保留诊断；适配条件满足时使用隔离结构检查路径，不伪造语法成功 |
| 未选择实例 / 运行库、缺件 / 版本不匹配 | 在 UI 绑定并补齐已有本地资源；其他版本继续手动部署 |
| 会话 preparing / launching | 查询原 sessionId 的状态，避免重复 start |
| failed 且 running 为 true | 停止原所属会话，核对退出后再启动；不传任意 PID 清理 |
| 实际包不一致、尚未进入世界或管线错误 | 进入独立测试世界、检查 observation 与日志、修复后 reload |
| 旧日志 / 截图 | 核对时效与来源，重新取得当前实例证据，保留验证未完成状态 |

参数合同以各功能 [manifest.json](../feature-plugins/shader-testing/manifest.json) 和实时工具发现为准，实际调用回归见 [shaderStudioMcp.test.ts](../src/main/shaderStudioMcp.test.ts)；完整模块边界与源码导航见 [开发指南](shader-studio-development.zh-CN.md)。
