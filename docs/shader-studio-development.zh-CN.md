# 光影工作台与相关功能开发指南

光影工作台由 `studio-shader.mmstudio` 和五个独立 `.mmfeature` 功能包组成。领域包负责项目身份、创建、接管和 AI 上下文；源码、选项、预览、游戏验证、检查导出分别安装和启停。本指南按 2026-10-07 的仓库源码整理当前功能、任务路径与开发位置，具体工具参数见 [光影 MCP 调用参考](shader-studio-mcp.zh-CN.md)。

## 1 模块与兼容基线

| 包 ID | 源码清单版本 | 页面与职责 | MCP 工具数 |
| --- | --- | --- | --- |
| `studio-shader` | `1.2.0` | 新建、接管、领域任务、工作台与灵感台 profile | 0 |
| `shader-source` | `1.0.1` | 光影源码：搜索、读取、Monaco 编辑、保存与撤销 | 2 |
| `shader-options` | `1.1.0` | 光影选项：选项、预设、程序开关、分组搜索与回写 | 2 |
| `shader-preview` | `1.0.1` | 效果预览：final 阶段、样例场景、昼夜与轨道视角 | 1 |
| `shader-testing` | `1.1.0` | 游戏验证：手动部署、实例证据、环境检测与隔离会话 | 3 |
| `shader-export` | `1.0.1` | 检查与导出：结构、语法诊断、ZIP 与完整性回读 | 2 |

五个功能包都只硬依赖 `studio-shader`，不互相要求安装。`shader-shared` 是共用源码目录，没有独立安装包。单独安装游戏验证包也能调用其内部导出逻辑，无须先安装导出页面。

| 身份或协议 | 当前值 |
| --- | --- |
| 包 ID / 领域 ID | `studio-shader` / `minecraft-shader` |
| 项目 kind / loader | `shader` / `iris` |
| 默认新建目标 | Minecraft `1.21.1` |
| 包 API / 领域 API | `2` / `1` |
| 固定宿主协议 | `hostVersion: "1.5.0-plugintest"` |
| 仓库主程序版本 | `1.5.0-preview.3` |
| 领域宿主能力 | `studioV1`；功能构建器补 `runtime` |
| 隔离会话适配器目标 | Minecraft `26.2`、Iris `1.11.2`、本地 Java `25` |

新建默认版本与隔离测试目标是两件事。默认 `1.21.1` 项目可编辑、检查、导出和手动部署；隔离会话能力检测会报告版本不支持。适配器目标表示实现范围，实际 Minecraft / Iris 运行验收仍待完成。

功能页按当前领域筛选。包级和贡献级 `studioIds` / `loaders` 共同限定页面、设置与动作；只有当前 Iris 光影项目能执行这些业务。两个 AI 页面和代码编辑器始终保留，通用构建页由领域声明隐藏。安装、停用、卸载和项目恢复复用 [mmfeature](mmfeature-development.zh-CN.md) 与 [mmstudio](mmstudio-development.zh-CN.md) 协议。

## 2 安装、新建与接管

在“功能”页安装光影工作台，再按任务选择五个功能。开发包从本地安装入口选择 `feature-plugin-dist/<包ID>.mmstudio` 或 `.mmfeature`，保留来源信任确认。安装仅注册能力，不扫描或修改项目，不下载 Minecraft、Iris、JDK 或玩家存档。

新建表单声明项目名称、Iris 环境、Minecraft 目标版本和自然 / 鲜明初始色彩。模板生成地形与通用纹理程序、final 色彩处理、include 选项、配置、双语标签、README 和模板许可证。初始 `quality` 值只选择模板色彩，不是完整画质档位或运行中的 Iris 预设。

```text
项目根目录/
  modmind.project.json                宿主生成的领域元数据
  README.md
  LICENSE.txt
  shaders/
    gbuffers_terrain.vsh / .fsh
    gbuffers_textured.vsh / .fsh
    final.vsh / .fsh
    lib/options.glsl
    shaders.properties
    lang/zh_cn.lang / en_us.lang
  .modmind/                          对话、恢复与测试数据
  build/                             导出产物
```

