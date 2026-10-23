// edits.js —— 编辑栈（放置 / 删除 / 撤销 / 重做），原子批 + 只回报"变了的 chunk"。
//
// 为什么自己写而不是用 Deepslate 的 API：`Structure` 只有 `addBlock` 与 `getBlock`，**没有删除、没有改状态**。
// 但它的三个字段是公开的（`size` / `palette` / `blocks` / `blocksMap`），所以直接在这上面做增删改。
//
// ⚠ 一个必须注意的实现细节：`addBlock` 往 `blocks` 与 `blocksMap` 里放的是**两个不同的对象字面量**
//（见 UMD 里 `this.blocks.push({...}); this.blocksMap[...] = {...}`），所以改状态时必须**两边都改**，
// 否则渲染器读 `getBlocks()` 拿到的还是旧状态。`_setRaw` 就是为此写的（并按需重建 `blocks` 数组）。
const flat = (size, pos) => (pos[0] * size[1] + pos[1]) * size[2] + pos[2];

export class EditStack {
  constructor(structure) {
    this.structure = structure;
    this.past = [];
    this.future = [];
    this.revision = 0;
    // 操作数（P3）：只统计提交次数 —— 一组拖拽/一次放置记 1 次；
    // 撤销/重做只是"移动游标"，不算新操作，所以不动它。与 revision（每次历史变动都 +1，闸门依赖）分开。
    this.commits = 0;
    // O2：一次拖拽/框选 = 一个撤销组。组开着的期间，commit 只把 changes 并入 _group，
    // 不落历史、不加 commits/revision；endGroup() 时才整体入栈（这样"一次拖拽 = 一次 Ctrl+Z 全撤"）。
    this._group = null;
  }
  /** 开一个撤销组（拖拽开始 / 框选填充清空共用） */
  beginGroup() { if (!this._group) this._group = []; }
  /** 结束撤销组：整组入栈，计一次操作（空组不入栈） */
  endGroup() {
    if (this._group && this._group.length) {
      this.past.push(this._group);
      this.future.length = 0;
      this.revision++;
      this.commits++;
    }
    this._group = null;
  }
  get inGroup() { return this._group !== null; }

