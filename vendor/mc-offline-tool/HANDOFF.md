# mc-offline-tool 核心功能包 · 交接文档

> 交接日期：2026-10-15
> 交付版本：`mc-preview-1.14.12` · `mc-pull-1.14.1`
> 源码树：本交接包 `源码架构/` 目录（已剔除 `.work / dist / data / app / 截图 / 构建产物` 等冗余数据）
> 完整性清单：`manifest.json`（每个文件含 size + sha256）
> **路径约定**：本文档内的源码路径均相对于本交接包的 `源码架构/` 目录；功能包路径相对于 `功能包/当前版本/`。

---

## 0. 一句话概览

本项目是 **ModMind 的两个功能包**（`mc-preview` 3D 建筑预览/编辑、`mc-pull` 游戏数据采集）的**离线工具源码**。它不是游戏 mod，而是一套**零外部依赖**（不依赖 npm/pip 可联网安装）的 Node 工具链 + 前端渲染器，最终打包成 `.mmfeature` 交给 ModMind 宿主（客户端）加载。

接收者只需读懂三件事：
1. **两套功能包各自做什么**（§3）
2. **它们共享的 Node 核心模块怎么串起来**（§4 / §5）
3. **怎么构建、安装、验证**（§6）—— 本项目的纪律是「每个修复都带闸门 + 变异测试」，接手后务必延续。

---

## 1. 项目背景与演进

| 时间 | 事件 |
|------|------|
| 早期 | `voxel-architect`（体素建造）1.5.x，单包形态 |
| 2026-10-10 | 旧项目归档（`2026-10-10-旧项目归档/`），主线切换为 **`mc-offline-tool`** |
| 2026-10-10 | 关键修复：用 `registry-layers.json` 修掉「材质丢失」；`viewport.moveLocal()` WASD/QE 修掉「视角无法移动」；接上 Java 采集（两个 handler）；**17/17 测试通过** |
| 2026-10-13 | 交付 `mc-preview-1.14.12.mmfeature` / `mc-pull-1.14.1.mmfeature`（当前版本，见 `功能包/当前版本/`） |

**核心设计取舍**：
- `mc-preview` 消费 `mc-pull` 产出的 `items.json` + `icons/`；
- 预览侧还有一份**独立 Web 形态**（`mc-offline-tool/preview/`，经 `/api/*` 路由），与功能包共用同一批 Node 模块；
- 功能包只是把同样的 Node 模块从「HTTP 路由」改成「宿主 `action handler`」，**前端代码一行不用改**。

> ⚠️ 注意：`参考文档/v1.8-方案-全新体验改版与23项清零清单.md` 是 1.8 时代的设计方案（23 项清零清单）。**当前已交付 1.14.x，远超该方案版本号**——意味着 1.8 之后又经历了多轮迭代。该方案是「意图起点」，不是「当前事实」。接手时请以 `git log` / 安装历史 + 本交接包代码为准重新基线。

---

## 2. 当前状态

- **最新交付物**：`功能包/当前版本/mc-preview-1.14.12.mmfeature`（195,234 B）、`mc-pull-1.14.1.mmfeature`（49,995 B）
- **测试**：2026-10-10 起 17/17 通过（见 `docs/testing/`、`tests/`）
- **硬编码路径已全部治理**（B2，见 §6）：5 类路径抽成 `src/paths.mjs` 唯一入口，解析优先级 `环境变量 > 配置文件 > 自动发现 > 明确报错`，**不再写死开发机 `E:/mc/.minecraft`**
- **采集数据落点改为项目内**：`<项目>/.modmind/mc-capture/packs/<key>/`，key = 实例目录名消毒值；同游戏路径再采集直接覆盖，不同版本/整合包各自独立

### v1.8 方案 23 项清零清单状态（最新基线）