模板包含纹理、顶点颜色、lightmap、alpha test，以及曝光、饱和度、对比度。它提供可继续开发的基线，真实游戏效果须另外验证。

“接管现有项目”识别含 `shaders` 与 `.vsh` / `.fsh` / `.gsh` / `.csh` 程序的完整源码文件夹。接管原地补写领域元数据，保留已有源码、资源、配置与许可证。识别器当前推断目标为 `1.21.1`，这不是对作者原始兼容版本的证明，接管时应核对目标。光影 ZIP 暂不直接接管，应先解压成源码文件夹；仅有编译产物也不能替代原工程。

## 3 按任务使用五个功能

| 任务 | 建议路径 | 验证与恢复 |
| --- | --- | --- |
| 修改一个已有程序 | 源码搜索 → 读取文件 → 编辑 → 保存 | 保存后回读；版本冲突先重读；必要时撤销 |
| 调整效果档位 | 选项查询 → 查看值域、分组、预设诊断 → 保存 | 选项与程序覆盖一起回读；异常预设不部分套用 |
| 快速判断色彩方向 | 保存源码 → 打开效果预览 → 刷新 → 调整昼夜或视角 | 核对 final 源码哈希；缺少 uniform 转游戏验证 |
| 在已有实例中查看 | 交互选择 Iris 实例 → 部署 → 用户启动并选包 | 查看部署后的日志和实例截图；部署失败可重试 |
| 使用隔离测试会话 | 绑定实例与运行库 → 检测环境 → 启动 → 查询就绪 → 用户进入世界 → 观察 / 重载 → 停止 | 核对实际包、管线、有效选项与进程退出 |
| 交付 ZIP | 检查 → 修复阻断项 → 导出 | 回读 ZIP 大小、SHA-256 与工程 revision；保留检查范围 |

### 源码与恢复

光影保存工具只编辑 `shaders/` 内已有文本；新建程序、图片、许可证等复用主程序项目编辑器。`read` 返回单文件 SHA-256，`save` 必须带该文件 revision。选项保存使用整个发行内容的 inventory revision，不能混用两种版本号。

源码与选项包共享按项目串行的写入队列。改写前记录 before / after，失败回滚已写文件；两类页面的 undo 都撤销最近一次已提交的光影修改，可能涉及另一页面或多个文件。撤销会核对当前内容，拒绝覆盖后续外部修改。

恢复记录位于 `.modmind/shader-history/`，按最多 20 次、32 MiB 清理并优先保留当前记录。路径、链接、容量和跨项目检查集中在业务服务中，不能依赖前端隐藏按钮。

发行内容扫描限制为 2048 个文件、128 MiB、单文件 16 MiB、目录深度 16；着色器和受控文本读取 / 保存限 2 MiB。include 展开拒绝循环、越界、超过 32 层或累计 8 MiB，额外的 256 KiB 本地语法解析阈值按阶段单独计算。

### 选项与预设

识别带值域的 define、被引用的布尔宏和白名单内 Iris const 选项；排除 include guard、未引用内部宏和块注释。重复声明不一致时返回诊断并禁止不安全回写。

支持预设继承、布尔项、`=` / `:` 值、续行和 `!program.NAME`。查询同时提供展开的选项 `profiles`、程序覆盖 `profilePrograms`、错误 `profileIssues`、菜单分组和 `configurationConditional`。循环、未知选项、非法值、重复预设或不存在的程序不会被静默跳过后部分应用。

保存程序覆盖回写 `program.NAME.enabled`，条件配置、重复或跨行程序属性会拒绝修改。显示的源码值与展开预设不等于运行中 Iris 的有效选项；实际值由会话 observation 查询。预设名称也不能作为“最高画质”的判断依据。

### final 快速预览

Three.js 生成方块地形与水面样例输入，只运行当前工程的 `final.fsh`，支持 `colortex0`、`viewWidth`、`viewHeight`、`frameTimeCounter` 和 `texcoord`。不复现 gbuffers、阴影、维度、其他纹理、geometry / compute、完整 Iris uniforms 与 GLSL 变换。

