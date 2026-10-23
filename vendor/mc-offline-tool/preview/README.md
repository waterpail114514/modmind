# preview/ —— 3D 建筑预览（Deepslate × 用户实例资源 × 本地图标）

> **产品**：把「3D 预览」做成可用的独立网页工具（审核员《给开发员的 3D 预览落地方案》§一 **形态 A**）。
> **不动素体建造功能包** —— 那条线由现负责人维护。
> 一个页面装齐：**Deepslate 渲染 + 本地资源包 + 18,266 张 Java 提取图标 + 放置/删除/撤销重做 + 导入导出 + 材料清单**。

## 交付物：两个 ModMind 功能包（当前版本）

本目录是**同一套前端**的独立网页形态；同一份代码另有两个功能包形态，打包入口在相邻目录：

| 功能包 | 源码目录 | 产物 | 说明 |
| --- | --- | --- | --- |
| **`mc-preview`** 3D 建筑预览 | `../preview-feature/` | `功能包/当前版本/mc-preview-1.0.0.mmfeature`（0.14 MB） | 宿主适配层 + Shadow DOM 挂载 + 6 个 action（open/scene/items/icons/import/export） |
| **`mc-pull`** 游戏数据采集 | `../pull-feature/` | `功能包/当前版本/mc-pull-1.0.0.mmfeature`（0.01 MB） | 4 个 action（status/run/installProbe/importProbe），产物即本目录读的 `items.json` + `icons/` |

- 功能包形态下**前端代码一行不改**：`src/host.js` 把「HTTP `/api/*`」换成「宿主 `window.modmind.featurePlugins.invoke`」。
- 联测脚本：`../pull-feature/.work/test-two-packages.mjs`（**17/17 PASS**：Node 路线采集 → 预览包读；Java 路线导入 → 预览包读；按需打包互不干扰）。
- **装包前先跑 `.work/verify-host-install.mjs`**（45 项）：它照抄主程序 app.asar 里 `prepareFeaturePlugin()`/`validate()`/
  `validateContributions()`/`validateInput()` 的口径，连**渲染侧真实 payload 能否过 `action.inputSchema`** 都验。
- 交付物总览与归档说明见工作台根目录的 `../README.md`。

### ⚠ 宿主装包的硬要求（2026-10-10 踩过：报「插件动作声明无效」）

主程序 `validate()` 里这两条**不看就装不上**，而旧 `pack.cjs` 只验 ZIP 口径、会「回验全绿却装不上」：

1. **`main` / `renderer` / `style` 三者缺一 ⇒ 抛「插件入口无效」**，且 `style` 必须**恰好**是 `renderer.css`
   ⇒ `renderer.css` 必须真的打进包（`manifest.files` 里要有它）。`mc-pull` 原本没有这个文件，现已由构建脚本生成。
2. **每个 `action` 必须带 `inputSchema`**（对象且 `type: "object"`）⇒ 否则抛**「插件动作声明无效」**（就是这次的报错）。
   另外 `handler` 要匹配 `^[A-Za-z][A-Za-z0-9:._-]*$`、`permission` ∈ read/write/network/process、
   `surfaces` 只能 `workbench` / `inspiration`。

而且宿主**每次 `invoke` 都跑一遍 `validateInput`**（`ajv`，`strictSchema: true`），input 会**原样**送进校验
（不做任何补充）⇒ schema 里写了 `additionalProperties: false` 就必须保证前端不多发一个键。这两条现已在
`preview-feature/build/pack.cjs` 的 ⑦ 段做成**构建期硬失败**，`renderer.css` 由构建脚本强制产出。

## 跑起来（一条命令）

```bash
node src/serve-app.mjs --root . --port 8787 --path /preview/index.html --api ./preview/api.mjs
# 打开 http://127.0.0.1:8787/preview/index.html
```

- `--api ./preview/api.mjs` 提供三件事：`/api/import`、`/api/export`、**`/api/scene`（按需打包）**。
  **不带它页面仍能看、能编辑**，只是①导入/导出不可用 ②贴图回落到预打包的 `data/assets.js` + `data/atlas.png`（2.83 MB + 2.48 MB）。
- 按需打包默认从 `E:/mc/.minecraft/versions` 里自动找实例（优先 GregTech）；可用环境变量覆盖：`PREVIEW_INSTANCE`（实例目录）、`PREVIEW_MC`（`.minecraft` 根）。
- 依赖**零安装**：两个 UMD 已 vendor 在本目录（工具根没有 npm 工程）。

## 功能（本版实现的 / 没实现的）

| 已实现 | 说明 |
| --- | --- |
| 3D 视口 | Deepslate `StructureRenderer`；左键拖拽旋转、右键拖拽平移、滚轮缩放 |
| 网格 / 适应建筑 / 分层 | `drawGrid`；`F` 适应；`G` 网格；分层滑块只显示 y ≤ N（**层过滤开启时是整场重建**，关闭时走增量） |
| 编辑 | 放置（点方块的面 → 放相邻格）/ 删除 / **撤销重做**（`Ctrl+Z` / `Ctrl+Y`）；每次编辑只重建受影响的 chunk |
| 拾取 | `3` 或拾取模式：点方块 → 设为当前物品（吸管） |
| 物品栏 | **18,266 项**（`items.json` 的 id + **中文名** + 是否方块），搜索 / 按来源(29 命名空间) / 只看方块 / 分页(381 页) / 最近 / 收藏（localStorage） |
| 导入 | 拖拽或选文件：**`.nbt` / `.litematic` / `.schem`(v2)** 三种 → 服务端解析 → 直接换场景。`.schem v1/v3` 与 `.schematic` 是**数字 id 格式**，会**明确报错**并提示转换成 v2/litematic（不静默失败，见 B4） |
| 导出 | `.schem`（Sponge v2）/ `.litematic`（gzip NBT）→ 浏览器下载 |
| 材料清单 | 面板表格 + `CSV` 下载（中文名 + id + 数量，降序） |
| 快捷键 | `1/2/3` 切模式、`F` 适应、`G` 网格、`Ctrl+Z / Ctrl+Y` 撤销重做 |