| 类别 | 项 | 状态 |
|------|-----|------|
| 缺陷 B1–B7 | Shadow DOM 键盘、teardown、原子替换图标、导入格式、越界坐标、调色板越界、采集三 bug | **13 项已关闭**（含 1 项被 U2 取代）|
| 不合理 U1–U6 | 单真相 opaque、持久化编辑、**截断标记回传(U4)**、注册表 id 侧车(U5)、文档(U6) | **U3(持久编辑) 未关闭**；其余已处理 |
| 优化 O1–O10 | 隐面剔除、O(n)→O(1)、litematic 内存、图标缓存、场景缓存、缓存上限、分页、进度、PNG 切分 | **O1–O8 在 1.8 方案中标记未做**；后续轮次（1.8→1.14）中部分已被新实现覆盖（如 scene 指纹缓存、图标 LRU），**建议接手时实测核对，不要假设全未做** |

> 接收者提示：U3（编辑持久化/自动保存）与 O 系列是**后续计划的合理起点**，但需先用 `tests/` 跑一遍、读 `git log` 确认现状，避免重复劳动。

---

## 3. 已实现功能

### 3.1 `mc-preview` — 3D 建筑预览与编辑
- **空世界起步**：起始世界为空（无石头铺底），靠 `viewport.pickPlane()` 在地面平面落格，解决「空世界放不下第一块」的死局（`preview-feature/backend/main.js:72` `starterBuild`）
- **编辑栈**（`preview/src/edits.js`）：放置/删除/撤销/重做；一组拖拽=一个撤销组；`blocksMap` 为权威源，O(1) 改格、`_syncBlocks` 仅按方块数重建 `blocks`（`edits.js:88`）
- **导入/导出**：`.nbt / .litematic / .schem(v2)` → 统一 JSON；导出 `.schem / .litematic`（`preview/api.mjs` `writeSchem`/`writeLitematic`）
- **按需场景打包**：只给当前用到的方块状态 → 现打一张刚好装得下的 2 的幂图集（`preview/scene-assets.mjs` `buildForStates`）
- **全量图集**：`buildAll()` 供构建期生成 `registry-*` 侧车

### 3.2 `mc-pull` — 游戏数据采集
- **免探针基础版**（`pull_run`）：直接读注册表侧车 + 语言文件中文名 + 贴图直烤图标（48px），项目无数据包时自动跑
- **游戏内真渲染（高保真）**（`pull_install_probe` + `pull_import_probe`）：把探针 jar 装进实例 mods/，启动游戏后探针在 4 个纯色背景下渲染整页，逐像素一元回归解出**真 alpha**（`src/build-icons.mjs`）
- **一键启动游戏**（`pull_launch`）：宿主未开放启动能力，故自己用实例版本 json 拼 java 命令行 spawn（`pull-feature/backend/main.js:1126`）
- **自动采集**：面板每 8 秒轮询，发现比当前数据包更新的产物自动导入（`pull-feature/src/feature-entry.jsx` `tick`）
- **数据包管理**：切换/清除/导出（store-zip，`pull-feature/backend/main.js:1081`）

### 3.3 共享核心模块 `src/`（零依赖）
PNG 编解码、NBT 读写、建筑文件读取、zip 读取、图标切割、路径解析、资产 id 归一化等。详见 §5。

---

## 4. 代码结构与模块依赖