MCP `preview-image` 只回读已打开、可见、编译成功且源码哈希一致的当前项目画布；不自动打开页面。未打开、模态框遮挡、编译错误、旧源码或截图时项目切换都会拒绝。结果是最大宽度 1024 的 PNG 预览，标记 `scope: 'final-only'` 与 `gameVerified: false`。WebGL 不支持某种桌面 GLSL 不代表它在 Iris 中失败。

### 检查与导出

检查使用 ShaderFrog 解析当前预处理分支，提供结构、include 越界 / 循环、程序配对、容量与许可证诊断。面向 GLSL ES 的本地解析器不等同桌面 OpenGL 或实际 Iris 编译；诊断行号可能对应预处理后的源码。

geometry / compute 和展开超过 256 KiB 的阶段只检查 include，并返回 skipped。普通检查返回 `syntax-checked` 或 `failed`；隔离测试内部可使用 `structure-checked`、`parsed: 0`，让桌面 GLSL 交给 Iris。结构检查模式没有作为公共导出参数开放。

发行只包含 `shaders/` 与根目录 README / LICENSE / NOTICE / COPYING，排除项目元数据、会话、历史和 build。默认生成 `build/shader-<namespace哈希前12位>.zip`，回读整包 SHA-256 并核对工程 revision。当前不是逐条目冻结导出或游戏证据绑定；`gameVerified` 仍为 false。

## 4 游戏验证的两条路径

| 项目 | 手动部署 | 隔离会话 |
| --- | --- | --- |
| 目标目录 | 用户交互选择的现有 Iris 实例 | `.modmind/shader-sessions/<sessionId>/game` |
| 启动游戏 | 用户使用已有启动器 | 工作台复用已有 Fabric 运行库和本地 Java 启动所属 child |
| 版本条件 | 检测已有 Iris，具体兼容需用户验证 | 当前限定 Minecraft 26.2 / Iris 1.11.2 / Java 25 |
| 导出门槛 | 既有静态语法检查 | 结构与 include 检查，运行编译交给 Iris |
| 数据修改 | 复制专属 ZIP、旧包备份与部署记录；不改 Iris 配置 | 独立 mods、配置、日志、native 与光影 ZIP |
| 证据 | 部署后新增日志、现有实例截图 | 实际包名、管线、错误、有效选项、预设与会话状态 |
| 当前截图能力 | 读取现有截图；不自动生成 | 尚无会话原生截图和固定场景自动化 |

绑定实例与运行库都只能通过应用目录选择器。运行库目录需包含 `versions`、`libraries`、`assets`；可信绑定保存在用户应用目录 `shader-testing/bindings/`。MCP 不接收外部目录、Java 路径、JVM 参数或 PID。

手动部署将包复制到 `shaderpacks/`，覆盖前备份到 `.modmind-backups/`，复制后核对 hash。部署记录保存日志字节偏移，查询最多读取新增日志尾部 128 KiB；`fresh` 和 `packMentioned` 分别表达时效与包名命中。截图按文件名排序取最多四张 PNG，读取时转为最大 1024×768 的 JPEG 缩略图，并保留原文件名。它们未绑定当前包或同帧设置，不能当作已自动核验的原生证据。

隔离会话仅复制 Iris 及其依赖闭包，不复制无关模组、玩家存档、配置或账号；已有游戏 JAR 与资产只读复用。每次 staging 以包 SHA-256 命名 ZIP，重载导出当前工程后在游戏线程调用 Iris。观察结果核对实际包名与管线，但启动返回 `preparing`、进程 `running`、会话 `ready` 和进入真实世界是不同状态。

当前每个服务只有一个活动会话，控制操作串行，凭 sessionId、实际 child PID、随机秘密和序号校验。停止先请求正常退出，无响应才终止所属进程，并报告 graceful / forced / not-started / exited。活动会话保护项目切换、删除及功能启停；任务取消、项目生命周期、插件关闭与 20 分钟总租约接入清理。应用重启不接管历史 PID；旧会话目录和世界目前保留，尚无自动容量清理策略。

