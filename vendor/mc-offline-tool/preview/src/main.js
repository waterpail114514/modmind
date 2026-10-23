// main.js —— 产品装配：资源 → 视口 → 编辑栈 → 物品栏 → 工具栏/鼠标/键盘 → 导入导出。
import { buildResources } from './resources.js';
import { createViewport, lineCells, CHUNK_SIZE } from './viewport.js';
import { createInventory } from './inventory.js';
import { EditStack, stateStringOf, stateString } from './edits.js';
import { loadSceneAssets } from './scene.js';
import { $, $$, setRoot, rootNode, hostScene, hostImport, hostExport, hostInitialBuild, isFeature } from './host.js';
import { defaultPropsOf } from './defaults.js';
import { inferOnPlace, inferConnect, affectedBy, schemaOf } from './statelogic.js';
import { BLOCK_DEFAULTS } from './block-defaults.generated.js';   // 构建时从 registry-defaults 抽的原版默认态
import { loadRegistryDefaults } from './registry.js';
import { importBuilding, exportBuilding, download, materialRows, materialsCsv, structureToBuildJson } from './io.js';
import { createViewCube } from './viewcube.js';
import * as projects from './projects.js';

const D = window.deepslate;
// ── 手感实验室（2026-10-11；《3D 建筑面板手感优化方案》的候选增强项）────────────────
//   URL ?feel=1 开启全部增强；?feel=1&damp=0.4 指定阻尼强度（默认 0.28）。
//   默认（无参数）= 全关闭 ⇒ 行为与既有版本一致（回归闸门基线不受影响）。
//   右下角面板可逐项开关做 A/B：「全部关」= 旧手感，逐项开 = 感受每一处差异。
const FEEL = (() => {
  const q = new URLSearchParams(location.search);
  const on = q.get('feel') === '1';
  const dampQ = parseFloat(q.get('damp') || '');
  return {
    on,
    damping: on ? (Number.isFinite(dampQ) ? Math.max(0, Math.min(0.8, dampQ)) : 0.28) : 0,
    zoomCursor: on,
    // ★ 2026-10-12 默认 true：世界会被"无限建造"长大到几百格，而内容只在角落 ⇒
    //   按世界尺寸取景会把相机拉到 600+ 格，网格/建筑都被抗锯齿吃掉（用户报「网格消失」）。
    //   默认按**内容包围盒**取景才对；没内容时 fitContent 自己会退回按世界尺寸（viewport 里有兜底）。
    fitContent: true,
    smoothKeys: on,
    lerpDrag: on,
    showY: on,
  };
})();
/** 按住 WASD 平滑移动的按键集合（仅 feel.smoothKeys 时维护）。 */
const keysDown = new Set();
// E7 反馈收敛：成功 / 警告 / 错误都走 #msg 这**一条行**（颜色区分），成功 2 秒后自动淡出，
// 警告与错误持续显示直到被下一条覆盖 —— 不再让用户在底部提示、状态栏、画面三处找反馈。
let msgTimer = null;
const setMsg = (t, kind = '') => {
  const m = $('msg'); if (!m) return;
  m.textContent = t; m.className = kind;
  if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
  if (!kind) msgTimer = setTimeout(() => { m.classList.add('fade'); }, 2000);
};
// E1：同类提示节流（"贴到世界边界内侧"这类提示 4 秒内只说一次，不刷屏）
const hintLast = new Map();
const hintOnce = (key, t, kind = '', gapMs = 4000) => {
  const now = performance.now();
  if (now - (hintLast.get(key) || 0) < gapMs) return;
  hintLast.set(key, now);
  setMsg(t, kind);
};
// ★ busy 必须**每次现查**，不能在模块求值时抓一次：功能包会被"切走再切回来"，
//   第二次挂载是一棵**全新的 shadow 树**，模块级抓到的旧节点早已游离 ⇒ 忙等提示写到一个看不见的节点上。
// E4（Nielsen 三阈值）：累计等待 >300ms 才亮指示（快速阶段不闪烁）；亮起后至少保留 300ms（不一闪而过）。
//   计时器跨阶段共享：boot 的四个阶段合起来算一次"忙"，只要总等待超阈值指示就会出现。
const busy = { timer: null, shownAt: 0 };
const showBusy = (t) => {
  const b = $('busy'); if (b) b.textContent = t;
  if (busy.timer) return;
  busy.timer = setTimeout(() => {
    const el = $('busy');
    if (el) { el.classList.add('on'); busy.shownAt = performance.now(); }
  }, 300);
};
const hideBusy = () => {
  if (busy.timer) { clearTimeout(busy.timer); busy.timer = null; }
  const b = $('busy'); if (!b) return;
  const held = performance.now() - busy.shownAt;
  if (busy.shownAt && held < 300) setTimeout(() => { const el = $('busy'); if (el) el.classList.remove('on'); }, 300 - held);
  else b.classList.remove('on');
  busy.shownAt = 0;
};

const state = {
  mode: 'place',            // pan | place | erase | pick | select（1-5 切换）
  invOpen: true,            // 物品栏是否展开（工具条 / B 键切换）
  layerMax: Infinity,      // 分层上限（索引 y ≤ 它可见；Infinity = 全部）。★ 只影响**绘制**，不改数据
  proj: null,               // 投影（2026-10-11）：导入后不替换世界，供「按投影补全」使用
  build: null,              // 当前建筑的原始 JSON（导入/加载时用）
  source: null,             // 权威 Structure（编辑栈操作它）
  edit: null,
  vp: null,
  inv: null,
  ready: null,
  nameById: new Map(),      // 中文名（材料清单用）
  mirrorX: false,           // 镜像 X（M）：绕世界中心线（= 网格正中）左右对称 —— 对应**红色**的 X 轴
  mirrorZ: false,           // 镜像 Z（Shift+M）：绕世界中心线前后对称 —— 对应**蓝色**的 Z 轴（2026-10-12 用户要求）
  // ★ 2026-10-12：`mirrorY` **已移除**（用户选择"去掉 Y 镜像，只留 X/Z"）。
  //   留这段注释是为了让后来人知道"它不是漏了，是被有意去掉的"，以及为什么：
  //   镜像面 = 世界高度/2，而世界只向上长 ⇒ 一往高处建，Y 的镜像面就漂；X/Z 两侧对称长所以不漂。
  selRegion: null,          // 框选矩形选区 { x1, z1, x2, z2 }（平面格）；null = 无选区
  // ★ 坐标系（2026-10-11 用户：「原点移到网格中心」）：origin = **索引 (0,0,0) 对应的用户坐标**。
  //   用户坐标 = 索引 + origin。载入时置 (-⌊W/2⌋, 0, -⌊D/2⌋)：x/z 的原点在网格正中（负坐标合法），
  //   y 保持 0 = 地面/网格平面。内部（Structure/EditStack/渲染/导出）仍用 0 起索引，一行没动。
  origin: [0, 0, 0],
};
// ---------------------------------------------------------------- 卸载清理
// 功能包会被宿主"切走再切回来"（组件卸载 → 重新挂载）。凡是挂在 document / window 上的监听，
// 以及 rAF 帧循环，**都必须能撤销**：不撤的话第二次挂载会叠加（按一次 w 走两格、Ctrl+Z 撤两次、
// 双份绘制持续发热）。self-contained 的写法：所有 addEventListener 走这个 on()，shutdown() 一次清空。
const TEARDOWN = [];
let themeObs = null;              // 监听宿主主题切换（见 syncBackdrop）
function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  TEARDOWN.push(() => { try { target.removeEventListener(type, fn, opts); } catch { /* 尽力而为 */ } });
}
/** 供功能包入口在组件卸载时调用（独立网页模式没人调也无害） */
export function shutdown() {
  for (const f of TEARDOWN.splice(0)) f();
  try { flushSave(); } catch { /* U3：卸载前把防抖中的存档落盘 */ }
  dismissToast();
  try { if (themeObs) themeObs.disconnect(); } catch { /* 尽力而为 */ }
  themeObs = null;
  // ★ ViewCube 自带一个每帧比对的 rAF 循环（相机变了才重画）—— 卸载时必须停掉。
  //   不停的话：② 卸载后 rAF 计数继续涨（闸门 B2 抓到的就是它：225 => 226），
  //   而且闭包持有 canvas/state ⇒ 整个实例泄漏。
  try { state.vcube && state.vcube.stopLoop(); } catch { /* 可能还没建 */ }
  try { state.vp && state.vp.dispose(); } catch { /* 视口可能还没建 */ }
  try { state.inv && state.inv.dispose && state.inv.dispose(); } catch { /* 物品栏可能还没建 */ }
}

/**
 * 视口底色跟随主题。读 `#stageWrap` 的**计算后**背景色（`--mm-canvas` 已被解析成 rgb），
 * 再交给视口当 gl.clearColor —— 这样"宿主浅色 ⇒ 画布浅色"自动成立，不用我们去猜主题。
 * 宿主切主题不一定重发 prefers-color-scheme，所以同时盯 <html>/<body> 上的 class/style/data-theme。
 */
function syncBackdrop() {
  if (!state.vp) return;
  try {
    const bg = getComputedStyle($('stageWrap')).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (!m) return;
    const p = m[1].split(',').map((x) => parseFloat(x) / 255);
    if (p.length >= 3 && p.slice(0, 3).every((v) => Number.isFinite(v))) state.vp.setBackdrop([p[0], p[1], p[2]]);
  } catch { /* 取不到就保持默认底色 */ }
}

// ---------------------------------------------------------------- 由 build.json 建 Structure
function structureFrom(build, D) {
  const [sx, sy, sz] = build.size;
  const st = new D.Structure([sx, sy, sz]);
  const isAir = (id) => /(^|:)air$|cave_air$|void_air$/.test(id);
  // ★ 三个计数器**分开**（审核员 B5/B6）：出界丢弃、调色板越界（数据损坏）、空气，三者含义完全不同，
  //   合在一个数里用户就会"查错方向"。以前这里 `catch { /* 忽略 */ }`、`if (!p) continue` 全是静默的。
  let placed = 0, skippedAir = 0, skippedBadRef = 0, skippedOutOfBounds = 0;
  for (const b of build.blocks) {
    const p = build.palette[b.state];
    if (!p) { skippedBadRef++; continue; }
    if (isAir(p.Name)) { skippedAir++; continue; }
    try { st.addBlock(b.pos, p.Name, p.Properties || {}); placed++; } catch { skippedOutOfBounds++; }
  }
  return { st, placed, skippedAir, skippedBadRef, skippedOutOfBounds };
}

/**
 * 应用一次「切到 target 层」—— **2026-10-12 重构：只设一个上限，零重建**。
 *
 * 旧实现（layer.js 的"增量视图"）在每次滑块 input 时：遍历全部方块收集 place/erase ops → commit →
 * 重建受影响 chunk 的 mesh。对大建筑，每动一格就要重建**一整层 chunk**（几百个 mesh）⇒ 明显卡顿。
 * 而"只看 ≤N 层"这件事根本不需要动数据 —— `chunkBuilder.chunks` 是 3D 数组，
 * 库的 drawStructure 只是 `getMeshes().forEach(drawMesh)` ⇒ 我们在提交阶段跳过超限的 chunk 即可
 * （见 viewport.js 的 drawStructureVisible）。拖滑块的代价因此**降到 0**：改一个变量 + 重绘一帧。
 * 用户看到的差别：参考站的分层"拖起来不卡"，就是这个道理。
 */
function applyLayer(target) {
  const sy = state.source.size[1];
  const capped = Math.max(0, Math.min(target, sy - 1));
  state.layerMax = capped >= sy - 1 ? Infinity : capped;
  const el = $('layerVal');
  if (el) el.textContent = state.layerMax === Infinity ? '全部' : ('≤ ' + (state.layerMax + 1) + ' 层');
  if (state.vp && state.vp.setLayerLimit) {
    state.vp.setLayerLimit(state.layerMax === Infinity ? null : state.layerMax);
  }
  updateStatus();
}
/** 合并两组 chunks（按键去重；编辑 chunks ∪ 视图侧 chunks 一次刷新）。 */
function mergeChunks(a, b) {
  if (!b || !b.length) return a;
  const seen = new Set(a.map((c) => c.join(',')));
  const out = a.slice();
  for (const c of b) { const k = c.join(','); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out;
}

// ---------------------------------------------------------------- 载入建筑
function loadBuild(build, label) {
  state.build = build;
  const { st, placed, skippedAir, skippedBadRef, skippedOutOfBounds } = structureFrom(build, D);
  state.source = st;
  centerOrigin(st.size);               // ★ 坐标系：原点摆到网格中心（x/z 居中，y=0 地面）
  state.edit = new EditStack(st);
  state.layerMax = Infinity;           // 换建筑 ⇒ 分层复位（视口的 limit 也要跟着清）
  if (state.vp && state.vp.setLayerLimit) state.vp.setLayerLimit(null);
  $('layer').max = String(st.size[1] - 1);
  $('layer').value = String(st.size[1] - 1);
  $('layerVal').textContent = '全部';
  if (state.vp) {
    state.vp.setStructure(st);
    // ★ 取景优先按**内容包围盒**（大世界里内容只在角落 ⇒ 按世界尺寸会把相机拉到几百格外，
    //   网格和建筑都被抗锯齿吃掉）。没内容时 fitContent 退回按世界尺寸（它的兜底）。
    if (state.vp.fitContent) state.vp.fitContent(); else state.vp.fit();
    syncAxes();
  }
  refreshProjButtons();
  state.vp?.setOutline(null);
  // 读数**逐个说清**（审核员 B5/B6）：空气是正常的；调色板损坏与越界丢弃是**异常**，非零就显红，
  // 免得用户把"数据坏了"读成"本来就是空气"。
  const badRef = (build.stats && build.stats.skippedBadRef) || skippedBadRef;
  const notes = [];
  if (skippedAir) notes.push(`跳过空气 ${skippedAir}`);
  if (badRef) notes.push(`调色板下标越界 ${badRef}（数据损坏）`);
  if (skippedOutOfBounds) notes.push(`越界丢弃 ${skippedOutOfBounds}`);
  // ★ 补全"缺失的连接/附着"（只增不减）——见 growConnectAll 的注释。
  //   游戏导出的文件里 state 本来就是对的 ⇒ **补 0 格、无副作用**；
  //   别的工具导出的常是默认态（栅栏=孤柱、按钮=贴一堵不存在的北墙）⇒ 这里把它们修回来。
  //   报数字而不是静默改数据：用户得看得见工具动了什么。
  let fixed = 0;
  if (st.getBlocks().length) {
    const fix = growConnectAll();
    if (fix.length && doEdit(fix, { repair: false })) fixed = fix.length;
  }
  setMsg(`已载入 ${label}：${st.size.join('×')} / ${placed} 方块${fixed ? ` · 已补全 ${fixed} 个方块的连接/附着状态` : ''}${notes.length ? `（${notes.join('，')}）` : ''}`,
    (badRef || skippedOutOfBounds) ? 'err' : '');
  updateStatus();
  void refreshScene(build);              // 换建筑 → 按需换图集（首屏时 key 相同会直接返回）
  refreshGhost();                        // 换建筑 ⇒ 投影差异变了，虚影要重画（投影虚影，2026-10-12）
}

// ---------------------------------------------------------------- O1 开面剔除 · A/B 画面一致性
// 审核 M2：「先小集合 A/B 验证」。同一测试结构、同一相机、同一 GL 上下文抓两帧：
//   A = 剔除前（opaque 表为空，所有相邻面都生成网格）；
//   B = 剔除后（正常 opaque 表，方块之间的内部相邻面被剔除）。
// 外部可见画面必须**逐像素一致**——被剔除的面全夹在不透明方块内部，本来就不可见。
// 测试结构：stone 2×2×2（含内部相邻面）+ glass 紧贴 +x 外侧；glass 非 opaque，
//   stone 朝 glass 的面绝不能剔（透过 glass 必须看得到）。
// badOpaque：变异注入（用错误 opaque 表替换）⇒ 返回的 diffPixels 必须 > 0，证明对比不是恒真断言。

/**
 * 框选预览的**画面级**验证（2026-10-11）：把相机对准给定选区，抓两帧逐像素比 ——
 * A = 有选区预览，B = 清掉选区。差异像素数 > 0 才说明"预览真的画出来了"。
 *
 * ★ 为什么要做到像素级：T1/T2/T5 那些断言查的是 state 与线框 mesh（"数据对不对"），
 *   而"drawOverlay 里到底有没有把它提交上去"查不到 —— 把绘制代码整段删掉，那些断言照样绿。
 *   这是本项目的老毛病（"计数能保字符串、保不了选择器"的同类）：**要断言"画出来了"，就得看画面**。
 * 反向对照见闸门 T9：把 region 传 null 时差异必须为 0（证明这个差异确实来自选区，不是噪声）。
 */
async function selPreviewAB(region) {
  const vp = state.vp;
  if (!vp) throw new Error('视口尚未初始化');
  vp.stopLoop();
  const gl = vp.gl;
  const savedCam = { xr: vp.cam.xr, yr: vp.cam.yr, dist: vp.cam.dist, target: [...vp.cam.target] };
  const savedSel = vp.selectRegion;
  const r = region || savedSel;
  // 把相机对准选区中心（否则选区可能根本不在画面里，差异恒为 0 ⇒ 假红/假绿）
  if (r) {
    const cx = (Math.min(r.x1, r.x2) + Math.max(r.x1, r.x2) + 1) / 2;
    const cz = (Math.min(r.z1, r.z2) + Math.max(r.z1, r.z2) + 1) / 2;
    const ext = Math.max(Math.abs(r.x2 - r.x1) + 1, Math.abs(r.z2 - r.z1) + 1, 2);
    vp.cam.target = [cx, 0, cz];
    vp.cam.dist = Math.max(8, ext * 3);
    vp.cam.xr = 0.9; vp.cam.yr = 0.6;
  }
  const grab = () => {
    vp.draw();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  let a, b;
  try {
    vp.setSelectRegion(r);
    a = grab();
    vp.setSelectRegion(null);
    b = grab();
  } finally {
    vp.setSelectRegion(savedSel);
    vp.cam.xr = savedCam.xr; vp.cam.yr = savedCam.yr; vp.cam.dist = savedCam.dist; vp.cam.target = savedCam.target;
    vp.draw();
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  }
  return { diff, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, region: r || null };
}

async function renderAB({ badOpaque = null } = {}) {
  const vp = state.vp;
  if (!vp) throw new Error('视口尚未初始化');
  const scene = await hostScene(['minecraft:stone', 'minecraft:glass']);
  const baseFlags = scene.flags || {};
  const flagsA = { ...baseFlags, opaque: [] };
  const flagsB = badOpaque ? { ...baseFlags, opaque: badOpaque } : baseFlags;
  const rA = await buildResources(D, { assets: scene.assets, opaque: flagsA, atlasUrl: scene.atlasUrl });
  const rB = await buildResources(D, { assets: scene.assets, opaque: flagsB, atlasUrl: scene.atlasUrl });
  // 测试结构 3×2×3：两块 stone 沿 z 相邻居中（(1,0,0)(1,0,1)，共享面是"内部剔除"对象）；
  // glass 放东西两侧 —— 无论相机在 ±x 哪边，**可见侧** stone-glass 接触面一旦被错剔，
  // 视线透过 glass 看到的是 stone 内部背向面（全被 backface culling）⇒ 直接露出背景，差异无处藏。
  const st = new D.Structure([3, 2, 3]);
  st.addBlock([1, 0, 0], 'minecraft:stone', {});
  st.addBlock([1, 0, 1], 'minecraft:stone', {});
  for (const gx of [0, 2]) {
    st.addBlock([gx, 0, 0], 'minecraft:glass', {});
    st.addBlock([gx, 0, 1], 'minecraft:glass', {});
  }

  const gl = vp.gl;
  const saved = {
    res: vp.resources, str: vp.structure,
    xr: vp.cam.xr, yr: vp.cam.yr, dist: vp.cam.dist, target: [...vp.cam.target],
  };
  vp.stopLoop();                        // 抓帧期间不让帧循环插帧
  const grab = (res) => {
    vp.setResources(res);
    vp.setStructure(st);
    vp.updateBuffers();                 // 同产品编辑路径：显式全量重建 chunk 网格
    vp.cam.xr = 0.7; vp.cam.yr = 0.6; vp.cam.dist = 9; vp.cam.target = [1, 0.5, 0.5];
    // 诊断：统计本次 draw 的 drawElements 次数与索引总数（产品零侵入，测完还原）
    let calls = 0, elems = 0;
    const rawDE = gl.drawElements.bind(gl);
    gl.drawElements = function (mode, count) { calls++; elems += count; return rawDE.apply(gl, arguments); };
    try { vp.draw(); } finally { gl.drawElements = rawDE; }
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { px, w, h, calls, elems };
  };
  const A = grab(rA.resources), B = grab(rB.resources);
  // 恢复现场：用户的资源 / 世界 / 相机原样
  vp.setResources(saved.res);
  vp.setStructure(saved.str);
  vp.updateBuffers();
  vp.cam.xr = saved.xr; vp.cam.yr = saved.yr; vp.cam.dist = saved.dist;
  vp.cam.target = saved.target;
  vp.startLoop();

  // 差异统计（基准 A 与本次 B 在同一循环内先算后弃，变量不交叉）
  let diffPixels = 0, maxDelta = 0, deltaSum = 0;
  for (let i = 0; i < A.px.length; i += 4) {
    const d = Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]);
    if (d > 0) { diffPixels++; deltaSum += d; if (d > maxDelta) maxDelta = d; }
  }
  return { diffPixels, maxDelta, avgDelta: diffPixels ? +(deltaSum / diffPixels / 3).toFixed(2) : 0, w: A.w, h: A.h,
    stats: { A: { calls: A.calls, elems: A.elems }, B: { calls: B.calls, elems: B.elems } } };
}

