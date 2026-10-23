# ModMind 开发者工作台

从项目选择页进入「ModMind开发者工作台」。简洁模式也提供同名入口。开发工程与普通 ModMind 项目各自保存；进入开发环境不会切换当前模组、整合包或领域项目。

## 第一版创作流程

1. 新建「功能包」或「自定义工作台」，填写名称和包 ID，选择保存位置。也可打开已有的开发工程，或点击「导入功能或工作台」选择现成的 `.mmfeature` / `.mmstudio` 和副本保存位置。
2. 在 AI 面板描述需求，或直接编辑源码。`manifest.json` 支持表单与 JSON 切换；工作台表单可编辑创建字段和两份 AI 上下文。
3. 点击「运行预览」。保存修改、类型检查、编译后，在隔离页面中加载 UI。页面按钮调用当前包在独立测试进程中的真实业务动作。
4. 在「调试」中调用业务动作或 MCP 工具。工作台包还可「创建测试项目」，回读生成文件、项目元数据和 AI profile。
5. 点击「导出」，生成 `.mmfeature` 或 `.mmstudio`。在 ModMind 功能管理中本地安装并确认来源，再验证实际宿主的使用效果。

UI 预览支持页面、深浅主题和指定桌面宽度。预览中的项目是测试数据；创建工作台测试项目后，刷新预览使用该测试项目。预览成功、动作调试成功和真实宿主安装成功是三个不同的结果。

工具栏下不设常驻说明或状态栏。任务进度、操作结果和错误只在需要时显示于工具栏，完整结果可展开查看。

## 工程与 SDK

```text
modmind.dev.json          独立开发工程身份
manifest.json            扩展包清单
main.ts                  activate、业务动作及工作台模板 provider
renderer.tsx             页面与 registerFeature
style.css                页面样式
assets/                  用户导入的图片、字体或文本
sdk/                     当前版本的可移植 SDK 类型
reference/               内置协议、开发指南和设计规范
.modmind-dev/            构建快照、测试数据、草稿、恢复点和开发对话
```

源码统一从 `@modmind/sdk` 导入 SDK。构建时把前端注册适配为现有 API 2 宿主入口，后端类型导入在编译后消除。工程不需要 ModMind 源码仓库、外部 Node 安装或运行仓库构建脚本。清单仍使用 `format: modmind-feature`、`apiVersion: 2`、`hostVersion: 1.5.0-plugintest`，领域使用 `apiVersion: 1`。

SDK 类型、React/Node 类型与资源导入声明接入编辑器。构建另行执行 TypeScript 完整检查，不将语法转换等同于类型检查。

## 导入现有包

导入先校验 ZIP 路径、文件清单、SHA-256 和接口版本，再创建独立开发副本。同名目录已存在时自动换用新的目录；取消或包损坏不会覆盖原包或已有工程。导入只读取文件，不安装或执行包内代码。

发布包通常不包含原始 TypeScript/TSX。导入工程直接编辑 `main.cjs`、`renderer.js`、`renderer.css`、`manifest.json` 和包内资源，编辑器与 AI 都使用这些实际入口。构建检查 JavaScript 语法并重新生成校验和，保持原有资源路径和声明；预览、动作与 MCP 调试、工作台测试创建和重新导出沿用独立开发流程。导入工程同样支持草稿和 AI 恢复点。

预览按清单 `views[].component` 解析页面，支持直接注册命名组件导出表，也支持 SDK 附带的页面元数据。API 版本以包清单为准；注册对象没有 `apiVersion` 不代表不兼容，显式声明了不同版本时仍会拒绝。预览页的 ID、名称和顺序取自清单。

导入包预览沿用软件实际的组件解析规则，提供完整页面上下文、设置页、主题、对话框和共享编辑器。旧式 `window.modmind` 功能 API 由应用原有 preload 定义生成，通过预览传输调用；不会给缺失接口编造成功结果。表单与文件下载在沙箱中可用。

导入包的后端在独立 Electron 宿主中运行，使用原有 `FeaturePluginService`、能力注册与业务服务；项目和 profile 均位于开发工程的 `.modmind-dev/`，不会安装到用户主 profile 或切换主窗口项目。声明的依赖从已安装功能包或仓库构建产物复制，并验证文件校验和；缺少依赖时明确报错。只读检查、参数 schema、领域和平台约束仍经过原有服务校验。并行页面请求共用一次运行时初始化，动作沿用实际宿主的并发与业务锁，事件通过原有 preload 订阅回传。

目前开放当前包及其依赖的声明动作、目录查询和测试项目查询；全局账号、应用更新、切换真实项目等操作不向预览开放。跨页面导航和设置只在当前包中完成。需要外部游戏实例、探针或在线凭据的功能仍需相应资源，预览不生成游戏数据。包的文件数量与体积限制仍适用。

进入开发者工作台及切换开发工程使用应用统一的 Logo 加载遮罩，完成初始读取或读取失败后释放遮罩；浅色模式为白底，深色模式沿用主题。

## 独立边界与工具实现

开发业务位于 `src/main/developer/`、`src/renderer/src/components/developer/` 和 `resources/developer-kit-src/`。它拥有自己的工程模型、文件服务、编译器和打包流程。新建 SDK 工程继续使用轻量 Node 测试运行时；导入现有包时使用独立 Electron 兼容宿主，以实际业务实现验证现有包。

现有 AI 工作台的界面、对话投影、模型与凭据配置、Agent 执行、MCP 传输及审批继续复用。基础编辑器、加载遮罩、主题和编译库属于通用基础设施。兼容预览复用宿主契约与运行服务，但只在独立进程、测试项目和 profile 中激活扩展；开发工程与普通项目的生命周期保持独立。导入操作本身仍只验包和复制，不执行代码。

