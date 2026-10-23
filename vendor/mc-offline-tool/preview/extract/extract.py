#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract.py — 从用户本地 Minecraft 实例提取「资源包三件套」（Deepslate 预处理格式）
源（优先级从低到高，后者覆盖前者）：
  A. 客户端 jar   assets/minecraft/{blockstates,models,textures}/**
  B. libraries/**   assets/<loader>/**（loader 自带资源，如 forge）
  C. mods/*.jar     assets/<mod>/{blockstates,models,textures}/**
输出（暂存内存 + 统计；实际写盘在 step2 脚本）：
  blockstates: {"ns:name": json}
  models:      {"ns:path": json}
  textures:    {"ns:path": png_bytes}
"""
import zipfile, json, os, sys, time
from collections import Counter

MC  = "E:/mc/.minecraft"
VER = os.path.join(MC, "versions/GregTech Leisure")
OUT = "E:/mc/.work/dl-demo/extracted"

t0 = time.time()

def list_sources():
    srcs = []
    jar = os.path.join(VER, "GregTech Leisure.jar")
    if os.path.exists(jar):
        srcs.append(("client-jar", jar, 0))
    # libraries（只收含 assets/ 的，先扫文件清单里的名字粗筛）
    libdir = os.path.join(MC, "libraries")
    if os.path.isdir(libdir):
        for root, _, files in os.walk(libdir):
            for f in files:
                if f.endswith(".jar"):
                    srcs.append(("libraries", os.path.join(root, f), 1))
    modsdir = os.path.join(VER, "mods")
    if os.path.isdir(modsdir):
        for f in sorted(os.listdir(modsdir)):
            if f.endswith(".jar"):
                srcs.append(("mods", os.path.join(modsdir, f), 2))
    return srcs

blockstates, models = {}, {}
textures = {}   # ns/path -> bytes（只存"方块相关"：block/ entity/ item/ 之外的先全收）
contrib = Counter()
tex_bytes_total = 0

srcs = list_sources()
print(f"源总数: {len(srcs)}  (client 1 + libraries {sum(1 for s in srcs if s[0]=='libraries')} + mods {sum(1 for s in srcs if s[0]=='mods')})")

for kind, path, prio in srcs:
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        print("  跳过(打不开):", path, e); continue
    n_bs = n_mo = n_tx = 0
    for name in z.namelist():
        if not name.startswith("assets/") or name.endswith("/"): continue
        parts = name.split("/")
        if len(parts) < 4: continue
        ns, cat = parts[1], parts[2]
        if cat == "blockstates" and name.endswith(".json"):
            key = f"{ns}:{parts[3][:-5]}"
            blockstates[key] = z.read(name)
            n_bs += 1
        elif cat == "models" and name.endswith(".json"):
            key = f"{ns}:" + "/".join(parts[3:])[:-5]
            models[key] = z.read(name)
            n_mo += 1
        elif cat == "textures" and name.endswith(".png"):
            key = f"{ns}:" + "/".join(parts[3:])[:-4]
            b = z.read(name)
            textures[key] = b
            tex_bytes_total += len(b)
            n_tx += 1
    if n_bs or n_mo or n_tx:
        contrib[kind] += 1
        if kind == "mods":
            pass

print(f"\n=== 汇总 ===")
print(f"blockstates: {len(blockstates)}")
print(f"models:      {len(models)}")
print(f"textures:    {len(textures)}  ({tex_bytes_total/1048576:.1f} MB)")
print(f"有贡献的源: {dict(contrib)}")

# 命名空间分布
nsbs = Counter(k.split(':')[0] for k in blockstates)
nsmo = Counter(k.split(':')[0] for k in models)
nstx = Counter(k.split(':')[0] for k in textures)
print(f"\nblockstates 命名空间 top15: {nsbs.most_common(15)}")
print(f"models 命名空间 top15: {nsmo.most_common(15)}")
print(f"textures 命名空间 top15: {nstx.most_common(15)}")

# 抽认一个 mod 方块的完整链路（例如 ad_astra 的木板）
for probe in ["ad_astra:aeronos_planks", "gtceu:bronze_block", "minecraft:oak_stairs"]:
    bs = blockstates.get(probe)
    print(f"\n--- {probe} ---")
    if bs:
        j = json.loads(bs)
        print("  blockstate:", json.dumps(j, ensure_ascii=False)[:220])
        # 看变体引用的 model
        def first_model(j):
            if "variants" in j:
                for v in j["variants"].values():
                    m = v[0] if isinstance(v, list) else v
                    return m.get("model")
            if "multipart" in j:
                ap = j["multipart"][0].get("apply")
                m = ap[0] if isinstance(ap, list) else ap
                return m.get("model")
            return None
        mname = first_model(j)
        print("  首个 model:", mname, " 在 models 里:", mname in models if mname else None)
        if mname and mname in models:
            mj = json.loads(models[mname])
            print("  model 内容:", json.dumps(mj, ensure_ascii=False)[:260])
    else:
        print("  blockstate 不存在")

print(f"\n耗时 {time.time()-t0:.1f}s")
