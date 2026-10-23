// build-icons.mjs —— 把拉取到的「整页截图」切成「逐个物品的图标」
//
// 输入：pull2/index.json（布局参数 + 物品顺序 + 采集期质量清单）、pull2/page-*-bg*-*.png
//       （同一页在 4 个纯色背景下的渲染）、pull2/items-meta.json（游戏内显示名等）
// 输出：<out>/icons/*.png（默认 48x48 RGBA，真 alpha）+ <out>/items.json
//
// 核心：对同一像素在 4 个背景 B 下的观测 O 做一元回归 O = a + slope*B
//       => alpha = 1 - slope，C = a / alpha。四个背景真正不同时该解是精确的，
//       所以拿到的 alpha 不是键控近似，而是从观测反解出来的真值；残差可自检。
//
// ★ 关于输出分辨率（D024 的关键修正）：
//   上一版把图标降采样成 16x16（= 纹素数），理由是「纹素网格与设备像素严格对齐」。
//   这个理由对**平面贴图**成立，对**渲染出来的 3D 模型图标**是错的：
//   游戏在 GUI 缩放 3 下是把模型**直接光栅化到 48 设备像素**上，立方体的轮廓边、
//   以及贴图放大后的采样边界都带有 48 分辨率的细节。压到 16x16 会把这些细节整体丢掉，
//   上屏时再放大 3 倍就显得毛糙——这正是用户说的「不够清晰」。
//   所以：**采集分辨率是多少就输出多少**（iconScale=1 ⇒ 48x48 = 游戏自己那一版），
//   前端按 1:1 绘制，不做任何缩放。
//
// 用法（CLI）：
//   node build-icons.mjs --pull2 <pull2目录> --out <app/data> [--outPx 48] [--report <路径>] [--maxPages N]
// 用法（模块）：
//   import { buildIcons } from './build-icons.mjs'
//   const report = buildIcons({ pull2, outDir, outPx, maxPages, log })

import fs from 'node:fs'
import { tryNormalizeAssetId } from './asset-id.mjs';
import path from 'node:path';
import { decode, encodeRGBA } from './png.mjs';

const BG_NAMES = ['magenta', 'black', 'gray', 'white'];

/**
 * 残差阈值（审核员 P3-2）：解出的 (alpha, C) 回算 4 个背景观测，逐像素残差应当接近 0。
 * 残差大 = 该像素的 alpha 解不可信（4 个背景不足以定解，或页图本身有问题）。
 * 这条以前只是**打印** worst，没有判据 ⇒ 超差清单要能进 report、UI 要能报警。
 */
const RESIDUAL_MAX = 16;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

/**
 * 从 Pull.java 的 pull2 产物切出图标 + items.json。
 * ★ onPage（2026-10-11，mc-pull 分批进度）：每切完一页调用一次（**await**），参数 (page, totalPages, items)。
 *   调用方借此写出"第 N/M 页"进度、并在两页之间检查取消标记 —— 因为这里是 `await`，
 *   事件循环得以喘息，长任务期间前端轮询/取消请求才可能被送达（D-import-progress）。
 * @param {{pull2:string, outDir:string, outPx?:number, maxPages?:number, report?:string, log?:(m:string)=>void,
 *          onPage?:(page:number,totalPages:number,items:number)=>void|Promise<void>}} opts
 * @returns {Promise<object>} report
 */