async function fetchBuild(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`取不到 ${url}（${r.status}）`);
  return r.json();
}

// ---------------------------------------------------------------- 状态行（P3：收敛为一条）
function updateStatus() {
  const st = state.source;
  // 坐标：定稿原型口径 `x, -, z`；★手感实验室（showY）：3D 编辑里"高度"是关键信息，补上 y。
  // ★ 2026-10-11：显示的必须是**用户坐标**（原点在网格正中，可为负），不是内部索引。
  const u = state.hoverPos ? toUser(state.hoverPos) : null;
  const coord = u ? (FEEL.showY ? `${u[0]}, ${u[1]}, ${u[2]}` : `${u[0]}, -, ${u[2]}`) : '—';
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  setText('stCoord', coord);
  setText('stBlocks', st ? String(st.getBlocks().length) : '—');
  // 网格尺寸（用户要"无限建造" ⇒ 长大必须看得见）：显示尺寸 + 悬停看用户坐标范围/原点
  if (st) {
    const [sx, sy, sz] = st.size;
    const el = $('stSize');
    if (el) { el.textContent = `${sx}×${sy}×${sz}`; el.title = `网格尺寸 ${sx}×${sy}×${sz}（世界每长大一次就变大；无上限）`
      + `\n坐标原点在网格正中：x ${state.origin[0]}…${state.origin[0] + sx - 1}，y 0…${sy - 1}，z ${state.origin[2]}…${state.origin[2] + sz - 1}`
      + `\n（往网格外放方块会自动长大；已有方块的坐标不会变）`; }
  } else setText('stSize', '—');
  // 操作数 = **提交次数**（一组拖拽记 1 次）；撤销/重做**不增加**（它们不是"操作"）
  setText('stRev', String(state.edit?.commits ?? 0));
  setText('stHist', `↶${state.edit?.past?.length ?? 0} ↷${state.edit?.future?.length ?? 0}`);
  const undo = $('undoBtn'), redo = $('redoBtn');
  if (undo) undo.disabled = !state.edit?.canUndo;
  if (redo) redo.disabled = !state.edit?.canRedo;
}

// ---------------------------------------------------------------- 按需打包（P4）
/**
 * 该方块的「默认态属性」。
 * ★ 为什么必须有：MC 里裸名 = 默认态，而默认态在**注册表**里、资源包没有 ⇒ 纯 multipart 的方块
 *   （如 `ae2:controller`，每个 part 的 when 都要求 state/type）在"无属性"时一个模型都匹配不到，
 *   收不到模型与贴图，放上去就是**材质全丢**。服务端会按同一套规则算好回传，这里优先用它。
 */
function propsForBlock(id) {
  const cached = state.sceneDefaults && state.sceneDefaults[id];
  if (cached && Object.keys(cached).length) return cached;
  const reg = state.registryDefaults && state.registryDefaults[id];
  if (reg && Object.keys(reg).length) return reg;      // ② 注册表（权威，含 mod）
  const inline = BLOCK_DEFAULTS[id];                   // ③ 内联的**原版**默认态（同步可用；见构建脚本的注释）
  if (inline) return inline;
  const bs = window.__ASSETS__ && window.__ASSETS__.blockstates && window.__ASSETS__.blockstates[id];
  return bs ? defaultPropsOf(bs) : {};                 // ④ 近似推导兜底
}
/**
 * 该方块是否**必须**先向后端补一次默认态（异步）才能正确推断。
 * 原版方块一律不需要：需要推断的那些已经内联在 `BLOCK_DEFAULTS` 里，其余原版方块也没有可推断的属性。
 * 只有 **mod 方块**（非 `minecraft:` 命名空间）才可能"有连接/附着属性、但我们手上没有" ⇒ 才值得等一次往返。
 * ★ 这条判断直接决定 `actAt` 的**同步性**，而同步性是拖拽撤销组的生命线（见 actAt 里的注释）。
 */
const needsRemoteDefaults = (id) => !!id && !id.startsWith('minecraft:');

// ---------------------------------------------------------------- 状态推断（连接 / 附着 / 朝向，2026-10-12）
// 逻辑本身在 statelogic.js（纯函数，可 node 单测）。这里只负责**把世界接进去**、并在三处调用它：
//   ① 放置时（≈ 游戏的 getStateForPlacement）——按钮按命中面贴、栅栏当场接上旁边；
//   ② 每次编辑后（≈ updateShape）——邻居变了，周围的连接状态要跟着变（"放一块栅栏，旁边那块也长杆"）；
//   ③ 导入建筑后（只增不减）——把别的工具留下的"默认态孤柱/浮空按钮"补成正确的连接。
// 一句话说清为什么这三处都要：**默认态的语义就是"孤立的"**（见 statelogic.js 头部），
// 不主动算，放下去的栅栏永远是一根柱子、按钮永远贴着一堵不存在的北墙。
const OPAQUE_SET = new Set((window.__OPAQUE__ && window.__OPAQUE__.opaque) || []);
const SCHEMA_CACHE = new Map();
/** 方块 id → 取值域（来自 blockstates；预打包与按需打包两条路径都会把它放进 __ASSETS__） */
function schemaForBlock(id) {
  if (SCHEMA_CACHE.has(id)) return SCHEMA_CACHE.get(id);
  const bs = window.__ASSETS__ && window.__ASSETS__.blockstates && window.__ASSETS__.blockstates[id];
  const s = bs ? schemaOf(bs) : null;
  SCHEMA_CACHE.set(id, s);
  return s;
}
/** 世界查询：**索引坐标** → `{id, props}`（越界或空气 = null） */
function blockAtIdx(p) {
  const s = state.source;
  if (!s) return null;
  if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= s.size[0] || p[1] >= s.size[1] || p[2] >= s.size[2]) return null;
  const rec = s.blocksMap[(p[0] * s.size[1] + p[1]) * s.size[2] + p[2]];
  if (!rec) return null;
  const bs = s.palette[rec.state];
  return bs ? { id: bs.getName().toString(), props: bs.getProperties() || {} } : null;
}
/** 推断上下文：把"查邻居 / 完整方块表 / 取值域"三件事塞给纯函数（见 statelogic.js 的 ctx 说明） */
function stateCtx(pos, extra) {
  return {
    getAt: (dx, dy, dz) => blockAtIdx([pos[0] + dx, pos[1] + dy, pos[2] + dz]),
    isOpaque: (id) => OPAQUE_SET.has(id),
    schemaOf: schemaForBlock,
    ...extra,
  };
}
/**
 * 「邻居变化 ⇒ 重算受影响方块的连接」——游戏的 `updateShape` 干的就是这件事。
 * 只在放置时算一次是不够的：先摆栅栏、后放支撑方块（或反过来），两种顺序都得自然地对。
 *
 * 实现用**预演（delta）**：先在内存里把这一批 ops 的效果叠上去，再拿它当"新世界"重算 ——
 * 于是重算可以**并进同一次 commit**（一次 Ctrl+Z 全撤），既不用开撤销组，
 * 也不受调用方是否已经开组的影响（`applyProjection` / 框选填充都会开组）。
 */
function repairStates(ops) {
  const delta = new Map();                    // "x,y,z" → {id, props} | null（null = 本批里被删）
  for (const op of ops) {
    if (!state.edit || !state.edit.isInside(op.pos)) continue;
    delta.set(op.pos.join(','), op.kind === 'erase' ? null : { id: op.id, props: op.props || {} });
  }
  const ctxAt = (pos) => ({
    getAt: (dx, dy, dz) => {
      const p = [pos[0] + dx, pos[1] + dy, pos[2] + dz];
      const k = p.join(',');
      return delta.has(k) ? delta.get(k) : blockAtIdx(p);
    },
    isOpaque: (id) => OPAQUE_SET.has(id),
    schemaOf: schemaForBlock,
  });
  const curAt = (p) => {
    const k = p.join(',');
    return delta.has(k) ? delta.get(k) : blockAtIdx(p);
  };
  const seen = new Set(), out = [];
  for (const op of ops) {
    for (const p of affectedBy(op.pos)) {
      const k = p.join(',');
      if (seen.has(k)) continue;              // 同一格被多批 ops 影响时只算一次
      seen.add(k);
      const b = curAt(p);
      if (!b) continue;                       // 空气/越界：没什么可重算的
      const next = inferConnect(b.id, b.props, ctxAt(p));
      if (next) out.push({ kind: 'place', pos: p, id: b.id, props: next });
    }
  }
  return out;
}
/**
 * 全量补连接（**只增不减**）——导入现成建筑后用。
 * 为什么只增不减：文件里的连接是游戏算出来的权威值，我们只该补"缺的"，不该撤"已有的"
 * （我们的连接判定是近似：例如玻璃不在"完整立方体表"里 ⇒ 我们判"不连"，而游戏里栅栏是连玻璃的 ——
 *  若双向重算，就会把文件里正确的 true 改成 false，那才是真把数据改坏）。
 */
function growConnectAll() {
  const st = state.source;
  if (!st) return [];
  const out = [];
  for (const b of st.getBlocks()) {
    const id = b.state.getName().toString();
    const props = b.state.getProperties() || {};
    const next = inferConnect(id, props, stateCtx(b.pos, { growOnly: true }));
    if (next) out.push({ kind: 'place', pos: b.pos.slice(), id, props: next });
  }
  return out;
}
// 优先让服务端只打包"这个建筑用到的贴图"（/api/scene → 小图集 + 配套模型表）；
// 服务端不可用（没带 --api / 读不到实例）时自动回落到预打包的 data/assets.js + data/atlas.png。
/**
 * 确保"这个方块的默认态"拿得到（**缺就补一次**）。
 *
 * ★ 为什么必须有（2026-10-12 实测，闸门 (U0c) 诊断给出的数字）：按需打包只收**当前建筑用到的 state**
 *   （`statesOfBuild(build)`），而用户会从物品栏放**建筑里没有的**方块（栅栏、按钮、玻璃板……）。
 *   在功能包里 `state.registryDefaults` 是空的（包内没有静态侧车文件，见 registry.js），
 *   而按需打包成功时又**不会**落回预打包 ⇒ `window.__ASSETS__` 也不会被懒加载
 *   ⇒ `propsForBlock()` 只能返回 `{}` ⇒ **状态推断无从下手**（连"它有四向属性"都不知道）
 *   ⇒ 放下去依旧是孤柱 / 浮空的按钮。这正是用户报的那个 bug 的**真正源头**。
 * 做法：把方块的**裸名**（无属性）加进 want 再要一次 scene —— 后端对裸名会按**注册表**补默认态回传
 *   （见 scene-assets.mjs 的 `bare` 分支），并且会把该方块的**全部变体模型收全**
 *   （连接/附着/multipart 方块一律收全，见那里的注释），所以推断出来的新 state 也画得出来。
 * 只在"确实缺"时往返一次；拿到就并进 `sceneDefaults`，后续放置直接命中缓存。
 */
const blockFixPending = new Map();
async function ensureBlockDefaults(id) {
  const have = state.sceneDefaults && state.sceneDefaults[id];
  if (have && Object.keys(have).length) return have;
  if (!state.build || !state.vp || !id) return null;
  if (blockFixPending.has(id)) return blockFixPending.get(id);
  const p = (async () => {
    try {
      const want = statesOfBuild(state.build);
      want.push(stateStringOf(id, {}));             // 裸名 ⇒ 后端按注册表补默认态
      const scene = await hostScene(want);
      if (scene.key !== state.sceneKey) {
        const r = await buildResources(D, {
          assets: scene.assets, opaque: scene.flags || window.__OPAQUE__ || {}, atlasUrl: scene.atlasUrl,
        });
        state.sceneKey = scene.key;
        state.sceneStates = want;
        state.vp.setResources(r.resources);
      }
      state.sceneDefaults = { ...(state.sceneDefaults || {}), ...(scene.defaults || {}) };
    } catch { /* 后端不可用：保持原样（propsForBlock 还有别的兜底） */ }
    return (state.sceneDefaults || {})[id] || null;
  })();
  blockFixPending.set(id, p);
  const done = () => blockFixPending.delete(id);
  p.then(done, done);
  return p;
}

function statesOfBuild(build) {
  const out = new Set();
  for (const p of build?.palette || []) if (p && p.Name) out.add(stateStringOf(p.Name, p.Properties || {}));
  return [...out];
}
function setStat(res) {
  const el = $('stat');
  if (!el) return;                    // 状态行已收敛为一条，资源统计不再是必备字段
  const s = res.stats || {};
  const how = res.onDemand ? '按需' : '预打包';
  // 预打包路径给的字段叫 atlasSize（数字），按需打包给的叫 atlas（"1024²" 字符串）—— 统一在这里归一
  const size = s.atlasSize ?? (parseInt(String(s.atlas || ''), 10) || '?');
  const skip = s.skipped ? ` / 跳过 ${s.skipped}` : '';
  $('stat').textContent = `${s.blockstates ?? '?'} blockstates / ${s.models ?? '?'} models / ${how}图集 ${size}² / 物品 ${state.inv ? state.inv.total : 0}${skip}`;
}
/** 懒加载预打包的 assets.js（只有按需打包不可用时才读它，省掉一次 2.8 MB 的解析） */
function ensurePrebaked() {
  if (window.__ASSETS__) return Promise.resolve(window.__ASSETS__);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'data/assets.js';
    s.onload = () => (window.__ASSETS__ ? resolve(window.__ASSETS__) : reject(new Error('data/assets.js 里没有 __ASSETS__')));
    s.onerror = () => reject(new Error('取不到 data/assets.js'));
    document.head.appendChild(s);
  });
}
/** 把「后端给的场景」装成 Deepslate 资源（按需路径与空场景兜底共用） */
async function applyScene(scene, want) {
  state.sceneKey = scene.key;
  state.sceneStates = want;          // 这套资源**覆盖**了哪些方块状态（放置新方块时据此判断要不要按需补）
  state.sceneDefaults = scene.defaults || {};
  state.sceneFlags = scene.flags || null;
  state.sceneTruncated = scene.truncated || null;   // U4：后端截断标记（非空就要显黄条）
  const r = await buildResources(D, { assets: scene.assets, opaque: scene.flags || window.__OPAQUE__ || {}, atlasUrl: scene.atlasUrl });
  return { ...r, onDemand: true };
}
/**
 * 截断提示（审核员 U4）：后端为了限制体积会截断（states / missing / icons），
 * 以前是**无声**的 —— 用户看到"少了"却不知道为什么。这里只要有截断就回一句可读的话。
 */
const TRUNC_LABEL = { states: '方块状态', missing: '缺失资源', icons: '图标' };
function truncNote(scene) {
  const t = (scene && scene.truncated) || state.sceneTruncated;
  if (!t) return '';
  const parts = Object.entries(t).filter(([, n]) => n > 0).map(([k, n]) => `${TRUNC_LABEL[k] || k} ${n} 条`);
  return parts.length ? `后端截断：${parts.join('，')}（结果不完整）` : '';
}
async function loadResourcesFor(build) {
  try {
    const want = statesOfBuild(build);
    const scene = await hostScene(want);          // 独立网页走 /api/scene；功能包走宿主 preload
    console.info('[scene] 按需打包', scene.stats, scene.missing.length ? `缺 ${scene.missing.length}` : '');
    return await applyScene(scene, want);
  } catch (e) {
    state.sceneError = String((e && e.message) || e);
    // ★ 功能包里**没有静态文件**（data/assets.js 不在包内、宿主也不给包内静态路径）⇒ 绝不能走预打包回落，
    //   否则只会再报一次「取不到 data/assets.js」。改用后端给的**空场景**保底：网格照画，
    //   之后放置方块时按需扩展会把真实资源补进来。
    if (isFeature()) {
      setMsg(`按需打包不可用：${state.sceneError}`, 'warn');
      return await applyScene(await hostScene([]), []);
    }
    state.sceneStates = 'ALL';         // 回落用的是预打包全量资源 ⇒ 任意方块都在里面，不需要按需扩展
    setMsg(`按需打包不可用，改用预打包图集：${state.sceneError}`, 'warn');
    const assets = await ensurePrebaked();
    return { ...(await buildResources(D, { assets, opaque: window.__OPAQUE__ || {} })), onDemand: false };
  }
}
/** 当前资源是否已覆盖某个方块 id */
function sceneCovers(id) {
  const s = state.sceneStates;
  if (s === 'ALL') return true;
  return Array.isArray(s) && s.includes(id);
}
/**
 * ★ 按需**扩展**场景资源：把新方块的 blockstates/models/textures 补进当前这套资源。
 * 没有这一步，"从物品栏放一个当时不在场景里的方块（尤其 mod 方块）"会因为模型/贴图都不在资源里而放不出来 ——
 * 这是按需打包引入的系统性问题，必须在工具层解决，而不是逐个方块打补丁。
 */
