// registry.js —— 浏览器侧读「方块注册表默认态」侧车文件（`data/registry-defaults.json`，id → 默认态属性）。
//
// 为什么要注册表：裸名 = 默认态，而默认态只在**方块注册表**里。没有它就只能按 MC 惯例近似推
// （`src/defaults.js`），罕见方块会推错。侧车文件是从 42 MiB 的 `vanilla-registry.json`
// （含 mod，实测 4,182 个方块有默认态、其中 3,540 个是 mod 方块）抽出来的，只有 ~319 KB。
//
// 只在「预打包回落」路径上需要它（按需打包时默认态由服务端算好随 `/api/scene` 回传）。
// ★ 功能包里**没有静态侧车文件**，直接返回 {} —— 默认态走 `state.sceneDefaults`（scene action 回传的）。
import { isFeature } from './host.js';

let cache = null;
let pending = null;

export async function loadRegistryDefaults(url = 'data/registry-defaults.json') {
  if (isFeature()) return {};
  if (cache) return cache;
  if (!pending) {
    pending = fetch(url)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((j) => (cache = j && typeof j === 'object' ? j : {}));
  }
  return pending;
}
