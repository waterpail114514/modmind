# 光影工作台 1.1 初版记录

当前模块版本、功能范围与开发入口见 [光影工作台与相关功能开发指南](shader-studio-development.zh-CN.md)，工具参数和任务路径见 [光影 MCP 调用参考](shader-studio-mcp.zh-CN.md)。本文保留 1.1 初版实现与验收记录，初版的“暂无自动启动 / 热重载”等边界不覆盖后来新增的隔离会话。

2026-10-06 升级计划与实施状态见 [光影工作台升级方案](shader-studio-promax.zh-CN.md)。该文档区分已交付里程碑与后续游戏 / GPU 能力；下文保留 1.1 基线范围。

第二批新增本地环境检测与独立 Iris 会话，统一 start / state / observe / reload / stop，经 MCP 和 JVM 夹具验证。目标适配 Minecraft 26.2 / Iris 1.11.2 / Java 25，实际游戏验收未完成；其他版本保留手动部署。运行库由用户交互选择，不自动下载游戏，不复制玩家存档或配置；范围与限制以升级记录为准。

本模块按领域工作台协议实现，模块 ID 为 `studio-shader`，领域 ID 为 `minecraft-shader`，项目类型为 `shader`，目标为 `iris`。这是按需安装的第四个工作台，三个基础工作台仍随主程序内置。

## 安装与功能

在“功能”页安装官方光影工作台后可新建、接管光影项目；也可从本地安装入口选择 `feature-plugin-dist/studio-shader.mmstudio`，确认信任后安装。新建项目不再提供“自定义 +”安装入口。领域包不包含功能页面与操作工具。下列五个 `.mmfeature` 包分别安装、启停、卸载；它们只依赖领域包，不要求安装其他光影功能。安装不扫描或修改已有项目，不下载 Minecraft 或 Iris。停用功能后对应页面和 MCP 工具消失，项目文件与恢复记录保留。

| 功能包 | 页面与任务 |
| --- | --- |
| `shader-source` | 光影源码：文件搜索、复用 Monaco 编辑 GLSL / 配置 / 语言、保存冲突检测、撤销上次保存；图片、许可证等交给已有项目编辑器 |
| `shader-options` | 光影选项：识别 define 选项、sliders、简单 profile，数值滑块、预设与源码回写 |
| `shader-preview` | 效果预览：工程 final.fsh 片元处理，Three.js 方块地形与水面输入、昼夜、轨道视角与重置 |
| `shader-testing` | 游戏验证：已有 Iris 实例、部署并校验 ZIP、旧包备份、新增日志和最多四张实际截图 |
| `shader-export` | 检查与导出：容量、文件与 include 边界 / 循环、语法、程序配对、许可证提示、可验证 ZIP |

功能页默认按当前工作台筛选，安装并启用的适用页面才进入侧栏；“全部工作台”可查找其他领域功能，不能直接打开不适用的页面。清单顶层 `studioIds` / `loaders` 和页面 `views.studioIds` 与原页面条件共同生效。光影两份 AI profile 独立，明确区别概念、静态检查、final 预览与实际游戏证据；skills 列表为空。MCP 随所属功能安装和启停，查询与写入沿用同一业务服务。

## 新建与接管

新建表单由工作台声明项目名称、Iris 环境、Minecraft 目标版本与初始自然 / 鲜明色彩。生成地形与通用纹理程序、final 色彩处理、include 选项、光影配置、双语标签和模板许可证。地形处理包含纹理、顶点颜色、lightmap 和 alpha test；final 包含曝光、饱和度与对比度。模板是可继续开发的基础，不冒充高级光影效果或已通过实际游戏测试。

已有源码文件夹通过项目页“接管现有项目”识别，要求 shaders 中存在程序。按协议原地补写领域元数据，保留原源码、配置、资源和许可证。光影 ZIP 接管暂未提供，需先由用户解压成完整源码文件夹；导出 ZIP 已支持。

