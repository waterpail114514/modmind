// launch.mjs — 最小 Forge 启动器（离线建造工具 P1 阶段的基础设施）
//
// 职责：只读版本 json，组装命令行，注入采集器与请求文件，启动客户端。
// 设计约束：不改动用户原实例；所有可写内容都落在 --game-dir 指向的隔离目录。
//
// 用法：
//   node launch.mjs --mc-root <E:\mc\.minecraft> --version-json <...json> \
//                   --game-dir <隔离目录> --java <javaw.exe路径> \
//                   [--inject <采集器jar>] [--capture] [--dry-run] [--username <名>]
//
// 规则实现说明：Mojang 的 rules 采用「按顺序求值、最后一个匹配者生效」。无 rules 即允许。
// 当前只支持 os.name / os.arch / os.version 与 features 全部为假（不启用 any feature）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const need = (k) => { if (!args[k]) { console.error(`缺少参数 --${k}`); process.exit(2); } return args[k]; };

const mcRoot = path.resolve(need('mc-root'));
const versionJsonPath = path.resolve(need('version-json'));
const gameDir = path.resolve(need('game-dir'));
const javaExe = args.java ? path.resolve(args.java) : null;
const nativesDir = path.join(gameDir, '.natives');
const dryRun = Boolean(args['dry-run']);
const prepareOnly = Boolean(args['prepare-only']);

// ---------- 规则求值 ----------
function ruleMatches(rule) {
  const os_ = rule.os;
  if (os_) {
    if (os_.name && os_.name !== 'windows') return false;
    if (os_.arch) {
      const want = os_.arch === 'x86' ? 'x86' : 'x86_64';
      if (process.arch !== (os_.arch === 'x86' ? 'ia32' : 'x64')) return false;
      if (want === 'x86' && process.arch !== 'ia32') return false;
    }
    if (os_.version) return false; // 未实现版本正则匹配，保守视为不匹配
  }
  if (rule.features) return false; // 本启动器不启用任何 feature
  return true;
}
function allowed(rules) {
  if (!rules || rules.length === 0) return true;
  let verdict = false;
  for (const r of rules) {
    if (ruleMatches(r)) verdict = r.action === 'allow';
  }
  return verdict;
}

// ---------- 组装 ----------
const vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
const librariesDir = path.join(mcRoot, 'libraries');
const assetsDir = path.join(mcRoot, 'assets');
const sep = process.platform === 'win32' ? ';' : ':';

const classpathEntries = [];
const nativesToExtract = [];

// 本机架构决定要哪一个 natives 分类器
const NATIVE_CLASSIFIER = { x64: 'natives-windows', arm64: 'natives-windows-arm64', ia32: 'natives-windows-x86' }[process.arch];

for (const lib of vj.libraries ?? []) {
  if (!allowed(lib.rules)) continue;
  const art = lib.downloads?.artifact;
  const parts = String(lib.name ?? '').split(':'); // group:artifact:version[:classifier]
  const classifier = parts.length >= 4 ? parts.slice(3).join(':') : null;

  // 形态一：分类器作为独立条目。本机版本 json 即此形态，且 windows 下同时列出
  // natives-windows / natives-windows-arm64 / natives-windows-x86，必须按架构只取一个。
  if (classifier && classifier.startsWith('natives-')) {
    if (classifier !== NATIVE_CLASSIFIER) continue;
    if (art?.path) nativesToExtract.push({ rel: art.path, exclude: lib.extract?.exclude ?? [] });
    continue;
  }

  // 形态二：natives 字段加 downloads.classifiers
  const nativeKey = lib.natives?.['windows'];
  if (nativeKey) {
    if (nativeKey !== NATIVE_CLASSIFIER) continue;
    const cls = lib.downloads?.classifiers?.[nativeKey];
    if (cls?.path) nativesToExtract.push({ rel: cls.path, exclude: lib.extract?.exclude ?? [] });
    continue;
  }

  if (art?.path) classpathEntries.push(path.join(librariesDir, art.path));
}

