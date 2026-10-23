// backend/main.js —— 「游戏数据采集」功能包后端（构建成 `main.cjs`）。
//
// 采集口径（都在 Node 里做，不依赖 Java —— 本机没有 java/javac）：
//   · **方块**：来自 42 MiB 的注册表（`vanilla-registry.json`，实测 9,374 条、含 mod）⇒ id / 是否方块 / 默认态；
//   · **物品**：注册表里没有物品表，改为**合并实例里所有 `assets/*/lang/zh_cn.json`** 的 `item.*` / `block.*` 键
//     （mod 一般都会带自己的语言文件）⇒ 拿到 id 与**中文名**；若数据目录里已有更全的 `items.json`，以它为底再补；
//   · **图标**：从实例贴图里烤 —— `item/<name>.png` → `block/<name>.png` → `block/<name>_top.png`，
//     按 `pxPerTexel=3` 最近邻放大到 48px，扁平命名 `<ns>__<name>.png`（与既有产物同约定）。
//     ⚠ 运行期染色的物品（如 GT 的 material_sets × 材料色）在 Node 里拿不到，那些图标会退化成基础贴图；
//       要 100% 保真得靠「装探针 → 启动游戏 → 游戏内渲染导出」（`pull_install_probe` 提供了这一步）。
//
// 路径都可用环境变量覆盖：PREVIEW_MC / PREVIEW_INSTANCE / PREVIEW_DATA / PREVIEW_REGISTRY
//                         / PREVIEW_PROBE_JAR（直接指定探针 jar）/ PREVIEW_PROBE_DIR（给它一个目录去挑）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { packKey, projectDataPath } from '../../src/project-data.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { listEntries } from '../../src/zipread.mjs'
import { decode, encodeRGBA } from '../../src/png.mjs'
import { buildIcons } from '../../src/build-icons.mjs'
import { findInstanceDir } from '../../preview/scene-assets.mjs'

// ★★ 2026-10-13 B2（规范 §0.9「支持设置、自动发现和显式覆盖」）：
//   这里原来是 `process.env.X || 'E:/…'` —— **开发机路径写死在代码里**，换台机器就静默跑不起来。
//   现在一律走 `src/paths.mjs`：优先级 = env（显式覆盖）> 配置文件 > 自动发现 > **明确报错**。
//   本机路径搬进 `%APPDATA%/modmind/mc-paths.json`（由 tools/gen-path-config.py 生成，可手改）。
//   解析得到 ''（= 未找到）时**不再是"用另一个猜的路径"**，而是按调用点的性质分流：
//     少扫一处就跳过并记录 / 降级但必须可见 / 不能继续就抛可操作的错。
import { opt, pick, requirePath, report as pathsReport } from '../../src/paths.mjs'

const MC_DIR = opt('MC_ROOT')
const DATA_DIR = opt('DATA_DIR')
// ★ 这个"完整注册表"用**专用**变量名：`PREVIEW_REGISTRY` 是预览包那边给"默认态侧车"用的
//   （形状是 {id: props}），两者共用同一个变量会**静默拿错形状**（实测候选从 14561 掉到 5187）。
//   仍兼容旧的 PREVIEW_REGISTRY，并对两种形状都做解析（见 regBlockIds）。
const REGISTRY = opt('REGISTRY')
// 探针 jar：优先用显式 jar / 目录，其次在候选目录里挑版本号最大的那个（不再硬编码文件名）
const PROBE_JAR = opt('PROBE_JAR')
// ★★ 2026-10-12 B8 修复：env 必须**覆盖**，不能"追加"。
//   原实现是 `[env || '', 'E:/…/.work/dist']` ⇒ 即使设了 env，开发机硬编码的 `.work/dist` **照样被扫**。
//   实测后果（两次）：假宿主闸门用 env 指向自建目录（只放自造夹具），却仍能看到 `.work/dist` 里的真探针
//     ⇒ ① 上一轮 pull 闸门 6 条红（它以为"只有 forge-1.20.1"，实际还看得见 fabric 探针）；
//        ② 这一轮我刚往 `.work/dist` 放 forge-1.1.0，闸门里 `sortBuilds` 立刻改挑 1.1.0，而断言写的是自造夹具 1.0.0。
//   ⇒ 闸门/测试**无法隔离探针矩阵**，断言随开发机磁盘内容漂移。
//   规范 §0.9 要求「支持设置、自动发现和**显式覆盖**」⇒ 设了 env 就只用它。
//   （默认值里的硬编码路径属 B2，本轮不动其形状，留待 B2 那一轮一起改自动发现。）
// env（显式覆盖）> 配置文件 > **未找到就空列表**（不再回落到开发机路径）。
// 注：B8 已把"env 只追加不覆盖"改掉了；这里换解析器后语义不变（env 仍最高优先），
// 但**默认值**从"开发机硬编码"变成"配置里写什么就是什么"。
const PROBE_DIRS = pick('PROBE_DIR').path ? [pick('PROBE_DIR').path] : []

const readEntry = (buf, e) => {
  const p = e.localOffset, nl = buf.readUInt16LE(p + 26), el = buf.readUInt16LE(p + 28)
  const d = buf.subarray(p + 30 + nl + el, p + 30 + nl + el + e.compressedSize)
  return e.method === 8 ? zlib.inflateRawSync(d) : Buffer.from(d)
}

/**
 * 从**探针 jar 的文件名**里取探针自己的版本号三元组。
 *
 * ★★ 这里踩过一个真坑（2026-10-10 实机查出来的）：文件名是
 *    `modmind-probe-forge-1.20.1-0.2.0.jar` —— **第一个** `x.y.z` 是 **Minecraft 版本**（1.20.1），
 *    探针自己的版本在**最后**。原来用 `/(\d+)\.(\d+)\.(\d+)/`（第一个匹配）⇒ 0.2.0 / 0.9.2 / 1.0.0
 *    全都算成 `[1,20,1]` ⇒ "按数值比版本"永远不成立 ⇒ 装哪个探针只取决于 `readdirSync` 的顺序（随机）。
 *    现在取**最后一个**匹配，并把 MC 版本那段显式跳过。
 */
function verOf(f) {
  const all = [...String(f).matchAll(/(\d+)\.(\d+)\.(\d+)/g)]
  if (!all.length) return [0, 0, 0]
  // 跳过形如 `-1.20.1-` 的 Minecraft 版本段：取最后一个 x.y.z（探针自己的版本写在最后）
  const last = all[all.length - 1]
  return [+last[1], +last[2], +last[3]]
}
const verGt = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

/* range-impl.js.txt —— P0.1 要插入的「MC 版本比较 + 版本范围」实现（**纯 JS**，不做内联转义）。
 *
 * ★ 为什么单独一个文件、而不是把 JS 写进补丁脚本的字符串里：
 *   第一版把 JS 源码写成 Python 字符串再插进去，`\]` 被吃成 `]` ⇒ 正则字符类提前闭合
 *   ⇒ 在**构建产物被 require 时**才炸；而 `node --check` **不校验正则字面量**（它报了 0 通过）
 *   ⇒ 语法闸门换成 **esbuild**（构建本来就用它，它会真正编译正则）。
 * ★ 本文件必须是**能直接当 JS 用**的纯文本：第一版忘了删掉写文件时留的 Python 头（`# -*- coding` + 三引号），
 *   于是那段 Python 被原样插进 JS ⇒ esbuild 在 61 行报 `Syntax error`。
 *   ⇒ 教训：**"往源码里插内容"的产物，自己要先能被目标语言的解析器吃掉。**
 */
/* ======================= MC 版本号比较 + 版本范围（2026-10-12，P0.1） =======================
 * ★★ 为什么不能按字符串比：'1.21.10' < '1.21.9' 会成立（逐字符比到 '1' vs '9'）
 *    ⇒ 范围匹配一上线，1.21.10 / 1.21.11 就会"明明在范围内却报 none"。必须按**数字段**逐段比。
 */
const mcSegs = (v) => String(v == null ? '' : v).split(/[.\-+_]/)
  .map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0))
