// scene-assets.mjs —— 「用户实例 → Deepslate 资源」的正确流水线（Node，零依赖）
//
// 它同时干两件事：
//   ① 修掉预演管线 `extract/build-assets3.py` 的两个 bug：
//      · 引用过滤只认带命名空间的 `"ns:block/x"`，而原版模型绝大多数写作 `"block/x"`（相对自身命名空间）
//        ⇒ 本版按 MC 语义解析：值不含 ':' 时按**模型自身命名空间**补全；收 textures/ 下**全部类别**（含 item/、part/）。
//      · 按内容去重时把同内容的其余路径整条丢掉 ⇒ 本版**每条路径都保留 UV**，同内容的多条路径共用同一矩形（别名）。
//   ② 支持**按需打包**：只给一批方块状态，就只解析它们用到的 blockstates/models/textures，并现打一张
//      恰好装得下的 **2 的幂**方形图集（Deepslate 硬要求 2 的幂）。
//
// MC 语义要点（照着实现，不猜）：
//   · variants 的键是"子集匹配"，多个命中时取**最具体**（键里属性对最多）的那个；
//   · multipart 的 when 支持 OR / AND 与 `a|b` 多值；
//   · 模型的 textures 沿 parent 链合并（子覆盖父），`#ref` 在合并后的表里解引用（可多级）；
//   · 一个模型的 elements 可能来自祖先 ⇒ 链上所有模型的 elements 都要收，且都用**合并后的表**解引用。
import fs from 'node:fs'
import { mcRoot } from '../src/paths.mjs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { listEntries } from '../src/zipread.mjs'
import { decode, encodeRGBA } from '../src/png.mjs'
import { defaultPropsOf } from './src/defaults.js'
// 状态推断（连接/附着/朝向）——打包侧也要用：**会被推断改状态的方块必须把模型收全**，
// 否则推断出的 state 在资源里没有模型（Deepslate 静默跳过 ⇒ "放了看不见"）。见 buildForStates。
import { classOf, schemaOf } from './src/statelogic.js'

const readEntryFast = (buf, e) => {
  const p = e.localOffset
  const nl = buf.readUInt16LE(p + 26), el = buf.readUInt16LE(p + 28)
  const s = p + 30 + nl + el
  const d = buf.subarray(s, s + e.compressedSize)
  if (e.method === 0) return Buffer.from(d)
  if (e.method === 8) return zlib.inflateRawSync(d)
  throw new Error('zip method ' + e.method)
}

/** "minecraft:oak_stairs[facing=north,half=bottom]" → { id, props } */
export function parseState(s) {
  const i = s.indexOf('[')
  if (i < 0) return { id: s, props: {} }
  const props = {}
  for (const kv of s.slice(i + 1, s.lastIndexOf(']')).split(',')) {
    const j = kv.indexOf('=')
    if (j > 0) props[kv.slice(0, j)] = kv.slice(j + 1)
  }
  return { id: s.slice(0, i), props }
}
const nsOf = (id) => id.split(':', 1)[0]
const withNs = (v, ns) => (v.includes(':') ? v : `${ns}:${v}`)

/** 自动找一个可用实例：versions 下"含 mods/ 且有客户端 jar"的目录，优先 GregTech */
// ★ B2：默认值改走解析器（原来是写死的 'E:/mc/.minecraft'）。
//   默认参数是**每次调用时**求值的 ⇒ 这里必须调函数、不能缓存成常量。
export function findInstanceDir(mcDir = mcRoot()) {
  const versions = path.join(mcDir, 'versions')
  if (!fs.existsSync(versions)) throw new Error('找不到 versions 目录：' + versions)
  const cands = fs.readdirSync(versions)
    .map((n) => path.join(versions, n))
    .filter((d) => fs.existsSync(path.join(d, 'mods')) && fs.readdirSync(d).some((f) => f.endsWith('.jar')))
  if (!cands.length) throw new Error('versions 下没有"含 mods/ 与客户端 jar"的实例')
  return cands.find((d) => /GregTech/i.test(d)) || cands[0]
}

