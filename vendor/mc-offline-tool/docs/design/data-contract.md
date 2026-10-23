# 统一数据契约设计稿（T3）

> **状态：设计稿，未落地任何代码改动。** 对应《Minecraft Universal Studio 智能体落地规范》§5.2 / §15 Task 3。
> **本文的每条设计都对着一次实测**：左边写"今天磁盘上真实是什么"，右边才是"应该是什么"。
> 凡是我没实测过的，都明确标**未验证**；凡是有取舍的，都在 §9 写明理由与他人做法（§8 参考资料）。
>
> **本文引用的每个数字都能复算**：`python tests/baseline/verify-design-facts.py`（16 项逐条对照）。
> 写这个脚本的当天就抓到我自己引错一个数（把"2 页切片 1,330 条里的 1,264"写成了"全量 18,266 条里 1,264"，
> 实测全量是 **17,384 条**）——引用数字的文档必须能复算，否则数据一变就没人知道哪句过期。
>
> 取证日期：**2026-10-13**。取证对象：
> `app/data/items.json`（18,284 条）、`.work/gencmp/m2-registry.json`（9,374 方块）、
> `.work/gencmp/registry-ids.json`（侧车）、`.work/probe-01/.modmind/probe/pull2/*`（探针 28 页产物）。
> 两个包的版本：`mc-pull 1.14.0` / `mc-preview 1.14.12`。

---

## 0. 一句话结论

**今天有 4 套互不相认的"物品/方块表"**（探针产物、数据包 items.json、注册表、注册表侧车），
它们靠**位置约定**（谁放在哪个目录）和**字段名巧合**（都叫 `ids`/`names`）互相认识 —— 没有版本号、没有 schema 身份、没有来源优先级规则。
本设计要做的是：**给每一份数据一个可校验的身份（`asset_id` + `schema_version` + `provenance`）**，
把"位置约定"换成"契约声明"，并明确**谁覆盖谁**、**缺了怎么办**。

---

## 1. `asset_id` 规则

### 1.1 现状（实测）

| 位置 | 主键形态 | 问题 |
| --- | --- | --- |
| 数据包 `items.json` | `ids: ["ad_astra:aeronos_cap", …]` 18,284 条 | 与 `names`/`icons`/`maxStack`… **按下标对齐** |
| 探针产物 `items-meta.json` | `ids` 18,266 条，另有一份 `index.json.items` | 两份 id 列表**必须同序**，但没有校验 |
| 注册表 | `blocks[].id` 9,374 条 | 与侧车 `registry-ids.json.ids` 同序 |

**实测风险**：按下标对齐意味着**任何一次过滤/乱序都会静默错位**。
我们已经在 B10 里吃过一次同类事故（`maxStack` 与 `ids` 语义错位：18,266 条里 **17,384 条（95.2%）** `maxStack` 为 0，而石头本该是 64）；
而且 `build-icons.mjs` 里 `meta.names.slice(0, ids.length)` 这种"按长度截断"在多页切片时**依赖两边同序**，无任何断言保护。

### 1.2 设计

```
asset_id := <namespace>:<path>[<state>][#<nbt-hash>]
  · 物品：  minecraft:stone                  （无 state、无 nbt）
  · 方块：  minecraft:oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]
           · 属性按**字母序**排列，用 `,` 分隔、`=` 连接，**不留空格**
           · 缺省属性**必须显式写出**（不做"省略即默认"的推断 —— 那会让同一个状态有两种写法）
  · 带 NBT 的物品/方块实体：minecraft:chest#<sha256前16>   （nbt 归一化后的哈希）
```

**判据（可执行）**：
- 正则：`^[a-z0-9_.-]+:[a-z0-9_/.-]+(\[[a-z0-9_]+=[a-z0-9_.-]+(,[a-z0-9_]+=[a-z0-9_.-]+)*\])?(#[0-9a-f]{16})?$`
- **不等价判据**：`minecraft:oak_stairs[facing=east,half=top]` 与 `…[half=top,facing=east]` 必须**归一化后相同**；
- **反例保护**：不允许 `minecraft:oak_stairs[]`（空属性表）与 `minecraft:oak_stairs` 同时存在。

**为什么不用"数组下标"当主键**：下标是**位置**，不是**身份**；任何排序/过滤都会让它变义。
`asset_id` 的价值恰恰在于"同一件东西在任何一份数据里都是同一个字符串"。

### 1.3 迁移面（要说清代价）

