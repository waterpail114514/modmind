// src/blockstate.mjs —— blockstate 解析 + **multipart 合并规则**（设计稿 §5、§9 未决 5）
//
// ## 这个模块要解决的唯一问题
// `assets/<ns>/blockstates/<name>.json` 有两种写法，**能给的信息量不同**：
//
//  ① `variants`：键就是**完整状态**，例如
//        "facing=east,half=bottom,shape=inner_left": { "model": ... }
//     ⇒ 键的个数**就是**状态总数，属性与取值域也都是完整的。
//
//  ② `multipart`：把模型拆成若干部件，每个部件带一个 `when` 条件，而 `when` 是
//     **部分约束** —— 它只说"这个部件在什么条件下出现"，从来说过"一共有多少种状态"，
//     也没说过"这个方块的完整属性集合是什么"。
//
// ## ★★ 核心规矩：**两个方向都不许过度声称**
//
// **① 不给状态总数。**
//   · `variants` ⇒ `stateCount` = 键的个数（**真实**）；
//   · `multipart` ⇒ `stateCount === null` + `stateCountReason`。
//     此时只给"观察到的取值"与 `upperBound`（笛卡尔积**上界**，**明确不是**状态数）。
//   · 为什么：把部分约束当状态数报出去是**假精确**，比"不知道"更坏 —— 下游会拿它去算覆盖率、分配资源。
//
// **② 也不给"完整取值域"。** 这一点是实测**改正**过来的（我第一版把它叫"取值域"，是过度声称）：
//   · 实测（`tools/probe-multipart-domain.mjs`，可复跑）：
//       - 67 个 multipart 文件里，**33 个（49.3%）含"没有 `when` 的部件"**
//         ⇒ 那部分对所有状态都适用，它的取值**根本没被记录**；
//       - 与注册表（运行时真值）对照 66 个可对照的，**57 个属性集合不一致**：
//         `acacia_fence` 少了 `waterlogged`、`bamboo` 少了 `stage`、`andesite_wall` 少了 `waterlogged`…
//     ⇒ 从 `multipart` 推出来的是「**出现过的**属性与取值」，可能**既不完整也没有上界保证**。
//   · ⇒ 用 `domainComplete` 显式区分：`variants` = `true`；`multipart` = **`false`**。
//
// ## multipart 的合并规则（本模块就是它的定义处）
//   · `when` 是**合取**：`{"east":"side","north":"none"}` = east 是 side **且** north 是 none；
//   · `{"OR": [a, b]}` = 析取；`{"AND": [a, b]}` = 合取；
//   · 值里 `"a|b"` = 多个允许值；`"*"` = 任意值 ⇒ **不计入**（记了会让下游以为"这个值是对的、且只有这些"）；
//   · 属性/取值 = 所有分支里**出现过**的具体值之并集，并逐属性标注来源
//     （`variants` 推出来的 vs 只在 `multipart` 里露过面的）。
//   · **本模块不给"合并后的状态集合"** —— 那需要读 `models/` 与代码侧规则（成本高，且未验证），
//     在没有把握之前**宁可只给界**。
import fs from 'node:fs'

/** `when` 里的取值语法：`"a|b"` = 多值；`"*"` = 任意（不计入）。
 *  ★ `tag` 必须由调用方给：第一版我把它写死成 `'multipart'`，结果从 `variants` 推出来的属性
 *    也带上了 `multipart` 标记 ⇒ `propertySource` 全变成 `mixed`（判据 ①d 抓到）。 */
function addValue(dom, src, key, raw, tag) {
  if (typeof raw !== 'string') return
  for (const v of raw.split('|')) {
    const t = v.trim()
    if (!t || t === '*') continue                 // ★ `*` 不提供具体取值 ⇒ 不记
    if (!dom[key]) { dom[key] = new Set(); src[key] = new Set() }
    dom[key].add(t)
    src[key].add(tag)
  }
}

/** 递归吃 `when` 的各种形状：dict / list / str（`"a=b,c=d"`）；`OR`/`AND` 是关键字不是属性。 */
function walkWhen(node, dom, src, counters) {
  if (node == null) return
  if (typeof node === 'string') {
    for (const kv of node.split(',')) {
      const i = kv.indexOf('=')
      if (i > 0) addValue(dom, src, kv.slice(0, i).trim(), kv.slice(i + 1).trim(), 'multipart')
    }
    return
  }
  if (Array.isArray(node)) { for (const x of node) walkWhen(x, dom, src, counters); return }
  if (typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'OR') { counters.orBranches += Array.isArray(v) ? v.length : 1; walkWhen(v, dom, src, counters); continue }
    if (k === 'AND') { walkWhen(v, dom, src, counters); continue }
    if (v != null && typeof v === 'object') { walkWhen(v, dom, src, counters); continue }   // 嵌套（含未识别的关键字）
    addValue(dom, src, k, v, 'multipart')
  }
}

/**
 * 分析一个 blockstate JSON。
 *
 * 返回字段（**注意 `stateCount` 与 `domainComplete` 的语义**）：
 *   · `fidelity`       `'state.full'`（variants，可数）| `'state.partial'`（multipart，只有观察到的）| `'state.none'`
 *   · `stateCount`     ★ 只有 `state.full` 才给数字；其余**恒为 `null`**
 *   · `stateCountReason` 为什么是 null / 数字从哪来（给下游和日志用）
 *   · `properties`     **出现过的**属性取值（multipart 下**不完整**，见 `domainComplete`）
 *   · `domainComplete` ★ 只有 variants 为 `true`；multipart 为 `false`（实测 57/66 与真值不一致）
 *   · `propertySource` 每个属性是从 `variants` 还是 `multipart` 观察到的（可分辨可信度）
 *   · `upperBound`     笛卡尔积**上界**（**不是**状态数；multipart 下可能远大于也可能相等）
 *   · `nakedParts`     ★ 没有 `when` 的部件数（>0 就意味着取值一定不完整）
 */
