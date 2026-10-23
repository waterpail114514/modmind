# test-fixtures.md —— 可用的真实测试样本（哈希为本次实测）

- 依据：规范 §6.2「每组至少选一个可获得、许可允许用于测试的真实样本，并记录版本号、来源、哈希、预期输出和测试日期」
  与 §11.2「每条测试记录至少包含…输入文件来源与 SHA-256…」
- 实测时间：2026-10-12
- 记法：**事实** ＝ 本次实测；**未验证** ＝ 没有样本或没跑过，不得推测通过

★ **哈希纪律**：本表所有哈希都是 **2026-10-12 实测重算**。若样本被替换，本表即失效；
判定"上一轮结论还算不算数"之前，先重跑 `python tests/baseline/make-ledger.py`（它只覆盖 `.mmfeature`）
或对本表逐条复算。

---

## 1. 真实游戏实例（用户本机，`E:\mc\.minecraft\versions\`）

本机**只有 2 个实例**，都在下表（这是全部可得样本，不是抽样）：

| 实例目录名 | 加载器 | MC 版本 | mods | 客户端 jar | json 字节 / sha256 前16 |
| --- | --- | --- | --- | --- | --- |
| `All in One [Modded One Block]` | **forge** `1.16.5-36.2.34` | **1.16.5** | **113** | 同名 jar 17,547,153 B | 53,035 / `bc960905843e71b7` |
| `Immersed With Shaders` | **fabric**（`net.fabricmc:sponge-mixin`） | **1.21** | **68** | 同名 jar 26,836,080 B | 57,341 / `b836849b3f3bb73d` |

- 读法：**事实** 来自逐字读版本 json（`clientVersion` + `libraries`）。
  这两个 json 都**没有 `inheritsFrom`**（PCL 导出的合并版），走的正是 `clientVersion` 那条回退分支。
- ⚠ **未验证**：`forge/1.16.5` 实例上**跑过静态采集**（见下表 0.47 s / 114 jar 的实测），
  但**没有在该实例上装过探针**（本机没有 forge 1.16.5 的探针构建 ⇒ 真缺口 B5）。

## 2. 探针构建（`.work/dist/`，4 个）

| jar | 字节 | sha256 前16 | 声明范围（**实测**读自包内元数据） | 三态 |
| --- | --- | --- | --- | --- |
| `modmind-probe-fabric-1.21-1.0.0.jar` | 38,283 | `03274fada8920ef6` | `fabric.mod.json:depends.minecraft = "~1.21"` | `1.21`=**matched**；`1.21.x`=**unverified** |
| `modmind-probe-forge-1.20.1-0.2.0.jar` | 34,628 | `37498756c796c5b7` | `mods.toml` → minecraft `[1.20.1]`、forge `[47,48)` | `1.20.1`=matched |
| `modmind-probe-forge-1.20.1-0.9.2.jar` | 34,579 | `c273b170e9c9539e` | 同上 | 同上（**版本序更旧**，用于"按数值取最大"的回归） |
| `modmind-probe-forge-1.20.1-1.0.0.jar` | 34,628 | `7bb314f47d3510c1` | 同上 | 同上（**当前会被选中**的那个） |

★ **实测纠正一处易错理解**：forge 探针的 minecraft 范围是 **`[1.20.1]`（精确区间）**，
**不覆盖 1.20.4** ⇒ `probeJarFor('forge','1.20.4')` 返回 **null 是对的**。
真正"范围命中但未构建"的例子是 **fabric `~1.21` → `1.21.4` = unverified**。
（本轮我第一版断言把这两者写反了，被自己的实测数据证伪 —— 见 DECISIONS D-007。）

## 3. 游戏内探针产物（`.work/probe-01/.modmind/probe/pull2/`）

- 规模：**117 个文件**；`index.json` 声明 **28 页**；每页 4 张纯色背景截图（magenta/black/gray/white）。
- 关键文件哈希（实测）：

