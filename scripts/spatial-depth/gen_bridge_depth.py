"""Regenerate depth maps for the built-in static wallpapers (空间壁纸 feature).

Writes into web/public/assets/wallpapers/depth/<id>.png — the DEV/source public
dir (Vite `npm run build` copies it into public/app, and the apk bundles it).
Do NOT write into public/app directly: that dir is the build output and is wiped
on every build (emptyOutDir).

Depends on the Depth Anything V2 install on this machine (see gen_depth.py for the
hardcoded repo/checkpoint paths). Run with that repo's venv python, e.g.:
    <DepthAnything venv>\\python.exe scripts\\spatial-depth\\gen_bridge_depth.py

Add a new wallpaper: drop its source into web/public/..., add an entry to SRC
below AND to SPATIAL_IDS in web/src/lib/wallpaper.svelte.js, then rerun this.
"""
import os, sys, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_depth import load_model, generate

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PUB = os.path.join(REPO, "web", "public")            # dev/source public dir
WP = os.path.join(PUB, "assets", "wallpapers")
OUT = os.path.join(WP, "depth")
os.makedirs(OUT, exist_ok=True)

# id -> source image (matches WPLIB in web/src/lib/wallpaper.svelte.js; flux = dynamic, excluded).
# 内置壁纸现为「层峦 + 流光」：层峦是程序化生成的，深度图由 gen-ridges.mjs 按图层精确写出，不走模型估计，
# 所以这里是空的。以后加照片类内置壁纸时在这里和 SPATIAL_IDS 一并补。
SRC = {
}

import torch
device = "cuda" if torch.cuda.is_available() else "cpu"
model = load_model("vitl", device)
print(f"model loaded on {device}")

for wid, path in SRC.items():
    img = cv2.imread(path)
    if img is None:
        print(f"  SKIP {wid}: cannot read {path}"); continue
    depth, w, h = generate(img, model, blur=2.0, max_side=1280)
    out = os.path.join(OUT, f"{wid}.png")
    cv2.imwrite(out, depth)
    print(f"  {wid:10s} {w}x{h} -> {out}")
print("done")
