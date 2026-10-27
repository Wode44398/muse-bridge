"""生成公开版自带的字体（web/src/assets/font/）。

  python build_fonts.py --lucide <lucide 包目录> --lora <Lora 静态字体目录> --inter <Inter 拉丁子集 woff2> [--out <目录>]

产出（文件名固定，代码按名字引用）：
  bridge-sans-var.woff2    「Bridge Sans」= Inter 4（OFL 1.1，原样拷贝，可变字重 100–900）
  bridge-serif-var.woff2   「Bridge Serif」= Lora 3.008 的 Regular / Bold 两个母版插值成可变字重 400–700（OFL 1.1；
                           按 OFL 改动版不能沿用保留字体名「Lora」，所以 name 表改名为 Bridge Serif）
  bridge-icons.woff2       「Bridge Icons」= Lucide 图标（ISC）描边转填充后放在界面原来用的私有区码位上（见 ICONS），
                           组件里按码位取字形的写法一行不用改；维护者的私有 overlay 可把 --icons 指回原版图标字体
  bridge-symbols.woff2     「Bridge Symbols」= 同样来源的连字图标（Vertex 分页用：按名字 menu / plus / mic… 出图）
许可文本：OFL-Inter.txt、OFL-Lora.txt、LICENSE-Lucide.txt 写到 web/public/licenses/（--licenses），随构建产物发布到
/app/licenses/——字体本身的 name 表只放一句出处，许可全文靠这几个文件随包分发（OFL 与 ISC/MIT 都要求附上）。
"""
import argparse
import io
import os
import shutil
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor
from fontTools import varLib, subset
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import iconkit  # noqa: E402

LUCIDE_LICENSE_NOTE = ('Icons from Lucide (https://lucide.dev), ISC License - https://opensource.org/licenses/ISC ; '
                       'outlined and assembled for claude-bridge.')

# —— 私有区码位 → Lucide 图标（与界面里按码位取字形的地方一一对应）——————————————————————
# 值：lucide 名字；或 ('solid', 名字)：第一个元素实心、其余挖空；或 ('svg', 元素列表)：自绘（24 网格，描边 2）
ICONS = {
    0xE001: 'plus',
    0xE008: 'archive',
    0xE00C: 'arrow-left',
    # 下 / 右箭头：Lucide 的 chevron 偏小，按原界面的比例放大一档（自绘，同一笔法）
    0xE027: ('svg', [('path', {'d': 'm4.5 8.25 7.5 7.5 7.5-7.5'})]),
    0xE02A: ('svg', [('path', {'d': 'm8.25 4.5 7.5 7.5-7.5 7.5'})]),
    0xE03B: 'check',
    0xE03C: 'circle-check',
    0xE03D: ('solid', 'circle-check'),
    0xE056: 'copy',
    0xE060: 'circle-ellipsis',
    0xE062: 'ellipsis-vertical',
    0xE064: 'pencil',
    0xE072: 'folder',
    0xE078: 'git-branch',
    0xE088: 'circle-question-mark',
    0xE08A: 'house',
    0xE08F: 'info',
    0xE098: 'zap',
    0xE0BD: 'pin',
    # 项目：两道横线 + 一只收口的盒（自绘）
    0xE0C9: ('svg', [('path', {'d': 'M8 3.5h8'}), ('path', {'d': 'M5.5 7h13'}),
                     ('path', {'d': 'M3.5 10.5h17l-1.2 7.6a2.5 2.5 0 0 1-2.47 2.1H7.17a2.5 2.5 0 0 1-2.47-2.1z'})]),
    0xE0CE: 'rotate-cw',
    0xE0D3: 'search',
    0xE0D6: 'settings',
    0xE0DD: 'panel-left',
    # 卡片叠放：前一张完整、后一张只露上沿与右沿（自绘）
    0xE0E2: ('svg', [('rect', {'x': '2.5', 'y': '8.5', 'width': '15', 'height': '11', 'rx': '2.5'}),
                     ('path', {'d': 'M6.5 8.5V7.5A2.5 2.5 0 0 1 9 5h10a2.5 2.5 0 0 1 2.5 2.5v6.5a2.5 2.5 0 0 1-2.5 2.5h-1.5'})]),
    0xE0E5: 'loader-circle',
    0xE0EA: 'square',
    0xE101: 'trash-2',
    0xE105: 'circle-user-round',
    0xE109: 'triangle-alert',
    0xE10F: 'x',
    0xE11C: 'share-2',
}

