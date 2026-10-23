// backend/main.js —— 功能包后端（构建成 `main.cjs`）。
//
// 复用 `preview/` 里已被验证过的 Node 模块（按需打包 scene-assets、格式读写 api、NBT/PNG/zip 工具），
// 只把它们从「HTTP 路由」改成「宿主 action handler」：
//   宿主 `FeaturePluginService.invoke` 会取 activate() 返回对象里的 **handler 名** 并 `handler.call(runtime, input, invocation)`。
//   manifest 里 actions[].id 是带冒号的（`preview:scene`），handler 名是 `preview_scene`，两者对应关系写在 manifest。
//
// 三个外部路径都可用环境变量覆盖（打包在别人机器上跑时用得上）：
//   PREVIEW_MC       `.minecraft` 根。★ 2026-10-13 B2 起**默认值不再写死在代码里**：
//                    解析优先级 = 环境变量 > %APPDATA%/modmind/mc-paths.json > 自动发现 > 明确报错
//                    （统一实现见 src/paths.mjs；本机路径由 tools/gen-path-config.py 生成）
//   PREVIEW_INSTANCE 实例目录（默认在 versions 下自动找"含 mods/ + 客户端 jar"的，优先 GregTech）
//   PREVIEW_DATA     拉取产物目录（items.json 与 icons/ 所在，默认 mc-offline-tool/app/data）
import fs from 'node:fs'
import path from 'node:path'
import { encodeRGBA } from '../../src/png.mjs'
import { createSceneAssets, findInstanceDir } from '../../preview/scene-assets.mjs'
import { readBuildFile } from '../../src/schem-reader.mjs'
import { writeSchem, writeLitematic, toApiJson, computeMaterials, safeName } from '../../preview/api.mjs'
import { selectedData, projectDataPath, packKey } from '../../src/project-data.mjs'

function dataDirOf(projectPath) { return selectedData(projectPath) }

let scene = null, sceneKey = '', sceneAt = 0
function getScene(projectPath) {
  const dir = dataDirOf(projectPath)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  const instanceDir = meta.instanceDir
  if (!instanceDir || !fs.existsSync(instanceDir)) throw new Error('采集来源实例已移动或不存在，请重新采集当前游戏实例')
  const jars = fs.readdirSync(instanceDir).filter(f => f.endsWith('.jar')).map(f => path.join(instanceDir, f))
  const mods = path.join(instanceDir, 'mods')
  if (fs.existsSync(mods)) jars.push(...fs.readdirSync(mods).filter(f => f.endsWith('.jar')).map(f => path.join(mods, f)))
  const fingerprint = JSON.stringify([dir, meta.capturedAt, ...jars.sort().map(f => { const s = fs.statSync(f); return [f, s.size, s.mtimeMs] })])
  if (scene && sceneKey === fingerprint && Date.now() - sceneAt < 120000) return scene
  // 注册表侧车：包内没有它（319 KB 的 id→默认态），指向工具目录里那份；
  // 也可用 PREVIEW_REGISTRY 指到别处。没有它就退回近似推导（罕见方块默认值可能不准）。
  const registryPath = path.join(dir, 'registry-defaults.json')
  console.log('[mc-preview] 实例：' + instanceDir)
  const mcDir = path.basename(path.dirname(instanceDir)) === 'versions' ? path.dirname(path.dirname(instanceDir)) : instanceDir
  scene = createSceneAssets({ instanceDir, mcDir, registryPath, log: (m) => console.log('[mc-preview] ' + m) })
  sceneKey = fingerprint; sceneAt = Date.now()
  return scene
}

/**
 * 起始建造世界：32×16×32 的**空世界**（一个方块都没有）。
 *
 * ★ 历史与取舍：
 *   · 最早是"完全空"，但那时放置的交互是「点已有方块的面 → 放到相邻格」⇒ 一个方块都没有时
 *     点哪儿都是"没点到方块"，**永远放不下第一块**（实测死局）。当时我给底部铺了一层石头绕开它。
 *   · 用户明确要求（2026-10-10）：「3d建筑直接空世界，不要石头铺底，直接硬约束可以在底部放方块」。
 *     ⇒ 现在起始世界重新变空，**死局由"硬约束"解决**：`viewport.pickPlane()` 让"点地面平面"能落在
 *     底部层（y=0）的格子上 ⇒ 空世界也能放下第一块，不再靠铺地面。
 */
function starterBuild(name = '新建建造世界', size = [32, 16, 32]) {
  return { format: 'empty', name, size, palette: [], blocks: [], stats: { blocks: 0 }, source: 'new' }
}

/**
 * 空场景：states 为空时（用户把方块全删了 / 导入了一个空建筑 / 起始世界还没铺地面）给一份**合法**的场景。
 * 必须合法：Deepslate 要求图集边长是 2 的幂、且图集要能解码，否则整条渲染管线会抛错 →
 * 前端回落到预打包 `data/assets.js` —— 而功能包里**没有这个静态文件**，于是报「取不到 data/assets.js」，
 * 界面一片空白（实测就是这个）。用一张 16×16 全透明图集 + 空表保底；之后放置方块时会走「按需扩展」补真实资源。
 */
function emptyScene() {
  const px = 16
  return {
    blockstates: {}, models: {}, uv: {},
    atlas: 'data:image/png;base64,' + Buffer.from(encodeRGBA(px, px, Buffer.alloc(px * px * 4))).toString('base64'),
    defaults: {}, flags: { transparent: [], nonSelfCulling: [], opaque: [], noModel: [] },
    unknownStates: [], missing: [],
    truncated: { states: 0, missing: 0 },
    stats: {
      blockstates: 0, models: 0, textures: 0, atlas: `${px}²`, atlasBytes: 0,
      missingTextures: 0, atlasFull: 0, unknownStates: 0, transparent: 0, noModel: 0,
    },
    key: 'empty',
  }
}

