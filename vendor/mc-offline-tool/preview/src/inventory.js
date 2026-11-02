// inventory.js —— 物品栏面板：18,266 张 Java 提取图标 + 中文名，搜索 / 筛选 / 分页 / 收藏 / 最近。
//
// 数据源（都已在盘，不复制、不内联）：
//   ../app/data/items.json   { ids[], names[], block[], icons[], count }
//   ../app/data/icons/<ns>__<name>.png   48px 游戏原生截图
//
// 设计取舍：这里是 **DOM 网格**，不是 app/app.js 那套 canvas 复刻 GUI。
// 那套是"物品栏复刻"展品（像素级还原原版界面）；本页要的是能与 3D 视口联动的选择器，
// 所以复用它的**数据**与交互习惯（搜索/分页/最近/收藏），不用它的绘制。

import { $, isFeature, hostIcons, hostItems } from './host.js';
import { createPagedInventory } from './inventory-paged.js';
const PAGE = 48;                      // 8 × 6

// O4：图标懒加载 + 缓存。功能包模式下图标由后端按 id 返回 data URL（一页 48 张）。
// 不缓存的话，每次翻页/改搜索条件都会把已经看过的图标**重新请求一遍**（1.8 万张不可能一次拉全）。
// 缓存 key = 物品 id，value = data URL。跨多次挂载复用（模块只求值一次），设上限防无界增长。
const ICON_CACHE = new Map();
const ICON_CACHE_MAX = 2048;
const cacheIcon = (id, url) => {
  if (!id || !url) return;
  if (ICON_CACHE.size >= ICON_CACHE_MAX) ICON_CACHE.delete(ICON_CACHE.keys().next().value);
  ICON_CACHE.set(id, url);
};

const LS_FAV = 'preview.favorites';
const LS_REC = 'preview.recent';
const readLS = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
const writeLS = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set].slice(0, 500))); } catch { /* 隐私模式下写不了，忽略 */ } };