## 5 领域任务与 AI

领域包不注册业务工具；安装对应功能后才发现其 MCP。两份 profile 的 skills 当前均为空，工具使用指导来自领域提示词与实时工具说明。

| 领域任务 | 目标包与 action | 实际行为 |
| --- | --- | --- |
| `check` | `shader-export.query`，默认 `operation: validate` | 静态检查 |
| `build` | `shader-export.package` | 生成项目内 ZIP |
| `export` | `shader-export.export` | 导出；应用窗口中提供保存对话框 |
| `test` | `shader-testing.test`，默认 `operation: deploy` | 手动部署到已绑定实例 |

`tasks.test` 不是隔离会话启动。隔离操作通过 `shader-testing.session` / `modmind_shader_session` 执行。以上任务是可选跨包引用，领域包不硬依赖导出或测试包；目标未安装会返回不可用，不能把引用改成循环依赖。

工作台可执行已选择的写入和进程工具，灵感台只保留查询。UI 和 MCP 使用相同业务服务、输入 schema、项目作用范围与操作审查；实际图片在公共 MCP 链路转换为图像内容块，不能只返回一个窗口位置。

## 6 源码导航

| 修改范围 | 入口 |
| --- | --- |
| 身份、创建表单、AI profile、任务绑定 | [studio-shader/manifest.json](../feature-plugins/studio-shader/manifest.json) |
| 领域 provider、模板、识别器 | [main.ts](../feature-plugins/studio-shader/main.ts)、[shaderTemplates.ts](../feature-plugins/studio-shader/src/main/shaderTemplates.ts)、[shaderAdoption.ts](../feature-plugins/studio-shader/src/main/shaderAdoption.ts) |
| 页面、action、tool 声明 | 各 `shader-*/manifest.json`、`main.ts`、`renderer.tsx` |
| 项目身份、写入许可与调用包装 | [shaderFeature.ts](../feature-plugins/shader-shared/src/main/shaderFeature.ts) |
| 路径、容量、扫描、共用写入队列 | [shaderFiles.ts](../feature-plugins/shader-shared/src/main/shaderFiles.ts) |
| inventory、文件保存、选项回写、include、恢复 | [shaderSourceService.ts](../feature-plugins/shader-shared/src/main/shaderSourceService.ts) |
| define / toggle / const、预设、分组解析 | [shaderOptionParser.ts](../feature-plugins/shader-shared/src/main/shaderOptionParser.ts) |
| 语法诊断与 ZIP | [shaderValidationService.ts](../feature-plugins/shader-shared/src/main/shaderValidationService.ts)、[shaderExportService.ts](../feature-plugins/shader-shared/src/main/shaderExportService.ts) |
| final 场景与图像回读 | [FinalPreview.tsx](../feature-plugins/shader-preview/components/FinalPreview.tsx)、[shader-preview/main.ts](../feature-plugins/shader-preview/main.ts) |
| 手动实例、日志、截图、部署 | [shaderTestingService.ts](../feature-plugins/shader-shared/src/main/shaderTestingService.ts) |
| 运行库、Iris 依赖闭包、Java 与可信绑定 | [shaderRuntimeEnvironment.ts](../feature-plugins/shader-shared/src/main/shaderRuntimeEnvironment.ts) |
| 会话、进程、重载与退出 | [shaderSessionService.ts](../feature-plugins/shader-shared/src/main/shaderSessionService.ts) |
| Java 控制协议与编译索引 | [shaderSessionAgentClient.ts](../feature-plugins/shader-shared/src/main/shaderSessionAgentClient.ts)、[ShaderSessionAgent.java](../resources/shader-runtime/ShaderSessionAgent.java)、[shaderSessionAgent.json](../feature-plugins/shader-shared/src/main/shaderSessionAgent.json) |
| 结构化返回类型 | [shaderStudio.ts](../src/shared/shaderStudio.ts) |
| 页面布局和反馈 | 各功能包 `components/` 与 [ShaderFrame.tsx](../feature-plugins/shader-shared/components/ShaderFrame.tsx) |