- ~~`items.json` 的 `ids` 是**现有公开产物**，`app/app.js` 与 `preview_items` 都按下标读。
  ⇒ **不删 `ids`**，而是**新增** `assetIds[]`（与 `ids` 同长同序），并把 `ids` 标注为"兼容列、主张废弃"。~~
  ✅ **已落地（2026-10-13，mc-pull 1.14.1）**：`items.json` 现有 `schemaVersion: 1` 与 `assetIds[]`，
  由 `src/asset-id.mjs` **生成**（不是抄 `ids`）；判据见 `pull-feature/.work/test-asset-id.mjs`（**28 条**）。
  ★ 两个必须写下来的诚实点：
    ① 实测 18,284 条真实 id **全部合规、归一化后 0 条变化** ⇒ `assetIds === ids` **是预期的**；
    ② 因此"两者相等"这条断言**对空实现也成立**，**不能当验证** —— 真正的判别力在测试的
       **变异用例**（乱序输入必须被改写、属性值不同必须不相等）。
  ⚠ 另有一个历史字段：`items.json` 里的 `schema: 2` —— 全仓 grep 实测**只有写入、无人读取**，
  保留仅为兼容；**不要再往它上面加含义**，数据契约版本一律看 `schemaVersion`。
- 探针侧（Java）：`ids` 已有；**新增**方块态的 `assetIds` 是**新一轮探针改动**（要重新编译 + 真机跑），不要塞进本轮。

---

## 2. SQLite schema + migration

### 2.1 现状

**今天没有数据库。** 一切靠 JSON 文件 + 目录约定：

```
<pack>/items.json          18,284 条 · 约 1.9 MB
<pack>/icons/*.png         18,284 张（实测 app/data 那份）
<pack>/meta.json
<project>/.modmind/mc-capture/{active.txt, packs/<key>/…}
.work/gencmp/registry-ids.json   （侧车：{source, sourceMtime, count, ids[]}）
```

**实测痛点**：`registry-ids.json` 这个侧车就是"文件当索引"的补丁 —— 它存在的唯一理由是
**读 42 MiB 的注册表太慢**（只为了拿 9,374 个 id）。这正是"该用数据库"的信号。

### 2.2 设计（最小表集）

```sql
-- schema_version：所有写入都必须先读它做兼容判断
CREATE TABLE schema_meta (version INTEGER NOT NULL, applied_at TEXT NOT NULL, note TEXT);

-- 资产主表：一行 = 一个 asset_id
CREATE TABLE asset (
  asset_id      TEXT PRIMARY KEY,
  ns            TEXT NOT NULL,       -- 冗余出来便于按命名空间统计/过滤
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL,       -- item | block | entity
  display_name  TEXT,                -- 中文名（来自语言文件或探针）
  display_lang  TEXT,                -- 这个中文名是哪种语言得到的（'zh_cn' / 'game'）
  block_state   TEXT,                -- 归一化后的属性串（无则 NULL）
  nbt_hash      TEXT
);
CREATE INDEX idx_asset_ns ON asset(ns);
CREATE INDEX idx_asset_path ON asset(path);

-- 来源：一个 asset 可以有多个来源，靠 confidence 排序（见 §3）
CREATE TABLE asset_source (
  asset_id   TEXT NOT NULL REFERENCES asset(asset_id),
  provenance TEXT NOT NULL,          -- 见 §3 的取值域
  confidence INTEGER NOT NULL,       -- 越大越可信
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  detail     TEXT,                   -- 该来源的原始定位（实例目录/jar 路径/产物目录）
  PRIMARY KEY (asset_id, provenance)
);

-- 图标：一张图可以被多个 asset 共享（实测：同贴图多物品）
CREATE TABLE icon (
  asset_id   TEXT NOT NULL REFERENCES asset(asset_id),
  png_rel    TEXT NOT NULL,          -- 相对 packs/<key>/icons/ 的文件名
  px         INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,      -- ★ 去重键必须用**全串哈希**，不许用截断串
  provenance TEXT NOT NULL,
  PRIMARY KEY (asset_id, provenance)
);

-- 属性：**每个字段自带 provenance 与可信度**（B10 的教训：不能整包一个"可不可信"）
CREATE TABLE attr (
  asset_id   TEXT NOT NULL REFERENCES asset(asset_id),
  key        TEXT NOT NULL,          -- max_stack | damageable | max_damage | framed | …
  value      TEXT,                   -- 存字符串，读时按 key 的类型解析（NULL = 未知，**不是**默认值）
  provenance TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  PRIMARY KEY (asset_id, key, provenance)
);

-- 解析器注册表（§4）
CREATE TABLE parser (
  parser_id      TEXT PRIMARY KEY,        -- 例：'langfile.zh_cn@1'
  parser_version TEXT NOT NULL,
  input_glob     TEXT NOT NULL,           -- 它认什么输入
  output_kind    TEXT NOT NULL,           -- name | blockstate | icon | attr
  builtin        INTEGER NOT NULL DEFAULT 1
);
```

