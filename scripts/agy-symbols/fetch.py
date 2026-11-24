# Antigravity 分页的图标字体子集：向 Google Fonts 官方接口按名字要一份 Material Symbols Rounded 子集。
#
# 用法：  python scripts/agy-symbols/fetch.py web/src/visuals/fonts/agy/material-symbols-rounded-agy.woff2
# 依赖：fonttools + brotli（只用来核对出来的字体；pip install fonttools brotli）
#
# 为什么走接口而不是自己切：图标名有别名（restore 其实是 history 那个字形、draft 是 note），接口替我们把别名的
# 连字一并带上，出来的格式也和页面一直在用的那份一致。
# 注意：接口对它不认识的名字是【悄悄丢掉】而不是报错（spark 就是这样没的——现行 Material Symbols 里已经没有它，
# 收藏改用 star、运行工作流改用 account_tree），所以下面出来之后逐个核对。
#
# 保留的轴：FILL（选中 / 打开态由线稿变实心）、opsz（光学尺寸，页面用 font-optical-sizing 让它跟着字号走）、
# wght。不要 GRAD（页面没用，省体积）。
#
# 加图标：把名字加进 NAMES 重跑。出来之后脚本会逐个核对连字在不在——缺字的后果是页面上直接显示成那串英文，
# 所以宁可在这里失败。
import os
import re
import sys
import urllib.request

NAMES = sorted(set('''
add arrow_back arrow_downward arrow_upward attach_file bolt bug_report check check_circle checklist circle close
code code_blocks content_copy dark_mode delete description dock_to_right download edit edit_note edit_square error
expand_less expand_more extension folder folder_open globe help image info left_panel_close left_panel_open lightbulb
menu mindfulness more_horiz north_east open_in_new refresh replay restore schedule search shield smart_toy
stop_circle terminal tune visibility_off warning wb_twilight

desktop_windows play_arrow star account_tree
draft text_snippet table slideshow picture_as_pdf graphic_eq movie folder_zip
content_cut content_paste format_quote link select_all text_fields
'''.split()))

# 要 woff2 得报一个现代浏览器的 UA
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
CSS = ('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL@20..48,100..700,0..1'
       '&icon_names=' + ','.join(NAMES) + '&display=block')


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def ligature_names(font):
    cmap = font.getBestCmap()
    rev = {}
    for cp, g in sorted(cmap.items()):
        ch = chr(cp)
        if g not in rev or ch.islower() or ch.isdigit() or ch == '_':
            rev[g] = ch
    out = set()
    for lk in font['GSUB'].table.LookupList.Lookup:
        for st in lk.SubTable:
            st = getattr(st, 'ExtSubTable', st)
            for first, ls in (getattr(st, 'ligatures', None) or {}).items():
                for l in ls:
                    out.add((rev.get(first, '?') + ''.join(rev.get(c, '?') for c in l.Component)).lower())
    return out


def main(dst):
    css = get(CSS).decode('utf-8')
    m = re.search(r"src:\s*url\(([^)]+)\)\s*format\('woff2'\)", css)
    if not m:
        sys.exit('接口没给 woff2 地址：\n' + css[:400])
    data = get(m.group(1))
    tmp = dst + '.part'
    with open(tmp, 'wb') as f:
        f.write(data)

    from fontTools.ttLib import TTFont
    font = TTFont(tmp)
    lost = [n for n in NAMES if n not in ligature_names(font)]
    if lost:
        os.remove(tmp)
        sys.exit('字体里缺这些名字的连字：' + ', '.join(lost))
    axes = sorted(a.axisTag for a in font['fvar'].axes)
    if axes != ['FILL', 'opsz', 'wght']:
        os.remove(tmp)
        sys.exit('轴不对：' + ', '.join(axes))
    font.close()
    os.replace(tmp, dst)
    print(len(NAMES), 'icons,', len(data), 'bytes, axes', axes)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: fetch.py <output.woff2>')
    main(sys.argv[1])
