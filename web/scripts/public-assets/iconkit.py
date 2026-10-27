"""公开版图形素材的公共工具：把 Lucide（ISC）的描边图标变成填充轮廓。

Lucide 的图标是 24×24 的描边路径（stroke 2、圆头圆角）。字体字形与 sfSymbols 表要的是填充轮廓，
这里的做法：cairosvg 把 SVG 画成高分辨率灰度图 → contourpy 取 0.5 等值线（外轮廓 + 洞）→ Douglas-Peucker 化简。
画布 1200px 对应 24 单位（每单位 50px），化简容差 0.6px，图标尺寸（12–32px）下与矢量描边看不出差别。

依赖：fonttools、cairosvg、contourpy、numpy、Pillow（见同目录 README.md）。
"""
import io
import json
import math
import os
import re

import cairosvg
import contourpy
import numpy as np
from PIL import Image

# —— Lucide 数据 ——————————————————————————————————————————————————————————

def load_lucide(lucide_dir, name):
    """读 lucide 包 dist/esm/icons/<name>.js 里的节点数组 → [(tag, {attr: value})]。"""
    p = os.path.join(lucide_dir, 'dist', 'esm', 'icons', name + '.js')
    src = open(p, encoding='utf-8').read()
    m = re.search(r'const \w+ = (\[.*?\]);\s*\nexport', src, re.S)
    if not m:
        raise ValueError('解析不了 lucide 图标 ' + name)
    js = m.group(1)
    js = re.sub(r'(?<=[{,\s])([A-Za-z_][\w-]*)\s*:', r'"\1":', js)
    data = json.loads(js)
    return [(tag, attrs) for tag, attrs in data]


def element_svg(tag, attrs, **extra):
    a = dict(attrs)
    a.update({k.replace('_', '-'): v for k, v in extra.items()})
    a.pop('key', None)
    return '<%s %s/>' % (tag, ' '.join('%s="%s"' % (k, v) for k, v in a.items()))


def icon_svg(elements, *, stroke=2.0, solid=False, box=24, extra=''):
    """elements 画成一张 SVG（黑笔白底）。solid=True：第一个元素实心填黑，其余元素用白笔挖空（做 .fill 风格）。"""
    parts = []
    for i, (tag, attrs) in enumerate(elements):
        if solid and i == 0:
            parts.append(element_svg(tag, attrs, fill='#000', stroke='#000'))
        elif solid:
            parts.append(element_svg(tag, attrs, fill='none', stroke='#fff'))
        else:
            parts.append(element_svg(tag, attrs))
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {b} {b}" width="{b}" height="{b}">'
            '<g fill="none" stroke="#000" stroke-width="{s}" stroke-linecap="round" stroke-linejoin="round">{p}</g>{x}</svg>'
            ).format(b=box, s=stroke, p=''.join(parts), x=extra)


# —— 位图 → 轮廓 —————————————————————————————————————————————————————————————

def rasterize(svg, px):
    png = cairosvg.svg2png(bytestring=svg.encode('utf-8'), output_width=px, output_height=px, background_color='white')
    im = Image.open(io.BytesIO(png)).convert('L')
    return 1.0 - np.asarray(im, dtype=np.float64) / 255.0   # 墨 = 1，纸 = 0


def _rdp(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    n = math.hypot(*ab)
    if n == 0:
        d = np.hypot(*(pts - a).T)
    else:
        v = pts - a
        d = np.abs(ab[0] * v[:, 1] - ab[1] * v[:, 0]) / n
    i = int(np.argmax(d))
    if d[i] > tol:
        left = _rdp(pts[:i + 1], tol)
        right = _rdp(pts[i:], tol)
        return np.vstack([left[:-1], right])
    return np.vstack([a, b])


def simplify_ring(ring, tol):
    """闭合环的 Douglas-Peucker：先按最远两点切成两段各自化简。"""
    pts = np.asarray(ring, dtype=np.float64)
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 4:
        return pts
    d = np.hypot(*(pts - pts[0]).T)
    j = int(np.argmax(d))
    a = _rdp(np.vstack([pts[:j + 1]]), tol)
    b = _rdp(np.vstack([pts[j:], pts[:1]]), tol)
    out = np.vstack([a[:-1], b[:-1]])
    return out


def signed_area(r):
    x, y = r[:, 0], r[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def trace(svg, *, box=24, px=1200, tol_px=0.6, min_area_px=6.0):
    """SVG（viewBox 0..box）→ [[外环, 洞环…], …]，坐标是 viewBox 单位、y 向下。"""
    ink = rasterize(svg, px)
    gen = contourpy.contour_generator(z=ink, fill_type=contourpy.FillType.OuterOffset)
    pts_list, offs_list = gen.filled(0.5, 2.0)
    k = box / px
    shapes = []
    for pts, offs in zip(pts_list, offs_list):
        rings = []
        for s, e in zip(offs[:-1], offs[1:]):
            r = simplify_ring(pts[s:e], tol_px)
            if len(r) < 3 or abs(signed_area(r)) < min_area_px:
                continue
            rings.append(r * k)
        if rings:
            shapes.append(rings)
    return shapes


def rings_bbox(shapes):
    allp = np.vstack([r for sh in shapes for r in sh])
    return allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max()


def oriented(shapes, *, y_up):
    """按字体要求定方向：外环顺时针、洞逆时针（在给定坐标系里）。返回 [环…]（打平）。"""
    out = []
    for sh in shapes:
        for i, r in enumerate(sh):
            a = signed_area(r)
            if y_up:
                want_cw = (i == 0)
                is_cw = a < 0
            else:   # y 向下时肉眼顺时针 = 数学上的逆时针
                want_cw = (i == 0)
                is_cw = a > 0
            out.append(r if is_cw == want_cw else r[::-1])
    return out


def _num(v):
    s = ('%.1f' % v).rstrip('0').rstrip('.')
    if s in ('', '-', '-0'):
        return '0'
    if s.startswith('0.'):
        return s[1:]
    if s.startswith('-0.'):
        return '-' + s[2:]
    return s


def path_d(rings):
    """环 → SVG path d（直线段，一位小数）。"""
    segs = []
    for r in rings:
        p = ['M' + _num(r[0][0]) + ' ' + _num(r[0][1])]
        for x, y in r[1:]:
            p.append('L' + _num(x) + ' ' + _num(y))
        segs.append(''.join(p) + 'Z')
    return ''.join(segs)