### 2.3 三条硬规矩

1. **`value IS NULL` 表示"未知"，永不等于"默认值"** —— B10 的核心教训。要表示"真的是 64"就得写 `'64'`。
2. **`confidence` 只在"同 key 不同来源"之间比较**；不允许把不同 key 的置信度相乘（那是伪精度）。
3. **写库前必须先读 `schema_meta.version`** 并在不认识的版本上**明确报错**（§0.6：不得静默降级）。

### 2.4 migration 机制（最小可跑）

```
migrations/001_init.sql
migrations/002_add_attr_table.sql     ← 追加式；每个文件只有 up（不做 down，回滚靠备份）
```

- 启动时：`PRAGMA user_version` 取出当前版本 → 依次 apply 未执行的 `NNN_*.sql` → 写 `schema_meta`；
- **每个 migration 必须先备份**（`<db>.bak-<version>`）——"可回滚"比"有 down 脚本"更实用；
- **禁止**在 migration 里做网络/外部进程调用（保证可离线重放）。

### 2.5 迁移面

**不要求**立刻把 JSON 换成 SQLite。设计稿定的是**契约**；落地顺序建议：
① 先在 `items.json` 上加 `schemaVersion`/`assetIds[]`/`provenance`（**不动存储**）；
② 再让读取方（preview / app）改成"优先读 SQLite、回退读 JSON"；
③ 最后才把写入方切过去。**每一步都能单独回退。**

---

## 3. 来源优先级

### 3.1 现状（实测）

今天**没有任何优先级规则**，实际行为是"**谁最后写谁赢**"：
`packs/<key>/items.json` 可以被"免探针直读"覆盖，也可以被"探针导入"覆盖，两者**同 key 就直接换掉**。
磁盘上真实存在两份语义不同的产物：`source: 'mc-pull local-assets …'`（免探针，属性全 null）
与 `source: 'probe:pull2'`（探针，属性是"取错 API 的 maxStack"）—— 而**没有任何字段能机器判定谁更可信**。

### 3.2 设计：`provenance` 取值域 + 置信度（**只增不改**）

| provenance | 含义 | 实测依据 | confidence（属性类） |
| --- | --- | --- | --- |
| `probe.pull2@1` | 游戏内探针（1.1.0+，带 `attrSemantics`） | 字节码差分 10/10 通过 | **100** |
| `probe.pull2@0` | 游戏内探针（≤1.0.0，字段语义错位） | 实测 18,266 条里 **17,384 条（95.2%）** `maxStack == 0`（石头本应 64） | **0**（不可用，只留原始值） |
| `local-assets` | 静态读实例 jar（免探针） | 实测 15198 候选 → 落盘若干 | 名字 60 / 图标 70 / **属性 0（未知）** |
| `langfile.zh_cn@1` | 语言文件里的键 | 注册表没有物品表，靠它凑 | 名字 40 |
| `registry.default-state@1` | 注册表（只含默认态） | 实测 9374 条、每块 1 个 state | 方块身份 80 / 状态 30 |
| `report.vanilla@1` | 官方 `--reports`（未验证） | **未验证** | 名字 70 / 属性 50 |

**冲突解决规则（必须可实现、可测试）**：
1. 同一 `(asset_id, key)` 有多个来源 ⇒ **取 confidence 最大者**；
2. 相同 confidence ⇒ 取 `last_seen` 较新者，且**记录 `losing` 来源**（便于事后追）；
3. **图标不适用"取最大"** —— 一张真渲染图与一张静态贴图不是"同一件事的两个值"，而是**两个不同的东西**
   ⇒ 图标必须**并存**，由用户在预览里选（今天 `meta.json.fidelity` 已经在做这件事的雏形）。

**判据**：给一个"探针产物 + 免探针产物同 key"的场景，断言最终 `attr.provenance='probe.pull2@1'` 且
`icon` 表里**两张都在**。反例：把探针产物删掉 ⇒ 属性必须回落成"未知"，**不许**回落到免探针的 null→64。

---

## 4. 解析器注册表

