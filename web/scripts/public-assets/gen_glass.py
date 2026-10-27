"""生成公开版的玻璃控件图层（web/src/assets/ios27、web/src/assets/figma-glass）。

  python gen_glass.py [--out-ios27 <目录>] [--out-fg <目录>]

这些 PNG 是「与底色无关」的玻璃外观层：组件用 border-image 九宫格 / background 铺在控件后面。
文件名、画布尺寸、形状在画布里的位置与界面 CSS 的切片数值一一对应（改尺寸要同时改 CSS），外观是这里自己画的：
半透明填色 + 上亮下暗的细边 + 顶部一抹柔光 + （深色版）下方软投影。全部按 3 倍图画，先 2 倍超采样再缩回。
维护者的私有 overlay 可按同名文件换掉整套（overlay 清单 varDirs / ovUrl，见 src/runtime/overlay-web.mjs）。
"""
import argparse
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SS = 2   # 超采样


def rrect_mask(W, H, box, r):
    m = Image.new('L', (W * SS, H * SS), 0)
    x0, y0, x1, y1 = [v * SS for v in box]
    ImageDraw.Draw(m).rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=r * SS, fill=255)
    return m


def to_arr(img):
    return np.asarray(img, dtype=np.float64) / 255.0


def compose(layers, W, H):
    """layers: [(rgb(3,), alpha(H,W))] 自下而上 over 合成 → RGBA Image（缩回 1x）。"""
    acc_rgb = np.zeros((H * SS, W * SS, 3))
    acc_a = np.zeros((H * SS, W * SS))
    for rgb, a in layers:
        rgb = np.broadcast_to(np.asarray(rgb, dtype=np.float64), acc_rgb.shape) if np.ndim(rgb) == 1 else rgb
        out_a = a + acc_a * (1 - a)
        with np.errstate(invalid='ignore', divide='ignore'):
            out_rgb = (rgb * a[..., None] + acc_rgb * acc_a[..., None] * (1 - a[..., None])) / np.where(out_a > 0, out_a, 1)[..., None]
        acc_rgb, acc_a = out_rgb, out_a
    rgba = np.dstack([np.clip(acc_rgb, 0, 1), np.clip(acc_a, 0, 1)])
    im = Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), 'RGBA')
    return im.resize((W, H), Image.LANCZOS)


def glass_layers(W, H, box, r, *, fill, fill_a, rim_top, rim_bot, rim_w=3.0, sheen=0.10, shadow=None, tint=None, edge=0.0):
    """一块玻璃：填色、顶部柔光、细边、投影。数值都是 3 倍图像素。"""
    mask = rrect_mask(W, H, box, r)
    m = to_arr(mask)
    layers = []
    if shadow:
        dy, blur, a = shadow
        sh = Image.new('L', mask.size, 0)
        sh.paste(mask, (0, int(dy * SS)))
        sh = sh.filter(ImageFilter.GaussianBlur(blur * SS))
        layers.append(((0, 0, 0), to_arr(sh) * a * (1 - m)))   # 只在形状外面，不透过半透明的玻璃体
    layers.append((np.asarray(tint or fill, dtype=np.float64) / 255.0, m * fill_a))
    # 顶部柔光：形状上半部从上往下渐隐
    y0, y1 = box[1] * SS, box[3] * SS
    ys = np.arange(H * SS)[:, None]
    g = np.clip(1 - (ys - y0) / max(1, (y1 - y0) * 0.55), 0, 1) ** 1.6
    layers.append(((1, 1, 1), m * g * sheen))
    # 细边：形状减去内缩 rim_w 的形状；上沿亮、下沿暗
    inner = mask.filter(ImageFilter.MinFilter(int(rim_w * SS) * 2 + 1))
    ring = np.clip(m - to_arr(inner), 0, 1)
    t = np.clip((ys - y0) / max(1, (y1 - y0)), 0, 1)
    ring_a = ring * (rim_top + (rim_bot - rim_top) * t)
    layers.append(((1, 1, 1), ring_a))
    if edge:   # 外沿一圈细暗线（深色底上勾出轮廓）
        thin = mask.filter(ImageFilter.MinFilter(int(1.5 * SS) * 2 + 1))
        layers.append(((0, 0, 0), np.clip(m - to_arr(thin), 0, 1) * edge))
    return layers


