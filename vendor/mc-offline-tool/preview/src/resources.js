// resources.js —— 把 data/assets.js + atlas.png + opaque.js 组装成 Deepslate 要的 Resources。
//
// 与预演 `dl-demo/out/main.js` 的这段逻辑逐行一致（含两条踩过坑的规则）：
//   · 动画贴图：`du≠dv 且路径以 block/ 开头` 时用宽度当高度（否则水/岩浆/火撕裂）
//   · getDefaultBlockProperties 返回 null：与预演一致，不要擅自改成 {}（会改变 tint/状态的合并行为）
export async function buildResources(D, { assets, opaque, atlasUrl = 'data/atlas.png' }) {
  const A = assets;
  // ★ 静默失败是这一轮最难查的一类 bug：某条 fromJson 抛错 → 该方块被悄悄丢掉 → 渲染成空白。
  //   现在把跳过的条目**收集起来回报**（warning + stats.skipped + skipped 数组），让工具明说而不是装作没事。
  const skipped = [];
  const blockDefinitions = {};
  for (const [id, json] of Object.entries(A.blockstates)) {
    try { blockDefinitions[id] = D.BlockDefinition.fromJson(json); } catch (e) { skipped.push({ kind: 'blockstate', id, why: String((e && e.message) || e) }); }
  }
  const blockModels = {};
  for (const [id, json] of Object.entries(A.models)) {
    try { blockModels[id] = D.BlockModel.fromJson(json); } catch (e) { skipped.push({ kind: 'model', id, why: String((e && e.message) || e) }); }
  }
  Object.values(blockModels).forEach(m => {
    try { m.flatten({ getBlockModel: id => blockModels[id.toString()] }); } catch { /* parent 链断的模型跳过 */ }
  });

  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('图集加载失败：' + atlasUrl));
    i.src = atlasUrl;
  });
  const S = img.width;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const atlasData = ctx.getImageData(0, 0, S, S);

  const idMap = {};
  for (const [id, [x, y, w, h]] of Object.entries(A.textures)) {
    const p = id.split(':')[1] || id;
    const h2 = (w !== h && p.startsWith('block/')) ? w : h;
    idMap[id] = [x / S, y / S, (x + w) / S, (y + h2) / S];
  }
  const atlas = new D.TextureAtlas(atlasData, idMap);

  const O = opaque || {};
  const OPAQUE = new Set(O.opaque || []);
  const NONSELF = new Set(O.nonSelfCulling || []);
  const TRANSP = new Set(O.transparent || []);

  const resources = {
    getBlockDefinition(id) { return blockDefinitions[id.toString()]; },
    getBlockModel(id) { return blockModels[id.toString()]; },
    getTextureUV(id) { return atlas.getTextureUV(id); },
    getTextureAtlas() { return atlas.getTextureAtlas(); },
    getPixelSize() { return atlas.getPixelSize(); },
    getBlockFlags(id) {
      const s = id.toString();
      return { opaque: OPAQUE.has(s), self_culling: !NONSELF.has(s), semi_transparent: TRANSP.has(s) };
    },
    getBlockProperties() { return null; },
    getDefaultBlockProperties() { return null; },
    getItemModel() { return undefined; },
    getItemComponents() { return undefined; },
  };

  return {
    resources,
    skipped,
    stats: {
      atlasSize: S,
      blockstates: Object.keys(blockDefinitions).length,
      models: Object.keys(blockModels).length,
      uvEntries: Object.keys(idMap).length,
      skipped: skipped.length,
    },
    hasDefinition: (id) => Boolean(blockDefinitions[id]),
  };
}