`studio-shader/src/main/shaderService.ts` 是兼容 re-export 入口，实际功能包按职责导入 shared 服务。新增业务先复用 shared 的项目、写入、恢复和已有宿主服务，按任务扩展现有 action；新增查询或操作同时更新 tools、schema、UI 与实际 MCP 验证。视觉规则以 [设计规范](design-spec.zh-CN.md) 为准。

## 7 构建、回归与发布

沿用仓库 Node.js 22 与锁定依赖。六个包的单包构建分别为：

```powershell
node scripts/build-feature-plugins.mjs --only=studio-shader
node scripts/build-feature-plugins.mjs --only=shader-source
node scripts/build-feature-plugins.mjs --only=shader-options
node scripts/build-feature-plugins.mjs --only=shader-preview
node scripts/build-feature-plugins.mjs --only=shader-testing
node scripts/build-feature-plugins.mjs --only=shader-export
```

仅修改业务时构建对应包；修改 shared 时重建受影响包；`--only` 仍会更新元数据目录，不生成主程序安装器。预览、选项、语法、会话分别复用已有 Three.js 0.180.0（MIT）、ShaderFrog 7.0.1（ISC）、XMCL Core 2.15.1（MIT）和宿主进程设施，许可证随相关包分发。

更改 Java adapter 源码后执行：

```powershell
node scripts/compile-shader-session-agent.mjs
```

该脚本需要本地 javac，以 `--release 17` 编译并更新 class / 源码 SHA-256；构建 testing 包时校验源产物一致性。class 格式为 Java 17 不代表游戏可用 Java 17 启动，隔离目标仍要求 Java 25。

```powershell
npm run typecheck
npx vitest run feature-plugins/shader-shared/src/main/shaderOptionParser.test.ts feature-plugins/studio-shader/src/main/shaderService.test.ts feature-plugins/shader-shared/src/main/shaderSessionService.test.ts src/main/shaderStudioMcp.test.ts
```

实际 MCP 回归依赖 `feature-plugin-dist/` 的对应包。`node scripts/shader-studio-smoke.mjs` 用已有主程序构建和隔离配置验证页面、安装、实际应用 MCP、深浅主题、1280px / 390px、预览与异常恢复。JVM / Iris 元数据和日志夹具只能证明业务协议与生命周期；真实游戏、固定场景和画质要单独验收。




## 8 完成范围与后续边界

| 范围 | 当前状态 |
| --- | --- |
| 项目创建、源码接管、五包独立安装与恢复 | 已实现 |
| 选项 / 预设 / 程序覆盖、保存回读与撤销 | 已实现，描述源码配置 |
| final 样例预览与源码匹配图像 | 已实现，限 final 阶段 |
| 静态检查、项目内 ZIP、手动部署和实例日志 / 截图读取 | 已实现，游戏验证标记保持 false |
| 本地环境检测、隔离会话、实际状态接口、重载和退出 | 已实现；实际 Minecraft 26.2 / Iris 1.11.2 验收待完成 |
| 固定世界、场景 / 机位、动态路径、自动原生 PNG 与同帧证据 | 待实施 |
| GPU 计时、同条件性能比较、帧诊断和动态画质回归 | 待实施 |
| 实际 Iris / 驱动检查、逐 ZIP 条目冻结导出、证据绑定报告 | 待实施 |

仓库已有 [11 条应用 UI / MCP 场景记录](../test-results/shader-studio/1791300476849/result.json) 和 [发布包回读及实际 EXE 安装记录](../test-results/official-feature-publication/1791301555021/report.json)，均保留 `actualGameVerified: false`。发布完成、JVM 夹具通过、管线存在和画质认可分别报告。

历史与后续计划见 [1.1 初版记录](shader-studio.zh-CN.md) 和 [升级方案与分批实施记录](shader-studio-promax.zh-CN.md)。前者的初版能力限制不覆盖后来新增会话；后者规划的 C / D / E 不应写成已交付功能。
