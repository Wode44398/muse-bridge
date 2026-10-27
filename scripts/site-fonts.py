#!/usr/bin/env python3
"""官网标题字体子集：Noto Serif SC（思源宋体，SIL OFL 1.1）→ 只含页面标题用到的字的 woff2。

官网标题（h1/h2/h3、问答的 summary、工作台释义的 dt、字标与页脚标语）用宋体；
整套 CJK 字库十几 MB，所以只打页面真正用到的那几百个字。

改了任何标题文字之后重跑一次（否则新字会回落到系统宋体）：
    python scripts/site-fonts.py            # 默认读 site/index.html，写 site/assets/fonts/
依赖：fonttools + brotli（pip install fonttools brotli）；字体源默认取 Windows 已装的
NotoSerifSC-VF.ttf，可用 --src 指定。
"""
import argparse, html, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('--html', default=os.path.join(ROOT, 'site', 'index.html'))
ap.add_argument('--out', default=os.path.join(ROOT, 'site', 'assets', 'fonts', 'bridge-serif-600.woff2'))
ap.add_argument('--src', default=r'C:\Windows\Fonts\NotoSerifSC-VF.ttf')
ap.add_argument('--weight', default='600')
a = ap.parse_args()

page = open(a.html, encoding='utf-8').read()
page = re.sub(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>', '', page)

# 用宋体的元素：标题三级、问答 summary、dt、字标与页脚标语
chunks = re.findall(r'<(h1|h2|h3|summary|dt)\b[^>]*>([\s\S]*?)</\1>', page)
texts = [c[1] for c in chunks]
texts += re.findall(r'class="(?:brand__word|foot__line)"[^>]*>([\s\S]*?)</', page)
text = html.unescape(re.sub(r'<[^>]+>', ' ', ' '.join(texts)))
# 常备：ASCII、常用中文标点与全角符号（标题里随时会出现，不值得每次重算）
always = ''.join(chr(c) for c in range(0x20, 0x7F)) + '，。、；：？！「」『』（）《》〈〉【】—…·～“”‘’　'
chars = sorted(set(text + always) - set('\n\r\t'))
print(f'{len(chars)} glyphs requested')

with tempfile.TemporaryDirectory() as td:
    inst = os.path.join(td, 'inst.ttf')
    txt = os.path.join(td, 'chars.txt')
    open(txt, 'w', encoding='utf-8').write(''.join(chars))
    subprocess.check_call([sys.executable, '-m', 'fontTools.varLib.instancer', a.src, f'wght={a.weight}', '-o', inst, '-q'])
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    subprocess.check_call([sys.executable, '-m', 'fontTools.subset', inst, f'--text-file={txt}',
                           '--flavor=woff2', '--layout-features=kern,liga,palt,vpal,locl',
                           '--name-IDs=*', '--name-legacy', '--name-languages=*',
                           f'--output-file={a.out}'])
print(a.out, os.path.getsize(a.out), 'bytes')