async function growScene(id) {
  try {
    const want = [...(Array.isArray(state.sceneStates) ? state.sceneStates : []), id];
    const scene = await hostScene(want);
    if (scene.unknownStates.includes(id)) {
      setMsg(`「${id}」在实例里没有方块定义（多半是物品而不是方块），放不下`, 'warn');
      return false;
    }
    if (scene.key === state.sceneKey) { state.sceneStates = want; return true; }
    const r = await buildResources(D, { assets: scene.assets, opaque: scene.flags || window.__OPAQUE__ || {}, atlasUrl: scene.atlasUrl });
    state.sceneKey = scene.key;
    state.sceneStates = want;
    state.sceneDefaults = { ...(state.sceneDefaults || {}), ...(scene.defaults || {}) };
    state.sceneFlags = { ...(state.sceneFlags || {}), ...(scene.flags || {}) };
    state.vp.setResources(r.resources);       // 热换图集：视口对象不变，事件不用重绑
    ghostSig = '';                            // ★ 资源换了 ⇒ 去重签名作废，否则虚影不重建（拿旧图集 UV 画新图集 = 花）
    refreshGhost();
    setStat({ ...r, onDemand: true });
    return true;
  } catch (e) {
    setMsg('按需补资源失败（这个方块可能仍放不出来）：' + ((e && e.message) || e), 'err');
    return false;
  }
}
/** 换建筑时热换资源：图集变了要换渲染器，但视口对象不变（事件处理器闭包引用它，不用重绑） */
async function refreshScene(build) {
  if (!state.vp || !build) return;
  try {
    const want = statesOfBuild(build);
    const scene = await hostScene(want);
    if (scene.key === state.sceneKey) { state.sceneStates = want; return; }
    const r = await buildResources(D, { assets: scene.assets, opaque: scene.flags || window.__OPAQUE__ || {}, atlasUrl: scene.atlasUrl });
    state.sceneKey = scene.key;
    state.sceneStates = want;
    state.sceneTruncated = scene.truncated || state.sceneTruncated;
    state.vp.setResources(r.resources);
    ghostSig = '';                            // ★ 同上：换图集必须让虚影重建
    refreshGhost();
    setStat({ ...r, onDemand: true });
    setMsg(`已按需打包：${scene.stats.textures} 张贴图 / 图集 ${scene.stats.atlas}${truncNote(scene) ? ' · ' + truncNote(scene) : ''}`,
      truncNote(scene) ? 'warn' : '');
  } catch (e) {
    setMsg('切换建筑的按需打包失败，沿用当前图集：' + ((e && e.message) || e), 'warn');
  }
}

// ---------------------------------------------------------------- 项目（多项目存档，2026-10-11）
// ★ 本段**替换**了原来那套"单个 sessionStorage 快照"。旧实现只有一个 key，
//   于是「新建」只能 clearSave() 把上一个项目抹掉 —— 这正是用户报的"每次新建都丢旧项目"。
//   现在每个项目一个 key（见 projects.js）：新建 = 建一个新项目、切换 = 换 key 载入，谁都不覆盖谁；
//   自动保存**按项目**落盘。存档格式用紧凑编码（实测 2.73× 压缩）以对冲 localStorage 的容量墙。
//   存储后端为什么选 localStorage 而不是 IndexedDB：见 projects.js 头部注释（一句话：
//   IDB 的往返在 --virtual-time-budget 下闸门观测不到，而"不丢数据"这条必须能被断言证明）。
const SAVE_DEBOUNCE = 500;
let saveTimer = null;
let curProjId = '';          // 当前项目 id（空 = 项目层没就绪）
let projReady = false;       // ★ 就绪闸：启动中途（世界还是空的）绝不写盘，否则会把真数据盖成空世界
let syncGroupOpen = null;    // 由 bindToolbar 里赋值：打开某个下拉（供闸门/程序内部用）

const emptyBuild = (name) => ({
  format: 'empty', name: name || '新建建造世界', size: [32, 16, 32],
  palette: [], blocks: [], stats: { blocks: 0 }, source: 'new',
});
function snapshotOf() {
  if (!state.source || !state.edit) return null;
  return structureToBuildJson(state.source, {
    name: (state.build && state.build.name) || '编辑会话', format: 'autosave', source: 'autosave',
  });
}
/** 保存状态小字。★ 三种状态必须**可区分**（未保存 / 已保存 / 失败），不能都写"就绪"。 */
function setSaveState(kind, text) {
  const el = $('projSave');
  if (!el) return;
  el.textContent = text;
  el.className = 'saveState' + (kind === 'err' ? ' err' : (kind === 'dirty' ? ' warn' : ''));
}
function projNameOf(id) {
  const p = projects.list().find((x) => x.id === id);
  return p ? p.name : '(已删除)';
}
/** 落盘。manual = 用户按了「保存」/ Ctrl+S（成功要回话、失败要醒目）。 */
function flushSave(manual) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!projReady || !curProjId) return { ok: false, why: '项目还没就绪' };
  const snap = snapshotOf();
  if (!snap) return { ok: false, why: '世界还没准备好' };
  const r = projects.save(curProjId, snap);
  if (!r.ok) {
    setSaveState('err', '保存失败');
    setMsg(r.why, 'err');
    return r;
  }
  setSaveState('ok', '已保存 ' + fmtTime(Date.now()));
  if (manual) {
    setMsg('已保存到项目「' + projNameOf(curProjId) + '」：' + (r.blocks || 0) + ' 方块 / '
      + ((r.bytes || 0) / 1024).toFixed(1) + 'KB');
  }
  refreshProjList();
  return r;
}
function scheduleSave() {
  if (!projReady || !curProjId) return;      // 就绪前不写盘（否则会把别的项目盖掉）
  if (saveTimer) clearTimeout(saveTimer);
  setSaveState('dirty', '未保存…');
  saveTimer = setTimeout(() => flushSave(false), SAVE_DEBOUNCE);
}
/** 旧版单快照的会话恢复条（v1.11.0 及以前）。新流程是"直接载入上次项目"，不再需要它；
 *  但卸载清理那行还引用 dismissToast，所以保留一个安全的空实现。 */
let toastEl = null;
function dismissToast() { if (toastEl) { try { toastEl.remove(); } catch { /* 已摘 */ } toastEl = null; } }
function fmtTime(ms) {
  try { return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); } catch { return '--:--'; }
}

/** 项目列表渲染（下拉里那一列 + 底部的容量说明） */
function refreshProjList() {
  const box = $('projList');
  const nm = $('projName');
  if (nm) nm.textContent = curProjId ? projNameOf(curProjId) : '—';
  if (box) {
    const list = projects.list().slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    box.textContent = '';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'proj-empty';
      d.textContent = '还没有项目';
      box.appendChild(d);
    }
    for (const p of list) {
      const b = document.createElement('button');
      b.className = 'proj-row' + (p.id === curProjId ? ' cur' : '');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.pid = p.id;                       // 闸门据此点"第 N 个项目"
      const n1 = document.createElement('span');
      n1.className = 'nm'; n1.textContent = p.name;
      const n2 = document.createElement('span');
      n2.className = 'meta';
      n2.textContent = (p.blocks || 0) + ' 块 · ' + ((p.bytes || 0) / 1024).toFixed(0) + 'KB · ' + fmtTime(p.at);
      b.appendChild(n1); b.appendChild(n2);
      b.onclick = () => switchProject(p.id);
      box.appendChild(b);
    }
  }
  const u = $('projUsage');
  if (u) {
    const g = projects.usage();
    u.textContent = '存档 ' + (g.chars / 1048576).toFixed(2) + 'MB / 上限 ' + (g.max / 1048576).toFixed(1)
      + 'MB（浏览器给本站的额度）· 每个项目独立存档，切换不会丢';
  }
}

/** 切到某个项目：先把当前项目落盘（不丢），再载入目标。 */
function switchProject(id) {
  if (!id || id === curProjId) { if (syncGroupOpen) syncGroupOpen(null); return { ok: false, why: 'already' }; }
  if (curProjId && projReady) flushSave(false);          // ★ 关键：切换前先存当前项目
  const build = projects.load(id);
  if (!build) {
    setMsg('项目载入失败（存档损坏或被清掉）', 'err');
    return { ok: false, why: 'load-failed' };
  }
  curProjId = id;
  projects.setLast(id);
  projReady = true;
  loadBuild(build, 'project');
  setSaveState('ok', '已保存 ' + fmtTime(Date.now()));
  setMsg('已切换项目「' + projNameOf(id) + '」：' + build.blocks.length + ' 方块'
    + (build.blocks.length ? '' : '（空项目，选个方块点一下放下第一块）'));
  refreshProjList();
  if (syncGroupOpen) syncGroupOpen(null);
  return { ok: true, id, blocks: build.blocks.length };
}

/** 新建项目（★ 不再销毁当前项目 —— 这是本次要修的核心毛病） */
function newProject() {
  if (curProjId && projReady) flushSave(false);
  const prev = curProjId;
  const prevBlocks = prev ? (projects.list().find((p) => p.id === prev) || {}).blocks || 0 : 0;
  const n = projects.list().length + 1;
  const r = projects.create('建筑 ' + n, emptyBuild('建筑 ' + n));
  if (!r.ok) { setMsg(r.why, 'err'); return r; }
  curProjId = r.id;
  projReady = true;
  loadBuild(emptyBuild('建筑 ' + n), 'new');
  setSaveState('dirty', '未保存…');
  scheduleSave();                                   // 立刻建一个新存档副本，免得"新项目"还没落盘
  setMsg(prev ? ('已新建项目「建筑 ' + n + '」（原项目保留：' + prevBlocks + ' 方块，可在项目列表里切回）')
    : '已新建项目「建筑 ' + n + '」');
  refreshProjList();
  if (syncGroupOpen) syncGroupOpen(null);
  return { ok: true, id: r.id };
}

function dupProject() {
  if (!curProjId) return { ok: false };
  const b = projects.load(curProjId);
  if (!b) { setMsg('副本失败：当前项目读不出来', 'err'); return { ok: false }; }
  flushSave(false);
  const r = projects.create(projNameOf(curProjId) + ' 副本', b);
  if (!r.ok) { setMsg(r.why, 'err'); return r; }
  setMsg('已另存为副本：' + projNameOf(r.id));
  refreshProjList();
  return r;
}

function renameProject() {
  if (!curProjId) return { ok: false };
  const old = projNameOf(curProjId);
  let next = null;
  try { next = window.prompt('项目名', old); } catch { next = null; }
  if (next == null) return { ok: false, why: 'cancel' };
  next = String(next).trim();
  if (!next || next === old) return { ok: false, why: 'nochange' };
  const r = projects.rename(curProjId, next);
  if (!r.ok) { setMsg(r.why, 'err'); return r; }
  if (state.build) state.build.name = next;
  setMsg('已重命名为「' + next + '」');
  refreshProjList();
  scheduleSave();
  return r;
}

function deleteProject() {
  if (!curProjId) return { ok: false };
  const list = projects.list();
  const n = list.length;
  if (n <= 1) { setMsg('至少保留一个项目（删掉最后一个就没地方存了）', 'warn'); return { ok: false, why: 'last' }; }
  const nm = projNameOf(curProjId);
  let yes = true;
  try { yes = window.confirm('删除项目「' + nm + '」？此操作不可撤销。'); } catch { yes = true; }
  if (!yes) return { ok: false, why: 'cancel' };
  const r = projects.remove(curProjId);
  if (!r.ok) { setMsg(r.why, 'err'); return r; }
  const next = r.last || (projects.list()[0] || {}).id;
  curProjId = '';
  setMsg('已删除项目「' + nm + '」');
  if (next) switchProject(next);
  else newProject();
  return { ok: true };
}

/** 启动：迁移旧快照 → 保证至少一个项目 → 决定"这次打开要载入哪个"。 */
function bootProjects() {
  const mig = projects.migrateLegacy();
  let list = projects.list();
  if (!list.length) {
    const r = projects.create('我的建筑', emptyBuild('我的建筑'));
    if (!r.ok) { projReady = false; setSaveState('err', r.why); return { ok: false, why: r.why, migrated: mig }; }
    list = projects.list();
  }
  curProjId = projects.lastId() || list[0].id;
  projReady = true;
  return { ok: true, id: curProjId, list, migrated: mig, build: projects.load(curProjId) };
}


// ---------------------------------------------------------------- 编辑动作
/**
 * 投影虚影的**画面级**验证（同 selPreviewAB 的思路，2026-10-12）：
 * 抓两帧逐像素比 —— A = 有虚影、B = 清掉虚影。差异 > 0 才说明"虚影**真的画出来了**"，
 * 而不是"ghostInfo 里有个数字"（本项目的老教训：计数保得了字符串，保不了"提交上去了没有"）。
 * 相机对准投影中心（否则虚影可能整个在画面外 ⇒ 差异恒 0 ⇒ 判据变成假绿）。
 * 反向对照交给闸门：投影为空时 diff 必须为 0。
 */
