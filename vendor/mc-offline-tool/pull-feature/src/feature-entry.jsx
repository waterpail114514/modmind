// src/feature-entry.jsx —— 「游戏数据采集」功能包渲染入口（IIFE，最外层同步注册）。
//
// 设计（与 3D 预览包同一套路）：
//   · 宿主用**经典 <script>** 注入 renderer.js ⇒ 必须 IIFE、最外层同步注册；
//   · 面板用 **Shadow DOM** 隔离，样式单一来源是 `src/pull.css`（构建时内联），
//     颜色/间距全部走宿主主题令牌 `--theme-*`（穿 Shadow DOM 继承）⇒ 自动跟随浅色/深色；
//   · 面板本体用**原生 DOM** 搭（不引 ReactDOM），生命周期由 useEffect 收口（卸载时 dispose）。
//
// UI/交互 = 定稿原型 v5（`v1.7-设计-mc-pull采集面板UI原型-v5.html`）：
//   头部(标题+副标题+目标实例选择器) → 扫描卡 → 状态行 → 三步线 → 当前步骤卡(9 变体) →
//   数据包区 → 自动采集开关 → 最近操作日志。
//
// P1：面板显示的每个数字/清单/状态都必须来自后端真实扫描（status 返回）；面板不预置、不估计。
// P2：单卡叙事 —— 只显示"现在能做的一件事"，当前步之外不出现假按钮。
// 决策（2026-10-11 用户提"我需要一键启动游戏"后改）：宿主没对 mc-pull 开放启动能力（查过
//   app.asar），所以**自己实现** pull:launch —— 用实例版本 json 拼 java 命令行（对齐 PCL 的
//   LatestLaunch.bat）、spawn 后脱离。UI 真启动，不再"假装能启动"或只给引导。
//
// ★ 文案全部走 textContent（纯文本，绝不含 `**`，避免被原样显示成字符）。
import { CSS } from './css.generated.js'

const FEATURE_ID = 'mc-pull'
const SVGNS = 'http://www.w3.org/2000/svg'

function invoke(action, input) {
  const api = globalThis.modmind && globalThis.modmind.featurePlugins
  if (!api || typeof api.invoke !== 'function') throw new Error('宿主未提供 modmind.featurePlugins.invoke（不在功能包环境？）')
  return api.invoke(FEATURE_ID, action, input)
}

const h = (tag, cls, text) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}
/** 后端 note/verdict 一律清掉 `**`（历史遗留的 markdown 强调符会被 textContent 原样显示） */
const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/\*\*/g, '')
const nf = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n === undefined || n === null ? '—' : n))
const msg = (e) => clean(e && e.message ? e.message : e)
const pad = (n) => String(n).padStart(2, '0')
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const stamp = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const shortStamp = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** 时间比较：ISO 字符串（同格式、同 UTC 口径）直接字典序即可；'' 视为最小 */
const later = (a, b) => !!a && (!b || String(a) > String(b))
/** 从探针 jar 文件名取探针自己的版本号（写到最后的那个 x.y.z），取不到返回 '' */
const jarVer = (f) => {
  const m = [...String(f || '').matchAll(/(\d+)\.(\d+)\.(\d+)/g)]
  return m.length ? m[m.length - 1][0] : ''
}

/** 小 SVG 图标（用 DOM 构建，不用 innerHTML） */
function glyph(kind) {
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const add = (d, w) => {
    const p = document.createElementNS(SVGNS, 'path')
    p.setAttribute('d', d)
    p.setAttribute('stroke-width', w)
    svg.appendChild(p)
  }
  if (kind === 'check') add('M3 8.5 6.5 12 13 4.5', '2.2')
  else if (kind === 'warn') { add('M8 2.2 14.4 13H1.6L8 2.2Z', '1.6'); add('M8 6.6v3.2', '1.6'); add('M8 11.6h.01', '2') }
  else if (kind === 'ok') { add('M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Z', '1.6'); add('M5.4 8.3 7.2 10 10.8 6', '1.6') }
  else add('M6 3.5 10.5 8 6 12.5', '1.8')
  return svg
}
/** note 行：[svg] + [文本]（纯文本，经 clean） */
function noteBox(kind, text) {
  const n = h('div', 'note ' + kind)
  n.appendChild(glyph(kind === 'warn' ? 'warn' : kind === 'err' ? 'warn' : 'ok'))
  n.appendChild(h('span', null, clean(text)))
  return n
}
const btn = (label, cls, onClick) => {
  const b = h('button', 'btn' + (cls ? ' ' + cls : ''), label)
  b.type = 'button'
  if (onClick) b.onclick = onClick
  return b
}

/**
 * 面板：头部 → 扫描 → 状态行 → 三步 → 当前步骤卡 → 数据包 → 自动采集 → 日志。
 * 全部数据来自宿主 action；面板不预置、不估计（P1）。
 */