# —— Vertex 分页的连字名 → Lucide 图标 ————————————————————————————————————————————————
SYMBOLS = {
    'arrow_back': 'arrow-left', 'arrow_upward': 'arrow-up', 'check': 'check', 'chevron_right': 'chevron-right',
    'delete': 'trash-2', 'gemini_chat': 'sparkle', 'keyboard_arrow_down': 'chevron-down', 'layers': 'layers',
    'menu': 'menu', 'mic': 'mic', 'plus': 'plus', 'add': 'plus', 'refresh': 'refresh-cw', 'side_nav': 'panel-left',
    'side_nav_expand': 'panel-left-open', 'content_copy': 'copy', 'image': 'image', 'videocam': 'video',
    'volume_up': 'volume-2', 'music_note': 'music', 'close': 'x', 'more_vert': 'ellipsis-vertical',
}


def elements_for(spec, lucide):
    if isinstance(spec, tuple) and spec[0] == 'svg':
        return spec[1], False
    if isinstance(spec, tuple) and spec[0] == 'solid':
        return iconkit.load_lucide(lucide, spec[1]), True
    return iconkit.load_lucide(lucide, spec), False


def glyph_from(spec, lucide, *, scale, ox, oy_top, em_top, stroke=2.0):
    els, solid = elements_for(spec, lucide)
    shapes = iconkit.trace(iconkit.icon_svg(els, stroke=stroke, solid=solid))
    # 24 网格 → 字体单位（y 向上）：x' = ox + x·scale；y' = em_top − (oy_top + y·scale)
    tshapes = []
    for sh in shapes:
        tshapes.append([[(ox + x * scale, em_top - (oy_top + y * scale)) for x, y in r] for r in sh])
    import numpy as np
    rings = iconkit.oriented([[np.asarray(r) for r in sh] for sh in tshapes], y_up=True)
    pen = TTGlyphPen(None)
    for r in rings:
        pts = [(int(round(x)), int(round(y))) for x, y in r]
        dedup = [pts[0]] + [p for i, p in enumerate(pts[1:], 1) if p != pts[i - 1]]
        if len(dedup) > 1 and dedup[-1] == dedup[0]:
            dedup.pop()
        if len(dedup) < 3:
            continue
        pen.moveTo(dedup[0])
        for p in dedup[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


def _lsb(fb, name):
    # hmtx 的左边距必须等于字形的 xMin（DirectWrite 按 xMin − lsb 定原点，不一致整枚字形会横移）
    glyf = fb.font['glyf']
    g = glyf[name]
    g.recalcBounds(glyf)
    return getattr(g, 'xMin', 0) if g.numberOfContours else 0


def empty_glyph():
    return TTGlyphPen(None).glyph()


def set_names(fb, family, *, version, copyright, license_desc, license_url, designer=''):
    fb.setupNameTable({
        'copyright': copyright, 'familyName': family, 'styleName': 'Regular',
        'uniqueFontIdentifier': family.replace(' ', '') + '-' + version, 'fullName': family,
        'psName': family.replace(' ', '') + '-Regular', 'version': 'Version ' + version,
        'designer': designer, 'licenseDescription': license_desc, 'licenseInfoURL': license_url,
    })


def build_icons(lucide, out):
    names = ['.notdef', 'space'] + ['uni%04X' % cp for cp in sorted(ICONS)]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x20: 'space', **{cp: 'uni%04X' % cp for cp in ICONS}})
    glyphs = {'.notdef': empty_glyph(), 'space': empty_glyph()}
    for cp, spec in ICONS.items():
        # 与原界面用的图标字体同一套几何：1000 的 em，基线在底、整格 1000 高；24 网格缩到 920、四周各留 40
        glyphs['uni%04X' % cp] = glyph_from(spec, lucide, scale=920 / 24, ox=40, oy_top=40, em_top=1000)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (1000, _lsb(fb, n)) for n in names})
    fb.setupHorizontalHeader(ascent=1000, descent=0)
    fb.setupOS2(sTypoAscender=1000, sTypoDescender=0, sTypoLineGap=0, usWinAscent=1000, usWinDescent=0,
                achVendID='NONE', fsType=0)
    set_names(fb, 'Bridge Icons', version='1.000', copyright='Lucide Contributors (ISC); assembled for claude-bridge',
              license_desc=LUCIDE_LICENSE_NOTE, license_url='https://opensource.org/licenses/ISC')
    fb.setupPost()
    fb.setupMaxp()
    fb.font.flavor = 'woff2'
    fb.font.save(os.path.join(out, 'bridge-icons.woff2'))


