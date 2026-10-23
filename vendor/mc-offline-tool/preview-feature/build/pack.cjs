// build/pack.cjs —— 打成 `.mmfeature`（ZIP）并**照抄宿主 `prepareFeaturePlugin` 的口径回验**。
//
// 回验项（每一条都对应一次踩过的坑）：
//   ① ZIP ≤ 64 MiB、解压后 ≤ 128 MiB（宿主硬限制）；
//   ② 条目数 === Object.keys(manifest.files).length + 1（manifest.json 自己）—— 宿主这么数；
//   ③ manifest.files 是 **{ 路径: sha256 } 对象**（宿主 `files['main.cjs']` 这么取）；
//   ④ 逐条 sha256 必须与包内字节一致；路径不得绝对/含 `..`；不得重名；
//   ⑤ **每个 `views[].component` 必须出现在 renderer.js 里**（`pack.py` 241–242 行那条 —— 我们自己的
//      旧 pack.cjs 漏抄过它，结果 -m2 能"回验全绿"却装不上）；
//   ⑥ **`require` 真跑一遍 main.cjs**：`activate()` 必须返回函数，且 manifest 里每个 `actions[].handler`
//      都能对上、每个 `action.id` 都含冒号（宿主按冒号建 preload 路由表）。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 最小 ZIP 写入（deflate） */
function zipWrite(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function packFeature({ pkgDir, distDir }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.base.json'), 'utf8'));
  const names = [manifest.main, manifest.renderer, manifest.style].filter(Boolean);
  const files = names.map((n) => ({ name: n, data: fs.readFileSync(path.join(distDir, n)) }));
  // 第三方许可 / 说明：`assets/` 下的文件**都**随包带上。
  // （deepslate 与 gl-matrix 是 MIT，署名与许可原文必须跟着产物走；宿主的 allowedFile 也允许 assets/**）
  const assetsDir = path.join(pkgDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const n of fs.readdirSync(assetsDir).sort()) {
      const f = path.join(assetsDir, n);
      if (fs.statSync(f).isFile()) files.push({ name: 'assets/' + n, data: fs.readFileSync(f) });
    }
  }

  // ⑤ 组件名必须出现在 renderer.js（pack.py 有、我们旧 pack.cjs 漏了的那条）
  const rendSrc = files.find((f) => f.name === manifest.renderer).data.toString('utf8');
  for (const v of manifest.views || []) {
    if (!rendSrc.includes(v.component)) throw new Error(`renderer.js 里找不到组件 ${v.component}（manifest 里声明了）`);
  }

  // ⑦ 宿主 `validate()` / `validateContributions()` 的**声明式硬要求**。
  //    这几条我们是踩过坑才补的：只回验 ZIP 口径（旧 pack.cjs）会"全绿却装不上",
  //    宿主实际报的是「插件动作声明无效」——根因就是下面第 3 条（action 必须有 inputSchema）。
  if (manifest.format !== 'modmind-feature' || manifest.apiVersion !== 2 || manifest.hostVersion !== '1.5.0-plugintest')
    throw new Error('format/apiVersion/hostVersion 与宿主要求不兼容（须 modmind-feature / 2 / 1.5.0-plugintest）');
  if (manifest.main !== 'main.cjs' || manifest.renderer !== 'renderer.js' || manifest.style !== 'renderer.css')
    throw new Error('main/renderer/style 必须恰好是 main.cjs / renderer.js / renderer.css（缺 style 会报「插件入口无效」）');
  for (const n of ['main.cjs', 'renderer.css', 'renderer.js'])
    if (!names.includes(n)) throw new Error('包里缺少 ' + n + '（宿主要求这三个都在文件清单里）');

  const ID_OK = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
  const HANDLER_OK = /^[A-Za-z][A-Za-z0-9:._-]*$/;
  for (const key of ['capabilities', 'views', 'actions']) {
    const list = manifest[key] || [];
    const ids = list.map((e) => e.id);
    if (ids.some((id) => typeof id !== 'string' || !ID_OK.test(id)) || new Set(ids).size !== ids.length)
      throw new Error(key + ' 的标识为空 / 非法 / 重复');
  }
  for (const a of manifest.actions || []) {
    if (typeof a.handler !== 'string' || a.handler.length > 80 || !HANDLER_OK.test(a.handler))
      throw new Error('action.handler 非法：' + a.id);
    if (!a.inputSchema || typeof a.inputSchema !== 'object' || Array.isArray(a.inputSchema) || a.inputSchema.type !== 'object')
      throw new Error('action.inputSchema 缺失或不是 { type:"object" }（宿主会报「插件动作声明无效」）：' + a.id);
    if (!['read', 'write', 'network', 'process'].includes(a.permission)) throw new Error('action.permission 非法：' + a.id);
    if (a.projectRequired !== undefined && typeof a.projectRequired !== 'boolean') throw new Error('action.projectRequired 必须是布尔：' + a.id);
    if (a.surfaces !== undefined && (!Array.isArray(a.surfaces) || !a.surfaces.length || a.surfaces.some((s) => !['workbench', 'inspiration'].includes(s))))
      throw new Error('action.surfaces 只能含 workbench / inspiration：' + a.id);
  }
  // 宿主 allowedFile()：只允许 manifest.json / main.cjs / renderer.js / renderer.css，以及 assets/ 下"安全片段"
  const SAFE_PART = /^[A-Za-z0-9_. -]+$/;
  for (const f of files) {
    if (['main.cjs', 'renderer.js', 'renderer.css'].includes(f.name)) continue;
    const parts = f.name.split('/');
    const ok = f.name.startsWith('assets/') && f.name.length <= 512 && parts.every(
      (p) => SAFE_PART.test(p) && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p),
    );
    if (!ok) throw new Error('宿主不允许该路径：' + f.name);
  }

  // ⑥ 真跑一遍后端
  const mod = require(path.join(distDir, manifest.main));
  if (typeof mod.activate !== 'function') throw new Error('main.cjs 没有导出 activate');
  const handlers = mod.activate({});
  for (const a of manifest.actions || []) {
    if (!a.id.includes(':')) throw new Error('action.id 必须含冒号（宿主按冒号建路由表）：' + a.id);
    if (typeof handlers[a.handler] !== 'function') throw new Error(`manifest 声明的 handler 后端没有：${a.handler}`);
  }

  // ③ manifest.files = { 路径: sha256 }
  manifest.files = {};
  for (const f of files) manifest.files[f.name] = sha256(f.data);

  const zip = zipWrite([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }, ...files]);
  const out = path.join(distDir, `${manifest.id}-${manifest.version}.mmfeature`);
  fs.writeFileSync(out, zip);

  // ①②④ 回验（照宿主口径）
  const entryCount = files.length + 1;
  const fileCount = Object.keys(manifest.files).length;
  if (fileCount + 1 !== entryCount) throw new Error(`条目数对不上：zip ${entryCount} vs files+1 ${fileCount + 1}`);
  if (zip.length > 64 * 1024 * 1024) throw new Error('包超过宿主 64 MiB 上限');
  const unpacked = files.reduce((s, f) => s + f.data.length, 0);
  if (unpacked > 128 * 1024 * 1024) throw new Error('解压后超过宿主 128 MiB 上限');
  for (const f of files) {
    if (f.name.startsWith('/') || f.name.includes('..')) throw new Error('非法路径：' + f.name);
    if (manifest.files[f.name] !== sha256(f.data)) throw new Error('sha256 对不上：' + f.name);
  }

  console.log('─'.repeat(58));
  console.log(`包：${path.basename(out)}  ${(zip.length / 1048576).toFixed(2)} MB`);
  console.log(`  id/version  ${manifest.id} / ${manifest.version}   hostVersion=${manifest.hostVersion} apiVersion=${manifest.apiVersion}`);
  console.log(`  条目 ${entryCount}（files ${fileCount} + manifest.json）  解压 ${(unpacked / 1048576).toFixed(2)} MB`);
  for (const f of files) console.log(`  ${f.name.padEnd(20)} ${String(f.data.length).padStart(9)} B  ${manifest.files[f.name].slice(0, 16)}`);
  console.log(`  组件 ${(manifest.views || []).map((v) => v.component).join(', ')} 已在 renderer.js`);
  console.log(`  manifest 声明式校验 ✓ main/renderer/style · action.inputSchema(${(manifest.actions || []).length}) · surfaces · assets 路径`);
  console.log(`  后端 activate ✓  handler ${(manifest.actions || []).map((a) => a.handler).join(', ')} 全部对上`);

  // ⑧ P3-3：把"这一版到底是什么"落到 `dist/build-info.json`（字节 + sha256 + 时间 + 输入清单）。
  //    教训（审核员 §5-B-2）：审核期间产物被重打一次（V1 17:09 → V2 17:29），报告里的哈希差点整份作废。
  //    有了这份侧车，任何人拿到包就能"对版"，不用靠 mtime 猜。
  const info = {
    id: manifest.id,
    version: manifest.version,
    hostVersion: manifest.hostVersion,
    apiVersion: manifest.apiVersion,
    builtAt: new Date().toISOString(),
    package: path.basename(out),
    packageBytes: zip.length,
    packageSha256: sha256(zip),
    unpackedBytes: unpacked,
    entryCount,
    files: Object.fromEntries(files.map((f) => [f.name, { bytes: f.data.length, sha256: manifest.files[f.name] }])),
  };
  fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`  build-info.json ✓  ${info.package} ${info.packageBytes} B  sha256=${info.packageSha256.slice(0, 16)}  @ ${info.builtAt}`);
  return out;
}

module.exports = { packFeature, zipWrite, sha256 };
