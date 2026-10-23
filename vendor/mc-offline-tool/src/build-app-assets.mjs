// build-app-assets.mjs —— 从「游戏实际解析后的资源」构建前端资源
//
// 为什么不用 jar：jar 里那份只是其中一个来源。本实例的 resourcePacks 含 mod_resources
// 与 gtceu:dynamic_assets，mod 可以覆盖 GUI 贴图与字体。实测两处决定性差异：
//   1. minecraft/font/include/unifont.json 在 jar 里是【空 provider 列表】（29 字节），
//      而游戏解析后是真正的 unihex provider（1879 字节）——所以「读 jar」根本得不到游戏用的字体配置。
//   2. 游戏里的中文来自 modernui/font/source-han-sans-cn-medium.otf（8.3 MB），
//      拉丁来自 modernui/font/inter-frozen-medium.otf。这两份只存在于 mod 的 assets 里。
// 所以资源层的正确做法是：问游戏要（probe 的 dumpResolved），而不是猜 jar。
//
// 用法：node build-app-assets.mjs --resolved <.../pull2/resolved> --out <app/data>

import fs from 'node:fs';
import path from 'node:path';

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
const args = parseArgs(process.argv.slice(2));
const resolved = path.resolve(args.resolved || '');
const outDir = path.resolve(args.out || 'app/data');

if (!fs.existsSync(resolved)) {
  console.error('找不到 resolved 目录：' + resolved);
  console.error('先跑一次 probe 的 pull 阶段（captureIcons=false 即可）。');
  process.exit(1);
}

const gameDir = path.join(outDir, 'game');
fs.rmSync(gameDir, { recursive: true, force: true });

const copied = [];
const skip = [];
function copy(rel) {
  const src = path.join(resolved, rel);
  if (!fs.existsSync(src)) { skip.push(rel); return false; }
  const dst = path.join(gameDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied.push({ rel, bytes: fs.statSync(dst).size });
  return true;
}

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

// 1. GUI 贴图与字体贴图：整棵 textures/gui 与 textures/font 都要
//    （跳过 realms 的大图与 packmenu 的整屏背景，与物品栏无关，且体积大）
const BIG_SKIP = /^(realms\/|packmenu\/|minecraft\/textures\/gui\/presets\/)/;
const all = walk(resolved);
const guiTextures = [];
for (const rel of all) {
  if (!rel.includes('/textures/gui/') && !rel.startsWith('textures/gui/')) continue;
  if (!rel.endsWith('.png')) continue;
  if (BIG_SKIP.test(rel)) { skip.push(rel); continue; }
  const ns = rel.split('/')[0];
  if (copy(rel)) guiTextures.push(ns + ':' + rel.slice(ns.length + 1, -4));
}
const fontTextures = all.filter((r) => r.includes('/textures/font/') && r.endsWith('.png'));
for (const rel of fontTextures) copy(rel);

// 2. 字体本体：现代 UI 用矢量字体渲染文本，这是「和游戏一样」的关键
const fontFiles = all.filter((r) => /\/font\/.*\.(otf|ttf)$/i.test(r));
for (const rel of fontFiles) copy(rel);

// 3. 字体配置链（保留证据，也用于回退到原版位图字体）
const fontJson = all.filter((r) => /\/font\/.*\.json$/.test(r));
for (const rel of fontJson) copy(rel);
const fontZip = all.filter((r) => /\/font\/.*\.zip$/.test(r));
for (const rel of fontZip) copy(rel);

// 4. 语言文件：界面文案也从游戏取（container.inventory 等）
const langFiles = all.filter((r) => /\/lang\/zh_cn\.json$/.test(r));
for (const rel of langFiles) copy(rel);

// 5. 创造模式分类页签（由 probe 的 dumpCreativeTabs 生成，在 resolved 的同级）
const tabsSrc = path.join(resolved, '..', 'creative-tabs.json');
let tabCount = 0;
if (fs.existsSync(tabsSrc)) {
  const raw = fs.readFileSync(tabsSrc);
  const dst = path.join(gameDir, 'creative-tabs.json');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(tabsSrc, dst);
  const parsed = JSON.parse(raw.toString('utf8'));
  tabCount = parsed.tabCount;
  copied.push({ rel: 'creative-tabs.json', bytes: raw.length });
} else {
  skip.push('creative-tabs.json（probe 未导出）');
}

// 5. fonts.css：把游戏的矢量字体暴露给浏览器
const pick = (re) => fontFiles.map((r) => r.replace(/^\//, '')).filter((r) => re.test(r));
const inter = pick(/inter-frozen-medium\.otf$/i)[0] || null;
const interItalic = pick(/inter-frozen-medium-italic\.otf$/i)[0] || null;
const han = pick(/source-han-sans-cn-medium\.otf$/i)[0] || null;
const mono = pick(/jetbrains-mono-medium\.ttf$/i)[0] || null;

const css = [];
const face = (family, file, style) => {
  if (!file) return;
  css.push(`@font-face {\n  font-family: '${family}';\n  src: url('../game/${file}') format('${/\.otf$/i.test(file) ? 'opentype' : 'truetype'}');${
    style ? `\n  font-style: ${style};` : ''}\n  font-display: block;\n}`);
};
face('MCUI', inter);
face('MCUI', interItalic, 'italic');
face('MCCJK', han);
face('MCMono', mono);
fs.mkdirSync(path.join(outDir, 'font'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'font', 'fonts.css'), css.join('\n\n') + '\n');

const manifest = {
  source: 'ResourceManager (pack-resolved, dumped by probe pull stage)',
  guiScale: null,
  fontLineHeight: null,
  guiTextureCount: guiTextures.length,
  guiTextures,
  fonts: { latin: inter, latinItalic: interItalic, cjk: han, mono },
  langFiles,
  creativeTabCount: tabCount,
  copiedCount: copied.length,
  skipped: skip.length,
};
// 把游戏自己的 GUI 缩放与字体行高带进来（前端据此对齐原版版式）
const rmPath = path.join(resolved, '..', 'resolved-manifest.json');
if (fs.existsSync(rmPath)) {
  const rm = JSON.parse(fs.readFileSync(rmPath, 'utf8'));
  manifest.guiScale = rm.guiScale ?? null;
  manifest.fontLineHeight = rm.fontLineHeight ?? null;
}
fs.writeFileSync(path.join(gameDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

console.log(JSON.stringify({
  resolved, outDir, copiedCount: copied.length, skipped: skip.length,
  guiTextures: guiTextures.length,
  fonts: manifest.fonts,
  css: path.join(outDir, 'font', 'fonts.css'),
  skippedSample: skip.slice(0, 8),
}, null, 1));
