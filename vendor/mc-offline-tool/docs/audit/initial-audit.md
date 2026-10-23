# initial-audit.md —— 当前两个 feature 的初始审计

- 依据：《Minecraft Universal Studio 项目落地智能体规范》v1.0（2026-10-12）**Task 1** 与 §2.4 的必含项
- 审计时间：2026-10-12 19:3x
- 审计方式：**对包内产物与源码工程逐个实测**（解包比对、源码字符串扫描、逐 action 读 manifest、跑既有闸门）
- 记录约定：**事实**＝本次实测得到；**推断**＝由事实推出但未直接观测；**未验证**＝没测/没条件测

---

## 1. 仓库目录、源文件与生成文件的关系（事实）

源码工程**存在**（不是只有打包产物）。三块源码 + 一条构建链：

| 功能包 | 源码位置 | 构建脚本 | 产物 |
| --- | --- | --- | --- |
| **mc-pull** | `pull-feature/backend/main.js`（后端）+ `pull-feature/src/feature-entry.jsx`（渲染器） | `pull-feature/build/build-feature.mjs` | `pull-feature/dist/mc-pull-<ver>.mmfeature` + `dist/main.cjs` / `renderer.js` / `renderer.css` |
| **mc-preview** | ★ **跨两个目录**：`preview/`（应用源：`index.html`、`app.css`、`src/*.js`、`vendor/`、`data/`）+ `preview-feature/`（功能包壳：`backend/`、`src/feature-entry.jsx`、`build/`） | `preview-feature/build/build-feature.mjs`（内含 `pack.cjs`） | `preview-feature/dist/mc-preview-<ver>.mmfeature` |
| **Runtime Probe** | `probe/fabric-1.21/`（Gradle+Loom）+ `.work/probe-src/`（Forge 1.20.1，手搓 javac） | `probe/build-fabric.ps1`、`tools/build-probe.ps1` | `.work/dist/modmind-probe-<loader>-<mc>-<ver>.jar`（现有 4 个） |

**关键事实（构建链是"抽出式"而非手工两份）**：`preview-feature/build/build-feature.mjs` 从 `preview/index.html` 抽出 `#app` 标记生成 `dom-template.generated.js`、从 `preview/app.css` 生成 `css.generated.js`，
并对 CSS 做两处必要改写（`:root{` → `:host{`；`height:100vh` → `height:100%`），再与 `preview/src/*.js` 一起打包成 `renderer.js`。
⇒ **改前端只改 `preview/`，不要改 `renderer.js`**（那是产物）。

**生成物 vs 源**（不要直接改产物）：`*/dist/*`、`preview-feature/src/*.generated.js`、`preview/src/block-defaults.generated.js`。

---

## 2. 宿主 feature API、renderer 与 main 的通信方式（事实）

**manifest 共同字段（两包一致，实测）**：
`format: modmind-feature`、`apiVersion: 2`、`hostVersion: 1.5.0-plugintest`、`hostCapabilities: ["runtime"]`、
`dependencies: []`、`main: main.cjs`、`renderer: renderer.js`、`style: renderer.css`、
`capabilities[]`（1 条）、`views[]`（各 1 个：`pull` / `preview`）、`actions[]`、**`files{}`（逐条目 sha256）**。

**通信方式（推断，依据 = 既有假宿主与源码）**：renderer 通过 `modmind.featurePlugins.invoke(featureId, action, input)` 调后端 handler；
后端 `activate()` 返回 `handlers` 表（`<action 去冒号>` → 函数）。
既有假宿主 `preview-feature/.work/serve-feature.mjs` 复现了这套（含 `invoke`、`featurePlugins`、主题令牌、`props.project.path`）。

★ **`files{}` 逐条目 sha256 是包内自带的完整性清单** —— 规范 §2.3 没提到它，它是现成的强度，应保留并纳入发布校验。

### 2.1 mc-pull 的 action 与权限（实测，逐条）

