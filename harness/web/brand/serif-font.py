# 展示用宋体子集：思源宋体（Noto Serif SC，SIL OFL 1.1）wght 600 → 只含界面里用宋体的固定文字 → woff2。
# 与 bridge 官网标题字（site/assets/fonts/bridge-serif-600.woff2）同一款字、同一字重；整套 CJK 字库十几 MB，只打用到的字。
#
# 用宋体的只有「展示」：空态首屏的时段问候（src/lib/theme.ts 的 greeting()）与连接页标题。
# 改了这些文字之后重跑一次（否则新字会落到系统宋体）：
#     python harness/web/brand/serif-font.py
# 依赖：fonttools + brotli；字体源默认取 Windows 已装的 NotoSerifSC-VF.ttf，可用 --src 指定。
import argparse, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
ap = argparse.ArgumentParser()
ap.add_argument("--src", default=r"C:\Windows\Fonts\NotoSerifSC-VF.ttf")
ap.add_argument("--weight", default="600")
ap.add_argument("--out", default=os.path.join(WEB, "src", "assets", "fonts", "dimensio-serif-600.woff2"))
a = ap.parse_args()

theme = open(os.path.join(WEB, "src", "lib", "theme.ts"), encoding="utf-8").read()
body = re.search(r"export function greeting\(\)[\s\S]*?\n}", theme).group(0)
texts = re.findall(r'return "([^"]+)"', body)
texts += ["连接 dimensio"]  # SetupSheet 标题
always = "".join(chr(c) for c in range(0x20, 0x7F)) + "，。、；：？！「」（）—…·"
chars = sorted(set("".join(texts) + always))
print(f"{len(chars)} glyphs: {''.join(c for c in chars if ord(c) > 0x7F)}")

with tempfile.TemporaryDirectory() as td:
    inst = os.path.join(td, "inst.ttf")
    txt = os.path.join(td, "chars.txt")
    open(txt, "w", encoding="utf-8").write("".join(chars))
    subprocess.check_call([sys.executable, "-m", "fontTools.varLib.instancer", a.src, f"wght={a.weight}", "-o", inst, "-q"])
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    subprocess.check_call([sys.executable, "-m", "fontTools.subset", inst, f"--text-file={txt}",
                           "--flavor=woff2", "--layout-features=kern,liga,locl",
                           "--name-IDs=*", "--name-legacy", "--name-languages=*",
                           f"--output-file={a.out}"])
print(a.out, os.path.getsize(a.out), "bytes")