function createApp(root, projectPath) {
  // scanPhase: scanning | done ；importPhase: idle | importing | done | cancelled
  // local: '' | running | done | failed | blocked（本会话被清空后不再自动直读复活）
  const S = {
    scanPhase: 'scanning', scanAt: '', status: null,
    activeInstance: '', busy: '', installMsg: '',
    importPhase: 'idle', progress: null, delta: null,
    auto: true, listeningSince: null, lastAutoAt: '',
    packs: [], activePack: '', clearPending: '',
    logs: [], local: '', launchGuided: false, launching: false,
  }
  const parts = {}

  // ---------- 头部 ----------
  const head = h('header', 'p-head')
  const tt = h('div', 'tt')
  head.appendChild(tt)
  const pick = h('div', 'inst-pick')
  parts.instBtn = h('button', 'inst-btn')
  parts.instBtn.type = 'button'
  parts.instBtn.setAttribute('aria-expanded', 'false')
  parts.instName = h('b', 'ip-name', '正在扫描…')
  parts.instVer = h('span', 'ip-ver', '')
  parts.instBtn.append(h('span', 'ip-label', '目标实例'), parts.instName, parts.instVer, h('span', 'ip-caret', '▾'))
  parts.instBtn.onclick = () => toggleInstMenu()
  parts.instMenu = h('div', 'inst-menu')
  parts.instMenu.hidden = true
  pick.append(parts.instBtn, parts.instMenu)
  pick.appendChild(btn('选择实例目录', '', async () => {
    try {
      const chosen = await invoke('pull:chooseInstance', {})
      if (!chosen.instanceDir) return
      S.activeInstance = chosen.instanceDir
      S.local = ''
      S.scanPhase = 'scanning'
      await refresh()
    } catch (error) { log('err', msg(error)); renderAll() }
  }))
  head.appendChild(pick)
  root.appendChild(head)

  // ---------- 扫描卡 / 状态行 / 三步线 / 当前步骤卡 ----------
  parts.scanCard = h('section', 'stage')
  root.appendChild(parts.scanCard)
  parts.statusStrip = h('div', 'status-strip')
  root.appendChild(parts.statusStrip)
  parts.steps = h('ol', 'steps')
  root.appendChild(parts.steps)
  parts.stage = h('section', 'stage')
  root.appendChild(parts.stage)

  // ---------- 数据包区 ----------
  const sect = h('section', 'sect')
  const sectHead = h('div', 'sect-head')
  sectHead.appendChild(h('h3', null, '数据包（项目内）'))
  sectHead.appendChild(h('span', 'hint', '采集结果按实例分开存；预览包读取的是「当前使用」这个'))
  sect.appendChild(sectHead)
  // ★ B2 / §0.6：路径解析不到时必须**看得见**。这些项缺了会让采集"看起来能跑、其实少东西"（
  //   例如注册表缺失 ⇒ 候选只来自语言文件键，明显变少）—— 以前这些路径写死在代码里，用户无从知晓。
  parts.pathsWarn = h('div', 'paths-warn')
  sect.appendChild(parts.pathsWarn)
  parts.packs = h('div', 'packs')
  sect.appendChild(parts.packs)
  root.appendChild(sect)

  // ---------- 自动采集 ----------
  const autoSect = h('section', 'sect')
  const autoRow = h('div', 'auto-row')
  const autoInfo = h('div', 'info')
  autoInfo.appendChild(h('div', 't', '自动采集'))
  parts.autoSub = h('div', 'sub')
  autoInfo.appendChild(parts.autoSub)
  autoRow.appendChild(autoInfo)
  parts.autoSwitch = h('div', 'switch')
  parts.autoSwitch.setAttribute('role', 'switch')
  parts.autoSwitch.setAttribute('tabindex', '0')
  parts.autoSwitch.setAttribute('aria-label', '自动采集开关')
  const toggleAuto = () => {
    S.auto = !S.auto
    if (S.auto && probeState() === 'installed' && !S.listeningSince) S.listeningSince = Date.now()
    log('info', S.auto ? '自动采集已开启（每 8 秒检查一次游戏内产物）' : '自动采集已关闭 —— 需要手动点「检查产物」再导入')
    if (S.auto) void tick()
    renderAll()
  }
  parts.autoSwitch.onclick = toggleAuto
  parts.autoSwitch.onkeydown = (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAuto() }
  }
  autoRow.appendChild(parts.autoSwitch)
  autoSect.appendChild(autoRow)
  root.appendChild(autoSect)

  // ---------- 最近操作（折叠日志） ----------
  const logs = h('section', 'logs')
  const det = document.createElement('details')
  det.open = true
  const sum = document.createElement('summary')
  sum.appendChild(h('span', null, '最近操作'))
  const chev = h('span', 'chev')
  chev.appendChild(glyph('chev'))
  sum.appendChild(chev)
  det.appendChild(sum)
  parts.logBody = h('div', 'body')
  det.appendChild(parts.logBody)
  logs.appendChild(det)
  root.appendChild(logs)

  // ============================ 派生（只读 status，不预置） ============================
  const instances = () => (S.status && S.status.scan && S.status.scan.instances) || []
  const curInst = () => instances().find((i) => i.dir === S.activeInstance) || instances()[0] || null
  const activePack = () => (S.packs || []).find((p) => p.key === S.activePack) || null
  const probeState = () => {
    if (S.busy === '装入探针') return 'installing'
    const inst = curInst()
    if (!inst) return 'absent'
    if (inst.probe === 'matched') return 'installed'
    if (inst.probe === 'none') return 'none'
    if (inst.probeMode === 'unverified') return 'unverified'
    return 'absent'
  }
  /** 探针"装过但没跑过"：装入时间晚于该实例最后一次启动 */
  const probeStale = () => {
    const inst = curInst()
    return !!(inst && later(inst.probeAt, inst.lastLaunch))
  }
  /** ★ M3（2026-10-11 事故形态）："跑过"≠"采到"——探针确实运行了，但产出的是「放置验证」
   *  而不是采集数据（placement-report 晚于探针装入、且还没有 pull2 采集产物）。 */
  const placementRan = (inst) => !!(inst && !inst.hasDump && inst.placementAt && later(inst.placementAt, inst.probeAt))
  /** 派生阶段：1 装探针 / 2 启动产出 / 3 待导入 / 4 导入中 / 5 完成或取消 */
  const stage = () => {
    if (S.importPhase === 'importing') return 4
    if (S.importPhase === 'done' || S.importPhase === 'cancelled') return 5
    if (S.status && S.status.needsImport) return 3
    if (probeState() === 'installed') return 2
    return 1
  }

  function log(kind, text) {
    S.logs = [{ t: clock(new Date()), kind, text: clean(text) }, ...S.logs].slice(0, 40)
  }
  const setBusy = (t) => { S.busy = t || ''; renderAll() }

  // ============================ 渲染 ============================
  function renderAll() {
    if (S.scanPhase === 'scanning') { renderScanning(); return }
    // 扫描卡只在打开/重新扫描时出现（规格 1.1「仅打开时 ~1s」）⇒ 扫描完成后必须清掉，
    // 否则它会一直占着 .stage 的位置（也会让「当前步骤卡」的查询命中错的那张）。
    parts.scanCard.replaceChildren()
    renderInstPicker()
    renderStatus()
    renderSteps()
    renderStage()
    renderPacks()
    renderAuto()
    renderLogs()
  }

  function renderScanning() {
    parts.instName.textContent = '正在扫描…'
    parts.instVer.textContent = ''
    parts.statusStrip.className = 'status-strip s-run'
    parts.statusStrip.replaceChildren(h('span', 'dot'), h('span', null, '正在扫描游戏实例…'), h('span', 'sub', '实例列表只从扫描结果来'))
    parts.steps.replaceChildren()
    const card = h('div', 'stage-card')
    card.appendChild(h('div', 'kicker', '正在扫描'))
    const h2 = h('h2')
    h2.appendChild(h('span', 'spin-lg'))
    h2.appendChild(h('span', null, '正在扫描游戏实例…'))
    card.appendChild(h2)
    card.appendChild(h('p', 'desc', '面板不猜实例 —— 它会真的去这些位置扫「有 mods/ 与客户端 jar 的实例」：'))
    const paths = h('div', 'scan-paths')
    for (const s of (S.status && S.status.scan && S.status.scan.sources) || ['（读取中…）']) {
      const p = h('span', 'pth')
      p.appendChild(h('span', 'dot2'))
      p.appendChild(h('span', 'mono', String(s)))
      paths.appendChild(p)
    }
    card.appendChild(paths)
    parts.scanCard.replaceChildren(card)
  }

  function renderInstPicker() {
    const inst = curInst()
    if (!inst) { parts.instName.textContent = '（没有可用实例）'; parts.instVer.textContent = ''; return }
    parts.instName.textContent = inst.name
    parts.instVer.textContent = [inst.loader, inst.mc].filter(Boolean).join(' ')
    if (!parts.instMenu.hidden) renderInstMenu()
  }

  function badgeOf(inst) {
    if (inst.probe === 'none') return { label: '暂无探针构建', cls: 'no' }
    // ★ 2026-10-12 P0.1：'absent' 现在有两种含义，措辞必须分开 ——
    //   unverified = jar **自己声明**覆盖该版本，但我们**没在这个版本上实测过**（可试装，失败请回报）；
    //   其余 = 该版本正是构建目标（= 实际验证过的）。
    //   把"声明覆盖"和"验证过"混成一句"可装探针"，就是**拿未验证的范围当承诺**。
    if (inst.probe === 'absent') {
      return inst.probeMode === 'unverified'
        ? { label: '可试装（该版本未验证）', cls: 'warn' }
        : { label: '可装探针', cls: 'ok' }
    }
    if (!inst.lastLaunch) return { label: '从未启动过', cls: 'warn' }
    if (later(inst.probeAt, inst.lastLaunch)) return { label: '探针没跑过', cls: 'warn' }
    if (placementRan(inst)) return { label: '跑了「放置验证」', cls: 'warn' }
    return { label: '已装探针', cls: 'ok' }
  }

  function renderInstMenu() {
    const menu = parts.instMenu
    const items = instances()
    if (!items.length) {
      menu.replaceChildren(h('div', 'menu-note', '没有扫描到可用实例（有 mods/ 与客户端 jar 的实例）'))
      return
    }
    const nodes = items.map((inst) => {
      const it = h('div', 'inst-item' + (inst.dir === S.activeInstance ? ' active' : ''))
      it.setAttribute('data-inst', inst.dir)
      it.appendChild(h('span', 'ii-mark', (inst.mc || '?').split('.')[0]))
      const info = h('div', 'ii-info')
      info.appendChild(h('div', 'ii-t', inst.name))
      info.appendChild(h('div', 'ii-s', `${inst.dir} · ${inst.loader || '未知加载器'} ${inst.mc || '未知版本'}`))
      it.appendChild(info)
      const b = badgeOf(inst)
      it.appendChild(h('span', 'ii-badge ' + b.cls, b.label))
      it.onclick = () => selectInstance(inst.dir)
      return it
    })
    const bn = h('div', 'menu-note', '探针按「加载器 × MC 版本」自动匹配；更多平台的构建待提供')
    const scanRow = h('div', 'menu-scan')
    scanRow.appendChild(h('span', null, `扫描自 ${((S.status.scan && S.status.scan.sources) || []).length} 处位置 · ${S.scanAt || '--'}`))
    scanRow.appendChild(h('span', 'sp'))
    const rb = h('button', null, '重新扫描')
    rb.type = 'button'
    rb.onclick = () => { closeInstMenu(); startScan() }
    scanRow.appendChild(rb)
    menu.replaceChildren(...nodes, bn, scanRow)
  }

  function toggleInstMenu() {
    if (S.scanPhase === 'scanning') return
    if (parts.instMenu.hidden) { renderInstMenu(); parts.instMenu.hidden = false; parts.instBtn.setAttribute('aria-expanded', 'true') }
    else closeInstMenu()
  }
  function closeInstMenu() { parts.instMenu.hidden = true; parts.instBtn.setAttribute('aria-expanded', 'false') }

  function renderStatus() {
    const st = stage()
    const el = parts.statusStrip
    let cls = 's-wait', main = '', sub = ''
    if (st === 1) { cls = 's-wait'; main = '第 1 步 · 把探针装入测试实例'; sub = '装入后需要启动一次游戏' }
    if (st === 2) {
      cls = 's-wait'
      main = '第 2 步 · 启动一次实例，让探针产出数据'
      sub = S.auto ? '自动采集已开启 —— 启动后放着就行' : '自动采集已关闭 —— 跑完后回来点「检查产物」'
    }
    if (st === 3) { cls = 's-run'; main = '有新产物可以导入'; sub = '产物：pull2 · ' + (shortStamp(S.status.newestDump && S.status.newestDump.capturedAt) || '--') }
    if (st === 4) {
      cls = 's-run'
      const p = S.progress || { page: 0, totalPages: 0, items: 0 }
      main = `正在导入 · 第 ${p.page}/${p.totalPages || '?'} 页`
      sub = `已处理 ${nf(p.items)} 项`
    }
    if (st === 5) {
      if (S.importPhase === 'done') { cls = 's-ok'; main = '导入完成 · 数据包已更新'; sub = '最近一次：' + (S.logs[0] ? S.logs[0].t : '--') }
      else { cls = 's-wait'; main = '已取消 · 数据包未改动'; sub = '可以随时重新导入' }
    }
    el.className = 'status-strip ' + cls
    el.replaceChildren(h('span', 'dot'), h('span', null, main), h('span', 'sub', sub))
  }

  function renderSteps() {
    const st = stage()
    const ps = probeState()
    const defs = [
      { n: 1, lab: '装入探针', d: '把探针 jar 放进实例',
        state: ps === 'installed' ? 'done' : (ps === 'installing' ? 'active' : (st === 1 ? 'active' : 'idle')),
        stt: ps === 'installed' ? '已装入探针' : (ps === 'installing' ? '正在装入…' : (ps === 'none' ? '暂无构建' : '未装入')) },
      { n: 2, lab: '启动实例', d: '启动一次，探针自动产出',
        state: st === 2 ? 'active' : (st > 2 ? 'done' : 'idle'),
        stt: st === 3 ? '已产出' : (st === 2 ? '待启动' : (st > 2 ? '已启动' : '未开始')) },
      { n: 3, lab: '导入数据包', d: '把产物写进项目数据包',
        state: st === 4 ? 'active' : (st === 5 && S.importPhase === 'done' ? 'done' : (st === 5 ? 'active' : 'idle')),
        stt: st === 4 ? '进行中' : (st === 5 && S.importPhase === 'done' ? '完成' : (S.importPhase === 'cancelled' ? '已取消' : '待导入')) },
    ]
    parts.steps.replaceChildren(...defs.map((d) => {
      const li = h('li', 'step ' + d.state)
      const mark = h('span', 'mark')
      if (d.state === 'done') mark.appendChild(glyph('check'))
      else mark.textContent = String(d.n)
      li.append(mark, h('span', 'lab', d.lab), h('span', 'st', d.stt))
      return li
    }))
  }

  function renderStage() {
    const st = stage()
    const el = parts.stage
    el.replaceChildren()
    if (st === 1) el.appendChild(stage1Card())
    else if (st === 2) el.appendChild(stage2Card())
    else if (st === 3) el.appendChild(stage3Card())
    else if (st === 4) el.appendChild(stage4Card())
    else el.appendChild(stage5Card())
  }

  // ---- 步骤 1：装探针 ----
  function stage1Card() {
    const inst = curInst()
    const card = h('div', 'stage-card')
    card.appendChild(h('div', 'kicker', '当前步骤 1 / 3'))
    if (!inst) {
      card.appendChild(h('h2', null, '这个实例暂时不能采集'))
      card.appendChild(h('p', 'desc', '没有扫描到可用实例。请确认游戏实例目录下有 mods/ 与客户端 jar。'))
      const cta = h('div', 'cta-row')
      const b = btn('装入游戏内探针', 'primary'); b.disabled = true
      cta.append(b, h('span', 'hint-inline', '没有可用的实例'))
      card.appendChild(cta)
      return card
    }
    if (inst.probe === 'none') {
      card.appendChild(h('h2', null, '这个实例暂时不能采集'))
      card.appendChild(h('p', 'desc', `「${inst.name}」是 ${inst.loader || '未知加载器'} ${inst.mc || '未知版本'} —— 当前没有适配它的探针构建。`))
      card.appendChild(noteBox('warn', `已有构建：${(S.status.probeBuilds || []).join('、') || '（无）'}。可以：① 换一个 ${inst.loader || '该加载器'} ${inst.mc || ''} 的实例 ② 或等后续版本提供 ${inst.loader || '该加载器'} 支持。`))
      const cta = h('div', 'cta-row')
      const b = btn('装入游戏内探针', 'primary'); b.disabled = true
      cta.append(b, h('span', 'hint-inline', '没有可用的探针构建'))
      card.appendChild(cta)
      return card
    }
    card.appendChild(h('h2', null, '把探针装入实例'))
    card.appendChild(h('p', 'desc', '探针是游戏里的一个小 mod。装入后，启动一次游戏它就会产出「真渲染图标」和「游戏内物品名」。会同时覆盖该实例的 mods 与 .minecraft 对应版本目录两处；重复装入自动换新。'))
    const ver = jarVer(inst.matched)
    const line = h('div', 'probe-line')
    line.appendChild(h('span', 'pl-label', '将装入'))
    line.appendChild(h('b', 'num', inst.matched || '（匹配中…）'))
    line.appendChild(h('span', 'pl-why', `按实例 ${inst.loader || '?'} ${inst.mc || '?'} 自动匹配${ver ? ' · 最新 v' + ver : ''}`))
    line.appendChild(h('span', 'sp'))
    const more = h('button', 'btn ghost sm', '更换…'); more.type = 'button'
    more.onclick = () => { parts.probeList.hidden = !parts.probeList.hidden }
    line.appendChild(more)
    card.appendChild(line)
    parts.probeList = h('div', 'probe-list')
    parts.probeList.hidden = true
    for (const f of S.status.probeBuilds || []) parts.probeList.appendChild(h('div', 'pr-item', f))
    parts.probeList.appendChild(h('div', 'pr-note', '构建来自磁盘上的探针 jar 文件名；更多平台（Fabric / 其它 MC 版本）尚未提供构建'))
    card.appendChild(parts.probeList)
    const cta = h('div', 'cta-row')
    const busy = S.busy === '装入探针'
    const b = btn(busy ? (S.installMsg || '正在装入…') : '装入游戏内探针', 'primary', () => installProbe())
    b.disabled = busy
    if (busy) b.prepend(h('span', 'spin'))
    cta.append(b, h('span', 'hint-inline', '约 3 秒 · 不修改游戏本体'))
    card.appendChild(cta)
    return card
  }

  // ---- 步骤 2：启动（宿未开放启动能力 ⇒ 引导到侧边栏，UI 不假装能启动）----
  function stage2Card() {
    const inst = curInst()
    const card = h('div', 'stage-card')
    card.appendChild(h('div', 'kicker', '当前步骤 2 / 3'))
    card.appendChild(h('h2', null, '启动一次实例'))
    card.appendChild(h('p', 'desc', `目标实例：${inst ? inst.name : '（无）'}（${inst ? [inst.loader, inst.mc].filter(Boolean).join(' ') : '?'}）—— 游戏拉起到主界面即可退出；跑没跑过以「探针有没有产出」为准。`))
    if (inst && inst.probeAt) {
      const ok = h('div', 'probe-ok')
      ok.appendChild(glyph('check'))
      ok.appendChild(h('span', null, `探针已装：${inst.matched || '（已装）'}（${stamp(inst.probeAt)} 装入）`))
      ok.appendChild(h('span', 'sp'))
      const re = btn('重新装入', 'ghost sm', () => installProbe())
      ok.appendChild(re)
      card.appendChild(ok)
    }
    if (inst && !inst.lastLaunch) card.appendChild(noteBox('warn', '这个实例从没启动过游戏。点下面的「一键启动游戏」直接启动（也可以用自己的启动器手动启动）；启动后回到本面板，自动采集会继续监听产物。'))
    else if (probeStale()) card.appendChild(noteBox('warn', `探针装于 ${stamp(inst.probeAt)}，晚于最后一次启动（${stamp(inst.lastLaunch)}）⇒ 探针还没跑过。点下面的「一键启动游戏」直接启动。`))
    else if (placementRan(inst)) card.appendChild(noteBox('warn', clean(inst.verdict)))
    if (S.launchGuided) card.appendChild(noteBox('warn', '已发出启动命令——游戏窗口会自己打开（首次加载 mod 要稍等片刻）。拉起到主界面即可退出；探针产出后自动导入（监听中 · 每 8 秒检查）。'))
    const cta = h('div', 'cta-row')
    const go = btn(S.launching ? '正在启动…' : '一键启动游戏', 'primary', () => launchGame())
    if (S.launching) go.disabled = true
    cta.appendChild(go)
    cta.appendChild(btn('检查产物', 'ghost', () => checkProducts()))
    cta.appendChild(h('span', 'hint-inline', '不用离开面板 · 启动后自动监听产出'))
    card.appendChild(cta)
    return card
  }

  // ---- 步骤 3：导入 ----
  function stage3Card() {
    const card = h('div', 'stage-card')
    card.appendChild(h('div', 'kicker', '当前步骤 3 / 3'))
    card.appendChild(h('h2', null, '导入到数据包'))
    const nd = (S.status && S.status.newestDump) || {}
    const inst = curInst()
    card.appendChild(h('p', 'desc', `检测到${inst ? inst.name : '目标实例'}刚产出的数据（${shortStamp(nd.capturedAt) || '--'}）。导入会把图标与物品名写进项目内的数据包，预览包刷新后即可读取。`))
    const meta = h('div', 'meta')
    meta.appendChild(h('span', null, `产物 pull2 · ${nf(nd.pages)} 页`))
    meta.appendChild(h('span', null, `物品 ${nf(nd.count)} 项`))
    meta.appendChild(h('span', null, `图标 ${nf(nd.count)} 张（48px · 真 alpha）`))
    card.appendChild(meta)
    const cta = h('div', 'cta-row')
    const busy = S.busy === '导入游戏内数据'
    const b = btn(busy ? '导入中…' : '导入到数据包', 'primary', () => startImport())
    b.disabled = busy
    cta.append(b, h('span', 'hint-inline', '整体替换 · 中途取消不留半成品'))
    card.appendChild(cta)
    return card
  }

  // ---- 步骤 4：导入中（进度 + 取消）----
  function stage4Card() {
    const p = S.progress || { page: 0, totalPages: 0, items: 0, totalItems: 0 }
    const card = h('div', 'stage-card')
    card.appendChild(h('div', 'kicker', '正在导入'))
    card.appendChild(h('h2', null, '导入到数据包…'))
    const prog = h('div', 'prog')
    const bar = h('div', 'bar')
    const fill = h('i')
    fill.style.width = Math.round((p.page / (p.totalPages || 1)) * 100) + '%'
    bar.appendChild(fill)
    const nums = h('div', 'nums')
    nums.appendChild(h('span', null, `第 ${p.page} / ${p.totalPages || '?'} 页`))
    nums.appendChild(h('span', null, `已处理 ${nf(p.items)} / ${nf(p.totalItems || 0)} 项`))
    prog.append(bar, nums)
    card.appendChild(prog)
    const cta = h('div', 'cta-row')
    cta.append(btn('取消', '', () => cancelImport()), h('span', 'hint-inline', '取消时数据包保持原样（原子替换）'))
    card.appendChild(cta)
    return card
  }

  // ---- 步骤 5：完成 / 已取消 ----
  function stage5Card() {
    const card = h('div', 'stage-card')
    if (S.importPhase === 'done' && S.delta) {
      const d = S.delta
      card.appendChild(h('div', 'kicker', '完成'))
      card.appendChild(h('h2', null, '数据包已更新'))
      const banner = h('div', 'banner')
      banner.appendChild(h('div', 'big', d.first ? nf(d.totalItems) : '+' + nf(d.items)))
      const txt = h('div', 'txt')
      if (d.first) txt.textContent = `首次采集完成 —— 图标 ${nf(d.totalIcons)} 张 / 物品 ${nf(d.totalItems)} 项，全部来自真实游戏内渲染；数据包已创建 —— 预览包刷新后生效。`
      else if (d.items === 0 && d.icons === 0) txt.textContent = `本次没有变化（数据包现有 ${nf(d.totalItems)} 项 / ${nf(d.totalIcons)} 张图标）—— 预览包刷新后生效。`
      else txt.textContent = `本次新增 +${nf(d.items)} 项 · +${nf(d.icons)} 张图标；数据包现有 ${nf(d.totalItems)} 项 / ${nf(d.totalIcons)} 张图标 —— 预览包刷新后生效。`
      banner.appendChild(txt)
      card.appendChild(banner)
      const cta = h('div', 'cta-row')
      cta.append(btn('再跑一轮采集', '', () => again()), btn('看看有没有新产物', 'ghost', () => checkProducts()))
      card.appendChild(cta)
    } else {
      card.appendChild(h('div', 'kicker', '已取消'))
      card.appendChild(h('h2', null, '导入已取消，数据包未被改动'))
      card.appendChild(h('p', 'desc', '导入采用「整体替换」：先写临时目录、校验后才替换正式数据，所以中途取消不会留下半套数据。'))
      const cta = h('div', 'cta-row')
      cta.appendChild(btn('重新导入', 'primary', () => startImport()))
      card.appendChild(cta)
    }
    return card
  }

  // ---- 数据包区 ----
  // ★ B2：把"哪些路径没解析到、缺了会怎样、怎么配"说清楚（§0.6 失败必须可见）。
  //   只在**真的缺**的时候出现 —— 正常用户看不到任何额外噪音。
  function renderPathsWarn() {
    if (!parts.pathsWarn) return
    const px = (S.status && S.status.paths && S.status.paths.keys) || {}
    const HINT = {
      MC_ROOT: '扫不到游戏实例（实例清单会是空的）',
      DATA_DIR: '没有项目路径时没有落盘位置',
      REGISTRY: '采集会降级到「语言文件里的键」，候选方块的覆盖会明显变少',
    }
    const bad = Object.keys(HINT).filter((k) => px[k] && px[k].source === 'none')
    if (!bad.length) { parts.pathsWarn.replaceChildren(); return }
    const cfg = (S.status.paths.config && S.status.paths.config.path) || '%APPDATA%/modmind/mc-paths.json'
    const list = bad.map((k) => `${k}（${HINT[k]}）`).join('；')
    parts.pathsWarn.replaceChildren(noteBox('warn',
      `这些路径没解析到：${list}。设置方式二选一：① 环境变量（MC_ROOT 用 PREVIEW_MC，DATA_DIR 用 PREVIEW_DATA，`
      + `REGISTRY 用 PREVIEW_PULL_REGISTRY，PROBE_DIR 用 PREVIEW_PROBE_DIR）；② 在 ${cfg} 里配同名键。`))
  }

  function renderPacks() {
    renderPathsWarn()
    if (!S.packs.length) {
      const empty = h('div', 'pack-empty')
      empty.appendChild(h('span', 'pe-ico', '＋'))
      const d = h('div')
      d.appendChild(h('div', 'pe-t', '（还没有数据包）'))
      d.appendChild(h('div', 'pe-sub', '完成上面三步后，采集结果会出现在这里 —— 面板只显示真实读到的内容，不预先估计'))
      empty.appendChild(d)
      parts.packs.replaceChildren(empty)
      return
    }
    // ★ 每个数据包行右侧都有「清除…」+ 行内二次确认（danger/ghost 按钮 stopPropagation，避免误触发"选中该包"）。
    //   当前包由后端拦截（见 doClear）：规格 1.2「当前包拦截日志」。
    parts.packs.replaceChildren(...S.packs.map((p) => {
      const active = p.key === S.activePack
      const wrap = h('div', 'pack-wrap')
      wrap.setAttribute('data-key', p.key)
      const row = h('div', 'pack' + (active ? ' active' : ''))
      row.onclick = () => selectPack(p.key)
      row.appendChild(h('span', 'radio'))
      const info = h('div', 'info')
      const t = h('div', 't', p.title)
      // ★ 2026-10-12 B1（规范 §0.6「失败必须可见」）：把"物品属性从哪来、可不可信"**显示出来**。
      //   为什么必须显：免探针路线（本地直读）**根本没有属性来源** —— 堆叠上限/耐久写在游戏代码里，
      //   静态读 jar 拿不到。产物里那两个数组原来是 64/false 占位，界面上又一句不提
      //   ⇒ 用户会把"占位"当"实测"。这正是审计里 B1 列的"用户会被骗"。
      //   消费点（实测）：`app/app.js` 的 `maxStackOf = (i) => ITEMS.maxStack[i] || 64` 拿它做**堆叠**判定
      //   ⇒ 占位 64 会让钻石镐这类本该叠 1 的也叠到 64。
      // ★ 来源徽标（**既有功能，不许删**）：数据是从哪来的
      if (p.source === 'probe:pull2') t.appendChild(h('span', 'src probe', '游戏内真渲染'))
      else if (p.source === 'local-assets') t.appendChild(h('span', 'src', '本地直读'))
      else t.appendChild(h('span', 'src', '来源未知'))
      // ★ 属性可信度徽标（2026-10-12 B1 新增）：字段可不可信 —— 与"来源"是两个概念，
      //   所以**用独立类名 `attr-badge`**，不蹭 `.src`。理由见下：
      //   第一版我写成 `src warn`，结果闸门里那条老断言 `q('.pack .src')` 先命中了属性徽章
      //   ⇒ 老断言拿到「属性未知」而红。**给已有组件加"同前缀"新元素时，先查有没有 `.cls` 单类
      //   选择器会被抢先命中**（`querySelector` 返回的是**文档序第一个**，不是最匹配那个）。
      const prov = p.attrProvenance || ''
      if (prov === 'unknown') t.appendChild(h('span', 'attr-badge', '属性未知'))
      else if (prov === 'probe-mismapped') t.appendChild(h('span', 'attr-badge', '属性不可信'))
      else if (prov === 'probe') t.appendChild(h('span', 'src probe', '属性来自游戏内'))
      if (active) t.appendChild(h('span', 'cur', '当前使用'))
      info.appendChild(t)
      const srcLabel = p.source === 'probe:pull2' ? '游戏内真渲染' : (p.source === 'local-assets' ? '本地直读' : '来源未知')
      const attrHint = prov === 'unknown'
        ? ' · 属性（堆叠/耐久）无来源，已标为未知'
        : (prov === 'probe-mismapped' ? ' · 属性字段取错 API，已标为不可信' : '')
      info.appendChild(h('div', 'sub', `${srcLabel} · ${nf(p.count)} 项 · ${nf(p.icons)} 张图标 · ${shortStamp(p.capturedAt) || '--'}${attrHint}`))
      row.appendChild(info)
      row.appendChild(btn('导出', 'ghost sm pack-exp', (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        void exportPack(p.key)
      }))
      row.appendChild(btn('清除…', 'ghost sm pack-del', (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        S.clearPending = S.clearPending === p.key ? '' : p.key
        renderPacks()
      }))
      wrap.appendChild(row)
      if (S.clearPending === p.key) {
        const c = h('div', 'clear-confirm')
        c.appendChild(h('span', null, `将删除「${p.title}」：${nf(p.icons)} 张图标 / ${nf(p.count)} 项${active ? '。它是预览包正在用的数据包。' : ''} 此操作不可撤销。`))
        c.appendChild(h('span', 'sp'))
        c.append(
          btn('确认清除', 'danger sm', (e) => { if (e && e.stopPropagation) e.stopPropagation(); doClear(p.key) }),
          btn('取消', 'ghost sm', (e) => { if (e && e.stopPropagation) e.stopPropagation(); S.clearPending = ''; renderPacks() }),
        )
        wrap.appendChild(c)
      }
      return wrap
    }))
  }

  function renderAuto() {
    parts.autoSwitch.setAttribute('aria-checked', S.auto ? 'true' : 'false')
    parts.autoSub.replaceChildren()
    if (S.auto) {
      parts.autoSub.appendChild(h('span', 'live-dot'))
      parts.autoSub.appendChild(h('span', null, '监听中 · 每 8 秒检查一次游戏内产物，发现新的自动导入'))
    } else {
      parts.autoSub.appendChild(h('span', null, '已关闭 —— 需要手动点「检查产物」再导入'))
    }
  }

  function renderLogs() {
    if (!S.logs.length) { parts.logBody.replaceChildren(h('div', 'log-empty', '还没有操作记录。')); return }
    parts.logBody.replaceChildren(...S.logs.map((l) => {
      const row = h('div', 'log-line ' + l.kind)
      row.append(h('span', 'ts num', l.t), h('span', 'dd'), h('span', 'm', l.text))
      return row
    }))
  }

  // ============================ 动作 ============================
  function startScan() {
    S.scanPhase = 'scanning'
    log('info', '正在扫描游戏实例…')
    renderAll()
    void refresh()
  }

  async function refresh() {
    let st = null
    try {
      const input = { projectPath }
      if (S.activeInstance) input.instanceDir = S.activeInstance
      st = await invoke('pull:status', input)
    } catch (e) {
      S.scanPhase = 'done'
      log('err', '读取状态失败：' + msg(e))
      renderAll()
      return
    }
    S.status = st
    const firstDone = S.scanPhase === 'scanning'
    S.scanPhase = 'done'
    S.scanAt = clock(new Date())
    if (!S.activeInstance && st.instanceDir) S.activeInstance = st.instanceDir
    S.packs = st.packs || []
    S.activePack = st.activeKey || (S.packs[0] && S.packs[0].key) || ''
    if (S.auto && probeState() === 'installed' && !S.listeningSince) S.listeningSince = Date.now()
    if (firstDone) log('ok', `扫描完成：发现 ${instances().length} 个可用实例（${((st.scan && st.scan.sources) || []).join(' · ')}）`)
    if (st.importProgress && st.importProgress.state === 'importing') {
      S.progress = { page: st.importProgress.page, totalPages: st.importProgress.totalPages, items: st.importProgress.items, totalItems: st.importProgress.totalItems }
    }
    renderAll()
    maybeAutoLocal(st)
  }

  /**
   * 项目里一个数据包都没有时，自动直读本地游戏文件（免探针、免启动游戏）—— 保留为自动基础版。
   * 状态机：未跑过才跑；done/blocked 不重跑；failed 允许下次刷新重试。
   */
  function maybeAutoLocal(st) {
    const packs = (st && st.packs) || []
    if (!st || !projectPath || !S.auto || packs.length) return
    if (S.local === 'running' || S.local === 'done' || S.local === 'blocked') return
    void autoLocal()
  }
  async function autoLocal() {
    if (S.local === 'running') return
    S.local = 'running'
    setBusy('正在自动获取本地游戏数据…')
    try {
      const input = { projectPath }
      if (S.activeInstance) input.instanceDir = S.activeInstance
      const r = await invoke('pull:run', input)
      S.local = 'done'
      // ★ 成功后必须清忙标志：否则后续「装入探针 / 导入」会被 `if (S.busy) return` 永久挡掉。
      S.busy = ''
      log('ok', `自动获取本地游戏数据完成：${nf(r.count)} 条 → 数据包「${r.key}」，已设为当前使用`)
      if (r.dropped) log('info', `${nf(r.dropped)} 条没有可用贴图图标已跳过；装探针启动游戏可补齐并升级真渲染图标`)
      await refresh()
    } catch (e) {
      S.local = 'failed'
      setBusy('')
      log('err', '自动获取本地游戏数据失败：' + msg(e) + '（点「重新扫描」可重试）')
    }
  }

  async function installProbe() {
    if (S.busy) return
    const inst = curInst()
    if (inst && inst.probe === 'none') { log('err', '当前实例没有可用的探针构建'); renderAll(); return }
    setBusy('装入探针')
    const jar = inst && inst.matched ? inst.matched : ''
    log('info', '正在检测实例并复制探针（2 处目录）…')
    const input = { projectPath }
    if (S.activeInstance) input.instanceDir = S.activeInstance
    // 装入过程三阶段文案：真实操作（检测 → 复制 2 处目录 → 校验）与它并行跑；每阶段至少渲染一拍，
    // 这样小实例"秒完成"时「正在复制… / 正在校验…」也不会被 clearTimeout 抹掉（规格 1.2 要求三阶段都能看到）。
    const phase = async (m) => { S.installMsg = m; renderAll(); await new Promise((r) => setTimeout(r, 140)) }
    const pending = invoke('pull:installProbe', input)
    pending.catch(() => { /* 拒绝留给下面 await 处理，避免未处理拒绝告警 */ })
    try {
      await phase('正在检测实例…')
      await phase(jar ? `正在复制 ${jar}（2 处目录）…` : '正在复制探针（2 处目录）…')
      await phase('正在校验…')
      const r = await pending
      for (const t of r.targets || []) log('ok', '探针已装 → ' + t.label + (t.configAt ? '（采集配置已写入：mode=pull）' : ''))
      if (r.missing && r.missing.length) log('warn', '这些目标没装上：' + r.missing.join('、'))
      if (r.removed && r.removed.length) log('info', '清掉同 mod 旧版本：' + r.removed.join('、'))
      log('info', clean(r.note || ''))
      S.busy = ''; S.installMsg = ''
      await refresh()
      if (S.auto && !S.listeningSince) S.listeningSince = Date.now()
      renderAll()
    } catch (e) {
      setBusy(''); S.installMsg = ''
      log('err', '装探针失败：' + msg(e))
    }
  }

  async function startImport() {
    if (S.busy) return
    S.importPhase = 'importing'
    S.progress = { page: 0, totalPages: (S.status && S.status.newestDump && S.status.newestDump.pages) || 0, items: 0, totalItems: 0 }
    S.busy = '导入游戏内数据'
    log('act', '开始导入 pull2 产物…')
    renderAll()
    try { await invoke('pull:cancel', { projectPath, on: false }) } catch { /* 清位失败不致命 */ }
    // ★ "首采 / 增量"的判据落在**目标数据包**上（= 当前选中实例的 key）：该包本来不存在 ⇒ 首采。
    //   同一个包再次导入（含本地直读 → 探针升级）就是增量，N=0 要显性说"没有变化"（规格 1.2 第 8 条）。
    const targetKey = (S.status && S.status.packKey) || ''
    const prevPack = (S.packs || []).find((p) => p.key === targetKey) || null
    const hadPack = !!prevPack
    const prevCount = prevPack ? Number(prevPack.count) || 0 : 0
    const poll = setInterval(() => { void pollProgress() }, 600)
    try {
      const input = { projectPath }
      if (S.activeInstance) input.instanceDir = S.activeInstance
      const r = await invoke('pull:importProbe', input)
      clearInterval(poll)
      S.busy = ''
      S.importPhase = 'done'
      await refresh()
      const ap = activePack()
      const totalItems = ap ? Number(ap.count) || 0 : Number(r.count) || 0
      const totalIcons = ap ? Number(ap.icons) || 0 : totalItems
      S.delta = { first: !hadPack, items: Math.max(0, totalItems - prevCount), icons: Math.max(0, totalIcons - prevCount), totalItems, totalIcons }
      log('ok', `导入完成：${nf(r.count)} 条 / ${r.pages}${r.totalPages ? '/' + r.totalPages : ''} 页`)
      if (r.residualOk === false) log('warn', '部分图标 alpha 解可能不可信（回归残差超阈值）')
      renderAll()
    } catch (e) {
      clearInterval(poll)
      S.busy = ''
      const cancelled = /已取消/.test(msg(e))
      S.importPhase = cancelled ? 'cancelled' : 'idle'
      log(cancelled ? 'warn' : 'err', (cancelled ? '导入已取消（数据包未被改动）' : '导入失败：' + msg(e)))
      renderAll()
    }
  }

  async function pollProgress() {
    if (S.importPhase !== 'importing') return
    try {
      const input = { projectPath }
      if (S.activeInstance) input.instanceDir = S.activeInstance
      const st = await invoke('pull:status', input)
      const ip = st && st.importProgress
      if (ip) {
        S.progress = { page: ip.page, totalPages: ip.totalPages, items: ip.items, totalItems: ip.totalItems || 0 }
        renderStatus(); renderStage()
      }
      if (st) { S.status = st; S.packs = st.packs || [] }
    } catch { /* 轮询失败不刷屏 */ }
  }

  async function cancelImport() {
    try { await invoke('pull:cancel', { projectPath, on: true }) } catch { /* 尽力而为 */ }
    log('warn', '已请求取消导入 —— 数据包将保持原样')
    renderAll()
  }

  async function selectInstance(dir) {
    if (dir === S.activeInstance) { closeInstMenu(); return }
    S.activeInstance = dir
    S.importPhase = 'idle'; S.delta = null; S.launchGuided = false
    const inst = curInst()
    closeInstMenu()
    log('act', `已切换目标实例 → ${inst ? inst.name : dir}（${inst ? [inst.loader, inst.mc].filter(Boolean).join(' ') : ''}${inst && inst.probe === 'none' ? ' · 无探针构建' : ''}）`)
    await refresh()
  }

  async function selectPack(key) {
    if (!key || key === S.activePack) return
    try {
      await invoke('pull:select', { projectPath, key })
      S.activePack = key; S.clearPending = ''
      log('act', '已切换数据包 → ' + key)
      renderAll()
    } catch (e) { log('err', '切换失败：' + msg(e)) }
  }

  async function doClear(key) {
    // 当前使用也允许清除（真机 2026-10-11：之前"不能就地清除"在只有一个包时是死胡同）。
    // 确认条已列出将删内容；删的是当前包时后端会把"当前使用"自动交给剩余的第一个包。
    try {
      const r = await invoke('pull:clear', { projectPath, key })
      S.clearPending = ''
      log('warn', `已清除数据包 ${r.key}（${nf(r.files)} 张图标）${r.activeKey ? '；当前使用 → ' + r.activeKey : '；当前没有数据包在使用'}`)
      // 用户明确清除 ⇒ 本会话不再自动直读复活（重开面板才会重新获取）
      S.local = 'blocked'
      await refresh()
    } catch (e) { log('err', '清除失败：' + msg(e)); S.clearPending = ''; renderAll() }
  }

  /** 导出数据包（2026-10-11）：打成 zip 落盘到项目 exports/，日志给全路径（用户可直接去拿文件）。 */
  async function exportPack(key) {
    if (S.busy) return
    setBusy('导出数据包')
    log('act', `正在导出数据包「${key}」…`)
    try {
      const r = await invoke('pull:exportPack', { projectPath, key })
      log('ok', `已导出「${r.key}」：${nf(r.count)} 个文件（含 ${nf(r.icons)} 张图标）· ${(r.bytes / 1048576).toFixed(2)} MB`)
      log('info', '文件位置：' + r.file)
      S.busy = ''
      setMsg('数据包已导出 —— 文件路径见下方「最近操作」')
    } catch (e) {
      S.busy = ''
      log('err', '导出失败：' + msg(e))
    }
    renderAll()
  }

  /** 一键启动游戏：调后端 pull:launch（真 spawn 实例自己的 java 命令行）；dryRun 时只构建命令。 */
  async function launchGame() {
    if (S.launching) return
    S.launching = true
    log('act', '正在启动游戏…（用实例自己的版本 json 拼启动命令）')
    renderAll()
    try {
      const input = { projectPath }
      if (S.activeInstance) input.instanceDir = S.activeInstance
      const r = await invoke('pull:launch', input)
      if (r.dryRun) { log('info', '启动命令已构建（dryRun 模式，没有真的启动）' + (r.probeConfigFixed ? '；启动自检补齐了采集配置（mode=pull）' : '')); S.launchGuided = true }
      else if (r.launched) {
        log('ok', `游戏已启动（java PID ${r.pid} · 内存 ${r.memMb} MB）——拉起到主界面即可退出，产出后自动导入。`)
        if (r.probeConfigFixed) log('act', '启动自检：探针在但采集配置缺失/不对 —— 已补齐 mode=pull（这次会真的采集）。')
        S.launchGuided = true
      }
      else log('info', r.note || '没有启动。')
    } catch (e) { log('err', '启动失败：' + msg(e)) }
    S.launching = false
    renderAll()
  }
  async function checkProducts() {
    setBusy('检查产物…')
    await refresh()
    S.busy = ''
    if (S.status && S.status.needsImport) log('ok', '发现新产物，可以导入')
    else log('info', '扫描完成：没有发现新产物')
    renderAll()
  }
  function again() {
    S.importPhase = 'idle'; S.delta = null
    if (S.auto) S.listeningSince = Date.now()
    log('info', '再跑一轮：点「一键启动游戏」启动一次实例，产出后自动导入')
    renderAll()
  }

  /** 自动采集心跳：看一眼状态 → 有比当前数据包更新的产物就自动导入。 */
  async function tick() {
    if (!S.auto || S.busy || !projectPath) return
    try {
      const input = { projectPath }
      if (S.activeInstance) input.instanceDir = S.activeInstance
      const st = await invoke('pull:status', input)
      S.status = st
      S.packs = st.packs || []
      S.activePack = st.activeKey || S.activePack
      renderAll()
      const d = st.newestDump
      if (st.needsImport && d && d.capturedAt !== S.lastAutoAt && S.importPhase !== 'importing') {
        S.lastAutoAt = d.capturedAt
        log('act', `自动采集：发现新的游戏内产物（${shortStamp(d.capturedAt)} · ${nf(d.pages)} 页），开始导入…`)
        await startImport()
      }
      maybeAutoLocal(st)
    } catch { /* 轮询失败不刷屏 */ }
  }

  // 打开面板 → 第一件事：填满初始 UI 并扫描
  S.logs = [{ t: clock(new Date()), kind: 'info', text: '面板已打开' }]
  renderAll()
  try { void invoke('pull:cancel', { projectPath, on: false }) } catch { /* 忽略 */ }
  const kick = setTimeout(() => { void startScan() }, 60)
  const timer = setInterval(() => { void tick() }, 8000)
  return {
    refresh,
    dispose() { clearInterval(timer); clearTimeout(kick) },
  }
}

