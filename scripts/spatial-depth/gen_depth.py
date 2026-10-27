"""
Depth map generator for the "空间壁纸" (spatial wallpaper) feature.
Wraps Depth Anything V2 infer_image and emits a normalized, parallax-friendly
grayscale depth PNG (white = near, black = far).

Usage:
    python gen_depth.py <in_image> <out_depth_png> [--encoder vits|vitb|vitl]
                        [--max-side 1600] [--blur 2.0]

This same routine will become the core of the bridge backend depth endpoint,
so keep it dependency-light (only what the V2 venv already has: torch, cv2,
numpy) and side-effect free.
"""
import argparse
import os
import sys

import cv2
import numpy as np
import torch

# --- locate the Depth Anything V2 repo + checkpoints -------------------------
V2_REPO = r"C:\Users\you\Desktop\Depth-Anything-V2"
CKPT_DIR = os.path.join(V2_REPO, "checkpoints")
sys.path.insert(0, V2_REPO)

from depth_anything_v2.dpt import DepthAnythingV2  # noqa: E402

MODEL_CONFIGS = {
    "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
    "vitb": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
    "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
}


def load_model(encoder: str, device: str):
    model = DepthAnythingV2(**MODEL_CONFIGS[encoder])
    ckpt = os.path.join(CKPT_DIR, f"depth_anything_v2_{encoder}.pth")
    model.load_state_dict(torch.load(ckpt, map_location="cpu"))
    return model.to(device).eval()


def generate(img_bgr, model, input_size=518, blur=2.0, max_side=1600):
    """Return an 8-bit grayscale depth map (uint8, white=near) at (possibly
    downscaled) resolution, plus the resolution used."""
    h0, w0 = img_bgr.shape[:2]

    # Downscale huge images so the depth PNG stays light for the browser.
    scale = min(1.0, max_side / max(h0, w0))
    if scale < 1.0:
        img_proc = cv2.resize(img_bgr, (round(w0 * scale), round(h0 * scale)),
                              interpolation=cv2.INTER_AREA)
    else:
        img_proc = img_bgr

    with torch.no_grad():
        depth = model.infer_image(img_proc, input_size)  # float32 HxW, near=large

    # Normalize to 0..1 (white = near).
    d = depth.astype(np.float32)
    d = (d - d.min()) / (d.max() - d.min() + 1e-8)

    # Soften depth so parallax has no hard tearing at edges. A mild Gaussian is
    # enough; keep it proportional so it behaves the same across resolutions.
    if blur > 0:
        k = max(1, int(round(blur)) * 2 + 1)  # odd kernel
        d = cv2.GaussianBlur(d, (k, k), blur)

    depth_u8 = np.clip(d * 255.0, 0, 255).astype(np.uint8)
    return depth_u8, img_proc.shape[1], img_proc.shape[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("in_image")
    ap.add_argument("out_depth")
    ap.add_argument("--encoder", default="vitl", choices=["vits", "vitb", "vitl"])
    ap.add_argument("--max-side", type=int, default=1600)
    ap.add_argument("--blur", type=float, default=2.0)
    ap.add_argument("--also-resize-image", default="",
                    help="optional path to also write the downscaled source image")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    # cv2.imread/imwrite 在 Windows 用窄字节 API，读写不了非 ASCII 路径（如工作空间的「壁纸」文件夹）。
    # 一律走 numpy 的 Unicode 安全文件 IO（np.fromfile + imdecode / imencode + tofile）。
    img = cv2.imdecode(np.fromfile(args.in_image, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        print(f"ERROR: cannot read {args.in_image}", file=sys.stderr)
        sys.exit(1)

    model = load_model(args.encoder, device)
    depth_u8, w, h = generate(img, model, blur=args.blur, max_side=args.max_side)

    cv2.imencode('.png', depth_u8)[1].tofile(args.out_depth)
    if args.also_resize_image:
        scale = min(1.0, args.max_side / max(img.shape[:2]))
        out_img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA) if scale < 1.0 else img
        ext = os.path.splitext(args.also_resize_image)[1] or '.jpg'
        cv2.imencode(ext, out_img)[1].tofile(args.also_resize_image)

    print(f"OK  device={device} encoder={args.encoder}  depth={w}x{h} -> {args.out_depth}")


if __name__ == "__main__":
    main()
