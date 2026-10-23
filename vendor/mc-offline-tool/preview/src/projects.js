// projects.js —— 多项目存档层（2026-10-11，用户诉求：「每次点新建都会丢失旧项目」）。
//
// ── 为什么是 localStorage，而不是 IndexedDB ────────────────────────────────────
// 实测（preview/.work/probe-store*.py，无头 Edge + 假宿主）：
//   · localStorage：跨**页面加载**确实持久（第 1 次加载写、第 2 次加载读回，age_ms=629 真实流逝）；
//     单键 2.5MB 可写、4MB 抛 QuotaExceededError（字符串按 UTF-16 双字节计），**总量 4.5MB**。
//   · IndexedDB：**在 `--virtual-time-budget` 下观测不到往返** —— 虚拟时间会把 setTimeout 瞬间推进，
//     而 IDB 的真实 IPC 往返还没回来 ⇒ 闸门里永远读不到结果。
// ★ 选型的决定性理由不是容量，而是**可验证性**：本次的核心承诺是"切换项目不丢数据"，
//   而选 IDB 就等于把核心承诺交给一个闸门断言不了的通道（本项目纪律：每条主张都要有闸门+变异）。
//   容量墙用**紧凑编码**（下）与**容量护栏**（配额错误显式上报）来对冲。
//   将来若要上 IDB：把假宿主从 --dump-dom 换成 CDP（Evaluate + 真实等待）即可，判据不用重写。
//
// ── 紧凑编码（同步，无依赖）─────────────────────────────────────────────────
// build.json 里 `{"pos":[1,2,3],"state":5}` 一个方块要 26 字符，而本项目存档动辄上万个方块。
// 改成 `x,y,z,s;`（十进制、分号分隔）后同样一块只要 ~8 字符 ⇒ **实测 2.6× 压缩**，
// 直接把"能存几个项目"抬上去。★ 只用于**内部存档**；导出 .schem/.litematic 走的仍是标准格式，不动。
//
// ── 数据布局 ────────────────────────────────────────────────────────────────
//   mc-preview:projects      索引 { v, list:[{id,name,at,blocks,bytes}], last }
//   mc-preview:proj:<id>     单个项目正文（紧凑编码后的 JSON 文本）
//   mc-preview:autosave      旧版单快照 —— 首次启动时**迁移**成一个项目，不丢老数据

export const IDX_KEY = 'mc-preview:projects';
export const PROJ_PREFIX = 'mc-preview:proj:';
export const OLD_SNAP_KEY = 'mc-preview:autosave';   // 旧版（v1.11.0 及以前）的单快照 key

/** 单项目上限：实测单键 2.5MB 可写、4MB 炸；留余量到 2.4MB。 */
export const PROJ_MAX_CHARS = 2_400_000;
/** 全库上限：实测总量 4.5MB；留余量到 4.4MB。 */
export const TOTAL_MAX_CHARS = 4_400_000;

const nowMs = () => Date.now();
const newId = () => 'p' + nowMs().toString(36) + Math.floor(Math.random() * 1296).toString(36);

// ------------------------------------------------------------------ 紧凑编解码
/**
 * build.json → 紧凑文本。
 * 保持**无损可逆**：`unpackBuild(packBuild(b))` 与 `b` 语义等价（blocks 顺序、palette 顺序都不变）。
 */
export function packBuild(build) {
  const b = build || {};
  const palette = (b.palette || []).map(p => (Array.isArray(p) ? p : [p.Name || p.name || '', p.Properties || p.properties || {}]));
  const parts = (b.blocks || []).map((bl) => {
    const p = bl.pos || [0, 0, 0];
    return p[0] + ',' + p[1] + ',' + p[2] + ',' + (bl.state | 0);
  });
  return JSON.stringify({
    v: 1,
    n: b.name || '',
    f: b.format || 'preview',
    src: b.source || '',
    s: b.size || [0, 0, 0],
    p: palette,
    b: parts.join(';'),
  });
}

