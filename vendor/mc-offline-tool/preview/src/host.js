// host.js —— 「宿主适配层」：同一套前端代码，既能跑独立网页（HTTP `/api/*`），也能跑 ModMind 功能包。
//
// 为什么要这一层：功能包里**没有静态服务器**，取数据要走宿主 preload：
//   `window.modmind.featurePlugins.invoke('<featureId>', '<action.id（带冒号）>', input)`
// 而独立网页走 `fetch('/api/scene')` 等。差别只在这四处：场景资源、读建筑、写建筑、DOM 根。
// 于是把它们抽成一个可替换的 host 对象 —— 功能包入口启动前 `setHost(...)` 一次即可。
let HOST = null;
let ROOT = null;                 // 功能包用 Shadow DOM 挂载；独立网页为 null（= document）

/** 功能包入口调用：注入宿主适配器与 DOM 根 */
export function setHost(next) { HOST = next || null; }
export function setRoot(el) { ROOT = el || null; }
/** DOM 查找一律走这里（Shadow DOM 里 `document.getElementById` 找不到我们的元素） */
export const $ = (id) => (ROOT || document).getElementById(id);
export const $$ = (sel) => (ROOT || document).querySelector(sel);
export const rootNode = () => ROOT || document;

/** 是不是功能包模式 */
export const isFeature = () => !!(HOST && HOST.kind === 'feature');

/** 图标：功能包模式由后端按 id 返回 data URL（包内取不到 1.8 万张静态图）；独立网页返回 null（直接用文件路径） */
export async function hostIcons(ids) {
  if (isFeature()) return HOST.icons(ids);
  return null;
}

/**
 * 物品表：功能包模式由后端给（**包内没有静态 `app/data/items.json`**）；
 * 独立网页返回 null，调用方自己去 fetch 那个静态文件。
 * ★ 这条和场景资源一样是"包内没有静态文件"的硬约束 —— 漏了就会静默失败（物品栏空白）。
 */
export async function hostItems() {
  if (isFeature()) return HOST.items();
  return null;
}

/** 取场景资源（按需打包） */
export async function hostScene(states) {
  if (isFeature()) return HOST.scene(states);
  const { loadSceneAssets } = await import('./scene.js');
  return loadSceneAssets(states);
}
/** 读一个建筑文件（功能包模式返回 base64 内容） */
export async function hostImport(name, bytes) {
  if (isFeature()) return HOST.importBuild(name, bytes);
  const { importBuilding } = await import('./io.js');
  return importBuilding(new File([bytes], name));
}
/** 导出建筑（功能包模式返回 { filename, dataBase64, materials }） */
export async function hostExport(build, format) {
  if (isFeature()) return HOST.exportBuild(build, format);
  const { exportBuilding } = await import('./io.js');
  return exportBuilding(build, format);
}
/**
 * 初始建筑：功能包模式由后端给（包内**没有静态文件**可 fetch）；独立网页模式返回 null，调用方走 fetchBuild。
 *
 * ★ 这里必须做成函数，不能让 main.js 直接摸 `HOST` —— `HOST` 是本模块的私有变量，
 *   `main.js` 里写 `isFeature() ? HOST.initialBuild() : …` 会在功能包模式抛
 *   `ReferenceError: HOST is not defined`（独立网页模式因为短路求值永远走不到，所以自测测不出来）。
 */
export async function hostInitialBuild() {
  if (isFeature()) return HOST.initialBuild();
  return null;
}