/** 段数组比较：a>b ⇒ 1，a<b ⇒ -1，相等 ⇒ 0（短的一方缺省补 0） */
function segCmp(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 单个区间：lo/hi 为 null 表示该侧无界；loInc/hiInc 表示开闭 */
function parseOneRange(s) {
  s = String(s == null ? '' : s).trim()
  if (!s) return null
  if (s === '*' || s === 'x' || s === 'X') return { lo: null, loInc: true, hi: null, hiInc: true }

  // 1) Maven 区间（Forge/NeoForge）：[1.20.1] / [1.20.1,1.21) / [1.20.1,) / (,1.21.4]
  //    ★ 刻意用字符串操作解析，不用正则 —— 避开"字符类里写 \\] "的转义地雷（第一版就是死在这）。
  const first = s[0]
  if (first === '[' || first === '(') {
    const last = s[s.length - 1]
    const closedEnd = last === ']' || last === ')'
    const inner = s.slice(1, closedEnd ? s.length - 1 : s.length)
    const comma = inner.indexOf(',')
    if (comma < 0) {
      // `[1.20.1]`（无逗号）= Maven 的"恰好此版本"，开闭括号在这条语义下都当单点处理
      const v = inner.trim() ? mcSegs(inner.trim()) : null
      return { lo: v, loInc: true, hi: v ? v.slice() : null, hiInc: true }
    }
    const loTxt = inner.slice(0, comma).trim(), hiTxt = inner.slice(comma + 1).trim()
    return {
      lo: loTxt ? mcSegs(loTxt) : null, loInc: first === '[',
      hi: hiTxt ? mcSegs(hiTxt) : null, hiInc: closedEnd && last === ']',
    }
  }

  // 2) 比较器串：`>=1.21 <1.22` / `>=1.21` / `<1.22`
  if (s.indexOf('<') >= 0 || s.indexOf('>') >= 0) {
    let lo = null, loInc = true, hi = null, hiInc = true
    const re = /(>=|<=|>|<)\s*([0-9][0-9.a-zA-Z\-+]*)/g
    let cm
    while ((cm = re.exec(s)) !== null) {
      const op = cm[1], v = mcSegs(cm[2])
      if (op === '>=') { lo = v; loInc = true }
      else if (op === '>') { lo = v; loInc = false }
      else if (op === '<=') { hi = v; hiInc = true }
      else { hi = v; hiInc = false }
    }
    if (!lo && !hi) return null
    return { lo, loInc, hi, hiInc }
  }

  // 3) `~1.21` = >=1.21 <1.22（只抬最后一段）
  if (first === '~') {
    const lo = mcSegs(s.slice(1))
    if (!lo.length) return null
    const hi = lo.slice()
    hi[hi.length - 1] += 1
    return { lo, loInc: true, hi, hiInc: false }
  }
  // 4) `^1.21` = >=1.21 <2.0
  if (first === '^') {
    const lo = mcSegs(s.slice(1))
    if (!lo.length) return null
    const hi = lo.slice()
    hi[0] += 1
    for (let i = 1; i < hi.length; i++) hi[i] = 0
    return { lo, loInc: true, hi, hiInc: false }
  }

  // 5) `1.21.x` / `1.21.*` = >=1.21 <1.22
  const w = /^([0-9][0-9.]*)\.(x|X|\*)$/.exec(s)
  if (w) {
    const lo = mcSegs(w[1])
    const hi = lo.slice(); hi[hi.length - 1] += 1
    return { lo, loInc: true, hi, hiInc: false }
  }

  // 6) 裸版本 `1.20.1`：Maven 语义 = 恰好此版本
  if (/^[0-9][0-9.a-zA-Z\-+]*$/.test(s)) {
    const v = mcSegs(s)
    return { lo: v, loInc: true, hi: v.slice(), hiInc: true }
  }
  return null
}

/**
 * 把两套范围语法统一解析成**区间列表**（OR 语义）。解析不出来返回 null —— **不猜**：
 * 宁可退回"只认精确匹配"，也不放一个没读懂的范围过去。
 *   Maven（mods.toml）：`[1.20.1]` / `[1.20.1,1.21)` / `[1.20.1,)`
 *   Fabric（fabric.mod.json 的 depends.minecraft，semver 风味）：
 *       `~1.21` / `^1.21` / `>=1.21 <1.22` / `>=1.21` / `1.21.x` / `*` / 数组=OR
 */
function parseRangeSpec(spec) {
  const parts = Array.isArray(spec) ? spec : [spec]
  const out = []
  for (const p of parts) { const r = parseOneRange(p); if (r) out.push(r) }
  return out.length ? out : null
}

/** spec 是否覆盖某个具体 MC 版本。spec 读不懂 ⇒ false（**不猜**）。 */
function rangeCovers(spec, mc) {
  const rs = parseRangeSpec(spec)
  if (!rs) return false
  const v = mcSegs(mc)
  for (const r of rs) {
    if (r.lo && (r.loInc ? segCmp(v, r.lo) < 0 : segCmp(v, r.lo) <= 0)) continue
    if (r.hi && (r.hiInc ? segCmp(v, r.hi) > 0 : segCmp(v, r.hi) >= 0)) continue
    return true
  }
  return false
}

/**
 * 从 jar **内部**读它自己声明的 MC 范围（权威来源：构建工具生成，不会和代码漂移）：
 *   Fabric   `fabric.mod.json` → `depends.minecraft`
 *   Forge    `META-INF/mods.toml` / NeoForge `META-INF/neoforge.mods.toml` → `modId="minecraft"` 的 versionRange
 * 读不到 ⇒ spec=null ⇒ 调用方退回精确匹配（**不猜**）。探针 jar 只有 ~35KB 且结果有缓存。
 */
const rangeCache = new Map()
function jarDeclaredRange(jarPath) {
  if (rangeCache.has(jarPath)) return rangeCache.get(jarPath)
  let out = { spec: null, from: '' }
  try {
    const buf = fs.readFileSync(jarPath)
    const byName = new Map(listEntries(buf).map((e) => [e.name, e]))
    const fe = byName.get('fabric.mod.json')
    if (fe) {
      const j = JSON.parse(readEntry(buf, fe).toString('utf8'))
      const dep = j && j.depends ? j.depends.minecraft : null
      if (dep != null) out = { spec: dep, from: 'fabric.mod.json:depends.minecraft' }
    } else {
      const te = byName.get('META-INF/mods.toml') || byName.get('META-INF/neoforge.mods.toml')
      if (te) {
        const txt = readEntry(buf, te).toString('utf8')
        const m = /modId\s*=\s*"minecraft"[^]{0,400}?versionRange\s*=\s*"([^"]+)"/.exec(txt)
        if (m) out = { spec: m[1], from: te.name.split('/').pop() + ':modId=minecraft' }
      }
    }
  } catch { /* 读不了 ⇒ 保持 null */ }
  rangeCache.set(jarPath, out)
  return out
}

/** 构建排序：探针版本高的优先；同版本时"目标版本离实例更近"的优先（更像能用的那个）。 */
function sortBuilds(list, mc) {
  const v = mcSegs(mc)
  return list.slice().sort((a, b) => {
    if (verGt(verOf(a.file), verOf(b.file))) return -1
    if (verGt(verOf(b.file), verOf(a.file))) return 1
    return Math.abs(segCmp(mcSegs(a.mc), v)) - Math.abs(segCmp(mcSegs(b.mc), v))
  })
}

/** 定位探针 jar；显式路径优先，否则在候选目录里挑**版本号最大**的 */
function probeJar() {
  if (PROBE_JAR && fs.existsSync(PROBE_JAR)) return PROBE_JAR
  let best = null, bestV = null
  for (const d of PROBE_DIRS) {
    let files
    try { files = fs.readdirSync(d) } catch { continue }
    for (const f of files) {
      if (!/^modmind-probe.*\.jar$/i.test(f)) continue
      const v = verOf(f)
      // ★ 必须按**数值**比版本：字典序下 `…-1.10.0.jar` **小于** `…-1.9.0.jar`，
      //   跨到两位数版本号时就会静默装成旧探针。
      if (!bestV || verGt(v, bestV)) { best = path.join(d, f); bestV = v }
    }
  }
  return best || PROBE_JAR || path.join(PROBE_DIRS[0] || '.', 'modmind-probe.jar')
}

/**
 * 解析探针 jar 文件名 → { loader, mc, ver, file }。
 * 命名约定：`modmind-probe-<加载器>-<MC版本>-<探针版本>.jar`（真实出处 = `.work/dist/` 里的构建）。
 * 从**尾部**解析（ver 最后、mc 倒数第二、loader 是中间段），避免 `1.20.1` 与 `1.0.0` 两个版本号互相抢匹配。
 */
function parseProbeFile(f) {
  const p = String(f).replace(/\.jar$/i, '').split('-')
  if (p.length < 5 || p[0] !== 'modmind' || p[1] !== 'probe') return null
  const ver = p[p.length - 1], mc = p[p.length - 2]
  const loader = p.slice(2, p.length - 2).join('-')
  if (!/^\d+\.\d+\.\d+$/.test(ver) || !/^\d+\.\d+(?:\.\d+)?$/.test(mc) || !loader) return null
  return { loader, mc, ver, file: String(f) }
}

/** 扫描候选目录得到「探针构建矩阵」（真实来源 = 磁盘上的 jar 文件名，不猜）。 */
function probeBuilds() {
  const out = []
  const seen = new Set()
  if (PROBE_JAR) {
    const b = parseProbeFile(path.basename(PROBE_JAR))
    if (b) { const r = jarDeclaredRange(PROBE_JAR); out.push({ ...b, path: PROBE_JAR, range: r.spec, rangeFrom: r.from }) }
  }
  for (const d of PROBE_DIRS) {
    let files
    try { files = fs.readdirSync(d) } catch { continue }
    for (const f of files) {
      if (!/^modmind-probe.*\.jar$/i.test(f) || seen.has(f)) continue
      const b = parseProbeFile(f)
      if (!b) continue
      seen.add(f)
      const r = jarDeclaredRange(path.join(d, f))
      out.push({ ...b, path: path.join(d, f), range: r.spec, rangeFrom: r.from })
    }
  }
  return out
}

/**
 * 按「实例 loader × MC 版本」匹配探针构建。**两段语义（2026-10-12 P0.1）**：
 *   ① 目标版本精确相等        ⇒ mode='matched'     （= 这个构建实际构建/验证过的版本）
 *   ② 落在 jar 自己声明的范围 ⇒ mode='unverified'（**可试装，但该版本未验证**）
 *   ③ 都没有                  ⇒ null
 * ★ 为什么要有 ②：fabric 探针声明 `~1.21`，旧实现只认字面量 1.21 ⇒ 1.21.4 / 1.21.8 被判"暂无构建"（假缺口）。
 * ★ 为什么 ② 不能当 ①：Forge 的 MC 范围是**加载期硬约束**（范围不符 ⇒ 游戏不启动），
 *   而 1.21.4 官方正好移除了探针赖以渲染的 API ⇒ 未验证的范围只能承诺"可试装"。
 */
function probeJarFor(loader, mc) {
  if (!loader || !mc) return null
  const all = probeBuilds().filter((b) => b.loader === loader)
  if (!all.length) return null
  const exact = all.filter((b) => b.mc === mc)
  if (exact.length) return { ...sortBuilds(exact, mc)[0], mode: 'matched' }
  const inRange = all.filter((b) => b.range && rangeCovers(b.range, mc))
  if (inRange.length) return { ...sortBuilds(inRange, mc)[0], mode: 'unverified' }
  return null
}

/**
 * 读实例的加载器与 MC 版本 —— **真实扫描**：版本 json 的 `inheritsFrom` + `libraries`（forge/fabric 标识），
 * 读不到才退回目录名里的版本号 / 关键词。绝不凭空猜一个能匹配上的版本（否则会误导"可装探针"）。
 */
function instanceLoaderMc(dir) {
  const name = path.basename(dir || '')
  let j = null
  const tryRead = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
  j = tryRead(name + '.json')
  if (!j) {
    let js = []
    try { js = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { js = [] }
    for (const f of js) { const t = tryRead(f); if (t && (t.inheritsFrom || t.libraries)) { j = t; break } }
  }
  let mc = '', loader = ''
  if (j) {
    mc = String(j.inheritsFrom || '')
    const names = Array.isArray(j.libraries) ? j.libraries.map((l) => (l && l.name) || '') : []
    const libs = names.join(' ')
    if (/neoforge/i.test(libs)) loader = 'neoforge'
    else if (/forge/i.test(libs)) loader = 'forge'
    else if (/quilt/i.test(libs)) loader = 'quilt'
    else if (/fabric/i.test(libs)) loader = 'fabric'
    // PCL 等启动器导出的"合并版"版本 json 没有 inheritsFrom，MC 版本在 clientVersion 里。
    //（真机 2026-10-11：GregTech Leisure 的 PCL 合并 json ⇒ 旧实现识别成"forge 未知版本"，装不了探针）
    if (!mc && /^\d+\.\d+(?:\.\d+)?$/.test(String(j.clientVersion || ''))) mc = String(j.clientVersion)
    // 另一条真实线索：forge 主库名如 `net.minecraftforge:forge:1.20.1-47.2.0`
    if (!mc) {
      const fl = names.find((n) => n.indexOf('net.minecraftforge:forge:') === 0)
      const m2 = fl && /^(\d+\.\d+(?:\.\d+)?)-/.exec(String(fl.split(':')[2] || ''))
      if (m2) mc = m2[1]
    }
    if (!mc && j.id && /^\d+\.\d+(?:\.\d+)?$/.test(String(j.id))) mc = String(j.id)
  }
  if (!mc) { const m = /(\d+\.\d+(?:\.\d+)?)/.exec(name); if (m) mc = m[1] }
  if (!loader) {
    if (/neoforge/i.test(name)) loader = 'neoforge'
    else if (/forge/i.test(name)) loader = 'forge'
    else if (/fabric/i.test(name)) loader = 'fabric'
    else if (/quilt/i.test(name)) loader = 'quilt'
  }
  return { loader, mc }
}

/* ======================= 一键启动游戏（pull:launch） =======================
 * 宿主没有把"启动实例"能力开放给采集面板（2026-10-11 逐字查过 app.asar：别的 feature
 * 调不到测试服务的启动器，也没有 launchVersion 这类 API）。所以这里**自己启动**：
 * 用实例的版本 json 拼出完整 java 命令行，参数做法逐项对齐 PCL 生成的
 * `PCL/LatestLaunch.bat`（同一台机器上验证可用的那条命令），spawn javaw 后立刻脱离
 * （detached + unref），游戏窗口自己打开。启动的是**这个实例本身**（mods 全带），
 * 和用 PCL 双击启动等价。
 *
 * 范围：Windows / 官方现代版 json（PCL、官方启动器、HMCL 的"合并版"都行）。
 * dryRun（或闸门 env PREVIEW_LAUNCH_DRYRUN=1）只返回命令、不真的启动。
 */

/** 官方 launcher 的 rules 求值（子集）：features 一律视为不满足；os 只认 windows（x64）。 */
function rulesAllow(rules) {
  if (!Array.isArray(rules) || !rules.length) return true
  let allow = false
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue
    const osr = r.os || {}
    let match = true
    if (r.features) match = false
    if (osr.name && osr.name !== 'windows') match = false
    if (osr.arch) match = false // 规则里的 arch 只出现在 32 位/arm 特例上；x64 不匹配
    if (match) allow = r.action === 'allow'
  }
  return allow
}

