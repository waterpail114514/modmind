// viewcube.js —— 角落小方块视角控件（2026-10-11，替代原来的「旋转 90°」按钮）。
//
// 用户原话：「移除"选择90度"这个按钮，替换为一个视角按钮，实现类似 3D 建模软件中立方体视角
// （ViewCube/Gizmo）的方向切换与定位功能。」
//
// ── 设计要点 ────────────────────────────────────────────────────────────────
// 1. **26 个方向**（6 面 + 12 棱 + 8 角），用"点面/棱/角"切换。这不是把 26 个按钮塞进一个控件，
//    而是**一个小方块**：块上任何一点都对应一个方向，用户不需要数数。
// 2. **姿态与主相机同步**：方块用和主视图**同一个旋转**（M = Rx(xr)·Ry(yr)）绘制，
//    所以你看到的小方块就是你现在看世界的角度 —— 不需要额外的方位指示。
// 3. **命中判定用射线与立方体求交**，再由命中点在该面的归一化坐标分类"面/棱/角"
//    （|u|、|v| 都超过阈值 → 角；只有一个超过 → 棱；否则 → 面）。
//    为什么不用"把 26 个热点都画出多边形再判断点是否在多边形内"：那是 26 组多边形的维护负担，
//    而射线法只有一段求交 + 两次比较，且天然处理"被挡住的背面不能点"。
// 4. **自己画（2D canvas）**，不引第三方：本项目已有"不引新依赖"的惯例，
//    而且小方块只有 6 个四边形，手写比接库更可控（主题色也要跟着 CSS 变量走）。
//
// ★ 可测性：`hit(px,py)` / `dirAt(dir)`（方向 → 屏幕点）/ `state()` 都是纯函数式入口，
//   闸门可以直接"算出某方向的屏幕坐标 → 派发真 pointerdown/up"，不必猜像素。

const HALF = 0.5;
/** 面/棱/角的分类阈值（占半宽的比例）：中央 55% 算"面"，外侧分别算"棱/角"。 */
const INNER = 0.55;

const FACES = [
  { n: [1, 0, 0], label: '东', color: '#c0504d' },
  { n: [-1, 0, 0], label: '西', color: '#c0504d' },
  { n: [0, 1, 0], label: '上', color: '#4f9d4f' },
  { n: [0, -1, 0], label: '下', color: '#4f9d4f' },
  { n: [0, 0, 1], label: '南', color: '#4a6fa5' },
  { n: [0, 0, -1], label: '北', color: '#4a6fa5' },
];

/** 每个面的两条切向轴（用于枚举四个角 + 命中点局部坐标） */
const TANGENTS = {
  '1,0,0': [[0, 1, 0], [0, 0, 1]],
  '-1,0,0': [[0, 1, 0], [0, 0, 1]],
  '0,1,0': [[1, 0, 0], [0, 0, 1]],
  '0,-1,0': [[1, 0, 0], [0, 0, 1]],
  '0,0,1': [[1, 0, 0], [0, 1, 0]],
  '0,0,-1': [[1, 0, 0], [0, 1, 0]],
};

/** M = Rx(xr)·Ry(yr)，与 viewport.viewMatrix 的旋转部分**完全一致**（改一处必须改两处）。 */
function rotM(yr, xr) {
  const cy = Math.cos(yr), sy = Math.sin(yr), cx = Math.cos(xr), sx = Math.sin(xr);
  return [cy, 0, sy, sx * sy, cx, -sx * cy, -cx * sy, sx, cx * cy];
}
/** 行主序 3×3 作用于列向量 */
function mul(M, v) {
  return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
          M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
          M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
}
/** M 的转置（= 逆）：把"视图空间"的向量换回"方块本地空间" */
function mulT(M, v) {
  return [M[0] * v[0] + M[3] * v[1] + M[6] * v[2],
          M[1] * v[0] + M[4] * v[1] + M[7] * v[2],
          M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];
}