async function projGhostAB() {
  const vp = state.vp;
  if (!vp) throw new Error('视口尚未初始化');
  vp.stopLoop();
  const gl = vp.gl;
  const savedCam = { xr: vp.cam.xr, yr: vp.cam.yr, dist: vp.cam.dist, target: [...vp.cam.target] };
  const d = projectionDiff();
  if (d) {
    const cl = d.sameCells.concat(d.diffCells).map((c) => c.pos);   // 现在每项是 {pos,id,props}
    const xs = cl.map((p) => p[0]), zs = cl.map((p) => p[2]);
    const minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
    const minz = Math.min.apply(null, zs), maxz = Math.max.apply(null, zs);
    vp.cam.target = [(minx + maxx + 1) / 2, 1, (minz + maxz + 1) / 2];
    vp.cam.dist = Math.max(8, Math.max(maxx - minx + 1, maxz - minz + 1) * 3);
    vp.cam.xr = 0.9; vp.cam.yr = 0.6;
  }
  const grab = () => {
    vp.draw();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  let a, b;
  try {
    if (d) vp.setProjGhost(d.sameCells, d.diffCells, d.ghostSize, d.ghostOrigin);
    a = grab();
    vp.clearProjGhost();
    b = grab();
  } finally {
    ghostSig = '';                       // 上面动过虚影 ⇒ 让 refreshGhost 无条件重建回来
    refreshGhost();
    vp.cam.xr = savedCam.xr; vp.cam.yr = savedCam.yr; vp.cam.dist = savedCam.dist; vp.cam.target = savedCam.target;
    vp.draw();
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  }
  return { diff, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, cells: d ? d.sameCells.length + d.diffCells.length : 0 };
}

/**
 * 提交一次编辑。
 * ★ 2026-10-12 起，这里会**自动带上"邻居连接重算"**（见 repairStates）—— 因为方块的连接状态
 *   是"邻居的函数"：放一块栅栏要在旁边那块上也长出一根杆、删一块支撑要让旁边的玻璃板收回去。
 *   重算结果与用户 ops **并进同一次 commit** ⇒ 一次 Ctrl+Z 连重算一起撤销（不会撤销两次）。
 * `opts.repair === false` ⇒ 跳过重算。什么时候要跳：**只增不减的全量补连接**（导入建筑后那一次）——
 *   那批 ops 本身就是保守修正，再走一趟双向重算会把文件里正确的连接按我们的近似判据反着改掉
 *  （见 growConnectAll 的注释：我们的判定是近似，不能拿它去否决权威值）。
 */
function doEdit(ops, opts) {
  const fix = (opts && opts.repair === false) ? [] : repairStates(ops);
  const all = fix.length ? ops.concat(fix) : ops;
  const res = state.edit.commit(all, CHUNK_SIZE);   // ★ 必须与视口同一套分块（见 chunksOf 的注释）
  if (!res.changes.length) return false;
  // 编辑只需刷新受影响的 chunk。★ 2026-10-12：分层不再需要"把 ops 同步进视图"——
  //   分层是绘制筛选（见 applyLayer），数据结构永远是完整的，所以这里一行额外处理都不用做。
  state.vp.updateBuffers(res.chunks);
  updateStatus();
  // 建筑变了 ⇒ 投影差异变了 ⇒ 虚影重画。★ 走**延迟**版：拖拽放方块时每块都会改差异，
  //   同步重建会把 O(块数) 的活儿摊到每个鼠标事件上（越大越顿）。
  scheduleGhost();
  scheduleSave();                    // U3：编辑后防抖落盘（去掉这句 = 变异，闸门 E9-a 必须红）
  return true;
}
/**
 * ★ 世界长大（2026-10-11 重构：**正负两方向都行**，用户要「摆放没有限制」）。
 *   · 正方向（dx=dy=dz=0 + target）：按 8 的倍数长大，**原坐标不变**；
 *   · 负方向（dx/dy/dz>0）：**平移式扩展**——新世界把旧内容整体 +offset，读作"左边/下边/前边多出了空间"；
 *     撤销/重做历史里的坐标由 EditStack.translate 一起迁移，所以历史依然有效。
 * 共同点：保留调色板顺序（下标不变）；分层视图整体重建（坐标全变了，低频操作）。
 */
function shiftWorld(dx, dy, dz, target) {
  const st = state.source;
  const [sx, sy, sz] = st.size;
  const nsize = target || [sx + dx, sy + dy, sz + dz];
  const next = new D.Structure(nsize, st.palette.slice(), []);
  for (const b of st.getBlocks()) {
    next.addBlock([b.pos[0] + dx, b.pos[1] + dy, b.pos[2] + dz], b.state.getName().toString(), b.state.getProperties() || {});
  }
  if (dx || dy || dz) state.edit.translate(dx, dy, dz);
  state.source = next;
  state.edit.structure = next;
  state.vp.setStructure(next);
  state.layerMax = Infinity;
  const sy2 = nsize[1];
  $('layer').max = String(sy2 - 1);
  $('layer').value = String(sy2 - 1);
  $('layerVal').textContent = '全部';
  syncAxes();
  updateStatus();
  return nsize;
}
/** 镜像轴（世界中心线）同步给视口绘制；开镜像时可见（2026-10-11）。 */
function syncAxes() {
  if (!state.vp || !state.vp.setAxes) return;
  const s = state.source ? state.source.size : [1, 1, 1];
  state.vp.setAxes({
    x: state.mirrorX ? s[0] / 2 : null,
    z: state.mirrorZ ? s[2] / 2 : null,       // 镜像 Z 面（前后对称）—— 对应蓝色的 Z 轴
    // ★ 2026-10-12：**Y 镜像已按用户要求移除**（只留 X/Z）。原因是它的轴"会漂"：
    //   镜像面 = 世界高度/2，而世界**只向上长**（x/z 是两侧对称长）⇒ 一往高处建，Y 的镜像面就跟着往上移，
    //   于是"X 轴稳定、Y 轴漂"。地面锚定的编辑器里 Y 镜像也没有自然语义（往下就是地下，放不了）。
    //   这里恒为 null ⇒ 视口那条 y 轴线随之不再绘制。
    y: null,
    extent: [s[0], s[1], s[2]],
    // 坐标原点在**索引**空间的列（user 0 对应的索引 = -origin）—— 视口据此把坐标轴画在原点，
    // 而不是 Deepslate 默认的「角落」（原点居中后，角落那三条轴会指错地方）。
    origin: [-state.origin[0], -state.origin[1], -state.origin[2]],
  });
}
/**
 * 左下角的**坐标轴指示器**（2026-10-12 用户问"z 轴不都是竖着的吗"之后加的）。
 * 三根线的方向由视口按视图矩阵算（axisScreenDirs），这里只负责摆 DOM；字母**反向旋转**保持正立。
 * 为什么用 DOM 而不是画进 GL：字母要清晰，而在 GL 里画字得做字形纹理，代价大得多；
 * 这只是个 2D 覆盖层，CSS 转一下最省事、也不占渲染预算。
 */
function updateAxisGizmo() {
  const el = $('axisGizmo');
  if (!el || !state.vp || !state.vp.axisScreenDirs) return;
  const d = state.vp.axisScreenDirs();
  for (const k of ['x', 'y', 'z']) {
    const line = el.querySelector('.axl-' + k);
    if (!line || !d[k]) continue;
    const v = d[k];
    const ang = Math.atan2(v.y, v.x) * 180 / Math.PI;
    line.style.transform = 'rotate(' + ang.toFixed(1) + 'deg)';
    line.style.opacity = v.z > 0 ? '0.4' : '1';        // 背离观察者 ⇒ 淡显（一点深度线索）
    const lb = line.querySelector('i');
    if (lb) lb.style.transform = 'rotate(' + (-ang).toFixed(1) + 'deg)';   // 字母不跟着转
  }
}

/** 用户坐标 ↔ 内部索引（见 state.origin 的注释）。 */
function toUser(p) { return [p[0] + state.origin[0], p[1] + state.origin[1], p[2] + state.origin[2]]; }
function fromUser(p) { return [p[0] - state.origin[0], p[1] - state.origin[1], p[2] - state.origin[2]]; }
/** 载入/新建时把原点摆到网格中心（x/z 居中；y=0 仍是地面/网格平面）。 */
function centerOrigin(size) {
  state.origin = [-Math.floor(size[0] / 2), 0, -Math.floor(size[2] / 2)];
}

const GROW_STEP = 8;                 // 扩展粒度（8 的倍数：chunk 友好）
const GROW_MAX_AXIS = 64;            // 单轴**单次**最多扩这么多格。为什么是 64 而不是更大：
                                     //   x/z 是**对称扩**（两侧各 pad ⇒ 一次 +2×pad），256 的落点会让世界一次 +512/轴；
                                     //   实测连点两次就到 ~900 宽，fit 把相机拉到 2000 开外 ⇒ 用户反而看不清自己建的东西。
                                     //   64 ⇒ 一次 +128/轴，仍然"点到哪长到哪"，更远的点多点几次即可（提示里已说明）。
const VOLUME_MAX = 0x10000000;       // 2^28 = 2.68 亿格：blocksMap 是扁平索引数组（下标上限 2^32），留足余量

/** 某轴上"要容纳 index 坐标 p"需要新增多少格（8 的倍数；够则 0）。 */
function padNeeded(p, s) {
  if (p < 0) return Math.max(GROW_STEP, Math.ceil(-p / GROW_STEP) * GROW_STEP);
  if (p >= s) return Math.max(GROW_STEP, Math.ceil((p + 1 - s) / GROW_STEP) * GROW_STEP);
  return 0;
}

/**
 * ★ 无限建造 + 原点恒定（2026-10-11 用户："现在有网格限制，我希望没有限制，可以无限建造"
 *   + "原点移到网格中心"）。
 *
 * 出界 ⇒ 长大到能容纳它：
 *   · x/z **对称扩**（两侧各 pad 格）⇒ 网格中心恒等于用户坐标 0（原点永远在网格正中）；
 *     同时 `state.origin` 反向搬 pad ⇒ **已有方块的用户坐标一格都不变**
 *     （不再是旧行为"扩一次边、所有方块整体 +N 重编号"）。
 *   · y **只向上扩**（地面恒为 y=0；向下拒绝并说明）。
 *   · 单轴单次上限 GROW_MAX_AXIS、总体积上限 VOLUME_MAX：超了拒绝并说清怎么继续。
 * 返回 { ok, grew?, shift?, why? }；shift = 内部索引需要平移的量（调用方必须把目标坐标加上去）。
 */
function ensureBounds(pos) {
  const st = state.source;
  const [sx, sy, sz] = st.size;
  if (pos.every((v) => v >= 0) && pos[0] < sx && pos[1] < sy && pos[2] < sz) return { ok: true, shift: [0, 0, 0] };
  if (pos[1] < 0) return { ok: false, why: '地面以下放不了（y=0 是地面/网格平面）—— 本工具只能向上、向四周扩' };
  const gx = padNeeded(pos[0], sx), gz = padNeeded(pos[2], sz);
  const gy = pos[1] >= sy ? padNeeded(pos[1], sy) : 0;
  const over = Math.max(gx, gy, gz);
  if (over > GROW_MAX_AXIS) {
    return { ok: false, why: `离得太远：一次要扩 ${over} 格，超过单次上限 ${GROW_MAX_AXIS} 格 —— 往近处点，或多点几次逐步扩` };
  }
  const nsize = [sx + gx * 2, sy + gy, sz + gz * 2];
  if (nsize[0] * nsize[1] * nsize[2] > VOLUME_MAX) {
    return { ok: false, why: `再扩就 ${nsize.join('×')} 了（超过 ${VOLUME_MAX / 1e6} 百万格上限）—— 已经非常大，换个方向建或先清掉远处的方块` };
  }
  // ★ 顺序要求：先把 origin 搬到位，再 shiftWorld —— shiftWorld 内部会 syncAxes()，
  //   而轴线位置是按"新尺寸 + 新原点"算的。反过来写（先 shiftWorld 再搬 origin）会让
  //   网格里画出来的坐标轴**落后一次长大**（闸门 (E4) 抓到的就是这个：gridOrigin 差 8）。
  state.origin[0] -= gx; state.origin[2] -= gz;   // 原点跟着搬 ⇒ 已有方块的用户坐标不变
  shiftWorld(gx, gy, gz, nsize);
  return { ok: true, grew: nsize, shift: [gx, 0, gz] };
}
/**
 * 镜像点集（2026-10-11 重构：X/Y 双轴 + 去重；用户要求「坐标在网格中间，xy 都有镜像轴」）。
 * 轴 = **世界中心线**（x=W/2 的竖直面、y=H/2 的水平面——即网格正中，与视口里画出的轴线一致）：
 *   X 镜像 x' = W-1-x；Y 镜像 y' = H-1-y；两轴同开时再加上对角点（最多 4 格）。
 * 返回**包含自身**的去重坐标列表。
 */
function mirrorPoints(p) {
  const out = [p.slice()];
  const addIf = (q) => { if (q && !out.some((o) => o[0] === q[0] && o[1] === q[1] && o[2] === q[2])) out.push(q); };
  const [W, , D] = state.source.size;
  const mx = W - 1 - p[0], mz = D - 1 - p[2];
  const doX = !!state.mirrorX && mx !== p[0];
  const doZ = !!state.mirrorZ && mz !== p[2];
  // ★ 两轴**独立**、可同时开；同开时再加对角格 ⇒ 一次最多落 4 块（四个方向都对折）。
  //   X 与 Z 的轴都是世界中心线（索引 (W-1)/2、(D-1)/2）—— x/z 是**两侧对称**长大的
  //   ⇒ 网格中心恒等于用户坐标 0，轴不随世界长大而漂（这正是 X/Z 能留、Y 不能留的区别）。
  if (doX) addIf([mx, p[1], p[2]]);
  if (doZ) addIf([p[0], p[1], mz]);
  if (doX && doZ) addIf([mx, p[1], mz]);
  return out;
}
async function actAt(pos, normal) {
  if (state.mode === 'erase') {
    const ops = mirrorPoints(pos).map((q) => ({ kind: 'erase', pos: q }));
    if (doEdit(ops)) setMsg(`已删除 ${toUser(pos).join(', ')}${ops.length > 1 ? `（含镜像对称格 ×${ops.length}）` : ''}`);
    return;
  }
  if (state.mode === 'pick') {
    const p = state.source.palette[state.source.blocksMap[(pos[0] * state.source.size[1] + pos[1]) * state.source.size[2] + pos[2]]?.state];
    if (p) pickIntoInventory(p.getName().toString());
    return;
  }
  // place：放在命中面的相邻格
  const air = [pos[0] + normal[0], pos[1] + normal[1], pos[2] + normal[2]];
  const row = state.inv?.selectedRow;
  if (!row) { setMsg('先在左侧选一个物品', 'warn'); return; }
  if (row.isBlock === false) {
    setMsg(`「${row.name}」是物品不是方块，放不到场景里（想取场景里的方块请用「拾取」）`, 'warn');
    return;
  }
  // 出界 ⇒ 先把**网格长大**（无限建造：x/z 对称扩、y 向上扩，见 ensureBounds），失败才拒绝。
  // 返回 { ok, shift }：长大时内部索引会整体平移，调用方要把目标坐标也加上去（用户坐标不变）。
  const ensure = (p) => {
    if (state.edit.isInside(p)) return { ok: true, shift: [0, 0, 0] };
    const fit = ensureBounds(p);
    if (!fit.ok) { setMsg(fit.why, 'warn'); return { ok: false } };
    if (fit.grew) {
      const sh = fit.shift || [0, 0, 0];
      const side = sh[0] || sh[2];
      setMsg(`网格已长大到 ${fit.grew.join('×')}${side ? '（两侧对称扩，坐标原点仍在网格正中、已有坐标不变）' : '（原坐标不变）'}`);
    }
    return { ok: true, shift: fit.shift || [0, 0, 0] };
  };
  const e1 = ensure(air);
  if (!e1.ok) return;
  const airP = [air[0] + e1.shift[0], air[1] + e1.shift[1], air[2] + e1.shift[2]];
  // ★ 资源里还没有这个方块（mod 方块首次放置最常见）⇒ 先按需把它补进模型/贴图，再放
  if (!sceneCovers(row.id)) {
    setMsg(`正在按需补「${row.name}」的模型与贴图…`);
    if (!(await growScene(row.id))) return;
  }
  // ★ 资源包里没有烘焙模型的方块（`models/block/xxx.json` 是空对象 ⇒ 游戏里靠 mod 自定义渲染器）
  //   模型链一个面贴图都收不到 ⇒ Deepslate 画不出来。**明说并跳过**，别放一个"看不见的方块"。
  const noModel = (state.sceneFlags && state.sceneFlags.noModel) || [];
  if (noModel.includes(row.id)) {
    setMsg(`「${row.name}」在资源包里没有烘焙模型（多半靠 mod 自定义渲染器，如 AE2 的矩阵框架），本工具渲染不出来，已跳过`, 'warn');
    return;
  }
  // 镜像 X：摆放同时作用于对称格，并入**同一个 commit**（同组同撤销）
  // ★ 每个对称格**各自推断** state：它们的邻居并不一样（这格旁边有方块、对称那格未必），
  //   所以不能只算一次再复制 —— 那正是"镜像过去的栅栏没接上"的来源。
  // ★ 推断前先确保拿到该方块的默认态（否则 baseProps 是 {} ⇒ 推断无从下手 ⇒ 还是孤柱）。
  // ⚠ 只在**确实没拿到**时才 await：拖拽是"每个 move 调一次 actAt"，若每次都 await（哪怕立即 resolve），
  //   commit 就会被推到微任务里 ⇒ 而 pointerup 已经**同步**把撤销组关掉了 ⇒ 一次拖拽变成 N 条历史
  //   （实测踩到：P3-d2 报「历史只 +1」变成 [3 => 6]）。缓存命中时保持全同步。
  //   正常路径由"选中物品时预取"（见 createInventory 的 onSelect）把默认态先拿到手，这里基本不会 await。
  if (needsRemoteDefaults(row.id) && !(state.sceneDefaults && state.sceneDefaults[row.id])) {
    await ensureBlockDefaults(row.id);
  }
  const baseProps = propsForBlock(row.id);
  const ops = mirrorPoints(airP).map((q) => ({
    kind: 'place', pos: q, id: row.id,
    props: inferOnPlace(row.id, baseProps, normal, stateCtx(q)),
  }));
  if (doEdit(ops)) {
    state.inv.addRecent(row.id);
    setMsg(`已放置 ${row.name} → ${toUser(airP).join(', ')}${ops.length > 1 ? `（含镜像对称格 ×${ops.length}）` : ''}`);
    // ★ 放置后**自检"能不能画出来"**：Deepslate 对"资源里没有定义"的方块是**静默跳过**的
    //   （它只 console.error 一句，宿主不采集 console）⇒ 用户看到的正是"放了但什么都没出现"。
    //   现在明说，并且把这一条也记进 window.__PREVIEW_BOOT__ 便于诊断。
    try {
      const def = state.vp && state.vp.resources && state.vp.resources.getBlockDefinition
        ? state.vp.resources.getBlockDefinition(row.id) : undefined;
      if (!def) {
        const why = `⚠ 已放置 ${row.name}，但当前资源里没有它的方块定义（画面可能看不见）。`
          + `原因：按需打包没把这个方块的状态收进资源。请再点一次（会触发按需补资源）；若仍看不见，`
          + `说明它靠 mod 自定义渲染（如 AE2 的矩阵框架），本工具画不出来。`;
        setMsg(why, 'err');
        window.__PREVIEW_BOOT__ = { stage: '放置', error: why };
        console.warn('[preview] 放置后资源里没有该方块的模型：' + row.id);
      }
    } catch { /* 取不到资源就不自检 */ }
  }
}
function pickIntoInventory(blockId) {
  const base = blockId.includes('[') ? blockId.slice(0, blockId.indexOf('[')) : blockId;
  state.inv.select(base);
  setMsg(`已拾取 ${base}`);
}

// ---------------------------------------------------------------- 框选（选区 + 动作条）
// 2.2：框选拖出矩形 → 释放后浮出动作条 `[填充所选方块] [清空] [取消]`；填充/清空各自一步可撤销。
/** 选区覆盖的平面格（x,z）列表（矩形，无序化） */
function selCells() {
  const r = state.selRegion;
  if (!r) return [];
  // ★ 二道保险（2026-10-12）：即使 selRegion 里混进了界外坐标（旧存档/程序化设置），
  //   这里也**只吐出世界内的格子** —— 填充/清空不该把世界默默长大。
  const st = state.source;
  const sx = st ? st.size[0] : Infinity, sz = st ? st.size[2] : Infinity;
  const x0 = Math.max(0, Math.min(r.x1, r.x2)), x1 = Math.min(sx - 1, Math.max(r.x1, r.x2));
  const z0 = Math.max(0, Math.min(r.z1, r.z2)), z1 = Math.min(sz - 1, Math.max(r.z1, r.z2));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, z]);
  return out;
}
/** 动作条显示：`已选区 N 格` + 填充/清空/取消 */
function showSelBar(n) {
  const bar = $('selBar'); if (!bar) return;
  const c = $('selCount'); if (c) c.textContent = String(n);
  bar.hidden = false;
  bar.classList.add('on');
}
function hideSelBar() { const bar = $('selBar'); if (bar) { bar.hidden = true; bar.classList.remove('on'); } }
/**
 * 把当前选区同步给视口做**框选预览**（2026-10-11，用户："给个视觉反馈，让用户知道框选范围"）。
 *
 * `withTop=false`（拖动中）：只给平面范围 ⇒ 视口只画地面覆盖板。**故意不算框高**：
 *   算框高要遍历方块（O(方块数)），拖动中每帧都算会明显拖慢跟手感；而拖动阶段用户最需要的是
 *   "我框到哪儿了"（平面范围），高度等松手再补。
 * `withTop=true`（松手后）：扫一遍方块取"区域内最高方块"作为框高，视口补上立体边框 + 顶面板。
 *   ★ 只要一次，O(方块数) 可接受。
 */
function syncSelPreview(withTop) {
  if (!state.vp || !state.vp.setSelectRegion) return;
  const r = state.selRegion;
  if (!r) { state.vp.setSelectRegion(null); return; }
  let yTop = null;
  if (withTop) {
    yTop = -1;
    const xa = Math.min(r.x1, r.x2), xb = Math.max(r.x1, r.x2);
    const za = Math.min(r.z1, r.z2), zb = Math.max(r.z1, r.z2);
    for (const b of state.source.getBlocks()) {
      const p = b.pos;
      if (p[0] < xa || p[0] > xb || p[2] < za || p[2] > zb) continue;
      if (p[1] > yTop) yTop = p[1];
    }
  }
  state.vp.setSelectRegion({ x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2, yTop });
}
function clearSelRegion() { state.selRegion = null; hideSelBar(); syncSelPreview(false); }
/** 该列从 y=0 往上第一个空格（2.2「摆放=列顶」）；整列满返回 -1 */
function freeY(x, z) {
  const sy = state.source.size[1];
  for (let y = 0; y < sy; y++) if (!state.edit.blockAt([x, y, z])) return y;
  return -1;
}
/** [填充所选方块]：选区内每列在列顶放一个当前方块（整批 = 一步可撤销） */
function doFill() {
  const cells = selCells(); if (!cells.length) return;
  const row = state.inv?.selectedRow;
  if (!row) { setMsg('先在左侧选一个物品', 'warn'); return; }
  if (row.isBlock === false) { setMsg(`「${row.name}」是物品不是方块，填不到场景里`, 'warn'); return; }
  const props = propsForBlock(row.id);
  const ops = [];
  for (const [x, z] of cells) {
    const y = freeY(x, z);
    if (y < 0) continue;                       // 整列满：跳过（不静默失败，下方按实际填充数提示）
    ops.push({ kind: 'place', pos: [x, y, z], id: row.id, props });
    for (const q of mirrorPoints([x, y, z])) {
      if (q[0] === x && q[1] === y && q[2] === z) continue;      // 跳过自身（已 push）
      ops.push({ kind: 'place', pos: q, id: row.id, props });
    }
  }
  if (!ops.length) { setMsg('选区内没有可放置的格子（列已满）', 'warn'); return; }
  state.edit.beginGroup();
  const ok = doEdit(ops);
  state.edit.endGroup();
  if (!ok) { setMsg('选区内没有产生变化', 'warn'); return; }
  state.inv.addRecent(row.id);
  setMsg(`已填充 ${ops.length} 格（${row.name}）`);
  clearSelRegion();
}
/** [清空]：清空选区内每一列的全部方块（整批 = 一步可撤销；N = 有方块的列数） */
function doClear() {
  const cells = selCells(); if (!cells.length) return;
  const sy = state.source.size[1];
  const ops = [];
  let cols = 0;
  for (const [x, z] of cells) {
    let had = false;
    for (let y = 0; y < sy; y++) if (state.edit.blockAt([x, y, z])) { ops.push({ kind: 'erase', pos: [x, y, z] }); had = true; }
    if (had) cols++;
    if (had) {
      // 镜像列（X 换列；Y 对"整列清空"不产生新列，mirrorPoints 去重后自然处理）
      for (const q of mirrorPoints([x, 0, z])) {
        if (q[0] === x && q[2] === z) continue;
        for (let y = 0; y < sy; y++) if (state.edit.blockAt([q[0], y, q[2]])) ops.push({ kind: 'erase', pos: [q[0], y, q[2]] });
      }
    }
  }
  if (!ops.length) { setMsg('选区内没有方块可清空', 'warn'); clearSelRegion(); return; }
  state.edit.beginGroup();
  doEdit(ops);
  state.edit.endGroup();
  setMsg(`已清空 ${cols} 列`);
  clearSelRegion();
}

