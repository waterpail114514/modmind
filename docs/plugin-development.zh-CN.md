# ModMind 插件开发指南

ModMind 插件是放在约定目录下的一组文件：一个 `plugin.json` 清单，加上可选的**侧边栏面板**、**跨页面悬浮界面**与**后端工具**（Node 脚本）。面板和悬浮界面运行在沙箱网页中；后端工具会自动注册进 ModMind 内置的 MCP server，供 Codex / Claude Code 等外部 AI Agent 调用。

## 快速开始

1. 复制一个模板开始：
   - `resources/plugin-templates/panel-only/` — 只要一个侧边栏网页面板
   - `resources/plugin-templates/tools-only/` — 只给 AI Agent 提供工具
   - `resources/plugin-templates/panel-and-tools/` — 两者都要
   - `resources/plugin-templates/overlay-pet/` — 跨页面悬浮界面，可弹出到系统桌面
2. 把模板目录复制到插件目录（见下），重命名 `plugin.json` 里的 `id`
3. 保存任意文件，ModMind 自动重启后端并刷新已打开的面板；侧边栏立即出现你的插件
4. 在「插件」管理页可以打包 `.zip` 分享给别人，对方确认完全信任后即可安装

## 安装位置（作用域）

| 作用域 | 目录 | 生效范围 |
|---|---|---|
| 全局 | `%APPDATA%/ModMind/plugins/`（插件管理页 → 打开插件目录） | 所有项目 |
| 项目级 | `<项目>/.modmind/plugins/<id>/` | 仅当前项目，随项目一起归档分享 |

同名 `id` 时项目级优先。管理页中可以启用/停用每一个插件。

## plugin.json 规范

```jsonc
{
  "id": "my-plugin",              // 必填，3-64 位小写字母/数字/连字符
  "name": "我的插件",              // 必填，侧边栏显示名
  "version": "0.1.0",             // 必填，语义化版本
  "description": "一句话说明",     // 必填，最长 400 字符
  "author": "可选",
  "icon": "icon.svg",             // 可选，管理页显示的相对路径 svg/png
  "permissions": ["project.read", "storage"],
  "backend": {                    // 可选：后端工具
    "entry": "backend/main.mjs",  // Node ESM 入口
    "tools": [
      {
        "name": "my_tool",        // 最终 MCP 工具名: modmind_plugin_my-plugin_my_tool
        "description": "给 AI 看的工具说明，写清楚何时该调用它",
        "inputSchema": { "type": "object", "properties": {} },   // JSON Schema
        "annotations": { "readOnlyLocal": true }                  // 见下文注解
      }
    ]
  },
  "panel": {                      // 可选：侧边栏面板
    "entry": "panel/index.html"
  },
  "overlay": {                    // 可选：跨页面悬浮界面
    "entry": "overlay/index.html",
    "mode": "pet",               // floating 或 pet
    "width": 220,
    "height": 260,
    "minWidth": 160,
    "minHeight": 180,
    "resizable": true,
    "alwaysOnTop": true
  }
}
```

`backend`、`panel` 与 `overlay` 至少声明其一。

## 跨页面悬浮界面

声明 `overlay` 后，插件界面会在 ModMind 主窗口内跨页面常驻。管理页或悬浮界面右上角的弹出按钮可把它转移到独立透明窗口；该窗口可以拖到 ModMind 外、跨显示器、调整大小和置顶。独立窗口的“收回”按钮会把界面重新停靠到主窗口。

`mode: "floating"` 使用普通悬浮工具窗口外观；`mode: "pet"` 使用透明背景，并只在悬停时显示宿主控制条。插件页面仍处于 sandbox iframe，不能访问外层窗口或 Electron API。拖动、关闭、置顶与收回都由宿主控制。

## 信任与宿主桥能力

插件后端不是沙箱。通过导入流程安装时，ModMind 会先要求用户确认**完全信任**；确认后，后端作为完整 Node 扩展运行，可以直接读写本机文件、访问网络、读取环境变量和启动进程。手动放入插件目录等同于用户主动信任该插件。

`permissions` 只控制插件通过 `modmindPlugin.ctx` 或面板消息桥调用哪些 ModMind 宿主能力，不能限制插件后端直接使用 Node API。

| 权限 | 授予能力 |
|---|---|
| `project.read` | 后端 `ctx.projectInfo()` / 面板 `getProjectInfo` 读取当前项目名称、路径、类型快照 |
| `storage` | 后端 `ctx.storage.get/set(key, value)` 私有键值存储（按插件 id 隔离） |
| `net.fetch` | 后端 `ctx.net.fetch(url, init)` / 面板 `netFetch` 经宿主发起网络请求 |
| `clipboard.write` | 面板 `copyToClipboard` 写系统剪贴板 |

导入他人插件时，ModMind 会同时展示完整信任警告与声明的宿主桥能力。

## 权限边界

