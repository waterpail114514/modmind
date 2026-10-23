// src/provenance.mjs —— 来源优先级的**唯一**实现（设计稿 `docs/design/data-contract.md` §3）
//
// ## 为什么要有它
// 今天**没有任何优先级规则**，实际行为是"**谁最后写谁赢**"：
// `packs/<key>/items.json` 会被"免探针直读"覆盖，也会被"探针导入"覆盖，同 key 就直接换掉。
// 磁盘上真实存在两份语义不同的产物（`source: 'mc-pull local-assets …'` 与 `source: 'probe:pull2'`），
// 而**没有任何字段能机器判定谁更可信** —— B10 就是这么让"取错 API 的 maxStack"一路走到产物里的。
//
// ## 三条规则（设计稿 §3.2）
//   ① 同一 `(asset_id, key)` 有多个来源 ⇒ 取 **confidence 最大**者；
//   ② confidence 相同 ⇒ 取 `last_seen` **较新**者，并**记录落败来源**（便于事后追）；
//   ③ ★ **图标不适用"取最大"** —— 一张真渲染图与一张静态贴图不是"同一个值的两个来源"，
//      而是**两个不同的东西** ⇒ 必须**并存**，由使用者选（今天 `meta.json.fidelity` 是它的雏形）。
//
// ## 三条硬规矩
// · **不认识的 provenance 一律抛错**，不许"当成分数最低/最高"蒙过去（§0.6：不得静默回退）。
//   这条尤其重要：将来新加的来源如果被静默当成 0 分，它会**永远不生效且没人发现**。
// · ★ **分数 0 = 该来源对该字段"不可用"**，与"不提供该字段"一样**不参与竞争**。
//   依据设计稿 §3.2 的反例：拿掉探针产物后，属性必须回落成**未知（null）**，
//   **不许**回落到免探针路线猜的 `64`。若让 0 分参与竞争，就会悄悄变回"把未知当已知"。
//   区别在于：`不提供`（conf === null）与`不可用`（conf === 0）都要进 `losing`，**不能静默消失**。
// · **不在本模块里做 IO**：纯函数，输入候选、输出胜者 ⇒ 能被单测穷举（见 test-provenance.mjs）。
//
// ## 与产品的关系（★ 如实标注，别写成"已接线"）
// **状态：已实现、已被单测覆盖（`pull-feature/.work/test-provenance.mjs`，22 条），但尚未接入产品流程。**
// 为什么现在不接：产品当前**不会同时拿到同一 asset 的两个来源**（一次导入只有一个产物），
// 所以"冲突解决"暂时用不上；而硬接会改变行为 —— 例如 `resolveAttr(..., 'attr')` 会把
// ≤1.0.0 探针的产物判成 `unknown`（0 分 = 不可用），而产品当前契约为 `probe-mismapped`
// （要区分"来自旧探针"与"根本没有探针"）。**这一步（§10 第③步）的范围就是"纯函数 + 断言"**，
// 所以不造假接线：如实标为未接入。
// **接入点**（将来做"多来源合并"时）：当同一个 `pack key` 同时存在探针产物与免探针产物、
// 需要决定"这个字段用谁的"时，调 `resolveAttr()`；图标则一律用 `resolveIcons()` 取**全部**。
// ★ 自证"没被接线"的办法：`src/provenance.mjs` 不在任何打包入口的依赖图里 ⇒ 改它之后
//   重建 mc-pull 的 sha256 **必须不变**（这一条已写进自查脚本 `tests/baseline/self-audit.py`）。

/**
 * provenance 表：**唯一**的分数来源。
 * `conf` 按"字段类别"给分（设计稿 §3.2 的表）；不写 = 该来源不提供这类字段。
 * `conf: 0` = 该来源**明确不可用**（不是"分低"）——见文件头的硬规矩。
 * `verified` = 是否被实测验证过（`report.vanilla@1` 目前**未验证**，标出来别当已知）。
 */
