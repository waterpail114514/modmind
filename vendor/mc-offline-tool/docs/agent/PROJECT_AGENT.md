# PROJECT_AGENT.md —— 给智能体的工程说明（进这个仓库先读这一页）

配套文档（按需要展开，不要一次全读）：
- `docs/audit/initial-audit.md` —— Phase 0 审计（架构、契约、路径风险、能力边界、问题清单）
- `docs/agent/STATUS.md` —— 当前进度与下一步（**每轮必更新**）
- `docs/agent/DECISIONS.md` —— 有取舍的决策及理由
- `docs/compatibility/test-fixtures.md` —— 可用的真实样本（版本 / 加载器 / 哈希）
- `E:/mc/评审文档/00-规则与索引.md` —— 评审文档索引（有 `check-index.py` 守卫）

---

## 1. 这是什么

Minecraft Java 版**全版本资源采集 + 3D 建筑编辑**工具，以 **ModMind feature 形态**交付。
三个组成 + 一个可选件：

| 件 | 职责 | 源码位置 |
| --- | --- | --- |
| **mc-pull** | 采集 / 解析 / 索引 / 诊断 | `pull-feature/backend/main.js`（后端）+ `pull-feature/src/feature-entry.jsx`（渲染器） |
| **mc-preview** | 3D 预览 / 编辑 / 材料统计 / 导入导出 | ★ **跨两目录**：`preview/`（应用源）+ `preview-feature/`（包壳） |
| **Runtime Probe** | 可选游戏内 Java 探针 | `probe/fabric-1.21/`、`.work/probe-src/`（Forge） |
| MC Asset Core | 统一资产库（**尚未实现**，见 Task 3/4） | 规划中 |

---

## 2. 铁律（违反就是在做错事）

1. **先检查，再决策，再改代码。** 不在没读宿主契约 / 构建链 / 既有功能前重写任何东西。
2. **真实实现优先。** 不用 TODO、空函数、硬编码示例、假进度、伪造数据、只在 UI 显示成功来冒充完成。
3. **失败必须可见。** 不支持格式 / 未知字段 / 损坏资源 / 缺失依赖 / 未实现能力 ⇒ 明确诊断，**不得静默丢弃、不得伪报成功**。
4. **保留现有价值。** 先保住 ModMind 入口、manifest、action handler 与已工作的功能。改契约前先查调用方。
5. **兼容性必须有证据。** "支持某版本/某 Mod" = 测试样本 + 步骤 + 结果。
   **不得把"发现文件"说成"模型可正确渲染"，不得把"可导入"说成"无损"。**
6. **不假设用户环境。** 禁止把 `E:/...` / 用户目录 / 某实例路径当唯一默认路径。
7. **绝不捏造执行结果。** 没跑的测试写"未运行"；没取得的版本写"未验证"。
8. **一次聚焦一个可验收目标。** 先交付最小完整切片，再扩版本与 Mod 覆盖。

---

## 3. 构建 / 安装 / 回滚（可复现）

```bash
# 构建（一条命令出包，带自校验：源码 lint / 条目数 / manifest 声明式校验 / handler 对账 / 逐条目哈希）
node pull-feature/build/build-feature.mjs         # → pull-feature/dist/mc-pull-<ver>.mmfeature
node preview-feature/build/build-feature.mjs      # → preview-feature/dist/mc-preview-<ver>.mmfeature
```
- **安装**：解包覆盖 `%APPDATA%\modmind\feature-plugins\<id>`（脚本在 `*/.work/install-*.py`）。
  安装脚本**先整目录备份**已装版本到 `*/.work/installed-backup-<旧版本>/`，再逐条目 sha256 比对。
- **回滚**：把 `installed-backup-<旧版本>/` 覆盖回去即可；旧包另归档在 `E:\AI工作台\功能包\历史版本\我方构建\`（不删）。
- **台账 / 原件备份**：`python tests/baseline/make-ledger.py`
  → `tests/fixtures/ledger/packages.json` + `tests/fixtures/backup/`（备份名带 sha8）。

★ **改前端只改 `preview/`**：`renderer.js` / `dom-template.generated.js` / `css.generated.js` / `*.dist`
都是**产物**，手改会在下次构建时被覆盖。
（`preview-feature/build/build-feature.mjs` 会从 `preview/index.html` 抽 `#app` 标记、从 `preview/app.css` 抽样式，
并对 CSS 做两处必要改写：`:root{`→`:host{`、`height:100vh`→`height:100%`。）

