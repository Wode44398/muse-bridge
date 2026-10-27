"""生成公开版的设置页符号表 web/src/lib/sfSymbols.js（键名沿用设置页用的符号名，字形是 Lucide 图标，ISC）。

  python gen_symbols.py --lucide <lucide 包目录> [--sizes <参考尺寸 json>] [--out web/src/lib/sfSymbols.js]

格式与组件约定一致：'名字@字重': [墨迹宽, 墨迹高, 路径]（100pt 坐标，墨迹框左上角为原点，fill 绘制）。
Lucide 是描边图标：按字重换描边粗细，画成高分辨率位图再取轮廓（见 iconkit.py）。
「.fill」类的符号做成实心：第一个元素填实，其余元素在实心上挖空（或照常描边，见 RECIPES 的 ops）。
--sizes：{ 键: [宽, 高] }，给了就按它的最长边缩放（与界面原有尺寸对齐）；没给按 Lucide 24 网格 = 118pt。
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import iconkit  # noqa: E402

# 键 → (lucide 名, ops)；ops 省略 = 全部描边；'fill' 填实、'stroke' 照常描边、'knock' 白笔挖空、'hole' 白色填实挖洞
RECIPES = {
    'gearshape.fill@500': ('settings', ['fill', 'hole']),
    'sun.max.fill@500': ('sun', ['fill'] + ['stroke'] * 8),
    'camera.macro@500': ('flower-2', None),
    'drop.fill@500': ('droplet', ['fill']),
    'water.waves@500': ('waves', None),
    'sparkles@500': ('sparkles', None),
    'bell.badge.fill@500': ('bell-dot', ['stroke', 'fill', 'fill']),
    'iphone.radiowaves.left.and.right@500': ('smartphone-nfc', None),
    'desktopcomputer@500': ('monitor', None),
    'display.2@500': ('monitor-smartphone', None),
    'exclamationmark.bubble.fill@500': ('message-square-warning', ['fill', 'knock', 'knock']),
    'arrow.down.circle.fill@500': ('circle-arrow-down', ['fill', 'knock', 'knock']),
    'square.grid.2x2.fill@500': ('layout-grid', ['fill', 'fill', 'fill', 'fill']),
    'puzzlepiece.extension.fill@500': ('puzzle', ['fill']),
    'server.rack@500': ('server', None),
    'accessibility@500': ('accessibility', None),
    'battery.100percent@500': ('battery-full', None),
    'arrow.up.forward.app@500': ('square-arrow-out-up-right', None),
    'keyboard.fill@500': ('keyboard', ['knock'] * 8 + ['fill']),
    'capsule.portrait.fill@500': ([('rect', {'x': '7', 'y': '2.5', 'width': '10', 'height': '19', 'rx': '5'})], ['fill']),
    'viewfinder@500': ('scan', None),
    'scope@500': ('crosshair', None),
    'globe@500': ('globe', None),
    'info.circle.fill@500': ('info', ['fill', 'knock', 'knock']),
    'photo.fill@500': ('image', ['fill', 'hole', 'knock']),
    'wifi@500': ('wifi', None),
    'network@500': ('network', None),
    'stop.fill@500': ('square', ['fill']),
    'hand.raised.fill@500': ('hand', None),
    'chevron.right@600': ('chevron-right', None),
    'chevron.backward@600': ('chevron-left', None),
    'checkmark@600': ('check', None),
    'chevron.up.chevron.down@400': ('chevrons-up-down', None),
    'xmark@500': ('x', None),
    'checkmark@500': ('check', None),
    'plus@500': ('plus', None),
    'trash@400': ('trash', None),
    'sun.max@600': ('sun', None),
    'moon.fill@600': ('moon', ['fill']),
    'xmark.circle.fill@400': ('circle-x', ['fill', 'knock', 'knock']),
    'checkmark.circle.fill@400': ('circle-check', ['fill', 'knock']),
    'exclamationmark.triangle.fill@400': ('triangle-alert', ['fill', 'knock', 'knock']),
    'photo.badge.plus@400': ('image-plus', None),
    'info.circle@400': ('info', None),
    'ellipsis@500': ('ellipsis', None),
    'magnifyingglass@500': ('search', None),
    'magnifyingglass@600': ('search', None),
    'iphone@600': ('smartphone', None),
    'square.and.arrow.up@400': ('share', None),
    'square.and.arrow.up@600': ('share', None),
    'link@400': ('link', None),
    'sparkles@400': ('sparkles', None),
    'arrow.up.forward.app@400': ('square-arrow-out-up-right', None),
    'square.and.pencil@400': ('square-pen', None),
    'arrow.down.circle@400': ('circle-arrow-down', None),
    'trash@600': ('trash', None),
    'info.circle@600': ('info', None),
    'plus.circle.fill@400': ('circle-plus', ['fill', 'knock', 'knock']),
    'ellipsis@600': ('ellipsis', None),
    'ellipsis.circle@400': ('circle-ellipsis', None),
    'desktopcomputer@400': ('monitor', None),
    'display@400': ('monitor', None),
    'globe@400': ('globe', None),
    'lock.fill@400': ('lock', ['fill', 'stroke']),
    'iphone@400': ('smartphone', None),
    'xmark@600': ('x', None),
    'checkmark.circle.fill@500': ('circle-check', ['fill', 'knock']),
    'photo.on.rectangle@400': ('images', None),
    'paperplane.fill@400': ('send', ['fill', 'knock']),
}
STROKE = {'400': 1.9, '500': 2.1, '600': 2.4}
NL = chr(10)
MENU = {'paperclip': 'paperclip', 'research': 'scan-search', 'feather': 'feather'}


def svg_with_ops(elements, ops, stroke):
    if not ops:
        return iconkit.icon_svg(elements, stroke=stroke)
    parts = []
    # 先画实心、再描边、最后挖空（与元素在图标里的先后无关）
    order = {'fill': 0, 'stroke': 1, 'hole': 2, 'knock': 2}
    seq = sorted(enumerate(elements), key=lambda t: order.get(ops[t[0]] if t[0] < len(ops) else 'knock', 2))
    for i, (tag, attrs) in seq:
        op = ops[i] if i < len(ops) else 'knock'
        if op == 'fill':
            parts.append(iconkit.element_svg(tag, attrs, fill='#000', stroke='#000'))
        elif op == 'stroke':
            parts.append(iconkit.element_svg(tag, attrs, fill='none', stroke='#000'))
        elif op == 'hole':
            parts.append(iconkit.element_svg(tag, attrs, fill='#fff', stroke='#fff'))
        else:
            parts.append(iconkit.element_svg(tag, attrs, fill='none', stroke='#fff'))
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">'
            '<g fill="none" stroke="#000" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round">%s</g></svg>'
            % (stroke, ''.join(parts)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lucide', required=True)
    ap.add_argument('--sizes', default='')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'src', 'lib', 'sfSymbols.js'))
    ap.add_argument('--out-menu', default=os.path.join(HERE, '..', '..', 'src', 'lib', 'menuIconPaths.js'))
    a = ap.parse_args()
    sizes = json.load(open(a.sizes, encoding='utf-8')) if a.sizes else {}
    out = {}
    for key, (icon, ops) in RECIPES.items():
        weight = key.rsplit('@', 1)[1]
        els = icon if isinstance(icon, list) else iconkit.load_lucide(a.lucide, icon)
        shapes = iconkit.trace(svg_with_ops(els, ops, STROKE[weight]), tol_px=2.5)
        x0, y0, x1, y1 = iconkit.rings_bbox(shapes)
        w, h = x1 - x0, y1 - y0
        ref = sizes.get(key)
        k = (max(ref) / max(w, h)) if ref else 118 / 24
        rings = iconkit.oriented([[(r - [x0, y0]) * k for r in sh] for sh in shapes], y_up=False)
        out[key] = [round(w * k), round(h * k), iconkit.path_d(rings)]
    lines = [
        '// 设置页（iOS 风格）用的符号字形。由 web/scripts/public-assets/gen_symbols.py 生成，勿手改。',
        '// 键名沿用设置页一直用的符号名；字形是 Lucide 图标（ISC，https://lucide.dev），描边转成填充轮廓。',
        '// 维护者的私有 overlay 可换一套（清单 modules.sfSymbols，导出同格式的 SF），见 lib/symbolTable.svelte.js。',
        "// 'name@weight': [墨迹宽, 墨迹高, 路径]（100pt 坐标）。",
        'export const SF = {',
    ]
    for key, (w, h, d) in out.items():
        lines.append("  '%s': [%d, %d, '%s']," % (key, w, h, d))
    lines.append('};')
    open(a.out, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
    print('wrote', a.out, len(out), 'symbols', os.path.getsize(a.out), 'bytes')

    # 加号菜单 / 输入框里的三枚小图标（viewBox 0 0 20 20、fill 绘制）
    menu = {}
    for key, name in MENU.items():
        shapes = iconkit.trace(iconkit.icon_svg(iconkit.load_lucide(a.lucide, name), stroke=1.6), tol_px=2.0)
        rings = iconkit.oriented([[np.asarray(r) * (20 / 24) for r in sh] for sh in shapes], y_up=False)
        menu[key] = iconkit.path_d(rings)
    lines = [
        '// 加号菜单与输入框用的小图标路径（viewBox 0 0 20 20、fill 绘制）。由 web/scripts/public-assets/gen_symbols.py 生成，勿手改。',
        '// 字形是 Lucide 图标（ISC，https://lucide.dev）：' + '、'.join('%s=%s' % kv for kv in MENU.items()) + '。',
        'export const MENU_ICONS = {',
    ] + ["  %s: '%s'," % (k, v) for k, v in menu.items()] + ['};']
    open(a.out_menu, 'w', encoding='utf-8', newline=NL).write(NL.join(lines) + NL)
    print('wrote', a.out_menu)


if __name__ == '__main__':
    main()
