#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build-assets2.py — 用户实例 → Deepslate 三件套（2D 装箱版）
过滤 block/+entity/，内容去重，rectpack 装箱（自适应尺寸）
"""
import zipfile, json, os, io, time, hashlib
from collections import Counter
from PIL import Image
from rectpack import newPacker, MaxRectsBssf, SORT_AREA

MC  = "E:/mc/.minecraft"
VER = os.path.join(MC, "versions/GregTech Leisure")
OUT = "E:/mc/.work/dl-demo/out"
os.makedirs(OUT, exist_ok=True)

t0 = time.time()

def list_sources():
    srcs = [("client-jar", os.path.join(VER, "GregTech Leisure.jar"), 0)]
    for root, _, files in os.walk(os.path.join(MC, "libraries")):
        for f in files:
            if f.endswith(".jar"): srcs.append(("libraries", os.path.join(root, f), 1))
    for f in sorted(os.listdir(os.path.join(VER, "mods"))):
        if f.endswith(".jar"): srcs.append(("mods", os.path.join(VER, "mods", f), 2))
    return srcs

blockstates, models, tex_bytes = {}, {}, {}
for kind, path, prio in sorted(list_sources(), key=lambda s: s[2]):
    try: z = zipfile.ZipFile(path)
    except Exception: continue
    for name in z.namelist():
        if not name.startswith("assets/") or name.endswith("/"): continue
        parts = name.split("/")
        if len(parts) < 4: continue
        ns, cat = parts[1], parts[2]
        if cat == "blockstates" and name.endswith(".json"):
            blockstates[f"{ns}:{parts[3][:-5]}"] = z.read(name)
        elif cat == "models" and name.endswith(".json"):
            models[f"{ns}:" + "/".join(parts[3:])[:-5]] = z.read(name)
        elif cat == "textures" and name.endswith(".png"):
            rel = "/".join(parts[3:])[:-4]
            if rel.startswith(("block/", "entity/")):
                tex_bytes[f"{ns}:{rel}"] = z.read(name)

# 引用过滤：block/ 只留被 models 引用的；entity/ 全留
import re as _re
_pat = _re.compile(r'"([a-z0-9_.\-]+:[a-z0-9_./\-]+)"')
refs = set()
for b in models.values():
    refs.update(_pat.findall(b.decode("utf-8", errors="ignore")))
block_tex = {k: v for k, v in tex_bytes.items() if k.split(":",1)[1].startswith("block/")}
entity_tex = {k: v for k, v in tex_bytes.items() if k.split(":",1)[1].startswith("entity/")}
keep = {k: block_tex[k] for k in block_tex if k in refs}
keep.update(entity_tex)
print(f"[1] block {len(block_tex)}→引用 {len(keep)-len(entity_tex)} / entity {len(entity_tex)} 全留")

# 内容去重（保留每个内容的第一名）
seen = {}
for k, b in sorted(keep.items()):
    h = hashlib.md5(b).hexdigest()
    if h not in seen: seen[h] = (k, b)
print(f"[1b] 去重后 {len(seen)} 张   ({time.time()-t0:.1f}s)")

imgs = {}
for h, (k, b) in seen.items():
    try: imgs[k] = Image.open(io.BytesIO(b)).convert("RGBA")
    except Exception: pass
print(f"[2] 解码 {len(imgs)} 张")

# ---------- rectpack 装箱（自适应） ----------
def try_pack(W, H):
    packer = newPacker(rotation=False, pack_algo=MaxRectsBssf, sort_algo=SORT_AREA)
    for i, (k, im) in enumerate(imgs.items()):
        packer.add_rect(im.size[0], im.size[1], i)
    packer.add_bin(W, H)
    packer.pack()
    rects = packer.rect_list()
    if len(rects) == len(imgs):
        return rects, W, H
    return None, W, H

keys = list(imgs.keys())
plan = None
for (W, H) in [(4096, 8192), (8192, 8192), (8192, 12288), (8192, 16384), (16384, 16384)]:
    rects, w, h = try_pack(W, H)
    print(f"[3] 试 {W}x{H}: {'成功 '+str(len(rects)) if rects else '失败'}")
    if rects:
        plan = (rects, W, H); break
    if time.time() - t0 > 500: break

assert plan, "装箱失败"
rects, AW, AH = plan
print(f"[3] 装箱成功: {AW}x{AH}")

# ---------- 合成图集 ----------
atlas = Image.new("RGBA", (AW, AH), (0, 0, 0, 0))
uv = {}
for (b, x, y, w, h, rid) in rects:
    k = keys[rid]
    top = AH - y - h   # rectpack y 从底部；PIL 从顶部
    atlas.paste(imgs[k], (x, top))
    uv[k] = [x, top, w, h]

atlas.save(os.path.join(OUT, "atlas.png"), optimize=True)
print(f"[4] atlas.png: {AW}x{AH}  {os.path.getsize(os.path.join(OUT,'atlas.png'))/1048576:.1f} MB  ({time.time()-t0:.1f}s)")

# ---------- 三件套 ----------
bs_obj = {k: json.loads(b) for k, b in blockstates.items() if b}
mo_obj = {k: json.loads(b) for k, b in models.items() if b}
payload = json.dumps({"blockstates": bs_obj, "models": mo_obj, "textures": uv}, separators=(",", ":"), ensure_ascii=False)
with open(os.path.join(OUT, "assets.js"), "w", encoding="utf-8") as f:
    f.write("window.__ASSETS__="); f.write(payload); f.write(";")
with open(os.path.join(OUT, "opaque.js"), "w", encoding="utf-8") as f:
    f.write('window.__OPAQUE__={opaque:[],nonSelfCulling:[],transparent:[]};\n')
print(f"[5] assets.js: {os.path.getsize(os.path.join(OUT,'assets.js'))/1048576:.1f} MB  (bs {len(bs_obj)} / models {len(mo_obj)} / uv {len(uv)})")
print(f"[6] 完成 {time.time()-t0:.1f}s")
