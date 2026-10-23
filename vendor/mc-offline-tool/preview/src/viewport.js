// viewport.js —— Deepslate 视口封装：相机 / 适应 / 网格 / 分层 / 拾取 / 按需重绘 / 增量重建。
//
// 关键点（都实测过）：
//   · 投影在渲染器内部（`projMatrix` 是公开字段），**每次绘制前必须 setViewport**，
//     不要自己造投影；拾取就用这个 projMatrix 反投影，保证与画面一致。
//   · 增量重建：`updateStructureBuffers([chunk...])` 只重建给定 chunk（编入网格），所以编辑不会整场重刷。
//   · 高亮：`drawOutline(view, pos)` 画一个线框方块 —— 拾取命中时用它。
// ★ chunkSize 用**数组** [x, y, z]（2026-10-12）：Deepslate 支持非立方分块
//   （源码：`this.chunkSize = typeof i == 'number' ? [i,i,i] : i`）。
//   **y 方向取 1**：分层（只画 ≤N 层）的粒度就等于 1 层 —— 取 4 的话，一个只有 4 层高的世界
//   会退化成"只有一个 y 层 chunk"，分层**完全不起作用**（这是我这轮先试 4、再用一个 4 层高的世界
//   验算发现的）。代价是 chunk 槽位变多（y 方向 ×16），但槽位是稀疏数组、而且我们只遍历不重建
//   （见 drawStructureVisible），那点开销可以忽略；反过来，编辑时重建的 chunk 更小、更便宜。
export const CHUNK_SIZE = [16, 1, 16];
export function createViewport(D, { canvas, structure, resources, chunkSize = CHUNK_SIZE, feel = null }) {
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL 不可用（浏览器/显卡不支持）');
  const mat4 = (window.glMatrix && window.glMatrix.mat4) || D.mat4;
  if (!mat4) throw new Error('gl-matrix (mat4) 不可用');

  let current = structure;
  let activeResources = resources;
  // ★ useInvisibleBlockBuffer:false —— 见 setResources 处的注释：
  //   开着它时 Deepslate 会给**每个空格子**建一个线框（O(体积) 时间与内存），而我们从不画它；
  //   "无限建造"下这是致命的（实测 1.6M 格 ⇒ 1960 万条线 ≈ 470 MB ⇒ 渲染进程 OOM、页面卡死）。
  let renderer = new D.StructureRenderer(gl, current, activeResources, { chunkSize, useInvisibleBlockBuffer: false });

  const cam = { xr: 0.9, yr: 0.6, dist: 20, target: [0, 0, 0], zoom: 1 };
  // ── 手感实验室（2026-10-11；详见评审文档《3D 建筑面板手感优化方案》）────────────
  //   feel = null（默认）⇒ 全关闭，行为与既有版本**逐字节一致**（回归闸门基线保底）。
  //   main.js 在 URL ?feel=1 时传入**同一个对象**（面板可实时改各项）：
  //     · damping    >0 时：orbit / 滚轮缩放走"期望值(want)"，每帧指数趋近（拖拽跟手、松手滑出衰减）
  //     · zoomCursor 朝光标缩放（把光标下的世界点钉在屏幕上；与 three.js zoomToCursor 同构）
  //   pan / WASD 平移**不进阻尼**（抓取语义要 1:1 跟手）：它们直接改 cam 并把 want 拉齐。
  const FEEL = feel || { damping: 0, zoomCursor: false };
  const want = { xr: cam.xr, yr: cam.yr, dist: cam.dist, target: cam.target.slice() };
  function syncWant() {
    want.xr = cam.xr; want.yr = cam.yr; want.dist = cam.dist;
    want.target[0] = cam.target[0]; want.target[1] = cam.target[1]; want.target[2] = cam.target[2];
  }
  // 相机参数常量（P3/2.2，与定稿原型一致；**不在 UI 暴露这些数字**）
  const ROT_PER_PX = 0.010;    // yaw 灵敏度 rad/px
  const PITCH_PER_PX = 0.008;  // 俯仰灵敏度 rad/px
  // 2026-10-11：用户要「放大没有限制」——范围放宽到 3000×（0.02~60），俯仰也放宽到近地平线仰视。
  // ★ 2026-10-11 放开俯仰下界 -0.35 → -1.45（≈ -83°）：ViewCube 要能"从下往上看"（立方体视角的
  //   基本能力），-0.35（-20°）会让"底部"那一片方向点不到。上界 1.55（88.8°）不动，
  //   两侧都停在离 ±90° 有 7° 的地方 —— 那里相机 up 与视线共线，视图矩阵会翻面。
  //   注意：这条是**有意的行为变更**，闸门 P3-cam4 同步改了并注明原因（不是改判据去迁就实现）。
  const PITCH_MIN = -1.45, PITCH_MAX = 1.55;  // 俯仰 clamp（可仰视到 -83°，不可翻面）
  const ZOOM_MIN = 0.02, ZOOM_MAX = 60;       // 滚轮缩放 clamp（原 [0.25,2.4]，9.6× → 3000×）
  let baseDist = 0;            // zoom=1 时对应的相机距离（fit 时确定）
  let wantGrid = true;
  let outline = null;          // 悬停高亮的方块坐标
  let ghost = null;            // 幽灵预览 { pos:[x,y,z], kind:'place'|'erase' } | null
  /** 视口底色（0–1 的 RGB）。默认深色：独立网页/宿主没给 --theme-canvas 时的兜底。 */
  let backdrop = [0.055, 0.067, 0.086];
  function setBackdrop(rgb) {
    if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => Number.isFinite(v))) backdrop = rgb;
  }

  // ★ 尺寸缓存：改成持续帧循环后，如果每帧都调 getBoundingClientRect()，会**每帧强制一次布局**
  //   （明显掉帧）。所以只在创建时、window resize、以及元素尺寸变化（ResizeObserver）时量一次。
  let cssW = 0, cssH = 0, cssLeft = 0, cssTop = 0;
  function measure() {
    const r = canvas.getBoundingClientRect();
    cssW = r.width; cssH = r.height; cssLeft = r.left; cssTop = r.top;
  }
  measure();
  // ★ 这些监听/观察者必须能撤销：功能包会被宿主"切走再切回来"，组件卸载后若还挂着，
  //   第二次挂载就会叠加（双份 measure、双份绘制、resize 抖动）。统一登记，dispose() 一次清掉。
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => { try { target.removeEventListener(type, fn, opts); } catch { /* 尽力而为 */ } });
  };
  on(window, 'resize', measure);
  let resizeObs = null;
  if (typeof ResizeObserver === 'function') {
    try { resizeObs = new ResizeObserver(() => { measure(); }); resizeObs.observe(canvas); } catch { resizeObs = null; }
  }

  function cssSize() {
    if (cssW <= 0 || cssH <= 0) measure();          // 首帧/被隐藏时兜底
    return [Math.max(1, Math.round(cssW)), Math.max(1, Math.round(cssH))];
  }
  function resize() {
    const [w, h] = cssSize();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    return [W, H];
  }
  function viewMatrix() {
    const v = mat4.create();
    mat4.translate(v, v, [0, 0, -cam.dist]);
    mat4.rotate(v, v, cam.xr, [1, 0, 0]);
    mat4.rotate(v, v, cam.yr, [0, 1, 0]);
    mat4.translate(v, v, [-cam.target[0], -cam.target[1], -cam.target[2]]);
    return v;
  }
  // ---- 幽灵预览 / 顶面高亮：一个极简半透明 GL 程序（Deepslate 只给了线框 drawOutline，没有彩色实心块）----
  const box = (() => {
    const vs = 'attribute vec3 aPos;uniform mat4 uMVP;void main(){gl_Position=uMVP*vec4(aPos,1.0);}';
    const fs = 'precision mediump float;uniform vec4 uColor;void main(){gl_FragColor=uColor;}';
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    const CUBE = [
      1,0,0, 1,1,0, 1,1,1,  1,0,0, 1,1,1, 1,0,1,   // +x
      0,0,1, 0,1,1, 0,1,0,  0,0,1, 0,1,0, 0,0,0,   // -x
      0,1,0, 1,1,0, 1,1,1,  0,1,0, 1,1,1, 0,1,1,   // +y（顶）
      0,0,0, 1,0,1, 1,0,0,  0,0,0, 0,0,1, 1,0,1,   // -y
      0,0,1, 1,0,1, 1,1,1,  0,0,1, 1,1,1, 0,1,1,   // +z
      1,0,0, 0,0,0, 0,1,0,  1,0,0, 0,1,0, 1,1,0,   // -z
    ];
    const TOP = [0,1,0, 1,1,0, 1,1,1, 0,1,0, 1,1,1, 0,1,1];   // 顶面（2 三角形）
    const cubeBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(CUBE), gl.STATIC_DRAW);
    const topBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, topBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(TOP), gl.STATIC_DRAW);
    return { p, cubeBuf, topBuf, cubeVerts: CUBE, aPos: gl.getAttribLocation(p, 'aPos'), uMVP: gl.getUniformLocation(p, 'uMVP'), uColor: gl.getUniformLocation(p, 'uColor'), cubeN: CUBE.length / 3, topN: TOP.length / 3 };
  })();
  function blit(view, buf, n, model, color, noOffset) {
    const mvp = mat4.multiply(mat4.create(), renderer.projMatrix, mat4.multiply(mat4.create(), view, model));
    gl.useProgram(box.p);
    gl.uniformMatrix4fv(box.uMVP, false, mvp);
    gl.uniform4fv(box.uColor, color);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(box.aPos);
    gl.vertexAttribPointer(box.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    // 默认往观察者方向偏移一点，压过同格方块/网格（框选预览、悬停高亮、幽灵都靠它）。
    // `noOffset`：**不偏移** ⇒ 老老实实被真实方块遮住 —— 投影虚影的"一致组/降级组"要的正是这个
    //   （否则大投影的淡影会盖在已有建筑上，把建筑染成一片黄）。
    if (!noOffset) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1); }
    gl.drawArrays(gl.TRIANGLES, 0, n);
    if (!noOffset) gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  /** 悬停格顶面高亮 + 幽灵预览（摆放=蓝色半透明；删除=红调） */
  function drawOverlay(view) {
    if (!box) return;
    // 框选预览（先画，让悬停/幽灵盖在它上面）：地面覆盖板 + 顶面板（有 yTop 时）
    if (selRect) {
      const x0 = Math.min(selRect.x1, selRect.x2), z0 = Math.min(selRect.z1, selRect.z2);
      const w = Math.abs(selRect.x2 - selRect.x1) + 1, d = Math.abs(selRect.z2 - selRect.z1) + 1;
      // ★ 整块板**用一次 draw 画完**（把单位面按 w×d 缩放），不是逐格画 —— 逐格 40×40 就是 1600 次 draw。
      const mkPlate = (y) => { const m = mat4.create(); mat4.translate(m, m, [x0, y, z0]); mat4.scale(m, m, [w, 1, d]); return m; };
      blit(view, box.topBuf, box.topN, mkPlate(0.02), [0.25, 0.55, 1, 0.22]);          // 地面板：框住了哪些列
      if (selRect.yTop != null) {
        blit(view, box.topBuf, box.topN, mkPlate(selRect.yTop + 2), [0.25, 0.55, 1, 0.16]);   // 顶面板：框到多高
      }
    }
    if (outline) {
      const m = mat4.create(); mat4.translate(m, m, [outline[0], outline[1] + 1, outline[2]]);
      blit(view, box.topBuf, box.topN, m, [1, 1, 1, 0.16]);
    }
    // 投影虚影**不在这里画**（2026-10-12 改版）：它现在带方块贴图，走 drawTexturedGhost，
    // 而且必须排在**真实结构之后**才能被正确遮挡（见 draw() 里的调用点）。
    if (ghost) {
      const m = mat4.create(); mat4.translate(m, m, ghost.pos);
      const col = ghost.kind === 'erase' ? [1, 0.28, 0.28, 0.42] : [0.35, 0.72, 1, 0.34];
      blit(view, box.cubeBuf, box.cubeN, m, col);
    }
    // 立体边框（12 条棱）：用**网格那套线框程序**画（同一个网格 shader = 观感与坐标轴/网格一致）。
    if (selMesh && typeof selMesh.lineVertices === 'function' && selMesh.lineVertices() > 0) {
      renderer.setShader(renderer.gridShaderProgram);
      renderer.prepareDraw(view);
      renderer.drawMesh(selMesh, { pos: true, color: true });
      resetVertexAttrs();     // ★ 换了 program 就要清属性槽（否则下一帧会画出一堆 INVALID_OPERATION）
    }
  }
  /**
   * 镜像轴可视化（2026-10-11，用户要「镜像坐标在网格中间」——把轴画出来，位置一眼可见）：
   *   x = X 镜像轴位置（世界中心 x=W/2 的竖直面，YZ 平面）→ 偏红（对上红色的 X 坐标轴）；
   *   z = Z 镜像轴位置（世界中心 z=D/2 的竖直面，XY 平面）→ 偏蓝（对上蓝色的 Z 坐标轴）；
   *   y = Y 镜像轴位置（高度中线 y=H/2 的水平面）→ 偏绿（当前恒为 null，见下方注释）。
   *   null = 不画。
   */
  let axes = { x: null, y: null, z: null, extent: [0, 0, 0], origin: [0, 0, 0] };
  // ---------------------------------------------------------------- 框选预览（2026-10-11）
  // selRect = 选区（索引坐标，**含端点**）：{ x1, z1, x2, z2, yTop }
  //   yTop = null ⇒ 只画地面板（拖动中）；数字 ⇒ 再画立体边框 + 顶面板（释放后）
  let selRect = null;
  let selMesh = null;          // 自建的线框 mesh（不碰库的 gridMesh —— 那个画的是坐标轴）
  /** 懒建自有的线框 mesh。★ 必须 new 一个新的，不能 clear 复用库的 gridMesh（会擦掉网格/坐标轴）。 */
  function ensureSelMesh() {
    if (selMesh) return selMesh;
    const proto = renderer && renderer.gridMesh;
    if (!proto || typeof proto.constructor !== 'function') return null;
    try { selMesh = new (proto.constructor)(); } catch { selMesh = null; }
    return selMesh;
  }
  function rebuildSelMesh() {
    const mesh = ensureSelMesh();
    if (!mesh || typeof mesh.addLine !== 'function') return;
    mesh.clear();
    if (selRect && selRect.yTop != null) {
      const x0 = Math.min(selRect.x1, selRect.x2), x1b = Math.max(selRect.x1, selRect.x2) + 1;
      const z0 = Math.min(selRect.z1, selRect.z2), z1b = Math.max(selRect.z1, selRect.z2) + 1;
      const y0 = 0, y1b = selRect.yTop + 2;      // yTop 是"最高的那个方块"，盒子要到它上面一格
      const c = [0.16, 0.45, 0.95];
      const seg = (ax, ay, az, bx, by, bz) => mesh.addLine(ax, ay, az, bx, by, bz, c);
      // 下圈 4 条 + 上圈 4 条 + 立柱 4 条 = **恒定 12 条**（与选区大小无关）
      seg(x0, y0, z0, x1b, y0, z0); seg(x1b, y0, z0, x1b, y0, z1b);
      seg(x1b, y0, z1b, x0, y0, z1b); seg(x0, y0, z1b, x0, y0, z0);
      seg(x0, y1b, z0, x1b, y1b, z0); seg(x1b, y1b, z0, x1b, y1b, z1b);
      seg(x1b, y1b, z1b, x0, y1b, z1b); seg(x0, y1b, z1b, x0, y1b, z0);
      seg(x0, y0, z0, x0, y1b, z0); seg(x1b, y0, z0, x1b, y1b, z0);
      seg(x1b, y0, z1b, x1b, y1b, z1b); seg(x0, y0, z1b, x0, y1b, z1b);
      mesh.rebuild(gl, { pos: true, color: true });
    } else {
      mesh.rebuild(gl, { pos: true, color: true });   // 清空 ⇒ lineVertices() 归 0
    }
  }
  /** 主模块每次改动选区都调这里（相等则不重建，避免拖框时每像素都重建 buffer）。 */
  function setSelectRegion(r) {
    const norm = r ? { x1: r.x1 | 0, z1: r.z1 | 0, x2: r.x2 | 0, z2: r.z2 | 0, yTop: (r.yTop == null ? null : (r.yTop | 0)) } : null;
    const key = norm ? [norm.x1, norm.z1, norm.x2, norm.z2, norm.yTop].join(',') : '';
    const was = selRect ? [selRect.x1, selRect.z1, selRect.x2, selRect.z2, selRect.yTop].join(',') : '';
    if (key === was) return false;
    selRect = norm;
    rebuildSelMesh();
    render();
    return true;
  }
  // ── 分层切口的"补顶面"（2026-10-12，用户报「你这个分层后，贴图会缺失啊」）──────────────
  // ★ 那不是"贴图缺失"，是**缺面**，而且是 1.14.1 我把分层改成"绘制筛选"时引入的副作用：
  //   库的面剔除（`ChunkBuilder.needsCull`）是**建模期**按**完整世界**算的 ——
  //   "上方有方块 ⇒ 不生成这块的顶面"；而分层是**绘制期**把上层整列跳过 ⇒
  //   切口那一层的顶面**本来就没被生成** ⇒ 切开处直接看到内部（黑/空）。
  //   （1.14.0 的分层是"裁剪结构 + 重建"，重建时会重算 cull ⇒ 不破；但那要整场重建 ⇒ 卡。）
  // 修法：**只给切口那一层补画顶面**，用该方块真实模型的顶面贴图 ⇒
  //   · 成本 O(切口层方块数)（不是 O(世界)），且**不动**任何 chunk 网格（零重建的架构保住）；
  //   · 只补"顶面"是因为分层只会切**上面**（"只看 ≤N 层"）⇒ 缺的只有朝上的那一面。
  let capVbo = null;
  let capStats = { limit: null, cells: 0, quads: 0, bytes: 0, ms: 0 };
  let capScratch = null;
  let capTimer = 0;
  function dropCap() {
    if (capVbo) { try { gl.deleteBuffer(capVbo); } catch { /* 尽力而为 */ } capVbo = null; }
    capStats = { limit: null, cells: 0, quads: 0, bytes: 0, ms: 0 };
  }
  /**
   * 重建切口补面。`n` = 可见的最高层（索引 y ≤ n）；`n == null` ⇒ 不补（看全部时没有切口）。
   * 只处理 `y === n` 且 `y+1` 有方块的方块 —— 正是"顶面被剔除掉"的那些。
   */
  function rebuildCap(n) {
    dropCap();
    if (n == null || !current || !box || !activeResources) return false;
    const t0 = ghostNow();
    const res = activeResources;
    const st = current;
    const [sx, sy, sz] = st.getSize();
    if (n + 1 >= sy) return false;                       // 顶层之上没有东西 ⇒ 没有切口
    const list = [];
    for (const b of st.getBlocks()) {
      const p = b.pos;
      if (p[1] !== n) continue;                          // 只看切口那一层
      if (!st.getBlock([p[0], p[1] + 1, p[2]])) continue; // 上方没方块 ⇒ 它本来就有顶面
      list.push(b);
    }
    if (!list.length) return false;
    const idCache = new Map();
    const idOf = (s) => { let v = idCache.get(s); if (!v) { v = D.Identifier.parse(s); idCache.set(s, v); } return v; };
    // 只留"朝上"那一面：其余五个方向一律剔（不管邻居）⇒ 取出来的 mesh 就只有一个面
    const CULL_UP_ONLY = { up: false, down: true, west: true, east: true, north: true, south: true };
    const meshes = [];
    let totalQuads = 0, cells = 0;
    for (const b of list) {
      const id = b.state.getName().toString();
      const def = res.getBlockDefinition(id);
      if (!def) continue;
      let mesh;
      try { mesh = def.getMesh(idOf(id), b.state.getProperties() || {}, res, res, CULL_UP_ONLY); } catch { continue; }
      if (!mesh || !mesh.quads.length) continue;
      cells++;
      meshes.push({ mesh, x: b.pos[0], y: b.pos[1], z: b.pos[2] });
      totalQuads += mesh.quads.length;
    }
    if (!totalQuads) return false;
    const F = 15, need = totalQuads * 6 * F;
    if (!capScratch || capScratch.length < need) capScratch = new Float32Array(need + 900);
    const arr = capScratch;
    let o = 0;
    for (const it of meshes) {
      for (const q of it.mesh.quads) {
        const nrm = q.normal();
        if (!nrm || nrm.y < 0.5) continue;               // 保险：只要朝上的面
        const vs = q.vertices();
        for (let k = 0; k < 6; k++) {
          const v = vs[k === 3 ? 0 : k === 4 ? 2 : k === 5 ? 3 : k];
          const pp = v.pos.components();
          arr[o++] = pp[0] + it.x; arr[o++] = pp[1] + it.y; arr[o++] = pp[2] + it.z;
          const col = v.color || [1, 1, 1];
          arr[o++] = col[0]; arr[o++] = col[1]; arr[o++] = col[2];
          const uv = v.texture || [0, 0];
          arr[o++] = uv[0]; arr[o++] = uv[1];
          const lim = v.textureLimit || [0, 0, 0, 0];
          arr[o++] = lim[0]; arr[o++] = lim[1]; arr[o++] = lim[2]; arr[o++] = lim[3];
          const nr = v.normal ? v.normal.components() : [0, 1, 0];
          arr[o++] = nr[0]; arr[o++] = nr[1]; arr[o++] = nr[2];
        }
      }
    }
    if (!o) return false;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, o), gl.STATIC_DRAW);
    capVbo = buf;
    capStats = { limit: n, cells, quads: o / (F * 6), bytes: o * 4, ms: Math.round(ghostNow() - t0) };
    return true;
  }
  /**
   * 补面的重建**延迟合并**：滑块一拖会走过几十个档位，每档都遍历一遍方块表（O(世界方块数)）
   * 在大世界里会顿。合并到最后一次之后 140 ms —— 拖动中先沿用上一版补面（顶多短暂不完美）。
   */
  function scheduleCap(n) {
    if (capTimer) clearTimeout(capTimer);
    capTimer = setTimeout(() => { capTimer = 0; rebuildCap(n); draw(); }, 140);
  }
  /** 画切口补面：它是"世界的表面"，所以**不透明 + 写深度**（和虚影那套半透明设置相反）。 */
  function drawCap(view) {
    if (!capVbo) return;
    let prog;
    try { prog = ensureGhostProg(); } catch { return; }
    try {
      gl.useProgram(prog);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.CULL_FACE);
      const aPos = gl.getAttribLocation(prog, 'vertPos');
      const aCol = gl.getAttribLocation(prog, 'vertColor');
      const aUV = gl.getAttribLocation(prog, 'texCoord');
      const aLim = gl.getAttribLocation(prog, 'texLimit');
      const aNrm = gl.getAttribLocation(prog, 'normal');
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'mView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'mProj'), false, renderer.projMatrix);
      gl.uniform1f(gl.getUniformLocation(prog, 'pixelSize'), renderer.pixelSize || 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, renderer.atlasTexture);
      gl.uniform1i(gl.getUniformLocation(prog, 'sampler'), 0);
      gl.uniform1f(gl.getUniformLocation(prog, 'uAlpha'), 1);
      gl.uniform1f(gl.getUniformLocation(prog, 'uBright'), 1);
      gl.uniform1f(gl.getUniformLocation(prog, 'uMinLight'), 1);   // 补面就是"原样"的表面，不打光晕
      gl.bindBuffer(gl.ARRAY_BUFFER, capVbo);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, GHOST_STRIDE, 0); gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, GHOST_STRIDE, 12); gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, GHOST_STRIDE, 24); gl.enableVertexAttribArray(aUV);
      gl.vertexAttribPointer(aLim, 4, gl.FLOAT, false, GHOST_STRIDE, 32); gl.enableVertexAttribArray(aLim);
      gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, GHOST_STRIDE, 48); gl.enableVertexAttribArray(aNrm);
      gl.drawArrays(gl.TRIANGLES, 0, capStats.quads * 6);
    } catch { /* 尽力而为 */ } finally {
      try { gl.enable(gl.CULL_FACE); resetVertexAttrs(); } catch { /* 同上 */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 投影虚影 v2：**带方块贴图**（2026-10-12。用户「投影虚影看不清」⇒ 拍板「带方块贴图的虚影」）
  //
  // 与 v1（自己造的 1×1×1 纯色盒 VBO）的差别只有一句话：几何不再是我们造的盒子，
  // 而是**库自己的模型管线**产物 —— 台阶是台阶、栅栏是栅栏，贴图/朝向/UV 全对。
  //
  // 为什么这么接（全部核对过 deepslate 0.27.2 的源码；npm 包 dist 的 sha256 与我方 vendor
  // 逐字节一致 b8ea9489e8877615 / 281412 B —— 读的就是运行时装的那一份，不是"某个版本大概如此"）：
  //   · `new D.Structure(size)` + `addBlock(pos, id, props)` 装方块；
  //   · `new D.StructureRenderer(gl, st, resources, {chunkSize:[16,1,16], useInvisibleBlockBuffer:false})`
  //     构造时就把每个 chunk 的网格建好（模型 / UV / cull / 特殊渲染全走库的既有代码，我们不重写）；
  //   · **但不拿库的 chunk mesh 直接画**：它每个 quad 4 顶点 + **Uint16 索引**
  //     （`Mesh.rebuild` 里 `new Uint16Array(...)`）⇒ ① 想把几百个 chunk 合成一次 draw 会索引溢出
  //     （> 65535 回绕，画面直接画错），② 逐 chunk 画会让 draw call 变成"chunk 数 × 2"
  //     （100×10×100 的投影 ≈ 上千次/帧）。所以：**读 mesh 的 quads，烘成一张无索引的大 VBO**，
  //     用 drawArrays 画 —— 顶点数没有索引上限，draw call 回到"两组各 1 次"。
  //   · 顶点格式与库的主 shader **完全一致**（15 个 float，一条 stride）：
  //       vertPos3 | vertColor3 | texCoord2 | texLimit4 | normal3
  //     `texLimit` 是"这张贴图在图集里的矩形"，片元里用它把采样点 clamp 在图集格内
  //     （不 clamp 会采到隔壁贴图 ⇒ 方块边缘出现别的方块的像素）。这条不能省。
  //   · 片元着色器照抄库的（含 `a < 0.01 discard` 与 vLighting 那条公式），只多三个 uniform：
  //       uAlpha 整体透明度 / uBright 提亮 / uMinLight 暗面抬升（虚影要"看得清"，不能被暗面吃掉）。
  //   · 库的 `drawMesh` 用 `getAttribLocation(activeShader, …)` ⇒ 我们的属性名**必须**与库一致，
  //     写错就是取到 -1 —— GL 不报错，只是**静默不画**（这种"零报错的空白"最难查，所以下面每条
  //     attribute 都显式 enable/pointer，不走库的路径）。
  // ══════════════════════════════════════════════════════════════════════════════
  let ghostProg = null;                    // 自定义程序（懒编译）
  let ghostGroups = null;                  // { normal, diff, diffSolid, capped, refused, meta, origin }
  let ghostScratch = null;                 // 纯色盒的复用缓冲（见 bakeSolidGroup 里的注释）
  let ghostTexScratch = null;              // 带贴图那组的复用缓冲（见 bakeTexturedGroup 里的注释）
  const GHOST_CAP = 20000;                 // 块数粗筛（沿用 v1 的上限：超了只画差异组）
  const GHOST_QUAD_CAP = 120000;           // ★ 二次上限：带贴图后顶点是 60 B/个，得按**四边形**再卡一道
  // ★ 差异组超过这么多块就**降级为纯色盒**。
  //   ★ 2026-10-12 第二版：**1200 太低** —— 用户导入的塔形投影就有几千块，于是他看到的永远是
  //   "一片淡黄"（= 降级），也就是他第二次说"投影显示还是不行"的原因。
  //   现在提到 **10000**：配合"编辑路径延迟重建"（拖拽中不重建，停手后才重建一次），
  //   即使 10000 块要 ~55 ms，那也是**一次性的**、不落在每个鼠标事件上。
  //   降级仍然保留，只作为"超大投影别把页面拖死"的保险，并在界面里**明说**（不再让用户猜）。
  const GHOST_TEX_CAP = 10000;
  const GHOST_STRIDE = 15 * 4;             // 顶点步长（字节）：pos3+color3+uv2+uvLimit4+normal3
  // ★ 最后一次 setProjGhost 的实况 —— **即使没建出来也留着**。
  //   为什么必须留：这条管线有 try/catch 回落（模型缺失、超出上限、着色器编译失败都会"画不出来"），
  //   只看 projGhostInfo() === null 分不清是哪一步空的。本项目硬规矩：有回落就要能证明走了哪条路。
  let ghostDebug = null;
  const ghostNow = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0);

  const GHOST_VS = [
    'attribute vec4 vertPos;',
    'attribute vec2 texCoord;',
    'attribute vec4 texLimit;',
    'attribute vec3 vertColor;',
    'attribute vec3 normal;',
    'uniform mat4 mView;',
    'uniform mat4 mProj;',
    'varying highp vec2 vTexCoord;',
    'varying highp vec4 vTexLimit;',
    'varying highp vec3 vTintColor;',
    'varying highp float vLighting;',
    'void main(void) {',
    '  gl_Position = mProj * mView * vertPos;',
    '  vTexCoord = texCoord;',
    '  vTexLimit = texLimit;',
    '  vTintColor = vertColor;',
    '  vLighting = normal.y * 0.2 + abs(normal.z) * 0.1 + 0.8;',
    '}',
  ].join('\n');
  const GHOST_FS = [
    'precision highp float;',
    'varying highp vec2 vTexCoord;',
    'varying highp vec4 vTexLimit;',
    'varying highp vec3 vTintColor;',
    'varying highp float vLighting;',
    'uniform sampler2D sampler;',
    'uniform highp float pixelSize;',
    'uniform highp float uAlpha;',
    'uniform highp float uBright;',
    'uniform highp float uMinLight;',
    'void main(void) {',
    '  vec4 texColor = texture2D(sampler, clamp(vTexCoord,',
    '    vTexLimit.xy + vec2(0.5, 0.5) * pixelSize,',
    '    vTexLimit.zw - vec2(0.5, 0.5) * pixelSize));',
    '  if (texColor.a < 0.01) discard;',
    '  vec3 c = texColor.xyz * vTintColor * (max(vLighting, uMinLight) * uBright);',
    '  gl_FragColor = vec4(c, texColor.a * uAlpha);',
    '}',
  ].join('\n');
  function ensureGhostProg() {
    if (ghostProg) return ghostProg;
    const mk = (t, s) => {
      const sh = gl.createShader(t);
      gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('虚影着色器编译失败：' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, GHOST_VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, GHOST_FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('虚影着色器链接失败：' + gl.getProgramInfoLog(p));
    ghostProg = p;
    return p;
  }


  /**
   * 一致组：**纯色盒**（顶点 = 每块 36 个三角形的世界坐标，走 blit 那个单色程序）。
   * ★ 为什么这一组不用带贴图：实测（probe-bake.py，真实时间）16000 块的带贴图烘焙要 ~85 ms，
   *   而它挂在**每次编辑**后面 ⇒ 拖着放方块会顿。纯色盒只是内存拷贝（实测 < 2 ms），
   *   而且它下面是真实方块，纯色淡影本就比贴图更合适（贴图会和真实方块糊在一起）。
   */
  function bakeSolidGroup(list, size, origin) {
    if (!list || !list.length || !box) return { buf: null, n: 0, quads: 0, bytes: 0, added: 0, dropped: 0 };
    const C = box.cubeVerts;                       // 36 顶点 = 6 个面，顺序 +x -x +y -y +z -z（见 box 的定义）
    const ox = origin ? origin[0] : 0, oy = origin ? origin[1] : 0, oz = origin ? origin[2] : 0;
    // ★ scratch 复用：编辑路径上每次重建都分配 6 MB（15200 块）会把 GC 压爆 ⇒ 够用就不新建。
    const need = list.length * C.length;
    if (!ghostScratch || ghostScratch.length < need) ghostScratch = new Float32Array(Math.ceil(need * 1.3) + 108);
    const arr = ghostScratch;
    // ★★ 面剔除：一个 30x6x30 的壳如果每块都画 6 个面，半透明会叠 6 层 ⇒ 远看"一片糊"
    //   （实测截图的黄雾就是它）—— 而大投影恰恰是最需要看清"还差哪几块"的时候。
    //   同一组内有邻居就不画那一面。键用**全串**（本项目在"截断串做键"上吃过碰撞的亏）。
    const kOf = (x, y, z) => x + ',' + y + ',' + z;
    const occ = new Set();
    for (const c of list) {
      const p = (c && c.pos) ? c.pos : c;
      if (!p) continue;
      const x = p[0] - ox, y = p[1] - oy, z = p[2] - oz;
      if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) continue;
      occ.add(kOf(x, y, z));
    }
    const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let o = 0, added = 0, dropped = 0, faces = 0;
    for (const c of list) {
      const p = (c && c.pos) ? c.pos : c;
      if (!p) continue;
      const x = p[0] - ox, y = p[1] - oy, z = p[2] - oz;     // 虚影自己的坐标（整体平移到 ≥0）
      if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) { dropped++; continue; }
      added++;
      for (let f = 0; f < 6; f++) {
        if (occ.has(kOf(x + N6[f][0], y + N6[f][1], z + N6[f][2]))) continue;   // 有邻居 ⇒ 这面看不见
        faces++;
        const base = f * 18;                     // 每面 6 个顶点 × 3 分量
        for (let i = 0; i < 18; i += 3) { arr[o++] = x + C[base + i]; arr[o++] = y + C[base + i + 1]; arr[o++] = z + C[base + i + 2]; }
      }
    }
    if (!added) return { buf: null, n: 0, quads: 0, bytes: 0, added, dropped };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // ★ 只传有效前缀：scratch 比实际用到的长（它是复用的），整段传会把上一轮的垃圾也画出来
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, o), gl.STATIC_DRAW);
    // n 按**实际写入的顶点数**报（面剔除之后它不再等于 块数×36）
    return { buf, n: o / 3, quads: 0, bytes: o * 4, added, dropped, faces };
  }
  /**
   * 差异组：把一组投影方块烘成一张**带贴图**的 VBO。
   *
   * ★ 2026-10-12 第二版：**自己走"模型 → 顶点"，不经过库的 ChunkBuilder**。
   *   为什么换掉：库的路子是 `Structure` + `ChunkBuilder`，它建好每个 chunk 的 quad 之后会调
   *   `Mesh.rebuild(gl, …)` —— **为每个 chunk 创建 7 个 WebGL buffer 并把数据传上去**，
   *   而我们**只读 quads、一个都不用**。2 万块的投影有几百个 chunk ⇒ 白建几千个 buffer
   *   （实测：6000 块热态 88~130 ms，大头就在这）。
   *   现在：自己遍历 → `blockDefinition.getMesh(...)` → 写进自己的数组 → 最后**一次** bufferData。
   *
   * 保留的库能力：**模型变体选择 / 旋转 / uvlock / 图集裁剪（texLimit）/ tint** 全在 `getMesh` 里
   *   （我们只是把它的输出搬进自己的缓冲），所以"台阶是台阶、草方块是绿的"这些行为不变。
   * 自己实现的只有一处：**面剔除（cull）** —— 逐行照抄库 `ChunkBuilder.needsCull` 的语义
   *   （同 id 且 self_culling / opaque / 双方 waterlogged），只是"邻居"换成我们这份占用表
   *   （同一组内的方块）。判据 (U22) 直接钉它的边界情形（单块 6 个 quad、两块相邻 10 个）。
   * 有意不做：特殊渲染（箱子/告示牌那类 BER）—— 虚影是"看形状"，不是复刻实体。
   *
   * 两遍结构（先收集 mesh、再精确分配缓冲）是有意的：一遍写 + 中途扩容会让"扩容后重来"
   * 变成递归（我第一版就是这么写的，极端模型下会无限递归）。
   */
  function bakeTexturedGroup(list, size, origin) {
    const empty = { buf: null, n: 0, quads: 0, bytes: 0, added: 0, dropped: 0, noModel: 0 };
    if (!list || !list.length || !box) return empty;
    const res = renderer.resources;
    const ox = origin ? origin[0] : 0, oy = origin ? origin[1] : 0, oz = origin ? origin[2] : 0;
    const kOf = (x, y, z) => x + ',' + y + ',' + z;
    // ① 占用表（cull 的邻居来源：只看同一组内）
    const occ = new Map();
    let dropped = 0;
    for (const c of list) {
      const p = c && c.pos;
      if (!p) { dropped++; continue; }
      const x = p[0] - ox, y = p[1] - oy, z = p[2] - oz;
      if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) { dropped++; continue; }
      occ.set(kOf(x, y, z), c);
    }
    if (!occ.size) return Object.assign({}, empty, { dropped });
    // ② 标识符缓存（`Identifier.parse` 每次新建对象，而方块种类通常只有几十种）
    const idCache = new Map();
    const idOf = (s) => { let v = idCache.get(s); if (!v) { v = D.Identifier.parse(s); idCache.set(s, v); } return v; };
    const N6 = [['up', 0, 1, 0], ['down', 0, -1, 0], ['west', -1, 0, 0], ['east', 1, 0, 0], ['north', 0, 0, -1], ['south', 0, 0, 1]];
    // ③ 第一遍：算 cull、取 mesh、收集（**getMesh 只调一次**）
    const collected = [];
    let totalQuads = 0, added = 0, noModel = 0, culledSolid = 0;
    for (const c of list) {
      const p = c && c.pos;
      if (!p) continue;
      const x = p[0] - ox, y = p[1] - oy, z = p[2] - oz;
      if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) continue;
      if (typeof c.id !== 'string') { noModel++; continue; }
      const def = res.getBlockDefinition(c.id);
      if (!def) { noModel++; continue; }
      const props = c.props || {};
      const wl = props.waterlogged === 'true';
      const cull = { up: false, down: false, west: false, east: false, north: false, south: false };
      let allCulled = true;
      for (const d of N6) {
        const nb = occ.get(kOf(x + d[1], y + d[2], z + d[3]));
        let cut = false;
        if (nb) {
          const nf = res.getBlockFlags(nb.id);
          if (nb.id === c.id && nf && nf.self_culling) cut = true;
          else if (nf && nf.opaque) cut = !(d[0] === 'up' && wl);
          else cut = wl && !!(nb.props && nb.props.waterlogged === 'true');
        }
        cull[d[0]] = cut;
        if (!cut) allCulled = false;
      }
      added++;
      if (allCulled) { culledSolid++; continue; }   // 六面全被挡（实心体的内部块）⇒ 一个顶点都不用写
      let mesh;
      try { mesh = def.getMesh(idOf(c.id), props, res, res, cull); } catch { noModel++; continue; }
      if (!mesh || !mesh.quads.length) continue;
      collected.push({ mesh, x, y, z });
      totalQuads += mesh.quads.length;
    }
    if (!totalQuads) return Object.assign({}, empty, { added, dropped, noModel });
    // ④ 第二遍：精确分配 + 写入（纯内存拷贝，没有递归扩容那条路）
    const F = 15, need = totalQuads * 6 * F;
    if (!ghostTexScratch || ghostTexScratch.length < need) ghostTexScratch = new Float32Array(need + 1024);
    const arr = ghostTexScratch;
    let o = 0;
    for (const it of collected) {
      for (const q of it.mesh.quads) {
        const vs = q.vertices();
        for (let k = 0; k < 6; k++) {
          const v = vs[k === 3 ? 0 : k === 4 ? 2 : k === 5 ? 3 : k];     // 0,1,2 / 0,2,3
          const pp = v.pos.components();
          arr[o++] = pp[0] + it.x; arr[o++] = pp[1] + it.y; arr[o++] = pp[2] + it.z;
          const col = v.color || [1, 1, 1];
          arr[o++] = col[0]; arr[o++] = col[1]; arr[o++] = col[2];
          const uv = v.texture || [0, 0];
          arr[o++] = uv[0]; arr[o++] = uv[1];
          const lim = v.textureLimit || [0, 0, 0, 0];
          arr[o++] = lim[0]; arr[o++] = lim[1]; arr[o++] = lim[2]; arr[o++] = lim[3];
          const nr = v.normal ? v.normal.components() : [0, 1, 0];
          arr[o++] = nr[0]; arr[o++] = nr[1]; arr[o++] = nr[2];
        }
      }
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, o), gl.STATIC_DRAW);
    return { buf, n: o / F, quads: totalQuads, bytes: o * 4, added, dropped, noModel, culledSolid };
  }
  /** 释放两组 VBO（不动共用渲染器）。 */
  function dropGhost() {
    if (!ghostGroups) return;
    for (const g of [ghostGroups.normal, ghostGroups.diff, ghostGroups.diffSolid]) if (g && g.buf) { try { gl.deleteBuffer(g.buf); } catch { /* 尽力而为 */ } }
    ghostGroups = null;
  }
  /** 彻底释放（换尺寸/卸载时用；与 dropGhost 分开，因为后者要保持渲染器复用）。 */
  function disposeGhost() {
    dropGhost();
  }
  /**
   * 设置投影虚影（**带贴图**版）。
   * `cells` = 「与建筑一致」的投影方块、`diffCells` = 「缺的/错的」；每项 `{ pos:[x,y,z], id, props }`。
   * `size` = 虚影 structure 的尺寸（要能装下两组里最大的那个索引；缺省用当前世界尺寸）。
   * 传空 = 清掉。块数过多时**只画差异组**（那才是用户真正要看的），并标 capped。
   */
  function setProjGhost(cells, diffCells, size, origin) {
    const keep = Array.isArray(cells) ? cells : [];
    const diff = Array.isArray(diffCells) ? diffCells : [];
    const org = (Array.isArray(origin) && origin.length === 3) ? [origin[0] | 0, origin[1] | 0, origin[2] | 0] : [0, 0, 0];
    const sz = (Array.isArray(size) && size.length === 3 && size.every((v) => Number.isFinite(v) && v > 0))
      ? [size[0] | 0, size[1] | 0, size[2] | 0]
      : (current ? current.getSize().slice() : [16, 16, 16]);
    const capped = (keep.length + diff.length) > GHOST_CAP;
    const t0 = ghostNow();
    dropGhost();
    let gn = null, gd = null, gs = null, err = null;
    try {
      const useTex = diff.length <= GHOST_TEX_CAP;
      // 差异组**先烘**：即使整体超限，它也该在。规模大 ⇒ 降级纯色盒（见 GHOST_TEX_CAP 的实测注释）
      gd = useTex ? bakeTexturedGroup(diff, sz, org) : null;
      gs = useTex ? null : bakeSolidGroup(diff, sz, org);
      gn = capped ? null : bakeSolidGroup(keep, sz, org);   // 一致组走纯色盒（便宜、每次编辑都重建它）
    } catch (e) { err = String((e && e.message) || e); gn = null; gd = null; }
    const meta = {
      cells: keep.length, diffCells: diff.length,
      diffMode: (gd && gd.buf) ? 'texture' : (gs && gs.buf ? 'solid' : 'none'),
      texCap: GHOST_TEX_CAP,
      added: ((gn && gn.added) || 0) + ((gd && gd.added) || 0),
      noModel: ((gn && gn.noModel) || 0) + ((gd && gd.noModel) || 0),
      dropped: ((gn && gn.dropped) || 0) + ((gd && gd.dropped) || 0),
      over: ((gn && gn.over) || 0) + ((gd && gd.over) || 0),
      quads: ((gn && gn.quads) || 0) + ((gd && gd.quads) || 0),
      bakeMs: Math.round(ghostNow() - t0),
    };
    // ★ 诊断要在**分流之前**记：下面有两条返回路径（成功 / 全空），只记一条就会漏掉"为什么空"。
    ghostDebug = {
      at: (typeof Date !== 'undefined') ? Date.now() : 0,
      size: [sz[0], sz[1], sz[2]], capped, err, ok: false,
      cells: keep.length, diffCells: diff.length,
      normalMode: 'solid', diffMode: (gd && gd.buf) ? 'texture' : (gs && gs.buf ? 'solid' : 'none'),
      normal: gn ? { buf: !!gn.buf, quads: gn.quads, noModel: gn.noModel, dropped: gn.dropped, refused: !!gn.refused } : null,
      diff: gd ? { buf: !!gd.buf, quads: gd.quads, noModel: gd.noModel, dropped: gd.dropped, refused: !!gd.refused } : null,
      // 降级路径（差异组走纯色盒）也要记下来：不然判据会把"正常降级"读成"什么都没画"
      diffSolid: gs ? { buf: !!gs.buf, added: gs.added, dropped: gs.dropped } : null,
    };
    const refused = !!((gn && gn.refused) || (gd && gd.refused));
    if ((!gn || !gn.buf) && (!gd || !gd.buf) && (!gs || !gs.buf)) {
      ghostGroups = null;
      if (err) throw new Error(err);
      return false;
    }
    ghostGroups = {
      normal: (gn && gn.buf) ? { buf: gn.buf, n: gn.n, quads: gn.quads, bytes: gn.bytes } : null,
      // diff 与 diffSolid **互斥**（GHOST_TEX_CAP 分流）：前者带贴图、后者纯色盒
      diff: (gd && gd.buf) ? { buf: gd.buf, n: gd.n, quads: gd.quads, bytes: gd.bytes } : null,
      diffSolid: (gs && gs.buf) ? { buf: gs.buf, n: gs.n, quads: 0, bytes: gs.bytes } : null,
      capped: capped || refused, refused, meta, origin: org,
    };
    ghostDebug.ok = true;
    render();
    return true;
  }
  /**
   * 画**纯色盒**那两组（顶点已烘焙到世界坐标 ⇒ model 传单位矩阵，各一次 draw）：
   *   · 一致组 = 很淡的蓝（"投影覆盖了哪一片"的底影）；
   *   · 差异组 = **降级时**才在这里（规模超过 GHOST_TEX_CAP）—— 用橙黄 + 更实，
   *     比 v1 那个 0.34 的淡色醒目得多（v1 被用户说"看不清"的就是这个色）。
   */
  function drawSolidGhost(view) {
    if (!ghostGroups || !box) return;
    const g = ghostGroups.normal, ds = ghostGroups.diffSolid;
    // 顶点烘在**虚影自己的坐标**里（整体平移过）⇒ 这里用 model 平移回世界的索引坐标
    const org = ghostGroups.origin || [0, 0, 0];
    const model = mat4.fromTranslation(mat4.create(), [org[0], org[1], org[2]]);
    try {
      // ★ 这两组都传 noOffset=true：要**被真实方块遮住**（只显示空缺处），不然大投影的淡影
      //   会盖住已有建筑（截图实证：整栋建筑被染黄）。差异组仍保留偏移 —— 那是"错块该是什么"。
      if (g && g.buf) blit(view, g.buf, g.n, model, [0.42, 0.74, 1, 0.16], true);
      // 降级组的透明度也是实测调的：0.55 时大范围会叠成一片黄（30x6x30 的壳从外面看有 10+ 层
      // 半透明面），反而看不出**整体形状**；0.34 既保留这片都要建的提示、又不糊。
      if (ds && ds.buf) blit(view, ds.buf, ds.n, model, [1, 0.72, 0.25, 0.34], true);
    } catch { /* 尽力而为 */ }
  }
  /**
   * 画投影虚影（带贴图）。插在**真实结构之后**：这样"缺的方块"会被真实方块正确遮挡，
   * 而"错的方块"位置因为 polygonOffset 会压过原方块显示出来（用户要看的正是"这里该是什么"）。
   * ★ 关掉背面剔除：虚影要"封闭可看"（从里往外看也在），且个别模型的面绕序不一致，
   *   开着会整面消失（虚影缺一块比多画一层代价大得多）。
   */
  function drawTexturedGhost(view) {
    if (!ghostGroups) return;
    const g1 = ghostGroups.normal, g2 = ghostGroups.diff;
    if ((!g1 || !g1.buf) && (!g2 || !g2.buf)) return;
    safeDrawGhost(view, g1, g2);
  }
  /** 真正画（错误不外抛：虚影画不出来不该让整个世界不显示）。 */
  function safeDrawGhost(view, g1, g2) {
    let prog;
    try { prog = ensureGhostProg(); } catch { return; }
    try {
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);                       // 不写深度：后面的网格/高亮照常画
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1.5, -1.5);
      gl.disable(gl.CULL_FACE);
      const aPos = gl.getAttribLocation(prog, 'vertPos');
      const aCol = gl.getAttribLocation(prog, 'vertColor');
      const aUV = gl.getAttribLocation(prog, 'texCoord');
      const aLim = gl.getAttribLocation(prog, 'texLimit');
      const aNrm = gl.getAttribLocation(prog, 'normal');
      // 顶点烘在虚影自己的坐标里 ⇒ 把 origin 并进 mView（比给着色器加一个 model 矩阵省事，
      // 效果一样：先平移顶点、再做视图变换）。gl-matrix 的 mat4 是列主序，multiply(a,b) = a*b。
      const org = ghostGroups.origin || [0, 0, 0];
      const orgT = mat4.fromTranslation(mat4.create(), [org[0], org[1], org[2]]);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'mView'), false, mat4.multiply(mat4.create(), view, orgT));
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'mProj'), false, renderer.projMatrix);
      gl.uniform1f(gl.getUniformLocation(prog, 'pixelSize'), renderer.pixelSize || 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, renderer.atlasTexture);
      gl.uniform1i(gl.getUniformLocation(prog, 'sampler'), 0);
      // 一致组：很淡（它是"投影覆盖了哪一片"的底噪，不该干扰看建筑）；
      // 差异组：醒目的贴图虚影（用户真正要看的"还差哪几块"）。
      const DRAW = [[g1, 0.22, 1.0, 0.55], [g2, 0.82, 1.10, 0.78]];
      for (const it of DRAW) {
        const g = it[0];
        if (!g || !g.buf) continue;
        gl.uniform1f(gl.getUniformLocation(prog, 'uAlpha'), it[1]);
        gl.uniform1f(gl.getUniformLocation(prog, 'uBright'), it[2]);
        gl.uniform1f(gl.getUniformLocation(prog, 'uMinLight'), it[3]);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, GHOST_STRIDE, 0); gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, GHOST_STRIDE, 12); gl.enableVertexAttribArray(aCol);
        gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, GHOST_STRIDE, 24); gl.enableVertexAttribArray(aUV);
        gl.vertexAttribPointer(aLim, 4, gl.FLOAT, false, GHOST_STRIDE, 32); gl.enableVertexAttribArray(aLim);
        gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, GHOST_STRIDE, 48); gl.enableVertexAttribArray(aNrm);
        gl.drawArrays(gl.TRIANGLES, 0, g.n);
      }
    } catch { /* 尽力而为 */ } finally {
      try {
        gl.enable(gl.CULL_FACE);                 // 恢复库的默认（真实结构那一路要用）
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        resetVertexAttrs();                      // ★ 见 resetVertexAttrs 的注释：不清会留下坏属性槽
      } catch { /* 同上 */ }
    }
  }


  let gridOrigin = [0, 0, 0];
  function setAxes(a) {
    const was = gridOrigin.join(',');
    axes = a && typeof a === 'object'
      ? { x: a.x ?? null, y: a.y ?? null, z: a.z ?? null, extent: a.extent || [0, 0, 0], origin: a.origin || [0, 0, 0] }
      : { x: null, y: null, z: null, extent: [0, 0, 0], origin: [0, 0, 0] };
    gridOrigin = axes.origin;
    if (gridOrigin.join(',') !== was) rebuildGridMesh();
    render();
  }
  /**
   * ★ 自建网格 mesh（2026-10-11：用户「原点移到网格中心」）。
   *   Deepslate 的 `getGridMesh()` 把 X 红 / Z 蓝轴画在**角落** (0,0,0)；原点居中后必须画在原点，
   *   否则「坐标系」看着还是旧的。这里用**鸭子类型**在同一个 Mesh 实例上重画（clear/addLine/rebuild
   *   都是公开且同步的），不碰 Deepslate 源码。
   *   内容：地板 1 格网格（尺寸/格距看得见）+ 世界盒子棱（当前网格尺寸看得见）
   *        + **过原点的三条轴**（MC 配色：X 红 / Y 绿 / Z 蓝）。
   */
  function rebuildGridMesh() {
    const r = renderer;
    const mesh = r && r.gridMesh;
    if (!mesh || typeof mesh.addLine !== 'function' || typeof mesh.rebuild !== 'function' || !current) return;
    const [sx, sy, sz] = current.getSize();
    const ox = gridOrigin[0], oy = gridOrigin[1], oz = gridOrigin[2];
    const g = [0.8, 0.8, 0.8];
    // ★ 间距按相机距离自适应（见 gridDistBucket）：太远画粗格线 —— 1 格线被抗锯齿吃掉就是这个问题的根。
    //   世界盒子棱不受影响（那几根大线多远都看得见）。
    const step = gridDistBucket === 2 ? 8 : (gridDistBucket === 1 ? 2 : 1);
    mesh.clear();
    for (let x = step; x <= sx; x += step) mesh.addLine(x, 0, 0, x, 0, sz, g);
    for (let z = step; z <= sz; z += step) mesh.addLine(0, 0, z, sx, 0, z, g);
    for (const c of [[0, 0], [sx, 0], [0, sz], [sx, sz]]) mesh.addLine(c[0], 0, c[1], c[0], sy, c[1], g);
    mesh.addLine(0, sy, 0, sx, sy, 0, g);
    mesh.addLine(0, sy, sz, sx, sy, sz, g);
    mesh.addLine(0, sy, 0, 0, sy, sz, g);
    mesh.addLine(sx, sy, 0, sx, sy, sz, g);
    mesh.addLine(0, 0, oz, sx, 0, oz, [1, 0.3, 0.3]);
    mesh.addLine(ox, 0, 0, ox, 0, sz, [0.35, 0.55, 1]);
    mesh.addLine(ox, oy, oz, ox, sy, oz, [0.35, 1, 0.35]);
    mesh.rebuild(gl, { pos: true, color: true });
  }
  function drawAxes(view) {
    if (!box) return;
    const ext = axes.extent || [0, 0, 0];
    const sx = ext[0] || 0, sy = ext[1] || 0, sz = ext[2] || 0;
    if (axes.x != null && sx && sy && sz) {
      const m = mat4.create();
      mat4.translate(m, m, [axes.x - 0.04, 0, 0]);
      mat4.scale(m, m, [0.08, sy, sz]);
      blit(view, box.cubeBuf, box.cubeN, m, [0.95, 0.3, 0.25, 0.14]);   // 红（对上 X 坐标轴）
    }
    // ★ 这条 y 轴分支**保留**是刻意的：setAxes 是视口的通用能力（三轴皆可画），
    //   而"要不要 Y 镜像"是**上层业务决策** —— main.js 自 2026-10-12 起恒传 y:null（Y 镜像对
    //   地面锚定编辑器没有自然语义：它的镜像面 = 世界高度/2，世界只向上长 ⇒ 建得越高面越漂）。
    //   哪天要加回 Y，只改 main.js 一处即可，不必回头动视口。
    if (axes.y != null && sx && sy && sz) {
      const m = mat4.create();
      mat4.translate(m, m, [0, axes.y - 0.04, 0]);
      mat4.scale(m, m, [sx, 0.08, sz]);
      blit(view, box.cubeBuf, box.cubeN, m, [0.3, 0.8, 0.35, 0.14]);   // 绿（对上 Y 坐标轴）
    }
    // ★ Z 镜像面（2026-10-12 用户要「底部两条线都做镜像」）：z = D/2 的竖直面，偏蓝。
    if (axes.z != null && sx && sy && sz) {
      const m = mat4.create();
      mat4.translate(m, m, [0, 0, axes.z - 0.04]);
      mat4.scale(m, m, [sx, sy, 0.08]);
      blit(view, box.cubeBuf, box.cubeN, m, [0.25, 0.45, 0.95, 0.14]);
    }
  }
  /**
   * 坐标轴指示器用：三根轴在**屏幕空间**的方向（CSS 坐标：x 向右、y 向下）。
   * 用视图矩阵的旋转部分变换世界方向向量（w=0）⇒ 与相机一起转，用户一眼能对上画面里的三条线。
   * 返回 { x:{x,y,z}, y:{...}, z:{...} }，z 分量 > 0 表示该轴背离观察者（指示器据此淡显）。
   *
   * ★ 为什么需要它（2026-10-12 用户问"z 轴不都是竖着的吗"）：我们的轴只有颜色、**没有字母**，
   *   而"X 红 / Y 绿 / Z 蓝、Y 竖直"是 **Minecraft** 的约定 —— Blender / 3ds Max 一类软件是
   *   "Z 竖直"，习惯那套的人看我们的绿线自然就当成 Z 了。加字母 + 让方向随相机转，才不会有歧义。
   */
  function axisScreenDirs() {
    const v = viewMatrix();
    const src = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const out = {};
    for (const k of ['x', 'y', 'z']) {
      const d = src[k];
      // gl-matrix 是列主序：view[col * 4 + row]
      const cx = v[0] * d[0] + v[4] * d[1] + v[8] * d[2];
      const cy = v[1] * d[0] + v[5] * d[1] + v[9] * d[2];
      const cz = v[2] * d[0] + v[6] * d[1] + v[10] * d[2];
      out[k] = { x: cx, y: -cy, z: cz };      // 屏幕 y 向下 ⇒ 取反
    }
    return out;
  }

  // ---------------------------------------------------------------- 分层（2026-10-12 重构）
  // ★ 分层 = **"提交哪些 chunk"的筛选**，不是"改数据 + 重建 mesh"。
  //   旧做法（layer.js）每次拖滑块都：遍历全部方块收集 ops → commit → 重建受影响 chunk 的 mesh
  //   ⇒ 每动一格重建一整层 chunk（大建筑上就是几百个 mesh）⇒ 明显卡顿。
  //   而"只显示 ≤N 层"根本不需要改数据：`chunkBuilder.chunks` 是 **3D 数组**（[cx][cy][cz]，
  //   每个槽位有 mesh / transparentMesh），库的 `drawStructure()` 只是 `getMeshes().forEach(drawMesh)`
  //   ⇒ 我们自己在循环里跳过"整列都在限制之上"的 chunk 即可，**零重建**。
  //   ⚠ 索引编码要注意：Deepslate 用 `|c|*2 + (c<0?1:0)` 存槽位（负数占奇数槽）⇒ 要反解出真实 chunk 坐标。
  let layerLimit = null;          // 可见的最高层（索引 y ≤ 此值）；null = 全部
  let drawStats = { chunks: 0, drawn: 0, culled: 0, meshes: 0 };
  const unzip = (i) => (i % 2 === 0 ? i / 2 : -((i + 1) / 2));   // 槽位下标 → 真实 chunk 坐标

  function drawStructureVisible(view) {
    const cb = renderer.chunkBuilder;
    const chunks = cb && cb.chunks;
    if (!chunks || !chunks.length) { renderer.drawStructure(view); return; }
    renderer.setShader(renderer.shaderProgram);
    const ps = renderer.resources && renderer.resources.getPixelSize;
    renderer.setTexture(renderer.atlasTexture, ps ? renderer.resources.getPixelSize() : undefined);
    renderer.prepareDraw(view);
    const csy = (cb.chunkSize && cb.chunkSize[1]) || 16;
    const lim = layerLimit;
    // ★ 统计分两个（2026-10-12）：`culled` = **真有内容**但被上限排除的列；
    //   `culledSlots` = **逻辑上**被上限排除的层（不管那层有没有方块）。
    //   为什么要后者：判据若只看 `culled`，就会**依赖世界内容** —— 世界只有一层时它恒为 0，
    //   而那是正确行为（实测因此假红过一轮）。`culledSlots` 只跟"上限 + 世界高度"有关，稳定。
    let drawn = 0, culled = 0, culledSlots = 0, meshes = 0;
    const syMax = current ? current.getSize()[1] : 0;
    const iyMax = Math.ceil(syMax / csy) + 2;      // 遍历到"世界高度对应的层数"（槽位是稀疏的）
    for (let cx = 0; cx < chunks.length; cx++) {
      const col = chunks[cx];
      if (!col) continue;
      const colLen = Math.max(col.length, iyMax);
      for (let iy = 0; iy < colLen; iy++) {
        const cy = unzip(iy);
        if (cy < 0) continue;                      // 负坐标的槽位（我们的世界不含负层）
        const over = lim != null && cy * csy > lim;
        if (over) culledSlots++;
        const row = col[iy];
        if (!row) continue;
        // 这一列（固定的 cx/cy）整体在限制之上 ⇒ 一次跳过整列
        if (over) { culled++; continue; }
        drawn++;
        for (let iz = 0; iz < row.length; iz++) {
          const b = row[iz];
          if (!b) continue;
          if (b.mesh && !b.mesh.isEmpty() && b.mesh.quadVertices() > 0) {
            renderer.drawMesh(b.mesh, { pos: true, color: true, texture: true, normal: true });
            meshes++;
          }
          if (b.transparentMesh && !b.transparentMesh.isEmpty() && b.transparentMesh.quadVertices() > 0) {
            renderer.drawMesh(b.transparentMesh, { pos: true, color: true, texture: true, normal: true });
            meshes++;
          }
        }
      }
    }
    drawStats = { chunks: chunks.length, drawn, culled, culledSlots, meshes };
  }

  /** 网格间距的"档位"（按相机距离）：太远时 1 格线比像素还细、被抗锯齿吃掉（用户报「网格消失」）。 */
  let gridDistBucket = -1;
  function draw() {
    const bucket = cam.dist > 96 ? 2 : (cam.dist > 32 ? 1 : 0);
    if (bucket !== gridDistBucket) { gridDistBucket = bucket; rebuildGridMesh(); }
    const [W, H] = resize();
    renderer.setViewport(0, 0, W, H);
    // 视口底色跟随主题（由 main.js 读 `#stageWrap` 的计算后背景色传进来）。
    // 之前是写死的深色 —— 宿主是浅色主题时，面板里会突兀地出现一块深色画布。
    gl.clearColor(backdrop[0], backdrop[1], backdrop[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const view = viewMatrix();
    drawStructureVisible(view);      // ★ 分层在这里生效（纯筛选，零重建）
    // ★ 投影虚影（带贴图，2026-10-12 v2）：必须**排在真实结构之后** —— 它要测深度，
    //   缺的方块才会被真实方块挡住；错的方块位置靠 polygonOffset 压过原方块显示出来。
    drawCap(view);                   // ★ 分层切口的补顶面（不透明，属于"世界表面"）
    drawSolidGhost(view);            // 一致组：淡影（纯色盒，便宜）
    drawTexturedGhost(view);         // 差异组：带贴图的模型虚影（用户要看清的"还差哪几块"）
    if (wantGrid) {
      // ★ 网格面与建筑底面**共面**（都在 y=0）⇒ 会 z-fighting 出现闪烁条纹。
      //   用多边形偏移把网格的深度往下压一点点，让建筑稳定胜出（不依赖 Deepslate 内部实现）。
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      renderer.drawGrid(view);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (outline) renderer.drawOutline(view, outline);
    // 悬停格**顶面**高亮（半透明面）+ 幽灵预览（半透明方块 / 删除红调），用极简 GL 程序叠加。
    drawOverlay(view);
    drawAxes(view);
  }
  /**
   * ★ 渲染改成**持续 rAF 帧循环**（原来是"按需重绘 + rAF 去重"）。
   *   原因：按需重绘在部分驱动/合成器上会让 canvas 在两次绘制之间被合成出空帧 → 肉眼是**闪屏**；
   *   持续绘制每帧都有新内容，从根上不会闪。代价是常驻一次重绘（本场景只是重放缓存的 chunk 缓冲，很便宜）。
   *   保留 render() 是为了不改上层调用点，它现在什么都不用做。
   */
  function render() { /* 已由持续帧循环接管 */ }
  let rafId = 0;
  let lastTs = 0;
  /**
   * 阻尼趋近（feel.damping > 0 时才有效）：把 cam 向 want 按**时间无关的指数系数**逼近 ——
   *   k = 1 − exp(−λ·dt)，λ 由"每帧系数 @60fps"换算 ⇒ 120Hz / 掉帧下手感一致。
   * 收敛后直接贴合（防长期浮点漂移导致永远"差一点"）。
   */
  function applyDamping(ts) {
    if (!(FEEL.damping > 0)) { lastTs = ts; return; }
    const dt = lastTs ? Math.min(64, Math.max(8, ts - lastTs)) : 16.7;
    lastTs = ts;
    const k = 1 - Math.exp(-(FEEL.damping * 60 / 1000) * dt);
    cam.yr += (want.yr - cam.yr) * k;
    cam.xr += (want.xr - cam.xr) * k;
    cam.dist += (want.dist - cam.dist) * k;
    for (let i = 0; i < 3; i++) cam.target[i] += (want.target[i] - cam.target[i]) * k;
    if (Math.abs(want.yr - cam.yr) < 1e-4) cam.yr = want.yr;
    if (Math.abs(want.xr - cam.xr) < 1e-4) cam.xr = want.xr;
    if (Math.abs(want.dist - cam.dist) < 1e-3) cam.dist = want.dist;
    if (Math.abs(want.target[0] - cam.target[0]) + Math.abs(want.target[1] - cam.target[1]) + Math.abs(want.target[2] - cam.target[2]) < 1e-3) {
      cam.target[0] = want.target[0]; cam.target[1] = want.target[1]; cam.target[2] = want.target[2];
    }
  }
  // 每帧回调（主模块用它更新左下角的坐标轴指示器 —— 那是 DOM 覆盖层，不是 GL 内容）
  let frameCb = null;
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    applyDamping(ts || performance.now());
    draw();
    if (frameCb) { try { frameCb(); } catch { /* 指示器失败不该影响渲染 */ } }
  }
  function startLoop() { if (!rafId) loop(); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
  /**
   * 卸载清理：停帧循环 + 断开 ResizeObserver + 摘掉 window 监听。
   * ★ 之前 `stopLoop` 定义了但**没有任何调用方** ⇒ 组件卸载后 rAF 循环仍在每帧绘制（GPU 一直占着）。
   *   功能包组件卸载时由 main.js#shutdown() 调这里。
   */
  function dispose() {
    stopLoop();
    try { if (resizeObs) resizeObs.disconnect(); } catch { /* 尽力而为 */ }
    resizeObs = null;
    try {
      if (box) { gl.deleteBuffer(box.cubeBuf); gl.deleteBuffer(box.topBuf); gl.deleteProgram(box.p); }
    } catch { /* GL 资源随上下文回收，删不掉也无害 */ }
    for (const f of cleanups.splice(0)) f();
  }
  /**
   * ★ 把 GL 的顶点属性开关**全部关掉**（0..MAX_VERTEX_ATTRIBS-1）。
   *   为什么必须：Deepslate 重建网格时会 `gl.deleteBuffer(...)`（`Mesh.rebuild` 在列表为空时删缓冲），
   *   而 GL 的 `enableVertexAttribArray` 状态是**全局且跨 program 保留**的 —— 被删的 buffer 仍可能挂在
   *   某个已启用的属性槽上 ⇒ 之后**每一次** drawArrays 都报
   *     `INVALID_OPERATION: no buffer is bound to enabled attribute`（实测 12 条/帧），
   *   最终 `Abnormal renderer termination`、页面卡死（DOM 永远出不来）。
   *   实测判据：把"世界长大"整个禁掉 ⇒ 0 报错、页面正常；一旦让 `setStructure` 真的执行 ⇒ 复现。
   *   全关掉是安全的：Deepslate 的 `drawMesh` 每次绘制前都 `setVertexAttr`（重新 enable + bind）。
   */
  function resetVertexAttrs() {
    if (!gl) return;
    const n = (typeof gl.getParameter === 'function' ? gl.getParameter(gl.MAX_VERTEX_ATTRIBS) : 16) || 16;
    for (let i = 0; i < n; i++) { try { gl.disableVertexAttribArray(i); } catch { /* 越界就跳过 */ } }
  }
  function setStructure(next) {
    current = next;
    renderer.setStructure(next);
    resetVertexAttrs();     // ★ 见上面的注释：不关会留下「已启用但 buffer 已删」的属性槽
    rebuildGridMesh();      // renderer.setStructure 会把 gridMesh 换成 Deepslate 默认的（角落轴）⇒ 覆盖回来
    render();
  }
  function updateBuffers(chunks) {
    if (!chunks || !chunks.length) { renderer.updateStructureBuffers(); }
    else renderer.updateStructureBuffers(chunks);
    render();
  }
  function fit() {
    const [sx, sy, sz] = current.getSize();
    cam.target = [sx / 2, sy / 2, sz / 2];
    baseDist = Math.max(6, Math.max(sx, sy, sz) * 2.2);
    cam.dist = baseDist;
    cam.zoom = 1;
    cam.xr = 0.9; cam.yr = 0.6;          // 「适应建筑」重置 yaw/pitch
    syncWant();
    render();
  }
  /** 非空方块的包围盒（忽略空气；全空返回 null）。fitContent 用。 */
  function contentBounds() {
    const bs = current.getBlocks();
    if (!bs || !bs.length) return null;
    let mn = null, mx = null;
    for (const b of bs) {
      const nm = b.state && b.state.getName ? b.state.getName().toString() : '';
      if (isAir(nm)) continue;
      const p = b.pos;
      if (!mn) { mn = [p[0], p[1], p[2]]; mx = [p[0], p[1], p[2]]; continue; }
      if (p[0] < mn[0]) mn[0] = p[0]; else if (p[0] > mx[0]) mx[0] = p[0];
      if (p[1] < mn[1]) mn[1] = p[1]; else if (p[1] > mx[1]) mx[1] = p[1];
      if (p[2] < mn[2]) mn[2] = p[2]; else if (p[2] > mx[2]) mx[2] = p[2];
    }
    return mn ? { min: mn, max: mx } : null;
  }
  /**
   * ★ 手感实验室：「适应建筑」按**内容包围盒**取景（而不是整个世界尺寸）。
   *   症状：世界可以往外长大 ⇒ 按世界尺寸取景时，"大世界里一个小建筑"永远居中小小一团。
   *   全空时退回按世界尺寸（与 fit() 相同）。
   */
  function fitContent() {
    const b = contentBounds();
    if (!b) { fit(); return; }
    const c = [(b.min[0] + b.max[0] + 1) / 2, (b.min[1] + b.max[1] + 1) / 2, (b.min[2] + b.max[2] + 1) / 2];
    const ext = Math.max(b.max[0] - b.min[0] + 1, Math.max(b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1));
    const m = renderer.projMatrix;
    const tanHalf = (m && m[5]) ? 1 / m[5] : 0.7;
    baseDist = Math.max(4, (ext / 2) / tanHalf * 1.25);   // 留 25% 边距
    cam.target = c.slice();
    cam.dist = baseDist;
    cam.zoom = 1;
    cam.xr = 0.9; cam.yr = 0.6;
    syncWant();
    render();
  }
  /** ★ 手感实验室：视角吸附到最近的轴（MagicaVoxel「4」键语义）：yaw 取最近 90°、pitch 取三档。 */
  function snapAxis() {
    const HALF = Math.PI / 2;
    cam.yr = Math.round(cam.yr / HALF) * HALF;
    cam.xr = cam.xr > 1.15 ? 1.35 : (cam.xr > 0.55 ? 0.75 : 0.30);
    syncWant();
    render();
  }
  /** 立即把 yaw 挪 d 弧度（阻尼开启时也瞬时生效——Q·E 微调用 / 手感实验室）。 */
  function nudgeYaw(d) {
    cam.yr += d;
    want.yr += d;
    render();
  }

  // ---------------------------------------------------------------- 定向视角（ViewCube 用）
  // 为什么不让 ViewCube 直接写 cam.yr/xr：那样没有过渡动画，视角"啪"地跳过去，
  // 会让人丢失"我刚才在看哪"的空间感（3D 软件都是转过去的）。
  // 为什么自己补一套 rAF+setTimeout 双通道：底下那套阻尼（applyDamping）只在 startLoop 跑着时推进，
  //   而闸门/静态渲染路径不一定在跑循环 ⇒ 只挂阻尼的话动画会永远停在中途。
  //   双通道与"分层滑块"用的是同一个已验证写法：谁先到谁执行，另一个立刻取消。
  let tweenRaf = 0, tweenTimer = 0, tweenTo = null;
  const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  /**
   * 切到指定视角：`yr` = 水平角（弧度，可任意）、`xr` = 俯仰（会用 PITCH_MIN/MAX 夹住）。
   * opts.duration（默认 260ms）设 0 或 opts.animate === false 则瞬时到位。
   * 返回**目标值**（不是当前值）——调用方据此做"到位没有"的判断。
   */
  function setAngles(yr, xr, opts) {
    const o = opts || {};
    const dur = o.animate === false ? 0 : (o.duration == null ? 260 : Math.max(0, o.duration));
    let ty = Number(yr) || 0;
    const tx = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Number(xr) || 0));
    if (o.shortest !== false) {   // 走最近的角（否则从 170° 转到 -170° 会绕一整圈）
      const d = ((ty - cam.yr) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      ty = cam.yr + d;
    }
    if (tweenRaf) { cancelAnimationFrame(tweenRaf); tweenRaf = 0; }
    if (tweenTimer) { clearTimeout(tweenTimer); tweenTimer = 0; }
    if (dur <= 0) {
      cam.yr = ty; cam.xr = tx; tweenTo = null; syncWant(); render();
      return { yr: ty, xr: tx, animated: false };
    }
    const y0 = cam.yr, x0 = cam.xr, t0 = nowMs();
    tweenTo = { yr: ty, xr: tx };
    const step = () => {
      if (tweenRaf) { cancelAnimationFrame(tweenRaf); tweenRaf = 0; }
      if (tweenTimer) { clearTimeout(tweenTimer); tweenTimer = 0; }
      const k = Math.min(1, (nowMs() - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);   // ease-in-out
      cam.yr = y0 + (ty - y0) * e;
      cam.xr = x0 + (tx - x0) * e;
      syncWant();
      render();
      if (k < 1) { tweenRaf = requestAnimationFrame(step); tweenTimer = setTimeout(step, 32); }
      else { cam.yr = ty; cam.xr = tx; tweenTo = null; syncWant(); render(); }
    };
    step();
    return { yr: ty, xr: tx, animated: true };
  }
  /** 视角动画状态（闸门据此判"动画真的跑完了"而不是"设了个目标值"）。 */
  function angleTween() { return { active: !!tweenTo, target: tweenTo ? [tweenTo.yr, tweenTo.xr] : null }; }
  /**
   * 由"相机应该待在哪一侧"反算 (yr, xr)。
   * 推导：视线矩阵 M = Rx(xr)·Ry(yr)，相机在世界坐标 target + M⁻¹·(0,0,dist) 处 ⇒
   *   目标→相机 的单位向量 c = (-sin(yr)·cos(xr), sin(xr), cos(yr)·cos(xr))。
   * 反解：xr = asin(c.y)，yr = atan2(-c.x, c.z)。ViewCube 点哪个方向就喂哪个 c。
   */
  function anglesFor(c) {
    const L = Math.hypot(c[0], c[1], c[2]) || 1;
    const x = c[0] / L, y = c[1] / L, z = c[2] / L;
    return { yr: Math.atan2(-x, z), xr: Math.asin(Math.max(-1, Math.min(1, y))) };
  }
  /** 轨道旋转（右键拖 / 浏览工具左键拖 / Alt+左键）：yaw 连续，俯仰 clamp [0.10,1.45] rad */
  function orbit(dxPx, dyPx) {
    const dy = dyPx * PITCH_PER_PX;
    if (FEEL.damping > 0) {
      want.yr += dxPx * ROT_PER_PX;
      want.xr = Math.max(PITCH_MIN, Math.min(PITCH_MAX, want.xr + dy));
    } else {
      cam.yr += dxPx * ROT_PER_PX;
      cam.xr = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cam.xr + dy));
    }
    render();
  }
  /** 相机世界位置（从 viewMatrix 反解；不手推球面公式，避免与视图矩阵的顺序不一致）。 */
  function camPos() {
    const inv = mat4.invert(mat4.create(), viewMatrix());
    return inv ? [inv[12], inv[13], inv[14]] : cam.target.slice();
  }
  /** 视线单位向量（相机看向 target 的方向）= 视图矩阵第三列取反。 */
  function camForward() {
    const v = viewMatrix();
    const u = [-v[2], -v[6], -v[10]];
    const len = Math.hypot(u[0], u[1], u[2]) || 1;
    return [u[0] / len, u[1] / len, u[2] / len];
  }
  /** client 坐标 → 世界射线 {A, dir（单位方向）}。朝光标缩放的锚点计算用。 */
  function rayAt(clientX, clientY) {
    const r0 = canvasRect();
    const ndcX = ((clientX - r0.left) / r0.width) * 2 - 1;
    const ndcY = -(((clientY - r0.top) / r0.height) * 2 - 1);
    const A = unproject(ndcX, ndcY, -1);
    const B = unproject(ndcX, ndcY, 1);
    if (!A || !B) return null;
    const dir = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!len) return null;
    return { A, dir: [dir[0] / len, dir[1] / len, dir[2] / len] };
  }
  /**
   * 滚轮缩放：zoom ∈ [0.25, 2.4]（zoom=1 对应 fit 时的距离）。
   * ★ 手感实验室：feel.zoomCursor 开启且给了光标坐标时走「朝光标缩放」——
   *   把光标下的世界点 P 钉在屏幕上（相机沿**光标射线**推拉、target 一起挪）。
   *   推导（与 three.js OrbitControls#zoomToCursor 同构）：设 u=视线、r=光标射线、t_P=P 到相机的
   *   距离、d0→d1 为相机-目标距离：ΔT = (1 − d1/d0)·(t_P·r − d0·u)，dist=d1，朝向 (xr,yr) 不变。
   *   自校验：光标在屏幕中心（r≈u）⇒ ΔT=0（退化为普通缩放）；无缩放（d1=d0）⇒ ΔT=0。
   */
  function zoomBy(k, clientX, clientY) {
    if (!baseDist) baseDist = cam.dist || 20;
    const d0 = cam.dist;
    cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom * k));
    const d1 = baseDist / cam.zoom;
    let dT = null;
    if (FEEL.zoomCursor && clientX != null && d1 !== d0) {
      const ray = rayAt(clientX, clientY);
      const C = camPos();
      const u = camForward();
      if (ray && C) {
        // 锚点距离 t_P：优先真实命中（体素步进）；退化到"过 target 的垂面"交点 t_P = d0 / dot(r,u)
        let tP = null;
        const hit = pick(clientX, clientY);
        if (hit) {
          const P = [hit.pos[0] + 0.5, hit.pos[1] + 0.5, hit.pos[2] + 0.5];
          tP = (P[0] - C[0]) * ray.dir[0] + (P[1] - C[1]) * ray.dir[1] + (P[2] - C[2]) * ray.dir[2];
        }
        if (!(tP > 0)) {
          const den = ray.dir[0] * u[0] + ray.dir[1] * u[1] + ray.dir[2] * u[2];
          tP = den > 0.15 ? d0 / den : d0;   // 射线几乎垂直于视线 ⇒ 退回"相机前方 d0 处"
        }
        const f = 1 - d1 / d0;
        dT = [0, 0, 0];
        for (let i = 0; i < 3; i++) dT[i] = f * (tP * ray.dir[i] - d0 * u[i]);
      }
    }
    if (FEEL.damping > 0) {
      want.dist = d1;
      if (dT) for (let i = 0; i < 3; i++) want.target[i] += dT[i];
    } else {
      cam.dist = d1;
      if (dT) for (let i = 0; i < 3; i++) cam.target[i] += dT[i];
    }
    render();
  }
  // 拾取要用 clientX/Y 与画布矩形 → 走同一份尺寸缓存（页面不滚动，left/top 只在测量时更新），
  // 否则每次 pointermove 都 getBoundingClientRect() = 每帧强制布局。
  function canvasRect() {
    if (cssW <= 0 || cssH <= 0) measure();
    return { left: cssLeft, top: cssTop, width: cssW || 1, height: cssH || 1 };
  }

  // ---- 反投影 + 体素步进拾取 ----
  function unproject(ndcX, ndcY, ndcZ) {
    const vp = mat4.multiply(mat4.create(), renderer.projMatrix, viewMatrix());
    const inv = mat4.invert(mat4.create(), vp);
    if (!inv) return null;
    const m = inv;
    const x = m[0] * ndcX + m[4] * ndcY + m[8] * ndcZ + m[12];
    const y = m[1] * ndcX + m[5] * ndcY + m[9] * ndcZ + m[13];
    const z = m[2] * ndcX + m[6] * ndcY + m[10] * ndcZ + m[14];
    const w = m[3] * ndcX + m[7] * ndcY + m[11] * ndcZ + m[15];
    if (!w) return null;
    return [x / w, y / w, z / w];
  }
  /** 世界坐标 → 画布 client 坐标（与 unproject 同一套 proj·view；闸门算"某世界格的屏幕点"用）*/
  function project(p) {
    const r = canvasRect();
    const vp = mat4.multiply(mat4.create(), renderer.projMatrix, viewMatrix());
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (!w) return null;
    return [r.left + ((x / w) + 1) / 2 * r.width, r.top + (1 - y / w) / 2 * r.height];
  }
  const isAir = (id) => /(^|:)air$/.test(id) || /cave_air$|void_air$/.test(id);

  /** clientX/Y → { pos:[x,y,z], normal:[nx,ny,nz] } | null */
  function pick(clientX, clientY) {
    const r = canvasRect();
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((clientY - r.top) / r.height) * 2 - 1);
    const A = unproject(ndcX, ndcY, -1);
    const B = unproject(ndcX, ndcY, 1);
    if (!A || !B) return null;
    const dir = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const len = Math.hypot(...dir);
    if (!len) return null;
    dir[0] /= len; dir[1] /= len; dir[2] /= len;

    const [sx, sy, sz] = current.getSize();
    const size = [sx, sy, sz];
    // ★ 求与 AABB 的交点，并记下**从哪个轴进入** —— 这一轴就是"命中面的法线"。
    //   踩过的坑：原来只在大步进之后才记法线，于是"第一个格子里就有方块"时法线是 [0,0,0]，
    //   放置目标 = pos + [0,0,0] = **同一格** ⇒ 表现为"放置直接把原来的方块替换掉"。
    let t0 = -Infinity, t1 = Infinity, entryAxis = -1;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-9) {
        if (A[a] < 0 || A[a] > size[a]) return null;
        continue;
      }
      let ta = (0 - A[a]) / dir[a], tb = (size[a] - A[a]) / dir[a];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) { t0 = ta; entryAxis = a; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    const inside = t0 < 0;                       // 相机已在盒内 ⇒ 没有"进入面"
    let t = (inside ? 0 : t0) + 1e-4;
    const p = [A[0] + dir[0] * t, A[1] + dir[1] * t, A[2] + dir[2] * t];
    const v = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
    const step = [Math.sign(dir[0]), Math.sign(dir[1]), Math.sign(dir[2])];
    const tDelta = [Math.abs(1 / dir[0]), Math.abs(1 / dir[1]), Math.abs(1 / dir[2])];
    const tMax = [0, 1, 2].map(a => Math.abs(dir[a]) < 1e-9 ? Infinity
      : (step[a] > 0 ? (v[a] + 1 - p[a]) : (p[a] - v[a])) * tDelta[a] + t);
    let normal = [0, 0, 0];
    if (!inside && entryAxis >= 0) normal[entryAxis] = -Math.sign(dir[entryAxis]);
    const guard = 4 * (sx + sy + sz) + 32;
    for (let i = 0; i < guard; i++) {
      if (v[0] >= 0 && v[0] < sx && v[1] >= 0 && v[1] < sy && v[2] >= 0 && v[2] < sz) {
        const rec = current.blocksMap[(v[0] * sy + v[1]) * sz + v[2]];
        if (rec) {
          const st = current.palette[rec.state];
          const id = st && st.getName ? st.getName().toString() : '';
          // ★ 分层时**隐藏层上的方块不参与拾取**：否则会出现"点在刚被隐藏的方块上、却选中了看不见的东西"
          //   （旧的"视图过滤"实现天然没有这个问题，因为它根本没把隐藏层的方块放进结构里）。
          if (!isAir(id) && (layerLimit == null || v[1] <= layerLimit)) return { pos: v.slice(), normal: normal.slice() };
        }
      }
      const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      v[a] += step[a];
      tMax[a] += tDelta[a];
      normal = [0, 0, 0];
      normal[a] = -step[a];
    }
    return null;
  }

  /**
   * 与水平面 `y = planeY` 求交，返回该处的**格子坐标**（floor(x), floor(planeY), floor(z)）。
   *
   * ★ 用途（2026-10-10）：起始世界改成**空世界**后，一个方块都没有 ⇒ `pick()` 永远返回 null
   *   ⇒ 点哪儿都"没点到方块"，**永远放不下第一块**。这条给"点地面平面 → 在底部层放方块"用：
   *   硬约束就是"底部层（y=0）永远可放"，不依赖场景里已经有方块。
   */
  function pickPlane(clientX, clientY, planeY = 0) {
    const r = canvasRect();
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((clientY - r.top) / r.height) * 2 - 1);
    const A = unproject(ndcX, ndcY, -1);
    const B = unproject(ndcX, ndcY, 1);
    if (!A || !B) return null;
    const dy = B[1] - A[1];
    if (Math.abs(dy) < 1e-9) return null;              // 视线与平面平行
    const t = (planeY - A[1]) / dy;
    if (t < 0) return null;                            // 平面在相机身后
    const px = A[0] + (B[0] - A[0]) * t;
    const pz = A[2] + (B[2] - A[2]) * t;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
    return [Math.floor(px), Math.floor(planeY), Math.floor(pz)];
  }

  /**
   * 抓取式平移（右键 / 中键拖拽）。
   * ★ 之前这里只用了 yaw、还没考虑 pitch，拉起来"很怪"；现在按**相机的 right/up 轴**算：
   *   right = R_x(xr)·R_y(yr)·(1,0,0)，up = R_x(xr)·(0,1,0)；位移按 `2·dist·tan(fov/2)/画布高` 归一，
   *   于是"拖多少像素 ≈ 目标平面上移动多少世界单位"，手感与地图类工具一致。
   *   `tan(fov/2)` 直接从投影矩阵取（projMatrix[5] = 1/tan(fovY/2)），不依赖 Deepslate 的内部常量。
   */
  function panBy(dxPx, dyPx) {
    const h = cssSize()[1] || 1;
    const m = renderer.projMatrix;
    const tanHalf = (m && m[5]) ? 1 / m[5] : 0.7;
    const k = (2 * cam.dist * tanHalf) / h;
    const cy = Math.cos(cam.yr), sy = Math.sin(cam.yr);
    const cx = Math.cos(cam.xr), sx = Math.sin(cam.xr);
    const right = [cy, sx * sy, -cx * sy];
    const up = [0, cx, sx];
    for (let i = 0; i < 3; i++) cam.target[i] += -right[i] * dxPx * k + up[i] * dyPx * k;
    syncWant();   // 平移 = 抓取语义（1:1 跟手）：不进阻尼；want 拉齐，防止阻尼把 target 拉回去
    render();
  }

  /**
   * 按**世界单位**沿相机基向量移动（键盘用）：fwd=视线方向、strafe=右、vert=上。
   * 与鼠标平移共用同一套基向量，手感一致。
   */
  function moveLocal(fwd, strafe, vert) {
    const cy = Math.cos(cam.yr), sy = Math.sin(cam.yr);
    const cx = Math.cos(cam.xr), sx = Math.sin(cam.xr);
    const right = [cy, sx * sy, -cx * sy];
    const up = [0, cx, sx];
    // 视线方向 = right × up 的反向（相机在 target + R*(0,0,dist) 处朝 target 看）
    const f = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
    const sign = cam.dist > 0 ? -1 : 1;
    for (let i = 0; i < 3; i++) {
      cam.target[i] += (sign * f[i] * fwd) + right[i] * strafe + up[i] * vert;
    }
    syncWant();   // 同 panBy：平移即时，want 拉齐
    render();
  }

  return {
    gl, cam,
    panBy, moveLocal,
    get renderer() { return renderer; },      // getter：setResources 后外部拿到的是新渲染器
    get structure() { return current; },
    resize, render, draw, fit, setStructure, updateBuffers, pick, pickPlane, project, viewMatrix,
    /**
     * 换一套 Resources（按需打包会换图集）。**视口对象本身不变** —— 重建的是内部渲染器，
     * 这样 canvas 上的事件处理器不需要重新绑定（它们闭包引用的是这个视口对象）。
     */
    setResources(next) {
      activeResources = next;
      // ★ useInvisibleBlockBuffer:false：Deepslate 的这个"不可见方块线框"是 **O(体积)** 的
      //   （每个空格子 12 条线），而本工具从不画它（只画 structure/grid/outline）——
      //   32×16×32 白建 19.6 万条线；长到 208×16×480 就是 1960 万条线 ≈ 470 MB ⇒ 渲染进程 OOM、页面卡死。
      //   实测：把它关掉后，同样的长大过程不再卡（见 D098 的排查记录）。
      renderer = new D.StructureRenderer(gl, current, activeResources, { chunkSize, useInvisibleBlockBuffer: false });
      resetVertexAttrs();   // 换渲染器等于全套重建 ⇒ 同样要防「启用但无 buffer」的属性槽
      rebuildGridMesh();    // 新渲染器的 gridMesh 是刚生成的默认版（角落轴）⇒ 覆盖回来
      render();
    },
    get resources() { return activeResources; },
    startLoop, stopLoop, dispose, setBackdrop,
    get running() { return rafId !== 0; },
    setGrid(on) { wantGrid = !!on; render(); },
    get grid() { return wantGrid; },
    /** 分层上限（索引 y ≤ n 可见；null = 全部）。**只影响绘制**，不碰数据结构、不重建 mesh。 */
    axisScreenDirs,                       // 坐标轴指示器（主模块每帧读它更新 DOM）
    setFrameCallback(cb) { frameCb = typeof cb === 'function' ? cb : null; },
    setLayerLimit(n) {
      const v = (n == null || n === Infinity || n < 0) ? null : (n | 0);
      const changed = v !== layerLimit;
      layerLimit = v;
      // ★ 切口补面（2026-10-12）：分层是绘制筛选、库的面剔除是建模期算的 ⇒ 切开处缺顶面。
      //   只给切口那一层补（O(该层方块数)）。**先撤旧的、再延迟补新的**：
      //   · 撤旧的必须立刻 —— 不然拖动中会留下"比可见范围更低"的补面（凭空多出一层假顶面，
      //     比缺面更糟）；拖动中短暂缺面是可以接受的（本来就在变）；
      //   · 补新的延迟合并（滑块一拖过几十档，每档都遍历方块表会在**大世界**里顿）。
      if (capTimer) { clearTimeout(capTimer); capTimer = 0; }
      dropCap();
      if (v != null) scheduleCap(v);
      // ★ 无条件重绘（哪怕值没变）：调用方期望"调完就能读到新的 drawStats"。
      //   实测踩到：闸门连续两次设同一个层数 ⇒ 第二次不重绘 ⇒ drawStats 停在更早那帧
      //   （表现为"分层看不出效果"，其实是统计过期）。多画一帧的代价可以忽略。
      // ★ 直接 draw() 而不是 render()：render() 已经是空操作（改由持续帧循环接管），
      //   而在无头/虚拟时间环境里 rAF 常常不推进 ⇒ 不强制画这一帧的话，drawStats 会停在旧值
      //   （闸门的 ⑦l 系列直接读它判"分层真的生效"）。多画一帧的开销可忽略。
      draw();
      return changed;
    },
    get layerLimit() { return layerLimit; },
    /** 上一次绘制提交了多少 chunk/mesh（闸门据此判"分层只影响绘制"） */
    get drawStats() { return drawStats; },
    // 框选预览：主模块用 setSelectRegion 同步选区；闸门用 selectRegion/selCageLines 判"画了什么"
    setSelectRegion,
    get selectRegion() { return selRect ? Object.assign({}, selRect) : null; },
    /** 线框的线段数（闸门 T5 用它钉"不管选区多大都只有一个盒子 = 12 条"） */
    get selCageLines() {
      if (!selMesh || typeof selMesh.lineVertices !== 'function') return 0;
      return selMesh.lineVertices() / 2;
    },
    /** 坐标轴画在哪个索引列上（= 主模块的 -origin）——闸门据此判"轴在不在原点" */
    get gridOrigin() { return gridOrigin.slice(); },
    setOutline(pos) {
      const same = (outline && pos && outline[0] === pos[0] && outline[1] === pos[1] && outline[2] === pos[2]) || (!outline && !pos);
      outline = pos ? pos.slice() : null;
      if (!same) render();
    },
    get outline() { return outline; },
    /** 幽灵预览（摆放/删除悬停）：{ pos:[x,y,z], kind:'place'|'erase' } 或 null */
    setGhost(g) {
      const same = (!ghost && !g) || (ghost && g && ghost.pos[0] === g.pos[0] && ghost.pos[1] === g.pos[1] && ghost.pos[2] === g.pos[2] && ghost.kind === g.kind);
      ghost = g ? { pos: g.pos.slice(), kind: g.kind } : null;
      if (!same) render();
    },
    get ghost() { return ghost; },
    // 投影虚影（2026-10-12）：主模块在"投影载入/清除/建筑变化"时调；闸门用 projGhostInfo 判"画了几块"
    setProjGhost,
    clearProjGhost() { dropGhost(); render(); },
    /** 分层切口补面（2026-10-12）：闸门据此判补了没、补的是哪一层、几块 */
    get capInfo() { return { limit: capStats.limit, cells: capStats.cells, quads: capStats.quads, bytes: capStats.bytes, ms: capStats.ms, has: !!capVbo }; },
    /** 最后一次虚影构建的实况（含"没建出来"的那次）—— 闸门据此判"走了哪条路" */
    get ghostDebug() { return ghostDebug; },
    get projGhostInfo() {
      if (!ghostGroups) return null;
      const g1 = ghostGroups.normal, g2 = ghostGroups.diff, gs = ghostGroups.diffSolid;
      const m = ghostGroups.meta;
      return {
        // ★ `mode` 是**能验伪的关键**：闸门据此判"走的是带贴图路径，还是退回了纯色盒"。
        //   只看"有没有画"分不出这两条路 —— 而 v1→v2 这次改版要钉住的正是这一点。
        mode: 'texture',
        cells: m.cells, diffCells: m.diffCells,
        // ★ `verts` 只报**带贴图那组**（差异组）—— 它与 quads*6 对应；
        //   一致组是纯色盒（每块 36 顶点），单列在 solidVerts 里。两个口径不能混加。
        verts: (g2 ? g2.n : 0),
        solidVerts: (g1 ? g1.n : 0) + (gs ? gs.n : 0),
        normalMode: 'solid', diffMode: m.diffMode, texCap: m.texCap,
        // quad 数（每个 quad 展开成 2 个三角形 = 6 顶点 ⇒ verts === quads * 6）。
        // v1 的判据曾是"verts === 方块数 * 36"（每块一个立方体 36 顶点）；带贴图后
        // **方块与 quad 不是线性关系**（台阶 6 个 quad、栅栏十几根杆各 6 个，一个方块几个 cube），
        // 所以改成对 quad 断言 —— 判据的**意图不变**（"合并成一张、不随块数增长"），见 drawCalls。
        quads: m.quads,
        // ★ drawCalls 与 v1 同义：两组各一次 drawArrays，**与方块数解耦**
        //   （逐块/逐 chunk 画会让它随块数增长 —— 那正是"没合并"的症状）。
        drawCalls: (g1 && g1.buf ? 1 : 0) + (g2 && g2.buf ? 1 : 0) + (gs && gs.buf ? 1 : 0),
        meshes: (g1 ? 1 : 0) + (g2 ? 1 : 0),
        bytes: (g1 ? g1.bytes : 0) + (g2 ? g2.bytes : 0),
        capped: ghostGroups.capped, refused: ghostGroups.refused,
        bakeMs: m.bakeMs,                       // 实测口径：重建一次虚影花了多少毫秒（不靠猜）
        noModel: m.noModel, dropped: m.dropped, over: m.over, added: m.added,
      };
    },
    orbit, zoomBy, setAxes,
    /** 镜像轴状态（只读）：{ x, y, extent } —— 闸门据此判"轴画在网格中间 / 关掉后撤掉" */
    get axes() { return axes; },
    fitContent, snapAxis, nudgeYaw,       // ★ 手感实验室（?feel=1）
    setAngles, angleTween, anglesFor,     // ViewCube：定向切换（带过渡动画）
    get pitchRange() { return [PITCH_MIN, PITCH_MAX]; },
    syncFeel: syncWant,                   // 面板切开关时把 want 拉齐（防旧值回拉）
    tickDamping: applyDamping,            // 每帧阻尼推进（loop 里调用；测试可直接驱动）
  };
}

/** 两格之间的整数直线（3D Bresenham，返回**中间格**、不含两端）。快速拖动补格用（手感实验室）。 */
export function lineCells(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const n = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const out = [];
  for (let i = 1; i < n; i++) {
    out.push([Math.round(a[0] + dx * i / n), Math.round(a[1] + dy * i / n), Math.round(a[2] + dz * i / n)]);
  }
  return out;
}