export async function buildIcons(opts) {
  const log = opts.log || (() => {});
  const onPage = typeof opts.onPage === 'function' ? opts.onPage : null;
  const pull2 = path.resolve(opts.pull2);
  const outDir = path.resolve(opts.outDir);
  const reportPath = opts.report ? path.resolve(opts.report) : null;

  const index = JSON.parse(fs.readFileSync(path.join(pull2, 'index.json'), 'utf8'));
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(pull2, 'items-meta.json'), 'utf8'));
  } catch {
    meta = null;
  }

  const { cols, perPage, pages, padGui, cellGui, iconGui, iconDev, guiScale, bgCount } = index;
  const iconPx = iconGui / index.iconScale;          // 图标本体的纹素数（姿态缩放前），应为 16
  const pxPerTexel = iconDev / iconPx;               // 每个纹素占多少设备像素
  const padDev = padGui * guiScale;
  const cellDev = cellGui * guiScale;

  // 输出分辨率：默认就是采集时的设备分辨率（不降采样）
  const outPx = Math.max(1, opts.outPx ? Number(opts.outPx) : iconDev);
  const downBlock = iconDev / outPx;                 // 若 <1 表示要放大，不允许
  if (outPx > iconDev) {
    throw new Error(`outPx(${outPx}) 大于采集分辨率(${iconDev})，放大没有意义，拒绝`);
  }
  const downInt = Number.isInteger(downBlock);

  // 只处理前 N 页（快速重跑用；产出的是自洽的部分集，不是残缺集）
  const limitPages = opts.maxPages ? Math.min(pages, Math.max(1, Number(opts.maxPages))) : pages;
  const ids = index.items.slice(0, limitPages * perPage);

  // ★ 两段式写入：先写**临时目录**，全部写完并校验张数后，再**整体替换** icons/。
  //   旧写法是 `fs.rmSync(icons)` 然后逐张写 —— 删和写之间没有事务：中途失败 / 被取消 / 磁盘满
  //   ⇒ 旧图标库已经被清空、新的只写了一半（**数据全无**，且用户看不出来）。
  //   现在最坏情况只是"新库没换上去"，旧库完好。注意 outDir 下还有 font/、game/（由 build-app-assets.mjs 产出），
  //   本函数一律不动它们。
  const iconsDir = path.join(outDir, 'icons');
  const stamp = `${Date.now()}-${process.pid}`;
  const nextDir = path.join(outDir, `icons.next-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  // 自清历史残留（必须在建自己的 nextDir **之前**，否则会把自己删掉）：
  // 上次中途失败可能留下 icons.next-* / icons.old-*
  for (const n of fs.readdirSync(outDir)) {
    if (/^icons\.(next|old)-/.test(n)) { try { fs.rmSync(path.join(outDir, n), { recursive: true, force: true }); } catch { /* 占着就下次再清 */ } }
  }
  fs.mkdirSync(nextDir, { recursive: true });
  const pageFile = (p, b) => path.join(pull2, `page-${String(p).padStart(3, '0')}-bg${b}-${BG_NAMES[b]}.png`);
  // ★ 预检：这一批要用到的页图必须**全在**。缺页要在动手写之前就报错 ——
  //   否则会写到一半才抛，留下一个半成品目录（比"没导入"更难查）。
  for (let p = 0; p < limitPages; p++) {
    for (let b = 0; b < bgCount; b++) {
      if (!fs.existsSync(pageFile(p, b))) {
        fs.rmSync(nextDir, { recursive: true, force: true });
        throw new Error(`缺少页图，整批放弃（旧图标库未改动）：${pageFile(p, b)}`);
      }
    }
  }

  function sanitize(id) {
    return id.replace(/:/g, '__').replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  const icons = new Array(ids.length);
  const emptyIdx = [];
  let worstResidual = 0;
  let worstItem = '';
  let residualSum = 0;
  let residualCount = 0;
  // 超差清单（P3-2）：worst 只是"最差的那一个"，真正要排查得知道**有哪些**超了阈值
  const overResidual = [];
  let overCount = 0;

  // 先按采集分辨率解出真 alpha，必要时再整体降采样
  const full = Buffer.alloc(iconDev * iconDev * 4);
  const outBuf = Buffer.alloc(outPx * outPx * 4);

  function downsample(src, srcN, dst, dstN, block) {
    const b = Math.max(1, Math.round(block));
    for (let y = 0; y < dstN; y++) {
      for (let x = 0; x < dstN; x++) {
        let r = 0, g = 0, bl = 0, a = 0, n = 0;
        for (let dy = 0; dy < b; dy++) {
          for (let dx = 0; dx < b; dx++) {
            const sx = x * b + dx, sy = y * b + dy;
            if (sx >= srcN || sy >= srcN) continue;
            const o = (sy * srcN + sx) * 4;
            const al = src[o + 3] / 255;
            r += src[o] * al; g += src[o + 1] * al; bl += src[o + 2] * al; a += al; n++;
          }
        }
        const d = (y * dstN + x) * 4;
        if (n === 0 || a === 0) { dst[d] = dst[d + 1] = dst[d + 2] = dst[d + 3] = 0; continue; }
        dst[d] = Math.round(r / a);
        dst[d + 1] = Math.round(g / a);
        dst[d + 2] = Math.round(bl / a);
        dst[d + 3] = Math.round((a / n) * 255);
      }
    }
  }

  for (let p = 0; p < limitPages; p++) {
    const bgs = [];
    for (let b = 0; b < bgCount; b++) {
      const f = pageFile(p, b);
      bgs.push(decode(fs.readFileSync(f)));
    }
    const bgRgb = index.backgroundsRgb;

    const base = p * perPage;
    for (let k = 0; k < perPage; k++) {
      const i = base + k;
      if (i >= ids.length) break;
      const col = k % cols;
      const row = (k / cols) | 0;
      const x0 = padDev + col * cellDev;
      const y0 = padDev + row * cellDev;

      let itemWorst = 0;                       // 本图标的最差残差（P3-2 按图标记账）
      for (let ty = 0; ty < iconDev; ty++) {
        for (let tx = 0; tx < iconDev; tx++) {
          const sx = x0 + tx, sy = y0 + ty;
          const B = [0, 0, 0], O = [0, 0, 0];
          for (let b = 0; b < bgCount; b++) {
            const o = bgs[b].data, off = (sy * bgs[b].width + sx) * 4;
            B[b * 3] = bgRgb[b] >> 16 & 0xff;
            B[b * 3 + 1] = bgRgb[b] >> 8 & 0xff;
            B[b * 3 + 2] = bgRgb[b] & 0xff;
            O[b * 3] = o[off];
            O[b * 3 + 1] = o[off + 1];
            O[b * 3 + 2] = o[off + 2];
          }
          let aSum = 0, aCnt = 0;
          const ccol = [0, 0, 0];
          for (let ch = 0; ch < 3; ch++) {
            let sB = 0, sO = 0, sBB = 0, sBO = 0;
            for (let b = 0; b < bgCount; b++) {
              const Bv = B[b * 3 + ch], Ov = O[b * 3 + ch];
              sB += Bv; sO += Ov; sBB += Bv * Bv; sBO += Bv * Ov;
            }
            const n = bgCount;
            const den = n * sBB - sB * sB;
            if (den === 0) { ccol[ch] = O[ch]; continue; }
            const slope = (n * sBO - sB * sO) / den;
            const inter = (sO - slope * sB) / n;
            const alpha = 1 - slope;
            aSum += alpha; aCnt++;
            ccol[ch] = alpha > 1e-4 ? inter / alpha : 0;
          }
          let alpha = aCnt ? aSum / aCnt : 1;
          if (alpha > 0.998) alpha = 1;
          if (alpha < 0.002) alpha = 0;
          const d = (ty * iconDev + tx) * 4;
          full[d] = Math.max(0, Math.min(255, Math.round(ccol[0])));
          full[d + 1] = Math.max(0, Math.min(255, Math.round(ccol[1])));
          full[d + 2] = Math.max(0, Math.min(255, Math.round(ccol[2])));
          full[d + 3] = Math.round(alpha * 255);

          // 自检：用解出的 (alpha, C) 回算 4 个观测，残差应当接近 0
          let res = 0;
          for (let b = 0; b < bgCount; b++) {
            for (let ch = 0; ch < 3; ch++) {
              const pred = ccol[ch] * alpha + B[b * 3 + ch] * (1 - alpha);
              res = Math.max(res, Math.abs(pred - O[b * 3 + ch]));
            }
          }
          residualSum += res;
          residualCount++;
          if (res > itemWorst) itemWorst = res;
          if (res > worstResidual) { worstResidual = res; worstItem = ids[i]; }
        }
      }
      if (itemWorst > RESIDUAL_MAX) {
        overCount++;
        if (overResidual.length < 20) overResidual.push({ id: ids[i], worst: Number(itemWorst.toFixed(2)) });
      }

      let payload;
      if (outPx === iconDev) payload = Buffer.from(full);
      else if (downInt) { downsample(full, iconDev, outBuf, outPx, downBlock); payload = Buffer.from(outBuf); }
      else {
        // 非整数倍：取每个输出像素中心对应的源像素（最近邻），避免引入插值模糊
        for (let y = 0; y < outPx; y++) for (let x = 0; x < outPx; x++) {
          const sx = Math.min(iconDev - 1, Math.floor((x + 0.5) * downBlock));
          const sy = Math.min(iconDev - 1, Math.floor((y + 0.5) * downBlock));
          const s = (sy * iconDev + sx) * 4, d = (y * outPx + x) * 4;
          outBuf[d] = full[s]; outBuf[d + 1] = full[s + 1]; outBuf[d + 2] = full[s + 2]; outBuf[d + 3] = full[s + 3];
        }
        payload = Buffer.from(outBuf);
      }

      icons[i] = sanitize(ids[i]) + '.png';
      fs.writeFileSync(path.join(nextDir, icons[i]), encodeRGBA(outPx, outPx, payload));
      if (index.qc && index.qc[i] && index.qc[i][0] === 0) emptyIdx.push(i);
    }
    if (onPage) await onPage(p + 1, limitPages, Math.min((p + 1) * perPage, ids.length));
    if ((p + 1) % 8 === 0 || p === limitPages - 1) log(`  页 ${p + 1}/${limitPages}`);
  }

  // ---- 校验 + 原子替换 ----
  const written = fs.readdirSync(nextDir).length;
  if (written !== ids.length) {
    fs.rmSync(nextDir, { recursive: true, force: true });
    throw new Error(`切图张数不符：写出 ${written} 张，预期 ${ids.length} 张 —— 已放弃，旧图标库未改动`);
  }
  const oldDir = path.join(outDir, `icons.old-${stamp}`);
  const hadOld = fs.existsSync(iconsDir);
  if (hadOld) fs.renameSync(iconsDir, oldDir);          // 先让开名字（Windows 下 rename 到已存在目录会失败）
  try {
    fs.renameSync(nextDir, iconsDir);
  } catch (e) {
    if (hadOld && !fs.existsSync(iconsDir)) fs.renameSync(oldDir, iconsDir);   // 回滚，旧库照旧
    throw e;
  }
  if (hadOld) { try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* 删不掉就留着，不影响正确性 */ } }
  log(`  图标库已整体替换：${written} 张（旧库${hadOld ? '已备份后删除' : '原本不存在'}）`);

  // ★★ 2026-10-12 B10：先算"这份产物的属性字段到底是什么意思"（理由见下方 items 载荷里的长注释）。
  //   判据 = 产物自述 `attrSemantics`：修好的探针（1.1.0+）才写它。
  const sem = (meta && meta.attrSemantics) || null
  const semOk = !!(sem && sem.maxStack === 'max-stack-size' && sem.damageable === 'damageable-item')

  // ★ 2026-10-13 T3 第①步（设计稿 §1 / §2）：给产物一个**可校验的身份**。
  //   · `schemaVersion` = **数据契约**版本（读方不认识就必须报错，不许"尽力解析"）；
  //   · `schema` = 历史字段（icons 布局版本）—— ★ 全仓 grep 实测**只有这一处写入、无人读取**，
  //     保留纯粹为了兼容旧消费者，**不要再往它上面加含义**；
  //   · `assetIds` = 与 `ids` **同长同序**的规范身份（见下方生成处）。
  const items = {
    schemaVersion: 1,
    schema: 2,
    source: 'modmind pull (Pull.java)',
    iconPx: outPx,
    capturePx: iconDev,
    pxPerTexel,
    guiScale,
    count: ids.length,
    ids,
    // ★ 由 src/asset-id.mjs **生成**（不是抄 ids）：属性按字母序归一、非法即抛。
    //   实测今天 18,284 条**全部合规、归一化后 0 条变化** ⇒ 与 ids 内容相同是**预期**的
    //   （当前 id 都是纯 `ns:path`，还没有带状态的方块）；价值在于将来出现 `[facing=east,…]`
    //   时归一化已在位，且跨表能用同一套身份替代"按下标对齐"。
    //   失败数**必须报出来**（§0.6）：有不合规就抛错并给样例，不许静默留空。
    assetIds: (() => {
      const out = []
      const bad = []
      for (const id of ids) {
        const a = tryNormalizeAssetId(id)
        if (a === null) bad.push(id)
        out.push(a)
      }
      if (bad.length) {
        throw new Error('有 ' + bad.length + ' 条 id 不合规，无法生成 assetIds（样例：'
          + bad.slice(0, 5).join('、') + '）—— 见 src/asset-id.mjs 的规则')
      }
      return out
    })(),
    names: meta ? meta.names.slice(0, ids.length) : ids,
    // ★ 2026-10-12 B1（规范 §0.6「失败必须可见」）：没有 meta ⇒ 属性**未知**，写 null。
    //   原来写的是 64 / false —— 那是**把"未知"冒充成"已知"**（§5.4 明令禁止无上下文的兼容布尔值）。
    //   null 是**显式的未知**：下游 `x || 64` 仍得 64（行为不变），但产物本身不再声称 64 是事实。
    maxStack: meta ? meta.maxStack.slice(0, ids.length) : ids.map(() => null),
    block: meta ? meta.block.slice(0, ids.length) : ids.map(() => false),
    damageable: meta ? meta.damageable.slice(0, ids.length) : ids.map(() => null),
    icons,
    emptyForQc: emptyIdx,
    // ★★ 2026-10-12 实测缺陷（B10）：探针把两个字段**取错了 API** —— 两版探针都有：
    //     fabric 1.21：`maxStack.add(st.getMaxDamage())` / `damageable.add(st.isFramed())`
    //     forge 1.20.1：`maxStack.add(st.m_41776_())` / `damageable.add(st.m_41794_())`
    //     （★ 2026-10-12 更正：早先这里误标成 1.16.5。forge 探针源其实一直是 1.20.1 —— 见 probe/build-probe-forge.py）
    //     （同项目移植记录已注明 `m_41794_ = isFramed（非 isDamageableItem）`）
    //   ⇒ 探针产物的 `maxStack` **实为「最大耐久」**、`damageable` **实为「是否在展示框里」**。
    //   实测印证（.work/probe-01 的 items-meta.json，18266 条）：石头 maxStack=0（非耐久物品本应为 64）、
    //   部分 mod 物品 1561 / 2031（巨耐久）、damageable 全为 false（没有物品"在展示框里"）。
    //   这两个数组**不能当作「堆叠上限 / 可损坏」使用**。
    //   ★ 2026-10-12 已根治（探针 1.1.0）：两版探针都改成了正确的方法
    //     （SRG 名由 probe/srg-lookup.py 两跳查出；字节码差分见 probe/verify-probe-jars.py，10/10 通过）。
    //   **但消费端不能因此写死 'probe'**：`pull_import_probe` 处理的是**磁盘上已存在的产物**，
    //   用户机器上很可能还留着旧探针（≤1.0.0）产的 items-meta.json —— 写死就会把它们**谎报为可信**。
    //   所以判据取自**产物自述** `attrSemantics`（1.1.0+ 才写它），见下面 semOk 三态。
    //   另：mismapped 时把真值以**正确字段名**另存（maxDamage / framed）—— 原始信息不丢。
    attrProvenance: meta ? (semOk ? 'probe' : 'probe-mismapped') : 'unknown',
    maxDamage: (meta && !semOk && meta.maxStack) ? meta.maxStack.slice(0, ids.length) : ids.map(() => null),
    framed: (meta && !semOk && meta.damageable) ? meta.damageable.slice(0, ids.length) : ids.map(() => null),
    // 自述原文照抄进产物（事后可追：这份包是哪个探针版本产的）
    attrSemantics: sem || null,
    attrWarnings: (meta && !semOk) ? [
      'maxStack 实为「最大耐久」(getMaxDamage)，不是堆叠上限 ⇒ 不可用于堆叠判定',
      'damageable 实为「是否在展示框里」(isFramed)，不是「可损坏」⇒ 不可用于耐久判定',
      '该产物来自 1.0.0 及更早的探针；装入 1.1.0+ 探针并启动一次游戏即得真值',
    ] : [],
  };
  fs.writeFileSync(path.join(outDir, 'items.json'), JSON.stringify(items));
  fs.writeFileSync(path.join(outDir, 'items.js'), 'window.MC_ITEMS = ' + JSON.stringify(items) + ';\n');

  const report = {
    pull2, outDir, count: ids.length, pages: limitPages, totalPages: pages, written,
    partial: limitPages < pages,
    iconPx: outPx, capturePx: iconDev, pxPerTexel,
    badFrameCount: index.badFrameCount ?? null,
    emptyFromQc: emptyIdx.length,
    residual: {
      mean: residualCount ? residualSum / residualCount : null,
      worst: worstResidual, worstItem,
      threshold: RESIDUAL_MAX,
      ok: worstResidual <= RESIDUAL_MAX,     // P3-2：有判据，不是只打印
      overCount, over: overResidual,          // 超差清单（最多 20 条）
    },
    lagHistogram: index.lagHistogram ?? null,
  };
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

// CLI 入口判定：用 basename 比较，而不是 `import.meta.url`（本文件会被 esbuild 打进 CJS 功能包，
// 那里 import.meta 是空的，会在加载时抛 ERR_INVALID_ARG_TYPE）。
const isMain = /(^|[\\/])build-icons\.mjs$/.test(process.argv[1] || '');
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  // buildIcons 现在是 async（为了分批进度/取消）⇒ CLI 用 async IIFE 接住（bundle 成 CJS 时不能有顶层 await）
  ;(async () => {
    const report = await buildIcons({
      pull2: args.pull2 || '.',
      outDir: args.out || 'app/data',
      outPx: args.outPx,
      maxPages: args.maxPages,
      report: args.report,
      log: (m) => console.log(m),
    });
    console.log(JSON.stringify(report, null, 2));
  })();
}