const versionName = vj.id;
const classpath = classpathEntries.join(sep);

const placeholders = {
  natives_directory: nativesDir,
  launcher_name: 'modmind-offline-tool',
  launcher_version: '0.1.0',
  classpath,
  library_directory: librariesDir,
  classpath_separator: sep,
  version_name: versionName,
  game_directory: gameDir,
  assets_root: assetsDir,
  assets_index_name: vj.assetIndex?.id ?? '',
  auth_player_name: args.username ?? 'ModMindProbe',
  auth_uuid: '00000000000000000000000000000000',
  auth_access_token: '0',
  auth_xuid: '0',
  clientid: '0',
  user_type: 'legacy',
  version_type: vj.type ?? 'release',
  resolution_width: '1280',
  resolution_height: '720',
  user_properties: '{}',
  quickPlayPath: '',
  quickPlaySingleplayer: '',
  quickPlayMultiplayer: '',
  quickPlayRealms: '',
};

function subst(s) {
  return String(s).replace(/\$\{([^}]+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(placeholders, k) ? placeholders[k] : m);
}
function collect(list, acc) {
  for (const item of list ?? []) {
    if (typeof item === 'string') acc.push(subst(item));
    else if (item && typeof item === 'object') {
      if (!allowed(item.rules)) continue;
      const v = item.value;
      if (Array.isArray(v)) v.forEach((x) => acc.push(subst(x)));
      else acc.push(subst(v));
    }
  }
}

const jvmArgs = [];
collect(vj.arguments?.jvm, jvmArgs);
const gameArgs = [];
collect(vj.arguments?.game, gameArgs);

const fullArgs = [...jvmArgs, vj.mainClass, ...gameArgs];

// 未替换的占位符检查：留着会以字面量传给 JVM，属于静默错误，必须拦下
const unresolved = fullArgs.filter((a) => /\$\{[^}]+\}/.test(a));
if (unresolved.length) {
  console.error('存在未替换的占位符，拒绝启动：');
  unresolved.slice(0, 10).forEach((a) => console.error('  ' + a.slice(0, 160)));
  process.exit(3);
}

// ---------- 注入与请求文件 ----------
const actions = [];

