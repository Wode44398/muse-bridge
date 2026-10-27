"""生成公开版的识别素材（全部自绘）：

  web/public/assets/mascot/claude-小人-正面站立.svg / -正面行走.svg / -举旗.svg   主页 Claude 入口的像素小人
  web/public/assets/mascot/claude-菊花-静态.svg                                 Claude 的星标（十二道光芒）
  web/public/assets/icons/workspace.png                                         文件夹图标（256×256）

文件名与尺寸沿用界面原来引用的路径（组件按路径取，私有 overlay 可用同名原版覆盖，见 lib/overlay.svelte.js 的 ovUrl）。
  python gen_marks.py [--public <web/public 目录>]
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
CLAY = '#D97757'
INK = '#2B1B14'


def rects(rs, fill):
    return ''.join('<rect x="%g" y="%g" width="%g" height="%g" fill="%s"/>' % (x, y, w, h, fill) for x, y, w, h in rs)


def creature(ox, oy, legs, arms=None):
    """一只方块小生物：圆角块身体（切掉四角）、两只眼、可选小手、四条腿。坐标单位 = px，格子 11。"""
    body = [(ox + 11, oy, 110, 11), (ox, oy + 11, 132, 44), (ox + 11, oy + 55, 110, 11)]
    eyes = [(ox + 33, oy + 22, 11, 16), (ox + 88, oy + 22, 11, 16)]
    s = rects(body, CLAY) + rects(eyes, INK)
    if arms:
        s += rects(arms, CLAY)
    s += rects(legs, CLAY)
    return s


def svg(w, h, inner):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" fill="none" shape-rendering="crispEdges">%s</svg>\n'
            % (w, h, inner))


def mascots(out):
    # 站立：158×128
    ox, oy = 13, 40
    legs = [(ox + 11, oy + 66, 11, 22), (ox + 33, oy + 66, 11, 22), (ox + 88, oy + 66, 11, 22), (ox + 110, oy + 66, 11, 22)]
    stand = svg(158, 128, creature(ox, oy, legs, arms=[(ox - 11, oy + 22, 11, 22), (ox + 132, oy + 22, 11, 22)]))
    # 行走：129×113（腿一前一后）
    ox, oy = -2, 36
    legs = [(ox + 11, oy + 66, 11, 11), (ox + 33, oy + 66, 11, 6), (ox + 88, oy + 66, 11, 6), (ox + 110, oy + 66, 11, 11)]
    walk = svg(129, 113, creature(ox, oy, legs))
    # 举旗：140×146（左手举一面小旗）
    ox, oy = 8, 62
    legs = [(ox + 11, oy + 66, 11, 18), (ox + 33, oy + 66, 11, 18), (ox + 88, oy + 66, 11, 18), (ox + 110, oy + 66, 11, 18)]
    flag = rects([(0, 14, 5, 76)], INK) + rects([(5, 14, 32, 20)], '#E8B04A')
    lift = svg(140, 146, creature(ox, oy, legs, arms=[(0, oy + 11, 8, 11)]) + flag)
    for name, s in (('正面站立', stand), ('正面行走', walk), ('举旗', lift)):
        open(os.path.join(out, 'claude-小人-%s.svg' % name), 'w', encoding='utf-8', newline='\n').write(s)


def star(out, lobe_svg):
    """Claude 的服务标志（标识 agent 用，不去品牌）：取 @lobehub/icons-static-svg 的 icons/claude-color.svg（MIT，
    Copyright (c) 2023 LobeHub），只留路径、补出处注释。许可全文在 web/public/licenses/LICENSE-lobe-icons.txt。"""
    import re
    d = re.search(r' d="([^"]+)"', open(lobe_svg, encoding='utf-8').read()).group(1)
    s = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><!-- Claude 标志：@lobehub/icons-static-svg 1.96.0 '
         'icons/claude-color.svg（MIT，Copyright (c) 2023 LobeHub）。标志归其权利人所有，仅用于标识 Claude 服务。 -->'
         '<path d="%s" fill="#D97757" fill-rule="nonzero"/></svg>\n' % d)
    open(os.path.join(out, 'claude-菊花-静态.svg'), 'w', encoding='utf-8', newline='\n').write(s)


def folder(path):
    S = 4
    W = 256 * S
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    sh = Image.new('L', (W, W), 0)
    d = ImageDraw.Draw(sh)
    d.rounded_rectangle([22 * S, 66 * S, 234 * S, 222 * S], radius=22 * S, fill=110)
    sh = sh.filter(ImageFilter.GaussianBlur(6 * S))
    shadow = Image.new('RGBA', (W, W), (20, 60, 120, 0))
    shadow.putalpha(sh.point(lambda v: v * 0.45))
    im.alpha_composite(shadow, (0, 4 * S))
    d = ImageDraw.Draw(im)
    # 后片（带页签）
    d.rounded_rectangle([20 * S, 44 * S, 112 * S, 92 * S], radius=16 * S, fill=(58, 136, 222, 255))
    d.rounded_rectangle([20 * S, 60 * S, 236 * S, 214 * S], radius=20 * S, fill=(58, 136, 222, 255))
    # 纸
    d.rounded_rectangle([34 * S, 72 * S, 222 * S, 150 * S], radius=10 * S, fill=(246, 248, 252, 255))
    # 前片：上浅下深
    front = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    fm = Image.new('L', (W, W), 0)
    ImageDraw.Draw(fm).rounded_rectangle([20 * S, 92 * S, 236 * S, 218 * S], radius=20 * S, fill=255)
    grad = Image.new('RGBA', (W, W))
    gd = ImageDraw.Draw(grad)
    for y in range(92 * S, 218 * S):
        t = (y - 92 * S) / (126 * S)
        c = (int(110 - 40 * t), int(186 - 40 * t), int(250 - 22 * t), 255)
        gd.line([(0, y), (W, y)], fill=c)
    front.paste(grad, (0, 0), fm)
    im.alpha_composite(front)
    hl = Image.new('L', (W, W), 0)
    ImageDraw.Draw(hl).rounded_rectangle([24 * S, 95 * S, 232 * S, 100 * S], radius=3 * S, fill=90)
    im.alpha_composite(Image.merge('RGBA', (hl.point(lambda v: 255), hl.point(lambda v: 255), hl.point(lambda v: 255), hl)))
    im.resize((256, 256), Image.LANCZOS).save(path, optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--public', default=os.path.join(HERE, '..', '..', 'public'))
    a = ap.parse_args()
    mdir = os.path.join(a.public, 'assets', 'mascot')
    os.makedirs(mdir, exist_ok=True)
    mascots(mdir)
    star(mdir)
    folder(os.path.join(a.public, 'assets', 'icons', 'workspace.png'))
    for f in sorted(os.listdir(mdir)):
        print(f, os.path.getsize(os.path.join(mdir, f)))


if __name__ == '__main__':
    main()
