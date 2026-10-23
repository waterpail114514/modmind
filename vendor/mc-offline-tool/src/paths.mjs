// src/paths.mjs —— 路径解析的**唯一入口**（规范 §0.9「支持设置、自动发现和显式覆盖」）
//
// ## 为什么要有它
// 审计（docs/audit/initial-audit.md §5.1）实测：本仓库有 **5 类路径写死在代码里、共 8 处**，
// 全部指向开发机（`E:/mc/.minecraft`、`E:/AI工作台/mc-offline-tool/...`）。
// 后果：换个用户、换个盘符就静默跑不起来 —— 而"静默"正是 §0.6 明令禁止的
// （「不支持格式、未知字段、损坏资源、缺失依赖或未实现能力都必须输出明确诊断，
//   不得静默丢弃、回退或伪造成功」）。
//
// ## 解析优先级（本文件是唯一实现，别再在各处 `process.env.X || 'E:/...'`）
//   ① **env**（显式覆盖，最高优先；对 §0.9 的「显式覆盖」）
//   ② **配置文件** `%APPDATA%/modmind/mc-paths.json`（**本机路径放这里，不放代码里**）
//   ③ **自动发现**（只对"用户环境未知"的 MC 根做；其余路径不猜）
//   ④ `source: 'none'` —— **不返回任何猜测值**，由调用方给出可操作的错误
//
// ★ 为什么"其余路径不猜"：注册表 / 探针目录 / 数据目录都是**本工程自己的产物位置**，
//   在别人机器上无从推断 —— 编一个"看起来合理"的候选就是在伪造成功。宁可报错并告诉用户怎么配。
//
// ## 用法
//   import { mcRoot, pick, requirePath, report, clearCache } from '../../src/paths.mjs'
//   const r = mcRoot()            // → { path, source, tried }   source: env|config|discovered|none
//   const p = requirePath('REGISTRY')   // 拿不到就抛**可操作**的错（含 tried 清单）
//
// ## 配置文件形状（键名 = env 名去掉前缀）
//   { "MC_ROOT": "E:/mc/.minecraft", "DATA_DIR": "...", "REGISTRY": "...",
//     "PROBE_DIR": "...", "PROBE_JAR": "" }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 五类可解析路径。`env` 是最高优先级的显式覆盖（保留既有名字，不改调用方习惯）。 */
export const KEYS = {
  MC_ROOT: ['PREVIEW_MC'],
  DATA_DIR: ['PREVIEW_DATA'],
  REGISTRY: ['PREVIEW_PULL_REGISTRY', 'PREVIEW_REGISTRY'],
  PROBE_DIR: ['PREVIEW_PROBE_DIR'],
  PROBE_JAR: ['PREVIEW_PROBE_JAR'],
}

/** 配置文件名（可用 MODMIND_PATHS_CONFIG 覆盖 —— 测试要用，且能避免依赖开发机上的真配置）。 */
export function configPath() {
  if (process.env.MODMIND_PATHS_CONFIG) return process.env.MODMIND_PATHS_CONFIG
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, 'modmind', 'mc-paths.json')
}

let _cache = null

/** 清缓存（测试用：同一进程里改 env / 配置后要重解析）。 */
export function clearCache() { _cache = null }

function readConfig() {
  const p = configPath()
  try {
    const txt = fs.readFileSync(p, 'utf8')
    const j = JSON.parse(txt)
    if (j && typeof j === 'object' && !Array.isArray(j)) return { ok: true, data: j, path: p }
    return { ok: false, data: {}, path: p, err: '顶层不是对象' }
  } catch (e) {
    // 不存在 ≠ 出错：没配置文件是合法状态（还有 env 与自动发现兜）
    return { ok: false, data: {}, path: p, err: e && e.code === 'ENOENT' ? '' : String((e && e.message) || e) }
  }
}

/** 盘符扫描用：本机存在哪些盘根。只 stat 26 次，且只在"前两档都没命中"时才走。 */
function existingDriveRoots() {
  const out = []
  for (let c = 65; c <= 90; c++) {          // A..Z
    const root = String.fromCharCode(c) + ':/'
    try { if (fs.existsSync(root)) out.push(root) } catch { /* 读不到就跳过 */ }
  }
  return out
}

