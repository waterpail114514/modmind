# test-plan.md —— 测试计划与金字塔映射

- 依据：规范 §11.1（六层金字塔）、§11.3（质量门槛）
- 实测时间：2026-10-12
- 定位：本文件记录**现在有什么**、**对应金字塔哪一层**、**缺哪一层**。
  缺的层明确写"缺"，不因为"我们自建了变异体系"就声称已满足第 11 章。

---

## 1. 六层金字塔 × 现状映射

| 层（规范 §11.1） | 规范要求的内容 | 现状 | 位置 | 状态 |
| --- | --- | --- | --- | --- |
| **1 单元** | JSON 解析、ZIP 条目读取、NBT 解码、状态字符串解析、模型继承、哈希缓存 | ✅ 有：`test-range`(34) / `test-export-pack`(19) / `test-probe-config`(14) / `test-icon-encoder`(5) / `test-feature-backend`(16) | `pull-feature/.work/test-*.mjs`、`preview-feature/.work/` | **VERIFIED** |
| **2 组件** | 单个版本 adapter、单个格式 importer/exporter、资源引用解析 | ⚠ **部分**：格式导入导出**被集成测试覆盖**（`test-two-packages` ④⑤⑥），但**没有独立的 adapter 单测**；版本 adapter 尚未存在 | — | **部分 / 缺 adapter 层** |
| **3 集成** | `mc-pull → MC Asset Core → mc-preview` 真实端到端 | ⚠ **部分是**：`test-two-packages`(30) 走的是 `mc-pull → 产物 → mc-preview` 的**真链路**，但 **MC Asset Core 尚不存在** ⇒ 目前是"两包直连"而非"经核心" | `pull-feature/.work/test-two-packages.mjs` | **部分** |
| **4 回归** | 固定历史样本的输出**快照**、模型几何、材质引用、方块状态与材料数量 | ❌ **缺**：有"固定预期行为"（143 条断言），但**没有快照机制**（无 fixture 基线文件、无 golden 对比） | — | **缺** |
| **5 运行时** | 只对明确指定的游戏版本/加载器/Mod 样本执行 | ❌ **缺**：本机**从未在真机跑过探针**；探针产物是历史遗留的 `pull-01` | — | **缺（且需要用户操作）** |
| **6 性能** | 冷扫描、热扫描、模型解析、网格生成、内存峰值、取消响应 | ⚠ **只有零散数字**：采集 0.5 s（114 jar / 19732 贴图）、探针切图 4.0 s（2 页）——**没有记录硬件、样本大小、冷/热条件** | — | **不符合 §11.3 的报告口径** |

### 规范 §11.1 要求但完全为空的三项

1. **快照回归**（第 4 层的核心手法）
2. **取消响应**（第 6 层；`pull:cancel` 有实现但无测试）
3. **内存峰值**（第 6 层）

---

## 2. 现有测试的**实际强项**（不要因为"不符合金字塔"就低估）

规范化金字塔之前，这个工程已有的体系强在**能证伪**：

| 手段 | 位置 | 强在哪 |
| --- | --- | --- |
| **假宿主闸门**（250+ 断言） | `preview-feature/.work/serve-feature.mjs` + `preview/.work/gate102lib.py` | 在**真浏览器**（无头 Edge）里复现宿主的 Shadow DOM + 经典 script 注入 + `featurePlugins.invoke` 契约；断言清单从 `<title>` 读出 |
| **变异测试**（十余套） | `preview/.work/mutate-*.py` | 判据是「改前绿 / 改后绿 / **只把目标改坏才红**」⇒ 能证明"这条断言真的在检测目标"，不只是"跑过了" |
| **多宽度体检** | `preview/.work/check-pop.py` | 6 个宽度，防"某个宽度下控件被挤出面板" |
| **归因差分**（本轮新增） | `tests/baseline/diff-stale-tests.mjs` | 把同一条断言打在不同版本上 ⇒ 判"某条红是不是本轮改坏的"，**不靠推断** |

