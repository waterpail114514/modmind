// statelogic.js —— 「方块状态推断」（连接 / 附着 / 朝向）。**纯函数**，浏览器与 node 共用。
//
// ---------------------------------------------------------------- 为什么需要它
// MC 的 blockstate JSON 只有 variants / multipart，**默认值在方块注册表里**（见 defaults.js 的说明）。
// 而"默认态"的语义是「孤立的、未连接的」—— 直接拿默认态去放，必然错：
//   · `oak_fence` 默认 north/south/east/west **全 false** ⇒ 一根孤柱，跟旁边的栅栏接不上；
//   · `glass_pane` / `iron_bars` 同上（那些"悬空的玻璃竖条"就是这个）；
//   · `stone_button` 默认 `face=wall, facing=north` ⇒ 贴在「北面的墙」上 —— 北边没墙就**浮在空中**。
// 游戏里这两类问题分别由 `Block.getStateForPlacement`（放置时按命中面定朝向）与
// `Block.updateShape`（邻居变化时重算连接）解决。**我们之前两步都跳过了** ⇒ 手摆的不完整方块全是错的。
//
// 本模块做的是**近似**推断，判据是"用户一眼看过去对不对"，不是"与游戏逐位一致"。
// 有意为之的近似都写在对应函数的注释里（免得后来人当成漏做）。
//
// 设计约束：**不硬编码方块清单**（只按"属性名 + 取值域/默认值"分类）⇒ mod 方块也能被正确推断。
//
// ---------------------------------------------------------------- 上下文对象（ctx）
// 所有推断函数收一个 ctx，把"外部世界"收进来，从而保持本模块是纯函数：
//   · `ctx.getAt(dx, dy, dz)` → `{id, props}` 或 `null`（越界/空气）
//   · `ctx.isOpaque(id)`      → 该方块是否在"不透明（完整）方块表"里
//   · `ctx.schemaOf(id)`      → `{属性名: [取值…]}`（来自 blockstates 的 variants/multipart），
//                              没有就返回 null —— 此时退回"按默认值猜"的兜底分类
//   · `ctx.growOnly`          → 只增不减（导入现成建筑时用）

/** MC 的四个水平方向（也是 fences/panes/bars/walls/vines/redstone 的连接属性名） */
export const SIDES = ['north', 'south', 'west', 'east'];

/**
 * 方向名 → 索引增量。
 * ★ 坐标约定（照抄 MC，不是照抄我们的渲染）：**北 = -Z，南 = +Z，西 = -X，东 = +X**。
 *   我们的世界 x/z 与 MC 同向（Deepslate 也这么用），所以这里能直接相加。
 */
export const DIRS = {
  north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0],
};

/** 法线 → 方向名（取绝对值最大的分量；命中法线是单位轴向量，不会歧义） */
export function dirNameOf(n) {
  if (!n) return null;
  const [x, y, z] = n;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 'east' : 'west';
  if (ay >= ax && ay >= az) return y >= 0 ? 'up' : 'down';
  return z >= 0 ? 'south' : 'north';
}

/** 水平方向（face='floor'/'ceiling' 时 facing 只能取这四个） */
const HORIZ = ['north', 'south', 'west', 'east'];

/**
 * 「连接族」——同族的方块互相连接（`oak_fence` 与 `spruce_fence` 能接上）。
 * 游戏里这是 `BlockTags.FENCES` / `BlockTags.WALLS` 之类标签；我们**没有 tag 数据**，
 * 用"基名后缀"近似：`*_fence` / `*_pane` / `*_bars` / `*_wall` 各成一族。
 * ⚠ 只认这四个族：`oak_fence_gate` 不以 `_fence` 结尾（是 `_fence_gate`）⇒ 天然不匹配 ✓（栅栏门不是连接型）。
 * 非连接族返回**完整短名** ⇒ 退化成"同 id 才互连"。
 */
export function familyOf(id) {
  const base = String(id || '').replace(/^[^:]*:/, '');
  for (const f of ['fence', 'pane', 'bars', 'wall']) {
    if (base === f || base.endsWith('_' + f)) return f;
  }
  return base;
}

