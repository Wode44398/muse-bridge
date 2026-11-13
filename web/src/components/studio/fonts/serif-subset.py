# Media Studio 展示用宋体子集：思源宋体（Noto Serif SC，SIL OFL 1.1）wght 600 → 只含 Studio 里用宋体的字 → woff2。
# 做法照抄 dimensio 的 harness/web/brand/serif-font.py（同一款字、同一字重），只是文字表换成 Studio 的：
#   字标「Media Studio」+ 空态展示句（web/src/modules/studio/display.js 里 t('…') 的中文）+ 整套 ASCII（英文展示句）。
# 改了 display.js 的中文之后重跑：
#     python web/src/components/studio/fonts/serif-subset.py
# 依赖：fonttools + brotli；字体源默认取 Windows 已装的 NotoSerifSC-VF.ttf，可用 --src 指定。
import argparse, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))  # …/components/studio/fonts → web/src
ap = argparse.ArgumentParser()
ap.add_argument("--src", default=r"C:\Windows\Fonts\NotoSerifSC-VF.ttf")
ap.add_argument("--weight", default="600")
ap.add_argument("--out", default=os.path.join(HERE, "studio-serif-600.woff2"))
a = ap.parse_args()

display = open(os.path.join(SRC_DIR, "modules", "studio", "display.js"), encoding="utf-8").read()
texts = re.findall(r"t\('([^']+)'\)", display)
always = "".join(chr(c) for c in range(0x20, 0x7F)) + "，。、；：？！「」（）—…·"
chars = sorted(set("".join(texts) + always))
print(f"{len(chars)} glyphs: {''.join(c for c in chars if ord(c) > 0x7F)}")

with tempfile.TemporaryDirectory() as td:
    inst = os.path.join(td, "inst.ttf")
    txt = os.path.join(td, "chars.txt")
    open(txt, "w", encoding="utf-8").write("".join(chars))
    subprocess.check_call([sys.executable, "-m", "fontTools.varLib.instancer", a.src, f"wght={a.weight}", "-o", inst, "-q"])
    subprocess.check_call([sys.executable, "-m", "fontTools.subset", inst, f"--text-file={txt}",
                           "--flavor=woff2", "--layout-features=kern,liga,locl",
                           "--name-IDs=*", "--name-legacy", "--name-languages=*",
                           f"--output-file={a.out}"])
print(a.out, os.path.getsize(a.out), "bytes")