---

## 4. 测试与闸门

| 对象 | 位置 | 规模 |
| --- | --- | --- |
| **统一基线入口** | `tests/baseline/run-baseline.py` | 一条命令跑完，结果写 `last-baseline.json` |
| 假宿主闸门 | `preview-feature/.work/serve-feature.mjs`（服务器）+ `preview/.work/gate102lib.py`（无头 Edge 驱动） | 250+ 条断言 |
| Node 断言 | `pull-feature/.work/test-*.mjs`、`preview-feature/.work/test-feature-backend.mjs` | 7 套 / 143 条 |
| 变异套件 | `preview/.work/mutate-*.py` | 十几套，每套 2–9 个变异 |
| 多宽度体检 | `preview/.work/check-pop.py` | 6 个宽度 |
| 台账与归因 | `tests/baseline/make-ledger.py`、`diff-stale-tests.mjs`、`probe-import-behavior.mjs` | — |

**闸门写法的约定（踩过坑，别改）**：
- 闸门结果在无头 Edge 的 `<title>` 里；**必须走 `gate102lib`** 解析（它修了"统计头挤在第一条断言里"的错位）。
- 变异测试的断言必须**能证伪**：改前绿 / 改后绿 / **只把目标改坏才红**。
  否则不是闸门，是装饰。
- `node --check` **不校验正则字面量**（`\]` 被吃掉也报通过）⇒ 语法闸门一律用 `esbuild.transformSync`。
- Node 子进程**不要用 `execFileSync`**（沙箱里 EBUSY，pid 0）⇒ 用 Python `subprocess.run([node, ...])` 编排。

---

## 5. 已知硬边界（不要对外宣称能做的事）

1. **没有离线渲染器。** `src/build-icons.mjs` 是"把探针在游戏内截的整页截图（4 种纯色背景）逐像素回归解 alpha"的**后处理器**，
   整条链路依赖"已在游戏里渲染过一次"。
2. **mod 的代码属性拿不到**（堆叠上限 / 最大耐久 / 是否方块 / 是否可损坏 / 创造页归属）—— 写在代码里，jar 的 `data/` 里没有。
   **现状基础版把 `maxStack` 全填 64、`damageable` 全填 false（占位值）** ⇒ 这是 B1，必须让用户看得见"这是未知"。
3. **模型只做"贴图直烤"**：不做 layer 叠加、不做 tint、方块物品不是 3D 外观；找不到贴图的条目**整条丢弃并计数**。
4. **探针构建覆盖是三态**：`matched` / `unverified`（可试装）/ 无。真缺口：`forge/1.16.5`（**用户本机就有**）、`forge/1.20.4`、`neoforge/1.21.1`。
5. **`1.20.5+` 官方 `--reports` 只有原版、不含 mod**（`items.json`/`blocks.json`/`registries.json`）。

---

## 6. 数据与法律边界

- **不得打包分发 Minecraft 原版资产**。默认从**用户本地实例**采集。
- 包内**不得**出现 `preview/data/`（`atlas.png` 等）或 `app/data/`（`items.json`/`icons/`/`font/`/`game/`）这类派生素材。
  判定方法可复算：在产物里搜 `data:image/png;base64` 必须命中 **0**。
- 第三方声明：`mc-preview` 包内 `assets/THIRD-PARTY.md` 声明 **deepslate 0.27.2（MIT, Misode）** 与
  **gl-matrix 3.4.4（MIT）**，附许可原文。**gl-matrix 版本已双证据核实**；**deepslate 版本串在 vendor 与产物里都读不到**
  （上游 UMD 不带 version 注释）⇒ 取信依据是声明 + 同源路径，**不得声称已从产物反查**。
- esbuild 的 `legalComments` 必须是 `'eof'`（`'none'` 会剥掉上游法律注释 —— 曾因此缺署名）。

---

## 7. 环境备忘

- Node：`C:\Users\z1520\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`
- esbuild：`tools/node_modules/esbuild`（本工具没有独立 npm 工程，从既有依赖里借）
- 无头浏览器：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- **所有工程文件放 E 盘**，不落 C 盘（临时脚本也放 `E:\AI工作台\.workbuddy\tmp`）。
- **本机没有可用的 ffmpeg**（PATH 里没有；自带的那个是精简构建，写不出 png、没有 `rawvideo`）。
  需要时可 `python -m pip install --target <E盘目录> imageio-ffmpeg`（注意：`-i 清华源` 会报 "No matching distribution"）。