```
mc-offline-tool/
├─ preview/                      # 3D 预览【独立 Web 形态】+ 被功能包复用的核心 Node 模块
│  ├─ api.mjs                    # ★ 服务端核心：/api/import|export|scene，NBT 写入，场景指纹缓存
│  ├─ main.js                    # 应用入口（结构构建、编辑栈装配）
│  ├─ scene-assets.mjs           # ★ 实例 → Deepslate 资源的按需/全量打包流水线
│  ├─ index.html / app.css / simple.* / _probesel.html
│  ├─ extract/                   # 构建资源/图集的脚本（Python + mjs）
│  ├─ vendor/                    # deepslate.umd.cjs / gl-matrix.js（第三方，React 外部化）
│  └─ src/                       # ★ 前端核心
│     ├─ main.js                 # boot() 挂载、shadow DOM
│     ├─ edits.js                # 编辑栈（放置/删除/撤销/重做）
│     ├─ viewport.js             # moveLocal(WASD/QE)、pickPlane、框选
│     ├─ resources.js            # 资源组装（半透明/开面剔除标志）
│     ├─ inventory.js            # 图标 LRU 缓存
│     ├─ statelogic.js           # 连接/附着/朝向状态推断
│     ├─ registry.js / scene.js / layer.js / viewcube.js
│     ├─ host.js                 # HTTP ↔ 宿主 invoke 切换
│     ├─ projects.js / io.js / defaults.js / block-defaults.generated.js
│
├─ preview-feature/              # mc-preview 功能包（宿主适配器）
│  ├─ backend/main.js            # 6 个 action：open/scene/items/icons/import/export
│  ├─ src/feature-entry.jsx      # 渲染入口：Shadow DOM + 注册 + 卸载清理
│  ├─ src/{css,dom-template,block-defaults}.generated.js
│  ├─ build/{build-feature.mjs,pack.cjs}  # 打 .mmfeature
│  └─ manifest.base.json
│
├─ pull-feature/                 # mc-pull 功能包（数据采集）
│  ├─ backend/main.js            # action：status/run/installProbe/importProbe/launch/select/clear/exportPack/cancel
│  ├─ src/feature-entry.jsx      # 原生 DOM 面板（不引 ReactDOM，照宿主主题令牌）
│  ├─ src/{css, pull}.generated.js
│  ├─ build/build-feature.mjs
│  └─ manifest.base.json
│
├─ src/                          # ★ 共享 Node 模块（零依赖，被上面三者 import）
│  ├─ png.mjs · nbt.mjs · schem-reader.mjs · zipread.mjs
│  ├─ build-icons.mjs            # 4 背景解真 alpha
│  ├─ paths.mjs                  # ★ B2 路径解析唯一入口
│  ├─ asset-id.mjs · blockstate.mjs · model-resolver.mjs
│  ├─ analyze-registry.mjs · build-app-assets.mjs · build-scene-data.mjs · build-tints.mjs
│  ├─ serve*.mjs · verify-*.mjs · mutate-*.mjs · test-*.mjs
│
├─ tools/                        # 构建/调试脚本
│  ├─ build-app.cmd · build-probe.ps1 · run-app.cmd · import-build.mjs
│  ├─ lint-source.mjs            # ★ 构建期硬失败（lint 不过不让构建）
│  ├─ gen-path-config.py · check-env.py · 对照工具-使用说明.md
│  └─ probe-* / measure-*        # 探针/测量相关的排查脚本
│
├─ docs/                         # agent/ audit/ compatibility/ design/ licensing/ testing/
├─ tests/                        # baseline/ compatibility/ fixtures/ integration/ unit/
└─ （已剔除）.work/ app/ app3d/ autosave/ data/ dist/ probe/ samples/ scene-data/ viewer/ viewer-native/
```

**依赖方向（单向，无环）**：
```
preview/src/*  ──► preview/api.mjs ──► src/schem-reader.mjs ──► src/nbt.mjs
                                       src/paths.mjs
preview/scene-assets.mjs ──► src/{png,nbt,zipread,paths}.mjs
preview-feature/backend/main.js ──► preview/api.mjs + preview/scene-assets.mjs + src/*
pull-feature/backend/main.js   ──► src/build-icons.mjs ──► src/{png,paths,asset-id}.mjs
                                 ──► preview/scene-assets.mjs(findInstanceDir)
```

---

## 5. 核心实现说明（关键文件 + 行号）

### 5.1 建筑文件读写 `src/schem-reader.mjs` + `src/nbt.mjs`
- `readBuildFile(buf, name)` 按扩展名分派到 `readStructure` / `readLitematic` / `readSchem`（`schem-reader.mjs:213`）
- **负坐标归一化**（B5）：`.nbt` 结构文件 pos 可能为负，统一整体平移到 0 起、size 相应放大（`schem-reader.mjs:68` `readStructure`）
- **多 region 并集**：`.litematic` 各 region 按 `Position` 平移到统一坐标系，局部调色板 remap 到全局（`readLitematic`）
- **只支持 v2**：`.schem` 仅认 `BlockData`+`Palette`（名字调色板），v1 数字 id / v3 压缩调色板**显式拒绝**（不是崩溃）（`readSchem`）
- **计数器分流**（B6）：`skippedAir`（空气）与 `skippedBadRef`（调色板下标越界=数据损坏）**分开统计**，后者非零前端显红（`emit`，`schem-reader.mjs:186`）
- **NBT 长整型位解包**（关键坑，`nbt.mjs:97` `unpackLongsSpanning`）：跨 long 边界时须先 `BigInt.asUintN(64,…)` 转无符号再做逻辑右移，且低位片段只取 `take=64-startOff` 位，否则会把越界值 OR 进来 → 方块全错。同行 `unpackLongsNonSpanning` 供对照。