/* ======================= 探针采集配置（probe-config.json） =======================
 * 探针从 `<游戏目录>/.modmind/probe/probe-config.json` 读运行模式（缺文件 ⇒ 默认 placement）。
 * 2026-10-11 事故（诊断见评审 v1.7-审核-采集无产物诊断）：装入探针只拷了 jar、没写这份配置
 * ⇒ 探针跑成「放置验证」、采集（pull）被静默跳过 —— 面板永远等不到产物。
 * 现在「装入探针」= 拷 jar + 写配置，一体完成；写不进去就算这个目标没装成（不进 installed）。
 */
function writeProbeConfig(instanceDir) {
  const dir = path.join(instanceDir, '.modmind', 'probe')
  fs.mkdirSync(dir, { recursive: true })
  const cfg = {
    mode: 'pull',            // ★ 采集模式（探针读不到 mode 会回落 placement）
    iconScale: 1,
    marginGui: 2,
    bgCount: 4,              // 四背景解真 alpha
    startTick: 60,
    captureIcons: true,      // 全量截图（D025 期间曾设 false 只补页签；正式采集必须 true）
    totalTimeoutMs: 900000,
    note: '由 mc-pull 写入：游戏内采集配置（mode=pull）。下次「装入探针」会覆盖本文件。',
  }
  const target = path.join(dir, 'probe-config.json')
  const tmp = target + '.next'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  // 两段式：写完先校验、再就位（沿用 B3 纪律；rename 对已存在目标可直接覆盖）
  const check = JSON.parse(fs.readFileSync(tmp, 'utf8'))
  if (check.mode !== 'pull') throw new Error('probe-config 写入校验失败（mode≠pull）')
  try { fs.renameSync(tmp, target) } catch {
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2))     // 兜底直写（单写者、文件小）
    try { fs.rmSync(tmp, { force: true }) } catch { /* 尽力 */ }
  }
  return { configAt: target, mode: 'pull', at: new Date().toISOString() }
}

// ── 零依赖 store-zip（写"导出数据包"用）────────────────────────────────────
// 为什么 store（不压缩）：数据包大头是 PNG（本身已压缩），再 deflate 收益极小、还要引依赖。
// 两个必须守的点（同 build-probe.ps1 的教训）：① 条目名一律**正斜杠**（反斜杠的 zip 在 Java/Python 侧都读不对）；
// ② CRC 与长度按 Buffer 算（别用字符串长度）。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
/** entries: [{ name（必须正斜杠）, data: Buffer }] → zip Buffer（store 模式）。 */
function storeZip(entries) {
  const chunks = [], central = []
  let offset = 0
  for (const e of entries) {
    if (e.name.includes('\\')) throw new Error('zip 条目名出现反斜杠：' + e.name)
    const nb = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28)
    chunks.push(lh, nb, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(nb.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([ch, nb]))
    offset += lh.length + nb.length + e.data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cd, eocd])
}