export function createViewCube({ canvas, vp, onHome }) {
  const cv = canvas;
  const ctx = cv.getContext('2d');
  const CSS_PX = 92;                     // 与 app.css 的 #vcube 尺寸一致
  let S = 0;                             // 正交投影半径（世界单位 → 像素）
  let cx = 0, cy = 0;
  let hover = null;                      // 当前悬停的方向 { dir, kind }
  let dragging = null;
  let lastDrawn = null;
  let rafId = 0;

  function resize() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const px = Math.round(CSS_PX * dpr);
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
    S = px * 0.30;                       // 留出边距，别顶到边框
    cx = px / 2; cy = px / 2;
    return px;
  }

  /** 本地空间点 → 屏幕像素（正交投影：x 向右、y 向上翻成屏幕的向下） */
  function project(pLocal, M) {
    const v = mul(M, pLocal);
    return [cx + v[0] * S, cy - v[1] * S, v[2]];
  }

  /** 某个方向（单位/未归一化）对应的屏幕点：取"朝该方向的那一面"上的中心 */
  function dirToScreen(dir, M) {
    const L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const p = [dir[0] / L * HALF, dir[1] / L * HALF, dir[2] / L * HALF];
    return project(p, M);
  }

  /** 面的四个角（本地空间） */
  function faceCorners(f) {
    const [a, b] = TANGENTS[f.n.join(',')];
    const c = [];
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      c.push([f.n[0] * HALF + a[0] * sa * HALF + b[0] * sb * HALF,
              f.n[1] * HALF + a[1] * sa * HALF + b[1] * sb * HALF,
              f.n[2] * HALF + a[2] * sa * HALF + b[2] * sb * HALF]);
    }
    return [c[0], c[1], c[3], c[2]];     // 顺序绕圈，便于描边
  }

  /**
   * 屏幕点 → 立方体上的方向。
   * 射线在**本地空间**里与轴对齐立方体求交（slab 法），命中点再按面内归一化坐标分类。
   * 返回 { dir, kind, face, u, v } 或 null（没打中方块）。
   */
  function hit(px, py) {
    const M = rotM(vp.cam.yr, vp.cam.xr);
    // 视图空间：相机在 +z 方向无限远（正交），射线方向 (0,0,-1)
    const vx = (px - cx) / S, vy = -(py - cy) / S;
    const oV = [vx, vy, 4];
    const dV = [0, 0, -1];
    const o = mulT(M, oV), d = mulT(M, dV);

    let tmin = -Infinity, tmax = Infinity, axis = -1;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (o[i] < -HALF || o[i] > HALF) return null;
        continue;
      }
      let t1 = (-HALF - o[i]) / d[i], t2 = (HALF - o[i]) / d[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) { tmin = t1; axis = i; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (axis < 0 || tmin < 0) return null;

    const p = [o[0] + d[0] * tmin, o[1] + d[1] * tmin, o[2] + d[2] * tmin];
    const sign = p[axis] >= 0 ? 1 : -1;
    const fn = [0, 0, 0]; fn[axis] = sign;
    const [a, b] = TANGENTS[fn.join(',')];
    const ua = p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
    const vb = p[0] * b[0] + p[1] * b[1] + p[2] * b[2];
    const ru = ua / HALF, rv = vb / HALF;
    const du = Math.abs(ru) > INNER ? Math.sign(ru) : 0;
    const dv = Math.abs(rv) > INNER ? Math.sign(rv) : 0;
    const kind = (du && dv) ? 'corner' : (du || dv ? 'edge' : 'face');
    const dir = [
      fn[0] + a[0] * du + b[0] * dv,
      fn[1] + a[1] * du + b[1] * dv,
      fn[2] + a[2] * du + b[2] * dv,
    ];
    return { dir, kind, face: fn, u: ru, v: rv };
  }

  function cssToCanvas(e) {
    const r = cv.getBoundingClientRect();
    const k = cv.width / (r.width || 1);      // CSS 像素 → 画布像素（含 DPR）
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }

  // ------------------------------------------------------------------ 绘制
  function draw() {
    resize();
    const px = cv.width;
    ctx.clearRect(0, 0, px, px);
    const M = rotM(vp.cam.yr, vp.cam.xr);

    // 先算每个面的深度（视图空间 z 的平均），按远→近画（画家算法）
    const items = FACES.map((f) => {
      const pts = faceCorners(f).map((p) => project(p, M));
      const z = (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4;
      const nz = mul(M, f.n)[2];
      return { f, pts, z, nz };
    }).sort((a, b) => a.z - b.z);

    for (const it of items) {
      const facing = it.nz > 0.02;
      const isHover = hover && hover.face && hover.face.join(',') === it.f.n.join(',');
      ctx.beginPath();
      ctx.moveTo(it.pts[0][0], it.pts[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(it.pts[i][0], it.pts[i][1]);
      ctx.closePath();
      // 面底色：看得见的面用该轴向的主题色（浅），背面用中性灰（被挡住也无所谓，留个层次）
      const base = facing ? it.f.color : '#94a3b8';
      ctx.fillStyle = isHover ? 'rgba(37,99,235,.85)' : (facing ? hexA(base, 0.30) : hexA(base, 0.14));
      ctx.fill();
      ctx.lineWidth = Math.max(1, cv.width / 96);
      ctx.strokeStyle = facing ? hexA(base, 0.85) : 'rgba(148,163,184,.5)';
      ctx.stroke();

      // 标注：只在"明显朝着你"的面上写（斜到快侧过去时写了也是糊的）
      if (facing && it.nz > 0.45) {
        const cxp = (it.pts[0][0] + it.pts[1][0] + it.pts[2][0] + it.pts[3][0]) / 4;
        const cyp = (it.pts[0][1] + it.pts[1][1] + it.pts[2][1] + it.pts[3][1]) / 4;
        ctx.fillStyle = isHover ? '#fff' : hexA(base, 0.95);
        ctx.font = '600 ' + Math.round(cv.width * 0.135) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(it.f.label, cxp, cyp);
      }
    }

    // 悬停热点：棱/角上点一个圆点，让"我要去哪一条棱/哪一个角"看得见
    if (hover) {
      const p = dirToScreen(hover.dir, M);
      if (hover.kind !== 'face') {
        ctx.beginPath();
        ctx.arc(p[0], p[1], Math.max(2.5, cv.width * 0.035), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(37,99,235,.95)';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, cv.width / 110);
        ctx.stroke();
      }
    }
    lastDrawn = [vp.cam.yr, vp.cam.xr];
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 相机变了才重画（每帧只比两个数；静态画面下零重绘） */
  function sync() {
    if (!lastDrawn || Math.abs(lastDrawn[0] - vp.cam.yr) > 1e-4 || Math.abs(lastDrawn[1] - vp.cam.xr) > 1e-4) draw();
  }

  // ------------------------------------------------------------------ 交互
  function go(dir, opts) {
    const a = vp.anglesFor(dir);
    return vp.setAngles(a.yr, a.xr, opts);
  }

  function onDown(e) {
    // ★ setPointerCapture 要容错：合成事件（闸门用 dispatchEvent 派发的 PointerEvent）
    //   可能没有有效的 pointerId，直接调用会抛 NotFoundError/TypeError，
    //   把"点击切视角"整条路径一起带走（那样闸门测的就不是功能、而是事件构造方式了）。
    try { cv.setPointerCapture && cv.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真指针，忽略 */ }
    dragging = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
    e.preventDefault();
  }
  function onMove(e) {
    const [px, py] = cssToCanvas(e);
    if (dragging && dragging.id === e.pointerId) {
      const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
      dragging.x = e.clientX; dragging.y = e.clientY;
      dragging.moved += Math.abs(dx) + Math.abs(dy);
      if (dragging.moved > 3) { vp.orbit(dx * 1.6, dy * 1.6); }
      return;
    }
    const h = hit(px, py);
    const same = (!h && !hover) || (h && hover && h.dir.join(',') === hover.dir.join(','));
    hover = h;
    if (!same) draw();
    cv.style.cursor = h ? 'pointer' : 'grab';
  }
  function onUp(e) {
    const d = dragging;
    dragging = null;
    if (!d) return;
    if (d.moved <= 3) {                       // 没怎么动 ⇒ 当成"点了某个方向"
      const [px, py] = cssToCanvas(e);
      const h = hit(px, py);
      if (h) go(h.dir);
    }
  }
  function onLeave() { dragging = null; if (hover) { hover = null; draw(); } }
  function onDbl() {
    // 复位：角度回默认 3/4 视角；同时"定位"到内容（等价于适应建筑）—— 3D 软件里这两件事通常一起做
    vp.setAngles(0.6, 0.9);
    if (onHome) onHome();
  }

  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onLeave);
  cv.addEventListener('pointerleave', onLeave);
  cv.addEventListener('dblclick', onDbl);

  function startLoop() {
    if (rafId) return;
    const tick = () => { sync(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  return {
    draw, sync, startLoop, stopLoop, hit, dirToScreen: (d) => dirToScreen(d, rotM(vp.cam.yr, vp.cam.xr)),
    go, home: onDbl,
    /** 供闸门断言用：当前姿态 + 画出来的可见面 + 悬停态 */
    state() {
      const M = rotM(vp.cam.yr, vp.cam.xr);
      return {
        yr: vp.cam.yr, xr: vp.cam.xr,
        visibleFaces: FACES.filter((f) => mul(M, f.n)[2] > 0.02).map((f) => f.label),
        hover: hover ? { dir: hover.dir, kind: hover.kind } : null,
        dragging: !!dragging,
        canvasPx: cv.width,
      };
    },
    get canvas() { return cv; },
  };
}