源码保存按内容 SHA-256 校验版本，改写前保存恢复记录，多文件选项改写失败时回滚已写文件；撤销拒绝覆盖后续外部修改。历史最多保留 20 次、32 MiB，当前记录优先保留。只有 shaders 内文本走光影保存工具；新建程序、贴图与其他文件复用主程序项目编辑器。文件路径、include、写入历史、导出目录与游戏实例操作拒绝链接路径及越界访问。

发行只包含 shaders 和 README / LICENSE / NOTICE / COPYING；不会包含项目元数据、AI 对话、历史或 build。导出在检查通过后生成 ZIP 并回读 SHA-256，导出报告明确 `gameVerified: false`。

## 预览与验证边界

Three.js 预览只运行 final 片元阶段，当前支持 colortex0、viewWidth、viewHeight、frameTimeCounter 和 texcoord。不是 Minecraft / Iris 的完整渲染器，不模拟游戏 gbuffers、阴影、维度、其他纹理、geometry / compute、Iris uniforms 或其 GLSL 变换。依赖不支持的 uniform 时明确转向游戏验证，GPU 编译错误可见。颜色输出经过 Three.js 颜色空间处理。GLSL 150+ 或使用其他输出接口的程序可能不支持 WebGL 预览，不能据此认定游戏里失败。

静态检查使用成熟预处理器和语法解析器，解析当前预处理分支，提供 MC_VERSION 与 IS_IRIS 的基础定义。诊断行号对应预处理结果，不保证等于 include 原文件行号。解析器面向 GLSL ES 1 / 3，与桌面 GLSL 不完全等价；特殊桌面语法可能误报。geometry / compute 与展开超过 256 KiB 的阶段只检查 include，明确提示游戏编译验证，不能标记为完整编译通过。未提供原生 glslang 编译器、语言服务器、跨文件语义补全或自动性能分析。

游戏实例必须已由用户安装 Iris，使用 JAR 内 fabric.mod.json 的 id 确认，不能仅凭文件名。仅复制专属哈希命名 ZIP 到 shaderpacks，覆盖前保留 .modmind-backups 副本；不改写 Iris 配置、安装 mods 或执行项目代码。用户自行用已有启动器启动游戏并选择部署的包；软件随后读新增日志及截图。日志记录从部署时的字节位置起读，旧日志中的包名不能作为新证据；日志轮换按更新时间和包名分别报告。无错误、出现包名或截图都不能单独证明所有效果正确。截图是实例实际文件，保留文件名，不自动判断对应哪一个包。暂无自动启动、游戏内热重载、基准 FPS / 帧时间采集、截图自动生成或实际账号游戏运行验收。

## MCP 与协议扩展

- `modmind_shader_query` / `modmind_shader_edit`：源码包的 inventory、read 与 save、undo。
- `modmind_shader_options_query` / `modmind_shader_options_edit`：选项包的 inventory 与 options、undo，要求工程 revision。
- `modmind_shader_preview`：预览包的 inventory、preview、preview-image。
- `modmind_shader_validate`：导出包的 inventory、validate。
- `modmind_shader_export`：检查并导出到项目 build，返回产物、大小、SHA-256 与检查报告。
- `modmind_shader_test_query`：游戏验证包的 inventory、test-state，返回实际实例日志与截图。
- `modmind_shader_test`：向已选择的实例 deploy 或打开目录；bind 要求交互应用窗口，MCP 不能传任意外部目标目录。

写入工具只在工作台开放，灵感台保留读取；同一应用功能服务执行 schema、活动调用和项目边界校验，MCP 沿用操作审查。工具发现用 action.studioIds 过滤，动作仍在运行时验证当前领域，不能把发现过滤当作权限检查。

test-state 的截图沿用宿主 captures 格式，在真实 MCP 返回图片内容块，AI 可查看实际实例中的截图；图像文件名与日志来源同时保留。UI 使用同一业务服务的图像结果，没有另建截图解析链路。

preview-image 回读已打开的当前项目 final 预览画布，返回 PNG 图片内容和展开源码 SHA-256；尚未打开、编译错误、源码变化或截图时切换项目均拒绝。只截取预览画布，不采集其他 UI；不自动切换页面，也不把示例画面标记为游戏验证。