### 4.1 现状

解析逻辑**散在代码里、没有身份**：语言文件解析在 `pull-feature/backend/main.js`，
方块态解析在 `preview/scene-assets.mjs`，图标在 `src/build-icons.mjs`。
**没有 `parser_id`/`parser_version`**⇒ 出了问题无法回答"这条数据是哪版解析器产出的"（B10 就是靠翻源码才定位到的）。

### 4.2 设计

- 每条**入库的字段**都必须能回答"谁写的"：`attr.provenance` 与 `icon.provenance` 里带上解析器身份，
  例如 `'probe.pull2@1'` 隐含解析器 `probe.pull2@1`；对本地解析器用 `'langfile.zh_cn@1'` / `'registry.default-state@1'`。
- 解析器三个必备属性：**输入 glob**、**输出 kind**、**确定性**（同输入同输出）。
  非确定性的（例如"取目录里最新文件"）必须显式标注并把选择结果写进 `detail`。
- **解析器不得静默跳过**：跳过的条目要计数并暴露（今天 `dropped`（无图标）已经在做了，实测
  「候选 15198 → 落盘 N（新烤/复用/丢弃无图标）」这条恒等式就是正确形态，推广到所有解析器）。

### 4.3 判据

`assert dropped + kept === candidates`（今天只有 `pull_run` 有这条）；
新增解析器时同样要求"输入条目数 = 各出口之和"，且每个出口**有名有数**。

---

## 5. BlockState 模型（**本轮最重要的发现**）

### 5.1 现状（实测，逐条可复算）

`.work/gencmp/m2-registry.json`（9,374 方块）的 `render` 字段形状：

```jsonc
"render": {
  "kind": "baked",                       // baked 5856 (62.5%) / invisible 3518 (37.5%)
  "states": [                            // ★ 每个方块**恰好 1 个** state（9374/9374 全是 1）
    { "properties": { "facing": "north", "half": "bottom", "shape": "straight", "waterlogged": "false" },
      "quads": [ { "sprite": "minecraft:block/oak_planks", "tintIndex": -1, "layer": "solid",
                   "vertices": [ { "position": [0,0.5,0], "uv": [...], "color": [...] }, … ] } ] }
  ]
}
```

**关键实测结论（三条，都会影响设计）**：

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | **只存默认态**：`oak_stairs` 有 4 个属性，但 `properties` 里每个属性**只有 1 个取值**（`facing: ["north"]`） | `blocks[].properties` 的取值基数分布 = `{1: 9600}`（全部都是 1） |
| 2 | **几何只有 1 份**：`states` 长度分布 = `{1: 9374}` | `oak_slab` 只 bottom、`oak_log` 只 `axis=y`、`redstone_wire` 只 `power=0` |
| 3 | **37.5% 没有任何几何**：`kind: 'invisible'` 且 `quads: []` | `minecraft:water` → `{kind:'invisible', quads: []}` |

**按来源拆分**（这份注册表取自 GregTech 整合包，`gtceu` 占 7074/8371 个 mod 方块）：

| 范围 | 总数 | baked（可渲染） | invisible |
| --- | --- | --- | --- |
| 全部 | 9,374 | 5,856 (**62.5%**) | 3,518 (37.5%) |
| 原版 `minecraft:` | 1,003 | 863 (**86.0%**) | 140 (14.0%) |
| mod 命名空间 | 8,371 | 4,993 (**59.6%**) | 3,378 (40.4%) |

★ **这份统计只反映"这一台机器的这一个整合包"**，不能外推到别的实例（尤其是原版环境）。

### 5.2 设计

**BlockState 模型分三层，每层都带 `fidelity`（规范 §0.6 要求"失败必须可见"）**：

| 层 | 内容 | 数据来源 | fidelity 标记 |
| --- | --- | --- | --- |
| **L1 身份层** | `asset_id` + 默认属性串 + 是否方块 | 注册表（已有） | `state.default` |
| **L2 取值域层** | 每个属性的**完整取值域**（`facing ∈ {north,south,east,west}`…） | **今天缺** ⇒ 从客户端 jar 的 `assets/<ns>/blockstates/<name>.json` 的 `variants`/`multipart` 键里提取（**这是权威来源**，且离线可得） | `state.domain` |
| **L3 几何层** | 每个状态的烘焙几何 | ① 注册表已有默认态的 quads；② 其余状态：**按 L2 的取值域 + 已知形态族做变换**（stairs/slab/fence/wall/door/pane/rail 等），或标记 `unresolved` | `geom.baked-default` / `geom.transformed` / **`geom.unresolved`** |

