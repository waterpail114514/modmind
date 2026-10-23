// 变异测试：逐个把实现改坏，确认断言真的会 FAIL。只改实现、不改断言。
// 任何变异若仍然 PASS，说明对应断言没有检测力。
//
//   node src/mutate-inventory.mjs
//
// 两条硬约束（都踩过坑）：
//   1. 每个变异写进**独立目录**，并靠查询串破 ESM 缓存 —— ESM 按解析后的路径缓存，
//      多变异共用同一文件名会导致只有第一个真被加载。
//   2. 不 spawn 子进程：本环境 spawnSync 会 EBUSY，因此在进程内 import 变异副本。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAssertions } from './inventory-assertions.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'viewer', 'src');
const MUT = path.join(ROOT, '.work', 'mut');
const FILES = ['item-transform.js', 'inventory-model.js', 'inventory-view.js', 'icon-renderer.js', 'platform-bridge.js'];

const MUTATIONS = [
  { id: 'M1-旋转顺序改成既有 RyRx 写法', file: 'item-transform.js',
    from: "return order === 'vanilla' ? m4mul(X, m4mul(Y, Z)) : m4mul(Y, m4mul(X, Z));",
    to:   "return order === 'vanilla' ? m4mul(Y, m4mul(X, Z)) : m4mul(Y, m4mul(X, Z));" },

  { id: 'M2-原版缩放 0.625 改成 1.0', file: 'item-transform.js',
    from: 'scale: 0.625,', to: 'scale: 1.0,' },

  { id: 'M3-快捷栏循环改成不循环', file: 'inventory-model.js',
    from: 'const next = ((this.selected + delta) % n + n) % n;', to: 'const next = this.selected + delta;' },

  { id: 'M4-合并时不按剩余容量截断', file: 'inventory-model.js',
    from: 'const put = Math.min(room, s.count);', to: 'const put = s.count;' },

  { id: 'M5-判同 id 改成恒真（异种也被当同种合并）', file: 'inventory-model.js',
    from: 'if (d.id === s.id) {', to: 'if (d.id === d.id) {' },

  { id: 'M6-拿一半改成向下取整', file: 'inventory-model.js',
    from: 'const take = Math.ceil(s.count / 2);', to: 'const take = Math.floor(s.count / 2);' },

  { id: 'M7-set 不再夹紧到上限', file: 'inventory-model.js',
    from: 'const count = Math.max(1, Math.min(max, stack.count ?? 1));', to: 'const count = Math.max(1, stack.count ?? 1);' },

  { id: 'M8-add 跳过填已有堆叠', file: 'inventory-model.js',
    from: 'if (!s || s.id !== id) continue;', to: 'if (true) continue;' },

  { id: 'M9-反序列化丢弃选中索引', file: 'inventory-model.js',
    from: 'inv.selected = isHotbarIndex(data?.selected) ? data.selected : 0;', to: 'inv.selected = 0;' },

  { id: 'M10-select 不再发 select 事件', file: 'inventory-model.js',
    from: "this.emit('select', { index: i, stack: this.slots[i] });", to: '/* mutated */;' },

  { id: 'M11-shadeFactor 默认值改成 face（GUI 图标被画暗）', file: 'item-transform.js',
    from: "export function shadeFactor(face, mode = 'none') {", to: "export function shadeFactor(face, mode = 'face') {" },

  { id: 'M12-shadeFactor 把 none 也画暗', file: 'item-transform.js',
    from: 'if (mode !== \'face\') return 1;', to: 'if (mode !== \'face\') return FACE_SHADE[face] ?? 1;' },

  { id: 'M13-图标画布不再吸附整数设备像素（dpr≠1 时纹素宽度不均）', file: 'item-transform.js',
    from: 'const k = Math.max(1, Math.round(s * d));', to: 'const k = Math.max(1, s * d);' },

  { id: 'M14-恢复 Y 翻转（图标上下颠倒，草方块绿顶跑到下面）', file: 'item-transform.js',
    from: '  flipY: false,', to: '  flipY: true,' },
];

const loadPair = async (dir, tag) => {
  const u = (f) => pathToFileURL(path.join(dir, f)).href + '?mut=' + encodeURIComponent(tag);
  return [await import(u('inventory-model.js')), await import(u('item-transform.js'))];
};

fs.rmSync(MUT, { recursive: true, force: true });
fs.mkdirSync(MUT, { recursive: true });

// --- 0. 对照：不改动时必须全 PASS -------------------------------------------
{
  const [M, T] = await loadPair(SRC, 'control');
  const r = runAssertions(M, T);
  const fail = r.filter((x) => x[0] === 'FAIL').length;
  console.log(`对照（未变异）：${r.length} 条，失败 ${fail} —— ${fail === 0 ? 'PASS（符合预期）' : 'FAIL：断言本身有问题，先修断言'}`);
  if (fail !== 0) { for (const x of r) if (x[0] === 'FAIL') console.log('  ✗ ' + x[1] + ' :: ' + x[2]); process.exit(2); }
}

// --- 1..N. 每个变异必须 FAIL ------------------------------------------------
let killed = 0;
const survived = [];
for (const m of MUTATIONS) {
  const dir = path.join(MUT, m.id.replace(/[^A-Za-z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));

  const p = path.join(dir, m.file);
  const src = fs.readFileSync(p, 'utf-8');
  const hits = src.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`✗ ${m.id}：锚点命中 ${hits} 次（要求恰好 1 次），变异脚本失效`);
    survived.push(m.id + '(锚点不唯一)');
    fs.rmSync(dir, { recursive: true, force: true });
    continue;
  }
  fs.writeFileSync(p, src.replace(m.from, m.to), 'utf-8');

  let fail = -1, names = [];
  try {
    const [M, T] = await loadPair(dir, m.id);
    const r = runAssertions(M, T);
    names = r.filter((x) => x[0] === 'FAIL').map((x) => x[1]);
    fail = names.length;
  } catch (e) {
    names = ['加载即抛异常: ' + e.message];
    fail = 99;
  }
  if (fail > 0) killed++; else survived.push(m.id);
  console.log(`${fail > 0 ? '✓' : '✗'} ${m.id} → ${fail > 0 ? `被杀死（${fail} 条 FAIL）` : '存活 = 断言无效'}`
    + (names.length ? `\n    首条失败断言: ${names[0]}` : ''));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n变异 ${MUTATIONS.length} 个：杀死 ${killed}，存活 ${survived.length}`);
fs.rmSync(MUT, { recursive: true, force: true });
if (survived.length) { console.log('存活：' + survived.join('、')); process.exit(1); }