### 5.2 服务端核心 `preview/api.mjs`
- `createPreviewApi({root})` 提供 `POST /api/import|export|scene`
- **导出位打包** `packLongsSpanning`：`bits = max(2, ceil(log2(n)))`，且 `bits` 必须能被 64 整除（否则 `unpackLongsSpanning` 有符号位 bug，2026-10-10 修）
- **场景缓存**：`sha1(sceneFingerprint + 排序后的 states)` 作 key，按需只重算变更方块（性能关键）
- `computeMaterials` / `safeName` / `stateString`·`parseStateString`（属性按字母序，与 MC 一致）

### 5.3 实例 → 资源打包 `preview/scene-assets.mjs`
- `createSceneAssets({instanceDir, mcDir, registryPath})`：`findInstanceDir` 在 `versions/` 下找「含 mods/ + 客户端 jar」、优先 GregTech（`scene-assets.mjs:55`）
- **命名空间补全**（实测坑）：无前缀 parent/texture 中 813 条落入 `minecraft`，**不是**自身命名空间 → 先查 `minecraft:`，再回退自身（`pickNs` `scene-assets.mjs:222`）
- **按需收模型**（2026-10-12 关键修正）：会被我们改状态的方块（连接/附着/朝向类 `classOf≠none`）与所有 multipart 方块**收全模型**，否则推断出的新 state 在资源里没模型 → Deepslate 静默跳过 →「放了看不见」（`buildForStates` `scene-assets.mjs:315`）
- **半透明标志**：权威来自 `registry-layers.json` 的 `translucent` 层；注册表没有该方块才退回 alpha 启发式（`finish` `scene-assets.mjs:434`）
- **开面剔除候选**（O1，三层判据缺一不可，宁可少剔）：① 渲染层 solid ② 满立方体几何（全不透明贴图）③ 贴图全不透明（`computeOpaque` `scene-assets.mjs:387`）
- 三个侧车：`registry-defaults.json`（默认态）、`registry-layers.json`（渲染层）、`registry-opaque.json`（开面剔除表），均可经 `import.meta.url`/环境变量/显式路径三选一加载

### 5.4 编辑栈 `preview/src/edits.js`
- `EditStack`：`_setRaw` 只动 `blocksMap`（O(1)），`commit` 一次只 `_syncBlocks` 一次（`edits.js:62`/`:105`）
- **稀疏遍历防卡死**：世界长大到 512×128×512 后，`_syncBlocks` 用 `for...in` 只走已设下标（V8 字典模式），语义仍按下标升序（`edits.js:88`）
- `chunksOf` 支持数组 `[16,1,16]` 分块（分层粒度=1 层），与视口增量重建同套分块（`edits.js:168`）
- `translate(dx,dy,dz)`：世界向负向平移长大时，整体平移历史/未来所有 change 坐标（`edits.js:138`）

### 5.5 图标真 alpha `src/build-icons.mjs`
- **原理**：同像素在 4 个背景 B 下观测 O，一元回归 `O = a + slope·B` ⇒ `alpha = 1 - slope`，C = a/alpha；4 背景真正不同则解精确（`build-icons.mjs:163`）
- **输出分辨率**：采集多少输出多少（48px = 游戏自己那一版），不降采样（压到 16px 会丢细节显毛糙）
- **两段式 + 原子替换**：先写 `icons.next-*`，校验张数后再整体 rename，中途失败旧库完好（`build-icons.mjs:94`/`:261`）
- **自检**：残差 `RESIDUAL_MAX=16`，超差清单进 report/UI 报警（`build-icons.mjs:38`）
- **属性可信度**（B1/B10）：探针 ≤1.0.0 把 `maxStack`/`damageable` 取错 API（实为耐久/是否在展示框），产物自述 `attrSemantics` 标记 `probe-mismapped`；消费端不写死「可信」（`build-icons.mjs:279`）