LIGHT = dict(fill=(242, 242, 242), fill_a=0.55, rim_top=0.8, rim_bot=0.3, sheen=0.16)
DARK = dict(fill=(150, 150, 150), fill_a=0.17, rim_top=0.42, rim_bot=0.12, sheen=0.08, shadow=(10, 12, 0.16), edge=0.55)
BAR = dict(fill=(200, 200, 200), fill_a=0.05, rim_top=0.55, rim_bot=0.18, sheen=0.05)


def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, optimize=True)


def pill(W, H, box, style, **kw):
    r = min(box[2] - box[0], box[3] - box[1]) / 2
    return compose(glass_layers(W, H, box, r, **{**style, **kw}), W, H)


def card(W, H, box, r, style, **kw):
    return compose(glass_layers(W, H, box, r, **{**style, **kw}), W, H)


def prominent(W, H, box, rgb):
    r = min(box[2] - box[0], box[3] - box[1]) / 2
    layers = glass_layers(W, H, box, r, fill=rgb, fill_a=1.0, rim_top=0.45, rim_bot=0.0, sheen=0.14)
    return compose(layers, W, H)


def toggle_pressed(dark, on):
    W, H = 291, 192
    green = (52, 199, 89)
    off = (120, 120, 128)
    layers = []
    if on:
        tr = rrect_mask(W, H, (36, 45, 232, 147), 51)
        layers.append((np.asarray(green) / 255.0, to_arr(tr)))
        knob = (92, 36, 262, 153)
    else:
        tr = rrect_mask(W, H, (62, 45, 255, 147), 51)
        layers.append((np.asarray(off) / 255.0, to_arr(tr) * (0.42 if dark else 0.30)))
        knob = (28, 36, 198, 153)
    style = DARK if dark else LIGHT
    kl = glass_layers(W, H, knob, (knob[3] - knob[1]) / 2, **{**style, 'fill_a': 0.22 if on else style['fill_a'],
                                                              'shadow': (14, 12, 0.22)})
    return compose(layers + kl, W, H)


def slider_pressed(dark):
    W, H = 240, 180
    blue = (10, 132, 255)
    bar = rrect_mask(W, H, (0, 79, 126, 101), 11)
    layers = [(np.asarray(blue) / 255.0, to_arr(bar))]
    style = DARK if dark else LIGHT
    layers += glass_layers(W, H, (84, 33, 212, 141), 54, **{**style, 'fill_a': 0.2, 'shadow': (14, 12, 0.2)})
    return compose(layers, W, H)


