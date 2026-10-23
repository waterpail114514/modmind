// src/asset-id.mjs —— `asset_id` 的**唯一**实现（设计稿 `docs/design/data-contract.md` §1.2）
//
// ## 为什么要有它
// 今天有 4 套"物品/方块表"（探针产物 / 数据包 items.json / 注册表 / 注册表侧车），它们靠
// **数组下标**互相对齐 —— 下标是**位置**不是**身份**：任何一次过滤/排序都会让它变义。
// B10 就是这么错的（`maxStack` 与 `ids` 语义错位，18,266 条里 17,384 条 maxStack 为 0 而石头本该是 64）。
// `asset_id` 要做的是：**同一件东西在任何一份数据里都是同一个字符串**。
//
// ## 规则（设计稿 §1.2，逐条对应）
//   asset_id := <namespace>:<path>[<state>][#<nbt-hash>]
//     · 物品：minecraft:stone
//     · 方块：minecraft:oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]
//         - 属性按**字母序**排列，`,` 分隔、`=` 连接，**不留空格**
//         - 缺省属性**必须显式写出**（不做"省略即默认"的推断 —— 那会让同一状态有两种写法）
//     · 带 NBT：minecraft:chest#<sha256 前 16>
//
// ## 判据纪律
// · `normalizeAssetId` 对**非法输入抛错**（§0.6：不得静默丢弃/回退）；容忍式的是 `tryNormalize`。
// · **归一化必须真的在做功**：`[half=top,facing=east]` 与 `[facing=east,half=top]` 必须得到同一串，
//   而这**不能靠"反正输入都合规"来自证** —— 测试里有专门的变异用例（乱序 / 大小写 / 空格）证明它在归一。

/** 命名空间与路径的合法字符（沿用 Minecraft `ResourceLocation` 的规则：**全小写**）。 */
const NS_RE = /^[a-z0-9_.-]+$/
const PATH_RE = /^[a-z0-9_/.-]+$/
const NAME_RE = /^[a-z0-9_.-]+$/
const HASH_RE = /^[0-9a-f]{16}$/

/** 完整 asset_id 的形态判据（与设计稿 §1.2 的正则逐字一致）。 */
export const ASSET_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+(\[[a-z0-9_]+=[a-z0-9_.-]+(,[a-z0-9_]+=[a-z0-9_.-]+)*\])?(#[0-9a-f]{16})?$/

export function isValidAssetId(s) {
  return typeof s === 'string' && ASSET_ID_RE.test(s)
}

/**
 * 把属性对象归一化成 `[a=b,c=d]`（**字母序、无空格**）。
 * 传空对象/undefined ⇒ 返回 ''（不带方括号）—— 这与"空状态表"不同：
 * `oak_stairs[]` 是**非法写法**（见下面 parse 的判据）。
 */
export function normalizeState(state) {
  if (state == null) return ''
  const keys = Object.keys(state)
  if (!keys.length) return ''
  for (const k of keys) {
    if (!NAME_RE.test(k)) throw new Error('asset_id 属性名非法：' + JSON.stringify(k))
    const v = state[k]
    if (typeof v !== 'string' || !NAME_RE.test(v)) {
      throw new Error('asset_id 属性值非法（' + k + '=' + JSON.stringify(v) + '）：属性值必须是小写字符串')
    }
  }
  return '[' + keys.slice().sort().map((k) => k + '=' + state[k]).join(',') + ']'
}

/** 由部件拼出 asset_id（**不**做"省略属性"的推断）。 */
export function makeAssetId({ ns, path, state, nbtHash } = {}) {
  if (!NS_RE.test(String(ns || ''))) throw new Error('asset_id 命名空间非法：' + JSON.stringify(ns))
  if (!PATH_RE.test(String(path || ''))) throw new Error('asset_id 路径非法：' + JSON.stringify(path))
  const st = normalizeState(state)
  const h = nbtHash == null || nbtHash === '' ? '' : '#' + String(nbtHash)
  if (h && !HASH_RE.test(String(nbtHash))) throw new Error('asset_id 的 nbt 哈希必须是 16 位小写十六进制：' + JSON.stringify(nbtHash))
  const id = String(ns) + ':' + String(path) + st + h
  if (!isValidAssetId(id)) throw new Error('拼出的 asset_id 不合规：' + id)
  return id
}

/**
 * 解析 asset_id。非法返回 `null`（调用方自己决定是抛还是跳过）。
 * ★ 判据：`minecraft:oak_stairs[]`（空属性表）**非法** —— 它和 `minecraft:oak_stairs` 是两种写法表达同一件事，
 *   允许它就等于允许"同一状态两种身份"。
 */
export function parseAssetId(s) {
  if (typeof s !== 'string' || !s) return null
  let rest = s
  let nbtHash = null
  const hi = rest.indexOf('#')
  if (hi >= 0) {
    nbtHash = rest.slice(hi + 1)
    rest = rest.slice(0, hi)
    if (!HASH_RE.test(nbtHash)) return null
  }
  let stateStr = null
  let state = null
  const bi = rest.indexOf('[')
  if (bi >= 0) {
    if (!rest.endsWith(']')) return null
    stateStr = rest.slice(bi + 1, rest.length - 1)
    rest = rest.slice(0, bi)
    if (!stateStr) return null                       // ← `x[]` 非法
    state = {}
    for (const kv of stateStr.split(',')) {
      const eq = kv.indexOf('=')
      if (eq <= 0 || eq === kv.length - 1) return null
      const k = kv.slice(0, eq)
      const v = kv.slice(eq + 1)
      if (!NAME_RE.test(k) || !NAME_RE.test(v)) return null
      if (Object.prototype.hasOwnProperty.call(state, k)) return null   // 重复属性名非法
      state[k] = v
    }
  }
  const ci = rest.indexOf(':')
  if (ci <= 0) return null
  const ns = rest.slice(0, ci)
  const path = rest.slice(ci + 1)
  if (!NS_RE.test(ns) || !PATH_RE.test(path)) return null
  return { ns, path, state, stateStr, nbtHash }
}

/**
 * 归一化：**排序属性**、去掉非法写法带来的差异。
 * 非法输入 ⇒ **抛错**（带原文），不做"尽力而为"（§0.6）。
 */
export function normalizeAssetId(s) {
  const p = parseAssetId(s)
  if (!p) throw new Error('不是合法的 asset_id：' + JSON.stringify(s))
  return makeAssetId({ ns: p.ns, path: p.path, state: p.state, nbtHash: p.nbtHash })
}

/** 容忍式：拿不到就 null（给"批量转换 + 统计失败数"的场景用，**必须把 null 数报出来**）。 */
export function tryNormalizeAssetId(s) {
  try {
    return normalizeAssetId(s)
  } catch {
    return null
  }
}