export function analyzeBlockstate(bs) {
  const out = {
    fidelity: 'state.none',
    properties: null,
    propertySource: null,
    domainComplete: false,
    stateCount: null,
    stateCountReason: '',
    upperBound: null,
    variantsKeys: 0,
    multipartParts: 0,
    nakedParts: 0,
    orBranches: 0,
    warnings: [],
  }
  if (!bs || typeof bs !== 'object') {
    out.stateCountReason = '不是对象 ⇒ 无状态信息'
    out.warnings.push('输入不是 blockstate 对象')
    return out
  }

  const dom = {}          // key → Set(values)
  const src = {}          // key → Set('variants' | 'multipart')
  const counters = { orBranches: 0 }

  // ① variants：键 = 完整状态 ⇒ 状态数与取值域**都可数/完整**
  const variants = bs.variants
  if (variants && typeof variants === 'object' && Object.keys(variants).length) {
    const keys = Object.keys(variants)
    out.variantsKeys = keys.length
    for (const key of keys) {
      if (key === '') continue                        // 空键 = "单状态、无条件"（合法写法）
      for (const kv of key.split(',')) {
        const i = kv.indexOf('=')
        if (i <= 0) continue
        const k = kv.slice(0, i).trim()
        addValue(dom, src, k, kv.slice(i + 1).trim(), 'variants')
      }
    }
    out.fidelity = 'state.full'
    out.domainComplete = true
    out.stateCount = keys.length
    out.stateCountReason = '来自 variants 的键——每个键就是一个完整状态，所以键数**就是**状态数'
  }

  // ② multipart：`when` 只是部分约束 ⇒ 状态数**不给**、取值域**不完整**
  const mp = bs.multipart
  if (Array.isArray(mp) && mp.length) {
    out.multipartParts = mp.length
    out.nakedParts = mp.filter((p) => !p || typeof p !== 'object' || !('when' in p)).length
    for (const part of mp) {
      if (part && typeof part === 'object' && 'when' in part) walkWhen(part.when, dom, src, counters)
    }
    out.orBranches = counters.orBranches
    if (out.fidelity !== 'state.full') {
      out.fidelity = Object.keys(dom).length ? 'state.partial' : 'state.none'
      out.domainComplete = false
      out.stateCount = null
      out.stateCountReason = '这条 blockstate 用的是 multipart：`when` 只是**部分约束**，'
        + '它从没说过「一共有多少种状态」⇒ **不给状态总数**（给了就是假精确）'
      if (out.nakedParts > 0) {
        out.warnings.push('有 ' + out.nakedParts + ' 个部件没有 `when`（对所有状态都适用）'
          + ' ⇒ 它们的取值没被记录，下面的属性/取值**一定不完整**')
      }
      if (out.fidelity === 'state.none') out.warnings.push('multipart 里没有可提取的具体取值')
    } else {
      out.warnings.push('同时存在 variants 与 multipart：状态数与取值域以 variants 为准（两者不叠加）')
    }
  }

  const pkeys = Object.keys(dom)
  if (pkeys.length) {
    out.properties = {}
    out.propertySource = {}
    for (const k of pkeys.slice().sort()) {
      out.properties[k] = Array.from(dom[k]).sort()
      const s = src[k] || new Set()
      out.propertySource[k] = s.size > 1 ? 'mixed' : (s.values().next().value || 'unknown')
    }
    let ub = 1
    for (const k of pkeys) ub *= Math.max(1, out.properties[k].length)
    out.upperBound = ub
  }

  if (!out.stateCountReason) {
    out.stateCountReason = pkeys.length
      ? '没有 variants 也没有可用的 multipart ⇒ 只知道出现过的取值，不知道状态总数'
      : '没有任何状态信息（可能是空 models 引用）'
  }
  return out
}

/** 从磁盘读并分析（**只做这一个 IO**）。 */
export function analyzeBlockstateFile(file) {
  return analyzeBlockstate(JSON.parse(fs.readFileSync(file, 'utf8')))
}

/**
 * 把结果压成给下游用的**可判定**形态。
 *
 * ★ 关键：multipart 下**两个方向的界都不是真值** ——
 *   属性/取值是「**至少**观察到这些」（下界，可能漏），
 *   笛卡尔积是「**至多**这么多组合」（上界，可能多）。
 *   任何要"声称覆盖率"的地方都必须先看 `kind`：`domain-only` 时**不许**算比例（分母未知）。
 */
export function describeCoverage(r) {
  if (r.fidelity === 'state.full') {
    return { kind: 'countable', stateCount: r.stateCount, domainComplete: true, note: '状态数与取值域都可数（variants）' }
  }
  if (r.fidelity === 'state.partial') {
    return {
      kind: 'domain-only',
      stateCount: null,
      domainComplete: false,
      observedProperties: r.properties ? Object.keys(r.properties).length : 0,
      upperBound: r.upperBound,
      note: '只知道**观察到**的属性取值（可能漏），不知道状态总数 ⇒ 不得据此声称覆盖率。'
        + '`upperBound`（' + r.upperBound + '）只是笛卡尔积**上界**，既不等于状态数、也不保证是紧的'
        + (r.nakedParts ? '；且有 ' + r.nakedParts + ' 个部件没有 when ⇒ 取值一定不完整' : ''),
    }
  }
  return { kind: 'none', stateCount: null, domainComplete: false, note: '没有状态信息' }
}
