// src/model-resolver.mjs —— **静态模型 → 几何**（Phase 4 垂直切片的"3D 渲染"那一环）
//
// ## 这一步解决什么
// 之前只有两条拿到几何的路：① 探针（游戏内跑一次）② 注册表里"游戏烘好的 quads"。
// 两条都要求**先在某个实例上跑过东西**，而注册表那份还随来源实例一起消失了（§5.4 已记）。
// 本模块走第三条路：**直接从素材库的模型 JSON 算出几何** —— 用户在**没有探针、没有注册表**时也能看到 3D。
//
// ## 链路（每一步都能离线复现）
//   blockstate JSON → 选中的 variant → model（沿 `parent` 链合并 textures，取第一个带 `elements` 的模型）
//     → 每个 element 的每个 face → 贴图引用（`#var` 间接解析）→ **UV**（模型里不写 UV，要按规则推）
//     → 输出 quads（顶点位置 + UV + sprite）
//
// ## ★★ UV 规则是**量出来的**，不是凭记忆写的
// 模型 JSON 的 face 只有 `{texture, cullface}`，**没有 UV**（实测 `block/cube` 的 north 面就是如此）。
// UV 要按"每个面取垂直于法线的两个轴 + 定方向"推。写错一点贴图就**镜像或旋转**，
// 而**纯色贴图上肉眼看不出来**（`oak_planks` 正是纯色木头）。
// ⇒ 用 `tools/probe-face-uv-axes.mjs` 从注册表里**游戏亲手烘的 quads** 量：
//    量具 1077 个整方块 / 5160 个 quad；6 个面的 u/v 轴**各有 93~94% 的主流取值**，下表取主流。
//    （少数变体来自"被旋转的模型"，那属于另一件事，本模块对它们明确报 unsupported，不混进来。）
//
// ## ★ UV 的"铺满"语义（容易写错的第二处）
// `uv` 缺省时，贴图是**铺满该 element 的那个面**，不是"截取整个方块空间的一段"。
// ⇒ 台阶（y 从 0 到 8）的顶面显示的是**完整**贴图。若按"方块空间 0..1"直接算，台阶顶面只会显示半张图。
// 公式：`u = (su - lo) / (hi - lo)`，其中 `lo/hi` 是**该 element** 在 u 轴上的跨度（带方向）。
//
// ## 不做什么（§0.6：宁可"明确不支持"，不许"静默算错"）
//   · `multipart` 的方块 ⇒ `geom.unsupported`（合成需要真实烘焙规则，本模块不猜）；
//   · element 带 `rotation` ⇒ `geom.unsupported`（旋转顶点变换没实现，硬算就是错几何）；
//   · 多个 variant 指向不同模型而调用方没给状态 ⇒ `geom.unsupported`（选就是猜）；
//   · 贴图引用解不出来 ⇒ 该面记 warning（不静默给空贴图）。
import fs from 'node:fs'

/** ★ 实测表（`tools/probe-face-uv-axes.mjs`，可复跑）。`u`/`v` = [轴, 符号]。 */
export const FACE_UV_AXIS = {
  down: { u: ['x', +1], v: ['z', -1] },
  up: { u: ['x', +1], v: ['z', +1] },
  north: { u: ['x', -1], v: ['y', -1] },
  south: { u: ['x', +1], v: ['y', -1] },
  west: { u: ['z', +1], v: ['y', -1] },
  east: { u: ['z', -1], v: ['y', -1] },
}

/** 每个面的 4 个顶点（以 element 的 from/to 为界，单位 0..16）。顺序固定 ⇒ 便于比对与渲染。 */
const FACE_CORNERS = {
  down: [['x0', 'y0', 'z0'], ['x0', 'y0', 'z1'], ['x1', 'y0', 'z1'], ['x1', 'y0', 'z0']],
  up: [['x0', 'y1', 'z0'], ['x1', 'y1', 'z0'], ['x1', 'y1', 'z1'], ['x0', 'y1', 'z1']],
  north: [['x0', 'y0', 'z0'], ['x1', 'y0', 'z0'], ['x1', 'y1', 'z0'], ['x0', 'y1', 'z0']],
  south: [['x0', 'y0', 'z1'], ['x0', 'y1', 'z1'], ['x1', 'y1', 'z1'], ['x1', 'y0', 'z1']],
  west: [['x0', 'y0', 'z0'], ['x0', 'y1', 'z0'], ['x0', 'y1', 'z1'], ['x0', 'y0', 'z1']],
  east: [['x1', 'y0', 'z1'], ['x1', 'y1', 'z1'], ['x1', 'y1', 'z0'], ['x1', 'y0', 'z0']],
}

const AX = { x: 0, y: 1, z: 2 }

/** 把 `#var` 引用沿 textures 表解到最终贴图 id（带环保护）。 */
function resolveTextureRef(ref, textures, seen = new Set()) {
  if (typeof ref !== 'string') return null
  if (!ref.startsWith('#')) return ref.startsWith('minecraft:') ? ref : 'minecraft:' + ref
  const key = ref.slice(1)
  if (seen.has(key)) return null                        // 环：判不可解，别死循环
  seen.add(key)
  const v = textures[key]
  return v == null ? null : resolveTextureRef(v, textures, seen)
}