**明确不做的事**（避免把"猜"写成"已实现"）：
- ❌ 不为 `invisible` 的 3,518 条**编造几何** —— 它们要么需要真实渲染器（探针/游戏内），要么本就不可见；
- ❌ 不假设"非默认态 = 默认态旋转一下" —— 楼梯的 `shape=inner_left` 与 `straight` 是**不同几何**，
  变换只对**已确认的形态族**成立，其余一律标 `geom.unresolved`；
- ❌ 不把 L2 的取值域**从属性名猜**（例如看到 `facing` 就假设 4 个方向）—— 必须来自 blockstate json。

### 5.3 判据

- **可枚举性**：对每个方块，`L2` 覆盖的属性集合 ⊇ `L1` 默认态里出现的属性集合（不允许"默认态有某属性、取值域里却没有"）；
- **可渲染性**：`fidelity ∈ {baked-default, transformed}` 的方块占比要被**报出来**，并与上表的 62.5% 对照；
- **反例保护**：拿 `minecraft:oak_stairs[facing=east]` 去查几何，**若返回 undefined 必须显式标 `geom.unresolved`**，
  不许回退成默认态几何（那是"静默伪造渲染"）。

---

### 5.4 ★ L2 取值域层：**已实测**（2026-10-13，结掉 §9 未决问题 1）

来源候选实测（脚本 `tools/measure-blockstates.py`，可复跑）：

| 测量 | 结果 | 说明 |
| --- | --- | --- |
| **A 覆盖** | **1003 / 1003 = 100.0%** | 对**版本匹配**的 `E:\mc\原版素材库-1.20.1\assets\minecraft\blockstates`（1005 个文件） |
| A 的**反例** | 76.0%（762/1003） | 第一版我拿 **1.16.5** 实例的 jar 去对 **1.20.1** 的注册表，缺口全是 `cherry_planks`/`mangrove_*`/`bamboo_*`（**1.20 新方块**）⇒ 那是**版本差异**，不是覆盖不足。★ **A 类测量必须版本匹配，否则数字没有意义** |
| **B 增量** | 462 个方块能抽出取值域；解析失败 **0**；纯 `multipart` **67** 个 | 平均属性数 2.10 / 平均取值总数 5.98 / **平均状态组合 13.4** |
| **B 的关键判据** | `variants` 类 396 个里，**状态组合 >1 的 = 396 = 100.0%** | ⇒ **每一个能算状态数的方块都不止一个状态**，没有"顺手就能全画"的运气 |
| 解锁量 | 这 396 个方块共有 **4,695** 个状态，今天只能画 **396** | ⇒ 补上 L2 后，这批方块的渲染覆盖率 **8.4% → 100%** |
| 状态最多 | `chiseled_bookshelf`=**256**、`redstone_wire`=81、`brown_mushroom_block`/`chorus_plant`/`glow_lichen`/`mushroom_stem`/`red_mushroom_block`/`repeater`=64 | 单块状态数上限远超直觉 |
| **C mod 侧** | forge 实例 `All in One [Modded One Block]`：mod jar 113 个 ⇒ **5,299 个** blockstates / **52** 个命名空间（TOP：quark 860、silentgems 626、botania 542、create 443） | mod jar **确实是**取值域来源 |
| **C 的反例** | fabric 实例 `Immersed With Shaders`：mod jar 68 个 ⇒ `blockstates` **0 个** | ★ **fabric 侧的取值域拿不到**（该实例的 mod 不在 jar 里带 blockstates）⇒ L2 必须**允许缺失并显式标注**，不能假设"有 jar 就有取值域" |

**结论（据此定 L2 的来源与降级）**：
1. **L2 首选来源 = `blockstates/*.json`**（原版 100%、forge mod 覆盖良好）；
2. **必须版本匹配**：拿另一个版本的素材去补，得到的是"看起来像缺口"的**版本差异**；
3. **纯 `multipart`（67/1005）要单独处理**：它的 `when` 是**部分约束**，**推不出完整状态组合数**
   ⇒ 设计里必须补一条 multipart 合并规则（目前 **未决**，见 §9）；
4. **fabric 类实例可能整实例为 0** ⇒ L2 缺失是**正常状态**，按 `fidelity` 标 `state.domain-missing`，
   **不许**回退成"只用默认态却声称已覆盖"。

### 5.5 ★ `multipart` 的合并规则（已实现并实测，T3 第④步）