if (!dryRun) {
  fs.mkdirSync(nativesDir, { recursive: true });

  for (const { rel, exclude } of nativesToExtract) {
    const src = path.join(librariesDir, rel);
    if (!fs.existsSync(src)) { actions.push(`跳过缺失的 natives：${rel}`); continue; }
    // 用 .NET 的 ZipFile 解包。不用 Expand-Archive，因为它对非 .zip 扩展名不可靠。
    const tmp = path.join(nativesDir, '_tmp_' + crypto.randomUUID());
    fs.mkdirSync(tmp, { recursive: true });
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${JSON.stringify(src)},${JSON.stringify(tmp)})`], { stdio: 'ignore' });
    if (r.status !== 0) { actions.push(`natives 解包失败：${rel}`); continue; }
    // natives 包内部是 windows/x64/org/lwjgl/xxx.dll 这样的深层结构，而 java.library.path
    // 不递归查找，所以必须把所有本地库文件摊平到 natives 根目录，并丢弃 META-INF 与校验文件。
    const BINARY = /\.(dll|so|dylib)$/i;
    const walk = (d, base = '') => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const relp = base ? base + '/' + e.name : e.name;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs, relp); continue; }
        if (!BINARY.test(e.name)) continue;
        if (exclude.some((x) => relp.startsWith(x))) continue;
        fs.copyFileSync(abs, path.join(nativesDir, e.name));
      }
    };
    walk(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  actions.push(`natives 抽取：${nativesToExtract.length} 个条目 -> ${nativesDir}`);

  if (args.inject) {
    const src = path.resolve(args.inject);
    const modsDir = path.join(gameDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const dst = path.join(modsDir, path.basename(src));
    fs.copyFileSync(src, dst);
    actions.push(`注入采集器：${dst}`);
  }

  if (args.capture) {
    const reqDir = path.join(gameDir, '.modmind', 'voxel-capture');
    fs.mkdirSync(reqDir, { recursive: true });
    // 指纹：对 mods 目录的文件名与大小求哈希，改动任何 jar 都会变
    const modsDir = path.join(gameDir, 'mods');
    const h = crypto.createHash('sha256');
    if (fs.existsSync(modsDir)) {
      for (const n of fs.readdirSync(modsDir).sort()) {
        const st = fs.statSync(path.join(modsDir, n));
        h.update(`${n}:${st.size}\n`);
      }
    }
    // 上限由 javap 反汇编 CaptureRequest 得到，签名是 bounded(对象, 名称, 默认, 最小, 最大)。
    // 硬限制两条：maxStatesPerBlock 最大 16（无法采全声明状态），maxTotalQuads 最大 262144
    // （等于默认值，提不上去）。请求里没有偏移量或方块过滤字段，因此无法靠多次请求绕过。
    // 下面这一组是把每个字段都拉到其允许的最大值（timeoutMs 用 15 分钟）。
    const request = {
      schemaVersion: 1,
      requestId: crypto.randomUUID().replaceAll('-', ''),
      instanceFingerprint: 'sha256-' + h.digest('hex'),
      minecraftVersion: '1.20.1',
      maxBlocks: 100000,
      maxStatesPerBlock: 16,
      maxQuadsPerState: 2048,
      maxTotalQuads: 262144,
      maxTextures: 16384,
      maxTextureBytes: 268435456,
      timeoutMs: 900000,
    };
    const reqPath = path.join(reqDir, 'request.json');
    const reqText = JSON.stringify(request, null, 2);
    fs.writeFileSync(reqPath, reqText, 'utf8');
    actions.push(`写入请求：${reqPath}（${Buffer.byteLength(reqText)} 字节）`);
  }
}

// ---------- 报告 ----------
console.log('=== 启动器装配结果 ===');
console.log(`版本 json      : ${versionJsonPath}`);
console.log(`版本 id        : ${versionName}`);
console.log(`主类           : ${vj.mainClass}`);
console.log(`游戏目录       : ${gameDir}`);
console.log(`natives 目录   : ${nativesDir}`);
console.log(`classpath 条目 : ${classpathEntries.length}`);
console.log(`classpath 长度 : ${classpath.length} 字符`);
console.log(`natives 条目   : ${nativesToExtract.length}`);
console.log(`jvm 参数       : ${jvmArgs.length}`);
console.log(`游戏参数       : ${gameArgs.length}`);
console.log(`java           : ${javaExe ?? '(未指定)'}`);
if (actions.length) { console.log('--- 已执行 ---'); actions.forEach((a) => console.log('  ' + a)); }

if (dryRun) {
  console.log('--- 命令行预览（前 12 项）---');
  fullArgs.slice(0, 12).forEach((a) => console.log('  ' + (a.length > 150 ? a.slice(0, 150) + ' …' : a)));
  console.log(`--- 共 ${fullArgs.length} 项，未替换占位符 0 个 ---`);
  console.log('dry-run：未启动游戏');
  process.exit(0);
}
if (prepareOnly) {
  console.log('只做准备，未启动游戏');
  process.exit(0);
}

if (!javaExe) { console.error('缺少 --java，无法启动'); process.exit(2); }
if (!fs.existsSync(javaExe)) { console.error(`java 不存在：${javaExe}`); process.exit(2); }

console.log('=== 启动 ===');
const child = spawnSync(javaExe, fullArgs, { cwd: gameDir, stdio: 'inherit' });
console.log(`退出码：${child.status}`);
process.exit(child.status ?? 1);