export const PROVENANCE = {
  'probe.pull2@1': {
    label: '游戏内探针（1.1.0+，带 attrSemantics 自述）',
    conf: { name: 100, icon: 100, attr: 100 },
    verified: true,
    note: '字段语义已由 probe/srg-lookup.py 查证 + probe/verify-probe-jars.py 字节码差分 10/10',
  },
  'probe.pull2@0': {
    label: '游戏内探针（≤1.0.0，字段语义错位）',
    conf: { name: 100, icon: 100, attr: 0 },
    verified: true,
    note: 'maxStack 实为「最大耐久」（实测 18,266 条里 17,384 条为 0，而石头本该是 64）',
  },
  'local-assets': {
    label: '静态读实例 jar（免探针）',
    conf: { name: 60, icon: 70, attr: 0 },
    verified: true,
    note: '静态解析**拿不到**运行时属性（堆叠/耐久）—— 那是「未知」，不是「默认值」',
  },
  'langfile.zh_cn@1': {
    label: '语言文件（zh_cn）',
    conf: { name: 40 },
    verified: true,
    note: '只提供名字；注册表没有物品名，靠它凑',
  },
  'registry.default-state@1': {
    label: '注册表（只含默认态）',
    conf: { name: 50, blockId: 80, state: 30 },
    verified: true,
    note: '每块恒 1 个状态（实测 {1: 9374}）；state 只给 30 分，因为"非默认态"它给不出来',
  },
  'report.vanilla@1': {
    label: '官方 --reports（**未验证**）',
    conf: { name: 70, attr: 50 },
    verified: false,
    note: '★ 未验证：本机没跑通过这条路线，分数是设计值不是实测值 —— 用之前先实测',
  },
}

/** 认不出来的来源 ⇒ 抛错（不许静默当 0 分或满分）。 */
export function confidenceOf(prov, key) {
  const e = PROVENANCE[prov]
  if (!e) throw new Error('不认识的 provenance：' + JSON.stringify(prov) + '（可用：' + Object.keys(PROVENANCE).join('、') + '）')
  const c = e.conf && e.conf[key]
  return typeof c === 'number' ? c : null      // null = 该来源不提供这类字段（≠ 0 分）
}

/** 这条来源是否被实测验证过（清单里显式标出来的"未验证"要用得上，别当已知）。 */
export function isVerified(prov) {
  const e = PROVENANCE[prov]
  if (!e) throw new Error('不认识的 provenance：' + JSON.stringify(prov))
  return e.verified === true
}

/**
 * 解决一个**属性字段**的冲突。
 *
 * @param {{prov:string, value:*, lastSeen:string}[]} cands 候选（顺序**无关**，规则只按分数/时间）
 * @param {string} key 字段类别（'attr' | 'name' | 'icon' | 'state' | 'blockId'）
 * @returns {{value:*, provenance:string|null, confidence:number, losing:{prov:string,value:*,reason:string}[], reason:string}}
 *
 * ★ `value` 可以是 `null`（= 显式的"未知"）。**高分来源说"未知"能压过低分来源猜的值** ——
 *   因为"我知道它是未知"比"我猜了一个默认值"更可信（设计稿 §3.1 的核心要求）。
 */