**规则定义在 `src/blockstate.mjs`（唯一实现），判据在 `pull-feature/.work/test-blockstate.mjs`（32 条）。**

| 写法 | 能给什么 | 不能给什么 |
| --- | --- | --- |
| `variants` | 键 = 完整状态 ⇒ `stateCount` **可数**、属性与取值域**完整**（`domainComplete: true`） | — |
| `multipart` | 只给「**观察到**的属性取值」+ 笛卡尔积**上界** | ★ **状态总数（恒为 `null`）**、★ **完整取值域（`domainComplete: false`）** |

**合并细则**：`when` 是**合取**；`{"OR":[a,b]}` 析取 / `{"AND":[a,b]}` 合取；
值里 `"a|b"` = 多个允许值；`"*"` = 任意 ⇒ **不计入**（记了会让下游以为"这个值是对的、且只有这些"）。

#### ★★ 本轮实测新增的第二个发现：**"观察到的取值"也不完整**

设计稿原来只要求"不给状态总数"。实现时我先把它叫"取值域"就交出去了 —— **这是过度声称**，实测证据：

| 测量（`tools/probe-multipart-domain.mjs`，可复跑） | 结果 |
| --- | --- |
| multipart 文件总数 | **67** |
| 其中含「**没有 `when` 的部件**」的 | **33 个（49.3%）** —— 那些部件对**所有状态**都适用，其取值**根本没被记录** |
| 与注册表（运行时真值）对照可比的 | **66 个**，其中**属性集合不一致 57 个** |
| 具体样例 | `acacia_fence` / `birch_fence` / `andesite_wall` **漏 `waterlogged`**；`bamboo` **漏 `stage`**；`redstone_wire` **漏 `power`**（注册表有 `east,north,power,south,west`，我方只有四个方向） |

⇒ 所以本模块用 **`domainComplete`** 显式区分，并把两个方向的界都说清：

- `properties` = 「**至少**观察到这些」（**下界**，可能漏）；
- `upperBound` = 「**至多**这么多组合」（**上界**，可能多，也可能恰好相等 —— 实测 `redstone_wire` 恰好是 81）；
- **两者都不是真值**，因此 `describeCoverage()` 在 `state.partial` 时返回 `kind: 'domain-only'`，
  **不许**据此算"覆盖率"（分母未知）。

★ 与此直接相关的一条来源事实：注册表的来源实例 **`GregTech Leisure` 已从磁盘消失**
（`versions/` 下只剩 `All in One [Modded One Block]` 与 `Immersed With Shaders`）
⇒ `m2-registry.json`（9,374 方块）与 `app/data/items.json`（18,284 物品）**在本机已无法重新导出**。
这正是 `asset_source.detail` 与 `.mcproject.paths` 要记 provenance 的理由 —— 而且要能**看出路径已经不存在**。

---

## 6. `.mcproject`

### 6.1 现状

**今天没有 `.mcproject`。** 项目根靠**调用方传 `projectPath`**，数据落在
`<projectPath>/.modmind/mc-capture/`（实测结构：`active.txt` + `packs/<key>/{items.json,icons/,meta.json}`）。
`pack key` 由实例目录名派生（`packKeyOf(instanceDir)`），
⇒ 同一实例在**不同项目**里会生成**同 key 的两个包**，而它们之间没有关联。

### 6.2 设计（**放在项目根、进版本库、人可读**）

```jsonc
// <project>/.mcproject           （JSONC；解析器必须容忍注释）
{
  "schemaVersion": 1,
  "name": "我的红石机器",
  "packs": [
    { "key": "GregTech Leisure",
      "title": "GregTech Leisure",
      "capturedAt": "2026-10-13T00:21:12Z",
      "fidelity": "probe",                       // basic | probe
      "attrProvenance": "probe",                 // unknown | probe-mismapped | probe
      "count": 18284,
      "assets": { "iconPx": 48, "pxPerTexel": 3 } }
  ],
  "activeKey": "GregTech Leisure",
  "paths": {                                     // ★ 与 B2 的解析结果同源：把"本机路径"记进项目，便于换机器时诊断
    "MC_ROOT":  { "value": "E:/mc/.minecraft", "source": "config" },
    "REGISTRY": { "value": "…/m2-registry.json", "source": "env" }
  }
}
```