// ---------------------------------------------------------------- 启动
// ★★ 为什么 boot() 要**导出**、而不是在模块末尾直接跑一次（2026-10-10 实机"面板空白"的根因）：
//   功能包会被宿主"切走再切回来"。切回来时 entry 会新建一个 `div.mcp-host` 并 attach 一棵**全新**的
//   shadow 树，然后再 `import('./main.js')` —— 但 **ES 模块只会求值一次**：
//   第二次 import 直接命中缓存、**模块体不再执行** ⇒ 原来写在末尾的 `boot()` 再也不会被调用，
//   新树里只剩静态 HTML（工具栏/状态栏/物品栏全是空壳），看起来就是"功能 UI 缺失、不显示建筑世界"。
//   现在：boot() 由入口在**每次挂载**时显式调用；独立网页（isFeature() 为假）仍在模块末尾自动跑一次。
export async function boot() {
  const setStage = (s) => { window.__PREVIEW_BOOT__ = { stage: s, error: null }; };
  try {
    setStage('取建筑');
    const url = new URLSearchParams(location.search).get('build') || 'data/build.json';
    showBusy('正在读取实例资源…');   // E4：首载文案要说明"在干什么"（V4 验收）
    // 功能包模式：初始建筑由后端给（包内没有静态文件可 fetch）；独立网页模式：取 data/build.json
    const build = isFeature() ? await hostInitialBuild() : await fetchBuild(url);

    setStage('贴图');
    showBusy('准备贴图…');
    const res = await loadResourcesFor(build);   // 先试按需打包，失败回落预打包
    state.registryDefaults = await loadRegistryDefaults();   // 注册表默认态（319 KB，落回预打包时也要用）

    setStage('视口');
    showBusy('初始化视口…');
    const canvas = $('stage');
    state.vp = createViewport(D, {
      canvas, structure: new D.Structure([1, 1, 1]), resources: res.resources, chunkSize: CHUNK_SIZE,
      feel: FEEL,                        // ★ 手感实验室（无 ?feel=1 时 damping=0 / 全 false，行为与旧版一致）
    });
    state.vp.startLoop();                // 持续帧循环（不再按需重绘，避免闪屏）
    if (state.vp.setFrameCallback) state.vp.setFrameCallback(updateAxisGizmo);   // 坐标轴指示器（每帧更新）
    mountFeelPanel();                    // ★ 手感实验室面板（仅 ?feel=1；幂等）
    startFeelTicks();                    // ★ WASD 平滑移动的每帧推进（仅 ?feel=1）
    syncBackdrop();                      // 视口底色跟随宿主主题
    // 宿主切主题时刷新底色：prefers-color-scheme + <html>/<body> 上的 class/style/data-theme
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) on(mq, 'change', syncBackdrop);
    if (typeof MutationObserver === 'function') {
      themeObs = new MutationObserver(syncBackdrop);
      const opt = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
      themeObs.observe(document.documentElement, opt);
      if (document.body) themeObs.observe(document.body, opt);
    }
    bindViewportInput(canvas);
    // bindToolbar 必须在视口创建**之后**（它内部捕获 state.vp），但要在 loadBuild **之前**
    // （它会设一次模式提示，放在后面会盖掉"已载入…"消息）。
    setStage('工具栏');
    bindToolbar();

    setStage('物品栏');
    showBusy('载入物品栏…');
    // onSelect 里**预取默认态**（fire-and-forget）：用户点选一个方块时就把它的默认态要到手，
    // 于是真正放置时 `ensureBlockDefaults` 直接命中缓存、actAt 保持全同步
    //（同步性很重要：拖拽是"每个 move 一次 actAt"，见那里的注释）。
    state.inv = await createInventory({ onSelect: (r) => { updateStatus(); if (r && r.isBlock !== false) void ensureBlockDefaults(r.id); } });

    setStage('载入建筑');
    loadBuild(build, build.source || url);
    // 项目层：旧版单快照迁移 + 保证至少一个项目 + 上一次编辑的项目直接载回来。
    // ★ 语义变化（有意的）：v1.11.0 及以前是"弹一个 toast 问你要不要恢复"，现在**直接载入上次项目** ——
    //   因为"切项目不丢数据"要求打开面板就回到你上次在编辑的东西（等同编辑器打开上次的文件），
    //   而每次都要手动点一次"恢复"本身就是丢数据的入口（点错"新建"就没了）。
    //   只有在"世界已由 URL / 宿主给了内容"时才不打扰（免得覆盖用户明确要看的东西）。
    const boot = bootProjects();
    if (!boot.ok) setMsg('项目层没起来（存储不可用）：' + boot.why, 'err');
    else if ((!build || !build.blocks || build.blocks.length === 0) && boot.build && boot.build.blocks.length) {
      curProjId = boot.id;
      loadBuild(boot.build, 'project');
      setSaveState('ok', '已保存 ' + fmtTime(Date.now()));
      setMsg('已载入上次项目「' + projNameOf(boot.id) + '」：' + boot.build.blocks.length + ' 方块');
    } else {
      loadBuild(build, build.source || url);
    }
    refreshProjList();
    setStat(res);
    // 有模型/定义没吃进来要**明说**（以前是静默跳过 ⇒ 方块渲染成空白却毫无提示）
    if (res.skipped && res.skipped.length) {
      console.warn('[resources] 跳过的条目', res.skipped.slice(0, 20));
      setMsg(`有 ${res.skipped.length} 条模型/方块定义没能吃进来（可能渲染成空白）：`
        + res.skipped.slice(0, 3).map((x) => x.id).join(', '), 'warn');
    }
    // U4：后端截断也要**明说**（否则用户只看到"少了"，查不出为什么）
    if (truncNote()) setMsg(truncNote(), 'warn');
    hideBusy();
    setStage('完成');
    window.__PREVIEW_READY__ = { ok: true, size: state.source.size, blocks: state.source.getBlocks().length, onDemand: res.onDemand };
    window.__APP__ = state;              // 调试/自测用：能读到 vp / edit / inv / source
  } catch (e) {
    // ★ 失败必须**带阶段**说出来："空白面板"最贵的代价是分不清"还在加载"和"已经失败"。
    //   现在错误同时写进 #err（面板内可见）与 window.__PREVIEW_BOOT__（可被探针读到）。
    const stage = (window.__PREVIEW_BOOT__ || {}).stage || '未知';
    window.__PREVIEW_BOOT__ = { stage, error: String((e && e.stack) || e) };
    hideBusy();
    const errEl = $('err');
    if (errEl) errEl.textContent = `ERROR[${stage}]：` + ((e && e.stack) || e);
    console.error('[preview] boot 失败于阶段「' + stage + '」', e);
  }
}

// ---------------------------------------------------------------- 手感实验室（?feel=1）
/**
 * 面板：右下角浮层，逐项开关增强项做 A/B（「全部关」= 旧手感）。
 * 只出现在独立网页形态（light DOM）；功能包 URL 不带 ?feel=1，不出现。
 */
function mountFeelPanel() {
  if (!FEEL.on || document.getElementById('feelPanel')) return;
  const el = document.createElement('div');
  el.id = 'feelPanel';
  el.style.cssText = 'position:fixed;right:12px;bottom:44px;z-index:99;background:rgba(16,22,30,.94);color:#dbe6f2;'
    + 'font:12px/1.6 system-ui,-apple-system,sans-serif;border:1px solid #2c3a4c;border-radius:10px;'
    + 'padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.35);min-width:240px';
  const box = (f, lab, checked) => '<label style="display:block;margin:3px 0;cursor:pointer">'
    + '<input type="checkbox" data-f="' + f + '"' + (checked ? ' checked' : '') + '> ' + lab + '</label>';
  el.innerHTML =
    '<div style="font-weight:600;margin-bottom:4px">手感实验室 <span style="opacity:.55;font-weight:400">?feel=1</span></div>'
    + box('damping', '相机阻尼（旋转/缩放滑出）', FEEL.damping > 0)
    + '<label style="display:block;margin:2px 0 4px 18px;opacity:.85">强度 <input type="range" min="0.08" max="0.6" step="0.02" value="' + (FEEL.damping || 0.28) + '" style="width:120px;vertical-align:middle"></label>'
    + box('zoomCursor', '滚轮朝光标缩放', FEEL.zoomCursor)
    + box('fitContent', '「适应建筑」按内容包围盒', FEEL.fitContent)
    + box('smoothKeys', '按住 WASD 平滑移动', FEEL.smoothKeys)
    + box('lerpDrag', '快速拖动补格（不漏格）', FEEL.lerpDrag)
    + box('showY', '状态栏显示 Y 坐标', FEEL.showY)
    + '<div style="margin-top:7px;display:flex;gap:6px">'
    + '<button data-a="snap" style="flex:1">对齐最近轴 (0)</button>'
    + '<button data-a="off" style="flex:1">全部关</button>'
    + '<button data-a="on" style="flex:1">全部开</button></div>'
    + '<div style="margin-top:5px;opacity:.5">逐项开关即时生效 —— 用来对比新旧手感。</div>';
  document.body.appendChild(el);
  const rng = el.querySelector('input[type=range]');
  const sync = () => { try { state.vp.syncFeel(); } catch { /* vp 未就绪时忽略 */ } };
  el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => { FEEL[cb.dataset.f] = cb.checked; sync(); };
  });
  rng.oninput = () => { FEEL.damping = parseFloat(rng.value) || 0.28; sync(); };
  const setAll = (on) => {
    FEEL.damping = on ? (parseFloat(rng.value) || 0.28) : 0;
    FEEL.zoomCursor = on; FEEL.fitContent = on; FEEL.smoothKeys = on; FEEL.lerpDrag = on; FEEL.showY = on;
    el.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = on; });
    sync();
    setMsg(on ? '手感增强已全部开启' : '已回到旧手感（全部关闭）');
  };
  el.querySelector('[data-a="snap"]').onclick = () => { state.vp.snapAxis(); setMsg('视角已吸附到最近的轴'); };
  el.querySelector('[data-a="off"]').onclick = () => setAll(false);
  el.querySelector('[data-a="on"]').onclick = () => setAll(true);
  setMsg('手感实验室已开启（右下角面板逐项对比；0=视角吸附到最近的轴）');
}
/**
 * WASD 平滑移动的每帧推进（仅 FEEL.on；幂等启动一次）。
 * 速度随相机距离缩放（看得远走得快），Shift ×2.5；位移走 moveLocal（与平移同一套基向量）。
 */
