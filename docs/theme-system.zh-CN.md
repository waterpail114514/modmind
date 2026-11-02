# 全局主题

设置 → 通用 → 外观可一键选择 ModMind、默认、暖砂、青绿、石墨。ModMind 以灰白/深灰为基底，仅在操作和选中状态中使用 Logo 青绿，以金色作少量点缀。配色和深色模式分别保存，重启后恢复，并同步到已打开的主窗口、独立窗口和插件宿主。

「手动调色」分别保存浅色、深色模式的背景色与强调色。应用后，由共享主题函数推导面板、文字、边框和选中色，并校正文字对比度。选择预设清除手动颜色；恢复按钮只重置当前模式。Monaco、Blockbench、miniPaint 和插件主题协议同步接收自定义颜色。

「自定义背景」支持本地 PNG、JPG、WebP、GIF、MP4、WebM（最高 250 MB，视频编码须由 Electron 支持）。导入后复制到用户数据目录 `appearance-media`，原文件移动不影响使用。专用协议只允许读取导入的文件名，并支持视频 Range 请求；设置只保存文件引用。背景可见度、模糊程度、填满/完整显示和视频暂停均可保存。视频静音循环，在隐藏窗口或系统减少动态效果时暂停。加载失败回退到主题底色；移除背景会恢复完整的不透明界面。用户背景不进入图片/模型编辑器的内容画布。

## 唯一颜色源

所有应用界面色值定义在 `src/shared/appTheme.ts`。修改配色时编辑这里，运行 `npm run theme:generate` 更新生成的 `src/renderer/src/theme-tokens.css`。

组件 CSS 只引用语义变量，不定义色值。`palette.css` 将历史变量名映射到主题变量，并保留必要的统一控件规则；它不再是一份独立配色表。

| 变量 | 用途 |
| --- | --- |
| `--theme-canvas` | 页面、代码编辑器、工作区底色 |
| `--theme-panel` | 文件列表、侧栏、分组背景 |
| `--theme-surface` | 输入框和固定面板 |
| `--theme-raised` | 菜单、弹窗等抬升表面 |
| `--theme-text` / `--theme-muted` | 正文、辅助说明 |
| `--theme-line` / `--theme-strong-line` | 分隔线、需要辨识的边界 |
| `--theme-action` / `--theme-on-action` | 主操作底色、主操作文字 |
| `--theme-accent` / `--theme-selected` | 强调文字、选中底色 |
| `--theme-focus` | 中性键盘焦点提示，无蓝色光圈 |
| `--theme-detail` | 装饰色标、分类选中线；ModMind 使用 Logo 金色，不用于正文 |
| `--theme-success*` / `--theme-warning*` / `--theme-danger*` | 语义状态；不随用户强调色失去含义 |
| `--theme-console*` | 日志和终端等固定深色阅读区域 |
| `--theme-shadow` / `--theme-scrim` | 阴影、遮罩；透明度用 `color-mix` |

新增主题必须提供浅深模式。正文、辅助文字、强调文字在页面/面板上的对比度，以及主按钮文字的对比度均有自动检查。

## 内嵌界面

- Monaco 使用同一 TypeScript 主题表生成主题；配色切换时保留文档和草稿。
- Blockbench 的 UI 颜色通过桥接接口读取同一主题表。
- miniPaint 接收宿主计算好的颜色变量，不再保存另一份浅深配色。
- 插件收到 `hostInfo.palette`、`hostInfo.themePreset` 和后续 `themeChanged` 消息；应用内脚手架与可复制的面板、悬浮窗模板共用 `src/shared/pluginUi.ts`，自动应用主题与滚动条，并提供统一的工具栏、按钮、表单、列表及状态反馈。`plugins:check` 已加入主题检查，`plugins:smoke` 验证真实沙箱交互。已有第三方插件需消费这个接口，宿主不跨越 iframe 沙箱强改第三方 DOM。
- 图片像素、材质、Minecraft 富文本格式、任务书中持久化的游戏配色和代码语法色属于内容，不当作应用底色替换。

## 防回退检查

### 共享滚动条

`src/shared/scrollbars.ts` 是滚动条规格与样式的唯一入口，`AppScrollbars` 覆盖页面、列表、弹窗和横向滚动区。轨道与角落透明、无箭头，10 px 拖动区域中的滑块默认 4 px，悬停为 6 px；颜色跟随主题，按下加深。使用浏览器原生滚动，保留触控、滚轮、键盘、选区自动滚动和虚拟列表行为，不增加额外容器或滚动事件监听。折叠侧栏和纯横向标签保留隐藏滚动条的规则。

Monaco 读取相同规格与滑块色；Blockbench、miniPaint 通过已有主题桥接接收共享样式。插件协议提供 `scrollbarStyle`，新插件模板自动应用；已有第三方插件需自行消费。主题检查禁止页面 CSS 再定义单独的滚动条皮肤。

滚动条两端留出 12 px。设置页顶部搜索/分类栏不参与滚动，下方内容使用共享 `ScrollArea`，滚动条槽位自然从分类栏下方开始，不会在标题区域露出背景。分类换行时依靠弹性布局自动适配，不测量固定高度。切换设置分类/搜索重置内容滚动位置，切换页面仍保留原有位置恢复。

`npm run theme:check` 检查生成文件是否与主题表一致，并禁止应用 CSS、JSX 样式和主题适配器重新写死颜色。该检查已经加入 `prebuild`。

验证命令：

```text
npm run theme:generate
npm run theme:check
npm run typecheck
npx vitest run src/shared/appTheme.test.ts
node scripts/appearance-smoke.mjs
node scripts/theme-audit-smoke.mjs
node scripts/theme-details-smoke.mjs
```

页面审查脚本使用独立用户目录和本地工程。主题保存调用实际 IPC；只对与主题无关的远程目录查询提供固定数据。逐页截图和报告写入 `test-results/theme-audit-live/`、`test-results/theme-details-live/`。

## 已覆盖页面

| 项目范围 | 页面 |
| --- | --- |
| 无项目 | 项目选择 |
| 整合包 | 工作台、灵感台、模组列表、模组下载、文件清单、配置与默认项、脚本与 KubeJS、数据包、FTB 任务书、Patchouli 指南书、图像工坊、资源包、光影包、界面资源、存档与世界、玩家预设、服务端配置、文件工作台、代码、版本迁移、反编译、依赖与优化、服务端测试、游戏测试、发布、版本记录、设置、插件管理 |
| Java 模组 | 工作台、模型、代码、前置与联动、构建与导出、版本与迁移、发布、Mappings |
| 服务端插件 | 工作台、依赖与联动、代码、服务端测试、构建与导出、版本迁移 |
| 基岩和网易工程 | 各自的工作台、构建与导出、版本记录 |
| 页内界面 | 设置五类、生产中心四个标签、图像工坊三种模式、确认弹窗 |
| 主题联动 | 全部整合包入口 × 四套配色 × 浅深模式；重载后恢复、第二窗口同步；Blockbench 和 miniPaint 各八组主题 |

审查覆盖空态、示例文件和配置表单；外部服务返回的图片、模型及用户第三方插件内容不计入应用配色一致性断言。