function PullWorkspace(props) {
  const React = (globalThis.__modmindFeatureHost || {}).React
  if (!React) return null
  const ref = React.useRef(null)
  const projectPath = (props && ((props.project && props.project.path) || props.projectPath || props.path))
    || globalThis.__MCPULL_PROJECT__ || ''
  React.useEffect(() => {
    const el = ref.current
    if (!el || el.dataset.mcpullBooted) return
    el.dataset.mcpullBooted = '1'
    const shadow = el.shadowRoot || el.attachShadow({ mode: 'open' })
    if (!shadow.querySelector('style.mcpull-css')) {
      const st = document.createElement('style')
      st.className = 'mcpull-css'
      st.textContent = CSS
      shadow.appendChild(st)
    }
    const old = shadow.querySelector('.mcpull-wrap')
    if (old) old.remove()
    const wrap = document.createElement('div')
    wrap.className = 'mcpull-wrap'
    const rootEl = document.createElement('div')
    rootEl.className = 'mcpull-root'
    wrap.appendChild(rootEl)
    shadow.appendChild(wrap)
    let app = null
    try { app = createApp(rootEl, projectPath) } catch (e) { console.error('[mc-pull] 面板初始化失败', e) }
    return () => {
      try { app && app.dispose() } catch { /* 尽力而为 */ }
      try { delete el.dataset.mcpullBooted } catch { /* 允许重新挂载 */ }
    }
  }, [])
  return React.createElement('div', { ref, className: 'mcpull-host' })
}

function register() {
  const reg = globalThis.__modmindRegisterFeature
  if (typeof reg === 'function') reg(FEATURE_ID, { PullWorkspace })
  else console.warn('[mc-pull] 宿主未提供 __modmindRegisterFeature')
}
register()