def squircle_svg(n=4.0, R=42, size=200, steps=18):
    """自绘的连续曲率圆角（超椭圆角，n=4），200×200，四角各占 R。"""
    pts = []
    def corner(cx, cy, a0):
        for i in range(steps + 1):
            t = a0 + (math.pi / 2) * i / steps
            c, s = math.cos(t), math.sin(t)
            x = cx + R * math.copysign(abs(c) ** (2 / n), c)
            y = cy + R * math.copysign(abs(s) ** (2 / n), s)
            pts.append((x, y))
    corner(R, R, math.pi)              # 左上
    corner(size - R, R, 1.5 * math.pi)  # 右上
    corner(size - R, size - R, 0)       # 右下
    corner(R, size - R, 0.5 * math.pi)  # 左下
    d = 'M' + 'L'.join('%.2f %.2f' % p for p in pts) + 'Z'
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d"><path d="%s"/></svg>'
            % (size, size, size, size, d))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-ios27', default=os.path.join(HERE, '..', '..', 'src', 'assets', 'ios27'))
    ap.add_argument('--out-fg', default=os.path.join(HERE, '..', '..', 'src', 'assets', 'figma-glass'))
    a = ap.parse_args()
    I, F = a.out_ios27, a.out_fg

    # —— figma-glass：顶栏 / Dock 工具条 / 文件面板（3 倍图，形状四周留 24px 余量）——
    for n in (32, 36, 40, 44):
        S = (n + 48) * 3
        box = (70, 70, S - 70, S - 70)
        save(pill(S, S, box, LIGHT), os.path.join(F, 'tb-orb%d-light.png' % n))
        save(pill(S, S, box, DARK), os.path.join(F, 'tb-orb%d-dark.png' % n))
    for n in (32, 36, 40):
        H = (n + 48) * 3
        box = (72, 72, 360, H - 72)
        save(pill(432, H, box, BAR), os.path.join(F, 'tb-bar%d-light.png' % n))
        save(pill(432, H, box, BAR, rim_top=0.4), os.path.join(F, 'tb-bar%d-dark.png' % n))
    H = (44 + 48) * 3
    save(pill(432, H, (70, 70, 362, H - 70), LIGHT), os.path.join(F, 'tb-cap44-light.png'))
    save(pill(432, H, (70, 70, 362, H - 70), DARK), os.path.join(F, 'tb-cap44-dark.png'))
    save(pill(288, 288, (70, 70, 218, 218), LIGHT), os.path.join(F, 'fp-orb48-light.png'))
    save(pill(288, 288, (70, 70, 218, 218), DARK), os.path.join(F, 'fp-orb48-dark.png'))
    save(pill(432, 288, (70, 70, 362, 218), LIGHT), os.path.join(F, 'fp-cap48-light.png'))
    save(pill(432, 288, (70, 70, 362, 218), DARK), os.path.join(F, 'fp-cap48-dark.png'))

    # —— ios27：设置页 / 文件面板的控件（3 倍图，形状四周留 40px 余量）——
    save(pill(372, 372, (118, 118, 254, 254), LIGHT), os.path.join(I, 'nav44-light.png'))
    save(pill(372, 372, (118, 118, 254, 254), DARK), os.path.join(I, 'nav44-dark.png'))
    save(pill(426, 426, (118, 118, 308, 308), LIGHT), os.path.join(I, 'nav62-light.png'))
    save(pill(426, 426, (118, 118, 308, 308), DARK), os.path.join(I, 'nav62-dark.png'))
    save(pill(600, 372, (118, 118, 482, 254), LIGHT), os.path.join(I, 'cap44-light.png'))
    save(pill(600, 372, (118, 118, 482, 254), DARK), os.path.join(I, 'cap44-dark.png'))
    save(pill(840, 426, (118, 118, 722, 308), LIGHT), os.path.join(I, 'tab62-light.png'))
    save(pill(840, 426, (118, 118, 722, 308), DARK), os.path.join(I, 'tab62-dark.png'))
    stage = dict(LIGHT, fill=(238, 238, 238), fill_a=0.58)
    save(pill(372, 372, (118, 118, 254, 254), stage), os.path.join(I, 'stage44-light.png'))
    save(pill(600, 372, (118, 118, 482, 254), stage), os.path.join(I, 'stagecap44-light.png'))
    save(prominent(372, 372, (118, 118, 254, 254), (0, 132, 250)), os.path.join(I, 'prom44-light.png'))
    save(prominent(372, 372, (118, 118, 254, 254), (0, 128, 240)), os.path.join(I, 'prom44-dark.png'))
    save(prominent(600, 372, (118, 118, 482, 254), (0, 126, 245)), os.path.join(I, 'stageprom44.png'))
    panel_l = dict(LIGHT, fill=(247, 247, 247), fill_a=0.73, sheen=0.10)
    panel_d = dict(DARK, fill=(28, 28, 30), fill_a=0.975, rim_top=0.22, rim_bot=0.06, sheen=0.03, shadow=None)
    save(card(457, 457, (46, 46, 411, 411), 102, panel_l), os.path.join(I, 'alert-light.png'))
    save(card(457, 457, (46, 46, 411, 411), 102, panel_d), os.path.join(I, 'alert-dark.png'))
    save(card(457, 457, (46, 46, 411, 411), 102, dict(panel_l, fill=(245, 245, 245))), os.path.join(I, 'stagepanel-light.png'))
    save(card(481, 481, (46, 46, 435, 435), 114, panel_l), os.path.join(I, 'sheet-light.png'))
    save(card(481, 481, (46, 46, 435, 435), 114, panel_d), os.path.join(I, 'sheet-dark.png'))
    for dark in (False, True):
        sfx = 'dark' if dark else 'light'
        save(toggle_pressed(dark, True), os.path.join(I, 'toggle-on-pressed-%s.png' % sfx))
        save(toggle_pressed(dark, False), os.path.join(I, 'toggle-off-pressed-%s.png' % sfx))
        save(slider_pressed(dark), os.path.join(I, 'slider-pressed-%s.png' % sfx))
    open(os.path.join(I, 'squircle26.svg'), 'w', encoding='utf-8', newline='\n').write(squircle_svg())
    for d in (I, F):
        for f in sorted(os.listdir(d)):
            print('%-40s %7d' % (os.path.join(os.path.basename(d), f), os.path.getsize(os.path.join(d, f))))


if __name__ == '__main__':
    main()