function matchVariant(variants, props) {
  let best = null, bestN = -1
  for (const [key, value] of Object.entries(variants)) {
    const pairs = key.split(',').map((x) => x.trim()).filter(Boolean)
    let ok = true
    for (const p of pairs) {
      const eq = p.indexOf('=')
      if (eq < 0) { ok = false; break }
      if (props[p.slice(0, eq)] === undefined || String(props[p.slice(0, eq)]) !== p.slice(eq + 1)) { ok = false; break }
    }
    if (ok && pairs.length > bestN) { best = value; bestN = pairs.length }
  }
  return best
}
// （原 matchWhen 已删除，2026-10-12）它唯一的调用点是为 multipart **按 state 精确匹配**，
// 而那条路径现在改成"multipart 一律收全"（见 buildForStates 的注释：形状会随状态变，
// 按 state 收就会在推断出新 state 时缺模型）。留个记号免得有人以为它是被误删。
/** 一个 blockstate 定义里**全部**（不判属性）模型引用 —— 全量打包用 */
function allModelsOf(bs) {
  const out = []
  for (const v of Object.values(bs.variants || {})) for (const it of Array.isArray(v) ? v : [v]) if (it?.model) out.push(it.model)
  for (const part of bs.multipart || []) for (const it of Array.isArray(part.apply) ? part.apply : [part.apply]) if (it?.model) out.push(it.model)
  return out
}

/** guillotine BSSF：在 size×size 里放 w×h */
function packer(size) {
  const free = [{ x: 0, y: 0, w: size, h: size }]
  return (w, h) => {
    let best = -1, bestScore = Infinity
    for (let i = 0; i < free.length; i++) {
      const f = free[i]
      if (f.w < w || f.h < h) continue
      const dw = f.w - w, dh = f.h - h
      const score = Math.min(dw, dh) * 4096 + Math.max(dw, dh)
      if (score < bestScore) { bestScore = score; best = i }
    }
    if (best < 0) return null
    const f = free.splice(best, 1)[0]
    const dw = f.w - w, dh = f.h - h
    if (dw > dh) free.push({ x: f.x + w, y: f.y, w: dw, h }, { x: f.x, y: f.y + h, w, h: dh })
    else free.push({ x: f.x, y: f.y + h, w, h: dh }, { x: f.x + w, y: f.y, w: dw, h: f.h })
    return { x: f.x, y: f.y }
  }
}