def build_symbols(lucide, out):
    letters = sorted(set(''.join(SYMBOLS.keys())))
    gname = {c: ('underscore' if c == '_' else c) for c in letters}
    ligs = sorted(SYMBOLS)
    names = ['.notdef', 'space'] + [gname[c] for c in letters] + ['lig.' + k for k in ligs]
    fb = FontBuilder(960, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x20: 'space', **{ord(c): gname[c] for c in letters}})
    glyphs = {n: empty_glyph() for n in names}
    cache = {}
    for k in ligs:
        spec = SYMBOLS[k]
        if spec not in cache:
            # 960 的 em，图标框即整格（与原 Vertex 页用的符号字体同一套几何）
            cache[spec] = glyph_from(spec, lucide, scale=40, ox=0, oy_top=0, em_top=960)
        glyphs['lig.' + k] = cache[spec]
    fb.setupGlyf(glyphs)
    adv = {n: 0 for n in names}
    adv.update({'space': 240, **{'lig.' + k: 960 for k in ligs}})
    fb.setupHorizontalMetrics({n: (adv[n], _lsb(fb, n)) for n in names})
    fb.setupHorizontalHeader(ascent=1056, descent=-96)
    fb.setupOS2(sTypoAscender=1056, sTypoDescender=-96, sTypoLineGap=0, usWinAscent=1062, usWinDescent=91,
                achVendID='NONE', fsType=0)
    set_names(fb, 'Bridge Symbols', version='1.000', copyright='Lucide Contributors (ISC); assembled for claude-bridge',
              license_desc=LUCIDE_LICENSE_NOTE, license_url='https://opensource.org/licenses/ISC')
    fb.setupPost()
    fb.setupMaxp()
    rules = '\n'.join('  sub %s by lig.%s;' % (' '.join(gname[c] for c in k), k) for k in sorted(ligs, key=len, reverse=True))
    fea = ('languagesystem DFLT dflt;\nlanguagesystem latn dflt;\n'
           'lookup NAMES {\n%s\n} NAMES;\nfeature liga { lookup NAMES; } liga;\nfeature rlig { lookup NAMES; } rlig;\n' % rules)
    addOpenTypeFeaturesFromString(fb.font, fea)
    fb.font.flavor = 'woff2'
    fb.font.save(os.path.join(out, 'bridge-symbols.woff2'))


# —— Bridge Serif：Lora 两个静态母版 → 可变字重 ——————————————————————————————————————
SERIF_UNICODES = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x2000, 0x2070))
                  + [0x131, 0x152, 0x153, 0x2C6, 0x2DA, 0x2DC, 0x20AC, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2215, 0xFEFF, 0xFFFD])

LORA_NOTE = ('Bridge Serif is a Modified Version of Lora 3.008 (Copyright 2011 The Lora Project Authors, '
             'https://github.com/cyrealtype/Lora-Cyrillic) - two static masters subsetted and interpolated into a weight axis, '
             'renamed as required by the Reserved Font Name "Lora". Licensed under the SIL Open Font License, Version 1.1.')


def _subset(path, tmp):
    f = TTFont(path)
    opts = subset.Options()
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.glyph_names = True
    opts.drop_tables += ['STAT']
    s = subset.Subsetter(opts)
    s.populate(unicodes=SERIF_UNICODES)
    s.subset(f)
    f.save(tmp)
    return tmp