/** 找能启动 1.20.x 的 java（17）：env 指定 → 实例的 .minecraft/runtime → %APPDATA%\.minecraft\runtime → PATH。 */
function findLaunchJava(mcRoot) {
  const tries = []
  if (process.env.MODMIND_MC_JAVA) tries.push(process.env.MODMIND_MC_JAVA)
  const roots = [
    path.join(mcRoot, 'runtime'),
    path.join(process.env.APPDATA || '', '.minecraft', 'runtime'),
  ]
  const ranked = []
  for (const rt of roots) {
    let ds = []
    try { ds = fs.readdirSync(rt) } catch { ds = [] }
    for (const d of ds) ranked.push({ rt, d, s: /beta|gamma/i.test(d) ? 0 : 1 }) // beta/gamma = Java 17
  }
  ranked.sort((a, b) => a.s - b.s)
  for (const r of ranked) for (const exe of ['javaw.exe', 'java.exe']) tries.push(path.join(r.rt, r.d, 'bin', exe))
  for (const p of tries) { try { if (p && fs.existsSync(p)) return p } catch { /* 忽略 */ } }
  try {
    const w = execFileSync('where', ['javaw'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim()
    if (w && fs.existsSync(w)) return w
  } catch { /* PATH 里没有 */ }
  return ''
}

/** 把实例的版本 json 拼成一条可启动的命令（不启动）。dryRun 与真启动共用同一条构建路径。 */
function buildLaunchPlan(instanceDir, opts = {}) {
  const name = path.basename(instanceDir || '')
  if (!instanceDir || !name) throw new Error('缺少实例目录（instanceDir）')
  let j = null
  try { j = JSON.parse(fs.readFileSync(path.join(instanceDir, name + '.json'), 'utf8')) } catch { /* 走下面统一报错 */ }
  if (!j || !j.mainClass || !j.arguments || !Array.isArray(j.arguments.game)) {
    throw new Error('「' + name + '」的版本 json 缺少启动信息（mainClass / arguments.game）——一键启动只支持现代版格式')
  }
  const mcRoot = path.resolve(instanceDir, '..', '..')
  const librariesDir = path.join(mcRoot, 'libraries')
  const nativesDir = path.join(instanceDir, name + '-natives')
  try { fs.mkdirSync(nativesDir, { recursive: true }) } catch { /* 建不了就交给 java 报错 */ }
  const cp = []
  for (const lib of (j.libraries || [])) {
    if (!rulesAllow(lib.rules)) continue
    const rel = lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path
    if (rel) cp.push(path.join(librariesDir, rel))
  }
  cp.push(path.join(instanceDir, name + '.jar')) // 实例 jar 放最后（与 PCL 生成的 classpath 一致）
  const ident = pclIdentity(mcRoot, instanceDir) // 离线玩家身份：跟着这个实例上次的启动命令走
  const subst = (s) => String(s)
    .replace(/\$\{natives_directory\}/g, nativesDir)
    .replace(/\$\{launcher_name\}/g, 'ModMind')
    .replace(/\$\{launcher_version\}/g, '1')
    .replace(/\$\{classpath\}/g, cp.join(';'))
    .replace(/\$\{classpath_separator\}/g, ';')
    .replace(/\$\{library_directory\}/g, librariesDir)
    .replace(/\$\{version_name\}/g, name)
    .replace(/\$\{game_directory\}/g, instanceDir)
    .replace(/\$\{assets_root\}/g, path.join(mcRoot, 'assets'))
    .replace(/\$\{assets_index_name\}/g, String((j.assetIndex && j.assetIndex.id) || '5'))
    .replace(/\$\{auth_player_name\}/g, String(opts.username || ident.username || 'Player'))
    .replace(/\$\{auth_uuid\}/g, String(opts.uuid || ident.uuid || '00000000000000000000000000000000'))
    .replace(/\$\{auth_access_token\}/g, '0')
    .replace(/\$\{auth_xuid\}/g, '0')
    .replace(/\$\{clientid\}/g, '0')
    .replace(/\$\{user_type\}/g, 'legacy')
    .replace(/\$\{version_type\}/g, 'ModMind')
  const flatten = (arr) => {
    const out = []
    for (const a of (arr || [])) {
      if (typeof a === 'string') out.push(a)
      else if (a && a.value && rulesAllow(a.rules)) {
        for (const v of (Array.isArray(a.value) ? a.value : [a.value])) out.push(String(v))
      }
    }
    return out.map(subst)
  }
  const memMb = Number(opts.maxMemoryMb) > 0 ? Math.floor(Number(opts.maxMemoryMb))
    : Math.min(8192, Math.max(2048, Math.floor(os.totalmem() / 1048576 / 4)))
  const extras = [
    '-XX:-OmitStackTraceInFastThrow',
    '-Djdk.lang.Process.allowAmbiguousCommands=True',
    '-Dfml.ignoreInvalidMinecraftCertificates=True',
    '-Dfml.ignorePatchDiscrepancies=True',
    '-Xmx' + memMb + 'm',
    '-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC',
    '-XX:G1NewSizePercent=20', '-XX:G1ReservePercent=20', '-XX:G1HeapRegionSize=32M',
    '-XX:MaxGCPauseMillis=50', '-XX:+PerfDisableSharedMem',
    '-XX:MinHeapFreeRatio=25', '-XX:MaxHeapFreeRatio=40',
    '-Dlog4j2.formatMsgNoLookups=true',
  ]
  const java = opts.java || findLaunchJava(mcRoot)
  if (!java) throw new Error('找不到 Java 17（看了实例的 .minecraft/runtime 与 %APPDATA%\\.minecraft\\runtime）——先用你自己的启动器装一次 Java')
  const args = [...flatten(j.arguments.jvm), ...extras, String(j.mainClass), ...flatten(j.arguments.game)]
  const display = [java, ...args].map((x) => (/[ \t]/.test(x) ? '"' + x + '"' : x)).join(' ')
  return { name, instanceDir, java, args, display, memMb, cpCount: cp.length, nativesDir }
}

/** 防连点：最近一次 spawn 的记录（同实例 60 秒内且进程还活着 ⇒ 不重复启动）。 */
let lastSpawn = { pid: 0, instanceDir: '', at: 0 }

/** 从 PCL 的 LatestLaunch.bat（如果它确实是这个实例上次的启动命令）里取 用户名/uuid —— 保住离线玩家身份。 */
function pclIdentity(mcRoot, instanceDir) {
  // PCL 的数据目录既可能在 .minecraft 旁边（<mcRoot>/../PCL），也可能在 .minecraft/PCL 里 —— 两处都看。
  const cands = [path.join(mcRoot, '..', 'PCL', 'LatestLaunch.bat'), path.join(mcRoot, 'PCL', 'LatestLaunch.bat')]
  for (const p of cands) {
    try {
      const bat = fs.readFileSync(p, 'utf8')
      const gd = /--gameDir\s+"([^"]+)"/.exec(bat)
      if (!gd || path.resolve(gd[1].trim()) !== path.resolve(instanceDir)) continue
      const u = /--username\s+([^\s"]+)/.exec(bat)
      const id = /--uuid\s+([^\s"]+)/.exec(bat)
      return { username: u ? u[1] : '', uuid: id ? id[1] : '' }
    } catch { /* 这个位置没有，试下一个 */ }
  }
  return {}
}

/** 实例 mods/ 里最大的探针装入时间（ISO），没装返回 ''。 */
function probeInstalledAt(dir) {
  let mods = []
  try { mods = fs.readdirSync(path.join(dir, 'mods')) } catch { return { at: '', jar: '' } }
  let at = '', jar = ''
  for (const f of mods) {
    if (!/^modmind-probe.*\.jar$/i.test(f)) continue
    let t = ''
    try { t = fs.statSync(path.join(dir, 'mods', f)).mtime.toISOString() } catch { /* 取不到时间 */ }
    if (t > at) { at = t; jar = f }
  }
  return { at, jar }
}

function jars(dirOverride) {
  // 显式传入（功能包前端自动直读 / 闸门迷你实例）优先；其次环境变量；最后自动搜 versions。
  const dir = dirOverride || process.env.PREVIEW_INSTANCE || (MC_DIR && findInstanceDir(MC_DIR))
  if (!dir) throw new Error('没有找到本地游戏实例，请选择含客户端 jar 的实例目录')
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.jar'))
  if (!all.length) throw new Error('实例目录里没有客户端 jar：' + dir)
  // ★ 客户端 jar 的命名约定是「<版本目录名>.jar」。直接 find 取首个，在实例里留有旧备份/PCL 残留时
  //   会**采错源**（读进别的版本）。优先精确名，取不到才退回，并明说选了谁。
  const want = path.basename(dir) + '.jar'
  const client = all.includes(want) ? want : all[0]
  if (client !== want) console.log(`[mc-pull] 注意：实例里没有「${want}」，退回用「${client}」当客户端 jar`)
  const out = [path.join(dir, client)]
  const mods = path.join(dir, 'mods')
  if (fs.existsSync(mods)) for (const f of fs.readdirSync(mods).sort()) if (f.endsWith('.jar')) out.push(path.join(mods, f))
  return { instanceDir: dir, jars: out, clientJar: client }
}

/** 游戏内探针的产出目录：`<实例>/.modmind/probe/pull2`（Pull.java 里用 `mc.gameDirectory` 直接拼的）。 */
function probePull2(instanceDir) {
  return path.join(instanceDir, '.modmind', 'probe', 'pull2')
}

/**
 * ★ 自动搜索"游戏内产物"（2026-10-10，用户："直接加上自动搜索"）。
 *
 * 以前只认**当前实例**那一个路径 ⇒ 用户装过探针、也可能在别的整合包/版本里启动过游戏，
 * 但面板只会说"没找到"，让人自己去翻目录。现在把整个 `.minecraft` 树扫一遍：
 *   ①当前实例 ②`<MC>/versions/*`（每个版本/整合包一个实例目录）③`<MC>` 根
 * 每个候选都看 `<dir>/.modmind/probe/pull2/index.json`，找到就带上页数与时间，按时间倒序。
 * 导入时**默认用最新的那一处**；界面上把找到几处、分别在哪都列出来。
 */
function dumpInfo(dir) {
  if (!dir) return null
  const idx = path.join(dir, 'index.json')
  if (!fs.existsSync(idx)) return null
  let pages = 0, at = '', count = 0
  try {
    const j = JSON.parse(fs.readFileSync(idx, 'utf8'))
    pages = Number(j.pages) || 0
    // ★ 真实物品数 = index.json 的 items 数组长度（P1：步骤 3 的「物品 N 项」必须来自产物，不估计）
    count = Array.isArray(j.items) ? j.items.length : (Number(j.count) || 0)
  } catch { /* 坏文件就当没页数/条数 */ }
  try { at = fs.statSync(idx).mtime.toISOString() } catch { /* 取不到时间 */ }
  return { dir, instanceDir: path.dirname(path.dirname(path.dirname(dir))), pages, count, capturedAt: at }
}

function findProbeDumps(projectPath) {
  const out = []
  const seen = new Set()
  const probe = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    const d = dumpInfo(dir)
    if (d) out.push(d)
  }
  try { probe(probePull2(jars().instanceDir)) } catch { /* 当前实例不可用（没客户端 jar） */ }
  let versions = []
  try { versions = fs.readdirSync(path.join(MC_DIR, 'versions')) } catch { /* 没有 versions 目录 */ }
  for (const n of versions) probe(probePull2(path.join(MC_DIR, 'versions', n)))
  probe(probePull2(MC_DIR))
  // ★ ModMind 的**隔离测试实例**（侧边栏「测试与构建」自己准备的那个）也在项目里 —— 产物可能落在它那儿
  for (const e of projectInstanceDirs(projectPath, false)) probe(probePull2(e.dir))
  out.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
  return out
}

/**
 * ModMind 的**隔离测试实例目录**（2026-10-10 从宿主 app.asar 里查出来的）：
 *   主进程的诊断采集器把 `path.join(dataRoot, "minecraft", …)` 映射成 `project/minecraft/…`，
 *   而 `project/logs` 映射自 `path.join(project.path, "logs")` ⇒ **dataRoot = project.path**
 *   ⇒ 测试实例的游戏目录就是 **`<项目目录>/minecraft/`**（另有 run / run-gametest / run-server 兜底）。
 * 侧边栏「测试与构建」的文案也印证：「准备隔离的 Minecraft 测试实例」。
 * ⇒ 探针要装到**那儿**才可能被真正启动的实例加载，搜索产物也要覆盖那儿。
 */
function projectInstanceDirs(projectPath, onlyExisting) {
  if (!projectPath) return []
  const out = []
  for (const n of ['minecraft', 'run', 'run-gametest', 'run-server']) {
    const dir = path.join(String(projectPath), n)
    let exists = false
    try { exists = fs.statSync(dir).isDirectory() } catch { /* 还没准备 */ }
    if (onlyExisting && !exists) continue
    // `minecraft` 是宿主自己的约定目录：即使还没有也**允许**我们建出来（装探针用）
    if (!exists && n !== 'minecraft') continue
    out.push({ dir, kind: 'project', label: '项目内 ' + n, exists })
  }
  return out
}

/** 把一个"实例目录"描述成前端要的样子（探针是否已装 / 有没有产物 / 最后启动时间 / 一句结论）。 */
function describeInstance(name, dir, extra = {}) {
  let mods = []
  try { mods = fs.readdirSync(path.join(dir, 'mods')) } catch { /* 读不到 mods */ }
  let lastLaunch = ''
  for (const f of ['logs/latest.log', 'logs/debug.log']) {
    try {
      const t = fs.statSync(path.join(dir, f)).mtime.toISOString()
      if (!lastLaunch || t > lastLaunch) lastLaunch = t
    } catch { /* 这个实例没启动过 */ }
  }
  const probes = mods.filter((f) => /^modmind-probe.*\.jar$/i.test(f)).map((f) => {
    let at = ''
    try { at = fs.statSync(path.join(dir, 'mods', f)).mtime.toISOString() } catch { /* 取不到时间 */ }
    return { name: f, at }
  })
  const probeAt = probes.map((p) => p.at).filter(Boolean).sort().pop() || ''
  const probeDir = path.join(dir, '.modmind', 'probe')
  const hasDump = fs.existsSync(path.join(probeDir, 'pull2', 'index.json'))
  // ★ 产物形态校验（2026-10-11 事故显性化）：探针"跑过"≠"采集跑过"——看它产出的是哪一种。
  const statAt = (p) => { try { return fs.statSync(p).mtime.toISOString() } catch { return '' } }
  const placementAt = statAt(path.join(probeDir, 'placement-report.json'))
  let cfgMode = ''
  try { cfgMode = JSON.parse(fs.readFileSync(path.join(probeDir, 'probe-config.json'), 'utf8')).mode || '' } catch { cfgMode = '' }
  // ★ 探针平台匹配（P1：面板只渲染，不猜）：按实例的真实 loader × MC 版本，从构建矩阵里找。
  //   probe='none' 无适配构建 / 'absent' 有适配但还没装 / 'matched' 已装（有适配构建）
  const { loader, mc } = instanceLoaderMc(dir)
  const build = probeJarFor(loader, mc)
  const probe = !build ? 'none' : (probes.length ? 'matched' : 'absent')
  // ★ 三态透传（2026-10-12 P0.1）：probe = "有没有构建/装没装"；probeMode = "这份构建的把握有多大"。
  //   UI 据此把 'absent' 分成「可装探针」与「可试装（该版本未验证）」两种措辞。
  const probeMode = build ? build.mode : ''
  const probeRange = build && build.range
    ? String(Array.isArray(build.range) ? build.range.join(' | ') : build.range) : ''
  let verdict
  if (hasDump) verdict = '已有产物'
  else if (!probes.length) verdict = '未装探针'
  else if (!lastLaunch) verdict = '探针已装，但这个实例从没启动过游戏'
  else if (placementAt && placementAt > (probeAt || '')) {
    // ★ 探针跑过，但产出的是「放置验证」而不是采集（2026-10-11 事故的场景显性化）。
    verdict = cfgMode === 'pull'
      ? '探针产出的是「放置验证」而不是采集数据（采集配置已是 pull —— 属异常，看该实例 logs 的 [ModMindProbe] 行）'
      : '探针跑了「放置验证」而不是采集（采集配置缺失或 mode≠pull）⇒ 点「重新装入探针」补写配置，再启动一次'
  }
  else if (probeAt && lastLaunch < probeAt) verdict = '探针是在最后一次启动之后装的 ⇒ 探针从没运行过，要再启动一次'
  else verdict = '探针装好且晚于最后启动却没产出 ⇒ 启动可能失败（看该实例 logs）'
  return { name, dir, id: dir, loader, mc, probe, probeMode, probeRange, matched: build ? build.file : '', hasProbe: probes.length > 0, hasDump, lastLaunch, probes, probeAt, pullAt: statAt(path.join(probeDir, 'pull2', 'index.json')), placementAt, cfgMode, verdict, ...extra }
}

/** 自动搜索"有哪些可用实例"（有 `mods/` 且有客户端 jar 的版本目录），并标出探针是否已装、是否产出过数据。 */
function findInstances() {
  const out = []
  // ★ B2：MC 根解析不到时**必须显式返回**（否则 path.join('', 'versions') = 相对路径 'versions'
     //   会去扫**当前工作目录** —— 那种"看起来有结果、其实扫错地方"的行为比报错更坏）。
  if (!MC_DIR) return out
  let names = []
  try { names = fs.readdirSync(path.join(MC_DIR, 'versions')) } catch { return out }
  for (const n of names) {
    const dir = path.join(MC_DIR, 'versions', n)
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    if (!files.includes('mods') || !files.some((f) => f.endsWith('.jar'))) continue
    out.push(describeInstance(n, dir, { kind: 'version' }))
  }
  return out
}

/**
 * 一次遍历所有实例 jar，同时收：
 *   · names：`assets/<ns>/lang/zh_cn.json` 的 `item.* / block.* / tile.*` 键 → 中文名；
 *   · items：这些键对应的 id 集合（语言文件里出现过 = 是物品/方块）；
 *   · tex：`assets/<ns>/textures/**.png` 的**位置索引** id → {jar, entry}（**不读内容**）。
 *
 * ★ 2026-10-11：整合包 70+ 个 jar、贴图总量可达数百 MB。旧实现 readTextures 把每张 PNG 都
 *   readEntry 进内存 Map（几百 MB 常驻），现在只存 zip 条目引用，烤图标时经 readTexRef 按需
 *   读单条（同一 jar 连续命中时缓存该 jar 的 buffer），内存只持有 entry 元数据 + 当前 jar。
 */
function scanAssets(list) {
  const names = new Map()          // "ns:name" -> 中文名
  const nameRanks = new Map()
  const items = new Set()          // "ns:name"（语言文件里出现的物品/方块）
  const blockIds = new Set()
  const tex = new Map()            // "ns:textures 下相对路径" -> { jar, entry }
  for (const p of list) {
    let buf; try { buf = fs.readFileSync(p) } catch { continue }
    let es; try { es = listEntries(buf) } catch { continue }
    for (const e of es) {
      const bs = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/.exec(e.name)
      if (bs) blockIds.add(`${bs[1]}:${bs[2]}`)
      if (/^assets\/[^/]+\/lang\/(?:zh_cn|en_us)\.json$/.test(e.name)) {
        const rank = e.name.endsWith('/zh_cn.json') ? 2 : 1
        const ns = e.name.split('/')[1]
        let j; try { j = JSON.parse(readEntry(buf, e).toString('utf8')) } catch { continue }
        for (const [k, v] of Object.entries(j)) {
          const m = /^(?:block|item|tile)\.(.+)$/.exec(k)
          if (!m || typeof v !== 'string') continue
          // 键形如 `block.minecraft.stone` / `item.gtceu.electric_pump`：
          // 去掉类别前缀后，按**第一个点**切 命名空间:路径（路径里允许再有点）。
          // ★ 旧实现写成 `${ns}:${m[2]}` ⇒ minecraft:minecraft.stone，物品永远匹配不到贴图（闸门抓到）。
          const rest = m[1]
          const dot = rest.indexOf('.')
          const id = dot < 0 ? `${ns}:${rest}` : `${rest.slice(0, dot)}:${rest.slice(dot + 1)}`
          if (!names.has(id) || rank >= (nameRanks.get(id) || 0)) { names.set(id, v); nameRanks.set(id, rank) }
          items.add(id)
        }
      } else if (e.name.startsWith('assets/') && e.name.endsWith('.png') && e.name.includes('/textures/')) {
        const q = e.name.split('/')
        tex.set(`${q[1]}:${q.slice(3).join('/').slice(0, -4)}`, { jar: p, entry: e })
      }
    }
  }
  return { names, items, tex, blockIds }
}

/** 按 scanAssets 给的 {jar, entry} 引用读一张贴图（同 jar 连续命中只持有一份 buffer） */
const texCache = { jar: '', buf: null, byName: null }
function readTexRef(ref) {
  if (!ref) return null
  try {
    if (texCache.jar !== ref.jar) {
      const buf = fs.readFileSync(ref.jar)
      const es = listEntries(buf)
      texCache.jar = ref.jar; texCache.buf = buf
      texCache.byName = new Map(es.map((e) => [e.name, e]))
    }
    const e = texCache.byName.get(ref.entry.name)
    return e ? readEntry(texCache.buf, e) : null
  } catch { return null }
}

/** 最近邻放大 k 倍（图标 = 贴图 × pxPerTexel） */
function scale(im, k) {
  const w = im.width * k, h = im.height * k
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = (y / k) | 0
    for (let x = 0; x < w; x++) {
      const sx = (x / k) | 0
      const s = (sy * im.width + sx) * 4, d = (y * w + x) * 4
      out[d] = im.data[s]; out[d + 1] = im.data[s + 1]; out[d + 2] = im.data[s + 2]; out[d + 3] = im.data[s + 3]
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * 注册表里的「方块 id 清单」。
 *
 * ★ 审核员 U5/O9/P2-3：采集只需要一份 **id 清单**，而完整注册表是 **44 MB**
 *   （按 D063 实测口径：引入 +0.55 s、+207 MB 常驻），每次 `pull_run` 都全量 `JSON.parse` 一次纯属浪费。
 *   现在**侧车优先**：`<注册表同目录>/registry-ids.json`（只含 id 数组，几百 KB），带来源 mtime 以便失效；
 *   没有/过期才全量 parse，并**顺手写侧车**（下次就快）。
 *   形状兼容：`{blocks:[{id,…}]}`（完整注册表）或 `{id: props}`（抽取后的默认态侧车）—— 不区分会静默得到 0 个方块。
 */
function regBlockIds() {
  if (!REGISTRY) return []
  const idsPath = path.join(path.dirname(REGISTRY), 'registry-ids.json')
  let regMtime = 0
  try { regMtime = fs.statSync(REGISTRY).mtimeMs } catch { /* 注册表不在，就靠侧车 */ }
  try {
    const sc = JSON.parse(fs.readFileSync(idsPath, 'utf8'))
    if (Array.isArray(sc.ids) && sc.ids.length && (!regMtime || sc.sourceMtime === regMtime)) {
      console.log(`[mc-pull] 注册表 id 侧车命中（${sc.ids.length} 条，省掉 44 MB 解析）`)
      return sc.ids
    }
  } catch { /* 没侧车 / 读不动 —— 走全量 */ }
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
  const ids = Array.isArray(reg && reg.blocks)
    ? reg.blocks.map((b) => b && b.id).filter(Boolean)
    : Object.keys(reg || {})
  try {
    fs.writeFileSync(idsPath, JSON.stringify({ source: REGISTRY, sourceMtime: regMtime, count: ids.length, ids }))
    console.log(`[mc-pull] 已生成注册表 id 侧车（${ids.length} 条）→ ${idsPath}（下次采集不再解析 44 MB）`)
  } catch { /* 写不了不影响采集 */ }
  return ids
}

// ---------------------------------------------------------------- 采集数据的存放位置（★ 项目内）
/**
 * 采集数据放在**项目里**：`<projectPath>/.modmind/mc-capture/`
 *   packs/<key>/{items.json, icons/, meta.json}   —— 每个 key = 一个"数据包"
 *   active.txt                                     —— 当前选中的 key（预览包按它决定读哪个包）
 *
 * key = 实例目录名（消毒后）。于是：
 *   · **同一个游戏路径**（同一实例目录）⇒ 同一 key ⇒ 再次采集**直接覆盖**；
 *   · **不同版本 / 不同整合包** ⇒ 实例目录不同 ⇒ key 不同 ⇒ **各自独立保存**，互不覆盖。
 * 这正对用户 2026-10-10 的要求：「同一个游戏路径只能直接覆盖，不同版本和整合包才能分离保存」。
 */
function captureRootOf(projectPath) {
  if (!projectPath) return ''
  return projectDataPath(projectPath)
}
function packKeyOf(instanceDir) {
  const base = path.basename(instanceDir || 'instance')
  const label = base.replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 68) || 'instance'
  return label + '-' + createHash('sha256').update(path.resolve(instanceDir).toLowerCase()).digest('hex').slice(0, 10)
}
function activeKeyOf(root) {
  try { return fs.readFileSync(path.join(root, 'active.txt'), 'utf8').trim() } catch { return '' }
}
function listPacks(root) {
  const dir = path.join(root, 'packs')
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const out = []
  for (const key of names) {
    const p = path.join(dir, key)
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8')) } catch { /* 没有 meta 也照样列出来 */ }
    let icons = 0
    try { icons = fs.readdirSync(path.join(p, 'icons')).length } catch { /* 没有图标目录 */ }
    out.push({
      key,
      title: meta.title || key,
      count: meta.count ?? null,
      icons,
      capturedAt: meta.capturedAt || '',
      instanceDir: meta.instanceDir || '',
      source: meta.source || '',
      fidelity: meta.fidelity || '',
      // ★ 2026-10-12 B1：属性可信度（unknown / probe-mismapped / probe）—— 卡片要显示它
      attrProvenance: meta.attrProvenance || '',
    })
  }
  out.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
  return out
}

/** 导入进度（前端轮询渲染「第 N/M 页」）——每次切完一页写一次，落在项目数据根下。 */
function importProgressPath(root) { return root ? path.join(root, 'import-progress.json') : '' }
function readImportProgress(root) {
  const p = importProgressPath(root)
  if (!p) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
/** 取消标记：前端在导入中点「取消」时置位；导入循环在两页之间检查它。 */
function importCancelPath(root) { return root ? path.join(root, 'import-cancel.txt') : '' }

export function activate() {
  return {
    /**
     * 现状：实例/探针状态 + **项目内的数据包列表** + 当前选中。
     * 单一数据源 = `<projectPath>/.modmind/mc-capture/`（见文件头的说明）。
     */
    pull_status: (input) => {
      // ★ 被选中实例缺失（没客户端 jar）不能让整个 status 崩掉 —— 面板要能照常渲染"扫描卡 + 实例清单"，
      //   把"没有可用实例"作为一个明确的空态呈现，而不是一片报错。
      let instanceDir = '', clientJar = '', instanceError = ''
      try {
        const j = jars(input && input.instanceDir)
        instanceDir = j.instanceDir; clientJar = j.clientJar
      } catch (e) {
        instanceDir = String((input && input.instanceDir) || process.env.PREVIEW_INSTANCE || '')
        instanceError = String((e && e.message) || e)
      }
      const jar = probeJar()
      const projectPath = String((input && input.projectPath) || '')
      const root = captureRootOf(projectPath)
      const key = packKeyOf(instanceDir)
      const packs = root ? listPacks(root) : []
      const activeKey = root ? (activeKeyOf(root) || key) : ''
      // ★ 自动搜索：游戏内产物 + 可用实例（用户要求"直接加上自动搜索"）。
      //   也可以传 `probeDir` 显式指定一处（自测/旁路用）—— 那时只认它，不去扫盘。
      const explicitDump = dumpInfo(input && input.probeDir)
      const probeDumps = explicitDump ? [explicitDump] : findProbeDumps(projectPath)
      const best = probeDumps[0] || null
      // ★ 自动采集的判据（2026-10-10 用户："我的游戏自动采集呢"）：
      //   有游戏内产物，且它比"当前数据包"**新**（或当前还没有数据包）⇒ 就该自动导入一次。
      //   比较用的是"产物 index.json 的 mtime"和"数据包 meta.json 里的 capturedAt"，两个都在磁盘上、可复现。
      const activePack = packs.find((p) => p.key === activeKey) || null
      const newestDump = best ? { dir: best.dir, capturedAt: best.capturedAt, pages: best.pages, count: best.count } : null
      const needsImport = !!(newestDump && (!activePack || !activePack.capturedAt || newestDump.capturedAt > activePack.capturedAt))
      // ★ 扫描结果（P1：面板"知道有什么实例"的唯一来源）：真实去这些位置扫，实例/探针匹配全来自磁盘。
      const scanSources = MC_DIR ? [path.join(MC_DIR, 'versions')] : []
      for (const e of projectInstanceDirs(projectPath, false)) scanSources.push(e.dir)
      const instances = [
        ...findInstances(),
        ...projectInstanceDirs(projectPath, false).map((e) => describeInstance(e.label, e.dir, { kind: 'project', exists: e.exists })),
      ]
      if (instanceDir && !instances.some(e => path.resolve(e.dir) === path.resolve(instanceDir))) {
        instances.unshift(describeInstance(path.basename(instanceDir), instanceDir, { kind: 'selected' }))
      }
      const scan = { sources: scanSources, at: new Date().toISOString(), instances }
      // ★ 被选中实例的完整描述（loader/mc/probe/matched/lastLaunch/verdict）：第 2/3 步卡片按它渲染，
      //   探针能不能装、装没装、有没有产物 —— 全部来自真实扫描（同 describeInstance，不另起一套）。
      const selected = instanceDir ? describeInstance(path.basename(instanceDir), instanceDir, { kind: 'selected' }) : null
      return {
        instanceDir, clientJar, packKey: key, instanceError,
        projectPath, dataRoot: root,
        packs, activeKey,
        selected,
        // 兼容旧字段：items/icons 指"当前选中的包"
        items: (packs.find((p) => p.key === activeKey) || {}).count ?? 0,
        icons: (packs.find((p) => p.key === activeKey) || {}).icons ?? 0,
        // 自动采集：面板按这个决定要不要自己导一次（用户不用点任何按钮）
        needsImport, newestDump,
        activePackCapturedAt: activePack ? activePack.capturedAt : '',
        // ★ B2：REGISTRY 可能解析不到（''）—— 那时 path.dirname('') = '.'，会去查**当前目录**下的
        //   registry-ids.json（"看起来有结果、其实问错地方"）。显式守卫成 false。
        registryIdsSidecar: !!REGISTRY && fs.existsSync(path.join(path.dirname(REGISTRY), 'registry-ids.json')),
        // ★★ B2 / §0.6：把"每条路径从哪来"显示出来 —— 用户不该靠猜自己配没配对。
        //   source ∈ env | config（配置文件）| discovered（自动发现）| none（未找到）
        paths: pathsReport(),
        probeInstalled: !!(selected && selected.probe === 'matched'),
        probeSource: (selected && selected.matched) || jar,
        probeAvailable: !!(selected && selected.probe !== 'none'),
        // 导入分批进度（前端轮询渲染「第 N/M 页」；没有进行中的导入则为 null）
        importProgress: readImportProgress(root),
        // ★ 扫描：位置 + 时间 + 实例清单（含 loader/mc/probe/matched —— 全部来自真实扫描）
        scan,
        // 探针构建矩阵（磁盘上的 jar 文件名）—— 步骤 1 的「更换…」清单用
        probeBuilds: probeBuilds().map((b) => b.file),
        // 自动搜索的结果：找到几处、分别在哪、各多少页（按时间倒序，第一处就是导入时用的那处）
        probeDumps,
        probeBest: best,
        probeSearchRoots: [
          path.join(MC_DIR, 'versions', '*', '.modmind', 'probe', 'pull2'),
          path.join(MC_DIR, '.modmind'),
          path.join(instanceDir, '.modmind'),
          '（项目内测试实例）<project>/minecraft/.modmind/probe/pull2',
        ],
        // 可用实例 = <MC>/versions/* 里能跑的 + **ModMind 的隔离测试实例**（项目内 minecraft/run/…）
        instances,
        probeDump: best ? best.dir : '',
        probeReady: !!best,
      }
    },

    /** 切换"当前使用的数据包"（写 active.txt；预览包按它决定读哪个包） */
    pull_select: (input) => {
      const root = captureRootOf(String((input && input.projectPath) || ''))
      if (!root) throw new Error('缺少 projectPath（宿主没把项目路径传下来）')
      const key = packKey(String((input && input.key) || ''))
      if (!key) throw new Error('缺少 key')
      if (!fs.existsSync(path.join(root, 'packs', key))) throw new Error('没有这个数据包：' + key)
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, 'active.txt'), key)
      console.log('[mc-pull] 已切换数据包：' + key)
      return { activeKey: key, root }
    },

    /**
     * 导入取消开关（D-import-progress）：前端在导入中点「取消」→ on:true 置位取消标记；
     * 导入在每页之间检查它，命中即抛出、丢弃临时目录（正式数据包未被改动）。
     * on:false 在面板打开 / 导入结束时清位，避免上一会话的残留标记把新导入直接掐掉。
     */
    pull_cancel: (input) => {
      const root = captureRootOf(String((input && input.projectPath) || ''))
      if (!root) throw new Error('缺少 projectPath（宿主没把项目路径传下来）')
      const on = !!(input && input.on)
      const p = importCancelPath(root)
      try {
        if (on) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(p, String(Date.now())) }
        else fs.rmSync(p, { force: true })
      } catch { /* 磁盘不可写不致命 */ }
      console.log('[mc-pull] 导入取消标记 ' + (on ? '置位' : '清除'))
      return { cancel: on }
    },

    /** 清除某个数据包（**不可恢复**；前端必须二次确认） */
    pull_clear: (input) => {
      const root = captureRootOf(String((input && input.projectPath) || ''))
      if (!root) throw new Error('缺少 projectPath（宿主没把项目路径传下来）')
      const key = packKey(String((input && input.key) || ''))
      if (!key) throw new Error('缺少 key')
      const dir = path.join(root, 'packs', key)
      if (!fs.existsSync(dir)) throw new Error('没有这个数据包：' + key)
      let bytes = 0, files = 0
      for (const f of fs.readdirSync(path.join(dir, 'icons'), { withFileTypes: true })) {
        if (f.isFile()) { files++; try { bytes += fs.statSync(path.join(dir, 'icons', f.name)).size } catch { /* 忽略 */ } }
      }
      fs.rmSync(dir, { recursive: true, force: true })
      // 清除的就是"当前使用"时：把当前使用自动交给剩余的第一个包；没有剩余则清掉 active.txt。
      //（真机 2026-10-11：前端曾拦"当前包不能就地清除"，只有一个包时成了死胡同 —— 用户明确确认后应真的删。）
      if (activeKeyOf(root) === key) {
        const rest = listPacks(root)
        const next = rest.length ? rest[0].key : ''
        try {
          if (next) fs.writeFileSync(path.join(root, 'active.txt'), next)
          else fs.rmSync(path.join(root, 'active.txt'), { force: true })
        } catch { /* 忽略 */ }
      }
      console.log(`[mc-pull] 已清除数据包：${key}（${files} 张图标 / ${(bytes / 1048576).toFixed(1)} MB）`)
      return { cleared: true, key, files, bytes, activeKey: activeKeyOf(root) }
    },

    /**
     * 导出数据包（2026-10-11，用户要求「加一个导出数据包」）：
     * 把 packs/<key>/ 原样打成 store-zip，落盘到 <root>/exports/<key>-<stamp>.mmpack.zip。
     * 设计口径：
     *   · **落盘在项目目录内**（用户自己拿得到；面板日志给全路径 + 大小）；
     *   · 包内额外写 export-manifest.json（key / 导出时间 / 文件数 / 恢复说明）——
     *     解压后把 items.json / icons/ / meta.json 放回 packs/<key>/ 即可恢复；
     *   · 不压缩（PNG 已压缩）；条目名全部正斜杠。
     */
    pull_export_pack: (input) => {
      input = input || {}
      const root = captureRootOf(String(input.projectPath || ''))
      if (!root) throw new Error('缺少 projectPath（宿主没把项目路径传下来）')
      const key = packKey(String(input.key || '') || activeKeyOf(root))
      if (!key) throw new Error('没有可导出的数据包（还没采集过）')
      const dir = path.join(root, 'packs', key)
      if (!fs.existsSync(dir)) throw new Error('没有这个数据包：' + key)
      const files = []
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const r = rel ? rel + '/' + e.name : e.name
          projectDataPath(input.projectPath, `packs/${key}/${r}`)
          if (e.isDirectory()) walk(path.join(d, e.name), r)
          else files.push({ name: r, data: fs.readFileSync(path.join(d, e.name)) })
        }
      }
      walk(dir, '')
      if (!files.length) throw new Error('数据包是空的：' + key)
      const icons = files.filter((f) => f.name.startsWith('icons/')).length
      const at = new Date().toISOString()
      // 口径：manifest.files 记为**内容文件数**（求值在 push 之前，不含 manifest 自身）；
      // 返回值 count = zip 总条目数（= 内容文件 + 1）。两处不同名不同义，别当 bug 修。
      files.push({
        name: 'export-manifest.json',
        data: Buffer.from(JSON.stringify({
          format: 'modmind-capture-pack', version: 1, key, exportedAt: at,
          files: files.length, icons,
          note: '解压后把 items.json / icons/ / meta.json 放回 <项目>/.modmind/mc-capture/packs/<key>/ 即可恢复。',
        }, null, 2), 'utf8'),
      })
      const buf = storeZip(files)
      const outDir = path.join(root, 'exports')
      projectDataPath(input.projectPath, 'exports')
      fs.mkdirSync(outDir, { recursive: true })
      const stamp = at.replace(/[-:T]/g, '').slice(0, 12)
      const out = path.join(outDir, key + '-' + stamp + '.mmpack.zip')
      projectDataPath(input.projectPath, 'exports/' + path.basename(out))
      fs.writeFileSync(out, buf)
      console.log(`[mc-pull] 已导出数据包：${key} → ${out}（${files.length} 个文件 / ${(buf.length / 1048576).toFixed(2)} MB）`)
      return { file: out, bytes: buf.length, count: files.length, icons, key, at }
    },

    /**
     * 一键启动游戏（**真启动**，不是引导）：用实例自己的版本 json 拼出启动命令、spawn 后脱离。
     * 参数做法与 PCL 的 `LatestLaunch.bat` 逐项对齐（同一台机器验证过的可用命令）。
     * dryRun / 闸门 env PREVIEW_LAUNCH_DRYRUN=1 时只返回命令、不真的启动。
     */
    pull_launch: (input) => {
      input = input || {}
      const { instanceDir } = jars(input.instanceDir)
      // ★ M2：启动前自检 —— 探针在但采集配置缺失/mode 不对 ⇒ 先补齐再启动（防"先启动后装探针/顺序手滑"）。
      //   探针不在则不写（没有 jar 的配置是孤儿，会误导排查）。
      let probeConfigFixed = false
      let probeConfigMode = ''
      try {
        const cfgPath = path.join(instanceDir, '.modmind', 'probe', 'probe-config.json')
        try { probeConfigMode = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mode || '' } catch { probeConfigMode = '' }
        const hasProbe = fs.readdirSync(path.join(instanceDir, 'mods')).some((f) => /^modmind-probe.*\.jar$/i.test(f))
        if (hasProbe && probeConfigMode !== 'pull') {
          writeProbeConfig(instanceDir)
          probeConfigFixed = true
          probeConfigMode = 'pull'
          console.log('[mc-pull] 启动自检：探针在但采集配置缺失/不对，已补齐 mode=pull')
        }
      } catch { /* 自检失败不阻断启动；产物形态校验会在面板侧兜底解释 */ }
      const dry = input.dryRun === true || process.env.PREVIEW_LAUNCH_DRYRUN === '1'
      const plan = buildLaunchPlan(instanceDir, { maxMemoryMb: input.maxMemoryMb })
      if (dry) {
        return {
          dryRun: true, instanceDir, java: plan.java, memMb: plan.memMb, cpCount: plan.cpCount,
          command: plan.display, probeConfigFixed, probeConfigMode,
          note: '（dryRun：只构建了启动命令，没有真的启动）' + (probeConfigFixed ? ' 自检补齐了采集配置（mode=pull）。' : ''),
        }
      }
      if (lastSpawn.pid && lastSpawn.instanceDir === instanceDir && (Date.now() - lastSpawn.at) < 60000) {
        let alive = false
        try { process.kill(lastSpawn.pid, 0); alive = true } catch (e) { alive = !!(e && e.code === 'EPERM') }
        if (alive) {
          return { launched: false, pid: lastSpawn.pid, instanceDir, note: '这个实例刚启动过（java PID ' + lastSpawn.pid + '），看起来还在跑——没有重复启动。' }
        }
      }
      const child = spawn(plan.java, plan.args, { cwd: instanceDir, detached: true, stdio: 'ignore' })
      child.unref()
      lastSpawn = { pid: child.pid, instanceDir, at: Date.now() }
      console.log('[mc-pull] 已启动游戏：' + instanceDir + '（java PID ' + child.pid + ' · Xmx' + plan.memMb + 'm）')
      return {
        launched: true, pid: child.pid, instanceDir, java: plan.java, memMb: plan.memMb,
        probeConfigFixed, probeConfigMode,
        note: '游戏正在启动（java PID ' + child.pid + '）——窗口会自己打开，拉起到主界面即可退出；探针产出后自动导入。' +
          (probeConfigFixed ? ' 启动前自检补齐了采集配置（mode=pull）。' : ''),
      }
    },

    /**
     * 自动获取本地游戏数据（**免探针、免启动游戏**，2026-10-11 用户实机反馈后成为默认）：
     *   方块 id（注册表侧车）∪ 语言文件物品/方块键（中文名），图标直接从实例贴图烤。
     *   采集面板在"项目内一个数据包都没有"时自动调它，用户对"路线"无感知。
     *
     * 与游戏内探针的关系（**不是两条让用户选的路线**）：
     *   · 本路线 = 基础版（贴图直烤；运行期染色物品如 GT 材料色拿不到，无贴图的条目丢弃并计数）；
     *   · 探针导入（pull_import_probe）= 高保真，写**同一个 key** 的数据包直接覆盖升级。
     */
    pull_run: (input) => {
      input = input || {}
      // A recollection may read a replaced JAR at the same path.
      texCache.jar = ''; texCache.buf = null; texCache.byName = null
      const { instanceDir, jars: list, clientJar: clientJarName } = jars(input.instanceDir)
      const { names, items, tex, blockIds } = scanAssets(list)

      // 落点：项目内 packs/<实例名>/（与探针导入同 key ⇒ 高保真可直接覆盖升级）；
      //   显式 outDir 留给自测旁路；两者都没有才退回旧 DATA_DIR。
      const key = packKeyOf(instanceDir)
      const root = input.projectPath ? captureRootOf(String(input.projectPath)) : ''
      // ★ B2：三种落点都没有时**不能**拼出一个相对路径写到 CWD 里去（那是最坏的一种"静默"）。
      const outDir = input.outDir || (root ? path.join(root, 'packs', key) : DATA_DIR)
      if (!outDir) {
        requirePath('DATA_DIR', '既没有项目路径（projectPath）、也没传 outDir、配置里也没有 DATA_DIR —— 没有落点')
      }
      const isPack = !!(root || input.outDir)

      // ① 条目集合：注册表里的方块 ∪ 语言文件里的物品 ∪ 已有 items.json（尽量不丢）
      // ★ B2 / §0.6：这里原来是 `catch { /* 不致命 */ }` —— 降级本身合理（候选集会退到"语言文件里的键"），
      //   但**静默**吞掉原因就不合理了：候选数会明显缩水（本机实测注册表侧 9,374 条），而用户看不到任何提示。
      //   ⇒ 保留降级，但把原因**带进返回值**（进而在日志里显示）。
      let regIds = []
      let regWarning = ''
      try { regIds = regBlockIds() } catch (e) {
        regWarning = '方块注册表不可用（' + String((e && e.message) || e).split('\n')[0] + '）'
          + ' ⇒ 本次候选只来自语言文件里的键，可能少一部分方块。修法见面板「路径与来源」。'
      }
      const ids = new Set()
      const isBlock = new Set()
      for (const id of regIds) { ids.add(id); isBlock.add(id) }
      for (const id of blockIds) { ids.add(id); isBlock.add(id) }
      for (const id of items) ids.add(id)
      const oldPath = path.join(outDir, 'items.json')
      // 旧产物：条目要求并集（不丢），**名字也留底** —— 语言文件覆盖不到的名字（游戏内真名、
      // 或 mod 用了自定义翻译）就用旧的那份，别退化成裸 id。
      const oldNames = new Map()
      if (fs.existsSync(oldPath)) {
        try {
          const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'))
          const oids = old.ids || []
          for (let i = 0; i < oids.length; i++) {
            ids.add(oids[i])
            if (old.names && old.names[i]) oldNames.set(oids[i], old.names[i])
          }
        } catch { /* 旧文件坏了就忽略 */ }
      }
      const all = [...ids].sort()

      // ② 烤图标
      const iconsDir = path.join(outDir, 'icons')
      fs.mkdirSync(iconsDir, { recursive: true })
      const maxIcons = Number((input && input.maxIcons) || 0) || Infinity   // 便于快速自测
      const names2 = [], icons = [], blocks = [], keptIds = []
      // ★ 硬不变量：写进 items.json 的每一条**都必须有对应的图标文件**。
      //   旧版把"没图标"的条目也写进清单 —— 实测出过 23803 条清单 vs 18284 张图（**5519 条空白格子**），
      //   清单与 icons/ 不一致，物品栏里一大片空白，看着就像坏了。所以只收"有图标"的条目，
      //   丢弃数量明确回报（不静默）。想要更多条目就走 Java 路线（它有 100% 图标）。
      let baked = 0, kept = 0, dropped = 0
      for (const id of all) {
        const ci = id.indexOf(':')
        const ns = id.slice(0, ci), name = id.slice(ci + 1)
        const file = `${ns.replace(/[^\w.-]/g, '_')}__${name.replace(/[^\w.-]/g, '_')}.png`
        const dst = path.join(iconsDir, file)
        if (input.projectPath) projectDataPath(input.projectPath, `packs/${key}/icons/${file}`)
        const ref = tex.get(`${ns}:item/${name}`) || tex.get(`${ns}:block/${name}`) || tex.get(`${ns}:block/${name}_top`)
        if (fs.existsSync(dst) && (!ref || baked >= maxIcons)) {
          kept++
        } else {
          const src = ref ? readTexRef(ref) : null
          let okGo = false
          if (src && baked < maxIcons) {
            try {
              const im = scale(decode(src), 3)
              fs.writeFileSync(dst, encodeRGBA(im.width, im.height, im.data))
              baked++
              okGo = true
            } catch { okGo = false }
          }
          if (!okGo) { dropped++; continue }   // 没图标 ⇒ 不进清单（清单与磁盘必须一一对应）
        }
        names2.push(names.get(id) || oldNames.get(id) || name)
        blocks.push(isBlock.has(id))
        icons.push(file)
        keptIds.push(id)
      }

      // ③ 落盘（字段名与既有 items.json 一致 ⇒ 3D 预览功能包直接能读）
      const payload = {
        count: keptIds.length, ids: keptIds, names: names2, block: blocks, icons,
        maxStack: new Array(keptIds.length).fill(null),
        damageable: new Array(keptIds.length).fill(null),
        // ★ 2026-10-12 B1（规范 §0.6「失败必须可见」）：免探针路线**没有属性来源** ——
        //   堆叠上限/耐久写在游戏代码里，静态读 jar 拿不到。原来这里写的是 fill(64)/fill(false)，
        //   那是**把"未知"冒充成"已知"**（§5.4 明令禁止无上下文的兼容布尔值）。
        //   实测影响是真的：用户手上那份产物 18,284 条 maxStack 全是 64，而消费点
        //   `app/app.js` 的 `maxStackOf = (i) => ITEMS.maxStack[i] || 64` 用它做**堆叠**判定
        //   ⇒ 钻石镐/桶这类本该叠 1 的会叠到 64。
        //   现在：null = 显式未知（下游 `x || 64` 仍得 64，行为不变）；再用下面两个字段把"为什么"写出来。
        attrProvenance: 'unknown',
        attrNote: '本包只采集了 id / 中文名 / 图标 / 是否方块；物品属性（堆叠上限、是否可损坏）写在游戏代码里，'
          + '静态读 jar 拿不到 ⇒ 全部是未知（null），不是 64/false。装游戏内探针并启动一次游戏可取得。',
        iconPx: 48, pxPerTexel: 3,
        source: 'mc-pull local-assets ' + instanceDir,
      }
      fs.writeFileSync(oldPath, JSON.stringify(payload))
      let becameActive = false
      if (isPack) {
        fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
          key, title: path.basename(instanceDir), instanceDir,
          source: 'local-assets', fidelity: 'basic', attrProvenance: 'unknown',
          capturedAt: new Date().toISOString(),
          count: keptIds.length, icons: keptIds.length, iconPx: 48,
        }, null, 2))
        if (root) { try { fs.writeFileSync(path.join(root, 'active.txt'), key); becameActive = true } catch { /* 忽略 */ } }
      }
      const sum = baked + kept + dropped
      console.log(`[mc-pull] 本地直读：候选 ${all.length} → 落盘 ${keptIds.length} 条（新烤 ${baked} / 复用 ${kept} / 丢弃无图标 ${dropped}）→ ${oldPath}`)
      return {
        outDir, target: outDir, key, candidates: all.length, count: keptIds.length, baked, kept, dropped,
        /** 恒等式：baked + kept + dropped === candidates */
        balanced: sum === all.length,
        langNames: names.size, textures: tex.size, jars: list.length, clientJar: clientJarName,
        registryIds: regIds.length,
        /** 非空表示"这次降级了、且为什么"（§0.6：降级必须可见） */
        registryWarning: regWarning,
        registryIdsSidecar: fs.existsSync(path.join(path.dirname(REGISTRY), 'registry-ids.json')),
        source: 'local-assets', active: becameActive,
        note: [
          `已直接从本地游戏文件获取 ${keptIds.length} 条（方块/物品中文名 + 贴图图标，不用启动游戏）。`,
          dropped ? `其中 ${dropped} 条没有可用贴图图标已跳过（清单与 icons/ 必须一一对应）；装游戏内探针并启动一次游戏，可自动升级为游戏内真渲染图标（含运行期染色物品），并补齐这些条目。`
                  : '装游戏内探针并启动一次游戏，可自动升级为游戏内真渲染图标（含运行期染色物品）。',
        ].join(' '),
      }
    },

    /** 把游戏内探针装进实例 mods/（下次启动游戏产出高保真数据） */
    pull_install_probe: (input) => {
      input = input || {}
      // ★ 目标实例 = 面板选中的那个（显式 instanceDir）；没传才退回环境变量/自动搜。
      //   装之前先按该实例的**真实**（loader × MC 版本）匹配构建 —— 不再"挑版本号最大"（那会装错平台）。
      const { instanceDir } = jars(input.instanceDir)
      const { loader, mc } = instanceLoaderMc(instanceDir)
      const build = probeJarFor(loader, mc)
      if (!build) {
        throw new Error('暂无适配构建：「' + path.basename(instanceDir) + '」是 ' + (loader || '未知加载器') + ' ' + (mc || '未知版本') +
          ' —— 当前没有适配它的探针构建。可以换一个受支持平台的实例，或等后续版本提供支持。')
      }
      const jar = build.path
      if (!fs.existsSync(jar)) throw new Error('找不到探针 jar：' + jar)
      const want = build.file
      // ★ 装到**所有会被启动的实例**：
      //   ① 选中的那个实例（`<MC>/versions/<名字>` 或项目内测试实例）；
      //   ② **ModMind 的隔离测试实例**（侧边栏「测试与构建」启动的就是它，目录是 `<项目>/minecraft`）。
      //   只装 ① 是不够的 —— 宿主启动的是它自己准备的隔离实例（2026-10-10 用户问"我怎么去启动它"时查出来的）。
      const targets = [{ dir: instanceDir, label: '版本实例 ' + path.basename(instanceDir) }]
      const installed = []
      const removed = []
      for (const t of targets) {
        const modsDir = path.join(t.dir, 'mods')
        try { fs.mkdirSync(modsDir, { recursive: true }) } catch { continue }
        // 同一个 mod id 的**多个版本共存**会让 Forge 直接不加载 ⇒ 装新版时先清掉其它版本
        try {
          for (const f of fs.readdirSync(modsDir)) {
            if (!/^modmind-probe.*\.jar$/i.test(f) || f === want) continue
            try { fs.rmSync(path.join(modsDir, f), { force: true }); removed.push(t.label + '/' + f) } catch { /* 占着就留着 */ }
          }
        } catch { /* 读不了就跳过 */ }
        const dst = path.join(modsDir, want)
        try {
          fs.copyFileSync(jar, dst)
          // ★ 一体动作：jar 就位后立刻写采集配置（缺配置 ⇒ 探针跑成 placement，2026-10-11 事故）。
          //   配置写不进 ⇒ 本目标不算装成功（进 missing 让面板提示重试），绝不留"装了但不会采"的半装。
          const cfg = writeProbeConfig(t.dir)
          installed.push({ label: t.label, path: dst, configAt: cfg.configAt })
        } catch (e) {
          console.log('[mc-pull] 目标安装失败：' + t.label + ' — ' + (e && e.message ? e.message : e))
        }
      }
      console.log('[mc-pull] 探针已装：' + installed.map((x) => x.label).join(' / ') + (removed.length ? '（清掉旧版本 ' + removed.join(', ') + '）' : ''))
      return {
        installed: installed.length > 0,
        targets: installed,
        target: installed[0] ? installed[0].path : '',
        configAt: installed[0] ? installed[0].configAt : '',
        missing: targets.filter((t) => !installed.some((x) => x.label === t.label)).map((t) => t.label),
        source: jar, removed,
        loader, mc, matched: want, probeAt: probeInstalledAt(instanceDir).at,
        note: (build.mode === 'unverified'
          ? '⚠ 这个构建的声明范围覆盖你的 ' + mc + '，但**我们没在这个版本上实测过**：装得上不等于跑得通，失败请回报。\n'
          : '') + '探针与采集配置（mode=pull）已就位。现在到 ModMind 侧边栏的「测试与构建」里启动一次客户端（它会准备并运行那个隔离测试实例）' +
          '；探针会在游戏内导出数据到该实例的 `.modmind/probe/pull2`，面板会自动搜到并导入。' +
          (removed.length ? ` 已清掉同 mod 的旧版本：${removed.join('、')}。` : ''),
      }
    },

    /**
     * Java 采集适配：把游戏内探针（Pull.java）导出的产物转成正式的数据目录。
     *
     * 探针在游戏里做的事，Node 侧做不到或做不真：
     *   · 物品的**游戏内显示名**（跟随 mod 本地化，`ItemStack.getHoverName()`）；
     *   · 每个物品**真渲染出来的 48px 图标**（含 3D 模型、运行期染色，如 GT 的材料色）；
     *   · **真 alpha**（同一页在洋红/黑/灰/白 4 个背景下各渲染一次，逐像素解 O = a + slope·B）。
     * 这里只负责把 pull2 目录切成 icons/ + items.json（逻辑与 `src/build-icons.mjs` 同一份实现）。
     */
    pull_import_probe: async (input) => {
      input = input || {}
      const { instanceDir } = jars(input.instanceDir)
      const projectPath = String(input.projectPath || '')
      // ★ 自动搜索：不传 probeDir 时，扫整个 .minecraft 树找"游戏内产物"，用**最新的一处**。
      //   （用户："直接加上自动搜索" —— 以前只认当前实例那一个路径，别处启动过游戏也找不到。）
      const found = input.probeDir ? [dumpInfo(input.probeDir)].filter(Boolean) : findProbeDumps(projectPath)
      const src = input.probeDir || (found[0] && found[0].dir) || probePull2(instanceDir)
      const idxPath = path.join(src, 'index.json')
      // ★ 边界报错（规格 1.3 第 5 条，顺序有讲究，两句话各自指向正确的下一步动作）：
      //   ① 先判探针装没装 —— 没装就说"实例没启动"会把人引偏（他会去启动，但探针根本没装、什么也不会产生）；
      //   ② 再看产物在不在 —— 探针装了但没有 index.json = 探针从没运行过（实例还没启动过 / 启动失败）。
      let modJars = []
      try { modJars = fs.readdirSync(path.join(instanceDir, 'mods')) } catch { /* 没有 mods 目录 */ }
      const hasProbeJar = modJars.some((f) => /^modmind-probe.*\.jar$/i.test(f))
      if (!fs.existsSync(idxPath)) {
        if (!hasProbeJar) {
          throw new Error('还没装探针：这个实例的 mods/ 里没有探针（' + path.join(instanceDir, 'mods') + '）。请先在「第 2 步 装游戏内真渲染探针」把它装上。')
        }
        throw new Error('实例还没启动：探针已装，但没在 ' + src + ' 找到产物（index.json）。请到 ModMind 侧边栏的「测试与构建」启动一次装了探针的客户端，让探针运行后再回到这里。')
      }
      const totalPages = Number(JSON.parse(fs.readFileSync(idxPath, 'utf8')).pages) || 0
      const maxPages = input.maxPages ? Number(input.maxPages) : 0
      const partial = maxPages > 0 && maxPages < totalPages
      const key = packKeyOf(instanceDir)
      // ★ 数据落点：**项目内**的 packs/<key>/（同 key 覆盖、不同实例分离），见文件头说明。
      //   显式 outDir 仍然尊重（自测/旁路用）；完全部分导入走 partial-<时间戳>，**不碰正式包**。
      const explicit = !!input.outDir
      const root = captureRootOf(projectPath) || process.env.PREVIEW_CAPTURE_ROOT || ''
      if (!explicit && !root) throw new Error('缺少 projectPath：宿主没把项目路径传下来，无法定位「项目内的采集数据」目录')
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const outDir = explicit ? input.outDir
        : (partial ? path.join(root, 'partial-' + stamp) : path.join(root, 'packs', key))

      // ★ 分批进度 + 取消（规格 1.3 第 4 条）：每切完一页写一次 import-progress.json（前端轮询渲染「第 N/M 页」），
      //   并在两页之间检查取消标记 —— buildIcons 在每页 `await onPage`，事件循环得以喘息，
      //   并行送达的 /invoke（轮询 / 取消）才可能被执行（同步阻塞时它们根本进不来）。
      const progressPath = importProgressPath(root)
      const cancelPath = importCancelPath(root)
      const writeProgress = (o) => {
        if (!progressPath) return
        try { fs.writeFileSync(progressPath, JSON.stringify({ ...o, at: new Date().toISOString() })) } catch { /* 写不了不致命 */ }
      }
      try { if (cancelPath) fs.rmSync(cancelPath, { force: true }) } catch { /* 清掉上一会话的残留取消标记 */ }
      writeProgress({ page: 0, totalPages, items: 0, totalItems: 0, state: 'importing', key, outDir })
      let report
      try {
        report = await buildIcons({
          pull2: src, outDir,
          outPx: input.outPx,
          maxPages: input.maxPages,
          log: (m) => console.log('[mc-pull]' + m),
          onPage: async (page, pages, items) => {
            if (cancelPath && fs.existsSync(cancelPath)) throw new Error('已取消（数据包未被改动）')
            writeProgress({ page, totalPages: pages, items, totalItems: 0, state: 'importing', key, outDir })
            await new Promise((r) => setImmediate(r))
          },
        })
      } catch (e) {
        const cancelled = /已取消/.test(String(e && e.message))
        writeProgress({ page: 0, totalPages, items: 0, totalItems: 0, state: cancelled ? 'cancelled' : 'error', key, outDir })
        try { if (cancelPath) fs.rmSync(cancelPath, { force: true }) } catch { /* 忽略 */ }
        throw e
      }
      writeProgress({ page: report.pages, totalPages: report.totalPages, items: report.count, totalItems: report.count, state: 'done', key, outDir })
      try { if (cancelPath) fs.rmSync(cancelPath, { force: true }) } catch { /* 忽略 */ }

      const rz = report.residual || {}
      const residualNote = rz.ok === false
        ? `⚠ 回归残差超阈值：worst=${Number(rz.worst).toFixed(2)} > ${rz.threshold}（${rz.overCount} 个图标超差` +
          ((rz.over || []).length ? `，例：${rz.over.slice(0, 3).map((o) => o.id + ' ' + o.worst).join('；')}` : '') +
          '）—— 这些图标的 alpha 解可能不可信。'
        : ''
      const isPack = !explicit && !partial
      let becameActive = false
      if (isPack) {
        const title = path.basename(instanceDir)
        fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
          key, title, instanceDir, source: 'probe:pull2',
          // ★ 2026-10-12 B1：把"属性可信度"写进 meta（§0.6「失败必须可见」）。
          //   fidelity 'probe' = 这一包来自**游戏内探针**；attrProvenance 'probe-mismapped' =
          //   探针的 maxStack/damageable 两个字段取错了 API（见 src/build-icons.mjs 的 B10 注释）
          //   ⇒ 这两列**不可信**，别当"堆叠上限 / 可损坏"使。
          fidelity: 'probe', attrProvenance: 'probe-mismapped',
          capturedAt: new Date().toISOString(),
          count: report.count, pages: report.pages, totalPages: report.totalPages,
          iconPx: report.iconPx, pxPerTexel: report.pxPerTexel,
          residual: { worst: rz.worst ?? null, threshold: rz.threshold ?? null, ok: rz.ok !== false },
        }, null, 2))
        // 采完就把它设为"当前使用的数据包"——用户刚采完，下一步就是去看它
        try { fs.writeFileSync(path.join(root, 'active.txt'), key); becameActive = true } catch { /* 忽略 */ }
      }
      console.log(`[mc-pull] 游戏内数据已导入：${report.count} 条 / ${report.pages}${report.totalPages ? '/' + report.totalPages : ''} 页 → ${outDir}`)
      return {
        ...report,
        source: 'probe:pull2',
        key,
        probeDir: src,
        probeFound: found.length,
        dataRoot: root || '',
        target: outDir,
        active: becameActive,
        residualOk: rz.ok !== false,
        note: [
          `数据源：${src}（自动搜索到 ${found.length} 处游戏内产物，用最新的一处）`,
          isPack
            ? `已写入项目内的数据包「${path.basename(instanceDir)}」${becameActive ? '，并设为当前使用' : ''}（同一条游戏路径再次采集会直接覆盖它；换版本/整合包会另外存一份）。`
            : (partial ? `只切了前 ${report.pages}/${report.totalPages} 页 ⇒ 写到旁路目录，没有动正式数据包。` : `写到指定目录 ${outDir}。`),
          residualNote,
        ].filter(Boolean).join(' '),
      }
    },

    /**
     * ★ 纯函数的测试出口（2026-10-12 P0.1）：把"版本比较 / 范围解析"暴露出来，
     *   好让 `.work/test-range.mjs` 能在**不造合成实例**的前提下直接断言它们，
     *   并且能做变异（把 segCmp 换成字符串比较 ⇒ 断言必红）。
     *   命名用 `__test` 前缀，明确它不是产品能力。
     */
    __test: {
      segCmp, mcSegs, parseRangeSpec, rangeCovers, jarDeclaredRange, probeJarFor, probeBuilds,
    },
  }
}
