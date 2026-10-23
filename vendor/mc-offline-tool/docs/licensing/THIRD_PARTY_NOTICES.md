# THIRD_PARTY_NOTICES.md —— 第三方组件、许可与依赖登记

- 依据：规范 §0.8（依赖和许可证先审查）、§2.3（不得仅靠文件名推断第三方清单完整）、§2.4（依赖及许可证清单）
- 实测时间：2026-10-12
- 记法：**事实** ＝ 本次实测；**推断** ＝ 由事实推出；**未验证** ＝ 没核到

★ **审计纪律**：规范 §2.3 明说「**不得仅依靠文件名推断第三方依赖清单完整**」。
所以本表每一条都标了**取信依据**（从产物反查 / 只读到声明 / 无声明），
**不接受"名字看起来对"当作证据**。

---

## 1. 随包分发的第三方（`mc-preview`）

| 组件 | 声明版本 | 许可 | 包内形态 | **取信依据** |
| --- | --- | --- | --- | --- |
| **gl-matrix** | **3.4.4** | MIT（Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV） | 内联进 `renderer.js`（与 `preview/vendor/gl-matrix.js` 同源） | ★ **双证据（事实）**：① 源文件里有 `@version 3.4.4`；② **产物** `renderer.js` 里 `'@version 3.4.4' in src` = **True** |
| **deepslate** | **0.27.2** | MIT（Copyright (c) 2021 Misode） | 内联进 `renderer.js`（与 `preview/vendor/deepslate.umd.cjs` 同源） | ⚠ **只能取信于声明 + 同源路径（未验证）**：`preview/vendor/deepslate.umd.cjs` 与产物 `renderer.js` **都读不到版本串**（上游 UMD 构建不带 version 注释）。**不得声称已从产物反查** |

- 包内许可文本位置：**`assets/THIRD-PARTY.md`**（两家的 MIT 全文都在，实测存在）。
- 许可文本是否随包**完整保留**：**是（事实）** —— 该文件是 `.mmfeature` 的 5 个条目之一，
  且已纳入台账的包内 `files{}` 自校验（复算一致）。
- `mc-pull` 包：**无第三方声明文件，也无第三方代码**（推断：包内仅自有代码；`dependencies: []`）。
  ⚠ **未验证**：未逐行比对确认"确实零第三方"，只是未发现。

### 1.1 一处已知的历史教训（已在包内自述）

`assets/THIRD-PARTY.md` 自述：此前包里放的是**与本包无关的承包方 AGPL-3.0 全文**，
而真正的 MIT 署名被 esbuild 的 `legalComments: 'none'` **剥掉了**（"放了不该放的、缺了该有的"）。
现已改为 `legalComments: 'eof'`（保留上游法律注释）+ 附许可原文。

★ **这条要固化成闸门**：构建后必须验证 `renderer.js` 里存在上游法律注释。
**现状**：`'@version 3.4.4' in renderer.js` = True（gl-matrix 注释在）；
deepslate 因上游不带 version 注释，只能用其他特征串（如 `@license` / `@author`）守护。
⚠ **尚未做成自动断言** ⇒ 列为待补（见 §5）。

---

## 2. 宿主提供的、**不随包分发**的组件

| 组件 | 说明 | 依据 |
| --- | --- | --- |
| **React** | 界面**复用宿主提供的 React**，包内**不另带副本** | `assets/THIRD-PARTY.md` 自述 + 假宿主 `serve-feature.mjs` 提供 `__modmindFeatureHost.React`（事实：假宿主确实要提供它） |
| ModMind 宿主运行时 | 本工程以 ModMind feature 形态运行（`apiVersion: 2` / `hostVersion: 1.5.0-plugintest` / `hostCapabilities: ["runtime"]`） | 两包 manifest 实测一致 |

---

## 3. 构建/测试期依赖（**不随包分发**）

| 组件 | 用途 | 位置 | 许可 |
| --- | --- | --- | --- |
| **esbuild** | 打包 `main.cjs` / `renderer.js`；本轮起兼作**语法闸门** | `tools/node_modules/esbuild`（从既有依赖里借，本工具无独立 npm 工程） | MIT |
| **Microsoft Edge**（无头） | 假宿主闸门 / 多宽度体检 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | 系统自带 |
| Node.js 22.22.2 | 运行时 | `C:\Users\z1520\.workbuddy\binaries\node\versions\22.22.2-6` | MIT 类 |
| Python 3.13.12 | 测试编排 / 补丁 / 台账 | 受管运行时 | PSF |

★ 这些**只出现在开发机**，不进入 `.mmfeature`。可复算：包内条目清单只有
`manifest.json` / `main.cjs` / `renderer.js` / `renderer.css`（mc-pull：4 条；mc-preview：5 条含 `assets/THIRD-PARTY.md`）。

---

## 4. 游戏资源与法律边界（★ 最重要的一节）

| 事项 | 结论 | 取信依据 |
| --- | --- | --- |
| Minecraft 原版资产是否随包分发 | **否** | ★ **可复算判定**：产物 `renderer.js` 里 `data:image/png;base64` 命中 **0**（2026-10-12 实测 `mc-preview-1.14.11`） |
| 采集策略 | **默认从用户本地实例采集**（规范 §4.2A） | `pull_run` 走 `local-assets`；实测 114 jar / 19732 贴图取自 `E:\mc\.minecraft` |
| 磁盘上存在但**禁止入包**的派生素材 | `preview/data/`（`atlas.png` 4096×4096 2.6 MB、`assets.js` 2.9 MB、`registry-*.json`）、`app/data/`（`items.json` 1.87 MB、`items.js`、`icons/`、`font/`、`game/`） | 实测这些文件**未出现在任何 `.mmfeature` 的条目清单里** |
| 版权归属 | Minecraft 内容版权属 **Mojang / Microsoft**；本工具**不授予游戏授权**，也**不含可启动的客户端** | 包内 `assets/THIRD-PARTY.md` 自述（既有表述，本轮核对其与实测一致） |
| 公开分发前 | 须自行核对相应资源的使用与再分发条款 | 同上 |

⚠ **未验证**：`app/data/font/` 与 `app/data/game/` 的具体内容与来源**未逐项核对**
（只列了目录名）。若其中含第三方字体，需单列许可。

---

## 5. 待补的自动断言（下一步）

1. **许可注释守护**：构建后断言 `renderer.js` 内含 gl-matrix 与 deepslate 的上游法律注释特征串
   —— 防 `legalComments` 被改回 `'none'` 而无声剥掉署名。
2. **禁止入包守护**：断言产物内 `data:image/png;base64` 命中数为 **0**，
   且包内条目清单**不包含** `atlas.png` / `assets.js` / `items.json` 等派生素材。
3. **deepslate 版本取证**：从上游 npm tarball 的哈希反查（需联网），或改为在 `THIRD-PARTY.md`
   里注明"版本按 vendor 文件同源推定，未从产物反查"（**诚实标注**优于假装已核）。

★ 前两条属"低风险、可逆、保守"的补充，按规范 §3.3 可直接实施，不必先问。