| action | permission | projectRequired | handler |
| --- | --- | --- | --- |
| `pull:status` | `read` | false | `pull_status` |
| `pull:run` | `write` | false | `pull_run` |
| `pull:installProbe` | `write` | false | `pull_install_probe` |
| `pull:importProbe` | `write` | false | `pull_import_probe` |
| `pull:cancel` | `write` | false | `pull_cancel` |
| `pull:select` | `write` | false | `pull_select` |
| `pull:clear` | `write` | false | `pull_clear` |
| `pull:exportPack` | `write` | false | `pull_export_pack` |
| `pull:launch` | `process` | false | `pull_launch` |

### 2.2 mc-preview 的 action 与权限（实测，逐条）

| action | permission | projectRequired | handler |
| --- | --- | --- | --- |
| `preview:open` | `read` | false | `preview_open` |
| `preview:scene` | `read` | false | `preview_scene` |
| `preview:items` | `read` | false | `preview_items` |
| `preview:icons` | `read` | false | `preview_icons` |
| `preview:import` | `write` | false | `preview_import` |
| `preview:export` | `write` | false | `preview_export` |

★ **对规范的一处更正**：规范 §2.1/§2.2 说"manifest 对权限区分了 `read`、`write`、`process`"——
准确说法是：**权限是每个 action 的单个枚举字段 `permission`**（不是 manifest 级的三类清单，也没有 `permissions[]` 数组）。
⇒ 审查权限边界时要**逐 action 看**，不能看顶层。

⚠ **未验证**：规范称 `preview:import` 需要 `name` + `dataBase64`、`preview:export` 需要 `format` + `build`。
我本次**只逐字核了 `preview:open` 的 `inputSchema`（空对象）**，其余 5 条 schema 未逐字核。
核对方法：读 `manifest.json` 里对应 action 的 `inputSchema.required`。

---

## 3. 构建、打包、安装、调试与回滚（事实）