/** 从 blockstates JSON 提取取值域：`{north:['false','true'], …}`（variants 键 + multipart 的 when） */
export function schemaOf(bs) {
  const out = {};
  const add = (k, v) => {
    if (!k) return;
    const vals = String(v).split('|').map((s) => s.trim()).filter(Boolean);
    if (!out[k]) out[k] = [];
    for (const x of vals) if (!out[k].includes(x)) out[k].push(x);
  };
  for (const key of Object.keys((bs && bs.variants) || {})) {
    for (const p of String(key).split(',')) {
      const i = p.indexOf('=');
      if (i > 0) add(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  }
  const walkWhen = (when, depth) => {
    if (!when || depth > 4) return;
    for (const [k, v] of Object.entries(when)) {
      if (k === 'OR' || k === 'AND') { if (Array.isArray(v)) v.forEach((w) => walkWhen(w, depth + 1)); continue; }
      add(k, v);
    }
  };
  for (const part of (bs && bs.multipart) || []) walkWhen(part.when, 0);
  return Object.keys(out).length ? out : null;
}

/**
 * 「形状类/其余状态」属性：出现其中任何一个 ⇒ 该方块**不作为"简单朝向型"推断**
 *（楼梯的 shape、门的 half/hinge、活板门的 open、箱子的 type……它们的朝向由玩家决定，
 *  按命中面推反而会推歪；保持默认 north 是当前更稳的选择）。
 */
const SHAPE_LIKE = new Set([
  'shape', 'half', 'type', 'open', 'hinge', 'in_wall', 'powered', 'lit', 'rotation', 'tilt',
  'signal_fire', 'conditional', 'extended', 'mode', 'attachment', 'axis', 'note', 'instrument',
  'part', 'occupied', 'disarmed', 'crafting', 'triggered', 'unstable', 'eye', 'stage',
]);

/**
 * 分类：`'connect' | 'wall' | 'face' | 'facing' | 'none'`
 *   · connect —— 四向 bool（fence / pane / bars / vine）⇒ 邻居变化时重算
 *   · wall    —— 四向 none|low|tall（cobblestone_wall 系）⇒ 同上，取值域不同
 *   · face    —— 有 `face`(+`facing`) 的面附着型（button / lever）⇒ **按命中面**定
 *   · facing  —— 只有 `facing` 且没有形状类属性（ladder / end_rod）⇒ **按命中面**定
 *   · none    —— 不推断（楼梯 / 门 / 活板门 / 箱子 / 红石 / 完整方块 …）
 *
 * ★ 判定优先用 `schema`（取值域，权威）；没有 schema 时退回"按默认值猜"。
 *   两条兜底规则要能分开 `wall` 与 `redstone_wire`（二者的四向默认值**都是 `none`**）：
 *     · wall：四向 none|low|tall，**另有 `up` 属性**（矮墙的柱子）
 *     · redstone_wire：四向 none|side|up，另有 `power`、**没有 `up`**
 *   ⇒ 有 `up` 才判 wall。这条不是拍脑袋：见 t-statelogic.mjs 里对两者的断言。
 */
export function classOf(props, schema) {
  const p = props || {};
  const dom = (k) => (schema && schema[k]) || null;
  const vals = SIDES.map((k) => p[k]);
  const have = vals.filter((v) => v !== undefined).length;
  if (have === 4) {
    const d = dom('north') || dom('south') || dom('east') || dom('west');
    if (d) {
      // ★ 只看"域里有 true 吗"，**不要去要求同时有 false**：multipart 的 when 只写"成立的那一边"
      //   （`{"when":{"north":"true"}}`），false 是"不匹配任何 part"隐含的 ⇒ 域里根本没有 false。
      //   实测：oak_fence 的 north 域 = `['true']`、cobblestone_wall 的 north 域 = `['low','tall']`。
      //   反过来，红石线的域 = `['side','up']` ⇒ 既没 true 也没 low ⇒ 判 none（**不会被我们改写**）。
      if (d.includes('true')) return 'connect';
      if (d.includes('low') || d.includes('tall')) return 'wall';
      return 'none';
    }
    if (vals.every((v) => v === 'true' || v === 'false')) return 'connect';
    if (vals.some((v) => v === 'low' || v === 'tall')) return 'wall';
    if (vals.every((v) => v === 'none') && p.up !== undefined) return 'wall';   // ← 见上面注释
    return 'none';
  }
  if (p.face !== undefined && p.facing !== undefined) return 'face';
  if (p.facing !== undefined) {
    for (const k of Object.keys(p)) if (SHAPE_LIKE.has(k)) return 'none';
    return 'facing';
  }
  return 'none';
}

/**
 * 两个方块能不能连。规则（近似游戏）：**同族**（fence↔fence、pane↔pane…）或**对方是完整方块**。
 *
 * 与游戏的已知差异（有意为之，不是漏做）：
 *   ① 没有 BlockTags ⇒ mod 的"栅栏/玻璃板"（不在 `*_fence`/`*_pane` 命名约定里的）认不出同族，
 *      只能靠"完整方块"这一档来连；
 *   ② "完整方块"用**不透明表**近似（`__OPAQUE__`）。两个后果：
 *      · 台阶/楼梯是"不透明但非完整面"，在游戏里连不上栅栏，我们这里会连上 ⇒ **多一根连接杆**；
 *      · **玻璃**（透明但是完整面）不在表里 ⇒ 游戏里栅栏会连它，我们**少连一根**
 *        —— 为了不再引一张"完整方块表"，这一档先认了（宁可漏，不要错到薄的方块上去）。
 */
export function canConnect(selfId, other, ctx) {
  if (!other || !other.id) return false;
  if (familyOf(selfId) === familyOf(other.id)) return true;
  if (!ctx || !ctx.isOpaque || !ctx.isOpaque(other.id)) return false;
  // 不透明表里若混进了薄片/连接型方块（按定义不该有，但数据是外部生成的），这里再挡一次
  const sch = ctx.schemaOf ? ctx.schemaOf(other.id) : null;
  return classOf(other.props, sch) === 'none';
}

/**
 * 连接状态重算：返回**新的 props**（无变化返回 `null`）。
 * `ctx.growOnly` = **只增不减**：只把"没连"改成"连上"，不动已经连上的那些
 *（导入现成建筑时用 —— 文件里的连接是游戏算出来的权威值，我们只在缺的地方补，不撤销它已有的判断）。
 */
export function inferConnect(id, props, ctx) {
  const sch = ctx && ctx.schemaOf ? ctx.schemaOf(id) : null;
  const cls = classOf(props, sch);
  if (cls !== 'connect' && cls !== 'wall') return null;
  const growOnly = !!(ctx && ctx.growOnly);
  const ON = cls === 'connect' ? 'true' : 'low';
  const OFF = cls === 'connect' ? 'false' : 'none';
  let changed = false;
  const out = { ...props };
  for (const s of SIDES) {
    if (!(s in out)) continue;
    const [dx, dy, dz] = DIRS[s];
    const want = canConnect(id, ctx.getAt(dx, dy, dz), ctx) ? ON : OFF;
    if (out[s] === want) continue;
    if (growOnly && out[s] !== OFF) continue;      // 只增不减：非 OFF 的一律不碰
    out[s] = want;
    changed = true;
  }
  return changed ? out : null;
}

/**
 * 放置时的状态推断（≈ 游戏的 `getStateForPlacement`）。
 * `normal` = 鼠标命中的**面法线**（方块放在"命中格 + normal"的那一格）。
 *   · 连接型 ⇒ 直接按邻居算四向（放下去的瞬间就接上旁边的方块）；
 *   · face 型 ⇒ 点在顶面/底面 ⇒ `face=floor/ceiling`；点在侧面 ⇒ `face=wall` 且 `facing` = 法线方向
 *     （按钮"朝外"，法线正是朝外的方向）；floor/ceiling 时 facing 保持默认（没有水平依据）；
 *   · facing 型 ⇒ `facing` = 法线方向（梯子贴墙、末地烛朝外，都是这个规则）；
 *   · 其余 ⇒ 原样返回（楼梯/门的朝向由用户后续旋转，不猜）。
 */
export function inferOnPlace(id, props, normal, ctx) {
  const sch = ctx && ctx.schemaOf ? ctx.schemaOf(id) : null;
  const cls = classOf(props, sch);
  const out = { ...props };
  if (cls === 'connect' || cls === 'wall') {
    const next = inferConnect(id, out, ctx);
    return next || out;
  }
  if (cls === 'face' && normal) {
    const d = dirNameOf(normal);
    if (d === 'up') { out.face = 'floor'; }
    else if (d === 'down') { out.face = 'ceiling'; }
    else if (d) { out.face = 'wall'; out.facing = d; }
    return out;
  }
  if (cls === 'facing' && normal) {
    const d = dirNameOf(normal);
    if (!d) return out;
    const dom = sch && sch.facing;
    const ok = dom ? dom.includes(d) : true;      // 有域就按域校验（末地烛含 up/down；梯子只有四向）
    if (ok) out.facing = d;
    return out;
  }
  return out;
}

/**
 * 受一次编辑影响的格子（自身 + 6 邻）：连接状态只可能被**直接相邻**的方块改变，
 * 所以重算范围就是这 7 格（比 26 邻省，也不漏 —— 对角方块在 MC 里不影响连接）。
 */
export function affectedBy(pos) {
  const out = [[pos[0], pos[1], pos[2]]];
  for (const k of Object.keys(DIRS)) {
    const [dx, dy, dz] = DIRS[k];
    out.push([pos[0] + dx, pos[1] + dy, pos[2] + dz]);
  }
  return out;
}