export function resolveAttr(cands, key = 'attr') {
  const list = (cands || []).filter(Boolean)
  if (!list.length) {
    return { value: null, provenance: null, confidence: 0, losing: [], reason: '没有任何候选 ⇒ 未知' }
  }
  const all = list.map((c) => ({ ...c, conf: confidenceOf(c.prov, key) }))

  // ★ 三态必须分清：
  //   · `conf === null` ⇒ 该来源**不提供**这类字段；
  //   · `conf === 0`    ⇒ 该来源**不可用**（取错 API / 静态解析拿不到运行时属性）；
  //   · `conf > 0`      ⇒ 可用，参与竞争。
  //   0 分**不得参与竞争**，否则"删掉探针后属性回落成免探针猜的 64" —— 正是 §3.2 禁止的"把未知当已知"。
  const unusable = all.filter((c) => c.conf === 0)
  const scored = all.filter((c) => c.conf !== null && c.conf > 0)
  const whyUnusable = (c) => {
    const e = PROVENANCE[c.prov] || {}
    return { prov: c.prov, value: c.value, reason: '该来源对该字段不可用（分 0）' + (e.note ? '：' + e.note : '') }
  }
  if (!scored.length) {
    const noneProvides = all.every((c) => c.conf === null)
    return {
      value: null,
      provenance: null,
      confidence: 0,
      losing: unusable.map(whyUnusable),
      reason: noneProvides
        ? '候选都不提供「' + key + '」这类字段 ⇒ 未知'
        : '候选对该字段都不可用（分 0）⇒ **未知**（不回落到任何猜测值）',
    }
  }

  // ① 分数最大；② 同分取 lastSeen 较新；③ 仍同则按 prov 字典序（**确定性**：不让输入顺序影响结果）
  const sorted = scored.slice().sort((a, b) => {
    if (b.conf !== a.conf) return b.conf - a.conf
    const ta = String(a.lastSeen || ''), tb = String(b.lastSeen || '')
    if (ta !== tb) return tb < ta ? -1 : 1
    return a.prov < b.prov ? -1 : a.prov > b.prov ? 1 : 0
  })
  const win = sorted[0]
  const losing = sorted.slice(1).map((c) => ({
    prov: c.prov,
    value: c.value,
    reason: c.conf < win.conf ? ('分低 ' + c.conf + ' < ' + win.conf)
      : ('同分但 lastSeen 较旧（' + (c.lastSeen || '无') + ' < ' + (win.lastSeen || '无') + '）'),
  })).concat(unusable.map(whyUnusable))   // ← "不可用"的也要有人知道它来过（别静默消失）
  return {
    value: win.value,
    provenance: win.prov,
    confidence: win.conf,
    losing,
    reason: '取 ' + win.prov + '（分 ' + win.conf + '）' + (losing.length ? '，落败 ' + losing.length + ' 个' : ''),
  }
}

/**
 * 解决**图标**的冲突：**不做最大**，全部保留（设计稿 §3.2 规则③）。
 * 序按 confidence 降序、同分按 prov 字典序 ⇒ **确定性**（同一输入永远同一顺序）。
 */
export function resolveIcons(cands) {
  const list = (cands || []).filter(Boolean)
  const scored = list
    .map((c) => ({ ...c, conf: confidenceOf(c.prov, 'icon') }))
    .filter((c) => c.conf !== null && c.conf > 0)      // 0 分同样不可用（与 resolveAttr 一致）
  scored.sort((a, b) => (b.conf - a.conf) || (a.prov < b.prov ? -1 : a.prov > b.prov ? 1 : 0))
  return {
    // ★ 全部保留：真渲染图与静态贴图是**两个不同的东西**，不是同一个值的两个来源
    all: scored.map((c) => ({ provenance: c.prov, value: c.value, confidence: c.conf })),
    // ★ 候选对象里的字段叫 `prov`（不是 `provenance`）—— 我第一版写成 `scored[0].provenance`，
    //   结果 `preferred` 恒为 `undefined`；而 `JSON.stringify` 会**把 undefined 静默丢掉**
    //   （`Object.keys` 里有它、打印出来却没有），靠"看输出"很难发现 ⇒ 必须靠断言。
    preferred: scored.length ? scored[0].prov : null,
    reason: scored.length
      ? '并存 ' + scored.length + ' 张（按分数降序排列；preferred 只是「优先展示」，不是「唯一正确」）'
      : '没有任何图标',
  }
}

/** 给产物/日志用的一句话摘要。 */
export function summarizeResolution(r) {
  if (!r || !r.provenance) return '未知（' + ((r && r.reason) || '无候选') + '）'
  const e = PROVENANCE[r.provenance] || {}
  return r.provenance + '（' + (e.label || '?') + '，分 ' + r.confidence + '）'
}