### 5.6 路径解析唯一入口 `src/paths.mjs`（B2）
- `resolveKey` 优先级：`env > 配置文件(%APPDATA%/modmind/mc-paths.json) > 自动发现(仅 MC 根) > source:'none'`（`paths.mjs:98`）
- `requirePath` 拿不到就抛**可操作**错误（列试过的位置 + 怎么配）；`report()` 给 UI 显示每条路径来源（`paths.mjs:147`/`:164`）
- **绝不伪造**：其余路径（注册表/探针/数据目录是工程自身产物）无从推断就报错，不编候选

### 5.7 功能包后端适配器
- **`preview-feature/backend/main.js`**：`activate()` 返回 6 个 handler，纯薄封装（复用 `preview/api.mjs`、`scene-assets.mjs`、`schem-reader.mjs`）；`dataDirOf` 读 `<project>/.modmind/mc-capture/active.txt` 决定用哪个数据包（`:35`）
- **`pull-feature/backend/main.js`**：
  - `probeJarFor(loader, mc)` 两段语义：`matched`（精确命中=构建验证过的版本）/ `unverified`（落在 jar 声明范围，未实测）/ `none`（`pull-feature/backend/main.js:311`）；范围从 **jar 内部** `fabric.mod.json`/`mods.toml` 读取（`jarDeclaredRange` `:213`），用**数值段**比较（字符串比 `'1.21.10' < '1.21.9'` 会错，`mcSegs`/`segCmp` `:91`/`:94`）
  - `writeProbeConfig` 装探针时一体写 `mode=pull`（缺配置探针会跑成「放置验证」而非采集，2026-10-11 事故）
  - `buildLaunchPlan` 拼 java 命令行（对齐 PCL `LatestLaunch.bat`），`pull_launch` 真 spawn 并脱离
  - `scanAssets` 只存 zip 条目引用 + 按需读单张贴图，避免数百 MB 常驻（`pull-feature/backend/main.js:773`）
  - `regBlockIds` 侧车优先（44MB 注册表只解析一次，带来源 mtime 失效）
  - `__test` 导出纯函数（版本比较/范围）供单元变异测试（`pull-feature/backend/main.js:1504`）

### 5.8 功能包渲染入口 `*feature/src/feature-entry.jsx`
- **IIFE**：`renderer.js` 被宿主用经典 `<script>` 注入，禁止顶层 import/export
- **最外层同步注册** `register()`（包在 `import.meta.url` 失效的 bundle 里也必须同步，否则宿主静默丢弃）
- **Shadow DOM 隔离**：每次挂载都给干净 DOM；**每次挂载都显式 `boot()`**（ES 模块只求值一次，第二次 import 命中缓存不会再执行，否则切走再切回面板空白——2026-10-10 实机根因）
- **卸载清理**：useEffect 返回函数收掉 document/window 监听与 rAF，避免叠加（按 w 走两格、双份绘制）
- **宿主适配**：`host` 对象把 `HTTP /api/*` 换成 `modmind.featurePlugins.invoke(action,...)`，前端一行不改

---

## 6. 构建 / 安装 / 验证纪律

### 6.1 `.mmfeature` 硬约束（务必遵守）
- 仅 4 个根文件：`manifest.json` / `main.cjs` / `renderer.js` / `renderer.css` + `assets/**`
- 三方 sha256；`zip 条目数 === len(files)+1`（多出的根目录项）
- `renderer.js` 是经典脚本（无顶层 import/export）；React 外部化为 `window.__modmindFeatureHost.React`
- 动作走宿主 `window.modmind.featurePlugins.invoke`；manifest `actions[].id`（带冒号）对应 handler 名（下划线）

### 6.2 路径治理（B2，已落地）
所有路径经 `src/paths.mjs`；本机路径放进 `%APPDATA%/modmind/mc-paths.json`（由 `tools/gen-path-config.py` 生成，可手改）。**禁止**在业务代码里再写 `process.env.X || 'E:/…'`。

### 6.3 每个修复的验证闭环（v1.8 §七，务必延续）
1. **闸门**：先写断言让它 FAIL → 修复 → PASS
2. **变异测试**：undo 修复 → 断言必须重新 FAIL（证明断言真在测目标，不是假绿）
3. **lint 硬失败**：`tools/lint-source.mjs` 构建期不过直接拒构建
4. **构建 + 安装**：构建出的 `.mmfeature` sha 与预期一致
5. **三条状态**：changed / tested / not-yet 清晰记录