let feelTicksOn = false;
function startFeelTicks() {
  if (!FEEL.on || feelTicksOn) return;
  feelTicksOn = true;
  let last = 0;
  const tick = (ts) => {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, last ? (ts - last) / 1000 : 0.016);
    last = ts;
    if (!FEEL.smoothKeys || !state.vp || !state.vp.cam) return;
    let f = 0, s = 0;
    if (keysDown.has('w')) f -= 1;
    if (keysDown.has('s')) f += 1;
    if (keysDown.has('a')) s -= 1;
    if (keysDown.has('d')) s += 1;
    if (!f && !s) return;
    const spd = Math.max(3, Math.min(60, (state.vp.cam.dist || 20) * 0.9)) * (keysDown.has('shift') ? 2.5 : 1);
    state.vp.moveLocal(f * spd * dt, s * spd * dt, 0);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- 视口输入
function bindViewportInput(canvas) {
  const vp = state.vp;
  let drag = null, moved = 0, lastActAt = 0;
  // E2（P0）：**单次点击最多 1 次编辑**。actAt 是 async 的（放置可能先按需补资源），重复投递的
  // pointerdown（驱动重复注入、双击第二击、触摸+鼠标合成事件）会在极短时间内并发提交 ⇒ 编辑数无端跃升。
  // 120ms 去重窗口：窗口内的第二次"起手"直接丢弃。变异测试：去掉这层去重 ⇒ 闸门 E2 断言必须变红。
  const beginAct = (pos, normal) => {
    const now = performance.now();
    if (now - lastActAt < 120) return false;
    lastActAt = now;
    state.edit.beginGroup();               // 一次拖拽 = 一个撤销组
    void actAt(pos, normal);
    return true;
  };
  on(canvas, 'pointerdown', (e) => {
    // ⚠ 这里曾经是 mousedown + setPointerCapture(e.pointerId)：鼠标事件的 pointerId 是 undefined，
    // setPointerCapture(undefined) 会抛 TypeError 让整个处理器中断 ⇒ 旋转/放置/删除全都没反应。
    // 现在统一用 pointer 事件，并且只在真有 pointerId 时捕获。
    if (e.pointerId != null && typeof canvas.setPointerCapture === 'function') {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件/不支持时忽略 */ }
    }
    moved = 0;
    // 手势路由（2026-10-12 按用户要求对齐参考站 mcblock.top）：**右键拖=平移、中键拖=旋转**。
    // 参考站是「左键 旋转 · 右键 平移 · 滚轮 缩放」；我们的左键必须留给工具（摆放/删除/拾取/框选）
    // —— 它是编辑器不是纯查看器 —— 所以只把**右键与中键对调**。
    // 浏览工具左键拖=旋转、Shift+左键拖=平移、Alt+左键=旋转（这些不变）。
    let mode = null;
    if (e.button === 2) mode = 'pan';
    else if (e.button === 1) mode = 'rotate';
    else if (e.button === 0) {
      if (state.mode === 'pan' && e.shiftKey) mode = 'pan';
      else if (state.mode === 'pan' || e.altKey) mode = 'rotate';
      else if (state.mode === 'select') mode = 'select';
      else mode = 'act';
    }
    drag = { mode, x: e.clientX, y: e.clientY };
    if (e.button === 0 || e.button === 2) e.preventDefault();
    if (mode === 'act' || mode === 'select') {
      const hit = pickAt(e.clientX, e.clientY);
      if (!hit) { drag = null; return; }
      if (mode === 'select') {
        state.selRegion = { x1: hit.pos[0], z1: hit.pos[2], x2: hit.pos[0], z2: hit.pos[2] };
        syncSelPreview(false);             // ★ 按下就出现预览（哪怕只有一格），拖动中才有"跟手"的反馈
        hideSelBar();                      // 收起旧动作条（保留正在拖的新选区）
      } else {
        if (hit.clamped) hintOnce('clamp', '已贴到世界边界内侧放置（世界外放不下）');
        drag.lastCell = hit.pos.join(',');
        beginAct(hit.pos, hit.normal);
      }
    }
  });
  on(window, 'pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (drag.mode === 'rotate') vp.orbit(dx, dy);
      else if (drag.mode === 'pan') vp.panBy(dx, dy);
      else if (drag.mode === 'select') {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit && state.selRegion) {
          state.selRegion = { x1: state.selRegion.x1, z1: state.selRegion.z1, x2: hit.pos[0], z2: hit.pos[2] };
          syncSelPreview(false);           // 跟手更新（视口内部做相等判断，同一格不会重建 buffer）
        }
      } else if (drag.mode === 'act') {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit && hit.pos.join(',') !== drag.lastCell) {   // 拖过新格 → 连续操作（并入同一撤销组）
          const prev = drag.lastCell;
          drag.lastCell = hit.pos.join(',');
          if (hit.clamped) hintOnce('clamp', '已贴到世界边界内侧放置（世界外放不下）');
          // ★ 手感实验室：快速拖动**补格** —— 两帧间鼠标跨了多格时，把中间格按 3D 直线补齐，
          //   手感从"点阵"变成"笔刷"（每格都进同一撤销组；中间格沿用当前命中面的法线）。
          if (FEEL.lerpDrag && prev) {
            const a = prev.split(',').map(Number);
            const seen = new Set([prev]);
            for (const c of lineCells(a, hit.pos)) {
              const kk = c.join(',');
              if (!seen.has(kk)) { seen.add(kk); void actAt(c, hit.normal); }
            }
          }
          void actAt(hit.pos, hit.normal);
        }
      }
      drag.x = e.clientX; drag.y = e.clientY;
      return;
    }
    const hit = pickAt(e.clientX, e.clientY);
    state.hoverPos = hit ? hit.pos : null;
    vp.setOutline(hit ? hit.pos : null);
    vp.setGhost(ghostFor(hit));            // 幽灵预览（摆放=半透明 / 删除=红调）
    if (hit) canvas.style.cursor = state.mode === 'erase' ? 'not-allowed' : (state.mode === 'select' ? 'crosshair' : 'pointer');
    else canvas.style.cursor = 'crosshair';
    updateStatus();
  });
  on(window, 'pointerup', () => {
    if (drag) {
      if (drag.mode === 'act') state.edit.endGroup();        // 收束撤销组（一次拖拽 = 一次 Ctrl+Z 全撤）
      else if (drag.mode === 'select') {
        const cells = selCells();
        if (cells.length > 1) { showSelBar(cells.length); syncSelPreview(true); }   // ★ 松手补框高（一次 O(方块数)）
        else clearSelRegion();
      }
      drag = null;
    }
    updateStatus();
  });
  /** 摆放/删除工具下的幽灵：摆放显示将放置的相邻空格；删除显示红调命中格 */
  function ghostFor(hit) {
    if (!hit) return null;
    if (state.mode === 'place') return { pos: [hit.pos[0] + hit.normal[0], hit.pos[1] + hit.normal[1], hit.pos[2] + hit.normal[2]], kind: 'place' };
    if (state.mode === 'erase') return { pos: hit.pos.slice(), kind: 'erase' };
    return null;
  }
  /**
   * 拾取：先按体素步进命中**已有方块**；没命中且当前是放置/框选模式时，退化为**与底部平面求交**
   * （硬约束：底部层永远可放 ⇒ 空世界也能放下第一块）。
   * E1：命中"世界外的地面"（坐标为负 / 超出尺寸）时**自动贴到世界内最近格**（clamp），
   *     悬停描边同样夹在界内 ⇒ "哪里能放"直接看得见，新手第一块必成功。
   *     贴到的格子若已有方块，沿 +y 找第一个空格（等同"点顶面放上面"）；整列满才放弃。
   * 返回 { pos, normal, plane?, clamped? } | null。
   */
  function pickAt(clientX, clientY) {
    const hit = vp.pick(clientX, clientY);
    if (hit) return hit;
    if (state.mode !== 'place' && state.mode !== 'select') return null;
    const cell = vp.pickPlane(clientX, clientY, 0);
    if (!cell) return null;
    const st = state.source;
    if (!st) return { pos: cell, normal: [0, 0, 0], plane: true };
    const [sx, sy, sz] = st.size;
    // ★ 2026-10-11（用户：「现在有网格限制，我希望没有限制，可以无限建造」）：
    //   这里原来把界外落点 **吸附回界内**（clamp）—— 后果是"在空地上往网格外点"永远落在边界格，
    //   世界永远长不大（用户报的"摆放限制无法加大建筑尺寸"正是这条堵的）。
    //   现在：界外落点**原样返回**（带 outside 标记），由 actAt → ensureBounds 把网格长大。
    const inside = cell[0] >= 0 && cell[1] >= 0 && cell[2] >= 0 && cell[0] < sx && cell[1] < sy && cell[2] < sz;
    if (!inside) {
      // ★ 框选要**夹在世界内**（2026-10-12）：下面那条"原样返回"是给**摆放**用的
      //   （界外落点要能把世界长大 —— 用户 2026-10-11 的"无限建造"），摆放有 actAt→ensureBounds 兜着；
      //   而框选拿界外坐标毫无意义 —— 预览板会画到天边、填充/清空还会顺带把世界长大。
      //   （用户报「框选逻辑有问题，好像只能横向框选」；根因就是这条共用的路径。）
      if (state.mode === 'select') {
        return {
          pos: [Math.min(sx - 1, Math.max(0, cell[0])), 0, Math.min(sz - 1, Math.max(0, cell[2]))],
          normal: [0, 0, 0], plane: true, clamped: true,
        };
      }
      return { pos: cell, normal: [0, 0, 0], plane: true, outside: true };
    }
    const c = cell.slice();
    while (c[1] < sy && state.edit && state.edit.blockAt(c)) c[1]++;   // 界内：目标格被占 → 往上找空格
    if (c[1] >= sy) return { pos: c, normal: [0, 0, 0], plane: true, outside: true };   // 整列满 ⇒ 往上长
    return { pos: c, normal: [0, 0, 0], plane: true, clamped: false };
  }
  // 闸门用：把 pickAt / renderAB 暴露给假宿主自测（重复挂载时被覆盖，无泄漏）。
  // ensureBounds 也暴露：它是「出界 ⇒ 自动扩边界」的**决策**函数（actAt 里 `ensure(air)` 调的就是它），
  // 只测 shiftWorld（机制）测不出「决策写坏」⇒ 闸门 (B0)/(B0b) 直接验它。
  window.__PREVIEW_TEST__ = { pickAt, renderAB, project: (p) => state.vp.project(p), shiftWorld, ensureBounds, applyProjection, projectionDiff,
    toUser, fromUser, originRef: () => state.origin.slice(), buildJsonForExport,
    // 状态推断（2026-10-12）：闸门要能**直接问世界里的 state**（"这块栅栏的 north 是不是 true"），
    // 而不是只看"放了几块"——连接错不错，只有读 state 才知道。
    stateAtIdx: (p) => blockAtIdx(p),
    propsAt: (p) => { const b = blockAtIdx(p); return b ? b.props : null; },
    idAt: (p) => { const b = blockAtIdx(p); return b ? b.id : null; },
    repairStates, growConnectAll,
    /**
     * 放置/删除的**真实入口**（就是鼠标点击走的那条 `actAt`）。
     * 闸门用它时只跳过"鼠标射线 → 命中格"这一步（那部分与状态推断无关、另有断言覆盖），
     * 而"选中什么方块 ⇒ 推断 ⇒ 镜像 ⇒ doEdit ⇒ 邻居重算"整条链都是真的。
     * 为什么不直接暴露 doEdit：那样会**绕过推断**，等于用钩子把要验的东西替换掉了。
     */
    actAtTest: (pos, normal) => actAt(pos, normal),
    pickIntoInventory,
    // 投影虚影（2026-10-12）：闸门据此判"虚影画了什么/有几块"。
    // ⚠ viewport 那边 `projGhostInfo` 是 **getter**（不是方法）⇒ 这里直接读，千万别写成 `state.vp.projGhostInfo()`。
    projGhostInfo: () => (state.vp && state.vp.projGhostInfo) ? state.vp.projGhostInfo : null,
    refreshGhost, projOffset, moveContentToOrigin, projGhostAB,
    // 带贴图虚影（2026-10-12）：ghostTexStats 是**画面级**判据 —— 统计"虚影贡献的像素有几种颜色"，
    // 用来区分"带贴图"与"纯色盒"（只看"有没有画"是分不出这两条路的）。
    ghostTexStats, ensureProjAssets,
    // 1.14.4：框选夹界 / 虚影开关 / 延迟重建（闸门要能"看到走了哪条路"，不只是看结果）
    selCells, flushGhost, toggleGhost, isGhostHidden: () => ghostHidden,
    // 1.14.9：顶栏三段式布局 + 提示条可收起（闸门判"布局契约"与"收起/恢复"）
    //   ⚠ 这两条都**惰性**读 window.__HINT__：__PREVIEW_TEST__ 这个对象字面量在第 1630 行就求值了，
    //     而 setHintMuted 是第 ~1715 行的 const ⇒ 直接引用会踩 TDZ。
    hintHidden: () => !!(window.__HINT__ && window.__HINT__.hidden()),
    toggleHint: () => { if (window.__HINT__) window.__HINT__.toggle(); },
    // 1.14.10：投影浮层（L3）。refreshProjBtns 只做「按当前 state.proj 刷一次界面」，
    //   **不伪造状态** —— 探针/截图先自己设 state.proj，再让它刷，看到的仍是产品真实渲染。
    //   （refreshProjButtons 是函数声明 ⇒ 提升，在这里引用不会踩 TDZ。）
    refreshProjBtns: () => refreshProjButtons(),
    // 1.14.8：网格（闸门判"间距按距离自适应"与"坏掉没"）
    gridLines: () => { const gm = state.vp && state.vp.renderer && state.vp.renderer.gridMesh; return gm && gm.lineVertices ? gm.lineVertices() : -1; },
    camDist: () => (state.vp && state.vp.cam) ? state.vp.cam.dist : -1,
    camTarget: () => (state.vp && state.vp.cam) ? state.vp.cam.target.slice() : null,
    vpFit: () => state.vp.fit(), vpFitContent: () => state.vp.fitContent(),
    doMoveSel, shiftBlocksToOrigin,          // 1.14.7：框选的「移到原点」（工具能力，不是手工改文件）
    ghostDebug: () => (state.vp && state.vp.ghostDebug) ? state.vp.ghostDebug : null,
    // 分层（2026-10-12 重构）：闸门据此判"零重建 + 只影响绘制"
    layerLimit: () => (state.vp && 'layerLimit' in state.vp) ? state.vp.layerLimit : undefined,
    drawStats: () => (state.vp && state.vp.drawStats) ? state.vp.drawStats : null,
    vpDraw: () => state.vp && state.vp.draw(),   // 测试可显式驱动一帧（保证 drawStats 新鲜）
    axisDirs: () => (state.vp && state.vp.axisScreenDirs) ? state.vp.axisScreenDirs() : null,
    updateAxisGizmo,
    // 项目 / 保存 / ViewCube（2026-10-11）：闸门要能"读到走了哪条路"，而不只是"看到结果对不对"
    projects, projId: () => curProjId, projReady: () => projReady, projNameOf,
    saveNow: (manual) => flushSave(manual === true), saveStateText: () => ($('projSave') || {}).textContent,
    newProject, dupProject, renameProject, deleteProject, switchProject, refreshProjList, openGroup: (w) => syncGroupOpen(w),
    vcube: () => state.vcube && state.vcube.state(), vcubeHit: (x, y) => state.vcube && state.vcube.hit(x, y),
    vcubeDirToScreen: (d) => state.vcube && state.vcube.dirToScreen(d),
    vcubeGo: (d, o) => state.vcube && state.vcube.go(d, o),
    // 布局断言用：弹层与面板的矩形（闸门据此判「有没有被甩出面板」）
    popRect: (id) => { const e = $(id); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; },
    panelRect: () => { const rn = rootNode(); const el = (rn && rn.host) ? rn.host : document.documentElement; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; },
    vpAngleTween: () => state.vp.angleTween(), vpPitchRange: () => state.vp.pitchRange,
    vpSetAngles: (y, x, o) => state.vp.setAngles(y, x, o),
    // 框选预览（2026-10-11）：闸门据此判"预览画了什么"，而不是只判 state 里的数字
    selRegion: () => (state.selRegion ? Object.assign({}, state.selRegion) : null),
    selPreview: () => state.vp.selectRegion, selCageLines: () => state.vp.selCageLines,
    selPreviewAB, syncSelPreview };
  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    // 1.12/档，clamp [0.02, 60]（2026-10-11 按用户"不要放大限制"放宽，见 viewport.js）；带上光标坐标 —— feel.zoomCursor 时按"朝光标"缩放
    vp.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
  on(canvas, 'contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- 工具栏
function bindToolbar() {
  // ★★ 这里**故意不放** `const vp = () => state.vp` 这种惰性访问器。
  //   事故（19:00 实机 228 条错误）：访问器加上去之后，下面 8 处仍按"对象"写着 `vp.fit()` / `vp.grid`
  //   ⇒ 箭头函数上没有这些方法，**每次点击都抛 TypeError**，「适应建筑 / 网格 / 撤销 / 重做 / 分层」全废
  //   （最坑的是撤销：数据回退了、画面不刷新，看起来像撤销没生效）。
  //   现在统一成**只有一种写法**：任何位置都用 `state.vp.<方法>()`。
  //   视口对象在 `setResources()` 里是热换资源、**identity 不变**，所以直接取也不怕过期。
  //   自查一条命令即可：`rg -n 'vp = \(\) =>' preview/src` 必须为空。
  // 功能包模式：**没有静态文件**，"示例建筑"下拉里的 data/build*.json 取不到 ⇒ 藏起来，
  // 不让用户点一个必然报错的控件（要载入建筑请用「导入建筑…」，那条走宿主 action）。
  if (isFeature()) {
    const s = $('sample');
    if (s) s.style.display = 'none';
  }
  // 视口左上角的操作提示（随当前工具切换；1-5 换工具、Esc 回浏览）
  // ★ 2026-10-12（布局重设计一并做的）：文案写进 #hintTx，**不再**写 #overlay.textContent ——
  //   #overlay 里现在多了一个「收起」按钮，一句 textContent = 会把按钮一起抹掉（子元素全没）。
  const ov = $('overlay');
  const ovTx = $('hintTx');
  const HINT_PAN = '拖拽=旋转视角 · Shift 拖=平移 · 滚轮=缩放 · 1-5 换工具 · H 收起提示';
  const HINT_EDIT = '左键=执行工具 · 右键拖=平移 · 中键拖=旋转视角 · Esc 回浏览 · H 收起提示';
  let hintMuted = false;
  const setHintMuted = (m) => { hintMuted = !!m; if (ov) ov.hidden = hintMuted; };
  // ★ 收起只表示"这一次先别挡"：换工具/切模式会走 setTool ⇒ syncHint ⇒ 自动恢复。
  //   所以不需要在工具条上再加一个开关（那会是第 15 个常驻控件）。
  const syncHint = () => {
    const txt = (state.mode === 'pan') ? HINT_PAN : HINT_EDIT;
    if (ovTx) ovTx.textContent = txt; else if (ov) ov.textContent = txt;   // 兜底：万一是老 DOM
    setHintMuted(false);
  };
  const hintCloseBtn = $('hintClose');
  if (hintCloseBtn) hintCloseBtn.onclick = () => setHintMuted(true);
  // 供闸门与 H 键用（H 键那边读 window.__HINT__，避免在 const 之前引用它 —— TDZ）
  window.__HINT__ = { toggle: () => setHintMuted(!hintMuted), hidden: () => hintMuted };
  // 工具组模型（1-5 切换；Esc 回浏览；当前工具在工具条高亮）
  const TOOLS = [
    { id: 'pan', btn: 'm_pan', lab: '浏览' },
    { id: 'place', btn: 'm_place', lab: '摆放' },
    { id: 'erase', btn: 'm_erase', lab: '删除' },
    { id: 'pick', btn: 'm_pick', lab: '拾取' },
    { id: 'select', btn: 'm_select', lab: '框选' },
  ];
  const TOOL_MSG = {
    pan: '浏览：拖拽=旋转视角 · Shift 拖=平移 · 滚轮=缩放',
    place: '摆放：左键点方块的面 → 放在相邻格',
    erase: '删除：左键点方块 → 删除',
    pick: '拾取：左键点方块 → 设为当前物品',
    select: '框选：拖出矩形选区 → 释放后浮出动作条',
  };
  /** 同步工具条高亮（唯一真相是 state.mode）。变异靶点：不调它 ⇒ 高亮不跟手。 */
  function syncTools() {
    for (const t of TOOLS) { const b = $(t.btn); if (b) b.classList.toggle('on', t.id === state.mode); }
  }
  const setTool = (m) => {
    state.mode = m;
    if (m !== 'select') clearSelRegion();   // 2.2：离开框选 → 收起选区与动作条
    syncTools();
    syncHint();
    setMsg(TOOL_MSG[m] || '');
    updateStatus();
  };
  for (const t of TOOLS) { const b = $(t.btn); if (b) b.onclick = () => setTool(t.id); }
  setTool('place');

  // 镜像 X（工具条一个开关；快捷键 M）—— 2026-10-12 起**只剩 X**（Y 已按用户要求移除）。
  // 轴 = 世界中心线（网格正中）：开镜像时视口里画出轴线（syncAxes），"坐标在网格中间"一眼可见。
  const syncMirror = () => {
    const bx = $('mirrorBtn'), bz = $('mirrorBtnZ');
    if (bx) { bx.classList.toggle('on', state.mirrorX); bx.setAttribute('aria-pressed', state.mirrorX ? 'true' : 'false'); }
    if (bz) { bz.classList.toggle('on', state.mirrorZ); bz.setAttribute('aria-pressed', state.mirrorZ ? 'true' : 'false'); }
    syncAxes();
  };
  const MIRROR_TXT = {
    x: '镜像 X（左右对称，绕世界中心线）', z: '镜像 Z（前后对称，绕世界中心线）',
  };
  /** 两轴各自独立；同开时一次落 4 块（含对角）。 */
  const toggleMirror = (axis) => {
    const k = axis === 'z' ? 'z' : 'x';
    if (k === 'z') state.mirrorZ = !state.mirrorZ; else state.mirrorX = !state.mirrorX;
    const on = k === 'z' ? state.mirrorZ : state.mirrorX;
    syncMirror();
    const both = state.mirrorX && state.mirrorZ;
    setMsg(`${MIRROR_TXT[k]} 已${on ? '开 —— 摆放/删除同时作用于对称格（轴线已画出' + (both ? '；两轴同开 ⇒ 一次落 4 块含对角' : '') + '）' : '关'}`);
  };
  if ($('mirrorBtn')) $('mirrorBtn').onclick = () => { toggleMirror('x'); if (state.syncMirrorHead) state.syncMirrorHead(); };
  if ($('mirrorBtnZ')) $('mirrorBtnZ').onclick = () => { toggleMirror('z'); if (state.syncMirrorHead) state.syncMirrorHead(); };
  syncMirror();

  // 选区动作条（框选释放后浮出）：填充 / 清空 / 取消
  $('selFill').onclick = doFill;
  $('selClear').onclick = doClear;
  if ($('selMove')) $('selMove').onclick = () => {
    const n = selCells().length;
    if (!n) { setMsg('先在视口里拖出一个选区', 'warn'); return; }
    let ok = true;
    try { ok = window.confirm('把选区里的方块整体搬到原点（中心对齐 + 贴地）？\n整批算一次操作，Ctrl+Z 可全撤。'); } catch { ok = true; }
    if (ok) doMoveSel();
  };
  $('selCancel').onclick = () => { clearSelRegion(); setMsg('已取消选区'); };

  // ★ 手感实验室：fitContent = 按**内容包围盒**取景（大世界小建筑也能铺满视野）；默认按世界尺寸（原作）
  $('fitBtn').onclick = () => {
    // ★ 「适应建筑」默认按**内容包围盒**（FEEL.fitContent 现在默认 true；理由见上一条）
    if (state.vp.fitContent) { state.vp.fitContent(); setMsg('已适应建筑（按内容包围盒）'); }
    else { state.vp.fit(); setMsg('已适应建筑'); }
  };
  // 「旋转 90°」：视角水平旋转（yaw + π/2）—— 走 nudgeYaw（阻尼开启时同样瞬时生效）
  // 物品栏显示/隐藏（工具条 / B）。隐藏时补偿半宽，视图保持视觉锚定（不跳变）。
  // hidden 的元素量不到宽（display:none ⇒ rect=0），所以宽度在**隐藏前**记下来、显示时复用，
  // 这样 hide→show 的 panBy 严格可逆（浮点同 k，target 精确回原值）。
  let invW = 0;
  const toggleInv = () => {
    const inv = $('inv');
    if (!inv) return;
    if (state.invOpen) {
      invW = inv.getBoundingClientRect().width || invW || 320;
      state.invOpen = false;
      inv.hidden = true;
      if (state.vp && invW > 0) state.vp.panBy(invW / 2, 0);
    } else {
      state.invOpen = true;
      inv.hidden = false;
      const w = invW || inv.getBoundingClientRect().width || 320;
      if (state.vp && w > 0) state.vp.panBy(-w / 2, 0);
    }
    const b = $('invBtn'); if (b) b.classList.toggle('on', state.invOpen);
    setMsg(state.invOpen ? '物品栏已显示（B 或工具栏「物品栏」切换）' : '物品栏已隐藏（B 或工具栏「物品栏」恢复）');
  };
  $('invBtn').onclick = toggleInv;
  $('invBtn').classList.toggle('on', state.invOpen);

  // 网格按钮：文字要**反映开/关**，并给 aria-pressed（状态不只靠颜色）。
  // 原来这里写的是 `vp.grid ? '网格 G' : '网格 G'` —— 三元两支同一个字符串，等于没表达状态。
  const syncGridBtn = () => {
    const g = state.vp.grid;
    $('gridBtn').classList.toggle('on', g);
    $('gridBtn').textContent = g ? '网格（开）' : '网格（关）';
    $('gridBtn').setAttribute('aria-pressed', g ? 'true' : 'false');
  };
  $('gridBtn').onclick = () => { state.vp.setGrid(!state.vp.grid); syncGridBtn(); };
  syncGridBtn();

  $('undoBtn').onclick = () => {
    const r = state.edit.undo(16);
    if (!r) return;
    state.vp.updateBuffers(r.chunks);
    updateStatus(); scheduleSave(); refreshProjButtons();   // 撤销会改变「与投影的差异」 ⇒ 按钮文案/禁用态要跟着变
    setMsg(`已撤销（${r.changes.length} 处改动）`);
  };
  $('redoBtn').onclick = () => {
    const r = state.edit.redo(16);
    if (!r) return;
    state.vp.updateBuffers(r.chunks);
    updateStatus(); scheduleSave(); refreshProjButtons();
    setMsg(`已重做（${r.changes.length} 处改动）`);
  };
  // 「新建项目」：★ 只新建，**不销毁**当前项目（用户报的"每次新建都丢旧项目"就修在这里）。
  //   旧实现在这一行里写的是 clearSave() —— 一个 key 被清掉，上个项目当场没了。
  $('newBtn').onclick = () => { newProject(); dismissToast(); };

  // 2026-10-11 修卡顿：input 只记目标层（文字即时更新），调度里合并成一次**增量**应用。
  // 双通道调度：rAF 为主（正常浏览器 16ms 内落地）；setTimeout(30ms) 兜底——
  //   无头/虚拟时间等 rAF 不被推进的环境里也保证应用（flushLayer 幂等 + 双清理）。
  let layerPending = null, layerRaf = 0, layerTimer = 0;
  const flushLayer = () => {
    if (layerRaf) { cancelAnimationFrame(layerRaf); layerRaf = 0; }
    if (layerTimer) { clearTimeout(layerTimer); layerTimer = 0; }
    const t = layerPending;
    layerPending = null;
    if (t !== null) applyLayer(t);
  };
  $('layer').oninput = (e) => {
    const y = Number(e.target.value);
    const sy = state.source.size[1];
    $('layerVal').textContent = y >= sy - 1 ? '全部' : `≤ ${y}`;
    layerPending = y;
    if (!layerRaf && !layerTimer) {
      layerRaf = requestAnimationFrame(flushLayer);
      layerTimer = setTimeout(flushLayer, 30);
    }
  };

  $('sample').onchange = async (e) => {
    const v = e.target.value;
    if (!v) return;
    showBusy('载入示例…');
    try { loadBuild(await fetchBuild(v), v); } catch (err) { setMsg(String(err.message || err), 'err'); }
    hideBusy();
  };

  // ★ e.target 在**事件分发结束**时会被浏览器清成 null，而 async 处理器是在 await 之后才继续的
  //   （那时分发早已结束）⇒ 这里必须**先把元素取出来**再 await，否则 `e.target.value = ''` 抛
  //   TypeError（静默 unhandledrejection），且 value 没清空 ⇒ **同一个文件再选一次不会再触发**。
  //   闸门 (Z0b) 抓到的就是这个（0 => 1 条未捕获异常）。
  $('importInput').onchange = async (e) => {
    const el = e.target;
    const f = el && el.files && el.files[0];
    if (f) await doImport(f);
    if (el) el.value = '';
  };
  $('importBtn').onclick = () => $('importInput').click();
  // 投影（2026-10-11）：导入投影 → 按投影补全 / 清除投影
  const projBtn = $('projBtn'), projInput = $('projInput');
  if (projBtn && projInput) {
    projBtn.onclick = () => projInput.click();
    projInput.onchange = async (e) => {
      const el = e.target;                       // 同上：await 之后 e.target 已为 null，必须提前取
      const f = el && el.files && el.files[0];
      if (f) await importProjFile(f);
      if (el) el.value = '';
    };
  }
  if ($('projApply')) $('projApply').onclick = () => applyProjection();
  if ($('projHide')) $('projHide').onclick = () => toggleGhost();
  if ($('projClear')) {
    $('projClear').onclick = () => {
      state.proj = null;
      projStructCache = null;             // 投影换了对象 ⇒ 解析缓存失效
      refreshProjButtons();
      refreshGhost();                     // ★ 虚影随之撤掉（不留一个去不掉的幽灵）
      setMsg('投影已清除（当前建筑不受影响）');
    };
  }
  refreshProjButtons();
  if ($('originBtn')) $('originBtn').onclick = () => moveContentToOrigin();
  $('expSchem').onclick = () => doExport('schem');
  $('expLitematic').onclick = () => doExport('litematic');
  $('matBtn').onclick = () => showMaterials();

  // ================================================================ 项目 / 分组下拉 / ViewCube（2026-10-11）
  // ---- 分组下拉：三条交互必须齐（否则"折叠"会变成"藏起来找不着"）----
  //   ① 同时只开一个  ② 点面板外部关闭  ③ Esc 关闭；并同步 aria-expanded（状态不只用颜色/位置表达）
  const GROUPS = [['projGrp', 'projHead', 'projPop'], ['mirrorGrp', 'mirrorHead', 'mirrorPop'], ['fileGrp', 'fileHead', 'filePop']];
  // 面板可见范围（功能包里是宿主元素；独立网页就是 documentElement）。
  const panelRect = () => {
    const rn = rootNode();
    const el = (rn && rn.host) ? rn.host : document.documentElement;
    return el.getBoundingClientRect();
  };
  /**
   * ★ 弹层的左右对齐**必须按当下可用空间算**，不能在 CSS 里写死。
   *
   * 实测踩到的 bug（用户报的「红框里的截断」）：`.grp-pop.atright{right:0}` 是我为「组在工具条
   * 右半边」挑的固定对齐；但工具条是 `flex-wrap:wrap`，窗口一宽，「文件」就**单独换行落到最左**，
   * 而 `right:0` 仍把弹层往左甩 ⇒ 整块弹层跑出面板左侧、被宿主裁掉，只剩每行文字的尾巴
   * （用户截图里就是 筑…/影…/chem/matic/清单）。1920 宽可复现、1440 宽不复现 —— 它是
   * **布局相关**的：只读代码、或只在一个宽度下测，都发现不了。
   * 现在：打开时量一次，能靠左就靠左、靠左不行才靠右；两边都不行就把宽度钳住，至少不溢出。
   */
  function placePop(gid) {
    const g = GROUPS.find((x) => x[0] === gid);
    if (!g) return;
    const pop = $(g[2]), head = $(g[1]);
    if (!pop || !head || pop.hidden) return;
    pop.classList.remove('atright');
    pop.style.maxWidth = '';
    const pw = pop.getBoundingClientRect().width || 200;
    const hr = head.getBoundingClientRect();
    const R = panelRect();
    const pad = 8;
    const fitsLeft = (hr.left + pw) <= (R.right - pad);
    const fitsRight = (hr.right - pw) >= (R.left + pad);
    if (!fitsLeft && fitsRight) pop.classList.add('atright');
    if (!fitsLeft && !fitsRight) pop.style.maxWidth = Math.max(140, R.width - pad * 2) + 'px';
  }
  function openGroup(which) {
    for (const g of GROUPS) {
      const pop = $(g[2]), head = $(g[1]);
      if (!pop || !head) continue;
      const want = (g[0] === which);
      pop.hidden = !want;
      head.setAttribute('aria-expanded', want ? 'true' : 'false');
    }
    if (which === 'projGrp') refreshProjList();
    placePop(which);              // ★ 每次打开都重新定位（换行位置随窗口宽度变）
    return !!which;
  }
  syncGroupOpen = openGroup;
  for (const g of GROUPS) {
    const head = $(g[1]);
    if (!head) continue;
    head.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const pop = $(g[2]);
      openGroup(pop && pop.hidden ? g[0] : null);
    };
  }
  // 点外部关闭：挂在 rootNode（Shadow DOM 里 document 收不到内部事件的真实目标，
  // 所以用 composedPath 取真实目标判断"在不在面板里"）。
  on(rootNode(), 'pointerdown', (e) => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    for (const g of GROUPS) {
      const pop = $(g[2]), head = $(g[1]);
      if (!pop || pop.hidden) continue;
      if (pop.contains(t) || (head && head.contains(t))) continue;
      pop.hidden = true;
      head.setAttribute('aria-expanded', 'false');
    }
  });
  // ---- 项目按钮 ----
  if ($('saveBtn')) $('saveBtn').onclick = () => flushSave(true);
  if ($('newBtn')) { /* 上面已接 */ }
  if ($('projDup')) $('projDup').onclick = () => dupProject();
  if ($('projRen')) $('projRen').onclick = () => renameProject();
  if ($('projDel')) $('projDel').onclick = () => deleteProject();

  // ---- ViewCube（替代原「旋转 90°」）----
  const vcCv = $('vcubeCv');
  if (vcCv && state.vp) {
    state.vcube = createViewCube({ canvas: vcCv, vp: state.vp, onHome: () => { state.vp.fitContent(); } });
    state.vcube.draw();
    state.vcube.startLoop();
  }

  // ---- 镜像组标题的点亮：组一折叠，里面的开关状态就看不见了 ⇒ 在标题上带一个小圆点 ----
  const syncMirrorHead = () => {
    const head = $('mirrorHead'), dot = $('mirrorDot');
    const on0 = !!(state.mirrorX || state.mirrorZ);   // 任一轴开着就点亮（折叠起来也要看得出）
    if (head) head.classList.toggle('on', on0);
    if (dot) dot.hidden = !on0;
  };
  state.syncMirrorHead = syncMirrorHead;
  syncMirrorHead();
  on(document, 'keydown', (e) => {
    // ★ 事件跨 Shadow 边界会被**重定向（retargeting）**：挂在 document 上的监听器看到的 `e.target`
    //   是**宿主元素**（功能包里的 `<div class="mcp-host">`），不是里面真正获得焦点的 `<input>`。
    //   真实目标只在 `composedPath()[0]`。不修的话，功能包里**在搜索框打字会移动相机并吞掉字符**
    //   （打 w/a/s/d 移动相机、打 1/2/3 切模式、Ctrl+Z 被劫持成撤销 3D 编辑）。
    //   注意：独立网页（light DOM）下两条都对，所以只有功能包形态会坏。
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.isComposing) return;   // E3：输入法组合期间的按键（如确认候选的回车）不当作快捷键
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? $('redoBtn').click() : $('undoBtn').click(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(true); return; }   // Ctrl+S 手动保存
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); $('redoBtn').click(); return; }
    if (e.key === 'f' || e.key === 'F') $('fitBtn').click();
    if (e.key === 'g' || e.key === 'G') $('gridBtn').click();
    // 工具组：1-5 切换工具（浏览/摆放/删除/拾取/框选），Esc 回浏览
    const toolKey = { '1': 'pan', '2': 'place', '3': 'erase', '4': 'pick', '5': 'select' }[e.key];
    if (toolKey) { setTool(toolKey); return; }
    if (e.key === 'Escape') { clearSelRegion(); setTool('pan'); return; }   // 2.2：Esc 清选区 + 回浏览
    if (e.key === 'b' || e.key === 'B') { toggleInv(); return; }
    if (e.key === 'h' || e.key === 'H') { if (window.__HINT__) window.__HINT__.toggle(); return; }   // H：开关操作提示条
    if (e.key === 'm' || e.key === 'M') { toggleMirror(e.shiftKey ? 'z' : 'x'); return; }   // M = 镜像 X，Shift+M = 镜像 Z
    // 键盘移动视图：★手感实验室（smoothKeys）= 按住平滑移动（keydown 记键，每帧按速度×dt 推进，
    //   见 startFeelTicks）；默认 = 每按一次走 1 格（Shift ×4）——原作行为。
    if (e.key === 'Shift' && FEEL.smoothKeys) keysDown.add('shift');
    const step = e.shiftKey ? 4 : 1;
    const K = e.key.toLowerCase();
    if (K === 'w' || K === 's' || K === 'a' || K === 'd') {
      e.preventDefault();
      if (FEEL.smoothKeys) keysDown.add(K);
      else if (K === 'w') state.vp.moveLocal(-step, 0, 0);
      else if (K === 's') state.vp.moveLocal(step, 0, 0);
      else if (K === 'a') state.vp.moveLocal(0, -step, 0);
      else state.vp.moveLocal(0, step, 0);
    }
    // 2.2：Q/E 微调 15°（yaw ∓ π/12）—— 走 nudgeYaw（阻尼开启时同样瞬时生效）
    else if (K === 'q') { state.vp.nudgeYaw(-Math.PI / 12); setMsg('视角左转 15°（Q/E 微调，拖拽可连续旋转）'); e.preventDefault(); }
    else if (K === 'e') { state.vp.nudgeYaw(Math.PI / 12); setMsg('视角右转 15°（Q/E 微调，拖拽可连续旋转）'); e.preventDefault(); }
    // ★ 手感实验室：0 = 视角吸附到最近的轴（MagicaVoxel「4」键语义；顶视 / 正视一键到位）
    else if (FEEL.on && K === '0') { state.vp.snapAxis(); setMsg('视角已吸附到最近的轴（顶视/正视循环；再按 0 继续吸附）'); e.preventDefault(); }
  });
  // ★ 手感实验室：按住 WASD 平滑移动的收键（与上面的 keydown 配对；失焦时清空防"卡键"）
  on(document, 'keyup', (e) => { keysDown.delete(e.key.toLowerCase()); });
  on(window, 'blur', () => keysDown.clear());

  // 拖拽导入
  const wrap = $('stageWrap');
  on(wrap, 'dragover', (e) => { e.preventDefault(); wrap.style.outline = '2px dashed #4a9eff'; });
  on(wrap, 'dragleave', () => { wrap.style.outline = ''; });
  on(wrap, 'drop', async (e) => {
    e.preventDefault(); wrap.style.outline = '';
    const f = e.dataTransfer?.files?.[0];
    if (f) await doImport(f);
  });

  $('dlgClose').onclick = () => $('dlg').classList.remove('on');
  $('dlgCsv').onclick = () => {
    const rows = materialRows(state.build, (id) => state.inv.nameOf(id));
    download(new Blob([materialsCsv(rows)], { type: 'text/csv' }), `${(state.build.name || 'building')}-材料清单.csv`);
  };
}