**三条规矩**：
1. **进版本库**：路径字段**不写绝对路径的"活路径"**，只写"当时解析到的值 + 来源"，用途是**诊断**，不是复现；
2. **`schemaVersion` 必须存在**，读取方不认识就报错（不得静默按 1 处理）；
3. **包 key 与实例的关系要显式**：新增 `instanceRef`（实例名 + mc 版本 + 加载器），
   避免"同名实例在不同机器上被当成同一个包"。

### 6.3 迁移面

今天没有 `.mcproject` ⇒ **这是纯新增，不改任何现有行为**。
第一步只做"**写出来**"（导出/保存时生成），读取仍走现有 `active.txt`；
等 `.mcproject` 出现且被信任后，再让 `active.txt` 降级为缓存。

---

## 7. 拉取 → 预览的交换协议

### 7.1 现状（实测）

预览包读数据的路径有**两条**，格式不同、且都按下标对齐：

| 通道 | 生产者 | 消费者 | 实测形状 |
| --- | --- | --- | --- |
| `preview_items` | 读 `packs/<key>/items.json` | 渲染器 | `{id, name, icon, block}`（**丢掉了全部属性**） |
| `preview_scene` | `createSceneAssets({instanceDir, mcDir, registryPath})` | 渲染器 | 直接吃注册表的 `render.states[0].quads` |

⇒ 今天**"物品栏"与"3D 场景"是两套独立数据**：一个来自 items.json、一个来自注册表。
两边对同一个方块的认知可能不一致（items.json 说它 `block: true`，注册表说它 `kind: invisible`）。

### 7.2 设计（**单一来源 + 显式 fidelity**）

```
交换单元 = { assetId, iconRef, geomRef, fidelity, provenance }
  · iconRef：packs/<key>/icons/<png_rel>（可空）
  · geomRef：registryId + blockStateKey（可空）
  · fidelity：'icon.probe' | 'icon.static' | 'geom.baked-default' | 'geom.transformed'
              | 'geom.unresolved' | 'none'
  · provenance：见 §3
```

**规约（可执行）**：
1. **消费者必须按 `fidelity` 决定"画什么"**，不许自己判断"没有几何就画个方盒"；
2. **缺几何 ⇒ 明确标记**并在界面上可见（今天 `render.kind='invisible'` 的 37.5% 就是这类）；
3. **协议带 `schemaVersion`**，前后端不匹配时**明确报错**（不许"尽力解析"）；
4. **图标与几何各自独立降级**：有真渲染图但无几何（例如 GT 的机器）应当**能单独用**，
   不能被"几何缺失"连坐（今天的实现在 `scene` 路径上正是连坐的）。

### 7.3 判据

- 对 `minecraft:oak_stairs[facing=east]`：`geomRef.fidelity` 必须是 `transformed` 或 `unresolved`，
  **不能**是 `geom.baked-default`；
- 对 `gtceu:*`（7074 条，多数 `invisible`）：界面必须**看得出**"这类方块没有几何"，
  而不是渲染出一个空场景让人以为"拉取失败了"。

---

## 8. 参考资料（社区里已经有人做过的事）

| 主题 | 别人的做法 | 对本设计的用处 |
| --- | --- | --- |
| blockstate 建模 | **PrismarineJS 的 `minecraft-data`**：为每个版本生成 `blocks.json`，显式给出 `states` 数组 + `defaultState` + 每个属性的取值域 | 这是"取值域层"最成熟的现成形态；**先查它有没有覆盖我们要的版本**，能省掉自己解析 blockstate json |
| 资产身份 | **Minecraft 自己的 `ResourceLocation`**：`namespace:path`，全小写、`[a-z0-9_.-]` | 直接沿用其字符集规则，避免自创一套 |
| 版本化 schema | **SQLite 官方 `user_version` + 追加式 migration**（Rails/Django 的写法） | §2.4 采用；回滚靠备份而非 down 脚本 |
| 图标去重 | 成熟做法是**内容哈希**（sha256 全串），不用文件名 | 我们的 User Memory 里已记过"截断串碰撞"事故（853 张贴图 28 组键碰撞），§2.2 的 `content_sha256` 就是这么定的 |
| 保真度标记 | **glTF 的 `KHR_materials_*` 扩展**思路：不认识就忽略，但**必须能表达"我不知道"** | 支撑 `fidelity` 字段的设计（"未解析"是一等公民） |

> ★ 参考资料的用法遵守规范 §0.5：**不因为"别人这么写"就当依据**，
> 只用于对照"有没有现成轮子"，采纳与否仍以本仓库实测为准。

---

## 9. 取舍与未决问题（必须显式列出来）

### 已做的取舍