  get size() { return this.structure.size; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  isInside(p) {
    const s = this.structure.size;
    return p[0] >= 0 && p[0] < s[0] && p[1] >= 0 && p[1] < s[1] && p[2] >= 0 && p[2] < s[2];
  }
  stateAt(pos) {
    if (!this.isInside(pos)) return null;
    const rec = this.structure.blocksMap[flat(this.structure.size, pos)];
    return rec ? rec.state : null;
  }
  blockAt(pos) {
    if (!this.isInside(pos)) return null;
    const rec = this.structure.blocksMap[flat(this.structure.size, pos)];
    return rec ? this.structure.palette[rec.state] : null;
  }
  /**
   * 只改状态：null = 删；否则 = palette 下标。返回旧下标（或 null）。
   * ★ O2（v1.9）：只动 `blocksMap`（O(1)），**不再每次 findIndex/splice 线性扫描 `blocks`**。
   *   旧写法每次改一个格都要 `blocks.findIndex(...)`（O(N)）：框选 100×100 = 10⁴ 格就是 10⁸ 级扫描，
   *   直接卡到不可用。现在把 `blocksMap` 当权威源，一次提交/一次撤销结束时用 `_syncBlocks()` 从它整体
   *   重建 `blocks`（O(体积)，一次），供 `getBlocks()`（渲染/序列化）读取 —— 语义与顺序都和原来一致。
   */
  _setRaw(pos, state) {
    const s = this.structure;
    const i = flat(s.size, pos);
    const cur = s.blocksMap[i];
    const old = cur ? cur.state : null;
    if (state === null) {
      if (!cur) return null;
      s.blocksMap[i] = undefined;
    } else {
      if (cur) cur.state = state;
      else s.blocksMap[i] = { pos: pos.slice(), state };
    }
    return old;
  }
  /**
   * 从 `blocksMap`（权威）整体重建 `blocks` 数组。Deepslate 的 `blocks` 与 `blocksMap` 元素都是
   * `{pos, state: palette 下标}`（`getBlocks()` 再经 `toPlacedBlock` 转成 BlockState 对象），所以直接拷贝即可。
   *
   * ★ 2026-10-11（用户要"无限建造"）：这里原来是 `for (i = 0; i < bm.length; i++)` ——
   *   `blocksMap` 是扁平索引数组，**长度 = W*H*D**，所以那是 **O(体积)** 而不是 O(方块数)：
   *   32×16×32 = 1.6 万次（无感）→ 512×128×512 = **3355 万次/次编辑**（拖动/批量直接卡死）。
   *   世界能被长大之后，这条循环必须只跟**方块数**走。
   *   做法：稀疏数组只遍历**已设下标**（V8 对 length≫条目数的数组走字典模式，for...in 只访问真实条目）。
   *   顺序仍是**下标升序**（ECMAScript：数组的整数下标在 for-in 中先按升序枚举）⇒ `blocks` 顺序不变，
   *   `getBlocks()[0]` 之类依赖顺序的用法语义不变（闸门有断言守）。
   */
  _syncBlocks() {
    const s = this.structure;
    const bm = s.blocksMap, out = [];
    for (const k in bm) { const r = bm[k]; if (r) out.push(r); }
    s.blocks = out;
  }
  /** 放置：先清同格，再 addBlock（借它做调色板去重与扩容） */
  _place(pos, id, props) {
    const before = this.stateAt(pos);
    if (before !== null) this._setRaw(pos, null);
    this.structure.addBlock(pos.slice(), id, props || {});
    return { pos: pos.slice(), from: before, to: this.stateAt(pos) };
  }
  /**
   * 提交一批操作。ops = [{ kind:'place'|'erase', pos, id?, props? }]
   * 返回 { changes:[{pos,from,to}], chunks:[[cx,cy,cz]...] }；无实际变化则 changes 为空。
   */
  commit(ops, chunkSize = 16) {
    const changes = [];
    for (const op of ops) {
      if (!this.isInside(op.pos)) continue;
      if (op.kind === 'erase') {
        const from = this.stateAt(op.pos);
        if (from === null) continue;
        this._setRaw(op.pos, null);
        changes.push({ pos: op.pos.slice(), from, to: null });
      } else {
        const before = this.stateAt(op.pos);
        const same = before !== null && stateString(this.structure.palette[before]) === stateStringOf(op.id, op.props);
        if (same) continue;
        changes.push(this._place(op.pos, op.id, op.props));
      }
    }
    if (!changes.length) return { changes, chunks: [] };
    this._syncBlocks();                 // O2：一次提交只重建一次 blocks（替代每格线性扫描）
    if (this._group) {                  // 组开着：并入当前组，不落历史、不加 commits/revision
      for (const c of changes) this._group.push(c);
      return { changes, chunks: chunksOf(changes, chunkSize) };
    }
    this.past.push(changes);
    this.future.length = 0;
    this.revision++;
    this.commits++;                    // 操作数：一次 commit = 一次操作（撤销/重做不在这里）
    return { changes, chunks: chunksOf(changes, chunkSize) };
  }
  /**
   * 整体平移历史与未来的所有 change 坐标（2026-10-11：世界向负方向扩展 = 平移式长大时用）。
   * 调用方负责重建 structure 并同步 this.structure 引用；本方法只把**坐标**搬到位，
   * 这样撤销/重做在平移之后依然指向正确的格子。
   */
  translate(dx, dy, dz) {
    const mv = (c) => { c.pos[0] += dx; c.pos[1] += dy; c.pos[2] += dz; };
    for (const g of this.past) for (const c of g) mv(c);
    for (const g of this.future) for (const c of g) mv(c);
    if (this._group) for (const c of this._group) mv(c);
  }
  _apply(changes, dir) {
    // dir='undo' → 回到 from；dir='redo' → 回到 to
    for (const c of changes) this._setRaw(c.pos, dir === 'undo' ? c.from : c.to);
    this._syncBlocks();
  }
  undo(chunkSize = 16) {
    if (!this.past.length) return null;
    const changes = this.past.pop();
    this._apply(changes, 'undo');
    this.future.push(changes);
    this.revision++;
    return { changes, chunks: chunksOf(changes, chunkSize) };
  }
  redo(chunkSize = 16) {
    if (!this.future.length) return null;
    const changes = this.future.pop();
    this._apply(changes, 'redo');
    this.past.push(changes);
    this.revision++;
    return { changes, chunks: chunksOf(changes, chunkSize) };
  }
  clearHistory() { this.past.length = 0; this.future.length = 0; this._group = null; }
}

export function chunksOf(changes, chunkSize) {
  // ★ 2026-10-12：支持**数组**形式的 chunkSize（[x,y,z]）—— 视口那边为了"分层粒度 = 1 层"
  //   已经把分块改成 [16,1,16]，而这里的"受影响 chunk"必须用**同一套**分块算，
  //   否则增量重建会去刷一个根本不存在的 chunk（表现为：新放的方块不显示，直到整场重刷）。
  const cs = Array.isArray(chunkSize) ? chunkSize : [chunkSize, chunkSize, chunkSize];
  const seen = new Set();
  const out = [];
  for (const c of changes) {
    const k = [Math.floor(c.pos[0] / cs[0]), Math.floor(c.pos[1] / cs[1]), Math.floor(c.pos[2] / cs[2])];
    const id = k.join(',');
    if (!seen.has(k.join(','))) { seen.add(id); out.push(k); }
  }
  return out;
}

/** Deepslate BlockState → "ns:name[k=v,...]"（键按字母序，与 MC 一致） */
export function stateString(bs) {
  if (!bs) return '';
  const name = bs.getName ? bs.getName().toString() : String(bs);
  const props = bs.getProperties ? bs.getProperties() : null;
  return stateStringOf(name, props);
}
export function stateStringOf(id, props) {
  const keys = props ? Object.keys(props).filter(k => props[k] !== undefined && props[k] !== null) : [];
  if (!keys.length) return id;
  keys.sort();
  return `${id}[${keys.map(k => `${k}=${props[k]}`).join(',')}]`;
}