/** 沿 parent 链合并 textures（子覆盖父），并取第一个带 `elements` 的模型。 */
function resolveModelChain(libRoot, firstRef, warnings) {
  const chain = []
  const textures = {}
  let elements = null, elementsFrom = null
  let ref = firstRef, depth = 0
  while (ref && depth < 16) {
    const rel = String(ref).replace(/^minecraft:/, '')
    const p = libRoot + '/models/' + rel + '.json'
    if (!fs.existsSync(p)) { warnings.push('模型文件不存在：' + ref); break }
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    chain.push({ ref, parent: m.parent || null, hasElements: Array.isArray(m.elements), nElements: (m.elements || []).length })
    if (m.textures) for (const [k, v] of Object.entries(m.textures)) if (!(k in textures)) textures[k] = v
    if (!elements && Array.isArray(m.elements) && m.elements.length) { elements = m.elements; elementsFrom = ref }
    ref = m.parent
    depth++
  }
  if (depth >= 16) warnings.push('parent 链超过 16 层（疑似环），已停止')
  return { chain, textures, elements, elementsFrom }
}

/** 某 element 在"带方向的轴"上的跨度（0..1）。`s>0` 取正方向，`s<0` 表示该轴反向。 */
function extentOn(el, axis) {
  const [a, s] = axis
  const from = (a === 'x' ? el.from[0] : a === 'y' ? el.from[1] : el.from[2]) / 16
  const to = (a === 'x' ? el.to[0] : a === 'y' ? el.to[1] : el.to[2]) / 16
  return s > 0 ? [from, to] : [1 - to, 1 - from]
}

/** 顶点在"带方向的轴"上的位置（0..1）。 */
function signedPos(pos, axis) {
  const p = pos[AX[axis[0]]]
  return axis[1] > 0 ? p : 1 - p
}

/**
 * 解析一个方块的几何。
 * @returns {{fidelity:string, quads:Array|null, textures:object, modelChain:Array, elementsFrom:string,
 *            blockstateKind:string, reason:string, warnings:string[]}}
 *   `fidelity`：`geom.baked`（算出来了）| `geom.unsupported`（明确不支持的写法）| `geom.missing`（缺文件/缺几何）
 */