| # | 取舍 | 理由 |
| --- | --- | --- |
| 1 | **不删** `items.json` 的 `ids`/`maxStack`，只**新增**列 | 它们是现有公开产物，删了就破坏 `app/app.js` 与 `preview_items`；保守优先（§3.3） |
| 2 | 属性**逐字段**带 provenance，不做"整包一个可不可信" | B10 的教训：一个包里可能只有两个字段错，整包标记会**过度**否定其余字段 |
| 3 | 图标**并存**而非取最大 | 真渲染图与静态贴图是"两个不同东西"，不是同一个值的两个来源 |
| 4 | BlockState 只做**默认态 + 已确认形态族**的几何 | 不许编造；`invisible` 的 37.5% 保持显式不可渲染 |
| 5 | `.mcproject` 纯新增 | 今天没有它，加它不动任何现有行为 |

### 未决（需要你或后续实测决定）

1. ~~**L2 取值域从哪来**~~ → **已实测结案（§5.4）**：用 `blockstates/*.json`，**必须版本匹配**；
   原版覆盖 **1003/1003 = 100.0%**、forge mod 侧 5,299 个文件/52 命名空间；
   ★ **fabric 实例实测 0 个** ⇒ L2 缺失要作为**正常状态**显式标注。
   仍未决的是 **multipart 的合并规则**（67/1005 个纯 multipart 文件推不出完整状态数）—— 见下面新增的第 5 条。
2. **是否真的引入 SQLite**：今天 18,284 条用 JSON + 侧车已经能跑（0.47 s 读 114 jar 是另一处实测）。
   SQLite 的收益在"多来源冲突 + 查询"，不在"条数多"。⇒ 建议**先落契约、后落存储**（§2.5 的三步）。
3. **`nbt` 的归一化口径**：`#<hash>` 需要定义"什么算同一个 NBT"（键序无关？列表有序？），**未决**。
4. **`.mcproject` 进版本库会不会泄漏实例名**：实例名可能含个人信息 ⇒ 是否需要脱敏开关，**未决**。
5. ~~**`multipart` 怎么合并成完整状态数**~~ → **已结案（§5.5）**。
   规则已实现（`src/blockstate.mjs`）+ 判据 32 条（含**真数据穷举**：全库 1005 个 blockstate，
   纯 multipart 的 `stateCount` 非 null 的 **0 例**）。
   **最终采用的就是"只给可能取值、不给状态总数"这条**，并**额外**发现"可能取值本身也不完整"
   （33/67 有裸 `when` 部件、57/66 属性集合与真值不一致）⇒ 用 `domainComplete: false` + `upperBound`
   （明确标为界，不是真值）表达这个"不知道"。
   被否掉的另两条：**笛卡尔积当状态数**（假精确）、**读 `models/` 重建**（成本高且未验证）。

## 10. 这份设计稿怎么变成可验证的（下一步的最小动作）

按规范"小步 + 每步可验证"，建议顺序（**都不改现有行为**）：

1. ~~**做一个"可枚举率"实测**~~ → **已完成（§5.4，2026-10-13）**：A 覆盖 **1003/1003 = 100.0%**（版本匹配）、
   B 增量平均状态组合 **13.4**、`variants` 类 100% 不止一个状态、fabric 实例实测 **0 个**。
   脚本 `tools/measure-blockstates.py` 可复跑。⇒ **L2 的来源已定：`blockstates/*.json`，必须版本匹配，允许缺失**。
2. ~~**给 `items.json` 加三个字段**~~ → ✅ **已完成（2026-10-13，mc-pull 1.14.1）**：
   `schemaVersion: 1` + `assetIds[]`（`attrProvenance` 在 1.13.1 已有）。
   落实时把判据**加强**了一条：不仅"同长同序"，还要有**变异用例**证明归一化在做功
   （否则 `assetIds === ids` 对空实现也成立 = 空跑假 PASS）。测试：`test-asset-id.mjs` 28 条。
3. **把 §3 的来源优先级做成一张表 + 一个纯函数 + 断言**（冲突时选谁）——**先不接数据库**。
4. ~~**补一条 multipart 合并规则的定义**~~ → ✅ **已完成（2026-10-13）**：见 §5.5。
   规则实现 `src/blockstate.mjs`，判据 `test-blockstate.mjs` **32 条**（含真数据穷举与已知限制的可观察性）。

**不建议**一开始就上 SQLite 或改探针：前者是存储选型，后者要重新编译 + 真机跑，
都会把这一轮拖长，而且都不能单独验证。