| 文件 | 字节 | sha256 前16 |
| --- | --- | --- |
| `index.json` | 1,756,511 | `c8925d880f7ebce6` |
| `items-meta.json` | 1,671,565 | `e7d18812a9488ac1` |
| `creative-tabs.json` | 1,571,300 | `8087ca6914fc338e` |
| `page-000-bg0-magenta.png` | 1,271,920 | （未逐张记；共 28×4 张） |

- 用途：`pull:importProbe` 的**真实**输入。已实测切图结果：**2 页 → 1330 条 / 48px 图标 / 3 像素每纹素 / 残差 worst=34.09（阈值 16，超差 7 个）/ 4.0 s**。
- ⚠ **未验证**：28 页全量导入（测试只跑 2 页）。残差 **worst 34.09 > 阈值 16** ⇒
  这是"残差判据在工作"的正面证据，但**超差 7 个是否可接受没有结论**，不得当成通过。

## 4. 注册表与派生素材

| 样本 | 字节 | sha256 前16 | 备注 |
| --- | --- | --- | --- |
| `.work/gencmp/m2-registry.json`（完整注册表） | 44,448,047 | `cd570a25f4b5af24` | ⚠ **mtime 显示 1980-01-01**（非正常时间戳，疑为拷贝/占位所致）；用作"解析 44 MB"的对照 |
| `.work/gencmp/registry-ids.json`（侧车） | 292,195 | `7174e70add213c6c` | 9,374 条 id；`sourceMtime` 需与注册表对齐（已加入断言 ⑦e） |
| `preview/data/atlas.png` | 2,655,187 | `8ef1d2bf3611d9ab` | 4096×4096 Minecraft 派生图集 ⚠ **禁止入包** |
| `preview/data/assets.js` | 2,970,293 | `b0ead609f120e088` | `window.__ASSETS__`（blockstates + 模型）⚠ **禁止入包** |
| `app/data/items.json` | 1,883,033 | `5aed7894424272f3` | 采集产物（`DATA_DIR` 默认值指向这里）⚠ **禁止入包** |
| `app/data/items.js` | 1,865,457 | `7a6f7e0140e0bc49` | 同上 |

**"禁止入包"的可复算判定**：在 `.mmfeature` 的 `renderer.js` 里搜 `data:image/png;base64`，
命中数必须为 **0**（2026-10-12 实测 `mc-preview-1.14.11` = **0**）。

## 5. 交付物（`.mmfeature`）—— 完整台账见 `tests/fixtures/ledger/packages.json`

| 包 | 字节 | sha256 前16 | 条目 | 已装 |
| --- | --- | --- | --- | --- |
| `mc-pull-1.12.0.mmfeature` | 42,868 | `5aac106a783b08bf` | 4 | ✅ |
| `mc-preview-1.14.11.mmfeature` | 194,060 | `c2cef8200d287609` | 5 | ✅ |

共 **34 个** `.mmfeature` 已登记；**包内 `files{路径:sha256}` 逐条复算 0 处不符**；
原件备份在 `tests/fixtures/backup/`（文件名带 sha8）。

---

## 6. **没有**的样本（不得据推测声称支持）

| 版本组（规范 §6.2） | 本机样本 | 状态 |
| --- | --- | --- |
| 1.0–1.6.x（最早历史） | **无** | `UNVERIFIED` |
| 1.7.x–1.8.x（传统资源布局） | **无** | `UNVERIFIED` |
| 1.9–1.12.2（旧数字 ID / metadata / terrain.png） | **无** | `UNVERIFIED` |
| 1.13–1.16.x（扁平化后） | **有**：forge 1.16.5（113 mod） | 静态采集**已验证**；探针**未验证** |
| 1.17–1.20.4 | **无实例** | `UNVERIFIED`（但有 `forge/1.20.1` 探针构建） |
| 1.20.5–1.21.x | **有**：fabric 1.21（68 mod） | 待采集实测（本轮未在这台上跑） |
| NeoForge / Quilt | **无** | `UNVERIFIED`（无实例、无探针构建） |
| 快照/预发布 | **无** | `UNVERIFIED`（且规范要求单列实验通道） |
| Mod 类别 M0–M4 | 有 113+68 个 jar，**未按 M0–M4 分类** | `UNVERIFIED`（规范 §7.2 的分类尚未做） |
