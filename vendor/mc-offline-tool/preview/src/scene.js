// scene.js —— 按需打包（P4）：把当前建筑的方块状态发给服务端，换回**只含这些贴图**的小图集与配套模型表。
//
// 为什么这么设计：全量图集要装 2,482 张贴图（4096²/2.5 MB）；而一个建筑通常只用到几十种方块
// ⇒ 按需打包后图集常常只有 512²~1024²、几十 KB，首屏与显存都轻得多。
// 解析与打包都在服务端（复用 `preview/scene-assets.mjs`，已被全量重建验证过），浏览器只负责取用。

/**
 * @param {string[]} states 方块状态串数组，如 ["minecraft:grass_block[snowy=false]", …]
 * @returns {Promise<{assets:object, atlasUrl:string, stats:object, key:string}>}
 */
export async function loadSceneAssets(states) {
  const res = await fetch('/api/scene', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ states }),
  });
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt).error || txt; } catch { /* 非 JSON 就用原文 */ }
    throw new Error(msg);
  }
  const meta = JSON.parse(txt);
  const assetsRes = await fetch(meta.assets);
  if (!assetsRes.ok) throw new Error(`取不到场景模型表：${meta.assets}（${assetsRes.status}）`);
  const assets = await assetsRes.json();
  return {
    assets, atlasUrl: meta.atlas, stats: meta.stats, key: meta.key,
    missing: meta.missing || [], unknownStates: meta.unknownStates || [],
    defaults: meta.defaults || {}, flags: meta.flags || null,
    truncated: meta.truncated || null,     // U4：截断标记要透传，否则前端无从知道"结果被砍过"
  };
}