> 历史教训（已在记忆中固化，接手者必读）：`node --check` 只查语法查不出未定义标识符；带 try/catch 回落的数据源必须断言「走了哪条路」；缓存/去重键禁止用截断串（PNG 头尾字节天然相同 → 碰撞）；判据必须做差分，不为「条数吻合」归因。

---

## 7. 后续计划（建议起点）

> 下列以 v1.8 方案为锚点，但**必须先用 `tests/` 实测 + 读 `git log` 重新确认**，因为 1.8→1.14 之间已发生多轮迭代。

1. **U3 编辑持久化/自动保存**：空世界编辑结果落盘与恢复（1.8 标记未关）
2. **O 系列性能/体验项**：隐面剔除落地、O(n)→O(1) 全面化、litematic 内存、图标/场景缓存与上限、分页、进度、PNG 尺寸切分——逐项核对是否已被后续轮次覆盖
3. **采集面覆盖度**：更多加载器/MC 版本的探针构建（当前 `unverified` 范围可试装但未经实测）；运行期染色物品（GT 材料色）仍依赖 Java 路线
4. **属性可信度**：推动探针升级到 1.1.0+（字段语义正确），消除 `probe-mismapped` 警告
5. **文档同步**：本交接包交付后，`v1.8-方案` 应被一份「1.14 现状基线」替代，避免后人误读

---

## 8. 接手指南（Quick Start）

```bash
# 1) 准备路径配置（不再写死开发机路径）
#    在 %APPDATA%/modmind/mc-paths.json 写入：
#    { "MC_ROOT": "你的/.minecraft", "DATA_DIR": "...", "REGISTRY": "...", "PROBE_DIR": "...", "PROBE_JAR": "" }

# 2) 跑前端（独立 Web 形态，便于开发）
cd 源码架构
tools/run-app.cmd            # 启动 preview/ 的本地服务（/api/*）

# 3) 构建功能包
cd preview-feature && node build/build-feature.mjs     # 产出 dist/mc-preview-*.mmfeature
cd ../pull-feature  && node build/build-feature.mjs     # 产出 dist/mc-pull-*.mmfeature

# 4) 跑测试 / 闸门
#    见 tests/unit · tests/integration · docs/testing；lint 在构建脚本内硬失败

# 5) 安装到 ModMind
#    把 dist/*.mmfeature 放到宿主的功能包目录（或本交接包 功能包/当前版本/ 已是装好的版本）
```

**接手者最该先读的三个文件**：
1. `源码架构/preview/api.mjs` —— 服务端一切的起点
2. `源码架构/src/paths.mjs` —— 所有路径的真相来源（改环境先来这）
3. `源码架构/pull-feature/backend/main.js` —— 采集全链路（最复杂、坑最多）

**已知雷区**（避免重踩）：
- 探针装了但 `probe-config.json` 的 `mode≠pull` → 跑成放置验证，面板永远等不到产物
- 视图切走再切回空白 → 漏调 `boot()`
- 方块「放了看不见」→ 状态推断出的新 state 没收全模型（`buildForStates` 的「收全」分支）
- NBT 长整型位解包的符号位 / 片段长度 bug → 方块全错

---

## 9. 交接包清单

- 根目录：`00-交接文档.md`（本文件）、`manifest.json`（完整性清单）
- `源码架构/`：mc-offline-tool 核心源码（保持原相对结构），**178 个文件 / 约 3.73 MB**
- `功能包/当前版本/`：`mc-preview-1.14.12.mmfeature`、`mc-pull-1.14.1.mmfeature`（可直接安装的交付物副本）
- `参考文档/`：仓库根 `README.md`、`v1.8-方案-全新体验改版与23项清零清单.md`

**已剔除（冗余数据/无关文件）**：`.work / dist / node_modules / data / app / app3d / autosave / probe / samples / scene-data / viewer / viewer-native` 目录，以及所有 `*.png` 截图、构建产物 `.mmfeature`（单独交付）、`*.log`、临时编辑文件。

> 每个文件的大小与 sha256 见 `manifest.json`，接收后建议先校验再开工。