export function resolveBlockGeometry({ libRoot, blockId, stateStr = '' } = {}) {
  const warnings = []
  const out = {
    fidelity: 'geom.missing', quads: null, textures: {}, modelChain: [], elementsFrom: '',
    blockstateKind: '', chosenVariant: '', randomAlternatives: 0, reason: '', warnings,
  }
  const bsPath = libRoot + '/blockstates/' + blockId + '.json'
  if (!fs.existsSync(bsPath)) { out.reason = '缺 blockstate 文件：' + bsPath; return out }
  const bs = JSON.parse(fs.readFileSync(bsPath, 'utf8'))

  // ---- 选模型引用 ----
  let modelRef = null
  /** variant 的值可能是**对象**，也可能是**数组**（原版用它做"随机模型"避免重复感，如 stone/dirt/sand）。
   *  ★ 这里取数组的第 [0] 项（游戏也是随机取一个），并把候选个数报出来 —— 不静默忽略这个事实。 */
  const variantEntry = (v) => (Array.isArray(v) ? { entry: v[0] || {}, alternatives: v.length } : { entry: v || {}, alternatives: 1 })
  if (bs.variants && typeof bs.variants === 'object') {
    out.blockstateKind = 'variants'
    const keys = Object.keys(bs.variants)
    const want = String(stateStr || '')
    // ★ 三级匹配（实测必需）：blockstate 的键**可能省略默认属性**（如 waterlogged=false），
    //   而调用方（注册表/用户）给的键是完整的 ⇒ 精确匹配会失败。
    //   ① 精确；② 键的属性是"请求"的**子集**（即请求更完整）且在此类键里**唯一** ⇒ 用它；
    //   ③ 只有一个 variant 时兜底。仍不唯一 ⇒ 明确报 unsupported（不许猜）。
    const parseKey = (k) => Object.fromEntries(k.split(',').filter(Boolean).map((kv) => {
      const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]
    }))
    const req = parseKey(want)
    let pickKey = null
    if (keys.includes(want)) pickKey = want
    else if (keys.length === 1 && keys[0] === '') pickKey = ''
    else {
      const subsetKeys = keys.filter((k) => {
        const kk = parseKey(k)
        return Object.keys(kk).every((pk) => req[pk] === kk[pk])   // 键 ⊆ 请求
      })
      if (subsetKeys.length === 1) pickKey = subsetKeys[0]
      else if (subsetKeys.length > 1) {
        const uniq2 = [...new Set(subsetKeys.map((k) => String((variantEntry(bs.variants[k]).entry || {}).model)))]
        if (uniq2.length === 1) pickKey = subsetKeys[0]
        else {
          out.fidelity = 'geom.unsupported'
          out.reason = '请求的状态 ' + want + ' 匹配到 ' + subsetKeys.length + ' 个 variant、指向 '
            + uniq2.length + ' 个不同模型 ⇒ 无法唯一确定；不给更具体的状态就是猜。'
          return out
        }
      } else {
        const uniq = [...new Set(keys.map((k) => String((variantEntry(bs.variants[k]).entry || {}).model)))]
        if (uniq.length === 1) pickKey = keys[0]
        else {
          out.fidelity = 'geom.unsupported'
          out.reason = '这个方块有 ' + keys.length + ' 个 variant、指向 ' + uniq.length + ' 个不同模型，'
            + '必须给出具体状态（stateStr）才能选；不给就是猜。'
          return out
        }
      }
    }
    const { entry, alternatives } = variantEntry(bs.variants[pickKey])
    out.chosenVariant = pickKey
    out.randomAlternatives = alternatives
    // ★★ 模型级旋转：实测**还没实现对**（见文件头与 tools/probe-rot-conv2.mjs）⇒ 明确不支持，不静默算错
    if (entry.y || entry.x || entry.uvlock) {
      out.fidelity = 'geom.unsupported'
      out.reason = '这个 variant 带模型级旋转（y=' + (entry.y || 0) + ', x=' + (entry.x || 0)
        + ', uvlock=' + !!entry.uvlock + '），而本模块的旋转变换**尚未通过真值验证**：'
        + '用 y=90 且几何不对称的 attached_pumpkin_stem 试两种约定，对真值只命中 0/6 与 2/6；'
        + 'y=180 的那些（anvil/observer）模型在 xz 上对称 ⇒ 不旋转也能中，属空验证。'
        + '⇒ 宁可不给几何，也不给错几何（tools/probe-rot-conv2.mjs 可复跑）'
      return out
    }
    modelRef = entry.model || null
  } else if (Array.isArray(bs.multipart) && bs.multipart.length) {
    out.blockstateKind = 'multipart'
    out.fidelity = 'geom.unsupported'
    out.reason = 'multipart 的方块要把多个部件按 when 条件合成，那需要真实的烘焙规则；'
      + '本模块**不猜**（设计稿 §5.5：不给编造的几何）'
    return out
  } else {
    out.reason = 'blockstate 既没有 variants 也没有 multipart'
    return out
  }
  if (!modelRef) { out.reason = '选中的 variant 里没有 model 字段'; return out }

  // ---- 沿 parent 链取几何与贴图 ----
  const { chain, textures, elements, elementsFrom } = resolveModelChain(libRoot, modelRef, warnings)
  out.modelChain = chain
  out.textures = textures
  out.elementsFrom = elementsFrom || ''
  if (!elements) { out.reason = '整条 parent 链上都没有 elements（没有几何）'; return out }

  // ---- elements → quads ----
  const quads = []
  for (const [ei, el] of elements.entries()) {
    if (el.rotation) {
      out.fidelity = 'geom.unsupported'
      out.reason = '第 ' + ei + ' 个 element 带 rotation（旋转几何没实现）—— 硬算就是错几何，所以明确不支持'
      return out
    }
    const V = { x0: el.from[0], y0: el.from[1], z0: el.from[2], x1: el.to[0], y1: el.to[1], z1: el.to[2] }
    for (const [face, def] of Object.entries(el.faces || {})) {
      const axis = FACE_UV_AXIS[face]
      if (!axis) { warnings.push('未知的面名：' + face); continue }
      const [uLo, uHi] = extentOn(el, axis.u)
      const [vLo, vHi] = extentOn(el, axis.v)
      const du = uHi - uLo, dv = vHi - vLo
      if (Math.abs(du) < 1e-9 || Math.abs(dv) < 1e-9) {
        out.fidelity = 'geom.unsupported'
        out.reason = '第 ' + ei + ' 个 element 的 ' + face + ' 面在 u 或 v 轴上跨度为 0 ⇒ 无法定 UV'
        return out
      }
      const sprite = resolveTextureRef(def.texture, textures)
      if (sprite == null) warnings.push('第 ' + ei + ' 个 element 的 ' + face + ' 面贴图引用解不出来：' + String(def.texture))
      const vertices = FACE_CORNERS[face].map((c) => {
        const pos = [V[c[0]] / 16, V[c[1]] / 16, V[c[2]] / 16]
        // ★ 贴图**铺满该 element 的这个面**（不是截取方块空间的一段）
        const u = (signedPos(pos, axis.u) - uLo) / du
        const v = (signedPos(pos, axis.v) - vLo) / dv
        return { position: pos, uv: [u, v] }
      })
      quads.push({ element: ei, face, sprite, cullface: def.cullface || null, uvAuto: true, vertices })
    }
  }
  if (!quads.length) { out.reason = 'elements 里没有可用的面'; return out }
  out.fidelity = 'geom.baked'
  out.reason = '从模型 JSON 算出 ' + quads.length + ' 个 quad（UV 按实测规则自动推导、铺满各自的面）'
  out.quads = quads
  return out
}