export function createSceneAssets({ instanceDir, mcDir = mcRoot(), pad = 2, log = () => {}, registryPath = '' } = {}) {
  if (!instanceDir) throw new Error('createSceneAssets 需要 instanceDir（实例目录，例如 …/versions/GregTech Leisure）')
  let DB = null

  // ---- 方块注册表（可选，但强烈建议）：id → **默认态属性** ----
  // 来源是 `data/registry-defaults.json`（从 42 MiB 的 vanilla-registry.json 抽出的侧车，实测 4,182 个方块有默认态、
  // 其中 3,540 个是 mod 方块）。有它就用它（权威）；没有才退回 `defaultPropsOf` 的近似推导。
  let REG = undefined
  function registry() {
    if (REG !== undefined) return REG
    REG = null
    // 路径来源三选一：显式 registryPath → 环境变量 → 相对模块（**打成 bundle 后 import.meta.url 会失效**，
    // 功能包里必须靠前两条；这是"功能包里注册表没加载"的原因）
    const cands = []
    if (registryPath) cands.push(registryPath)
    if (process.env.PREVIEW_REGISTRY) cands.push(process.env.PREVIEW_REGISTRY)
    try { cands.push(fileURLToPath(new URL('./data/registry-defaults.json', import.meta.url))) } catch { /* bundle 里没有 import.meta.url */ }
    for (const p of cands) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (j && typeof j === 'object') { REG = j; break }
      } catch { /* 换下一个 */ }
    }
    log(REG ? `注册表：${Object.keys(REG).length} 个方块的默认态` : '注册表不可用（用近似推导）：试过 ' + cands.join(' / '))
    return REG
  }

  // ---- 渲染层侧车（`registry-layers.json`，与默认态侧车同目录）----
  // ★ 判断"该不该走半透明通道"必须看**渲染层**（translucent / cutout / solid），不能看贴图有没有 alpha：
  //   实测 `oak_leaves` 是 solid、`glass` 是 cutout，用 alpha 启发式会把它们错误地丢进混合通道 ⇒ 发灰、"像材质丢了"。
  let LAY = undefined
  function layers() {
    if (LAY !== undefined) return LAY
    LAY = null
    const cands = []
    if (registryPath) cands.push(path.join(path.dirname(registryPath), 'registry-layers.json'))
    if (process.env.PREVIEW_REGISTRY) cands.push(path.join(path.dirname(process.env.PREVIEW_REGISTRY), 'registry-layers.json'))
    try { cands.push(fileURLToPath(new URL('./data/registry-layers.json', import.meta.url))) } catch { /* bundle 里没有 */ }
    for (const p of cands) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (j && typeof j === 'object') { LAY = j; break }
      } catch { /* 换下一个 */ }
    }
    log(LAY ? `渲染层：${Object.keys(LAY).length} 个方块` : '渲染层不可用（退回 alpha 启发式）')
    return LAY
  }

  // ---- 开面剔除侧车（`registry-opaque.json`，与默认态侧车同目录，由 build-atlas --all 全量生成）----
  // ★ 为什么不能按需现场算：第③层"贴图全不透明"需要**全量**贴图 alpha 数据，而按需打包的 alpha 只覆盖
  //   默认态贴图子集——furnace_on 这类非默认态贴图不在子集里会被误当"缺失"而把整个方块排除（实测）。
  //   opaque 是方块级静态数据，构建期算一次、运行期查表，是唯一正确写法。
  let OPT = undefined
  function opaqueTable() {
    if (OPT !== undefined) return OPT
    OPT = null
    const cands = []
    if (registryPath) cands.push(path.join(path.dirname(registryPath), 'registry-opaque.json'))
    if (process.env.PREVIEW_REGISTRY) cands.push(path.join(path.dirname(process.env.PREVIEW_REGISTRY), 'registry-opaque.json'))
    try { cands.push(fileURLToPath(new URL('./data/registry-opaque.json', import.meta.url))) } catch { /* bundle 里没有 */ }
    for (const p of cands) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (Array.isArray(j)) { OPT = new Set(j); break }
      } catch { /* 换下一个 */ }
    }
    log(OPT ? `开面剔除表：${OPT.size} 个方块` : '开面剔除表不可用（退回现场计算）')
    return OPT
  }

  function load() {
    if (DB) return DB
    const jarNames = fs.readdirSync(instanceDir).filter(f => f.endsWith('.jar'))
    const clientJar = jarNames.includes(path.basename(instanceDir)+'.jar') ? path.basename(instanceDir)+'.jar' : jarNames[0]
    if (!clientJar) throw new Error('实例目录里找不到客户端 jar：' + instanceDir)
    const srcs = [[path.join(instanceDir, clientJar), 0]]
    ;(function walk(d) {
      if (!fs.existsSync(d)) return
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.jar')) srcs.push([p, 1])
      }
    })(path.join(mcDir, 'libraries'))
    const modsDir = path.join(instanceDir, 'mods')
    if (fs.existsSync(modsDir)) for (const f of fs.readdirSync(modsDir).sort()) if (f.endsWith('.jar')) srcs.push([path.join(modsDir, f), 2])

    const blockstates = new Map(), models = new Map(), tex = new Map()
    let sourceDataVersion
    for (const [p, prio] of srcs.sort((a, b) => a[1] - b[1])) {
      let buf; try { buf = fs.readFileSync(p) } catch { continue }
      let es; try { es = listEntries(buf) } catch { continue }
      for (const e of es) {
        const n = e.name
        if (n === 'version.json' && prio === 0) {
          try { const version = JSON.parse(readEntryFast(buf,e)); if(Number.isInteger(version.world_version)) sourceDataVersion = version.world_version; } catch {}
        }
        if (!n.startsWith('assets/') || n.endsWith('/')) continue
        const q = n.split('/')
        if (q.length < 4) continue
        const ns = q[1], cat = q[2]
        try {
          if (cat === 'blockstates' && n.endsWith('.json')) blockstates.set(`${ns}:${q[3].slice(0, -5)}`, JSON.parse(readEntryFast(buf, e)))
          else if (cat === 'models' && n.endsWith('.json')) models.set(`${ns}:${q.slice(3).join('/').slice(0, -5)}`, JSON.parse(readEntryFast(buf, e)))
          else if (cat === 'textures' && n.endsWith('.png')) tex.set(`${ns}:${q.slice(3).join('/').slice(0, -4)}`, readEntryFast(buf, e))
        } catch { /* 坏条目跳过 */ }
      }
    }
    log(`实例读入：blockstates ${blockstates.size} / models ${models.size} / textures ${tex.size}（源自 ${srcs.length} 个 jar）`)
    DB = { blockstates, models, tex, dataVersion: sourceDataVersion }
    return DB
  }

  // ★ 无命名空间的引用按 **MC 规则**补 `minecraft`（实测：1,047 条无前缀 parent 里 0 条落在自身命名空间、813 条落在 minecraft；
  //   textures 707 条同样 0 条落在自身命名空间）。若 minecraft 里没有、而自身命名空间里有，则用后者兜底。
  //   踩过的坑：`ae2:controller` 的 `"parent":"block/cube_all"` 曾被我补成 `ae2:block/cube_all`（不存在）⇒ 方块没有 elements ⇒ **材质整块丢失**。
  function pickNs(v, ownNs, kind) {
    if (!v || v.includes(':') || v.startsWith('#')) return v
    const S = load()
    const has = kind === 'model' ? (k) => S.models.has(k) : (k) => S.tex.has(k)
    if (has('minecraft:' + v)) return 'minecraft:' + v
    if (has(ownNs + ':' + v)) return ownNs + ':' + v
    return 'minecraft:' + v
  }

  /** 模型的 parent 链（父在前） */
  function chainOf(modelId, models) {
    const chain = [], seen = new Set()
    let id = modelId
    while (id && !seen.has(id)) { seen.add(id); chain.push(id); const m = models.get(id); if (!m) break; id = m.parent ? pickNs(m.parent, nsOf(id), 'model') : null }
    return chain.reverse()
  }
  /** 链合并后的 textures 表（子覆盖父） */
  function mergedMap(chain, models) {
    const out = {}
    for (const cid of chain) {
      const m = models.get(cid)
      if (!m?.textures) continue
      const ns = nsOf(cid)
      for (const [k, v] of Object.entries(m.textures)) if (typeof v === 'string') out[k] = v.startsWith('#') ? v : pickNs(v, ns, 'tex')
    }
    return out
  }
  function deref(map, v, ns, depth = 0) {
    if (!v || depth > 8) return null
    if (!v.startsWith('#')) return pickNs(v, ns, 'tex')
    const t = map[v.slice(1)]
    return t ? deref(map, t, ns, depth + 1) : null
  }
  /** 把一个模型（含祖先）收进 needModel/needTex；**返回它引用到的贴图集合**（供按方块算半透明标志） */
  function collectModel(modelId, models, needModel, needTex) {
    const chain = chainOf(modelId, models)
    for (const cid of chain) needModel.add(cid)
    const map = mergedMap(chain, models)
    const own = new Set()
    for (const cid of chain) {
      const m = models.get(cid)
      if (!m) continue
      const ns = nsOf(cid)
      for (const el of m.elements || []) {
        for (const f of Object.values(el.faces || {})) {
          const t = f.texture
          if (!t) continue
          const concrete = t.startsWith('#') ? deref(map, t, ns) : pickNs(t, ns, 'tex')
          if (concrete) { needTex.add(concrete); own.add(concrete) }
        }
      }
    }
    return own
  }

  /** 打包：给定贴图路径集合 → { png, uv, size, missing, failed, alpha } */
  function pack(needTex, models) {
    const S = load()
    const imgs = [], missing = []
    const alpha = new Map()          // 贴图路径 → 是否含"非全不透明"像素（决定方块走不走半透明通道）
    for (const p of [...needTex].sort()) {
      const b = S.tex.get(p)
      if (!b) { missing.push(p); continue }
      try {
        const im = decode(b)
        imgs.push({ p, im })
        let hasAlpha = false
        for (let i = 3; i < im.data.length; i += 4) if (im.data[i] < 255) { hasAlpha = true; break }
        alpha.set(p, hasAlpha)
      } catch { missing.push(p + ' (PNG 解码失败)') }
    }
    imgs.sort((a, b) => (b.im.width * b.im.height) - (a.im.width * a.im.height))
    const area = imgs.reduce((s, x) => s + (x.im.width + pad * 2) * (x.im.height + pad * 2), 0)
    let size = 256
    while (size < 16384 && size * size < area * 1.12) size *= 2
    let uv = {}, canvas = null, failed = []
    for (; size <= 16384; size *= 2) {
      const put = packer(size)
      uv = {}; failed = []
      canvas = Buffer.alloc(size * size * 4)
      for (const { p, im } of imgs) {
        const spot = put(im.width + pad * 2, im.height + pad * 2)
        if (!spot) { failed.push(p); continue }
        const x = spot.x + pad, y = spot.y + pad
        for (let r = 0; r < im.height; r++) im.data.copy(canvas, ((y + r) * size + x) * 4, r * im.width * 4, (r + 1) * im.width * 4)
        uv[p] = [x, y, im.width, im.height]
      }
      if (!failed.length) break
    }
    return { png: encodeRGBA(size, size, canvas), uv, size, missing, failed, alpha, images: imgs.length }
  }

  /** 按需：只给一组方块状态 */
  function buildForStates(states) {
    const S = load()
    const needBs = new Set(), needModel = new Set(), needTex = new Set()
    const defaults = {}                       // 裸名 → 推出来的默认属性（回传前端，放置时带上）
    const blockTex = new Map()                // blockId → 它引用到的贴图集合（用来算半透明标志）
    for (const s of states) {
      const { id, props: given } = parseState(s)
      const bs = S.blockstates.get(id)
      if (!bs) continue
      needBs.add(id)
      const ns = nsOf(id)
      // ★ 关键：裸名（无属性）按"默认态"处理 —— 否则纯 multipart 的方块（如 ae2:controller）
      //   会一个 part 都不匹配，模型与贴图全收不到，放上去就是"材质全丢"。
      const bare = Object.keys(given).length === 0
      // 默认态：**注册表优先**（权威、含 mod），没有才近似推导
      const props = bare ? ((registry() || {})[id] || defaultPropsOf(bs)) : given
      if (bare) defaults[id] = props
      const addModel = (mid) => {
        const own = collectModel(pickNs(mid, ns, 'model'), S.models, needModel, needTex)
        const set = blockTex.get(id) || new Set()
        for (const t of own) set.add(t)
        blockTex.set(id, set)
      }
      // ★ 2026-10-12：**状态会被我们改的方块，模型必须收全**。
      //   编辑器现在会按邻居/命中面推断 state（栅栏四向、玻璃板/栏杆连接、按钮 face/facing、梯子朝向 ——
      //   见 src/statelogic.js），而这里是**按给定 state 精确匹配**收集的 ⇒ 推断出来的新 state
      //   （如 `oak_fence[north=true]`）在资源里没有模型，Deepslate 会**静默跳过** ⇒ 用户看到"放了但看不见"。
      //   ⇒ 两类方块改为收全：① 连接/附着/朝向型（classOf ≠ none）；② 任何 multipart 方块（形状随状态变）。
      //   其余（楼梯 / 门 / 箱子 / 完整方块…）仍按 state 精确收 —— 它们的 state 不由我们改，
      //   收全只会把图集撑大（楼梯一族有几十个 variants 键）。
      const cls = classOf(props, schemaOf(bs))
      if (cls !== 'none' || bs.multipart) {
        for (const mid of allModelsOf(bs)) addModel(mid)
      } else if (bs.variants) {
        const v = matchVariant(bs.variants, props)
        for (const it of v ? (Array.isArray(v) ? v : [v]) : []) if (it?.model) addModel(it.model)
      }
    }
    const out = finish(needBs, needModel, needTex, states, blockTex)
    out.defaults = defaults
    return out
  }

  /** 全量：所有 blockstates 的**全部** variant/multipart 模型（不判属性） */
  function buildAll() {
    const S = load()
    const needBs = new Set(), needModel = new Set(), needTex = new Set()
    const blockTex = new Map()
    for (const [id, bs] of S.blockstates) {
      needBs.add(id)
      const ns = nsOf(id)
      for (const mid of allModelsOf(bs)) {
        const own = collectModel(pickNs(mid, ns, 'model'), S.models, needModel, needTex)
        const set = blockTex.get(id) || new Set()
        for (const t of own) set.add(t)
        blockTex.set(id, set)
      }
    }
    // ★ Deepslate 的 SpecialRenderers（箱子/告示牌/床/潜影盒/旗帜/钟…）会**硬编码**取 entity/* 贴图，
    //   那些路径不出现在任何模型的 faces 里 ⇒ 全量模式必须像原管线一样"entity 全留"，否则特殊方块会缺贴图。
    for (const k of S.tex.keys()) if (k.slice(k.indexOf(':') + 1).startsWith('entity/')) needTex.add(k)
    return finish(needBs, needModel, needTex, [], blockTex, true)   // buildAll = 生成侧车场景，必须真算（forceCompute）
  }

  // ---- O1 开面剔除候选表（三层判据，**缺一不可**；审核 M2：宁可少剔也不错剔）----
  //   ① 渲染层 solid（registry-layers.json 权威；查不到 → 不算）
  //   ② 满立方体几何：方块**全部**模型引用（allModelsOf 不判属性）的有效 elements 各自恰为一个
  //      [0,0,0]→[16,16,16] 单元；element.rotation 只允许 90 的倍数（22.5°/45° 旋转的满格不是满格）。
  //      必须覆盖全部状态而不能只看默认态：getBlockFlags 只按 id 生效——piston 未伸出时是满立方体、
  //      伸出时不是，若只看默认态会把伸出状态邻居的面剔出洞（D079 第九条教训的推广）。
  //      MC 的 variant x/y 旋转只允许 0/90/180/270，作用于满立方体仍占满整格，故无需排除。
  //   ③ 贴图全不透明：全部模型链引用到的贴图都不含 alpha<255 像素；缺失/解码失败 → 排除。
  function computeOpaque(needBs, alpha, forceCompute) {
    // ★ 生成侧车时必须真算（forceCompute），否则"查旧表 → 写回同一份表"自咬尾巴（变异测试踩过：
    //   改了判据代码但侧车还是旧的，变异根本没生效，闸门假绿）。
    const sidecar = forceCompute ? null : opaqueTable()
    if (sidecar) {                                                 // ★ 权威：构建期全量算好的表，直接查
      const out = []
      for (const id of needBs) if (sidecar.has(id)) out.push(id)
      return out
    }
    const S = load()
    const LAY = layers()
    if (!LAY) return []
    const out = []
    for (const id of needBs) {
      if (LAY[id] !== 'solid') continue                                        // ①
      const bs = S.blockstates.get(id)
      if (!bs) continue
      const allTex = new Set()
      let ok = true
      for (const ref of allModelsOf(bs)) {
        const mid = pickNs(ref, nsOf(id), 'model')
        const chain = chainOf(mid, S.models)
        const map = mergedMap(chain, S.models)
        let own = null
        for (let i = chain.length - 1; i >= 0; i--) {                          // MC 语义：子模型 elements 覆盖父
          const m = S.models.get(chain[i])
          if (m && m.elements) { own = m.elements; break }
        }
        if (!own || own.length !== 1) { ok = false; break }                    // ② 必须恰好一个单元
        const e = own[0]
        const full = e.from && e.to && e.from.every((v) => v === 0) && e.to.every((v) => v === 16)
        if (!full) { ok = false; break }
        if (e.rotation && (e.rotation.angle || 0) % 90 !== 0) { ok = false; break }
        for (const f of Object.values(e.faces || {})) {
          if (!f.texture) continue
          const t = f.texture.startsWith('#') ? deref(map, f.texture, nsOf(id)) : pickNs(f.texture, nsOf(id), 'tex')
          if (t) allTex.add(t)
        }
      }
      if (!ok || !allTex.size) continue
      // ③ 每一张贴图都要全不透明（缺贴图/解码失败 alpha.get → undefined ⇒ 保守排除）
      for (const t of allTex) if (alpha.get(t) !== false) { ok = false; break }
      if (ok) out.push(id)
    }
    return out
  }

  function finish(needBs, needModel, needTex, requested, blockTex, forceCompute) {
    const S = load()
    const packed = pack(needTex, S.models)
    const blockstates = {}, models = {}
    for (const k of needBs) blockstates[k] = S.blockstates.get(k)
    for (const k of needModel) { const m = S.models.get(k); if (m) models[k] = m }
    // 请求了但实例里**没有 blockstate 定义**的状态 ⇒ 多半是"物品不是方块"或实例里不存在。
    // 必须回报，否则前端只能"点了没反应"（这是"模组方块放不下"的一半原因）。
    const unknownStates = requested.filter((s) => !S.blockstates.has(parseState(s).id))
    // ★ 半透明标志：该方块引用到的**任一**贴图含"非全不透明"像素 ⇒ 交给 Deepslate 走透明通道。
    //   实测语义（vendor/deepslate.umd.cjs）：`getBlockFlags(...).semi_transparent` 决定这块合进
    //   transparentMesh 还是不透明 mesh。不设它时 AE2 框架/玻璃这类方块会被当不透明、**写深度** ⇒
    //   彼此错误遮挡、看上去"贴图消失"（用户实测）。
    const transparent = []
    const noModel = []                 // 资源包里**没有烘焙模型**的方块（多半靠 mod 自定义渲染器 ⇒ 本工具画不出来）
    const LAY = layers()
    for (const id of needBs) {
      const set = blockTex && blockTex.get(id)
      if (!set || !set.size) { noModel.push(id); continue }   // 一个面贴图都没收到 = 模型是空的
      const lay = LAY && LAY[id]
      if (lay) { if (lay === 'translucent') transparent.push(id); continue }   // ★ 权威：只有 translucent 走混合通道
      for (const t of set) if (packed.alpha.get(t)) { transparent.push(id); break }  // 注册表没有该方块时才退回启发式
    }
    // O1：开面剔除候选表（三层判据，见 computeOpaque 头注释）。只用于隐面剔除，宁可少剔也不错剔。
    const opaque = computeOpaque(needBs, packed.alpha, forceCompute)
    const flags = { transparent, nonSelfCulling: [], opaque, noModel }
    return {
      blockstates, models, uv: packed.uv, png: packed.png, unknownStates, flags,
      stats: {
        blockstates: Object.keys(blockstates).length, models: Object.keys(models).length,
        textures: Object.keys(packed.uv).length, atlas: `${packed.size}²`,
        atlasBytes: packed.png.length, missingTextures: packed.missing.length, atlasFull: packed.failed.length,
        unknownStates: unknownStates.length, transparent: transparent.length, opaque: opaque.length, noModel: noModel.length,
      },
      missing: packed.missing, failed: packed.failed,
    }
  }

  return { load, buildForStates, buildAll, texCount: () => load().tex.size }
}