本次增加小型通用协议能力：`navigation.hideCoreViews` 可以隐藏不适用的核心 build 页面，两个 AI 页面及项目编辑器保留；`navigation.compactSidebar` 声明窄窗口优先使用可展开的紧凑导航，不改写用户的桌面导航偏好；`StudioActionBinding.input` 为任务绑定提供默认参数，仍经目标 action schema 校验。宿主 build / export 有声明时路由到领域任务，光影不走 Gradle / Add-on 构建。导航与业务没有按光影名称硬编码分支。

## 选型与成本

| 上游 | 选择与限制 |
| --- | --- |
| ShaderFrog glsl-parser 7.0.1，ISC | 纯 JavaScript，约 0.7 MiB 解包，解析与预处理随模块打包，离线可用；面向 ES 语法，不能替代 Iris OpenGL 编译。npm 依赖固定版本，包 metadata 声明 ISC / Andrew Ray，发行包内附授权声明 |
| Three.js 0.180.0，MIT | 复用仓库已有渲染库与 OrbitControls，只作为示例场景和 final 预览，不复制游戏引擎；发行包附许可证 |
| Iris ShaderDoc | 核对 shaders 结构、程序、纹理 / lightmap、alpha test 与 final 模式；仅作为接口依据，没有复制其文档或整套光影代码 |
| Iris glsl-transformer | Java / ANTLR 解析与变换成熟，但需要 Java 集成和 Iris 运行语义，不为静态工作台引入整套运行环境 |
| Khronos glslang | 桌面 GLSL 编译更全面，但原生或 Vulkan/WASM 目标与 Minecraft compatibility 管线有差异，本版未将其包装成虚假的 Iris 编译验证 |

来源：<https://github.com/ShaderFrog/glsl-parser>、<https://github.com/mrdoob/three.js>、<https://github.com/IrisShaders/ShaderDoc>、<https://github.com/IrisShaders/glsl-transformer>、<https://github.com/KhronosGroup/glslang>。模板逻辑是本项目对这些接口的独立小型实现；新模块不下载领域大资源。新增解析器放在开发依赖中，构建内嵌到光影包，不增加主程序运行依赖。

## 构建与验收

```powershell
npm run features:build
npm run typecheck
npm run build
npx vitest run feature-plugins/studio-shader/src/main/shaderService.test.ts src/main/shaderStudioMcp.test.ts src/main/studioRegistry.test.ts src/renderer/src/navigationDefinitions.test.ts src/main/appChangelogService.test.ts src/main/featureStoreService.test.ts
node scripts/shader-studio-smoke.mjs
```

单元与实际 MCP 验证创建、真实 GLSL、选项源文件回写、冲突、撤销、include 错误、导出内容、源码与实例路径、领域切换和只读拒绝。Electron 验收脚本保存真实 UI 截图、canvas 像素和场景报告到 test-results/shader-studio/<时间>/，首次配置断网且不修改真实应用用户目录。游戏部署使用明确标记的本地 Iris JAR 元数据和日志夹具，仅验证工作台交互与复制 / 证据流程，不声称实际游戏运行成功。

此版本已上传官方功能源，未生成主程序安装器或修改用户游戏实例。工作台包可从官方功能页或本地安装，需配合本次协议扩展后的主程序。

2026-10-05 拆分后验收完成：全部功能包与主程序构建、双端 TypeScript 和主题 / 插件界面检查通过；47 项相关回归通过。真实 MCP 校验每包独立安装、工具发现与调用、停用、卸载、源码保留、重新安装、只读限制及领域和项目切换。实际应用 MCP 回读 final 预览图片内容，核对源码哈希并拒绝过期画面。离线 Electron 共 9 条场景通过，无页面脚本错误；五个功能包逐个安装、停用、卸载和恢复，深浅主题、1280px / 390px、canvas 像素、轨道拖动、昼夜和窄导航展开 / 收起均验证。最新记录为 `test-results/shader-studio/1791212835230/result.json`。实际游戏验证标记为 false；部署与日志使用明确的夹具，不代表真实游戏已运行。