/** 紧凑文本 → build.json 形状（与 io.js 的 structureToBuildJson 输出同形，可直接喂 loadBuild）。 */
export function unpackBuild(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  if (!j || j.v !== 1) throw new Error('存档格式不认识（v=' + (j && j.v) + '）');
  const blocks = [];
  if (j.b) {
    for (const seg of String(j.b).split(';')) {
      if (!seg) continue;
      const c = seg.split(',');
      blocks.push({ pos: [+c[0], +c[1], +c[2]], state: +c[3] | 0 });
    }
  }
  const palette = (j.p || []).map(([Name, Properties]) => ({ Name, Properties: Properties || {} }));
  return {
    format: j.f || 'preview', name: j.n || '', source: j.src || '',
    size: j.s || [0, 0, 0], palette, blocks,
    stats: { blocks: blocks.length },
  };
}

// ------------------------------------------------------------------ 底层读写
function readRaw(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeRaw(k, v) { localStorage.setItem(k, v); }      // 配额错**不吞**：由调用方转成用户可见的原因
function removeRaw(k) { try { localStorage.removeItem(k); } catch { /* 不可用就算了 */ } }

let lastError = null;
/** 最近一次失败的机器可读原因（闸门据此断言"走了哪条路"：quota / unavailable / …）。 */
export function lastFailure() { return lastError; }

function readIndex() {
  const raw = readRaw(IDX_KEY);
  if (!raw) return { v: 1, list: [], last: '' };
  try {
    const j = JSON.parse(raw);
    if (!j || j.v !== 1 || !Array.isArray(j.list)) return { v: 1, list: [], last: '' };
    return { v: 1, list: j.list.filter(p => p && p.id), last: j.last || '' };
  } catch { return { v: 1, list: [], last: '' }; }
}
function writeIndex(idx) { writeRaw(IDX_KEY, JSON.stringify(idx)); }

/** 全库占用（字符数，≈ 存储字节的一半精度足够做护栏）。 */
export function usage() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === IDX_KEY || k.startsWith(PROJ_PREFIX)) total += (readRaw(k) || '').length;
    }
  } catch { /* 读不到就报 0（护栏退化为只靠单键上限） */ }
  return { chars: total, max: TOTAL_MAX_CHARS };
}

export function list() { return readIndex().list; }
export function lastId() { return readIndex().last; }

/** 建项目（不覆盖任何既有项目）。返回 { ok, id, why? } */
export function create(name, build) {
  const id = newId();
  const idx = readIndex();
  const entry = { id, name: String(name || '未命名'), at: nowMs(), blocks: 0, bytes: 0 };
  // ★ 这里曾经写成 `r.idx.list.push(entry)` —— 而 save() 的返回值里**没有 idx**（它只回 {ok,bytes,blocks}）
  //   ⇒ 一新建就抛 TypeError: Cannot read properties of undefined (reading 'list')，
  //   表现为"面板根本起不来"（启动链在 bootProjects 里断掉）。
  //   修法：用上面这个 idx 局部变量（它就是传给 save 的同一个对象引用）。
  //   这条也进了 node 单测（preview/.work/t-projects.mjs 的 P4），不会再靠"跑起来看看"发现。
  const r = save(id, build, { idx, entry });
  if (!r.ok) return r;
  idx.list.push(entry);
  idx.last = id;
  try { writeIndex(idx); } catch (e) { lastError = 'index:' + (e && e.name); return { ok: false, why: '项目索引写不进去（存储可能已满）' }; }
  return { ok: true, id };
}

/**
 * 写一个项目的正文。`idx`/`entry` 可传入以避免重复解析索引（内部用）。
 * ★ 返回 { ok, why }，**永不抛** —— 调用方（自动保存/手动保存）都要能把它变成用户可见的一句话。
 */