def build_serif(lora_dir, out, tmpdir):
    reg = _subset(os.path.join(lora_dir, 'Lora-Regular.ttf'), os.path.join(tmpdir, 'lora-400.ttf'))
    bold = _subset(os.path.join(lora_dir, 'Lora-Bold.ttf'), os.path.join(tmpdir, 'lora-700.ttf'))
    ds = DesignSpaceDocument()
    ax = AxisDescriptor()
    ax.tag, ax.name, ax.minimum, ax.default, ax.maximum = 'wght', 'Weight', 400, 400, 700
    # 中间字重往粗里挪一档（avar）：界面标题多用 500，Lora 的 500 比原界面的衬线标题偏细
    ax.map = [(400, 400), (500, 560), (600, 640), (700, 700)]
    ds.addAxis(ax)
    for p, w, name in ((reg, 400, 'Regular'), (bold, 700, 'Bold')):
        s = SourceDescriptor()
        s.path, s.location, s.styleName, s.familyName = p, {'Weight': w}, name, 'Bridge Serif'
        ds.addSource(s)
    vf, _, _ = varLib.build(ds, exclude=['STAT'])
    name = vf['name']
    for rec in list(name.names):
        if rec.nameID not in (0,):
            name.removeNames(nameID=rec.nameID)
    name.setName('Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic); '
                 'Modified Version for claude-bridge (renamed, not "Lora")', 0, 3, 1, 0x409)
    for nid, val in ((1, 'Bridge Serif'), (2, 'Regular'), (3, 'BridgeSerif-1.000'), (4, 'Bridge Serif'),
                     (5, 'Version 1.000; Lora 3.008'), (6, 'BridgeSerif-Regular'), (13, LORA_NOTE),
                     (14, 'https://openfontlicense.org'), (25, 'BridgeSerif')):
        name.setName(val, nid, 3, 1, 0x409)
    if 'fvar' in vf:
        vf['fvar'].instances = []
    vf['OS/2'].achVendID = 'NONE'
    vf.flavor = 'woff2'
    vf.save(os.path.join(out, 'bridge-serif-var.woff2'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lucide', required=True)
    ap.add_argument('--lora', required=True, help='含 Lora-Regular.ttf、Lora-Bold.ttf、Lora-OFL.txt 的目录')
    ap.add_argument('--inter', required=True, help='Inter 4 拉丁子集（可变字重）woff2')
    ap.add_argument('--inter-license', default=os.path.join(HERE, '..', '..', '..', 'harness', 'web', 'src', 'assets', 'fonts', 'OFL-Inter.txt'))
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'src', 'assets', 'font'))
    ap.add_argument('--licenses', default=os.path.join(HERE, '..', '..', 'public', 'licenses'), help='许可文本输出目录（随产物发布）')
    ap.add_argument('--only', default='', help='逗号分隔：sans,serif,icons,symbols')
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    lic = os.path.abspath(a.licenses)
    os.makedirs(lic, exist_ok=True)
    only = set(filter(None, a.only.split(',')))
    tmp = os.path.join(out, '.tmp-build')
    os.makedirs(tmp, exist_ok=True)
    try:
        if not only or 'sans' in only:
            shutil.copyfile(a.inter, os.path.join(out, 'bridge-sans-var.woff2'))
            shutil.copyfile(a.inter_license, os.path.join(lic, 'OFL-Inter.txt'))
        if not only or 'serif' in only:
            build_serif(a.lora, out, tmp)
            shutil.copyfile(os.path.join(a.lora, 'Lora-OFL.txt'), os.path.join(lic, 'OFL-Lora.txt'))
        if not only or 'icons' in only:
            build_icons(a.lucide, out)
        if not only or 'symbols' in only:
            build_symbols(a.lucide, out)
        if not only or 'icons' in only or 'symbols' in only:
            shutil.copyfile(os.path.join(a.lucide, 'LICENSE'), os.path.join(lic, 'LICENSE-Lucide.txt'))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    for f in sorted(os.listdir(out)):
        print('%-28s %8d' % (f, os.path.getsize(os.path.join(out, f))))


if __name__ == '__main__':
    main()
