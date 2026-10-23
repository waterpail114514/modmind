// layer.js —— 【2026-10-12 已停用，保留仅为记录】
//
// 这个文件是 1.12.0 的"分层增量视图"引擎（拖滑块时走 place/erase ops + 增量刷 chunk）。
// 1.14.1 起分层改成**绘制筛选**（viewport.js 的 drawStructureVisible + setLayerLimit）：
//   "只显示 ≤N 层"根本不需要动数据，而旧实现每动一格都要重建一整层 chunk ⇒ 大建筑明显卡顿。
// 现在没有任何模块引用它 —— **不要**把它接回去；要看新的做法请读 viewport.js 里那段注释。
//
// ---- 以下为原文（停用）----
// layer.js —— 分层（y ≤ max）的**增量视图**引擎（2026-10-11，修「拖滑块明显卡顿」）。
//
// 为什么有它：原实现在每次滑块 input 时 `viewStructure()` 全量重建结构 + `setStructure()`
// （整场 chunk 重刷）——一秒几十次 input ⇒ 明显卡顿。本引擎维护一个**持久视图结构**，
// 层变化 = 一批 place/erase（走 EditStack 的"组"模式，不落撤销历史）+ 只刷新**受影响 chunk**。
//
// 单一真源：当前层上限（layerMax）由调用方持有并传入；S 里只存视图自身的状态（view / builtTo）。
// builtTo = 视图当前包含的最高层（视图恒等于 "source 的 0..builtTo 层"；-1 = 无视图=不过滤）。
export function createLayerView({ D, EditStack }) {
  const S = { source: null, view: null, edit: null, builtTo: -1 };

  /** 换源（载入新建筑）：重置一切。 */
  function reset(source) {
    S.source = source || null;
    S.view = null; S.edit = null; S.builtTo = -1;
  }

  /** 渲染应用的结构：过滤态用视图，否则用源。 */
  function structure() { return S.view || S.source; }

  /** 过滤态是否已建立（测试/断言用）。 */
  function active() { return S.builtTo >= 0; }

  /** 全量重建视图到 target 层（首次进入过滤、undo/redo 后等低频路径用）。 */
  function rebuild(target) {
    const src = S.source;
    if (!src) return;
    const [sx, sy, sz] = src.getSize();
    const capped = Math.max(0, Math.min(target, sy - 1));
    if (capped >= sy - 1) { S.view = null; S.edit = null; S.builtTo = -1; return; }
    const v = new D.Structure([sx, sy, sz]);
    for (const b of src.getBlocks()) {
      if (b.pos[1] <= capped) v.addBlock(b.pos, b.state.getName().toString(), b.state.getProperties() || {});
    }
    S.view = v;
    S.edit = new EditStack(v);
    S.builtTo = capped;
  }

  /**
   * 把视图切到 target 层。返回（kind 决定调用方动作）：
   *   { kind:'none' }             无变化，什么都不用做
   *   { kind:'rebuild' }          视图对象变了 ⇒ 调 setStructure(structure())
   *   { kind:'chunks', chunks }   增量 ⇒ 调 updateBuffers(chunks)
   */
  function setMax(target) {
    const src = S.source;
    if (!src) return { kind: 'none' };
    const sy = src.size[1];
    const capped = Math.max(0, Math.min(target, sy - 1));
    // 回到"全部"：清掉视图（低频，一次性）
    if (capped >= sy - 1) {
      if (S.builtTo < 0 && !S.view) return { kind: 'none' };
      S.view = null; S.edit = null; S.builtTo = -1;
      return { kind: 'rebuild' };
    }
    // 还没建视图（首次进入过滤）：全量建一次
    if (!S.view || !S.edit) { rebuild(capped); return { kind: 'rebuild' }; }
    const from = S.builtTo;
    if (from === capped) return { kind: 'none' };
    const ops = [];
    if (capped > from) {
      // 增大：把 (from, capped] 层的块从源补进视图
      for (const b of src.getBlocks()) {
        if (b.pos[1] > from && b.pos[1] <= capped) {
          ops.push({ kind: 'place', pos: b.pos.slice(), id: b.state.getName().toString(), props: b.state.getProperties() || {} });
        }
      }
    } else {
      // 减小：把 (capped, from] 层的块从视图移除
      for (const b of S.view.getBlocks()) {
        if (b.pos[1] > capped && b.pos[1] <= from) ops.push({ kind: 'erase', pos: b.pos.slice() });
      }
    }
    S.builtTo = capped;
    if (!ops.length) return { kind: 'none' };
    S.edit.beginGroup();
    const r = S.edit.commit(ops, 16);
    S.edit.endGroup();
    return { kind: 'chunks', chunks: r.chunks };
  }

  /**
   * 编辑同步：把一批编辑 ops 过滤后并入视图（place 落在隐藏层则不进视图；erase 照删）。
   * 返回增量 chunks；null = 视图无需刷新（未过滤 / 改动全在隐藏层）。
   * 注意：调用方**不能**把 null 当作"无编辑"——源的编辑永远生效，这只是视图侧。
   */
  function syncEdit(ops, layerMax) {
    const lim = layerMax === Infinity ? Number.MAX_SAFE_INTEGER : layerMax;
    if (S.builtTo < 0 || !S.view || !S.edit) return null;
    const vops = (ops || []).filter((o) => o.kind === 'erase' || o.pos[1] <= lim);
    if (!vops.length) return null;
    S.edit.beginGroup();
    const r = S.edit.commit(vops, 16);
    S.edit.endGroup();
    return r.chunks;
  }

  return { reset, structure, rebuild, setMax, syncEdit, active, S };
}