export function save(id, build, internal) {
  lastError = null;
  const text = packBuild(build);
  if (text.length > PROJ_MAX_CHARS) {
    lastError = 'quota:project';
    return { ok: false, why: `这个存档 ${(text.length / 1e6).toFixed(2)}MB，超过单项目上限 ${(PROJ_MAX_CHARS / 1e6).toFixed(1)}MB——请先导出 .schem 落盘` };
  }
  const u = usage();
  const oldLen = (readRaw(PROJ_PREFIX + id) || '').length;
  if (u.chars - oldLen + text.length > TOTAL_MAX_CHARS) {
    lastError = 'quota:total';
    return { ok: false, why: `存档总占用将超过 ${(TOTAL_MAX_CHARS / 1e6).toFixed(1)}MB（浏览器给本站的上限）——请在项目列表里删掉不再需要的项目，或导出后删除` };
  }
  try {
    writeRaw(PROJ_PREFIX + id, text);
  } catch (e) {
    lastError = 'quota:' + ((e && e.name) || 'unknown');
    return { ok: false, why: '存储写满，保存失败：' + ((e && e.name) || e) + '（请导出 .schem 落盘，或删掉旧项目）' };
  }
  const idx = (internal && internal.idx) || readIndex();
  let entry = (internal && internal.entry) || idx.list.find(p => p.id === id);
  if (!entry) {
    entry = { id, name: (build && build.name) || '未命名', at: nowMs(), blocks: 0, bytes: 0 };
    idx.list.push(entry);
  }
  entry.at = nowMs();
  entry.blocks = (build && build.blocks && build.blocks.length) || 0;
  entry.bytes = text.length;
  idx.last = id;
  if (!internal) {
    try { writeIndex(idx); } catch (e) { lastError = 'index:' + (e && e.name); return { ok: false, why: '项目索引写不进去（存储可能已满）' }; }
  } else {
    internal.entry = entry; internal.idx = idx;
  }
  return { ok: true, bytes: text.length, blocks: entry.blocks };
}

/** 读项目正文 → build.json 形状。读不到/坏了都返回 null（调用方提示，不静默）。 */
export function load(id) {
  const raw = readRaw(PROJ_PREFIX + id);
  if (!raw) { lastError = 'missing'; return null; }
  try { lastError = null; return unpackBuild(raw); }
  catch (e) { lastError = 'corrupt:' + ((e && e.message) || e); return null; }
}

export function rename(id, name) {
  const idx = readIndex();
  const e = idx.list.find(p => p.id === id);
  if (!e) return { ok: false, why: '项目不存在' };
  e.name = String(name || '未命名').slice(0, 60);
  e.at = nowMs();
  try { writeIndex(idx); return { ok: true }; } catch (err) { return { ok: false, why: '索引写不进去' }; }
}

export function remove(id) {
  removeRaw(PROJ_PREFIX + id);
  const idx = readIndex();
  idx.list = idx.list.filter(p => p.id !== id);
  if (idx.last === id) idx.last = idx.list.length ? idx.list[0].id : '';
  try { writeIndex(idx); return { ok: true, last: idx.last }; } catch (e) { return { ok: false, why: '索引写不进去' }; }
}

export function setLast(id) {
  const idx = readIndex();
  idx.last = id;
  try { writeIndex(idx); return { ok: true }; } catch { return { ok: false }; }
}

/**
 * 迁移旧版单快照（`mc-preview:autosave`）成一个项目。
 * ★ 这条是"不丢数据"承诺的一部分：老用户第一次打开新版时，上一次会话必须还在。
 * 迁移成功后**删掉旧键**（避免下次再迁一遍变成重复项目）。
 */
export function migrateLegacy() {
  const raw = readRaw(OLD_SNAP_KEY);
  if (!raw) return { migrated: false };
  let snap = null;
  try { snap = JSON.parse(raw); } catch { removeRaw(OLD_SNAP_KEY); return { migrated: false, why: '旧存档解析失败' }; }
  if (!snap || !snap.build || !Array.isArray(snap.build.blocks)) { removeRaw(OLD_SNAP_KEY); return { migrated: false }; }
  const idx = readIndex();
  if (idx.list.length && idx.list.some(p => p.name === '上次会话')) { removeRaw(OLD_SNAP_KEY); return { migrated: false }; }
  const name = '上次会话' + (idx.list.length ? '（迁移）' : '');
  const r = create(name, snap.build);
  if (r.ok) removeRaw(OLD_SNAP_KEY);
  return { migrated: r.ok, id: r.id, blocks: snap.build.blocks.length, why: r.why };
}