| 环节 | 现状 | 命令/位置 |
| --- | --- | --- |
| 构建 | 一条命令出包，带自校验 | `node pull-feature/build/build-feature.mjs` / `node preview-feature/build/build-feature.mjs` |
| 构建自检 | 有：`lint-source` R1 违规计数、包内条目数、manifest 声明式校验、handler 与 manifest 对账、逐条目哈希 | 构建输出末尾 |
| 安装 | 解包覆盖 `%APPDATA%\modmind\feature-plugins\<id>` | `pull-feature/.work/install-1.12.0.py`、`preview/.work/install-11411.py` |
| 安装校验 | **逐条目 sha256 比对**（`4/4 SAME` / `5/5 SAME`）+ 已装 `manifest.version` 必须等于包版本 | 同上 |
| 归档 | `E:\AI工作台\功能包\当前版本\`（只放最新）+ `历史版本\我方构建\`（旧包） | 同上 |
| 回滚 | 安装脚本**先把已装目录整目录备份**到 `*/\.work/installed-backup-<旧版本>/` | 同上 |
| 调试 | 假宿主 + 无头 Edge 闸门；独立页 `preview/index.html` 可直接开 | `preview-feature/.work/serve-feature.mjs` |
| 真机验收 | 由用户操作（我这边只能到假宿主/无头） | — |

**缺（规范 Task 2.1 明确要求）**：**为现有 `.mmfeature` 原件保存独立的哈希与备份** ——
现在只有"安装时对已装目录做备份"和"归档到功能包目录"，**没有一份"交付物原件 + sha256 + 时间戳"的可核对台账**。
（这正是我 2026-10-12 亲历过的风险：同一版本号被重打后，日志里的哈希就不再指向任何真实产物。）

---

## 4. 依赖与许可证清单（事实 + 待复核）

| 包 | `dependencies` | 包内第三方声明 | 许可 |
| --- | --- | --- | --- |
| mc-pull | `[]` | **无** `THIRD-PARTY` 类文件 | 包内仅自有代码；**未声明**是否含第三方（推断：无） |
| mc-preview | `[]` | `assets/THIRD-PARTY.md`（3139 字符） | 声明 **deepslate 0.27.2（MIT, Misode）** 与 **gl-matrix 3.4.4（MIT）**，附许可原文 |

`assets/THIRD-PARTY.md` 自述的三个要点（事实，摘自文件）：
① 包内**不含**承包方（ModMind 1.5.0 交接包）代码 ⇒ 不含 AGPL 文本；
② 界面**复用宿主提供的 React**（不另带副本）；
③ 修过一处旧问题：esbuild 的 `legalComments:'none'` 曾把上游署名剥掉，现已改 `'eof'` 保留法律注释。

⚠ **待复核（规范 §2.3 要求"不得仅依靠文件名推断第三方依赖清单完整"）**：
- 未核**本次 1.14.11 的 `renderer.js` 里 deepslate/gl-matrix 的实际版本字符串**是否与声明一致；
- 未核 `preview/vendor/` 与 `data/` 下是否还有未声明的第三方资产（如图标/字体）。

---

## 5. 硬编码路径、全局状态、文件写入点、子进程（事实）

### 5.1 硬编码绝对路径（`pull-feature/backend/main.js` 实测 4 处）

| 路径 | 用途 |
| --- | --- |
| `E:/mc/.minecraft` | `MC_DIR` 默认值（实例根） |
| `E:/AI工作台/mc-offline-tool/app/data` | `DATA_DIR` 默认值（旧数据落点） |
| `E:/AI工作台/mc-offline-tool/.work/dist` | `PROBE_DIRS` 默认值（探针 jar 目录） |
| `E:/AI工作台/mc-offline-tool/.work/gencmp/m2-registry.json` | `REGISTRY` 默认值（完整注册表） |

**对应环境变量（实测 11 个）**：`PREVIEW_MC`、`PREVIEW_DATA`、`PREVIEW_INSTANCE`、`PREVIEW_PROBE_JAR`、`PREVIEW_PROBE_DIR`、
`PREVIEW_PULL_REGISTRY`、`PREVIEW_REGISTRY`、`PREVIEW_CAPTURE_ROOT`、`PREVIEW_LAUNCH_DRYRUN`、`MODMIND_MC_JAVA`、`APPDATA`。

★ **裁定：规范 §0.9（"禁止把 `E:/...` 作为唯一默认路径"）——部分符合，但不是"唯一"**：
这些默认值**都能被环境变量覆盖**，所以不是"锁死"；但**默认值是开发机绝对路径**，
在用户机器上必然指错。⇒ 与规范要求的"设置、自动发现、显式覆盖"相比，**缺"自动发现"这一环**。
严重度：**中**（不崩，但默认状态下用户可能扫不到自己的实例）。

### 5.2 写入点（推断，来自源码行为 + 实测产物）

| 位置 | 写入什么 | 原子性 |
| --- | --- | --- |
| `<项目>/.modmind/mc-capture/packs/<实例名>/` | 采集数据包（items.json / icons / meta.json） | 未见原子替换（**待核**） |
| `<实例>/.modmind/probe/probe-config.json` | 探针采集配置 | 有"写不进则不算装成功"的处理 |
| `%APPDATA%\modmind\feature-plugins\<id>` | 安装功能包（脚本层，非产品代码） | 有备份 |

### 5.3 子进程

- `pull:launch`（`permission: process`）启动 `javaw` 拉起游戏实例；规范 §12 要求"参数数组、不拼 shell、启动前显示命令摘要"。
  **实测**：项目已有 `PREVIEW_LAUNCH_DRYRUN=1` 的干跑通道（闸门用它拿到命令不真启动）⇒ **符合"默认 dry-run"的方向**。
- 未见产品代码里调用反编译/外部下载工具。

---

## 6. 已存在的导入导出格式与测试覆盖（事实）

**导入**：`.nbt` / `.litematic` / `.schem`（`preview:import`，需 `name` + `dataBase64`）
**导出**：`.schem` / `.litematic`（`preview:export`，按 `format` 参数）
**材料统计**：有（`材料清单` 对话框 + CSV 下载）

**既有测试/闸门（实测清单，非规范要求的金字塔）**：

| 对象 | 工具 | 规模 | 最近结果 |
| --- | --- | --- | --- |
| mc-preview 假宿主闸门 | `preview-feature/.work/serve-feature.mjs` | **252 条断言** | 2026-10-12 全绿 |
| mc-preview 变异套件 | `preview/.work/mutate-*.py`（十余套） | 每套 2–9 个变异 | 今晚跑的 3/3 VERIFIED |
| 多宽度弹层体检 | `preview/.work/check-pop.py` | 6 个宽度 | 全过 |
| mc-pull 单元断言 | `.work/test-range.mjs` | **34 条** | 全绿（含 `1.21.10 > 1.21.9` 反字符串比较） |
| mc-pull 其它 | `test-export-pack.mjs` / `test-import-safety.mjs` / `test-probe-config.mjs` / `test-two-packages.mjs` / `test-feature-backend.mjs` | — | 未在本次重跑 |
| 探针矩阵差分 | `probe/matrix-diff.mjs`（7 合成实例） / `probe/verify-matrix.mjs` | — | 全绿 |
| 评审索引守卫 | `E:/mc/评审文档/.work/check-index.py` | 49 份文档 | PASS（差集 0） |

★ **差距（相对规范 §11.1/§11.2）**：现有测试是**本项目自建的差分/变异体系**，强在"能证伪、能变异"，但**没有**：
① 测试金字塔分层（unit/component/integration/regression/runtime/perf）；
② **版本兼容矩阵**（按版本组 × 加载器 × Mod 类别）；
③ **L0–L4 能力等级**与逐条证据；
④ 固定样本集（fixture）+ 快照回归。
⇒ 现有测试**可复用为金字塔中的"单元/集成"两层**，但不能声称已满足规范第 11 章。

---

## 7. 已有的资源解析能力及其边界（事实）

**能力（2026-10-12 实测，`probe/extract-scan.py`）**：
在用户**最难**的实例（Forge 1.16.5 + **113 个 mod** + PCL 合并版布局）上，**不启动游戏、只读 zip 中央目录**：
**0.47 秒**扫完 **114 个 jar** ⇒ 读到 **19760 张贴图 / 21292 个模型 / 6063 个方块状态 / 789 个语言文件 / 36075 个 data json / 113 个命名空间**。

**已实现的解析**：`assets/**/lang/*.json`（物品与方块显示名）、贴图条目索引、注册表侧车（方块 id）、
按需读单条贴图、**图标由贴图直接缩放**（48×48）、探针产物的导入与合并。

**边界（都是实测出来的，不是推测）**：
1. **图标**：**没有离线渲染器** —— `src/build-icons.mjs` 是"把探针在游戏内截的整页截图（4 种纯色背景）逐像素回归解 alpha"的**后处理器**，整条链路依赖"已在游戏里渲染过一次"。
2. **mod 的代码属性拿不到**：堆叠上限 / 最大耐久 / 是否方块 / 是否可损坏 / 创造页归属 —— 写在代码里，jar 的 `data/` 里没有。
   ⇒ 现状基础版把 `maxStack` 全填 **64**、`damageable` 全填 **false**（**占位值**）。
3. **模型只做"贴图直烤"**：不做 layer 叠加、不做 tint、方块物品不是 3D 外观；找不到贴图的条目**整条丢弃并计数**。
4. **探针构建覆盖（实测三态）**：`fabric/1.21` = matched、`fabric/1.21.x` = **unverified（可试装）**、`forge/1.20.1` = matched；
   **真缺口**：`forge/1.16.5`（**用户本机就有**）、`forge/1.20.4`、`neoforge/1.21.1`。

---

## 8. 现有 bug、复现步骤、严重度、建议顺序（事实，均可复现）

| # | 问题 | 复现 | 严重度 | 建议顺序 |
| --- | --- | --- | --- | --- |
| B1 | **基础版物品属性是占位值，且界面不显示 `fidelity`** ⇒ 用户看到"像真的一样的假数据"（堆叠 64 / 不可损坏） | 采集面板走默认（免探针）路径，看任意物品属性 | **高**（违反规范 §0.6「失败必须可见」与 §5.4 能力等级） | **第 1** |
| B2 | **`E:/...` 作为默认路径**（§5.1 四处的默认值） | 在非开发机上不设 env 直接跑 `pull:status` | 中 | 第 2 |
| B3 | **没有交付物原件台账**（`.mmfeature` + sha256 + 时间戳） | 见 §3 末 | 中 | 第 3 |
| B4 | `#err` 为空时仍绘制半透明底条（视口底部一条浅线） | 打开面板不报错即见 | 低 | 随后 |
| B5 | 探针真缺口（`forge/1.16.5` 等） | 面板实例卡片显示"暂无探针构建" | 高（功能缺口，非缺陷） | 见 Phase 4/5 |
| B6 | 写盘未见原子替换（§5.2 第 1 行） | **待核** | 待定 | 随 Phase 1 |

---

## 9. 未能验证的项目及原因（必写）

1. **宿主内真实运行**：我只在**假宿主**（`serve-feature.mjs`）与**独立网页**里验证过；真实宿主里的表现**由用户验收**，我没有条件自动跑。
2. **`--reports` 官方报告生成器**：**本机未跑过**（所以"1.20.5+ 原版属性可零 mod 取得"仍是文档结论，不是实测）。
3. **1.21.4 真机验证**：本机**没有 1.21.4 实例** ⇒ `~1.21` 只能停在 `unverified`，不能升格为"已验证"。
4. **`preview:import` / `preview:export` 的 inputSchema**：只核了 `preview:open`。
5. **`pull-feature` 侧的既有测试**（`test-export-pack` 等 4 个）：本次未重跑。
6. **deepslate / gl-matrix 版本与产物的对应**：只读了声明文件，未从产物里反查版本。
7. **`1.0–1.6.x` / `1.7–1.8.x` 等历史版本的样本**：**手上一份都没有**，全部 `UNVERIFIED`。

---

## 10. 破坏性操作前的备份/回滚方案

**已有**：
- 安装脚本**先整目录备份**已装版本到 `*/\.work/installed-backup-<旧版本>/`；
- 旧包归档到 `E:\AI工作台\功能包\历史版本\我方构建\`（不删）；
- 变异套件自带 restore + 还原后源码指纹比对；
- 评审文档有 `check-index.py` 守卫（防"文件在、索引没有"）。

**缺**：
- **交付物原件（`.mmfeature`）的独立备份与哈希台账**（T2.1）—— 见 §3 末；
- **产品级原子写**：`<项目>/.modmind/mc-capture/packs/<key>/` 的写入是否原子**未核**（规范 §12 要求）。

---

## 11. 审计结论与建议顺序

**一句话**：**源码工程齐全、构建链与安装链成熟、测试体系"强在能证伪"但"缺规范要求的分层与证据矩阵"；
最该先修的不是架构，而是一条"用户会被骗"的缺陷（B1）和一条"默认路径"缺陷（B2）。**

**建议的下一步顺序**（不重写、先保住现有价值）：
1. **B1**：基础版把 `fidelity` 显示出来 + 占位属性改成"未知"（成本极低，直接对上规范 §0.6/§5.4）。
2. **B2**：把四处默认路径改成"**自动发现优先、env 覆盖、配置兜底**"，而不是本机绝对路径兜底（对 §0.9）。
3. **T2**：建立**最小回归样本 + 交付物哈希台账**（规范 Task 2 第 1 条与 §11.1 的 fixture 基础）。
4. **T3**：按规范 §5.2 出**统一数据契约设计稿**（对照现有实现，标出迁移面）——**只出设计稿，不改代码**。
5. **T4**：第一条端到端垂直切片（橡木木板：发现 → 解析 → 入库 → 列表显示 → 3D 放置 → 保存重开 → 测试）。

**明确不做（本轮）**：不迁移 Rust/Tauri、不重写渲染器、不改 action 契约、不动现有已工作的用户功能。

---

## 12. 补充与更正（写完 §1–§11 之后的后续实测）

> 记法同前：**事实** ＝ 实测；**推断** ＝ 由事实推出；**未验证** ＝ 没测。
> 本节只记**新增**或**推翻前面结论**的内容，§1–§11 原文保留不动（保住"当时知道什么"的记录）。

### 12.1 §2.2 的 ⚠「其余 5 条 schema 未逐字核」⇒ **已消解（事实）**

逐字读完两包**全部 15 个 action** 的 `inputSchema`：

| 包 | action | `permission` | `inputSchema.required` | properties |
| --- | --- | --- | --- | --- |
| mc-preview | `preview:open` | read | （无） | （无） |
| mc-preview | `preview:scene` | read | `["states"]` | states |
| mc-preview | `preview:items` | read | （无） | projectPath |
| mc-preview | `preview:icons` | read | `["ids"]` | projectPath, ids |
| mc-preview | `preview:import` | write | `["name","dataBase64"]` | 同 |
| mc-preview | `preview:export` | write | `["format","build"]` | 同 |
| mc-pull | `pull:select` | write | `["key"]` | projectPath, key |
| mc-pull | `pull:clear` | write | `["key"]` | projectPath, key |
| mc-pull | 其余 7 条 | — | （无 required） | 见 manifest |

★ **结论强化**：规范 §2.1/§2.2 说的"权限区分 read/write/process"，
准确形态是**每个 action 一个 `permission` 枚举**，**没有 manifest 级 `permissions[]` 数组**
⇒ 审权限边界只能**逐 action 看**。
★ 另：`preview:scene` / `preview:icons` / `pull:select` / `pull:clear` **也有 required**（规范只提了 import/export 两条）。

### 12.2 §4 的 ⚠「未核第三方版本与产物对应」⇒ **部分消解**

- **gl-matrix 3.4.4 —— 双证据（事实）**：
  ① 源文件 `preview/vendor/gl-matrix.js` 的 `@version 3.4.4`；
  ② **产物** `renderer.js`（1.14.11）里 `'@version 3.4.4' in src` = **True**。
- **deepslate 0.27.2 —— 只能取信于声明（未验证）**：
  `preview/vendor/deepslate.umd.cjs` 与产物 `renderer.js` **都读不到版本串**（上游 UMD 构建不带 version 注释）。
  ⇒ 结论是"**声明 + 同源路径（`preview/vendor/deepslate.umd.cjs`）**"，**不得声称已从产物反查**。
- **`preview/vendor/` 无未声明资产（事实）**：恰好 2 个文件，都在 `THIRD-PARTY.md` 里。
- **`preview/data/` 与 `app/data/` 是 Minecraft 派生素材，但未入包（事实）**：
  `atlas.png`(4096×4096, 2.6 MB)、`assets.js`(2.9 MB)、`registry-*.json`、`items.json`(1.87 MB)、`icons/`、`font/`、`game/`。
  **可复算判定**：产物 `renderer.js` 里 `data:image/png;base64` 命中 **0**。
  ⇒ 判定为**边界项而非分发缺陷**（理由见 `docs/agent/DECISIONS.md` D-009），
  但已写进 `docs/agent/PROJECT_AGENT.md` §6 的"禁止入包"清单。

### 12.3 ★ 更正我自己的两处：§8 的 bug 表**已改**（B3 在本轮修完，并新增 B7）

- **B3（无交付物原件台账）⇒ 已修**：`tests/baseline/make-ledger.py`
  → **34 个 `.mmfeature` 登记 + 34 个原件备份**（备份名带 sha8 ⇒ 同号重打不会覆盖旧备份）。
  台账另做**同号不同物检测**：本轮结果 **无冲突**。
- **新增 B7（已修）：3 条既有测试长期陈旧、早已不可能跑绿**。见 §12.4。

### 12.4 ★★ 本节最要紧的一条：既有测试"烂"了 3 处，且**不是本轮改动造成的**

起因：跑基线时 `pull-feature/.work/` 下 2 个脚本报红。**没有靠推断归因** ——
写了 `tests/baseline/diff-stale-tests.mjs`，把**同两条断言**打在改动前（1.10.1）与改动后（1.11.0/1.12.0）三版上：

| 版本 | handler 数 | `__test` | 在"无加载器实例"上装探针 |
| --- | --- | --- | --- |
| 1.10.1（改动前） | 8 | 无 | **THROW** |
| 1.11.0（P0.1） | 10 | 有 | **THROW** |
| 1.12.0 | 10 | 有 | **THROW** |

三条归因（每条都有实测支撑）：

1. **装探针的红三版一致 ⇒ 不是我引入的回归**。`probeJarFor` 与那条报错在 1.10.1 里就已存在。
2. **`handler === 6` 在 1.10.1 就已假**（当时 8）。而 `run2.mode === 'merge'`
   更旧 —— 扫**全部 9 个历史包**的 `main.cjs`：字符串 `"merge"` **只出现在 1.0.0，从 1.8.0 起为 0**
   ⇒ 该断言对着 1.0.0 的契约写，**陈旧至少 8 个版本**。
3. **`pull_import_probe` 自 1.10.1 起就是 `async`**（源码 `backend/main.js:1335`
   `pull_import_probe: async (input) => {`；产物里逐字同形态）。
   旧测试用**同步** `try/catch` 接它 ⇒ 异常逃成 **unhandled rejection**（Node 22 直接判死进程）、
   `.written` 恒为 `undefined`。**产品行为本身是对的**（实测缺页时旧库分毫未动）。

**处置**：把它俩修成断言**当前契约**，并**改得更强**（不是放宽）：
`handler===6` → 「handlers 覆盖 manifest 声明的全部 action 且无非 `__` 未声明项」；
`mode==='merge'` → 「侧车契约：`ids` 数组 / `count` 一致 / `sourceMtime` 与注册表 mtime 对齐」；
并补 P0.1 三态匹配的回归覆盖（③a matched / ③b unverified / ③c null / ③d 段值比较）。
原件备份在 `tests/fixtures/backup-tests/*.orig.mjs`。

**修后实测**：`test-two-packages` **30 PASS / 0 FAIL**、`test-import-safety` **25 PASS / 0 FAIL**。

### 12.5 ★ 我写错并当场纠正的一处（留档，防复犯）

本轮第一版把 `probeJarFor('forge','1.20.4')` 断言成 `unverified` —— **被自己的实测数据证伪**：
`.work/dist/` 里 forge 探针声明的 minecraft 范围是 **`[1.20.1]`（精确区间）**，**不含 1.20.4**
⇒ 返回 null 才是对的。真正"范围命中但未构建"的例子是 **fabric 声明 `~1.21` → `1.21.4` = unverified**。
（已按实测改正断言，并把这条写进 `docs/agent/DECISIONS.md` D-007。）

### 12.6 新增事实：构建链自带完整性清单，实测全一致

manifest 自带 `files{路径: sha256}`（§2 已记）。本轮对**全部 34 个包**逐条复算：
**0 处不符**。⇒ 这是可复现的正面结论，已纳入台账与基线。

### 12.7 §9「未能验证」清单的更新

| 原项 | 现在 |
| --- | --- |
| 1 宿主内真实运行 | **仍由用户验收**（我只到假宿主 + 无头 Edge） |
| 2 `--reports` 官方报告生成器 | **仍本机未跑过** |
| 3 `1.21.4` 真机验证 | **仍 BLOCKED**（本机无 1.21.4 实例）；但 `fabric/1.21.4` 已加入**回归覆盖 ③b** |
| 4 import/export 的 `inputSchema` | ✅ **已消解**（见 12.1） |
| 5 `pull-feature` 侧 4 个既有测试未重跑 | ✅ **已全部重跑**，发现其中 2 个早已烂（见 12.4），已修 |
| 6 deepslate / gl-matrix 版本对应 | **gl-matrix 已双证据核实；deepslate 只能取信声明**（见 12.2） |
| 7 历史版本样本 | **仍一份都没有**（见 `docs/compatibility/matrix.md` §2 第 1–3 行） |

### 12.8 本机真实样本（原来只说"有实例"，现在有了准确清单）

本机**只有 2 个实例**（是全部可得样本，不是抽样）：

| 实例 | 加载器 | MC | mods | 三态 |
| --- | --- | --- | --- | --- |
| `All in One [Modded One Block]` | forge `1.16.5-36.2.34` | 1.16.5 | **113** | **无探针构建 ⇒ 真缺口 B5（用户的实例！）** |
| `Immersed With Shaders` | fabric | 1.21 | **68** | **matched**（有 `modmind-probe-fabric-1.21-1.0.0.jar`） |

⇒ 原先 §7 第 4 条列的"真缺口 `forge/1.16.5`（用户本机就有）"**确认成立**，
且现在多了个正面事实：**用户另一个实例（fabric 1.21）是 matched，探针可用**。
