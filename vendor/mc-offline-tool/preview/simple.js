// main.js —— Deepslate 渲染「用户本地数据的建筑」
//
// 资源三件套：data/assets.js（blockstates+models+UV）、data/atlas.png、data/opaque.js
// 建筑：data/build.json —— 由 build-to-json.mjs 从 .nbt/.litematic/.schem 统一转来（只吃 JSON，浏览器侧不解析建筑格式）
//
// 与 `E:\mc\.work\dl-demo\out\main.js` 的差异只有三处，渲染与交互逻辑原样保留：
//   ① 路径改成相对路径（vendor/ 与 data/），不再依赖 /node_modules 与 /out
//   ② 建筑从 build.json 读，支持 `?build=<相对路径>` 换建筑
//   ③ HUD 多报 format / name / 缺失定义数，便于验收时一眼看出渲染的是哪个文件
const D = window.deepslate;
const hud = document.getElementById('hud');
const errBox = document.getElementById('err');
const log = (s) => { hud.textContent = s; console.log(s); };
window.addEventListener('error', e => { errBox.textContent = 'ERROR: ' + (e.message || e.error); });

const buildUrl = new URLSearchParams(location.search).get('build') || 'data/build.json';

(async function () {
  try {
    log('构造模型定义…');
    const A = window.__ASSETS__;
    const blockDefinitions = {};
    for (const [id, json] of Object.entries(A.blockstates)) {
      try { blockDefinitions[id] = D.BlockDefinition.fromJson(json); } catch (e) {}
    }
    const blockModels = {};
    for (const [id, json] of Object.entries(A.models)) {
      try { blockModels[id] = D.BlockModel.fromJson(json); } catch (e) {}
    }
    Object.values(blockModels).forEach(m => { try { m.flatten({ getBlockModel: id => blockModels[id.toString()] }); } catch (e) {} });
    log(`模型定义: blockstates ${Object.keys(blockDefinitions).length} / models ${Object.keys(blockModels).length}`);

    log('加载图集…');
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data/atlas.png'; });
    const S = img.width;
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const atlasData = ctx.getImageData(0, 0, S, S);
    const idMap = {};
    for (const [id, [x, y, w, h]] of Object.entries(A.textures)) {
      const p = id.split(':')[1] || id;
      const h2 = (w !== h && p.startsWith('block/')) ? w : h;   // 动画贴图：宽当高（照抄 litematic-viewer）
      idMap[id] = [x / S, y / S, (x + w) / S, (y + h2) / S];
    }
    const atlas = new D.TextureAtlas(atlasData, idMap);
    log(`图集: ${S}×${S}  UV 条目 ${Object.keys(idMap).length}`);

    const O = window.__OPAQUE__ || {};
    const OPAQUE = new Set(O.opaque || []), NONSELF = new Set(O.nonSelfCulling || []), TRANSP = new Set(O.transparent || []);
    const resources = {
      getBlockDefinition(id) { return blockDefinitions[id.toString()]; },
      getBlockModel(id) { return blockModels[id.toString()]; },
      getTextureUV(id) { return atlas.getTextureUV(id); },
      getTextureAtlas() { return atlas.getTextureAtlas(); },
      getPixelSize() { return atlas.getPixelSize(); },
      getBlockFlags(id) { const s = id.toString(); return { opaque: OPAQUE.has(s), self_culling: !NONSELF.has(s), semi_transparent: TRANSP.has(s) }; },
      getBlockProperties() { return null; },
      getDefaultBlockProperties() { return null; },
      getItemModel() { return undefined; },
      getItemComponents() { return undefined; },
    };

    log('读建筑文件…');
    const j = await (await fetch(buildUrl)).json();
    const [sx, sy, sz] = j.size;
    const palette = j.palette;
    const blocks = j.blocks;
    log(`建筑: ${j.name || j.source || buildUrl}  [${j.format || '?'}]  ${sx}×${sy}×${sz}  方块 ${blocks.length}  调色板 ${palette.length}`);

    const structure = new D.Structure([sx, sy, sz]);
    let placed = 0;
    const missing = new Set();
    for (const b of blocks) {
      const entry = palette[b.state];
      if (!entry) continue;
      const name = entry.Name;
      structure.addBlock(b.pos, name, entry.Properties || {});
      placed++;
      if (!blockDefinitions[name]) missing.add(name);
    }
    log(`已放置 ${placed} 方块  缺失定义 ${missing.size} 个${missing.size ? '\n' + [...missing].slice(0, 8).join('\n') : ''}`);

    // ---- 渲染 + 交互（照抄 demo 的 InteractiveCanvas） ----
    const canvas = document.getElementById('c');
    function fitCanvas() { canvas.width = window.innerWidth * devicePixelRatio; canvas.height = window.innerHeight * devicePixelRatio; }
    fitCanvas(); window.addEventListener('resize', () => { fitCanvas(); redraw(); });

    const gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('WebGL 不可用');
    const renderer = new D.StructureRenderer(gl, structure, resources);

    const mat4 = (window.glMatrix && window.glMatrix.mat4) || D.mat4;
    if (!mat4) throw new Error('gl-matrix (mat4) 不可用');
    const center = [sx / 2, sy / 2, sz / 2];
    let xr = 0.9, yr = 0.6, dist = Math.max(6, Math.max(sx, sy, sz) * 2.2);
    function draw() {
      renderer.setViewport(0, 0, canvas.width, canvas.height);   // 刷新内建投影（aspect 取自 gl.canvas）
      gl.clearColor(0.055, 0.067, 0.086, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const view = mat4.create();
      mat4.translate(view, view, [0, 0, -dist]);
      mat4.rotate(view, view, xr, [1, 0, 0]);
      mat4.rotate(view, view, yr, [0, 1, 0]);
      mat4.translate(view, view, [-center[0], -center[1], -center[2]]);
      renderer.drawStructure(view);
    }
    let pending = false;
    function redraw() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; draw(); }); }

    let drag = null;
    canvas.addEventListener('mousedown', e => { if (e.button === 0) drag = [e.clientX, e.clientY]; });
    window.addEventListener('mousemove', e => { if (drag) { yr += (e.clientX - drag[0]) / 120; xr += (e.clientY - drag[1]) / 120; xr = Math.max(-1.5, Math.min(1.5, xr)); drag = [e.clientX, e.clientY]; redraw(); } });
    window.addEventListener('mouseup', () => drag = null);
    canvas.addEventListener('wheel', e => { e.preventDefault(); dist = Math.max(2, dist + e.deltaY / 120); redraw(); }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    // 截图式验收（无头浏览器靠 --virtual-time-budget 等首帧）：
    // 渲染完成就把状态挂到 window，外部可直接读。
    draw();
    window.__PREVIEW_READY__ = { format: j.format, name: j.name, size: [sx, sy, sz], placed, missingDefs: missing.size, atlas: S };
    log(`完成 ✓  ${j.name || ''} ${sx}×${sy}×${sz} / ${placed} 方块 / 缺失定义 ${missing.size} / 图集 ${S}²`);
  } catch (e) {
    errBox.textContent = 'ERROR: ' + (e && e.stack || e);
    console.error(e);
  }
})();