// ---------------------------------------------------------------- 投影（2026-10-11）
// 用户要「导入投影文件，投影文件可以直接补全方块建筑」：
//   · 「导入投影」**不动当前世界**，只把解析结果存进 state.proj；
//   · 「按投影补全」把当前建筑与投影逐格比对：缺的补上、错的替换（**只补不删**，不碰投影范围外的格），
//     整批一次可撤销；世界容不下投影时先自动长大。
//   投影与当前世界按同一坐标系对齐（原点对齐）——与「导入建筑」同规则。

/** 投影解析结果的缓存（按 `state.proj` 的对象身份失效 —— 换投影就换对象，比字符串 key 可靠） */
let projStructCache = null;
function projStructure() {
  if (!state.proj) return null;
  if (projStructCache && projStructCache.build === state.proj) return projStructCache.st;
  const { st } = structureFrom(state.proj, D);
  projStructCache = { build: state.proj, st };
  return st;
}
/**
 * 投影 → 世界的索引偏移：让**投影的中心**落在世界原点（= 网格中心 = 用户坐标 0）。
 *
 * ★ 为什么是"中心对齐"而不是"投影的 (0,0,0) 角对齐原点"（2026-10-12 用户拍板「按原点对齐」）：
 *   世界原点在**网格正中**（1.11.0 的约定，X 镜像轴就依赖它，不能动）。若把投影的**角**对齐原点，
 *   投影会整块压在世界的正半轴、与建筑错开一半 —— 那时"按投影补全"补出来的是半个建筑。
 *   中心对齐 = 两者的"原点"重合（本工具里"原点"就是网格中心），投影正好套在建筑上。
 *   y 不动：投影与建筑都从 y=0 的地面开始长（两边都贴地才能逐格比）。
 */
function projOffset(projSize, worldSize) {
  // ★ 2026-10-12：基准是**原点**，不是"世界的几何中心"（`worldSize` 参数保留只为兼容调用方，
  //   不再参与计算）。为什么：
  //   · "无限建造"的世界**只往正方向长大**（`shiftWorld(0,0,0,nsize)`，已有内容坐标不动）；
  //   · `state.origin` 只在世界**创建/载入**时算一次，**不随长大变**（探针实测：7x4x7 →
  //     80x40x288 之后 origin 仍是 [-3,0,-3]）；
  //   ⇒ 几何中心一路右移、原点不动 ⇒ 按几何中心对齐会把投影送偏几十格
  //     （实测 80x40x288 时 off=[38,0,142]，而建筑在索引 0..6 ⇒ **相距 38 格**；
  //      用户截图里"塔在角落、另一坨在中间"就是这个）。
  //   世界小的时候两套算法数值恰好相同（7x4x7 ⇒ 都是 3），所以这个 bug 只在长大过之后才现形。
  const ox = -state.origin[0], oz = -state.origin[2];      // 用户坐标 0 对应的索引
  return [Math.round(ox - projSize[0] / 2), 0, Math.round(oz - projSize[2] / 2)];
}

/**
 * 把**投影用到的方块状态**并进当前场景资源（带贴图虚影的前置条件）。
 *
 * 为什么必须做：资源是**按需打包**的（只收当前建筑用到的状态），而投影是**另一个文件** ——
 * 它完全可能用到建筑里没有的方块（比如投影是石材、建筑只有木头）。不补这一趟，
 * 虚影里那些方块就**没有模型可画**（`getBlockDefinition` 返回 undefined），表现为"虚影缺一大块"。
 * ★ 已经覆盖时**零开销**（只做一次集合比对就返回）：这个函数在每次导入投影时都会被调。
 */
async function ensureProjAssets() {
  if (!state.proj || !state.vp) return { added: 0 };
  const want = statesOfBuild(state.proj);            // 状态串（含属性），与建筑那边同一口径
  const have = Array.isArray(state.sceneStates) ? state.sceneStates : [];
  const miss = want.filter((s) => !have.includes(s));
  if (!miss.length) return { added: 0, total: want.length };
  const merged = have.concat(miss);
  try {
    const scene = await hostScene(merged);
    const r = await buildResources(D, { assets: scene.assets, opaque: scene.flags || window.__OPAQUE__ || {}, atlasUrl: scene.atlasUrl });
    state.sceneKey = scene.key;
    state.sceneStates = merged;
    state.sceneDefaults = { ...(state.sceneDefaults || {}), ...(scene.defaults || {}) };
    state.sceneFlags = { ...(state.sceneFlags || {}), ...(scene.flags || {}) };
    state.vp.setResources(r.resources);              // 换图集卷走了虚影的网格渲染器 ⇒ 下面要重建
    setStat({ ...r, onDemand: true });
    return { added: miss.length, total: want.length, key: scene.key };
  } catch (e) {
    return { added: 0, total: want.length, failed: String((e && e.message) || e) };
  }
}

/**
 * 画面级：**虚影自己贡献的像素**里有几种颜色？（2026-10-12，为"带贴图的虚影"立的判据）
 *
 * 为什么需要它：带贴图的虚影与旧的"纯色半透明盒"在"有没有画"这件事上**完全一样** ——
 * 只看 diff > 0 分不出两条路（那正是本项目反复吃过的假 PASS）。
 * 而"虚影像素的颜色多样性"能分：纯色盒只有"基色 × 光照"那么几种色；
 * 带贴图会有几十上百种（贴图纹理本身）。
 * 做法：抓两帧（有虚影 / 无虚影），只统计**两者不同的那些像素**（= 虚影贡献的）。
 * ★ 颜色按 /4 量化后计数（别写成 ** 加斜杠 —— 那会把块注释提前闭合）：抗锯齿与光照的细微渐变不该算"不同的颜色"，
 *   否则纯色盒也会因为插值出上百种 —— 判据就失去区分力（这条是变异测试逼出来的口径）。
 */
async function ghostTexStats() {
  const vp = state.vp;
  if (!vp) throw new Error('视口尚未初始化');
  const gl = vp.gl;
  vp.stopLoop();
  const savedCam = { xr: vp.cam.xr, yr: vp.cam.yr, dist: vp.cam.dist, target: [...vp.cam.target] };
  const d = projectionDiff();
  if (d) aimProjCam(vp, d);
  const grab = () => {
    vp.draw();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  let a, b;
  try {
    if (d) vp.setProjGhost(d.sameCells, d.diffCells, d.ghostSize, d.ghostOrigin);
    a = grab();
    vp.clearProjGhost();
    b = grab();
  } finally {
    ghostSig = '';
    refreshGhost();
    vp.cam.xr = savedCam.xr; vp.cam.yr = savedCam.yr; vp.cam.dist = savedCam.dist; vp.cam.target = savedCam.target;
    vp.draw();
  }
  const seen = new Map();
  const w = gl.drawingBufferWidth;
  const isGhost = (i) => (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]);
  let pix = 0, hfSum = 0, hfPairs = 0, wfSum = 0, wfPairs = 0;
  for (let i = 0; i < a.length; i += 4) {
    const gi = isGhost(i);
    if (gi) {
      pix++;
      const k = (a[i] >> 2) + ',' + (a[i + 1] >> 2) + ',' + (a[i + 2] >> 2);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    // ★ 高频纹理（"带贴图"的定义性特征）：只看**同一行内**相邻两个像素的色差。
    //   纯色实现即使带逐顶点光照插值，也只是**低频**梯度（相邻像素几乎一样）；贴图则有像素级突变。
    //   实测（calib-u13.py）：带贴图 57.90 / 纯色+光照 8.08 / 纯色无光照 5.35。
    //   ★ 同时统计**真实世界内容**同一口径的数值 —— 它是我们已知"必定带贴图"的参照物，
    //     于是能给出不依赖投影内容的**相对判据**（见 (U13b)）。背景占比很低，只统计"有差异"的像素对。
    if (i + 4 < a.length && ((i >> 2) % w) !== (w - 1)) {
      const gi2 = isGhost(i + 4);
      const d = Math.abs(a[i] - a[i + 4]) + Math.abs(a[i + 1] - a[i + 5]) + Math.abs(a[i + 2] - a[i + 6]);
      if (gi && gi2) { hfPairs++; hfSum += d; }
      else if (!gi && !gi2 && d > 0) { wfPairs++; wfSum += d; }
    }
  }
  const top = [...seen.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, n]) => k + '×' + n);
  const hfAvg = hfPairs ? +(hfSum / hfPairs).toFixed(2) : 0;
  const worldHfAvg = wfPairs ? +(wfSum / wfPairs).toFixed(2) : 0;
  return {
    pixels: pix, unique: seen.size, hfPairs, hfAvg, worldHfPairs: wfPairs, worldHfAvg,
    hfRatio: worldHfAvg > 0 ? +(hfAvg / worldHfAvg).toFixed(3) : null, top,
  };
}

/** 把相机对准投影中心（ghostTexStats 与 projGhostAB 共用；不对准就可能整个虚影在画面外 ⇒ 差异恒 0 ⇒ 假绿） */
function aimProjCam(vp, d) {
  const cl = d.sameCells.concat(d.diffCells).map((c) => c.pos);
  if (!cl.length) return;
  const xs = cl.map((p) => p[0]), zs = cl.map((p) => p[2]);
  const minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
  const minz = Math.min.apply(null, zs), maxz = Math.max.apply(null, zs);
  vp.cam.target = [(minx + maxx + 1) / 2, 1, (minz + maxz + 1) / 2];
  vp.cam.dist = Math.max(8, Math.max(maxx - minx + 1, maxz - minz + 1) * 3);
  vp.cam.xr = 0.9; vp.cam.yr = 0.6;
}
/**
 * 统计当前建筑与投影的差异：`{ ops, same, total, size, off, sameCells, diffCells, ghostSize, ghostOrigin, idHash }`；无投影返回 null。
 * ★ 2026-10-12：加 `off` 偏移（投影中心对齐原点，见 projOffset），并顺带产出 `sameCells`/`diffCells`
 *   ——后者就是投影虚影要画的两组坐标（"一致"淡青、"差异"橙黄），一处算完两处用。
 */