| 还没做 | 归属 |
| --- | --- |
| 框选 / 替换材质 / 镜像旋转 / 爆炸图 / 测量跨度 | 方案 P2/P3，对标 mcblock.top |
| 分层视图的增量优化（当前层过滤=整场重建） | P4 |
| 图集**按需打包**（D070 起；全量回落 4096²/2.53 MB）、`opaque` 剔除表（仍为空，不剔面，见 D079 第九条） | 方案 P4 |
| **`.schem` v1/v3** 与 **`.schematic`**（数字 id 格式）| 既有边界：`src/schem-reader.mjs` 只支持**名字调色板**（`.nbt` / `.litematic` / `.schem v2`），其余**明确报错**并提示转换（导入入口 accept 也只列这三种） |

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html` · `app.css` | 产品壳（顶栏 / 左物品栏 / 视口 / 状态栏 / 材料清单对话框） |
| `src/main.js` | 装配：资源 → 视口 → 编辑栈 → 物品栏 → 工具栏/鼠标/键盘 → 导入导出 |
| `src/viewport.js` | 视口：相机、适应、网格、**反投影 + 体素步进拾取**、按需重绘、增量重建、高亮线框 |
| `src/edits.js` | 编辑栈：放置/删除/撤销/重做（原子批 + 只回报变更 chunk） |
| `src/inventory.js` | 物品栏面板（复用 `../app/data/items.json` + `icons/`，不复制资产） |
| `src/io.js` | 导入/导出/材料清单（走 `/api/*`） |
| `src/resources.js` | 由 `data/assets.js` + `data/atlas.png` + `data/opaque.js` 组装 Deepslate `Resources` |
| `api.mjs` | 服务端：`/api/import`（任意格式→统一 JSON）、`/api/export`（→.schem/.litematic，含自制 NBT 写入器） |
| `vendor/` | `deepslate.umd.cjs`(deepslate 0.27.2) + `gl-matrix.js`，自包含 |
| `data/` | `assets.js`(blockstates+models+UV) / `atlas.png`(8192²) / `opaque.js` / `default.nbt` + 三个示例 JSON |
| `extract/` | 提取管线（`extract.py` + `build-assets3.py`，**原样搬自 dl-demo**；`MC`/`VER`/`OUT` 三处绝对路径需按实例改） |
| `build-to-json.mjs` | CLI：任意建筑文件 → 统一 JSON（页面与示例 JSON 都用它生成） |
| `simple.html` · `simple.js` | **P0 验收用的简版页**（只渲染不编辑，保留作为对照与回归） |
| `.work/test-edits.html` · `.work/test-api.mjs` | 两套自测（见下） |

## 验收（都可复跑）

**P0 三条（方案 §三 的 P0）**
| 验收 | 结果 |
| --- | --- |
| ① `default.nbt` 正确显示 | ✔ `7×4×7 / 87 方块 / 缺失定义 0`，与预演 `dl-demo/shot.png` 同建筑同机位 |
| ② 换 `.litematic` 也显示 | ✔ `3×2×4 / 22 方块`（**22** 是 fixture README 里写明的期望值） |
| ②' 换 `.schem` 也显示 | ✔ `10×17×26 / 1989 方块`（渲出一只粉色猪） |
| ③ 一张截图对得上 | ✔ `.work/shot-preview-*.png` |

**编辑内核自测：20/20 PASS**（`node src/serve-app.mjs … ` 后打开 `/preview/.work/test-edits.html`，用无头 `--dump-dom` 读结果）
覆盖：放置 / **同格覆盖不留重复条目**（Deepslate `addBlock` 有个"双对象"陷阱）/ 撤销重做往返 / 删空格子不算编辑 /
越界拒绝 / 增量重建 chunk 正确 / **拾取：把方块中心投影到屏幕坐标再打回去，命中 (0,0,0) 且法线 [0,1,0]** / 往空白处打返回 null。

**事件接线自测：13/13 PASS**（`preview/.work/test-events.html` —— 把产品页装进 **iframe**，**派发真实** `pointerdown/pointermove/pointerup/click/keydown`，再读它自己的状态位）
覆盖：① 点物品格 → 选中 + 高亮 → ② **点画布 → 目标格真的换成花岗岩**（读回 `source.getBlock`，不是只看计数）/ ③ `Ctrl+Z` → 该格回到 `spruce_sapling` / ④ **拖拽 200px → 相机 yaw 0.600→2.029** / ⑤ 切删除模式点画布 → 方块 87→86 / ⑥ 悬停 → `#stHover` 出坐标。

**格式往返：ALL PASS**（`node preview/.work/test-api.mjs`）
`.nbt`(87) / `.litematic`(22) / `.schem`(1989) 三个样本：读进来 → 导出 `.schem` 与 `.litematic` → 再读回来，
**尺寸 / 方块数 / 调色板状态串集合 / 逐格状态** 全 0 差异；并断言导出首两字节是 gzip `1f 8b`。

**材料清单**：`default.nbt` → 泥土 54 / 草方块 27 / 云杉树苗 4 / 桦木墙告示牌 1 / 下界合金箱子 1（与 `build.json` 逐项一致）。

## 已知边界（照实写）

- **两根接线 bug 已修（2026-10-10，用户报「旋转视图/放置/破坏/方块切换全没反应」）**：
  ① `src/main.js` 在 canvas 上挂 `mousedown` 却调 `setPointerCapture(e.pointerId)` —— **鼠标事件的 `pointerId` 是 `undefined`**，
  `setPointerCapture(undefined)` 抛 `TypeError`，整个处理器中断 ⇒ 旋转与"点画布放置/删除"全死。**改为 pointer 事件，且只在 `pointerId != null` 时捕获。**
  ② `src/inventory.js` 把 `onerror` 拼进 HTML 属性，而 `${JSON.stringify(name)}` 会吐出**双引号**把属性提前截断 ⇒ 整格 HTML 是坏的。
  **改为 JS 绑定图标降级 + `#grid` 事件委托**（网格每次重建 innerHTML，委托才不会被冲掉）。
- **仍未做的验证**：真人用真鼠标在真窗口里点一遍（本机浏览器自动化对 canvas 取不到引用，只能用上面的合成事件代替）。
- `opaque.js` 的 **`opaque`（开面剔除）表是空的 → 不剔面**（面数偏多但画面正确；要省面数需先做"满立方体"几何判定，见 D079 第九条）；
  它的 **`transparent` 表已由流水线按注册表渲染层重生成**（D079 U1：718 → 165，树叶/玻璃不再误判）；
  图集**按需打包**，全量回落是 **4096² / 2.53 MB**（早先那种 8192² / 30 MB 已不存在）。
- 资源只对应 **一个实例**（GTL 1.20.1 + Forge 71 mods）；换实例要重跑 `extract/`。
- ~~`grass_block` 侧面一圈浅色半透明带~~ → **已修（2026-10-10，见下节）**：根因是图集里**根本没有** `block/grass_block_side`。
- 分层视图开启时是**整场重建**（Deepslate 不支持按块隐藏）；关掉才是增量。
- `.litematic` 的"游戏内 Litematica 互通"**未在 CI 可回归**：本目录的 `lsb-probe` 是手搓探针（其 README 说明编解码共享同一前提），
  我们按它文档写明的期望值（22 块）对齐，并用**标准位宽** `max(2, ceil(log2(n)))` 导出（与 Litematica 自算位宽一致）；真实互通仍需外部样本人工验。

## 一处顺带修掉的既有 bug（2026-10-10）

`src/nbt.mjs#unpackLongsSpanning` 的**跨 long 分支**有两个坑，已修：
① `LongArray` 读进来是**有符号** BigInt，直接 `>>` 是算术右移会把符号位带进来（须先 `BigInt.asUintN(64, …)`）；
② 低位片段只能取 `take = 64 - startOff` 位，取满 `bits` 位会与高位片段在 `take..bits-1` 重叠、OR 出越界值。
症状：`lsb-probe.litematic`（fixture README 写明"第 12 格横跨 long 边界，专门压 `hi << (64-startOffset)` 分支"、**期望 22 块**）
被解成 **21 块**。修完回到 22，且 `.litematic` 往返测试由 FAIL 转 PASS。
⇒ 这也是为什么 `preview/api.mjs` 的位宽不再"向上取到 2 的幂"（那是为规避该 bug 的临时办法，且会让游戏内读错）。

## 管线（已修）与按需打包（P4）

### 权威管线是 Node 这一份

| | |
| --- | --- |
| `scene-assets.mjs` | 正确的「实例 → Deepslate 资源」流水线（修掉了下节两个 bug；按 MC 语义解析 variants/multipart/parent/`#ref`） |
| `extract/build-atlas.mjs` | CLI：`--all` 全量重建 · `--states "a,b"` 单场景 · `--instance <目录>`（默认自动找 versions 下含 `mods/` 的实例，优先 GregTech） |
| `extract/*.py` | **预演时代的 Python 版，保持原样**（本机 `python.exe` 是 Microsoft Store 占位程序，改了也**无法验证**）⇒ 里面那两个 bug 仍在，别再拿它出产物 |

**全量重建实测**：blockstates **2,217** / models **3,604** / textures **2,482** / 图集 **4096² · 2.48 MB** / 缺贴图 **10**。
（旧管线是 models 9,075 / 图集 8192² · 29.3 MB —— 因为新版只收 blockstates **可达**的模型，不再把 jar 里所有 json 都收进来；体积小 **12 倍**，渲染一致。）

### 按需打包：图集只装当前建筑用到的贴图

```
POST /api/scene { states:["minecraft:grass_block[snowy=false]", …] }
  → { key, atlas:"/preview/.work/scene-cache/<key>.png", assets:"…/<key>.json", stats }
```
- 服务端只解析这批状态的 blockstates → models → textures，用 guillotine BSSF 装进**恰好装得下的 2 的幂方形**；
- 产物按**内容哈希**缓存（键带 `v2|` 版本盐），同场景不重算；
- 前端 `src/scene.js` + `main.js`：**优先按需**；服务端不可用或读不到实例时**自动回落**预打包图集（此时才懒加载 2.8 MB 的 `data/assets.js`，`index.html` 里那个 script 标签已去掉）；切换建筑时 `viewport.setResources()` 热换图集（视口对象不变 ⇒ canvas 事件不用重绑）。

**实测（`default.nbt` 的 5 种状态）**：**9 个模型 / 5 张贴图 / 图集 256² / PNG 2,394 B** ⇒ 比全量图集**小约 1000 倍**；页面状态栏显示「按需图集 256²」、`__PREVIEW_READY__.onDemand === true`、画面与预打包路径一致。

## 19:00 实机事故复盘与修复（2026-10-10，D081）

**事故**：用户 19:00 装机（V3），20 秒内踩到 228 条错误；坏掉的是「适应建筑 / 网格 / 撤销 / 重做 / 分层」5 个控件。
**根因**：[main.js](file:///E:/AI%E5%B7%A5%E4%BD%9C%E5%8F%B0/mc-offline-tool/preview/src/main.js) 的 `bindToolbar()` 里有
`const vp = () => state.vp`（惰性访问器），而下面 **8 处仍按"对象"写** `vp.fit()` / `vp.setGrid()` / `vp.grid` /
`vp.updateBuffers()` / `vp.setStructure()` ⇒ 箭头函数上没有这些方法，**每次点击抛 TypeError**。
最坑的是撤销：**数据回退了、画面不刷新**，用户看到的是"撤销没生效"（状态不一致）。

**修法（不只是补括号，是把这一类问题堵死）**：
1. 删掉惰性访问器，`bindToolbar` 内**统一用 `state.vp.<方法>()`**（全文件只有一种写法；`bindViewportInput` 保留
   `const vp = state.vp` 这种"对象快照"，它指向的就是真对象，不是函数）。
2. 顺带修掉 `gridBtn.textContent = vp.grid ? '网格 G' : '网格 G'`（三元两支写同一串，等于没表达状态）——
   现在文字反映开/关 + `aria-pressed`。
3. **新增构建期机械自检** [tools/lint-source.mjs](file:///E:/AI%E5%B7%A5%E4%BD%9C%E5%8F%B0/mc-offline-tool/tools/lint-source.mjs)
   （R1：禁止 `const X = () => <裸标识符/成员链>`），**两个构建脚本都会先跑它，违反即构建失败**
   —— 审核员原话「一条 grep 就该暴露」，现在连 grep 都不用。
4. **假宿主闸门补上"用户路径点检 + 可见层断言"**（审核员 §5-A/§5-B）：
   原来 26 条断言**全部只读数据层与相机状态**，恰好绕开坏掉的 5 个控件（所以"26/26 全绿却一用就废"）。
   现在新增 ⑦g–⑦n：放置（选格子→点画布，方块数 1024→1025）· 适应建筑（**先拉远到 2000 再点，距离必须变小**）·
   网格（状态翻转 + 文字跟着变）· 撤销/重做（**画面重建被调用**的**增量**，不是绝对计数）· 分层滑块（结构重算）·
   材料清单（能开且有内容）· 全程 **0 条未捕获异常**（原来只打印不计数）。
   闸门 **30/30 × 浅色/深色**；**变异**（把事故形态改回去）→ 4 条红（⑦h/⑦j/⑦k/⑦m），lint 也红。

> 纪律（来自审核员 §3/§5）：**凡用户要"看见结果"的交互，断言必须落在可见层**；每个按钮/快捷键都要有
> "点了不抛错且状态可观测"的用例；断言写完必须变异。另外：假宿主的模板字面量里**不能出现反引号**
> （注释里也不行，会被提前闭合 —— 我踩了两次），现在 `run-gate.ps1` 会先 `node --check` 再起服务。

## ★ 「切走再切回来 ⇒ 面板空白 / 功能 UI 缺失」的根因（2026-10-10，D084）

**症状**（用户实机）：工具栏在，但**物品栏空、状态栏全是 `—`、视口全白**；同时**没有任何报错**。

**根因**：[main.js](file:///E:/AI工作台/mc-offline-tool/preview/src/main.js) 末尾直接写了一句 `boot()`，
而 [feature-entry.jsx](file:///E:/AI工作台/mc-offline-tool/preview-feature/src/feature-entry.jsx) 在 `import('./main.js')` 之后
只判断 `disposed`。宿主把面板**切到别的模块再切回来**时，entry 会新建一个 `div.mcp-host` 并挂一棵**全新**的 shadow 树，
然后再 `import()` —— 但 **ES 模块只求值一次**：第二次 import 命中缓存、**模块体不再执行**
⇒ 那句自动 `boot()` **永远不会再被调用**，新树里只剩静态 HTML（空壳）。

**为什么之前的闸门全绿**：假宿主 `__renderInto()` **只在注册时挂载一次**，从来没有"切回来"这条路径。

**修法**：
1. `boot()` 改为 **export**；模块末尾 `if (!isFeature()) boot()`（独立网页照旧自动跑）。
2. entry 每次挂载 `import()` 后**显式 `m.boot?.()`**；`attachShadow` 幂等；每次挂载重建 `.mcp-wrap`。
3. 模块级 `const busy = $('busy')` 改成**每次现查**（同一个病根：新树里的节点才有效）。
4. boot 加**阶段面包屑** `window.__PREVIEW_BOOT__`，失败时 `#err` 写 `ERROR[阶段]：…`
   —— 以后"空白面板"能一眼分清"还在加载"还是"已经失败"。

**闸门 + 变异**：假宿主新增 `__remount`，⑧ 段「卸载 → 重新挂载」断言 boot 重新跑完 + 工具栏重初始化 +
物品栏有格子 + 状态栏有数字 ⇒ **35/35 × 浅/深**；**变异**（退回事故形态）→ **31/35**，红的 ⑧a/⑧b/⑧c 实测
分别是 `网格 G` / `格 0` / `方块 —`，**与用户截图逐字一致**。

> ⚠ 宿主对**已加载**的 `renderer.js` 不会热替换 ⇒ 换包后要**完全退出并重开 ModMind** 再切面板。

## 采集功能：成功了还是失败了（2026-10-10，D084）

| 路线 | 结论 | 证据 |
| --- | --- | --- |
| 「开始采集（Node）」 | **成功** | `app/data/items.json` 20:26:04 写入：`count=18,284 / ids=18,284 / icons=18,284`（一一对应），`source="mc-pull (node) …GregTech Leisure"`，icons/ 18,284 张 |
| 「导入游戏内数据（Java）」 | **失败** | 宿主日志原文：`没找到游戏内探针产物：E:\mc\.minecraft\versions\GregTech Leisure\.modmind\probe\pull2（先「装探针」并启动一次游戏；或传 probeDir）`；实例的 `.modmind` 目录**不存在** ⇒ **探针装过，但游戏从没带探针启动过** |

正确顺序：**装探针 → 用 ModMind 启动一次该实例 → 再点「导入游戏内数据（Java）」**。
顺带修：实例 `mods/` 里同时有 `modmind-probe…-0.2.0.jar` 与 `…-1.0.0.jar`（同 mod 多版本会被 Forge 拒绝加载）
⇒ `pull_install_probe` 现在**装新版时先清掉同 mod 的其它版本**并回报删了哪些。

## 一次成批落地：空世界 / 采集只留 Java / 数据存进项目（2026-10-10，D085）

按用户一次提出的 7 项要求：

| # | 要求 | 做法 |
| --- | --- | --- |
| 1 | **3D 直接空世界，不要石头铺底** | `starterBuild()` 改回 32×16×32 / **0 方块**（当年铺地面是为了绕开"空世界放不下第一块"，现在改用下面的硬约束） |
| 2 | **硬约束：底部能放方块** | 新增 [viewport.pickPlane()](file:///E:/AI工作台/mc-offline-tool/preview/src/viewport.js#L207-L229)：体素拾取没命中且处于放置模式时，退化为"与底部平面求交 → 放 y=0"，**悬停就显示落点框** |
| 3 | 放置"放了看不见" | 放置后**自检** `resources.getBlockDefinition(id)`：为空就把原因写进状态栏（Deepslate 对无定义的方块是**静默跳过**的）；并新增**像素级闸门**（`gl.readPixels` 数被画像素，实测放置后 6850→7044） |
| 4 | **采集只要一条 Java 路线** | 界面移除「开始采集（Node）」与"合并/重建"选择；`pull_run` 降级为内部兜底，界面无入口 |
| 5 | **数据存到 ModMind 项目里** | `<projectPath>/.modmind/mc-capture/packs/<key>/`（走宿主自己的 `toolDataDirectory: ".modmind"` 约定）+ `active.txt` |
| 6 | **多个数据包可选，同路径覆盖、不同版本/整合包分离** | `key = 实例目录名`；面板列出所有包、"当前使用"徽标 + 下拉切换 + **二次确认**清除（`pull:select` / `pull:clear`） |
| 7 | **采集面板按 UI skill 重做** | [pull.css](file:///E:/AI工作台/mc-offline-tool/pull-feature/src/pull.css)：Shadow DOM + `--mm-*` 优先取宿主 `--theme-*`、4pt 间距、圆角 3 档、7 态（含 loading/error）、`focus-visible`、`prefers-reduced-motion`、768px 断点；面板用原生 DOM 搭 |

**预览包读"当前数据包"**：后端 [dataDirOf(projectPath)](file:///E:/AI工作台/mc-offline-tool/preview-feature/backend/main.js#L23-L43) 三级优先（`PREVIEW_DATA` → `<project>/.modmind/mc-capture/` 的 active 包 → 旧 `app/data` 兜底），
`preview:items`/`preview:icons` 带上 `projectPath`（schema 同步补字段），物品表缓存按数据目录分键。

**闸门**：新增**采集面板假宿主闸门**（`run-gate.ps1 -Pkg pull`）**15/15 × 浅/深**；预览闸门 **36/36 × 浅/深**；
导入安全 18 → **23**（项目内路径 / meta+active / 列表 / 清除）；两包联动 26/26、宿主口径 45/45、`test-api` ALL PASS、lint 0。
交付 → preview **142,864 B** / pull **21,810 B**。

> ⚠ Java 路线要 **装探针 → 启动一次该实例** 才会产出游戏内数据（诊断包里实例的 `.modmind` 目录不存在 ⇒ 从没带探针启动过）。
> **面板会自动搜索**（D086）：不再只认当前实例那一个路径，而是扫 `<MC>/versions/*` 找游戏内产物，并列出"哪些实例装了探针 / 有没有产物"。

## 按审核员《代码级缺陷与优化清单》收尾 B4/B5/B6（2026-10-10，D082）

针对的是"看着正常、结果少了/错了"这一类**诚实性缺陷**（每条都配闸门 + 变异）：

| 条目 | 原来 | 现在 |
| --- | --- | --- |
| **B4** 导入格式口径 | `index.html` 的 accept 列了 `.schematic`，而 reader 对它是**抛错**的（"UI 说支持、点了就报错"） | accept 只列真支持的三种（`.nbt`/`.litematic`/`.schem`）；非名字调色板的（`.schem v1/v3`、`.schematic`）**明确报错并提示转换**；v1 分支原来"先算一遍 data 再 throw"的死代码删掉。闸门：`test-api.mjs` 解析 accept，断言"每个扩展名都真能导"。变异：把 `.schematic` 加回 accept ⇒ 红 |
| **B5** 越界/负坐标 | `.nbt` 负数 pos 的方块被下游 `catch` **静默丢弃**，不计数、不提示 | `readStructure` 把负坐标**整体平移**归零并放大声明尺寸；`structureFrom` 新增 `skippedOutOfBounds` 计数并在消息里明说（非零**显红**）。闸门：构造含负坐标的 root，断言"一个不丢 + 全非负 + 落在尺寸内"。变异：去掉平移 ⇒ 红 |
| **B6** 调色板越界 ≠ 空气 | `emit()` 把"调色板下标越界（=数据损坏）"算进 `skippedAir` ⇒ **误导排查方向** | 独立 `skippedBadRef` 计数，`badRef` 非零时消息显红（提示"数据损坏"）。闸门：坏引用 → `skippedBadRef=1` 且 `skippedAir=0`。变异：改回算进空气 ⇒ 红 |
| **U4** 静默截断 | `preview_scene` 的 states(2 万)/missing(20)、`preview_icons` 的 ids(200) 截断**无声** | 三处都回传 `truncated`，宿主适配层**透传**（上一版就是在适配层重建对象时把新字段丢了），前端 `truncNote()` 有截断就显黄条。闸门：请求 201 个 id ⇒ `truncated.icons === 1` |
| **P3-3** 打包无自证 | 包外没有"这一版是什么" | `pack.cjs` 末尾写 `dist/build-info.json`（包名/字节/sha256/解压字节/逐文件 sha256/时间）⇒ 对版不用猜 mtime |

> 顺带修了**闸门自身的一处假失败**：假宿主 ⑦g「放置」突然 27/30 FAIL，诊断显示 `msg=正在按需补「空果伞盖」的模型与贴图…`
> ⇒ 放置要**先 `await growScene()`**（按需补模型/贴图）再落地，而闸门派发完 pointerup 就立刻读 `#stBlocks`，**读到旧值**。
> 修法：`__selftest` 改 async 并**轮询等结果落地**再断言 —— 这不是产品回归，是"断言必须等到结果真的出现"。
>
> 仍未做（审核清单剩下）：U3（编辑无自动保存）、P1-4（包不自包含）、P2-2（d076 无实体日志）、
> O1（开面剔除）、O8（长任务无进度）、O2–O7（编辑 O(n)、资源/图标缓存）。
> （U5/O9/P2-3、P3-1、P3-2 已在下一节 D083 补上。）

## 采集包（mc-pull）侧的审核条目收尾（2026-10-10，D083）

D082 改的是**预览侧行为**，采集包那次只是被重建（顺带拿到 `build-info.json`）—— 本轮补上采集包自己的四条：

| 条目 | 原来 | 现在 |
| --- | --- | --- |
| **U5/O9/P2-3** | `pull_run` 每次 `JSON.parse` **44 MB** 注册表，只为拿一份 id 清单（+0.55 s / +207 MB） | `regBlockIds()` **侧车优先**：`<注册表同目录>/registry-ids.json`（**292 KB**，含来源 mtime 失效）；没有/过期才全量 parse 并顺手写。实测第二次运行日志「侧车命中」，两次 `candidates` 都是 14,561（**不改变结果**） |
| **P3-2** | 切图残差**只打印** worst=34.09，没有判据、没有超差清单 | `RESIDUAL_MAX = 16` + `residual.{threshold,ok,overCount,over[]}` 进 report，后端 note 与采集 UI **报警**。实测 `ok=false`、**7 个图标超差**（真问题，我没把阈值调绿） |
| **P3-1/O10** | `encodeRGBA` 的「filter 0/2 择优」判据是**绝对值和**，不是 deflate 体积 ⇒ 48×48 图标反而更大 | **按尺寸分流**：`max(宽,高) < 128` 不做择优（filter 0），大图（图集）才择优。实测 200 张真实图标：filter 0 合计 **149,338 B** vs 择优 **224,039 B**（择优大 **50%**）；大图仍择优（565 vs 880） |
| **U2** | 两条采集路线写同一目录、后果不同，界面不区分 | 按钮改为「导入游戏内数据（Java）**· 重建**」/「开始采集（Node）**· 合并**」，说明写清差别；`pull_status` 新增 `derived`（`imported-*`/`baked-*`）与 `registryIdsSidecar`，状态表各一行 |

> 闸门：新增 `pull-feature/.work/test-icon-encoder.mjs`（5/5）；两包联动 **23 → 26**（+④d/⑦e/⑦f）。
> 变异 3 组（`pickBest` 永远 true / 去掉残差判据 / `regBlockIds` 回退全量 parse）⇒ **6 条红**。

## 按 ModMind 的 UI skill 重设计（2026-10-10，D080）

依据 = 交接包里的 `ui-design-studio` skill（`ui界面/SKILL.md` + `design-system.md`）。核心是**令牌单一来源**：
`--mm-*` 一律**优先取宿主主题令牌** `--theme-*`（与承包方两条功能包同一层别名），而 CSS 自定义属性**会穿过 Shadow DOM 继承**
⇒ 面板自动跟随宿主的浅色/深色主题，不再出现"宿主浅色、面板深色"的割裂。**之前是硬编码的一整套深色板**，这是本轮改动的根。

| skill 要求 | 落地 |
| --- | --- |
| 颜色：令牌单一来源、不硬编码 | 颜色只出现在令牌块；控件边界由正文色派生（`color-mix`），两种主题下都可辨识 |
| 间距 4pt、禁止非倍数 | 全量换成 `--sp-1..8`（4/8/12/16/24/32） |
| 圆角同页 ≤3 档 | 控件 8 / 卡片 12 / 胶囊 full |
| 字号阶梯 12/14/16/20 + 行高 | `--fs-xs..lg`；正文 1.5、标题 1.2–1.3 |
| 组件 7 态（含 loading / error） | `.btn` 有 default/hover/focus-visible/active/disabled/aria-busy；`.cell` 有 hover/active/选中；`#busy` = loading 遮罩 + 指示器；`#err` = error（左侧红条，不只靠颜色） |
| `focus-visible` 必须可见、禁止裸删 outline | 全局 `:focus-visible{outline:2px solid var(--mm-accent)}`，没有任何地方删 outline |
| 动效 120/200/320ms + `prefers-reduced-motion` | `--t-fast/base/slow`；降级媒体查询里去掉位移动画 |
| z-index 阶梯 | 对话框 `--z-modal:2000`；装饰线不进层级 |
| 断点 768 / 1280 | ≤1280 收窄物品栏 · ≤960 舍副标题 · ≤768 改上下布局 |
| **对比度必须实测** | 新增 `preview/.work/check-contrast.mjs`（按 WCAG 2.1 定义用 Node 实现 —— 本机**没有 Python**，跑不了 skill 附带的 `check_contrast.py`）：**16 组全部达 AA**（正文最低 4.51:1、控件边界 4.47:1） |

**视口底色也跟随主题**：`viewport.setBackdrop()` + `main.js#syncBackdrop()` 读 `#stageWrap` 的**计算后**背景色喂给
`gl.clearColor`，并监听 `prefers-color-scheme` 与 `<html>/<body>` 的属性变化 ⇒ 宿主换主题时画布一起变（之前写死深色）。

**顺带修掉两个真问题**（都是这轮动样式时暴露、被闸门或肉眼抓到的）：

1. **`height:100vh` 的替换漏了带空格的写法** ⇒ 功能包里 `#app` 按**整窗**高度撑开，直接溢出宿主给的那块容器
   （实测 838 vs 472px）。修法：构建脚本正则改成 `height:\s*100vh`；并给假宿主加常驻断言「#app 高 ≈ #slot 高」。
2. **物品栏图标整片不出来**：`app/data/items.json` 又被采集包的 **Node 路线**覆盖成 23,803 条，其中 **5,519 条没有图标文件**
   ⇒ 清单与 `icons/` 不一致（23,803 vs 18,284），格子全是空白。已恢复探针产物（18,266 ↔ 18,266 一一对应），
   并把「**清单里每条都必须有图标**」做成采集包的硬不变量（Node 路线只落盘有图标的条目 + 明确回报丢弃数）；
   两处断言守住它（两包联动 ②d/⑦d + 假宿主的「图标上屏 48/48」）。
   另：`PREVIEW_REGISTRY` 一个变量两种含义（预览包要 `{id:props}` 侧车、采集包要 `{blocks:[…]}` 注册表）
   ⇒ 采集包会**静默拿到 0 个方块**（候选 14,561→5,187）。已给采集包专用变量 `PREVIEW_PULL_REGISTRY`，并兼容两种形状。

**验收**：假宿主浏览器闸门 **20/20 ×（浅色 / 深色）**（含"填满容器""主题令牌穿 Shadow 继承""图标上屏"）、
预览包后端 13/13、两包联动 + B7 **23/23**、导入安全 18/18、宿主口径 45/45、独立网页 `test-api` ALL PASS、
对比度 16 组全过、独立网页图标 48/48 解码。

## 按审核员报告逐条修复（2026-10-10，D079）

审核员出了两份独立复核（`E:\mc\评审文档\v1.7\v1.7-审核-代码级缺陷与优化清单.md`、
`…-审核-mc-preview与mc-pull两包交付审核.md`）。下面每条**都带闸门、且做了变异**（变异 = 把修复改回去，闸门必须重新红）。

| 条目 | 问题 | 修法 | 闸门 / 变异 |
| --- | --- | --- | --- |
| **B1** | Shadow DOM 下 `document` 上的 keydown 看到的是**被重定向的宿主元素** ⇒ **在搜索框打字会移动相机并吞掉字符**（打 1/2/3 还会切模式） | 取 `e.composedPath()[0]` 当真实目标 | 假宿主浏览器闸门：先 **9/12 FAIL** → 修后 **12/12** → 变异回 **9/12** |
| **B3** | `buildIcons` 先 `rmSync(icons)` 再逐张写 ⇒ 中途失败/缺页就用**半截库顶掉旧库**（P0） | 两段式：写 `icons.next-*` → 预检页图齐全 → 校验张数 → 备份旧库 → 换名就位 → 删备份；**部分导入不许覆盖主数据目录**（自动写 `imported-partial-*`） | `test-import-safety.mjs` **18/18**；变异（把 rmSync 加回）→ 旧库被清空 `icons/=-1` FAIL |
| **B2** | 全项目**零 `removeEventListener`**、`stopLoop` 定义了没人调 ⇒ 切走再回来监听器与 rAF 叠加 | `main.js` 加 `on()`/`TEARDOWN` + 导出 `shutdown()`；`viewport.dispose()`、`inventory.dispose()`；入口 `useEffect` 返回 cleanup | 浏览器闸门：无清理时 `13→13` 且 `running=true`；修后 **13→2** 且 `running=false` |
| **P1-1/P1-2** | 两个**假绿灯**：②a 的输入里没有 ice/leaves（空数组也 PASS）、⑥b 只打印不断言 ⇒ 材质修复**无回归保护** | 换输入 + 断言**精确集合** | 变异：临时挪走 `registry-layers.json`（退回 α 启发式）⇒ 两条断言立刻 FAIL |
| **U1** | 回落路径用的 `data/opaque.js` 里 transparent 是**旧 α 启发式**（含 oak_leaves/glass），与按需路径不一致 | 用修好的流水线重生成（流水线读 registry-layers） | `transparent` **718 → 165**；`test-api.mjs` 里的不变量断言 ALL PASS |
| **B7** | ①探针 jar 按**字典序**取最大（`1.10.0` 会输给 `1.9.0`）②客户端 jar 无序取首个 ③`pull_run` 统计不闭合（缺 1068 条类别） | 数值比版本 / 优先「<目录名>.jar」/ 补 `skippedByCap` | 两包联动 ⑦ 段；实测闭合 `60+840+13651+10 = 14561` |
| **P1-3** | 包里放的是**承包方的 AGPL-3.0 全文**（与本包无关），而 deepslate/gl-matrix 的 **MIT 署名被剥掉** | `legalComments:'eof'` + 新增 `assets/THIRD-PARTY.md`（deepslate 原文取自上游仓库）+ 撤掉 AGPL | 包内条目与署名已核对（见下） |
| **P2-1** | 我上一轮归档把两个**目录联接**搬进归档，目标已不存在 ⇒ "看着有、打不开" | 删除（内容本就在归档内） | 归档顶层已无死链 |

**O1（开面剔除）本轮未做**：`opaque` 表要安全就不能只看"渲染层 solid + 贴图全不透明"——
**石台阶这类 solid 层但非满立方体的方块**标 opaque 会把邻居的面剔出洞。得先做"满立方体"几何判定 + 视觉回归，宁可少剔也不剔错。

## 功能包里的 UI 修复（2026-10-10）

功能包装上后界面是坏的（面板只占半截、物品栏空白、视口发白带一行红字）。**独立网页那条路测不出来** ——
这些缺陷只在功能包形态才暴露（包内**没有静态文件**、Shadow DOM、经典 script 注入、宿主 action 取数据）。逐条：

| # | 症状 | 真根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 整页不初始化（`#err` 一行红字） | `main.js` 直接引用 `HOST`，而那是 `host.js` 的**私有**变量 ⇒ `isFeature()` 为真时抛 `ReferenceError` | `host.js` 导出 `hostInitialBuild()` 收口（独立网页靠短路求值永远走不到那句） |
| 2 | 面板只占宿主容器上半截（402 / 790px） | Shadow 里那层包裹 div **没有高度** ⇒ `#app` 的 `height:100%` 落空 | `build-feature.mjs` 给 `.mcp-wrap` 生成确定高度 |
| 3 | 空世界里放不下第一块 | 放置是"点已有方块的面 → 放到相邻格"，空世界点哪儿都「没点到方块」 | `preview_open` 改为给**一层石头地面**的起始世界（32×16×32 / 1024 块） |
| 4 | 物品栏空白、来源页签也没有 | `inventory.js` 无条件 fetch 包内**不存在**的 `app/data/items.json` | `host.js` 导出 `hostItems()`，功能包走 `preview:items` |
| 5 | boot 中途中断 | `registry.js` 无条件 fetch 包内不存在的侧车 | 功能包直接返回 `{}`（默认态由 scene 回传） |
| 6 | 「取不到 data/assets.js」 | 按需失败时回落到预打包，而包里没有该静态文件 | 功能包改用后端给的 `emptyScene()`（POT 透明图集 + 空表） |
| 7 | 「示例建筑」下拉一点就报错 | 它取包内 `data/*.json` | 功能包模式隐藏它 |
| 8 | 46 条图标 404 | 图标先给了包内不存在的 `src` | 功能包模式先不给 `src`（文字兜底），等后端 data URL |

**怎么验的**：新写「假宿主」`preview-feature/.work/serve-feature.mjs`（经典 script 注入 `renderer.js` +
极简 React + 把 `modmind.featurePlugins.invoke` 接到真实 `dist/main.cjs` 的 handler），浏览器逐轮截图。
实测：包内**干净标签页 0 报错**、48/48 图标是 data URI、选方块 → 点视口 **1024 → 1025**（按需补资源也正常）；
独立网页（`serve-app`）**无回归**（87 块 / 0 报错）。

> ⚠ 另外发现一处**数据**问题：`app/data/items.json` 被改成 23803 条（采集包的 **Node 路线**默认写进同一个
> 数据目录），其中 5519 条没有图标。已按探针产物重建回 **18266 条 / 18266 图标**；采集包 UI 已加醒目告知，
> 并让 Node 路线**保留旧名字**（不再退化成裸 id），「导入游戏内数据（Java）」改为主按钮。

## 材质按渲染层判 · 视图键盘移动 · Java 采集适配（2026-10-10）

### 1. 方块材质「丢失」＝ 半透明判据用错（本轮真根因）

上一轮起用「贴图含 alpha」判半透明。问题是**树叶 / 玻璃的贴图确实含 alpha，但它们不该走混合通道** ⇒
被丢进 transparentMesh ⇒ 发灰、看着像贴图没了。

**权威依据是注册表的渲染层**（MC 的 material 由资源包的模型给出，不由贴图 alpha 决定）。
新增侧车 **`data/registry-layers.json`**（248 KB，**5,855 个方块**：solid 975 / cutout 491 / translucent 4,103 / cutout_mipped 286），
判定规则：任一 quad 是 translucent ⇒ translucent；否则有 cutout / cutout_mipped ⇒ cutout；否则 solid。

`scene-assets.mjs` 改为：**有侧车就用侧车，只有 `translucent` 走半透明**；侧车不可用才退回 alpha 启发式。

**验证（走功能包后端）**：`scene:["minecraft:stone","minecraft:oak_leaves","minecraft:ice"]` ⇒
`transparent: ["minecraft:ice"]`（`oak_leaves` / `glass` **不再**被判半透明）。日志出现 `渲染层：5855 个方块`。

### 2. 视图移动 —— 补键盘 + 操作提示

`viewport.js` 新增 `moveLocal(fwd, strafe, vert)`：按相机 **right / up / forward** 三轴位移，
forward 的符号由 `dist` 决定（相机在目标外侧时前进=靠近）；`main.js` 绑 **W A S D**（前后左右）与 **Q E**（升降），
按住 **Shift ×4**；视口左上角常驻**操作提示**（左键转 / 右键·中键平移 / 滚轮缩放 / WASD·QE / 1·2·3 模式 / F·G / Ctrl+Z·Y）。

### 3. 接上 Java 采集（`pull-feature`，新增两个 handler）

游戏内探针 `Pull.java` 能做 Node 侧做不到的事：**游戏内显示名**（跟随 mod 本地化）、
**真渲染出来的 48px 图标**（含 3D 模型与运行期染色）、**真 alpha**。

- `pull:installProbe` —— 把探针 jar 装进实例 `mods/`（在候选目录里按文件名排序取最大版本，不再硬编码文件名）
- `pull:importProbe` —— 读 `<实例>/.modmind/probe/pull2/`（`index.json` + `page-NNN-bgN-*.png` + `items-meta.json`），
  对同一像素在 **4 个纯色背景**下的观测做一元回归 `O = a + slope·B` ⇒ `alpha = 1 - slope`、`C = a / alpha`，
  切出 48px 图标 + `items.json`（实现与 `src/build-icons.mjs` **同一份**）

**实测**（`.work/probe-01` 的产物，取前 2 页）：**1,330 条 / 48px / 3 像素每纹素 / 5.8 s / 36 张含真半透明像素**
（例 `yellow_stained_glass_pane`）；名字为游戏内真值（`minecraft:stone=石头`）。

**★ 顺带纠正一个旧结论**：本机**有 JDK 17**（`%APPDATA%\.minecraft\runtime\java-runtime-beta\bin`，javac 17.0.15），
只是不在 PATH。已实跑 `tools/build-probe.ps1` 编译出 `modmind-probe-forge-1.20.1-1.0.0.jar`。

### 4. 两个功能包一起测试：**17/17 PASS**

`../pull-feature/.work/test-two-packages.mjs` 覆盖：①采集包 4 个 handler ②Node 路线采集（14,561 条 / 72 jar / 9,611 贴图）
③装探针（用临时实例目录，**不动你的真实例**）④Java 路线导入 ⑤**预览包读 Java 路线产物** ⑥**预览包读 Node 路线产物** + 按需打包不受影响。

⚠ 边界：①功能包**在 ModMind 里真正挂载出来**仍未验；②探针要**启动一次游戏**才产出 `pull2`；
③联测只导了 2 页（`maxPages` 控耗时），全量 28 页未跑；④Node 路线图标是**烤贴图**，运行期染色（GT 材料色）不保真。

## 工具级修复（2026-10-10 · 第五轮）

用户录屏报四处，全部追到根上：

### 1. 「放置会替换原来的方块」＝ 两层

**第一层（表层）**：拾取 DDA 的**首格法线是 `[0,0,0]`**（原来只在"走一步之后"才记法线）⇒ 放置目标 = 命中格本身 ⇒ 覆盖。
修法：求 AABB 交点时记下**从哪个轴进入**，用它作为初始法线。

**第二层（要害）**：改对法线后，目标跑到边界外（7×4×7 顶层之上 = y=4）⇒ 被拒。说明**固定尺寸盒子本身就不对** —— 建造世界应当能**往外长**。
修法：`ensureBounds()` —— 出界就按 **8 的倍数把结构长大**（先灌原调色板 ⇒ 下标不变、**撤销栈仍有效**），再 `setStructure` 并同步分层滑块；负方向不搬坐标、明确拒绝。

### 2. 「不完整/半透明方块贴图消失」＝ `opaque`（剔除表）是空表、半透明表也没建（当时的 `opaque.js` 只有 22 KB 里的一小段）

`getBlockFlags().semi_transparent` 全 false ⇒ **半透明方块被合进不透明 mesh、写深度** ⇒ 互相错误遮挡、面"消失"。
Deepslate 的真实语义（`vendor/deepslate.umd.cjs` ChunkBuilder）：`flags.semi_transparent ? transparentMesh : mesh`。
修法：解每张贴图时记 **是否含非全不透明像素**，按"该方块任一贴图含 alpha"算 `flags.transparent` ⇒ **全量 718 个半透明方块**，写进 `data/opaque.js` 并随 `/api/scene` 回传。

> ⚠ **本条的"按贴图 alpha 判"是启发式，已被取代**（2026-10-10）：树叶/玻璃的贴图确实含 alpha，
> 但它们**不该走混合通道** ⇒ 判错。现改为读注册表的**权威渲染层**（`data/registry-layers.json`），见本节上方的「材质按渲染层判」一节。

### 3. 「不能移动视图、右键很怪」＝ 平移轴算错

原来只用了 yaw。现在 `viewport.panBy()` 按相机的 **right/up 轴**平移，位移按 `2·dist·tan(fov/2)/画布高` 归一（`tan(fov/2)` 取 `projMatrix[5]` 的倒数），手感 = 「拖多少像素 ≈ 目标平面上移动多少世界单位」；右键与中键都可平移。

### 4. 「还有方块没有贴图」＝ **不是 bug，是能力边界**

`ae2:matrix_frame` 的 `models/block/matrix_frame.json` 是**空对象** —— 资源包里**没有烘焙模型**，游戏里靠 **mod 自定义渲染器（BER）**画（`sophisticatedstorage` 的箱子同理）。
Deepslate 只画静态模型 ⇒ **本质上画不出来**。
修法（工具层）：把"模型链一个面贴图都没收到"的方块列入 `flags.noModel`，放置时**明说并跳过**，不再默默放一个看不见的方块。

**验证**：事件自测 **26/26 PASS**（新增 ②′ 放置不覆盖原方块、④′ 右键平移）。`/api/scene` 对照：`matrix_frame`/`netherite_chest` → 无模型 = true；`glass`/`oak_leaves` → 半透明 = true；`stone`/`ae2:controller` → 都 false。

⚠ 仍存的两条已知边界：①`opaque` 留空 ⇒ **不做面剔除**（面数偏多，但不会剔出洞）；②~~"半透明"是按贴图 alpha 判的**启发式**~~ → **已改**：按注册表渲染层判（2026-10-10，见上节），只有 `translucent` 走混合。

## 接上注册表 · 修最后 2 张 PNG（2026-10-10 · 第四轮）

### 1. 方块注册表默认态（权威值）

`data/registry-defaults.json`（**319 KB 侧车**）＝ 从 42.4 MiB 的 `vanilla-registry.json` 抽出的 `id → defaultState.properties`：
9,374 条里 **4,182 个方块有默认态**，**其中 3,540 个是 mod 方块**（这份拉取含 mod）。

**优先顺序**：`/api/scene` 回传的 defaults（服务端按注册表算） → 前端 `data/registry-defaults.json` → `src/defaults.js` 的启发式。
所以**按需打包**与**预打包回落**两条路径都用上权威值。

**注册表纠正了启发式**（实测）：`campfire {lit:true}`（启发式「布尔一律 false」会错）、`repeater {delay:1}` / `turtle_egg {eggs:1,hatch:0}`（启发式「数字一律 0」会错）、`white_banner {rotation:0}`（启发式推不出）。

重抽侧车（换实例/换 mod 后用）：
```bash
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('<注册表>','utf8'));const o={};for(const b of j.blocks||[]){const p=b&&b.defaultState&&b.defaultState.properties;if(b&&b.id&&p&&Object.keys(p).length)o[b.id]=p}fs.writeFileSync('preview/data/registry-defaults.json',JSON.stringify(o))"
```

### 2. 最后 2 张 PNG 解不了 —— 是 **Adam7 隔行**

`gtlcore:…fuel_rod_assembly_base`（colorType 0）与 `usclb:item/clipboard`（colorType 6）的 IHDR 都是 **`interlace=1`**，而 `src/png.mjs#decode` 旧版遇到隔行直接 throw。
修法：把"解一条扫描线"抽成 `runPass(offset, pw, ph, x0, dx, y0, dy)`，`interlace=0` 走一个 pass、`=1` 走 Adam7 的 7 个 pass（标准 `X0/Y0/DX/DY` 表，各 pass 有独立扫描线与滤波）。

⇒ **全量重建 `missingTextures: 0`**（textures 2,592 → **2,594**，正好 +2）。

⚠ 注册表默认态只解决「**默认态该是什么**」，不解决「用户想选别的朝向」—— 后者要属性选择 UI（属 P2）。

## 工具级修复（2026-10-10 · 第三轮）

用户录屏报「放置/删除切换与换方块时**界面放大缩小**」+「**模组方块材质直接丢失**」，两处都追到根上：

### 1. 裸名 = 默认态（mod 方块"材质全丢"的根因，两层）

**第一层：裸名没有属性 ⇒ multipart 一个 part 都不匹配。**
MC 里 `minecraft:oak_stairs` 表示它的**默认态**，而默认态在**方块注册表**里、资源包没有。纯 multipart 的方块（如 `ae2:controller`，每个 part 的 `when` 都要 `state`/`type`）在"无属性"时**一个 part 都匹配不到** ⇒ `models:0 / textures:0` ⇒ 放上去什么都没有。
修法：`src/defaults.js#defaultPropsOf()`（**服务端与浏览器共用**）近似推默认态 —— variants 对每个键打分取"最像默认"的（`facing=north`/`half=bottom`/`shape=straight`/布尔→`false`/数字→`0`）；multipart 把各 part 的 `when` 取值并起来。`/api/scene` 回传 `defaults`，前端**带属性放置** ⇒ 与打包时选中的模型严格一致。

**第二层：无命名空间引用的默认命名空间是 `minecraft`，不是"模型自身命名空间"**（我写错了）。
`ae2:controller` 的 `"parent":"block/cube_all"` 被补成 `ae2:block/cube_all`（不存在）⇒ 模型没有 elements ⇒ 材质全丢。
**实测定死**：1,047 条无前缀 `parent` 里 **0 条**落在自身命名空间、**813 条**落在 minecraft；无前缀 `textures` 707 条同样 **0 条**落在自身命名空间。
修法：`pickNs()` —— 优先 `minecraft`，不存在再退回自身命名空间兜底。

### 2. 界面放大缩小 = 状态栏换行改变高度

`#status` 原是 `flex-wrap:wrap`，而 `#msg`/`#stat` 的文字随操作变长变短 ⇒ **一换行状态栏就变高 ⇒ 视口高度变化 ⇒ 3D 画面整体缩放跳动**（放置/删除切换、换方块时都会触发）。
修法：状态栏**定高 30px + nowrap + 溢出省略**（`#msg` 最多 34ch）。

### 3. 顺带修掉的两处工具级缺陷

| 缺陷 | 修法 |
| --- | --- |
| **缓存键不含代码版本** ⇒ 修好 `pickNs` 后 `/api/scene` 仍返回旧 JSON（`models: []`），而 `stats` 是现算的、看着正常（**静默命中旧缓存**，最难查） | 缓存键改为 **管线源码 `size+mtime` 指纹 + 状态列表**，源码一变自动换键 |
| `resources.js` 里 `fromJson` 失败是**静默 catch** ⇒ 坏模型被悄悄丢掉、方块渲染成空白却毫无提示 | 收集 `skipped[]` 并回报：`stats.skipped` → 状态栏「跳过 N」、`#msg` 警告、console 明细 |

### 4. 验证（实测）

事件自测 **22/22 PASS**（新增 ⑦e 模型在资源里 / ⑦f 贴图有 UV / ⑦g 放置带属性 —— ⑦e **先 FAIL 后 PASS**，正是缓存键那处）。
默认态推导：`oak_stairs → {facing:north, half:bottom, shape:straight}`（原 `inner_left`）/ `oak_fence → 四向 false`（原全 `true`）/ `oak_door → {facing:north, half:lower, hinge:left, open:false}` / `ae2:controller → {state:offline, type:block}`。
`ae2:controller` 的 models **0→4** / textures **0→1**。**全量重建：缺贴图 10 → 2**（`framedblocks` 那 8 个"缺失"其实是命名空间解析错的**假象**，修后全部消失；余下 2 个是 PNG 解码失败）。

⚠ 默认态的 `PREFER` 表是**按 MC 惯例写死的**，不是从注册表读的 ⇒ 罕见方块可能仍不对。我们有带 `defaultState` 的注册表（`vanilla-registry.json`），接上才能彻底解决。

## 工具级修复（2026-10-10 · 第二轮）

针对「部分模组方块无法放置」与「闪屏」，都在**工具层**解决：

### 1. 场景资源会**按需扩展**（治「模组方块放不下」）

按需打包只按"载入那一刻的调色板"生成资源 ⇒ 之后从物品栏放**当时不在场景里**的方块（mod 方块最常见），它的 blockstate/model/texture 都不在资源里，自然放不出来。

修法：前端记住 `state.sceneStates`（这套资源覆盖了哪些状态；回落预打包时是 `'ALL'`）。放置前若 `!sceneCovers(id)` ⇒ **带着新 id 重新请求一次场景 → 热换图集 → 再放置**；`/api/scene` 同时回报 `unknownStates`（实例里没有 blockstate 定义 ⇒ 多半是物品不是方块），前端给出明确提示，不再"点了没反应"。`actAt` 因此改为异步。

### 2. 闪屏的三个系统性来源

| 来源 | 修法 |
| --- | --- |
| **按需重绘**（只在事件后画一帧）+ 未开 `preserveDrawingBuffer`：部分驱动会在两次绘制之间合成出空帧 | 改成**持续 rAF 帧循环**（`startLoop/stopLoop`，`vp.running` 可查）+ `preserveDrawingBuffer: true` |
| **网格与建筑底面共面**（都在 y=0）⇒ z-fighting 闪条纹 | 画网格前 `enable(POLYGON_OFFSET_FILL)` + `polygonOffset(1,1)`，画完 `disable`（不动 Deepslate 内部实现） |
| **物品栏选中时重建 `#grid` 的 innerHTML** ⇒ 48 张图标重下重解、肉眼闪一下 | 新增 `markSelected()`，只改 `.sel` 这一个类 |

顺带治掉的性能问题：持续帧循环下原先每帧 `getBoundingClientRect()`（在 `resize()` 里）会**每帧强制一次布局** ⇒ 改为尺寸缓存（创建时 + `window resize` + `ResizeObserver` 时测量），拾取也走同一份缓存。

### 3. 验证

`.work/test-events.html`（真派发 `pointer/click/keydown`）：**19/19 PASS**，其中
⑦a 该 mod 方块初始**不在**资源里（复现问题）→ ⑦b 选中 `ae2:controller` → ⑦c **点画布后它真的进了场景** → ⑦d **模型自动补进资源**（`sceneStates` 7→8）；
⑧ 选中不重建网格（DOM 节点复用）；⑨ `vp.running === true`。

⚠ **闪屏那三条是从代码结构推定的根因**（headless 抓不到瞬时闪烁），**没有"修前/修后"对照证据** —— 需刷新后由你确认。

## 图集缺贴图（材质问题）已修 —— 2026-10-10

**症状**：草皮层侧面一圈发白的半透明带。
**根因**：`grass_block` 的模型引用 `block/grass_block_side` 与 `block/grass_block_side_overlay`，而图集的 UV 表里**两张都没有** ⇒ 侧面取不到 UV。顶面 `grass_block_top` 在图集里，所以只有侧面坏。

**对账（`.work\audit-textures.mjs`，走 201 个 jar）**：4,823 张 block/entity 贴图，按"模型 face 引用（解 parent 链 + `#ref`）"比对 ⇒ **被引用的 495 个路径里 210 个不在 UV 表里**。

**根因在预演管线 `extract/build-assets3.py` 的两个 bug**：
1. 第 48 行引用正则 `"([a-z0-9_.\-]+:[a-z0-9_./\-]+)"` **只认带命名空间的引用**，而原版模型绝大多数写作 `"block/xxx"`（无前缀）⇒ 整批被过滤掉；
2. 第 59–62 行按 md5 去重"只保留第一名"⇒ **同内容的其余路径被整条丢掉**，UV 表里查不到。

**本机 Python 是 Microsoft Store 占位程序（返回 9009），跑不了那条管线** ⇒ 在既有产物上做增量修补：
- `.work\patch-atlas.mjs` 补 94 张。先试塞空隙 → 发现图集**碎片化**（单行最宽仅 96px，任何 256 行行带里连一个可用空洞都没有）；扩容到 9216² 后 **Deepslate 直接拒绝**：`Expected texture atlas dimensions to be powers of two, got 9216x9216`。
- `.work\repack-atlas.mjs` 把 **2,930 个唯一矩形用 guillotine BSSF 重排回 8192²**（面积只占 69.4%，装完只用 6144/8192 行）。
- `.work\patch-atlas2.mjs` 把 `item/*` 等剩余 84 张塞进空出来的 2048 行（成功 83）。

**顺带修的工具**：`src/png.mjs` 的 `decode` 原来只支持 8 bit，而 **155 张是 4/2/1-bit 索引图**（旧版直接 throw）→ 按 PNG 规范补上 <8bit；`encodeRGBA` 原来逐行 filter 0（重编码后 30.5→41 MB）→ 改为**按行在 filter 0/2 里选更优**。

**结果**：缺 UV **210 → 13**；UV 条目 2,836 → **3,033**；图集仍 8192²、**体积 29.28 MiB 与原版 29.11 MiB 基本持平（+0.6%，却多装 197 张贴图）**；截图放大确认侧面已是"泥土 + 顶部绿边"。
余下 13 个是源头就没有：`ae2:part/cable/covered/_color_` 这类**运行时占位名**、未安装的 `thaumcraft:*`、mod 写错的 `minecraft:plane/sides`、以及 1 张解码失败（`usclb:item/clipboard`）。

⚠ **管线里的两个 bug 仍在 `extract/build-assets3.py` 中**，下次换实例重跑会复发 —— 应按本节结论把管线改对，或按方案 P4 做"按需打包"。
备份在 `.work\backup-atlas\`（`original-*` / `before-repack-*` / `before-patch2-*`）。

## 与 `E:\mc\.work\dl-demo` 的关系

dl-demo 是**预演**，保持原样不动；本目录是产品化落地。差异：路径改相对、建筑走 `build.json`、
渲染与交互逻辑逐行保留，另加了 `src/` 分层、物品栏、编辑栈、导入导出与 API。

## 变更记录

- **D065**（2026-10-10）P0 落地：把预演搬进工具，三条验收通过（当时页面为现在的 `simple.html`）。
- **D067**（2026-10-10）做成产品：物品栏 + 编辑 + 导入导出 + API；修 `nbt.mjs` 跨 long 位序 bug；
  自测 20/20、往返 ALL PASS。
- **D069**（2026-10-10）修材质：图集缺 210 张贴图（草皮侧面发白）→ 缺 UV 降到 13；`png.mjs` 支持 1/2/4-bit 索引图。
- **D070**（2026-10-10）**修管线 + 实施按需打包**：`scene-assets.mjs` + `extract/build-atlas.mjs`（全量 8192²/29.3 MB → **4096²/2.48 MB**）；
  `POST /api/scene` 按建筑现打小图集（default.nbt → **256²/2.3 KB**），失败自动回落预打包。
- **D074**（2026-10-10）第五轮四处修复：放置法线 / 出界自动扩边界 / 半透明贴图消失 / 右键平移；事件自测 26/26。
- **D075**（2026-10-10）**打成功能包 `mc-preview-1.0.0.mmfeature`**（0.14 MB）：宿主适配层 `src/host.js` + Shadow DOM 挂载 + 6 个 action；
  宿主口径全过、后端 12/12。
- **D076**（2026-10-10）**材质按渲染层判**（新增 `registry-layers.json` 侧车，树叶/玻璃不再误判半透明）+
  **视图键盘移动**（WASD/QE + 提示）+ **Java 采集适配**（新增 `mc-pull` 的 `installProbe` / `importProbe`）；
  纠正「本机无 JDK」的旧结论（JDK 17 可用，探针已实测编译）；**两个功能包联动 17/17 PASS**。
- **D077**（2026-10-10）**修「两个功能包无法安装」**：宿主 `validateContributions()` 要求每个 action 带
  `inputSchema`（否则报「插件动作声明无效」），`validate()` 要求 `style` 恰为 `renderer.css` 且该文件要在包里
  ⇒ 补齐两包清单 + `mc-pull` 生成 `renderer.css`，并把宿主口径做成 `pack.cjs` 的**构建期硬失败**；
  新增 `.work/verify-host-install.mjs`（宿主口径复验 **45/45**）。
- **D078**（2026-10-10）**修功能包里的 UI（八处）**：`HOST` 私有变量导致的崩溃、shadow 包裹层无高度、
  空世界放不下第一块、物品栏/注册表读包内静态文件 404、预打包回落、示例下拉、图标 404；并还原被
  Node 路线覆盖的 `app/data`。**包内干净标签页 0 报错**；预览包后端 13/13、两包联动 17/17。
- **D079**（2026-10-10）**按审核员两份报告逐条修复 + 每条的闸门与变异**：B1（shadow 键盘防护）、
  B3（导入先清空再写，P0）、B2（卸载清理）、P1-1/P1-2（两个假绿灯断言）、U1（回落路径的旧 α 启发式，
  transparent 718→165）、B7（探针版本/客户端 jar/统计闭合）、P1-3（许可：撤 AGPL、补 MIT 署名）、
  P2-1（归档死联接）。闸门：假宿主浏览器 16/16、预览包 13/13、两包联动 21/21、导入安全 18/18、
  宿主口径 45/45、standalone `test-api` ALL PASS；**O1（开面剔除）因需要"满立方体"判据而暂缓**。
- **D080**（2026-10-10）**按 ModMind 的 `ui-design-studio` skill 重设计 UI**：颜色改为优先取宿主主题令牌
  `--theme-*`（穿 Shadow DOM 继承 ⇒ 面板跟随宿主深浅主题）、间距 4pt、圆角 3 档、字号阶梯、组件 7 态、
  `focus-visible`、`prefers-reduced-motion`、断点、**对比度实测 16 组全达 AA**（新增 Node 版 check_contrast）；
  视口 `gl.clearColor` 也跟随主题。顺带修：**`height: 100vh` 替换漏匹配导致面板溢出宿主容器**、
  **`items.json` 与 `icons/` 不一致（Node 路线覆盖主数据）**、**`PREVIEW_REGISTRY` 一变量两含义**。
  假宿主闸门 **20/20 × 浅/深两主题**、两包联动 23/23。
- **D081**（2026-10-10）**19:00 实机 228 条错误复盘修复**：根因 = `bindToolbar` 里 8 处 `vp.` 漏调用括号
  （惰性访问器当对象用）⇒「适应建筑/网格/撤销/重做/分层」全抛 TypeError。修法：删访问器 + 全文件统一
  `state.vp.`；新增**构建期机械自检** `tools/lint-source.mjs`（R1 禁止 `const X = () => 裸成员`，违反即构建失败）；
  闸门补**用户路径点检 + 可见层断言**（放置/适应/网格/撤销/重做的**增量**调用/分层/材料清单/0 未捕获异常）
  ⇒ **30/30 × 浅/深两主题**；变异（改回事故形态）→ 4 条红。另修 `gridBtn` 三元两支同一串。
- **D082**（2026-10-10）**按审核员《代码级缺陷与优化清单》收尾"该修"档**：**B4** 导入 accept 与 reader 支持集
  对齐（`.schematic` / `.schem v1/v3` 明确报错，不再"宣称支持却点了报错"）+ 删 v1 分支死代码；
  **B5** `.nbt` 负坐标整体平移（原来越界方块被**静默丢弃**）+ `structureFrom` 加 `skippedOutOfBounds` 并显红；
  **B6** 调色板越界单独计数 `skippedBadRef`（原来被算成"空气"，**误导排查方向**）；
  **U4** 三处静默截断回传 `truncated`（适配层透传 + 前端黄条）；**P3-3** 打包写 `dist/build-info.json`。
  三条新闸门都做了**变异**（改回旧行为 → 5 条红）；顺带修好**闸门自身的时序假失败**（⑦g 放置要等
  `await growScene` 落地）。交付 → `功能包\当前版本\`（preview 141,793 B / pull 14,971 B）。
- **D083**（2026-10-10）**补上采集包（mc-pull）自己的审核条目**（D082 只改了预览侧行为）：
  **U5/O9/P2-3** 注册表 44 MB → **id 侧车 292 KB**（`regBlockIds()` 侧车优先，带 mtime 失效）；
  **P3-2** 切图残差加**阈值 16 + 超差清单**（实测 `ok=false`／7 个图标超差，是**真问题**，没调绿）；
  **P3-1/O10** `encodeRGBA` **按尺寸分流**（<128px 不做 filter 择优）—— 实测 200 张 48px 图标：
  不择优 149,338 B vs 择优 224,039 B（**择优大 50%**）；
  **U2** 按钮写清「Java · 重建 / Node · 合并」+ 状态表加**派生目录**与**id 侧车**两行。
  新增 `test-icon-encoder.mjs`（5/5），两包联动 **23 → 26**；变异 3 组 → 6 条红。
  交付 → `功能包\当前版本\`（preview 141,837 B / pull **16,423 B**）。
- **D084**（2026-10-10）**★ 实机"面板空白 / 功能 UI 缺失 / 不显示建筑世界"的根因**：`main.js` 末尾直接
  `boot()`，而 **ES 模块只求值一次** —— 宿主把面板"切走再切回来"时新 shadow 树**没人再 boot**，只剩静态 HTML。
  修法：`boot()` 改 export + entry 每次挂载显式调用；`busy` 改成每次现查；`attachShadow` 幂等；
  boot 加阶段面包屑（失败写 `ERROR[阶段]：…`）。假宿主新增 ⑧「卸载→重新挂载」⇒ **35/35 × 浅/深**；
  **变异 → 31/35**（红的 ⑧a/⑧b/⑧c 实测 `网格 G` / `格 0` / `方块 —`，与用户截图逐字一致）。
  另查明采集结论：**Node 成功**（18,284/18,284）、**Java 失败**（探针装过但游戏没带探针启动过）；
  `pull_install_probe` 现在会清掉同 mod 的旧版本。交付 → preview **142,061 B** / pull **16,643 B**。
- **D085**（2026-10-10）**按用户一次提出的 7 项成批落地**：3D **空世界**（不铺石头）+ `pickPlane` **底部硬约束**
  可放第一块；放置后**自检** + **像素级闸门**（放了没画出来必须红）；采集**只留 Java 一条路线**；
  数据存到 `<project>/.modmind/mc-capture/packs/<key>/`（同实例覆盖、不同版本/整合包分离）；
  新增**数据包选择**与**二次确认清除**；采集面板按 ui-design-studio skill **重做 UI**（Shadow DOM + 宿主主题令牌）。
  预览包按 `active.txt` 读"当前数据包"。假宿主闸门：预览 **36/36**、采集 **15/15**（各 × 浅/深）；
  导入安全 18→**23**。交付 → preview **142,864 B** / pull **21,810 B**。
- **D086**（2026-10-10）**采集面板加自动搜索**（用户批注「直接加上自动搜索」）：`findProbeDumps()` 扫
  ①当前实例 ②`<MC>/versions/*` ③`<MC>` 根 找游戏内产物（按时间倒序，导入默认用最新的一处），
  `findInstances()` 自动列出"有哪些可用实例、装没装探针、有没有产物"；界面加「自动搜索」「可用实例」两行。
  采集闸门 **15 → 17/17 × 浅/深**（实测输出：`可用实例：GregTech Leisure（已装探针）`）。
  交付 → pull **22,839 B**。
- **D087**（2026-10-10）**去机器上查（用户问"你检查了吗"）**：① **探针从未运行过**——实例最后启动
  `2026-10-09 10:18`，探针 `18:21` 才装进 mods，整个 `.minecraft` 下没有任何 `.modmind`/`pull2`；
  ModMind 只有一个游戏根 `E:\mc\.minecraft`（搜索范围是对的）。② 查出**真 bug**：`verOf()` 取文件名里
  **第一个** `x.y.z`，那是 MC 版本 `1.20.1` ⇒ 探针版本比较从未生效、装哪个只看目录顺序（实例里因此躺着
  最老的 **0.2.0**）。改为取最后一个 x.y.z；⑦a 闸门用 5 个版本名加固，**变异后挑中的正是 0.2.0**。
  ③ 面板新增「最后启动」行与**结论**（`探针是在最后一次启动之后装的 ⇒ 探针从没运行过`），时间按本地时区显示。
  采集闸门 **17 → 19/19 × 浅/深**。交付 → pull **23,522 B**。
- **D088**（2026-10-10）**加自动采集**（用户："我的游戏自动采集呢"）：面板默认开启「自动采集」，
  每 8 秒（+挂载后 1.2 秒）看一眼，**发现比当前数据包更新的游戏内产物就自己导入**；判据由后端算
  （产物 `index.json` 的 mtime vs 数据包 `meta.json` 的 `capturedAt`），并用 `lastAutoAt` 防重复导入。
  采集闸门 **19 → 20/20 × 浅/深**；导入安全 **23 → 25/25**（判据 + 防死循环）。
  交付 → pull **24,155 B**。
- **D089**（2026-10-10）**查清"实例是什么、怎么启动"**（用户问）——从宿主 app.asar 里查到：ModMind 侧边栏
  **「测试与构建」**会「准备**隔离的** Minecraft 测试实例」并启动它，而那个实例的目录是 **`<项目>/minecraft/`**
  （由诊断采集器的 `path.join(dataRoot,"minecraft",…)` → `project/minecraft/…` 反推）。**原来的错位**：探针只装到
  `<MC>/versions/<名字>/`，宿主启动的却是隔离实例 ⇒ 探针根本没被加载。**修法**：`projectInstanceDirs()` 把
  `<项目>/{minecraft,run,run-gametest,run-server}` 纳入**装探针**（写两份、逐个回报）与**自动搜索**，
  面板「可用实例」两类都列。采集闸门 **20 → 24/24 × 浅/深**（实测磁盘上真有
  `gate-project/minecraft/mods/modmind-probe-…-1.0.0.jar`）。交付 → pull **24,788 B**。