- 面板运行在 `sandbox="allow-scripts allow-downloads"` 的跨源 iframe 中；不能直接调用 Electron、Node、文件系统或主应用 API。资源由 `modmind-plugin://` 提供，CSP 禁止直接联网（`connect-src 'none'`）；联网需声明 `net.fetch` 并通过 `postMessage` 发送 `netFetch` 请求。
- 后端在独立 utilityProcess 中运行以隔离崩溃，但拥有完整 Node 权限；只安装和运行你完全信任来源的插件。
- `permissions` 会约束 `modmindPlugin.ctx` 的 `project.read`、`storage`、`net.fetch` 和剪贴板桥调用，但不是系统权限边界。
- `ctx.callTool()` 只提供同一插件已声明工具之间的便利调用；后端本身仍是完全可信代码。
- 工作台的插件制作工具只会在插件目录内新增或修改文件，不提供删除文件或修改 ModMind 源码的能力。

## 工具注解（annotations）

与 ModMind 内置 MCP 工具同一套四档体系：

| 注解 | 含义 |
|---|---|
| `readOnlyLocal` | 只读、不产生副作用（本地） |
| `readOnlyRemote` | 只读、访问外部服务 |
| `safeStateChange` | 有副作用但安全可逆（如写进度） |
| `managedAction` | 重操作（构建、下载、改文件） |

只读模式下（外部 Agent 的只读会话），ModMind 只分发声明为 `readOnly*` 的工具。该注解是调用策略，不是对完全可信后端的系统级约束。

## 面板 API

面板以 `<iframe sandbox="allow-scripts">` 加载，源唯一且随机。通信全部经 `window.parent.postMessage`：

```js
// 宿主会在面板加载后下发 hostInfo（主题、项目信息等）
window.parent.postMessage({ type: 'ready' }, '*')

window.addEventListener('message', (event) => {
  // event.data.type === 'hostInfo' -> event.data.hostInfo
  // event.data.type === 'result'   -> 对应请求的结果
})

// 发请求（payload 带 requestId 用于配对结果）
window.parent.postMessage({ type: 'invokeTool', requestId, toolName: 'summarize_project', input: {} }, '*')
window.parent.postMessage({ type: 'getProjectInfo', requestId }, '*')
window.parent.postMessage({ type: 'netFetch', requestId, url: 'https://example.com/data.json' }, '*')
window.parent.postMessage({ type: 'copyToClipboard', requestId, text: '...' }, '*')
window.parent.postMessage({ type: 'log', level: 'info', message: '...' }, '*')
```

宿主通过 `hostInfo.theme` 下发明暗主题。随附模板会据此设置 `--mm-bg`、`--mm-text`、`--mm-border`、`--mm-surface`；自定义面板也应在收到 `hostInfo` 后应用这些变量。

## 后端 API

入口文件在独立 utilityProcess 中执行，全局注入 `modmindPlugin`：

```js
modmindPlugin.registerTools({
  async my_tool(input) {
    const project = await modmindPlugin.ctx.projectInfo()   // project.read
    const n = await modmindPlugin.ctx.storage.get('k')       // storage
    await modmindPlugin.ctx.storage.set('k', n + 1)
    const res = await modmindPlugin.ctx.net.fetch(url)       // net.fetch
    await modmindPlugin.ctx.callTool('other_tool', {})       // 调本插件其他工具
    modmindPlugin.ctx.log.info('...')
    return { any: 'json-serializable' }
  }
})
```

约束：单次工具调用 30s 超时；返回值必须可 JSON 序列化。后端是完全可信 Node 代码；只有工作台提供的制作工具受插件目录边界约束。

## 用工作台（AI 对话）制作

直接在工作台描述需求，例如"帮我做一个显示模组清单统计的插件"。Agent 会通过内置 MCP 动作完成全流程：

- `modmind_plugins_scaffold` — 按模板生成脚手架
- `modmind_plugins_write_files` — 写入面板/后端代码
- `modmind_plugins_reload` — 立即热重载验证
- `modmind_plugins_read_source` — 回读源码继续迭代

## 调试

- 管理页每个插件都有开发者控制台。打开后会主动启动懒加载后端，并显示运行状态、PID、入口、权限、启动错误、退出码与最近 500 条日志。
- 开发者控制台可以启动、重启后端和清空日志；`console.log/warn/error`、`ctx.log`、工具调用结果、未捕获异常、面板及悬浮界面的 `log` 消息都会进入同一日志流。
- 管理页列出每个插件的加载错误（manifest 不合法、入口缺失等）
- 面板 `log` 消息与后端 `ctx.log` 输出进入应用诊断输出；后端启动错误同时显示在管理页
- 改动任何插件文件都会触发自动重载；宿主进程崩溃会懒重启

## 导入 / 导出

- **导出**：管理页 → 插件卡片 → 导出 `.zip`
- **导入**：管理页 → 导入按钮选择 `.zip`；确认完全信任后生效。压缩包可把 `plugin.json` 放在根目录或唯一的 `<id>/` 子目录