function projectionDiff() {
  if (!state.proj || !state.source) return null;
  const st = projStructure();
  const [sx, sy, sz] = state.source.size;
  const off = projOffset(st.size, state.source.size);
  const ops = [], sameCells = [], diffCells = [];
  let same = 0, idHash = 0;
  // ★ 虚影有**自己的一套坐标**：`projOffset` 是把投影的中心对到世界中心，投影比世界大时
  //   偏移是**负的**，投影会有一截落在负索引上 —— 而负索引装不进 Structure（越界即丢），
  //   实测 40x10x40 的投影配 16x8x16 的世界，只剩 4535/15200 块能画出来。
  //   所以虚影整体平移 `-min(0, off)` 到 ≥0，绘制时再平移回去（见 viewport 的 origin 参数）。
  const gox = Math.min(0, off[0]), goz = Math.min(0, off[2]);
  let mx = sx, my = sy, mz = sz;              // 尺寸的下限是"世界本身"（世界内的坐标也要装得下）
  // ★ state → {id, props, str} 缓存：`getBlocks()` 给的是调色板里的**同一批实例**，命中率≈100%。
  //   不缓存的话每块都要 getName().toString()（每次都新建字符串），而刷新虚影是编辑路径上的热函数。
  const infCache = new Map();
  const infoOf = (bs) => {
    let v = infCache.get(bs);
    if (!v) {
      v = { id: bs.getName().toString(), props: bs.getProperties() || {}, str: stateString(bs) };
      infCache.set(bs, v);
    }
    return v;
  };
  // 内容哈希：只比"数了几块"是**分不出"同一格换成了另一种方块"**的（两者计数都一样）——
  // 那种差异必须触发虚影重建，否则虚影停在旧形状上（实机表现：补全后虚影没变）。
  const bump = (s) => { for (let i = 0; i < s.length; i++) idHash = (idHash * 31 + s.charCodeAt(i)) | 0; };
  for (const b of st.getBlocks()) {
    const p = [b.pos[0] + off[0], b.pos[1], b.pos[2] + off[2]];
    const inf = infoOf(b.state);
    const inside = p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < sx && p[1] < sy && p[2] < sz;
    const rec = inside ? state.source.blocksMap[(p[0] * sy + p[1]) * sz + p[2]] : undefined;
    const cur = rec ? state.source.palette[rec.state] : null;
    {   // 平移后的坐标恒 ≥ 0 ⇒ 直接撑尺寸（平移过了，负索引不再是问题）
      const gx = p[0] - gox, gy = p[1], gz = p[2] - goz;
      if (gx + 1 > mx) mx = gx + 1;
      if (gy + 1 > my) my = gy + 1;
      if (gz + 1 > mz) mz = gz + 1;
    }
    bump(inf.str);
    if (cur && stateString(cur) === inf.str) { same++; sameCells.push({ pos: p, id: inf.id, props: inf.props }); continue; }
    diffCells.push({ pos: p, id: inf.id, props: inf.props });
    ops.push({ kind: 'place', pos: p, id: inf.id, props: inf.props });
  }
  return { ops, same, total: st.getBlocks().length, size: st.size, off, sameCells, diffCells,
    ghostSize: [mx, my, mz], ghostOrigin: [gox, 0, goz], idHash };
}

/**
 * 重画投影虚影（投影载入/清除、建筑变化、每次编辑之后都要调）。
 * ★ 用"签名"去重：编辑会很频繁，而重建 VBO 是 O(投影方块数) —— 差异没变就不重建
 *  （这也是为什么不用定时器防抖：定时器在 --virtual-time-budget 下不可断言，见 projects.js 的老教训）。
 */
let ghostSig = '';
let ghostHidden = false;      // 用户把虚影收起来了（**投影还在**，只是不显示）
let lastGhostMode = null;     // 上一次的虚影表示（texture/solid）—— 只在**变化**时提示用户
/**
 * **编辑路径专用**：把虚影重建**推迟到最后一次编辑之后**（默认 220 ms）。
 * 为什么：重建一次是 O(投影块数)（实测 800 块约 8 ms、6000 块约 30 ms），而它挂在每次编辑后面 ——
 * 拖拽放一行方块时每块都重烘一次，越大越顿。合并之后"拖拽过程中不重建、停下来立刻重建一次"。
 * ★ 与"按签名去重"是两件事：签名去重管"内容没变就别重建"，这个管"变了很多次也只重建一次"。
 */
let ghostTimer = 0;
function scheduleGhost(delayMs) {
  if (ghostTimer) clearTimeout(ghostTimer);
  ghostTimer = setTimeout(() => { ghostTimer = 0; refreshGhost(); }, delayMs || 220);
}
/** 立即执行挂起的重建（导入/补全/移到原点/闸门用 —— 那些路径要"调完就能读到结果"）。 */
function flushGhost() {
  if (ghostTimer) { clearTimeout(ghostTimer); ghostTimer = 0; }
  return refreshGhost();
}
function refreshGhost() {
  if (ghostTimer) { clearTimeout(ghostTimer); ghostTimer = 0; }   // 同步路径优先：别让定时器再跑一次
  if (ghostHidden) return;                                        // 用户把虚影收起来了
  return refreshGhostNow();
}
function refreshGhostNow() {
  if (!state.vp || !state.vp.setProjGhost) return;
  const diff = projectionDiff();
  if (!diff) {
    if (ghostSig) { ghostSig = ''; state.vp.clearProjGhost(); }
    return;
  }
  // ★ 签名必须含**内容**（idHash）：只比数量的话，"同一格换成另一种方块"不会触发重建。
  const sig = diff.sameCells.length + '/' + diff.diffCells.length + '/' + diff.off.join(',') + '/' + diff.idHash;
  if (sig === ghostSig) return;
  ghostSig = sig;
  state.vp.setProjGhost(diff.sameCells, diff.diffCells, diff.ghostSize, diff.ghostOrigin);
  // ★ 降级要**明说**（2026-10-12）：用户看到"一片纯色、没有贴图"时无从判断是坏了还是设计如此。
  //   只在**模式变化**时提示一次（refreshGhost 在每次编辑后都会跑，不能每次都弹）。
  const gi = state.vp.projGhostInfo;
  const mode = gi ? gi.diffMode : null;
  if (mode && mode !== lastGhostMode) {
    lastGhostMode = mode;
    if (mode === 'solid') setMsg(`投影较大（${diff.diffCells} 块差异），虚影已切换为**快速显示**（纯色块）；点「按投影补全」后会恢复精细显示`);
    else if (mode === 'texture' && diff.diffCells > 400) setMsg(`投影虚影：${diff.diffCells} 块差异，带贴图显示`);
  }
}

/**
 * 隐藏 / 显示投影虚影（**不卸载投影** —— 用户要的"关闭投影"）。
 * 为什么不做成"删除投影"：那个已经有「清除投影」按钮了；而误删投影是不可逆的作业损失，
 * 用户说"关闭"时想要的通常是"先把它收起来看世界"。
 */
function toggleGhost() {
  ghostHidden = !ghostHidden;
  if (ghostHidden) { ghostSig = ''; state.vp.clearProjGhost(); setMsg('已隐藏投影虚影（投影仍在，「显示虚影」可恢复）'); }
  else { ghostSig = ''; refreshGhost(); setMsg('已显示投影虚影'); }
  refreshProjButtons();
  return ghostHidden;
}
/**
 * [移到原点]（框选动作条，2026-10-12）：把**选区范围内**的方块整体搬到原点。
 * 用户原始诉求：「我需要你修改的是**工具**，不是文件」——他遇到"补全的投影挪动了"
 * （一批方块被补到几十格之外），所以要给的是**工具能力**：框住那批 → 一键搬回来。
 * 与「清空」的分工：**搬回来保住了成果**（那批方块本身是对的，只是位置错），
 * 删除是不可逆的信息损失 —— 要删的话旁边就有「清空」。
 * 整批一条历史 ⇒ 一次 Ctrl+Z 全退。
 */
function doMoveSel() {
  const cells = selCells();
  if (!cells.length) { setMsg('先在视口里拖出一个选区', 'warn'); return false; }
  const inSel = new Set(cells.map(([x, z]) => x + ',' + z));
  const bl = [];
  for (const b of state.source.getBlocks()) {
    if (inSel.has(b.pos[0] + ',' + b.pos[2])) bl.push(b);     // 整列（跨 y）都算选区内
  }
  if (!bl.length) { setMsg('选区里没有方块，没什么可搬的', 'warn'); return false; }
  // ★ 确认框在**按钮那边**（UI 层）：函数本身保持纯逻辑 —— 无头环境里 confirm 会返回 false，
  //   把确认写进这里会让这条能力**在闸门里根本跑不到**（等于没测）。
  return shiftBlocksToOrigin(bl);
}

/** 刷新投影按钮（显隐 + 文案带差异数）。 */
function refreshProjButtons() {
  const btn = $('projApply'), clr = $('projClear'), hid = $('projHide');
  if (!btn || !clr) return;
  const has = !!state.proj;
  // ★ L3：整条浮层跟着"有没有投影"整存整取。不这么做的话，清掉投影后会在视口右上
  //   留一个**空壳卡片**（三个按钮都 display:none，但框和标题还在）—— 那是纯粹的视觉垃圾。
  const pbar = $('projBar');
  if (pbar) pbar.hidden = !has;
  btn.style.display = has ? '' : 'none';
  clr.style.display = has ? '' : 'none';
  if (hid) {
    hid.style.display = has ? '' : 'none';
    hid.textContent = ghostHidden ? '显示虚影' : '隐藏虚影';
  }
  if (has) {
    const diff = projectionDiff();
    const n = diff ? diff.ops.length : 0;
    // 差异 0 ⇒ 明说「已一致」并禁用：写「按投影补全（0 块）」会被读成「还有 0 块要补」，误导
    btn.textContent = n ? `按投影补全（${n} 块）` : '已与投影一致';
    btn.disabled = n === 0;
  } else {
    btn.disabled = false;
  }
}

/** 导入投影（不替换世界）。 */
async function importProjFile(file) {
  showBusy(`载入投影 ${file.name}…`);
  try {
    const build = await hostImport(file.name, new Uint8Array(await file.arrayBuffer()));
    state.proj = build;
    // ★ 先补资源再画虚影：投影可能用到建筑里没有的方块（资源是按需打包的），
    //   不补的话那些方块在虚影里**没有模型可画**（表现为"虚影缺一大块"）。
    const pr = await ensureProjAssets();
    const diff = projectionDiff();
    const prNote = (pr && pr.added) ? ` · 已补 ${pr.added} 个投影方块的资源` : ((pr && pr.failed) ? ' · 资源补齐失败（虚影可能缺块）' : '');
    setMsg(`投影已载入：${file.name}（${diff.total} 块 · 与当前建筑差异 ${diff.ops.length} 块 · 已按原点对齐）${prNote}——点「按投影补全」把建筑修成投影`);
    refreshProjButtons();
    refreshGhost();                       // ★ 虚影：投影的"目标形状"要立刻看得见
  } catch (e) {
    setMsg(String(e.message || e), 'err');
  } finally { hideBusy(); }
}

/** 按投影补全：缺的补上、错的替换（只补不删）；整批一次可撤销；世界不够大先长大。 */
function applyProjection() {
  const diff = projectionDiff();
  if (!diff) { setMsg('先「导入投影…」再补全', 'warn'); return; }
  if (!diff.ops.length) { setMsg(`建筑与投影完全一致（共 ${diff.total} 块），无需补全`); return; }
  const [px, py, pz] = diff.size;
  const [sx, sy, sz] = state.source.size;
  if (px > sx || py > sy || pz > sz) {
    const round8 = (v) => Math.max(8, Math.ceil(v / 8) * 8);
    const nsize = [Math.max(sx, round8(px)), Math.max(sy, round8(py)), Math.max(sz, round8(pz))];
    shiftWorld(0, 0, 0, nsize);
    setMsg(`世界已长大到 ${state.source.size.join('×')} 以容纳投影`);
    return applyProjection();        // 尺寸变化后重算一遍（一次即收敛）
  }
  // ★ 整批 = 一次 Ctrl+Z 全撤。注意：**这不是靠 begin/endGroup 保证的**——
  //   doEdit → EditStack.commit(ops) 在没开组时本来就把整批落成**一条**历史（见 edits.js commit 尾部）。
  //   变异测试 M7 已证实：把这两行去掉，(C3)「补全整批一次撤销」照样绿 ⇒ 这对开组调用是**冗余保险**，
  //   留着是为了将来若把补全拆成多次 doEdit 时仍保持原子性。(C3) 真正的判据来源是 commit 的单条入栈
  //   （对应变异 M13：让 commit 改成逐格入栈 ⇒ (C3) 必红）。
  state.edit.beginGroup();
  const changed = doEdit(diff.ops);
  state.edit.endGroup();
  if (changed) setMsg(`已按投影补全：放置/替换 ${diff.ops.length} 块（原有一致 ${diff.same} / 投影共 ${diff.total}；只补不删）；一次 Ctrl+Z 可全撤`);
  else setMsg('补全未产生变化（投影与建筑已一致）');
  refreshProjButtons();
  refreshGhost();                         // 补全后差异归零 ⇒ 高亮组应当清空
}

/**
 * 「移到原点」（2026-10-12 用户要求）：把世界的**内容整体平移**，让内容包围盒中心对上用户坐标原点。
 *
 * ★ 为什么不用 `shiftWorld`：它是"世界长大"用的机制 —— 会重建 structure 并把**撤销历史里的坐标一起迁移**，
 *   但**它自己不是一次可撤销的编辑**（Ctrl+Z 撤不回来）。而"移到原点"是用户会想反悔的操作，
 *   所以这里改成**整批 erase + place 走 doEdit** ⇒ 一条历史、一次 Ctrl+Z 完整回退。
 *   （顺带：`repair:false` —— 平移不改变方块之间的相对关系，连接状态一个都不用重算。）
 * ★ dx/dz 要 clamp 到"不越界"的范围：内容若本来就贴着某一边，中心对原点会让另一头出界，
 *   而出界时 `Structure.addBlock` 会抛异常 —— 与其报错，不如夹住并**明说**受网格边界限制。
 * y 顺手贴地（最低方块落到 y=0）："移到原点"里的"原点"包含地面这一层。
 */
function moveContentToOrigin() {
  const st = state.source;
  if (!st) return false;
  const bl = st.getBlocks();
  if (!bl.length) { setMsg('世界是空的，没有可移到原点的内容', 'warn'); return false; }
  return shiftBlocksToOrigin(bl);
}

/**
 * 把**给定一组方块**整体搬到原点（内容包围盒中心对齐原点 + 贴地；出界就夹住），一次可撤销。
 * ★ 2026-10-12 从 `moveContentToOrigin` 里抽出来：**框选的「移到原点」用的是同一套算法**
 *   （用户报"补全的投影挪动了" ⇒ 让他能自己把那一批搬回来，而不是我替他改文件）。
 *   `repair:false`：平移不改变方块之间的相对关系，连接状态一个都不用重算。
 */
function shiftBlocksToOrigin(bl) {
  const st = state.source;
  if (!st || !bl.length) return false;
  const [sx, sy, sz] = st.size;
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity, mny = Infinity;
  for (const b of bl) {
    const [x, y, z] = b.pos;
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    if (y < mny) mny = y;
  }
  // 内容的"中心"按格边界算（min+max+1)/2）：奇数跨度落在中格，偶数跨度落在两格之间（取低格）
  const cx = Math.floor((mnx + mxx + 1) / 2), cz = Math.floor((mnz + mxz + 1) / 2);
  const tx = Math.floor(sx / 2), tz = Math.floor(sz / 2);        // 世界中心索引 = 用户坐标 0
  const wantDx = tx - cx, wantDz = tz - cz;
  const dx = Math.max(-mnx, Math.min(sx - 1 - mxx, wantDx));
  const dz = Math.max(-mnz, Math.min(sz - 1 - mxz, wantDz));
  const dy = -mny;                                                // 贴地（地面以下不允许，mny≥0 ⇒ dy≤0）
  if (!dx && !dz && !dy) { setMsg('内容已经在原点上了（中心对齐 + 贴地），无需移动'); return false; }
  const ops = [];
  for (const b of bl) ops.push({ kind: 'erase', pos: b.pos.slice() });
  for (const b of bl) {
    ops.push({
      kind: 'place', pos: [b.pos[0] + dx, b.pos[1] + dy, b.pos[2] + dz],
      id: b.state.getName().toString(), props: b.state.getProperties() || {},
    });
  }
  if (!doEdit(ops, { repair: false })) { setMsg('移到原点没有产生变化', 'warn'); return false; }
  const clamped = (dx !== wantDx || dz !== wantDz);
  setMsg(`已把内容移到原点：整体平移 ${dx}, ${dy}, ${dz} 格（一次 Ctrl+Z 可撤）`
    + (clamped ? '；⚠ 受网格边界限制，中心没能完全对上原点（可点「适应建筑」看一眼）' : ''), clamped ? 'warn' : '');
  return true;
}

async function doImport(file) {
  showBusy(`导入 ${file.name}…`);
  try {
    const build = await hostImport(file.name, new Uint8Array(await file.arrayBuffer()));
    loadBuild(build, file.name);
    $('sample').value = '';
  } catch (e) {
    setMsg(String(e.message || e), 'err');
  } finally { hideBusy(); }
}

/**
 * 导出用 JSON：世界**太大**时按**内容包围盒**裁剪。
 * 为什么必须：导出器是稠密的（`new Int32Array(W*H*D)`，见 api.mjs 的 buildGrid），
 * "无限建造"下世界可能到几亿格 ⇒ 直接爆内存。裁剪后区域 = 你的建筑本身，语义也更对。
 * 小世界（≤ EXPORT_CROP_MIN 格）**照旧导全图**，不改既有行为。
 */
const EXPORT_CROP_MIN = 2000000;
function buildJsonForExport(name) {
  const st = state.source;
  const [sx, sy, sz] = st.size;
  const full = structureToBuildJson(st, { name, format: 'preview' });
  if (sx * sy * sz <= EXPORT_CROP_MIN) return { json: full, cropped: null };
  const bs = st.getBlocks();
  if (!bs.length) return { json: full, cropped: null };
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const b of bs) for (let i = 0; i < 3; i++) { if (b.pos[i] < mn[i]) mn[i] = b.pos[i]; if (b.pos[i] > mx[i]) mx[i] = b.pos[i]; }
  const size = [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1];
  const blocks = full.blocks.map((b) => ({ pos: [b.pos[0] - mn[0], b.pos[1] - mn[1], b.pos[2] - mn[2]], state: b.state }));
  return { json: { ...full, size, blocks }, cropped: { from: [sx, sy, sz], to: size } };
}
async function doExport(format) {
  showBusy(`导出 .${format}…`);
  try {
    const { json, cropped } = buildJsonForExport(state.build?.name || 'building');
    const { blob, filename } = await hostExport(json, format);
    download(blob, filename);
    setMsg(`已导出 ${filename}（${(blob.size / 1024).toFixed(1)} KB）`
      + (cropped ? `：世界 ${cropped.from.join('×')} 太大，已按内容裁剪到 ${cropped.to.join('×')}` : ''));
  } catch (e) {
    setMsg(String(e.message || e), 'err');
  } finally { hideBusy(); }
}

function showMaterials() {
  const json = structureToBuildJson(state.source, { name: state.build?.name || 'building' });
  const rows = materialRows(json, (id) => state.inv.nameOf(id));
  const total = rows.reduce((s, r) => s + r.count, 0);
  $('dlgBody').innerHTML =
    `<p class="hint">共 ${rows.length} 种方块、${total} 个。按数量降序。</p>` +
    `<table><thead><tr><th>方块</th><th>id</th><th style="text-align:right">数量</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td>${r.name}</td><td style="color:#7f8ea1">${r.id}</td><td class="n">${r.count}</td></tr>`).join('') +
    `</tbody></table>`;
  $('dlg').classList.add('on');
}

// 独立网页（index.html 用 `<script type="module">` 直接加载）没人替我们调 boot()，这里自动跑一次。
// 功能包模式**不跑**：由 entry 在**每次挂载**后调用 `mod.boot()`（理由见 boot() 上方的说明）。
if (!isFeature()) boot();
