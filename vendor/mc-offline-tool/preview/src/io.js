// io.js —— 导入 / 导出 / 材料清单。全部走 preview/api.mjs 的三个路由（服务端只做格式转换，不做渲染）。
//
// 为什么导入走服务端：.litematic / .schem 的解析在 Node 侧（src/schem-reader.mjs）已经写好且经往返验证，
// 浏览器侧再实现一份只会两边不一致。导出同理（.schem / .litematic 都要 gzip+NBT 写入器）。

/** 导入任意建筑文件 → build.json 形状 */
export async function importBuilding(file) {
  const buf = await file.arrayBuffer();
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
    body: buf,
  });
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt).error || txt; } catch { /* 非 JSON 就用原文 */ }
    throw new Error(`导入失败：${msg}`);
  }
  return JSON.parse(txt);
}

/** 导出：format = 'schem' | 'litematic'。返回 { blob, filename, materials } */
export async function exportBuilding(buildJson, format) {
  const res = await fetch(`/api/export?format=${encodeURIComponent(format)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildJson),
  });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error || msg; } catch { /* 原文 */ }
    throw new Error(`导出失败：${msg}`);
  }
  const blob = await res.blob();
  let filename = decodeURIComponent(res.headers.get('x-filename') || `building.${format}`);
  let materials = [];
  const mh = res.headers.get('x-materials');
  if (mh) { try { materials = JSON.parse(decodeURIComponent(mh)); } catch { /* 材料清单不是必须的 */ } }
  return { blob, filename, materials };
}

/** 触发浏览器下载 */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 材料清单：把 buildJson 的 palette/blocks 统计成 [{id,name,count}]，降序 */
export function materialRows(buildJson, nameOf = (id) => '') {
  const counts = new Map();
  for (const b of buildJson.blocks || []) {
    const p = buildJson.palette[b.state];
    if (!p) continue;
    counts.set(p.Name, (counts.get(p.Name) || 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, name: nameOf(id) || id, count }))
    .sort((a, b) => b.count - a.count);
}

export function materialsCsv(rows) {
  const esc = (s) => /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  return '\ufeff' + 'id,name,count\n' + rows.map(r => `${esc(r.id)},${esc(r.name)},${r.count}`).join('\n') + '\n';
}

/** 从内存场景导出一个 build.json 形状（供导出与材料清单共用） */
export function structureToBuildJson(structure, { name, format = 'preview', source = '' } = {}) {
  const [sx, sy, sz] = structure.getSize();
  const palette = structure.palette.map(bs => ({
    Name: bs.getName().toString(),
    Properties: bs.getProperties() || {},
  }));
  const blocks = structure.getBlocks().map(b => ({
    pos: [b.pos[0], b.pos[1], b.pos[2]],
    state: typeof b.state === 'number' ? b.state : palette.findIndex(p => p.Name === b.state.getName().toString()),
  }));
  return { format, name, size: [sx, sy, sz], palette, blocks, source };
}