// 物品表缓存**按数据目录分键**：换了数据包要能立刻换一份（不能拿旧包的缓存糊弄）
const itemsCache = new Map()
function getItems(dir) {
  const file = path.join(dir, 'items.json'), stat = fs.statSync(file)
  const fingerprint = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
  const cached = itemsCache.get(dir)
  if (cached?.fingerprint === fingerprint && Date.now() - cached.at < 30000) return cached.value
  if (stat.size > 16 * 1024 * 1024) throw new Error('采集清单过大，请重新采集')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const { ids = [], names = [], icons = [], block = [] } = raw
  const v = { ids, names, icons, block, count: ids.length }
  if (itemsCache.size >= 4) itemsCache.delete(itemsCache.keys().next().value)
  itemsCache.set(dir, { fingerprint, value: v, at: Date.now() })
  return v
}

export function activate() {
  return {
    /** 起始建筑（功能包模式没有静态文件可 fetch，由后端给） */
    preview_open: () => ({ build: starterBuild() }),

    /** 按需打包：只给这批方块状态 → 小图集(data URL) + 配套模型表 + 默认态 + 标志位 */
    preview_scene: (input) => {
      // ★ 截断必须**回传标记**（审核员 U4）：静默截断是这类工具最贵的 bug —— 看着正常、结果少了。
      //   以前这里 slice(0,20000) 与 missing.slice(0,20) 都是**无声**的。
      const rawStates = Array.isArray(input && input.states) ? input.states.filter((s) => typeof s === 'string') : []
      const states = rawStates.slice(0, 20000)
      // 空建造世界（新建出来的那个）本来就没有方块 ⇒ states 为空是**正常**情况，给一份空场景而不是抛错
      if (!states.length) return emptyScene()
      const out = getScene(input.projectPath).buildForStates(states)
      const missingAll = out.missing || []
      return {
        blockstates: out.blockstates, models: out.models, uv: out.uv,
        atlas: 'data:image/png;base64,' + Buffer.from(out.png).toString('base64'),
        defaults: out.defaults || {}, flags: out.flags || null,
        unknownStates: out.unknownStates || [], missing: missingAll.slice(0, 20),
        truncated: { states: rawStates.length - states.length, missing: missingAll.length - Math.min(missingAll.length, 20) },
        stats: out.stats,
      }
    },

    /** 物品表（18k+ 项：id / 中文名 / 是否方块 / 图标文件名）；数据目录由 projectPath 决定（见 dataDirOf） */
    preview_items: (input) => {
      const dir = dataDirOf(input && input.projectPath)
      const it = getItems(dir)
      // 只回前端真正需要的字段（icons 是文件名，图标本体走 preview:icons）
      const query = String(input.query || '').toLowerCase()
      const rows = it.ids.map((id, i) => ({ id, name: it.names[i] || id, icon: it.icons[i] || '', block: it.block[i] === true }))
        .filter(row => !query || `${row.id} ${row.name}`.toLowerCase().includes(query))
      const offset = Number(input.offset || 0), limit = Math.min(500, Number(input.limit || 500))
      const items = rows.slice(offset, offset + limit)
      return { items, count: rows.length, offset, nextOffset: offset + items.length < rows.length ? offset + items.length : null, dataDir: dir }
    },

    /** 图标：只回这一页要用的，转成 data URL（包内不能靠静态路径取 18k 张图） */
    preview_icons: (input) => {
      const dir = dataDirOf(input && input.projectPath)
      const rawIds = Array.isArray(input && input.ids) ? input.ids : []
      const ids = rawIds.slice(0, 200)
      const it = getItems(dir)
      const index = new Map(it.ids.map((id, i) => [id, i]))
      const icons = {}
      for (const id of ids) {
        const i = index.get(id)
        if (i === undefined) continue
        const file = it.icons[i]
        if (!file) continue
        if (path.basename(file) !== file || !/^[\w.-]+\.png$/.test(file)) throw new Error('数据包图标路径无效，请重新采集')
        if (input.projectPath) projectDataPath(input.projectPath, `packs/${packKey(path.basename(dir))}/icons/${file}`)
        try { icons[id] = 'data:image/png;base64,' + fs.readFileSync(path.join(dir, 'icons', file)).toString('base64') } catch { /* 缺图标就跳过 */ }
      }
      return { icons, truncated: { icons: rawIds.length - ids.length } }
    },

    /** 导入任意建筑文件（前端把字节转 base64 传来）→ 统一 JSON */
    preview_import: (input) => {
      const buf = Buffer.from(String((input && input.dataBase64) || ''), 'base64')
      const name = String((input && input.name) || 'building.nbt')
      return { build: toApiJson(readBuildFile(buf, name), path.basename(name)) }
    },

    /** 导出 .schem / .litematic（返回 base64，前端落成 Blob 下载） */
    preview_export: (input) => {
      const format = String((input && input.format) || 'schem').toLowerCase()
      if (format !== 'schem' && format !== 'litematic') throw new Error('未知导出格式：' + format)
      const build = (input && input.build) || {}
      const bytes = format === 'litematic' ? writeLitematic(build) : writeSchem(build)
      return {
        filename: safeName(build.name) + '.' + format,
        dataBase64: Buffer.from(bytes).toString('base64'),
        materials: computeMaterials(build),
      }
    },
  }
}
