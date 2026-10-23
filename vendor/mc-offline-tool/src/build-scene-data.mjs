// build-scene-data.mjs —— 把 3D 预览要用的几何/贴图数据搬到 scene-data/
//
// 数据来源是既有的采集产物（D005 那一次 voxel-capture），不重新采集：
//   .work/viewer/shard-<ns>.json   每方块每状态的 quad 几何（build-viewer.mjs 导出）
//   .work/viewer/textures.json     sprite 名 -> { p, w, h, a, sat }
//   .work/probe-01/.modmind/voxel-capture/textures/*.png   逐 sprite 的贴图本体
//
// 这些都在 .work 下（中间产物目录），浏览器取不到，所以拷一份到 scene-data/。
// 目录名不带 app3d：这份数据同时给本地程序（viewer-native）与网页参考版用。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'e:/AI工作台/mc-offline-tool';
const VIEWER = path.join(ROOT, '.work/viewer');
const TEXSRC = path.join(ROOT, '.work/probe-01/.modmind/voxel-capture/textures');
const OUT = path.join(ROOT, 'scene-data');

fs.mkdirSync(path.join(OUT, 'textures'), { recursive: true });

let shardBytes = 0, shardCount = 0, blockCount = 0;
for (const f of fs.readdirSync(VIEWER)) {
  if (!/^shard-.*\.json$/.test(f)) continue;
  const src = path.join(VIEWER, f);
  const dst = path.join(OUT, f);
  fs.copyFileSync(src, dst);
  shardBytes += fs.statSync(src).size;
  shardCount++;
  const arr = JSON.parse(fs.readFileSync(src, 'utf8'));
  blockCount += arr.length;
}
fs.copyFileSync(path.join(VIEWER, 'textures.json'), path.join(OUT, 'textures.json'));
fs.copyFileSync(path.join(VIEWER, 'index.json'), path.join(OUT, 'index.json'));
fs.copyFileSync(path.join(VIEWER, 'tints.json'), path.join(OUT, 'tints.json'));

let texBytes = 0, texCount = 0;
for (const f of fs.readdirSync(TEXSRC)) {
  const src = path.join(TEXSRC, f);
  if (!fs.statSync(src).isFile()) continue;
  fs.copyFileSync(src, path.join(OUT, 'textures', f));
  texBytes += fs.statSync(src).size;
  texCount++;
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
console.log('shard  ' + shardCount + ' 个 / ' + blockCount + ' 方块 / ' + mb(shardBytes));
console.log('textures.json + index.json + tints.json');
console.log('贴图  ' + texCount + ' 张 / ' + mb(texBytes));
console.log('合计  ' + mb(shardBytes + texBytes));
