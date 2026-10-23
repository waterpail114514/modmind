// 物品栏与图标变换的断言入口。纯 node 运行，不需要浏览器：
//   node src/test-inventory.mjs
// 变异测试改走 src/mutate-inventory.mjs（进程内加载副本，不 spawn）。

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAssertions } from './inventory-assertions.mjs';

const SRC = path.resolve(import.meta.dirname, '..', 'viewer', 'src');
const DIR = path.resolve(process.env.MOD_DIR ?? SRC);
const load = (f) => import(pathToFileURL(path.join(DIR, f)).href);

const M = await load('inventory-model.js');
const T = await load('item-transform.js');
const results = runAssertions(M, T);

const pass = results.filter((r) => r[0] === 'PASS').length;
const fail = results.length - pass;
for (const [st, name, msg] of results) console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}\n    ${msg}`);
console.log(`\n断言 ${results.length} 条：通过 ${pass}，失败 ${fail}`
  + (process.env.MOD_DIR ? ` [副本: ${path.basename(DIR)}]` : ''));
process.exit(fail > 0 ? 1 : 0);