开发 AI 发现的工具：

| 工具 | 能力 |
| --- | --- |
| `modmind_dev_read` | 工程信息、文件列表、源码、SDK 与参考文档；返回写入所需 revision |
| `modmind_dev_write` | 在当前开发目录创建或更新文本文件，检查修改版本 |
| `modmind_dev_build` | 类型检查、契约校验、快照编译和打包 |
| `modmind_dev_debug` | 独立进程中的动作、MCP 调试和工作台项目创建 |
| `modmind_dev_preview` | 返回实际 UI 预览截图，供 AI 检查画面 |
| `modmind_dev_export` | 回读当前构建的本地安装包引用与验证信息 |

UI 与 MCP 使用同一开发服务。调用核对工程会话、相对路径、revision、输入 schema 和只读权限；切换工程后旧工具闭包失效。普通项目工具不会进入开发工作区的工具目录。MCP 调试经过 JSON-RPC 初始化、工具发现和 `tools/call`，显示业务结果并保留通信记录。

预览使用单独的 `modmind-dev-preview:` 协议、有限期内存资源和沙箱 iframe，不暴露 Electron preload 或 Node 接口。页面网络请求与外部导航被限制。业务代码在独立 Node 测试进程中运行，拥有原生包本身的本地权限；独立进程和测试目录不等于操作系统权限沙箱。

## 保存、恢复与离线

切换文件保留草稿；保存使用内容 revision，冲突保留输入并要求重新读取、合并。未保存源码草稿存入开发工程，重新打开时恢复。更多操作提供重新读取当前文件。

AI 开始前保存源码恢复点。「恢复 AI 修改前」保留当前源码作为反向恢复点，再次恢复可以取回。构建使用不可变快照，源码变化后旧构建不可继续调试或导出。构建失败保留源文件，可以修复后重试。

新建、源码编辑、配置、预览、调试和导出使用内置组件，首次断网可用。AI 对话仍依赖用户所选的模型服务。不会为开发工程下载 Minecraft、JDK 或游戏资源。

新建源码工程最多 512 个文件、单文件 4 MiB、合计 32 MiB。导入包工程合计最多 128 MiB，允许保留较大的原生资源；文本编辑最多 16 MiB，二进制资源原样保留。导出包最多 512 个校验文件、ZIP 64 MiB、解压内容 128 MiB。构建目录最多保留三个快照。SDK 和协议参考由应用管理。

新建源码工程内置 React、ReactDOM、Lucide 和 Node 标准库；额外 npm 包、异步 scaffold、接管 provider、任意布局拖拽和商店发布仍未接入。导入包的设置页、声明依赖和宿主功能 API 由兼容宿主验证。原生 Electron 子视图、完整游戏启动等需要额外界面承载的流程，仍须在完整目标宿主中验收；不能以挂载了外围页面代替这些流程成功。

## 选型与安装包资源

采用仓库锁定版本：Monaco 0.56.0（MIT）、esbuild 0.25.12（MIT）、TypeScript 5.9.3（Apache-2.0）、React 18.3.1（MIT）、Lucide 0.468.0（ISC）、Archiver 5.3.2（MIT）、Ajv 8.x（MIT）。导入复用仓库已有的 yauzl（MIT）和包格式校验，按条目读取并限制路径与解压大小，不新增依赖或自行实现 ZIP 解码。使用现有成熟编辑、类型检查、编译、校验和 ZIP 能力，由独立开发服务组织流程。

评估过 Sandpack。其在线 bundler 或自托管与离线转译资源准备不适合本地 Node 动作调试，因此选择本地工具链。第一版不引入拖拽搭建器。编译工具、类型和平台对应的 esbuild 二进制随 `developer-kit` 分发；它们是开发运行组件，体积约数十 MiB，并在构建时生成第三方声明。

esbuild 的 JavaScript 接口作为外部依赖原样放在工具包的 `node_modules/esbuild`，与对应平台的编译器一同分发；不再把依赖自身路径的代码合并进 Worker。运行时仍显式指定随包编译器路径，工具包离开仓库的 `node_modules` 后也可离线编译。

上游：[Monaco](https://github.com/microsoft/monaco-editor)、[esbuild](https://github.com/evanw/esbuild)、[TypeScript](https://github.com/microsoft/TypeScript)、[Sandpack bundler 部署说明](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)。

## 构建与验收

```powershell
npm run developer:kit
npm run typecheck
npx vitest run src/main/developer/service.test.ts src/main/agentToolReadiness.test.ts src/main/externalAgents.test.ts
npx electron-vite build
node scripts/developer-workbench-smoke.mjs
```

`predev`、`prebuild` 自动准备开发组件；Electron 打包通过 `extraResources` 分发。运行时从资源目录读取编译与调试组件，不依赖安装目录中的开发依赖。

定向回归覆盖两种包的创建、编辑、构建、安装器验包、动作与 MCP、参数错误、只读限制、路径越界与链接拒绝、旧会话失效、类型错误修复、草稿和可逆恢复点。Electron 验收使用全新断网 profile，验证真实页面交互、两种包导出及真实宿主安装/项目创建，并保存深浅主题和 1080×680 / 1440×900 的画面。

AI 验收中的确定性 Agent 传输夹具替代收费模型服务；其工具发现、MCP 进程、文件修改、编译、调试、截图和导出均使用实际实现。它验证接入闭环，不证明任意在线模型都能生成正确扩展。
