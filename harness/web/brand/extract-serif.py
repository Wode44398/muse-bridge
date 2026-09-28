# 从思源宋体（Noto Serif SC 可变字体，SIL OFL 1.1）按指定字重取出「dimensio」的字形轮廓与字距，
# 输出 JSON：{ weight, upm, xHeight, ascender, word: "dimensio", glyphs: [{ ch, adv, kern, d, bounds }] }
#   d：SVG path（y 轴向下、基线 y=0、字体单位）；kern：与下一个字形之间的 GPOS 字偶距（字体单位）
# 与 bridge 官网字标「bridge」是同一款字、同一字重（官网 site/assets/fonts/bridge-serif-600.woff2）。
#   python brand/extract-serif.py [字重=600] [字体=C:\Windows\Fonts\NotoSerifSC-VF.ttf] > brand/serif-600.json
import json, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

weight = float(sys.argv[1]) if len(sys.argv) > 1 else 600
src = sys.argv[2] if len(sys.argv) > 2 else r"C:\Windows\Fonts\NotoSerifSC-VF.ttf"
WORD = "dimensio"

f = TTFont(src)
inst = instancer.instantiateVariableFont(f, {"wght": weight})
gs = inst.getGlyphSet()
cmap = inst.getBestCmap()
names = [cmap[ord(c)] for c in WORD]

# GPOS 字偶距：只认 PairPos（类型 2，可能包在扩展查找 9 里），格式 1（逐对）与格式 2（按类）
def pair_kern(left, right):
    if "GPOS" not in inst:
        return 0
    gpos = inst["GPOS"].table
    total = 0
    feats = [fr for fr in gpos.FeatureList.FeatureRecord if fr.FeatureTag == "kern"]
    lookups = sorted({i for fr in feats for i in fr.Feature.LookupListIndex})
    for li in lookups:
        lk = gpos.LookupList.Lookup[li]
        for st in lk.SubTable:
            if lk.LookupType == 9:
                st = st.ExtSubTable
            if getattr(st, "LookupType", 2) != 2 and lk.LookupType != 9:
                continue
            cov = st.Coverage.glyphs
            if left not in cov:
                continue
            if st.Format == 1:
                ps = st.PairSet[cov.index(left)]
                for rec in ps.PairValueRecord:
                    if rec.SecondGlyph == right and rec.Value1 is not None:
                        total += getattr(rec.Value1, "XAdvance", 0) or 0
                        break
                else:
                    continue
                break
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs.get(left, 0)
                c2 = st.ClassDef2.classDefs.get(right, 0)
                v = st.Class1Record[c1].Class2Record[c2].Value1
                x = getattr(v, "XAdvance", 0) if v is not None else 0
                if x:
                    total += x
                    break
    return total

def path_of(name):
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))  # 字体 y 向上 → SVG y 向下
    return pen.getCommands()

out = {"weight": weight, "upm": inst["head"].unitsPerEm, "xHeight": inst["OS/2"].sxHeight,
       "word": WORD, "glyphs": []}
for i, (ch, name) in enumerate(zip(WORD, names)):
    bp = BoundsPen(gs)
    gs[name].draw(bp)
    nxt = names[i + 1] if i + 1 < len(names) else None
    out["glyphs"].append({"ch": ch, "adv": inst["hmtx"][name][0], "kern": pair_kern(name, nxt) if nxt else 0,
                          "d": path_of(name), "bounds": bp.bounds})
d_bounds = out["glyphs"][0]["bounds"]
out["ascender"] = d_bounds[3]
print(json.dumps(out))