export async function createInventory({ onSelect }) {
  if (isFeature()) return createPagedInventory({onSelect});
  ICON_CACHE.clear(); // A new mount may use a different project, game version or capture.
  // 数据源两条路：功能包由后端给（包内**没有**静态 items.json）；独立网页 fetch 静态文件。
  // ★ 以前这里无条件 fetch('../app/data/items.json') ⇒ 在功能包里 404，物品栏整块空白（实测就是这个）。
  const hostList = await hostItems();
  const items = hostList
    ? {
        ids: hostList.map((x) => x.id),
        names: hostList.map((x) => x.name),
        icons: hostList.map((x) => x.icon),
        block: hostList.map((x) => x.block === true),
      }
    : await (await fetch('../app/data/items.json')).json();
  const { ids, names, icons, block } = items;
  const rows = ids.map((id, i) => ({
    i,
    id,
    name: names?.[i] || id,
    file: icons?.[i] || '',
    ns: id.slice(0, id.indexOf(':')),
    isBlock: block?.[i] === true,
    lower: `${names?.[i] || ''} ${id}`.toLowerCase(),
  }));

  const fav = readLS(LS_FAV);
  const rec = readLS(LS_REC);
  const el = {
    q: $('q'),
    ns: $('ns'),
    onlyBlock: $('onlyBlock'),
    tabs: $('tabs'),
    grid: $('grid'),
    foot: $('invFoot'),
    selLine: $('selLine'),
    count: $('invCount'),
  };

  // 命名空间下拉
  const nsList = [...new Set(rows.map(r => r.ns))].sort((a, b) => a === 'minecraft' ? -1 : b === 'minecraft' ? 1 : a.localeCompare(b));
  el.ns.innerHTML = `<option value="">全部来源 (${nsList.length})</option>` +
    nsList.map(ns => `<option value="${ns}">${ns} (${rows.filter(r => r.ns === ns).length})</option>`).join('');

  const state = { tab: 'all', q: '', ns: '', onlyBlock: false, page: 0, filtered: rows, selected: null };

  function refilter() {
    const q = state.q.trim().toLowerCase();
    let out = rows;
    if (state.tab === 'fav') out = out.filter(r => fav.has(r.id));
    else if (state.tab === 'recent') {
      const order = [...rec].reverse();          // Set 是"旧→新"插入序，倒过来才是 MRU（最近用的排最前）
      out = order.map(id => rows.find(r => r.id === id)).filter(Boolean);
    } else if (state.tab === 'block') out = out.filter(r => r.isBlock);
    else if (state.tab === 'mod') out = out.filter(r => r.ns !== 'minecraft');
    else if (state.tab === 'vanilla') out = out.filter(r => r.ns === 'minecraft');
    if (state.ns) out = out.filter(r => r.ns === state.ns);
    if (state.onlyBlock) out = out.filter(r => r.isBlock);
    if (q) out = out.filter(r => r.lower.includes(q));
    if (state.tab === 'recent' || state.tab === 'fav') out = out.slice(0, 200);   // 这两个页签不翻页，看最近 200 个
    state.filtered = out;
    state.page = 0;
  }

  /**
   * 功能包模式：本页图标由后端给 data URL（包内没有静态 icons 目录）。
   * 独立网页模式什么都不做 —— `<img src="../app/data/icons/<file>">` 直接就好。
   * O4：命中缓存的直接上屏、不发请求；只把"这一页里没见过的" id 批量问一次后端。
   */
  function applyIcon(id, url) {
    const esc = (window.CSS && window.CSS.escape) ? window.CSS.escape(id) : id;
    const img = el.grid.querySelector('.cell[data-id="' + esc + '"] img');
    if (!img) return;
    img.style.display = '';
    img.src = url;
    const fb = img.nextElementSibling;
    if (fb) fb.style.setProperty('display', 'none');
  }
  async function fillIcons(list) {
    if (!isFeature()) return;
    const miss = [];
    for (const r of list) {
      const url = ICON_CACHE.get(r.id);
      if (url) applyIcon(r.id, url);
      else miss.push(r.id);
    }
    if (!miss.length) return;                       // 整页都缓存过 ⇒ 零请求（O4 闸门断言点）
    try {
      const map = await hostIcons(miss);
      for (const [id, url] of Object.entries(map || {})) { cacheIcon(id, url); applyIcon(id, url); }
    } catch { /* 取不到图标就保留文字兜底 */ }
  }

  function paint() {
    const list = state.filtered;
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (state.page >= pages) state.page = pages - 1;
    if (el.count) el.count.textContent = `${list.length} 项`;
    const slice = list.slice(state.page * PAGE, state.page * PAGE + PAGE);
    el.grid.innerHTML = slice.map(r => {
      const fb = r.id.slice(r.id.indexOf(':') + 1).replaceAll('_', ' ');
      // ★ 功能包模式**不要**给 img 一个包内不存在的 src（`../app/data/icons/...` 在包里没有）
      //   —— 那会先打一堆 404（ERR_ABORTED），再等 data URL 到了才显示。这里先留空并隐藏，
      //   由 fillIcons() 把后端的 data URL 塞进来；在图上屏之前先用文字兜底。
      const img = isFeature()
        ? '<img loading="lazy" style="display:none" alt="" draggable="false">'
        : `<img loading="lazy" src="../app/data/icons/${r.file}" alt="" draggable="false">`;
      const fbStyle = isFeature() ? ' style="display:block"' : '';
      return `<div class="cell${state.selected === r.id ? ' sel' : ''}" data-id="${r.id}" title="${r.name}\n${r.id}${r.isBlock ? '' : '（非方块）'}">` +
        img + `<span class="fb"${fbStyle}>${fb}</span></div>`;
    }).join('') || '<div class="hint" style="grid-column:1/-1;padding:12px">没有匹配的物品</div>';
    // 图标缺失时退化成文字 —— 用 JS 绑，**不在 HTML 属性里拼引号**：
    // 之前那种 `onerror="…'+${JSON.stringify(name)}+'…"` 会吐出双引号、把属性提前截断，整格 HTML 都是坏的。
    el.grid.querySelectorAll('img').forEach(img => {
      img.onerror = () => { img.style.display = 'none'; img.nextElementSibling?.style.setProperty('display', 'block'); };
    });
    void fillIcons(slice);      // 功能包模式：把本页图标换成后端给的 data URL

    el.foot.innerHTML = `<button class="btn" id="pgPrev">‹</button>` +
      `<span>第 ${state.page + 1}/${pages} 页 · ${list.length} 项</span>` +
      `<button class="btn" id="pgNext">›</button>` +
      `<span style="flex:1"></span><button class="btn" id="favBtn" title="收藏/取消收藏当前方块">★</button>`;
    el.foot.querySelector('#pgPrev').onclick = () => { if (state.page > 0) { state.page--; paint(); } };
    el.foot.querySelector('#pgNext').onclick = () => { if ((state.page + 1) * PAGE < list.length) { state.page++; paint(); } };
    el.foot.querySelector('#favBtn').onclick = () => { if (state.selected) toggleFav(state.selected); };
  }

  /** 只更新"选中"这一个类，**不重建网格** —— 重建 innerHTML 会让 48 张图标重下重解，肉眼就是闪屏 */
  function markSelected() {
    el.grid.querySelectorAll('.cell.sel').forEach((n) => n.classList.remove('sel'));
    if (!state.selected) return;
    const esc = (window.CSS && window.CSS.escape) ? window.CSS.escape(state.selected) : state.selected.replace(/"/g, '\\"');
    const node = el.grid.querySelector('.cell[data-id="' + esc + '"]');
    if (node) node.classList.add('sel');
  }

  function select(id) {
    const r = rows.find(x => x.id === id);
    if (!r) return;
    state.selected = id;
    addRecent(id);                     // MRU：选中即更新「最近」，最近用的排最前
    el.selLine.innerHTML = `选中：<b>${r.name}</b> <span style="color:#6b7a8d">${r.id}${r.isBlock ? '' : ' · 非方块'}</span>`;
    markSelected();
    if (state.tab === 'recent') { refilter(); paint(); }   // 「最近」页签下选择会改变顺序，刷新列表
    onSelect?.(r);
  }
  function toggleFav(id) {
    if (fav.has(id)) fav.delete(id); else fav.add(id);
    writeLS(LS_FAV, fav);
    paint();
  }
  function addRecent(id) {
    rec.delete(id);
    rec.add(id);
    if (rec.size > 500) { const first = rec.values().next().value; rec.delete(first); }
    writeLS(LS_REC, rec);
  }

  // 页签
  const TABS = [['all', '全部'], ['block', '方块'], ['vanilla', '原版'], ['mod', '模组'], ['recent', '最近'], ['fav', '收藏']];
  el.tabs.innerHTML = TABS.map(([k, t]) => `<button class="btn${k === state.tab ? ' on' : ''}" data-tab="${k}">${t}</button>`).join('');
  el.tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
    state.tab = b.dataset.tab;
    el.tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    refilter(); paint();
  });

  // E3：中文输入法组合态（拼音候选期间）不能边打边过滤 —— 候选框开着列表就乱跳，还会吃掉用户点击。
  // compositionstart/end + isComposing 双判据：组合期间忽略 input，compositionend 后按最终文本过滤一次。
  let composing = false;
  el.q.addEventListener('compositionstart', () => { composing = true; });
  el.q.addEventListener('compositionend', () => { composing = false; state.q = el.q.value; refilter(); paint(); });
  el.q.oninput = () => { if (composing || el.q.isComposing) return; state.q = el.q.value; refilter(); paint(); };
  el.ns.onchange = () => { state.ns = el.ns.value; refilter(); paint(); };
  el.onlyBlock.onchange = () => { state.onlyBlock = el.onlyBlock.checked; refilter(); paint(); };

  // 事件委托：网格每次都会重建 innerHTML，绑在容器上才不会被重绘冲掉（比逐格 onclick 稳）
  const onGridClick = (ev) => {
    const cell = ev.target && ev.target.closest ? ev.target.closest('.cell') : null;
    if (cell && el.grid.contains(cell)) select(cell.dataset.id);
  };
  el.grid.addEventListener('click', onGridClick);

  refilter();
  paint();

  const byId = new Map(rows.map(r => [r.id, r]));
  return {
    select,
    addRecent,
    toggleFav,
    /** id → 中文名（材料清单用）；取不到就回 id */
    nameOf: (id) => byId.get(id)?.name || id,
    get selected() { return state.selected; },
    get selectedRow() { return rows.find(r => r.id === state.selected) || null; },
    get total() { return rows.length; },
    get isFavorite() { return (id) => fav.has(id); },
    /** 卸载清理：摘掉网格的委托监听（节点虽随 shadow root 一起丢，但登记一下让"净增长=0"可验证） */
    dispose: () => { try { el.grid.removeEventListener('click', onGridClick); } catch { /* 尽力而为 */ } },
  };
}