---

## 3. 本轮新增的测试设施

| 文件 | 作用 | 覆盖 |
| --- | --- | --- |
| `tests/baseline/run-baseline.py` | **统一基线入口**：起假宿主 → 跑两包闸门 → 跑 7 套 Node 断言 → 写 `last-baseline.json`（含**器件指纹** sha256） | 一条命令全跑 |
| `tests/baseline/make-ledger.py` | 交付物台账：34 包 sha256 + 包内 `files{}` 自校验复算 + 同号不同物检测 + 原件备份 | 完整性 |
| `tests/baseline/diff-stale-tests.mjs` | 三版差分归因 | 归因 |
| `tests/baseline/probe-import-behavior.mjs` | `pull:importProbe` 行为观测（不判对错，只把真实返回/失败形态打出来） | 诊断 |
| `tests/fixtures/ledger/packages.json` | 台账数据 | — |
| `tests/fixtures/backup/` | 34 个原件备份（名字带 sha8） | 回滚 |
| `tests/fixtures/backup-tests/` | 2 个被修测试的**改前原件**（`*.orig.mjs`） | 可比对 |

**本轮实测总数**：Node 断言 **143 条**（34+19+25+14+30+5+16）全绿 + 浏览器闸门（见 `last-baseline.json`）。

---

## 4. 判据纪律（踩过的坑，写成硬规则）

这些不是风格偏好，每一条都对应一次实测事故：

1. **不许空跑假 PASS**：判绿必须同时满足「退出码 0 + FAIL 为 0 + **真的跑出了断言**（npass > 0）」
   —— 输入为空时 FAIL=0 会假绿。已内建在 `run-baseline.py`。
2. **不许只认一种输出格式**：实测三种汇总格式（`汇总：PASS n / FAIL m`、`结果：PASS n / FAIL m —— ALL OK`、
   `n/m ALL PASS`）。只认一种会**误判成"无统计头"⇒ 假红**。
3. **有 try/catch 回落的数据源必须断言"走了哪条路"**（source / 告警 / 计数三件套）。
4. **语法闸门用 `esbuild.transformSync`，不用 `node --check`** —— 后者**不校验正则字面量**
   （`\]` 被吃掉也报通过）。
5. **Node 子进程不用 `execFileSync`**（沙箱 EBUSY，pid 0）⇒ 用 Python `subprocess.run` 编排。
6. **断言媒体/内容"有"什么，必须直接看样本本身**，不能从"有该项"推"内容对"。
7. **变异测试的前置交互要容错**（`if (await locator.count()) …`），否则失败会表现为 30 s 超时而不是断言 FAIL，
   那就无法证明断言在检测目标。
8. **多文件变异：每轮 apply 前把"改过的所有文件"整体从备份重建** —— 只重建本变异涉及的文件时，
   上一轮在别的文件里的变异会残留并抢先触发旧断言。
9. **补丁幂等**：同一条命令可能被执行两次（沙箱提权重跑）⇒ 先判目标形态是否已存在再改。
10. **JS 里没有 Python 的 `'%s' % x`** —— 那会算成取模，打印 `NaN`（本轮又踩一次）。

---

## 5. 下一步要补的测试（按规范优先级）

1. **快照回归**（第 4 层）：给固定样本（两个真实例 + 4 个探针 jar）产出 golden 文件，
   与 `last-baseline.json` 里的数字一起作为改动闸门。
2. **adapter 单测**（第 2 层）：格式 adapter 独立后，每个 adapter 一个 `detect/read/validate/write/diagnostics` 用例。
3. **取消响应**（第 6 层）：`pull:cancel` 的响应时间与临时文件清理。
4. **性能报告口径**（§11.3）：记录硬件 + 样本大小 + 冷/热缓存；
   **不得**把"只扫 ZIP 中央目录"的时间说成全量解析性能（现在这个区分**已经在文案里做到了**，要保住）。