/** MC 根的自动发现候选（按"可能性从高到低"排；**第一个真实存在的**胜出）。 */
function discoverMcRoot() {
  const tried = []
  const cands = []
  const appdata = process.env.APPDATA
  const home = os.homedir()
  if (appdata) cands.push({ p: path.join(appdata, '.minecraft'), why: '官方启动器默认位置（%APPDATA%）' })
  if (home) cands.push({ p: path.join(home, '.minecraft'), why: '用户主目录' })
  // 第三方启动器（PCL 等）常把游戏装成 `<盘>:\mc\.minecraft` 这种"带一层目录"的形状
  for (const root of existingDriveRoots()) {
    cands.push({ p: path.posix.join(root.replace(/\\/g, '/'), '.minecraft'), why: '盘根下的 .minecraft' })
    cands.push({ p: path.posix.join(root.replace(/\\/g, '/'), 'mc/.minecraft'), why: '盘根 mc\\.minecraft（PCL 常见形状）' })
  }
  for (const c of cands) {
    const p = path.resolve(c.p)
    // 判据 = 有 versions/ 子目录（只判目录存在会把"空壳目录"也算命中）
    const looksLikeMc = (() => { try { return fs.statSync(path.join(p, 'versions')).isDirectory() } catch { return false } })()
    tried.push({ path: p, why: c.why, ok: looksLikeMc })
    if (looksLikeMc) return { path: p, tried }
  }
  return { path: '', tried }
}

function resolveKey(key) {
  const envNames = KEYS[key] || []
  // ① env
  for (const n of envNames) {
    const v = process.env[n]
    if (v && v.trim()) return { path: path.resolve(v.trim()), source: 'env', from: n, tried: [] }
  }
  // ② 配置文件
  const cfg = readConfig()
  const cv = cfg.data && cfg.data[key]
  if (typeof cv === 'string' && cv.trim()) {
    return { path: path.resolve(cv.trim()), source: 'config', from: cfg.path, tried: [] }
  }
  // ③ 自动发现（目前只有 MC 根有可发现的候选）
  if (key === 'MC_ROOT') {
    const d = discoverMcRoot()
    if (d.path) return { path: d.path, source: 'discovered', from: '候选扫描', tried: d.tried }
    return { path: '', source: 'none', from: '', tried: d.tried }
  }
  return { path: '', source: 'none', from: '', tried: [] }
}

function all() {
  if (_cache) return _cache
  const out = {}
  for (const k of Object.keys(KEYS)) out[k] = resolveKey(k)
  const cfg = readConfig()
  out.__config = { path: cfg.path, ok: cfg.ok, err: cfg.err }
  _cache = out
  return out
}

/** 单项解析：`{ path, source, from, tried }`，`source ∈ env|config|discovered|none`。 */
export function pick(key) {
  const r = all()[key]
  if (!r) throw new Error('未知的路径键：' + key + '（可用：' + Object.keys(KEYS).join(', ') + '）')
  return r
}

/** 只要字符串（拿不到返回 ''）—— 给"拿不到也能降级"的读路径用（如扫实例）。 */
export function opt(key) { return pick(key).path }

/** MC 根（`findInstanceDir` 等的默认参数用它）。 */
export function mcRoot() { return pick('MC_ROOT').path }

/**
 * 必须拿到，否则**明确报错**：给"没有它就没法正确做事"的调用点用。
 * 错误信息必须**可操作**（§0.6）：说清试过哪些位置、以及怎么配。
 */
export function requirePath(key, why) {
  const r = pick(key)
  if (r.path) return r.path
  const cfg = configPath()
  const lines = [
    '找不到「' + key + '」的路径' + (why ? '（' + why + '）' : ''),
    r.tried && r.tried.length
      ? '已试过的位置：' + r.tried.filter((t) => t.ok === false).map((t) => t.path).slice(0, 6).join('、')
      : '该类路径没有可自动发现的候选（它属于本工程自己的产物位置，无从推断）。',
    '两种设置方式（任选其一）：',
    '  · 环境变量：' + (KEYS[key] || []).join(' 或 '),
    '  · 配置文件：' + cfg + '  里加一项 ' + '"' + key + '": "<路径>"',
  ]
  throw new Error(lines.join('\n'))
}

/** 给 `pull_status` 用的完整报告（界面上要把"路径从哪来"显示出来，别让用户猜）。 */
export function report() {
  const a = all()
  const out = {}
  for (const k of Object.keys(KEYS)) {
    out[k] = { path: a[k].path, source: a[k].source, from: a[k].from }
    if (a[k].tried && a[k].tried.length) out[k].triedCount = a[k].tried.length
  }
  return { keys: out, config: a.__config }
}

/** 人类可读的一行摘要（日志/诊断用）。 */
export function summarize() {
  const a = all()
  return Object.keys(KEYS).map((k) => {
    const r = a[k]
    const tag = r.source === 'env' ? 'env' : r.source === 'config' ? 'config' : r.source === 'discovered' ? '自动发现' : '未找到'
    return k + '=' + (r.path || '(未找到)') + '[' + tag + ']'
  }).join('  ')
}
