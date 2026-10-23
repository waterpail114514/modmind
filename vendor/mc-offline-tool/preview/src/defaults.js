// defaults.js —— 「裸方块名 → 默认态属性」的推导（**纯函数，服务端与浏览器共用**）。
//
// 为什么需要：MC 里写 `minecraft:oak_stairs` 表示它的**默认态**，而默认态在**方块注册表**里；
// 资源包（blockstates/*.json）只有 variants / multipart，**不含默认值**。
// 后果（都实测踩过）：
//   · 纯 multipart 的方块（如 `ae2:controller`，每个 part 的 when 都要求 state/type）在"无属性"时
//     **一个 part 都不匹配** ⇒ 模型与贴图都收不到 ⇒ 放上去什么都没有（材质全丢）；
//   · `oak_fence` 的四向在 JSON 里首项全是 `true`，而内核默认**全 false**；
//   · `oak_stairs` 的 variants 首键是 `shape=inner_left`，而默认是 `straight`。
// ⇒ 不能"取首项"，要按 MC 的默认值约定挑。
//
// 规则（优先级从高到低）：
//   ① 该属性有公认默认值（见 PREFER）且候选里存在 ⇒ 用它；
//   ② 取值域是 true/false ⇒ `false`（MC 的普遍约定）；
//   ③ 是数字 ⇒ `'0'`；
//   ④ 否则取第一个取值。
// variants：对**每个键**按上面打分（键里每个属性对上得 0 分、没对上 1 分），取分数最低的键。
// multipart：把各 part 的 when 里每个属性按上面的规则并起来（只填空缺的键）⇒ 与这些取值一致的 part 命中、
//   互相冲突的 part 自然不命中 —— 这正是"默认态"的样子（栅栏=只有柱子，控制器=offline/block）。
// 解析出的属性会**回传给前端**，前端带着它放置 ⇒ 与打包时选中的模型严格一致。
const PREFER = {
  facing: 'north', half: 'bottom', shape: 'straight', axis: 'y',
  part: 'foot', attachment: 'floor', rotation: '0', orientation: 'north_up',
  tilt: 'none', mode: 'compare', thickness: 'base', hinge: 'left', axisDirection: 'positive',
};
const isBool = (v) => v === 'true' || v === 'false';
const isNum = (v) => /^-?\d+$/.test(v);

/** 单个属性取哪个值 */
function pickValue(key, opts) {
  if (PREFER[key] && opts.includes(PREFER[key])) return PREFER[key];
  if (opts.every(isBool)) return 'false';
  if (opts.every(isNum)) return opts.includes('0') ? '0' : opts[0];
  return opts[0];
}
/** 一个 variant 键（`k=v,k2=v2`）的分数：没有落在默认值上的属性各算 1 分 */
function keyScore(key) {
  const pairs = String(key || '').split(',').map((s) => s.trim()).filter(Boolean)
  let score = 0
  for (const p of pairs) {
    const eq = p.indexOf('=')
    if (eq <= 0) { score += 1; continue }
    const k = p.slice(0, eq).trim(), v = p.slice(eq + 1).trim()
    if (PREFER[k] === v) continue
    if (isBool(v) && v === 'false') continue
    if (isNum(v) && v === '0') continue
    score += 1
  }
  return score
}

export function defaultPropsOf(bs) {
  const out = {}
  if (bs && bs.variants) {
    const keys = Object.keys(bs.variants)
    if (keys.length) {
      let best = keys[0], bestScore = Infinity
      for (const k of keys) { const s = keyScore(k); if (s < bestScore) { bestScore = s; best = k } }
      for (const p of String(best).split(',').map((s) => s.trim()).filter(Boolean)) {
        const eq = p.indexOf('=')
        if (eq > 0) out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim()
      }
    }
  }
  const fromWhen = (when, depth = 0) => {
    if (!when || depth > 4) return
    for (const [k, v] of Object.entries(when)) {
      if (k === 'OR' || k === 'AND') { if (Array.isArray(v)) for (const w of v) fromWhen(w, depth + 1); continue }
      if (!(k in out)) out[k] = pickValue(k, String(v).split('|'))
    }
  }
  for (const part of (bs && bs.multipart) || []) fromWhen(part.when)
  return out
}
