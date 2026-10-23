// 物品栏与图标变换的断言集合。被两处复用：
//   - src/test-inventory.mjs    载入真实模块跑一遍
//   - src/mutate-inventory.mjs  载入被改坏的副本跑一遍（期望 FAIL）
// 因此这里不自己 import 任何被测模块，全部由调用方注入。
//
// 每条断言都必须能被一次具体的改动打 FAIL；compared === 0 一律判 FAIL（防空跑假绿）。

export const DEFAULT_MAX_STACK_FALLBACK = 64;

export function runAssertions(M, T) {
  const { Inventory, HOTBAR_SIZE, MAIN_SIZE, TOTAL, DEFAULT_MAX_STACK, isHotbarIndex } = M;
  const results = [];
  const check = (name, fn) => {
    try {
      const r = fn();
      if (r && r.ok === true) results.push(['PASS', name, r.msg]);
      else results.push(['FAIL', name, r.msg ?? '(无实测值)']);
    } catch (e) { results.push(['FAIL', name, '抛异常: ' + e.message]); }
  };
  const mk = () => new Inventory();

  // --- 布局 -----------------------------------------------------------------
  check('布局：36 = 9 + 27，且快捷栏判定只认 0..8', () => {
    const ok = TOTAL === 36 && HOTBAR_SIZE === 9 && MAIN_SIZE === 27
      && isHotbarIndex(0) && isHotbarIndex(8) && !isHotbarIndex(9) && !isHotbarIndex(-1);
    return { ok, msg: `TOTAL=${TOTAL} HOTBAR=${HOTBAR_SIZE} MAIN=${MAIN_SIZE}` };
  });

  // --- 补充与堆叠上限 -------------------------------------------------------
  check('add：同种先填已有堆叠再开新格', () => {
    const inv = mk();
    inv.set(0, { id: 'a', count: 60 });
    const left = inv.add('a', 10);
    const ok = inv.get(0).count === 64 && inv.get(1)?.count === 6 && left === 0;
    return { ok, msg: `槽0=${inv.get(0)?.count}(应64) 槽1=${inv.get(1)?.count}(应6) 剩余=${left}(应0)` };
  });

  check('add：放不下时返回剩余数量', () => {
    const inv = mk();
    inv.slots.fill(null);
    for (let i = 0; i < 36; i++) inv.set(i, { id: 'a', count: 64 });
    const left = inv.add('a', 5);
    return { ok: left === 5 && inv.totalItems() === 36 * 64, msg: `剩余=${left}(应5) 总数=${inv.totalItems()}` };
  });

  check('set：数量被夹在 1..max 之间', () => {
    const inv = mk();
    const a = inv.set(0, { id: 'a', count: 999 });
    const b = inv.set(1, { id: 'a', count: 0 });
    return { ok: a.count === DEFAULT_MAX_STACK && b.count === 1, msg: `999→${a.count} 0→${b.count}` };
  });

  check('maxStackOf 可注入（扩展点可用）', () => {
    const inv = new Inventory({ maxStackOf: (id) => (id === 'bucket' ? 16 : 64) });
    inv.add('bucket', 20);
    const ok = inv.get(0).count === 16 && inv.get(1)?.count === 4;
    return { ok, msg: `bucket 首格=${inv.get(0)?.count}(应16) 次格=${inv.get(1)?.count}(应4)` };
  });

  // --- 移动 / 合并 / 交换 ---------------------------------------------------
  check('move 到空槽：整体搬走，总数不变', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(0, { id: 'x', count: 7 });
    const before = inv.totalItems();
    const r = inv.move(0, 20);
    const ok = !inv.get(0) && inv.get(20)?.id === 'x' && inv.get(20).count === 7
      && inv.totalItems() === before && r.moved === 7 && r.swapped === false;
    return { ok, msg: `源=${JSON.stringify(inv.get(0))} 目标=${JSON.stringify(inv.get(20))} moved=${r.moved}` };
  });

  check('move 同种：合并且溢出留源', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(0, { id: 'x', count: 60 }); inv.set(1, { id: 'x', count: 10 });
    const r = inv.move(0, 1);
    // 目标已有 10，还能装 54，源有 60 → 移动 54、源剩 6
    const ok = inv.get(1).count === 64 && inv.get(0)?.count === 6 && r.moved === 54 && r.swapped === false;
    return { ok, msg: `目标=${inv.get(1).count}(应64) 源剩=${inv.get(0)?.count}(应6) moved=${r.moved}(应54)` };
  });

  check('move 异种：交换', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(0, { id: 'x', count: 3 }); inv.set(1, { id: 'y', count: 9 });
    const r = inv.move(0, 1);
    const ok = r.swapped === true && inv.get(0).id === 'y' && inv.get(1).id === 'x' && inv.totalItems() === 12;
    return { ok, msg: `0=${inv.get(0).id} 1=${inv.get(1).id} swapped=${r.swapped}` };
  });

  check('move 自查：自己到自己不改状态', () => {
    const inv = mk(); inv.slots.fill(null); inv.set(3, { id: 'x', count: 5 });
    const r = inv.move(3, 3);
    return { ok: inv.get(3).count === 5 && r.moved === 0, msg: `槽3=${inv.get(3).count} moved=${r.moved}` };
  });

  // --- 手上堆叠 -------------------------------------------------------------
  check('pickup：空手拿起整堆', () => {
    const inv = mk(); inv.slots.fill(null); inv.cursor = null;
    inv.set(5, { id: 'z', count: 12 });
    inv.pickup(5);
    return { ok: !inv.get(5) && inv.cursor?.id === 'z' && inv.cursor.count === 12, msg: `cursor=${JSON.stringify(inv.cursor)}` };
  });

  check('pickup：放到空槽', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.cursor = { id: 'z', count: 12 };
    inv.pickup(11);
    return { ok: !inv.cursor && inv.get(11)?.count === 12, msg: `槽11=${JSON.stringify(inv.get(11))} cursor=${JSON.stringify(inv.cursor)}` };
  });

  check('pickup：异种则交换（不是覆盖）', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(2, { id: 'a', count: 4 }); inv.cursor = { id: 'b', count: 6 };
    inv.pickup(2);
    const ok = inv.get(2).id === 'b' && inv.cursor.id === 'a' && inv.cursor.count === 4;
    return { ok, msg: `槽2=${inv.get(2).id} cursor=${JSON.stringify(inv.cursor)}` };
  });

  check('pickupHalf：5 → 手上 3 / 槽留 2（原版向上取整在手上）', () => {
    const inv = mk(); inv.slots.fill(null); inv.cursor = null;
    inv.set(2, { id: 'h', count: 5 });
    inv.pickupHalf(2);
    return { ok: inv.cursor?.count === 3 && inv.get(2)?.count === 2, msg: `手上=${inv.cursor?.count}(应3) 槽=${inv.get(2)?.count}(应2)` };
  });

  check('pickupHalf：手上有物品时只放 1 个', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(2, { id: 'h', count: 5 }); inv.cursor = { id: 'h', count: 3 };
    inv.pickupHalf(2);
    return { ok: inv.get(2).count === 6 && inv.cursor.count === 2, msg: `槽=${inv.get(2).count}(应6) 手上=${inv.cursor.count}(应2)` };
  });

  // --- 选中态 ---------------------------------------------------------------
  check('select：只在 0..8 合法，越界抛错', () => {
    const inv = mk();
    let threw = false;
    try { inv.select(9); } catch { threw = true; }
    let ok9 = false;
    try { ok9 = inv.select(8) === 8; } catch { ok9 = false; }
    return { ok: threw && ok9, msg: `select(9) 抛错=${threw} select(8) 成功=${ok9}` };
  });

  check('selectDelta：跨边界双向循环', () => {
    const inv = mk();
    inv.select(8); const a = inv.selectDelta(1);
    inv.select(0); const b = inv.selectDelta(-1);
    return { ok: a === 0 && b === 8, msg: `8→${a}(应0)；0→${b}(应8)` };
  });

  check('selectedStack 跟随 selected', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(4, { id: 's', count: 2 }); inv.select(4);
    const ok = inv.selectedStack()?.id === 's';
    inv.select(5);
    return { ok: ok && inv.selectedStack() === null, msg: `selected=4 → ${JSON.stringify(inv.get(4))}；切到 5 → ${JSON.stringify(inv.selectedStack())}` };
  });

  // --- 事件 -----------------------------------------------------------------
  check('事件：change 至少触发一次（compared>0 守卫）', () => {
    const inv = mk(); inv.slots.fill(null);
    let n = 0; inv.on('change', () => n++);
    inv.add('a', 1); inv.move(0, 1); inv.select(2);
    return { ok: n > 0, msg: `change 触发 ${n} 次（要求 > 0）` };
  });

  check('事件：select 事件带 index 与 stack', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(1, { id: 'e', count: 8 });
    let got = null; inv.on('select', (p) => { got = p; });
    inv.select(1);
    return { ok: got && got.index === 1 && got.stack?.id === 'e', msg: JSON.stringify(got) };
  });

  // --- 序列化 ---------------------------------------------------------------
  check('序列化往返：内容/选中/手上 三者一致', () => {
    const inv = mk(); inv.slots.fill(null);
    inv.set(4, { id: 'p', count: 42 }); inv.set(17, { id: 'q', count: 1 });
    inv.select(6); inv.cursor = { id: 'c', count: 9 };
    const n = Inventory.deserialize(JSON.parse(JSON.stringify(inv.serialize())));
    const ok = n.get(4)?.id === 'p' && n.get(4).count === 42 && n.get(17)?.id === 'q'
      && n.selected === 6 && n.cursor?.id === 'c' && n.cursor.count === 9 && n.slots.length === 36;
    return { ok, msg: `槽4=${JSON.stringify(n.get(4))} 槽17=${JSON.stringify(n.get(17))} selected=${n.selected} cursor=${JSON.stringify(n.cursor)}` };
  });

  // --- 图标变换 -------------------------------------------------------------
  check('变换：未旋转时半宽 = 0.5×0.625×16/8 = 0.625（解析解）', () => {
    const s = T.silhouette(T.buildItemMatrix({ rotationDeg: [0, 0, 0] }).matrix);
    const ok = Math.abs(s.halfW - 0.625) < 1e-6 && Math.abs(s.halfH - 0.625) < 1e-6;
    return { ok, msg: `halfW=${s.halfW.toFixed(6)} halfH=${s.halfH.toFixed(6)}（应均为 0.625）` };
  });

  check('变换：原版顺序的剪影装得进 16×16 框', () => {
    const s = T.silhouette(T.buildItemMatrix({ order: 'vanilla' }).matrix);
    const ok = s.halfW <= 1 && s.halfH <= 1;
    return { ok, msg: `halfW=${s.halfW.toFixed(3)} halfH=${s.halfH.toFixed(3)}（NDC，>1 即溢出）` };
  });

  check('★变换：既有 Ry·Rx 写法横向溢出，因此必须与原版区分（可证伪）', () => {
    const s = T.silhouette(T.buildItemMatrix({ order: 'legacy' }).matrix);
    const ok = s.halfW > 1;   // legacy 必须溢出，否则本条断言失去区分力
    return { ok, msg: `legacy halfW=${s.halfW.toFixed(3)}（应 > 1）、halfH=${s.halfH.toFixed(3)}` };
  });

  check('变换：默认走 vanilla，且数值取自原版 block/block.json', () => {
    const { meta } = T.buildItemMatrix({});
    const ok = meta.order === 'vanilla' && meta.scale === 0.625 && meta.boxPx === 16
      && meta.rotationDeg[0] === 30 && meta.rotationDeg[1] === 225 && meta.flipY === false;
    return { ok, msg: JSON.stringify(meta) };
  });

  // --- 朝向（本轮新增：我们的图标此前上下翻转，草方块绿顶被画到下面） ---------
  check('★朝向：方块顶面（模型空间 y=1）必须落在图标上半部（可证伪）', () => {
    const { matrix } = T.buildItemMatrix({});
    const proj = (x, y, z) => {
      const cx = matrix[0]*x + matrix[4]*y + matrix[8]*z + matrix[12];
      const cy = matrix[1]*x + matrix[5]*y + matrix[9]*z + matrix[13];
      const cw = matrix[3]*x + matrix[7]*y + matrix[11]*z + matrix[15];
      return [cx/cw, cy/cw];
    };
    const up = proj(0.5, 1, 0.5);      // 顶面中心
    const dn = proj(0.5, 0, 0.5);      // 底面中心
    const topPngY = (1 - up[1]) / 2;   // NDC → 画布 y（0 = 画布顶部）
    const botPngY = (1 - dn[1]) / 2;
    const ok = topPngY < 0.5 && botPngY > 0.5 && topPngY < botPngY;
    return { ok, msg: `顶面中心画布 y=${topPngY.toFixed(3)}（须 <0.5）、底面 y=${botPngY.toFixed(3)}（须 >0.5）` };
  });

  // --- 图标设备像素对齐（本轮新增：修 dpr≠1 时纹素宽度不均导致的「发糊」） ---
  check('★图标设备像素对齐：每纹素整数设备像素，且画布与显示 1:1（可证伪）', () => {
    const cases = [[3, 1], [3, 1.25], [3, 1.5], [3, 2], [2, 1.25], [4, 1.5], [6, 2]];
    const rows = cases.map(([s, d]) => {
      const p = T.iconDevicePlan(s, d);
      const k = p.devPx / p.texels;
      return { s, d, p, k, ok: Number.isInteger(p.devPx) && Number.isInteger(k) && k >= 1 && Math.abs(p.cssPx * p.dpr - p.devPx) < 1e-9 };
    });
    const ok = rows.length > 0 && rows.every((r) => r.ok);
    return {
      ok,
      msg: (rows.every((r) => r.ok) ? '全部通过；' : '有失败；')
        + rows.map((r) => `s${r.s}/dpr${r.d}→画布${r.p.devPx}px,${r.k}px/纹素,CSS${r.p.cssPx.toFixed(2)}px`).join('  '),
    };
  });

  check('图标对齐：dpr=1 时与旧实现完全一致（k = scale，不改变已验证的几何）', () => {
    const a = T.iconDevicePlan(3, 1), b = T.iconDevicePlan(2, 1), c = T.iconDevicePlan(6, 1);
    const ok = a.devPx === 48 && b.devPx === 32 && c.devPx === 96 && a.cssPx === 48 && b.cssPx === 32;
    return { ok, msg: `s3/dpr1→${a.devPx}px(${a.cssPx} CSS)；s2/dpr1→${b.devPx}px；s6/dpr1→${c.devPx}px` };
  });

  // --- 面明暗（本轮新增：纠正「GUI 图标被画暗」的偏差） ---------------------
  check('着色系数表：none 恒 1；face 按面取 0.5/0.8/0.6（可证伪）', () => {
    const faces = ['up', 'down', 'north', 'south', 'east', 'west'];
    const gui = faces.map((f) => T.shadeFactor(f, 'none'));
    const dflt = faces.map((f) => T.shadeFactor(f));          // 不传 mode ⇒ 走默认
    const world = faces.map((f) => T.shadeFactor(f, 'face'));
    const ok = gui.every((v) => v === 1)
      && dflt.every((v) => v === 1)
      && new Set(world).size > 1                              // world 必须有区分度，否则本条失去意义
      && Math.min(...world) === 0.5;
    return { ok, msg: `gui=${JSON.stringify(gui)} 默认=${JSON.stringify(dflt)} world=${JSON.stringify(world)}` };
  });

  check('变换：fill 只影响缩放，不影响旋转顺序', () => {
    const a = T.silhouette(T.buildItemMatrix({ order: 'vanilla', fill: 1 }).matrix);
    const b = T.silhouette(T.buildItemMatrix({ order: 'vanilla', fill: 1.2 }).matrix);
    const ok = b.halfW > a.halfW && b.halfH > a.halfH;
    return { ok, msg: `fill=1 → ${a.halfW.toFixed(3)}；fill=1.2 → ${b.halfW.toFixed(3)}` };
  });

  return results;
}
