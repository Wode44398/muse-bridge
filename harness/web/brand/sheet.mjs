// 生成品牌手册页 brand/kit/dimensio-brand.html（自包含：SVG 全部内联、字体 base64 内嵌）。
//   node harness/web/brand/sheet.mjs            —— 只写 HTML
//   node harness/web/brand/sheet.mjs --png [高]  —— 再用本机 Edge 无头截整页 kit/dimensio-brand.png
// 版式与 bridge 官网同一套：纸底、墨字、宋体标题、左栏章节索引、细线分节，夜色段落做节奏。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COLOR, FINE, MARK, PIXEL, f3, markFine, pt, wordmark } from "./geometry.mjs";
import { appIconSVG, lockupGeometry, lockupSVG, markBody, markSVG, monoMarkSVG, wordmarkSVG } from "./svg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.join(HERE, "..", "src", "assets", "fonts");
const KIT = path.join(HERE, "kit");
const b64 = (f) => fs.readFileSync(path.join(FONTS, f)).toString("base64");
const m = markFine();
const w = wordmark();
const INK = COLOR.ink, PAPER = COLOR.paper, ZHU = COLOR.zhu;
const RULE = "rgba(23,22,20,.16)";
const INK3 = "#6F6B63";

const svg108 = (body, cls = "", vb = "18 18 72 72") => `<svg viewBox="${vb}" class="${cls}" aria-hidden="true">${body}</svg>`;

// ── 01 概念：一根竖线贯穿整圆，转过 90° 躺平成水面 ─────────────────────────────────────
const upright = `rotate(-90 ${FINE.cx} ${FINE.wy})`;
function concept() {
  const turn = `<svg viewBox="0 0 120 120" class="turn" aria-hidden="true">
    <path d="M34 40A34 34 0 0 1 90 78" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M82 76L90 79L93 71" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="60" y="104" text-anchor="middle" class="svgmono">90°</text></svg>`;
  return `<div class="concept">
    <figure>${svg108(markBody(INK, { id: "cu", transform: upright }), "cmark")}<figcaption><b>竖</b>整枚竖着：那根线贯穿整圆、上下都出头——站在另一个维度</figcaption></figure>
    <div class="arrow">${turn}</div>
    <figure>${svg108(markBody(INK, { id: "cd" }), "cmark")}<figcaption><b>月桥</b>以线为轴，三笔一起转过 90°：一道拱横跨水面，倒影在水下补成整圆</figcaption></figure>
  </div>`;
}

// ── 02 构造：108 网格上的标志与它的每一个数 ───────────────────────────────────────────
function construction() {
  const ann = (d) => `<path d="${d}" fill="none" stroke="${INK3}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const tick = (x, y, horizontal) => (horizontal ? ann(`M${x} ${f3(y - 1.4)}V${f3(y + 1.4)}`) : ann(`M${f3(x - 1.4)} ${y}H${f3(x + 1.4)}`));
  const label = (x, y, t, anchor = "start") => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="lab">${t}</text>`;
  const grid = [];
  for (let i = 18; i <= 90; i += 6) grid.push(`M${i} 18V90M18 ${i}H90`);
  const cx = m.cx, cy = m.cy, R = m.R;
  const [rx, ry] = pt(cx, cy, FINE.Ro, -150);
  const a = pt(cx, cy, FINE.Ro, -90);
  const f = pt(cx, cy, FINE.Ro, -8);
  const e = pt(cx, cy, R, 90);
  const x0 = f3(cx - FINE.half), x1 = f3(cx + FINE.half), by = f3(cy + R + 8.5);
  return `<svg viewBox="4 10 112 90" class="cons" aria-hidden="true">
    <path d="${grid.join("")}" stroke="rgba(23,22,20,.07)" stroke-width="1" vector-effect="non-scaling-stroke" fill="none"/>
    <rect x="18" y="18" width="72" height="72" rx="16.1" fill="none" stroke="${RULE}" stroke-width="1" vector-effect="non-scaling-stroke"/>
    <circle cx="54" cy="54" r="33" fill="none" stroke="${RULE}" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    <circle cx="${cx}" cy="${cy}" r="${FINE.Ro}" fill="none" stroke="${ZHU}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="1.5 2.5" vector-effect="non-scaling-stroke"/>
    ${markBody(INK, { id: "kf" })}
    ${ann(`M${cx} ${cy}L${rx} ${ry}`)}<circle cx="${cx}" cy="${cy}" r=".7" fill="${ZHU}"/>
    ${label(f3(cx + 2), f3(cy - 2.5), `R ${FINE.Ro}`)}
    ${ann(`M${a[0]} ${a[1]}L${f3(a[0] + 20)} ${f3(a[1] - 3)}`)}
    ${label(f3(a[0] + 21), f3(a[1] - 3), `拱顶 ${FINE.crown}`)}
    ${ann(`M${f[0]} ${f[1]}L${f3(f[0] + 8)} ${f3(f[1] - 8)}`)}
    ${label(f3(f[0] + 9), f3(f[1] - 8.5), `拱脚 ${FINE.foot}`)}
    ${ann(`M${x0} ${by}H${x1}`)}${tick(x0, by, true)}${tick(x1, by, true)}
    ${label(cx, f3(by + 4.5), `水面 ${FINE.lineMid} → 两头 ${FINE.lineEnd} · 长 ${2 * FINE.half}`, "middle")}
    ${ann(`M${e[0]} ${e[1]}L${f3(e[0] + 18)} ${f3(e[1] + 2)}`)}
    ${label(f3(e[0] + 19), f3(e[1] + 1.5), `倒影 ${FINE.reflMid} → 两头 ${FINE.reflEnd} · 缺口 ${FINE.gap}°`)}
    ${label(f3(e[0] + 19), f3(e[1] + 4.7), `渐隐 ${FINE.r0} → ${FINE.r1}`)}
    ${label(92, 94, "可见窗 72 · 安全圆 ⌀66", "end")}
  </svg>`;
}

// ── 03 字标与组合：整圆撑满字标的升部线到基线 ──────────────────────────────
function lockupGuides() {
  const { mx, my, mw } = lockupGeometry();
  const x0 = mx - 140, x1 = w.box.x + w.box.w + 140;
  const pad = 170;
  const vb = [x0, -w.ascender - pad, x1 - x0, w.ascender + pad * 2].map(f3);
  const line = (y, t) =>
    `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${ZHU}" stroke-opacity=".6" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `<text x="${x1 - 10}" y="${y - 26}" text-anchor="end" class="guide">${t}</text>`;
  const k = w.ascender / m.box.h;
  return `<svg viewBox="${vb.join(" ")}" class="guides" aria-hidden="true">
    ${line(-w.ascender, "升部线")}${line(0, "基线")}${line(-w.xHeight, "x 高")}
    <g transform="translate(${f3(mx)} ${f3(my)}) scale(${f3(k)}) translate(${f3(-m.box.x)} ${f3(-m.box.y)})">${markBody(INK, { id: "gf" })}</g>
    <path d="${w.d}" fill="${INK}"/>
    <text x="${f3(mx + mw + w.xHeight * 0.2)}" y="130" text-anchor="middle" class="guide">↔ 0.4 x</text>
  </svg>`;
}

// ── 04 图标：瓦片各尺寸 + 像素版放大 + 与月桥并排 ─────────────────────────────────────
function icons() {
  const big = (s) => appIconSVG(1024).replace(/width="1024" height="1024"/, `width="${s}" height="${s}"`);
  const tiles = [192, 128, 64, 48].map((s) => `<figure class="tile">${big(s)}<figcaption>${s}</figcaption></figure>`).join("");
  const pixel = Object.keys(PIXEL)
    .map(Number)
    .sort((a, b) => b - a)
    .map(
      (s) =>
        `<figure class="px"><div class="zoom">${appIconSVG(s).replace(`width="${s}" height="${s}"`, `width="${s * 5}" height="${s * 5}" shape-rendering="crispEdges"`)}</div>` +
        `<div class="real">${appIconSVG(s)}</div><figcaption>${s}px</figcaption></figure>`,
    )
    .join("");
  const variants = `<div class="variants">
    <figure><div class="mask">${appIconSVG(1024, { bleed: true }).replace(/width="1024" height="1024"/, 'width="128" height="128"')}</div><figcaption>maskable<br>满幅，标志在安全圆内</figcaption></figure>
    <figure><div class="mono">${monoMarkSVG(128).replace(/#000/g, COLOR.ivory)}</div><figcaption>单色<br>安卓 13 主题图标</figcaption></figure>
  </div>`;
  return { tiles, pixel, variants };
}

// ── 06 动效：出场 + 正在发生（静帧；真动画在 src/lib/mark-motion.ts，弹簧与惯性都在那里）──────────
// 一帧的姿态：rot 整枚转角 · s 整枚缩放 · a / r 一笔绕圆描到哪 · ay / ry 拱 / 倒影以水面为轴的纵向缩放 ·
// lag 倒影慢半拍的角 · len 线长（0 = 还没长出来）· tail 线被甩的尾巴（静帧里用线多出来的一点偏角示意）
function motionFrame(id, fr) {
  const { cx, cy } = m;
  const o = { s: 1, a: 1, r: 1, ay: 1, ry: 1, lag: 0, len: 1, tail: 0, ...fr };
  const dash = (v) => `pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="${f3(100 - 100 * v)}"`;
  const sy = (k) => `translate(0 ${cy}) scale(1 ${k}) translate(0 ${-cy})`;
  return (
    `<defs><linearGradient id="${id}g" x1="0" y1="${m.fade.y1}" x2="0" y2="${m.fade.y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${INK}" stop-opacity="${m.fade.o0}"/><stop offset="1" stop-color="${INK}" stop-opacity="${m.fade.o1}"/></linearGradient>` +
    `<mask id="${id}a" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108"><path d="${m.archMask.d}" fill="none" stroke="#fff" stroke-width="${m.archMask.w}" stroke-linecap="round" ${dash(o.a)}/></mask>` +
    `<mask id="${id}r" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108"><path d="${m.reflMask.d}" fill="none" stroke="#fff" stroke-width="${m.reflMask.w}" stroke-linecap="round" ${dash(o.r)}/></mask></defs>` +
    `<g transform="translate(${cx} ${cy}) rotate(${o.rot}) scale(${o.s}) translate(${-cx} ${-cy})">` +
    (o.ay > 0 ? `<g transform="${sy(o.ay)}"><path d="${m.arch}" fill="${INK}"${o.a < 1 ? ` mask="url(#${id}a)"` : ""}/></g>` : "") +
    (o.ry > 0 && o.r > 0 ? `<g transform="rotate(${-o.lag} ${cx} ${cy}) ${sy(o.ry)}"><path d="${m.refl}" fill="url(#${id}g)"${o.r < 1 ? ` mask="url(#${id}r)"` : ""}/></g>` : "") +
    (o.len > 0 ? `<path d="${m.line}" fill="${INK}" transform="translate(${cx} ${cy}) rotate(${-o.tail}) scale(${o.len} 1) translate(${-cx} ${-cy})"/>` : "") +
    `</g>`
  );
}
const frameStrip = (frames, labels, id) =>
  frames.map((fr, i) => `<figure>${svg108(motionFrame(`${id}${i}`, fr), "frame")}<figcaption>${labels[i]}</figcaption></figure>`).join("");
function introFrames() {
  return frameStrip(
    [
      { rot: -118, s: 0.9, a: 0.85, r: 0, len: 0 },
      { rot: -91, len: 1.07 },
      { rot: -42, s: 0.97, tail: 7, lag: 3 },
      { rot: 0 },
    ],
    ["竖着旋入，一笔绕圆", "线从圆心射出，冲过头再弹回", "蓄一下，三笔一起顺时针转", "落成月桥"],
    "if",
  );
}
function liveFrames() {
  return frameStrip(
    [
      { rot: 0, ay: 0.35, ry: 0.35, len: 1.06 },
      { rot: 70, ay: 0, ry: 0, len: 1.12, tail: 6 },
      { rot: 6, ay: 0.85, ry: 0.4 },
      { rot: 0 },
    ],
    ["月桥沉进水面", "水面线独自转半圈", "月桥重新升起，倒影慢半拍", "落定，静一拍"],
    "lf",
  );
}

// ── 07 用法 ────────────────────────────────────────────────────────────────────────
function rules() {
  const ok = markSVG({ size: 96, pad: 8, id: "r0" });
  const turned = `<svg viewBox="16 18 76 76" width="96" height="96" aria-hidden="true">${markBody(INK, { id: "r1", transform: upright })}</svg>`;
  const solid = markSVG({ size: 96, pad: 8, grad: false, id: "r2" }).replace(`fill-opacity="${FINE.flat}"`, 'fill-opacity="1"');
  const colored = markSVG({ size: 96, pad: 8, color: "#2F6FE0", id: "r3" });
  const squash = markSVG({ size: 96, pad: 8, id: "r4" }).replace("<svg ", '<svg preserveAspectRatio="none" style="width:130px;height:74px" ');
  const cell = (svg, t, yes = false) => `<div class="rule${yes ? " yes" : ""}"><div class="rs">${svg}</div><p>${t}</p></div>`;
  return (
    cell(ok, "原样使用：墨或象牙，倒影渐隐", true) +
    cell(turned, "别竖着用——那只是出场的中间态") +
    cell(solid, "别把倒影画实") +
    cell(colored, "别换颜色：朱只给光点") +
    cell(squash, "别拉伸")
  );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────────
const ic = icons();
const sw = (name, bg, code, sub) =>
  `<div class="sw"><span class="chip" style="background:${bg}"></span><b class="serif">${name}</b><code>${code}</code><span>${sub}</span></div>`;

const body = `
<header class="cover">
  <div class="wrap">
    <p class="kicker"><span class="live"></span>dimensio · 品牌手册</p>
    <div class="cover-in">
      <div>
        <div class="lockup">${lockupSVG({ height: 132 })}</div>
        <h1 class="serif">一道拱，从另一个维度转过来。</h1>
        <p class="lead">dimensio 的标志就是 bridge 的「月桥」：一道拱横跨水面，倒影在水下补成整圆——放大到展示尺寸时细化成有笔势的三笔。「换一个维度」写在它的出场里：整枚先竖着绕出整圆、一根线贯穿圆心，再以这根线为轴一起转过 90°，落成月桥。</p>
      </div>
      <div class="hero-icon">${appIconSVG(1024).replace(/width="1024" height="1024"/, 'width="240" height="240"')}</div>
    </div>
  </div>
  <div class="horizon"></div>
</header>

<main class="wrap">
  <section>
    <div class="idx"><span>01</span>概念</div>
    <div class="sb">
      <h2 class="serif">一根线，转过 90°</h2>
      ${concept()}
      <p class="note">和 bridge 的月桥是同一枚：同一个圆、同一条水面、同一块瓦片；小尺寸完全照搬，展示尺寸多了笔势。那一「转」只在动的时候出现：竖着的是另一个维度，转平了就是此岸与彼岸之间的水面。</p>
    </div>
  </section>

  <section>
    <div class="idx"><span>02</span>构造</div>
    <div class="sb">
      <h2 class="serif">三笔，都在 108 网格上</h2>
      <div class="cons-wrap">${construction()}</div>
      <p class="note">外沿是正圆；拱顶厚 ${FINE.crown}、向两脚收到 ${FINE.foot}，内沿因此比外沿略扁，像宋体的笔势；水面线贯穿圆心，中段 ${FINE.lineMid}、两头收成 ${FINE.lineEnd} 的圆头；倒影的中线对齐拱脚，最低处 ${FINE.reflMid}、两端收到 ${FINE.reflEnd}，离开水面 ${FINE.gap}°，从水面往下由 ${FINE.r0} 渐隐到 ${FINE.r1}。这是展示尺寸的精绘版；40px 以下的界面里用月桥原样的等宽笔画（拱 ${MARK.arch} / 水面 ${MARK.line} / 倒影 ${MARK.refl}），32px 以下的图标逐像素重画。</p>
    </div>
  </section>

  <section>
    <div class="idx"><span>03</span>字标</div>
    <div class="sb">
      <h2 class="serif">思源宋体 600</h2>
      <div class="word">${wordmarkSVG({ height: 120 })}</div>
      <p class="note">字标用思源宋体（Noto Serif SC，SIL OFL）600——与 bridge 官网的字标「bridge」同一款字、同一字重。轮廓已转成路径，不依赖字体安装。</p>
      <h3 class="serif">组合</h3>
      <div class="guides-wrap">${lockupGuides()}</div>
      <p class="note">标志与字标并排时，拱的外沿顶对齐字标 d 的升部线，倒影的外沿底落在基线上：整圆正好撑满升部线到基线。间距 0.4 个 x 高。</p>
    </div>
  </section>
</main>

<div class="night">
  <div class="wrap">
    <div class="nin">
      <div class="idx"><span>04</span>图标</div>
      <div class="sb">
        <h2 class="serif">与月桥同一块瓦片</h2>
        <p class="note">暖墨瓦片 ${COLOR.tile[0]} → ${COLOR.tile[1]}（上亮下暗）、圆角 22.37%、内缘一道 8% 白细线、象牙 ${COLOR.ivory} 的标志——与 bridge 图标一模一样的底子。</p>
        <div class="tiles">${ic.tiles}</div>
        <div class="row2">${ic.variants}</div>
        <h3 class="serif">小尺寸逐像素重画</h3>
        <p class="note">16 / 20 / 24 / 32 不是缩小的矢量，而是在像素网格上重新摆的笔画：水面线落在整像素行上、拱的粗细取整。上为放大 5 倍，下为实际大小。</p>
        <div class="pixels">${ic.pixel}</div>
      </div>
    </div>
  </div>
</div>

<main class="wrap">
  <section>
    <div class="idx"><span>05</span>色板</div>
    <div class="sb">
      <h2 class="serif">纸、墨，一抹朱</h2>
      <div class="sws">
        ${sw("纸", COLOR.paper, COLOR.paper, "浅色画布")}
        ${sw("墨", COLOR.ink, COLOR.ink, "字标、标志、正文")}
        ${sw("朱", COLOR.zhu, COLOR.zhu, "只给「正在发生」")}
        ${sw("夜", COLOR.night, COLOR.night, "深色画布")}
        ${sw("象牙", COLOR.ivory, COLOR.ivory, "深底上的标志")}
        ${sw("瓦片", `linear-gradient(${COLOR.tile[0]},${COLOR.tile[1]})`, `${COLOR.tile[0]} → ${COLOR.tile[1]}`, "图标底")}
      </div>
      <p class="note">与 bridge 官网同一张纸、同一块墨。界面里的层次靠纸色深浅与细线，不靠彩色；强调就是墨本身。唯一的彩色是一抹朱，只留给正在发生的东西：在跑的光点、实时节点、倒计时、键盘焦点。</p>
    </div>
  </section>

  <section>
    <div class="idx"><span>06</span>动效</div>
    <div class="sb">
      <h2 class="serif">绕圆、贯穿、转平；沉下、翻转、升起</h2>
      <div class="frames">${introFrames()}</div>
      <p class="note">出场以水面线为参照：整枚标志竖着（拱在左、倒影在右）由小旋入，同时圆笔头一笔绕出整圆；笔快收尾时线从圆心往两头射出——跑得快时细、停下变粗，冲过头再弹回，穿过圆环时把圆环顶得一颤；往回蓄一下，三笔一起顺时针转过 90° 落成月桥——转起来整枚微微收紧，线两头被甩成浅 S、倒影慢半拍，落定带一点回摆。动作彼此交叠，不排队。</p>
      <div class="frames">${liveFrames()}</div>
      <p class="note">正在发生：月桥沉进水面（拱与倒影一起压扁进那根线，线吃进了墨、变长变粗）；水面线独自顺时针转半圈，两头甩成 S；月桥从水面重新升起，拱先、倒影慢半拍，冲过头再回落；静一拍，一周 2.2 秒。线中心对称，转半圈与原样重合，所以每一周升起的都是正着的月桥。一屏几处同时在跑时同一口气；停下时从当前姿态弹回静止，不瞬断。只用墨，不上朱。</p>
    </div>
  </section>

  <section>
    <div class="idx"><span>07</span>用法</div>
    <div class="sb">
      <h2 class="serif">留白与禁忌</h2>
      <p class="note">四周至少留出两个拱的笔画宽。标志最小 16px（用像素版），字标最小高 12px。</p>
      <div class="rules">${rules()}</div>
    </div>
  </section>
</main>

<footer class="wrap foot"><span>dimensio · 品牌手册</span><span>几何源 harness/web/brand/geometry.mjs · 重出 node harness/web/brand/build.mjs</span></footer>
`;

// 宋体只打标题里用到的字（整套 CJK 十几 MB）
function serifSubsetB64(text) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "dmsheet-"));
  try {
    const txt = path.join(td, "t.txt");
    const inst = path.join(td, "i.ttf");
    const out = path.join(td, "s.woff2");
    fs.writeFileSync(txt, [...new Set(text + " 0123456789·—°：，。、「」")].join(""));
    execFileSync("python", ["-m", "fontTools.varLib.instancer", "C:\\Windows\\Fonts\\NotoSerifSC-VF.ttf", "wght=600", "-o", inst, "-q"]);
    execFileSync("python", ["-m", "fontTools.subset", inst, `--text-file=${txt}`, "--flavor=woff2", `--output-file=${out}`]);
    return fs.readFileSync(out).toString("base64");
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
}
const serifText = [...body.matchAll(/class="serif">([^<]+)</g)].map((x) => x[1]).join("") + "月桥dimensio";

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dimensio · 品牌手册</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@font-face{font-family:"Brand Serif";src:url(data:font/woff2;base64,${serifSubsetB64(serifText)}) format("woff2");font-weight:600}
@font-face{font-family:"Dimensio Sans";src:url(data:font/woff2;base64,${b64("dimensio-sans-var.woff2")}) format("woff2");font-weight:100 900}
@font-face{font-family:"Dimensio Mono";src:url(data:font/woff2;base64,${b64("dimensio-mono-var.woff2")}) format("woff2");font-weight:100 800}
:root{--paper:${PAPER};--ink:${INK};--ink2:#48453F;--ink3:${INK3};--rule:${RULE};--rule2:rgba(23,22,20,.09);--zhu:${ZHU};--night:${COLOR.night};
--serif:"Brand Serif","Noto Serif SC","Songti SC",serif;--sans:"Dimensio Sans",system-ui,"PingFang SC","Microsoft YaHei UI",sans-serif;--mono:"Dimensio Mono",ui-monospace,Consolas,"Microsoft YaHei UI",monospace}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--paper);color:var(--ink);font:400 15px/1.8 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:0 64px}
.serif{font-family:var(--serif);font-weight:600;letter-spacing:.01em}
h1,h2,h3,p,figure{margin:0}
.kicker{display:flex;align-items:center;gap:10px;font:400 13px/1 var(--mono);letter-spacing:.06em;color:var(--ink3)}
.live{width:7px;height:7px;border-radius:50%;background:var(--zhu)}
.cover{position:relative;padding:72px 0 88px}
.cover-in{display:grid;grid-template-columns:1fr auto;gap:64px;align-items:end;margin-top:64px}
.lockup svg{display:block;height:132px;width:auto}
.cover h1{margin-top:56px;font-size:54px;line-height:1.2}
.lead{margin-top:22px;max-width:36em;font-size:17px;line-height:1.9;color:var(--ink2)}
.hero-icon svg{display:block;filter:drop-shadow(0 18px 30px rgba(23,22,20,.28))}
.horizon{position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--rule) 12%,var(--rule) 88%,transparent)}
section{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,9fr);column-gap:28px;padding:44px 0 64px;border-top:1px solid var(--rule)}
main section:first-child{border-top:0}
.idx{display:flex;align-items:baseline;gap:12px;font:400 13px/1.6 var(--mono);color:var(--ink3);letter-spacing:.06em}
.idx span{color:var(--ink);font-weight:600}
.sb h2{font-size:34px;line-height:1.3}
.sb h3{margin-top:40px;font-size:22px}
.note{margin-top:22px;max-width:40em;color:var(--ink2);font-size:15.5px}
.concept{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:24px;margin-top:36px}
.concept figure{display:flex;flex-direction:column;align-items:center;gap:16px}
.cmark{width:220px;height:220px}
.concept figcaption{max-width:17em;text-align:center;font-size:14px;line-height:1.7;color:var(--ink3)}
.concept figcaption b{display:block;font:600 20px/1.4 var(--serif);color:var(--ink);margin-bottom:4px}
.turn{width:120px;height:120px}.svgmono{font:400 10px var(--mono);fill:var(--ink3)}
.cons-wrap{margin-top:32px}.cons{display:block;width:100%;max-width:760px;height:auto}
.cons .lab{font:400 2.2px var(--mono);fill:var(--ink2)}
.word{margin-top:36px}.word svg{display:block;height:120px;width:auto}
.guides-wrap{margin-top:24px}.guides{display:block;width:100%;max-width:820px;height:auto}
.guides .guide{font:400 78px var(--mono);fill:var(--ink3)}
.night{background:var(--night);color:#EEEAE2}
.night .nin{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,9fr);column-gap:28px;padding:56px 0 72px}
.night .idx{color:rgba(238,234,226,.52)}.night .idx span{color:#EEEAE2}
.night .note{color:rgba(238,234,226,.72)}
.tiles{display:flex;align-items:flex-end;gap:36px;margin-top:36px}
.tiles figure,.pair figure,.variants figure,.px{display:flex;flex-direction:column;align-items:center;gap:12px}
figcaption{font:400 12px/1.5 var(--mono);color:rgba(238,234,226,.55);text-align:center}
main figcaption{color:var(--ink3)}
.tile svg{display:block}
.row2{display:flex;gap:64px;margin-top:44px;align-items:flex-start}
.pair{display:flex;gap:24px;padding:22px;border-radius:22px;background:rgba(238,234,226,.05);box-shadow:inset 0 0 0 1px rgba(238,234,226,.08)}
.variants{display:flex;gap:36px}
.mask svg{display:block;border-radius:50%}
.mono{width:128px;height:128px;border-radius:30px;background:#2A3A4C;display:grid;place-items:center}.mono svg{width:128px;height:128px}
.pixels{display:flex;align-items:flex-end;gap:40px;margin-top:28px}
.zoom svg{display:block;image-rendering:pixelated}
.real{margin-top:4px}.real svg{display:block}
.sws{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 28px;margin-top:32px}
.sw{display:grid;grid-template-columns:56px 1fr;grid-template-rows:auto auto auto;column-gap:16px;align-items:center}
.sw .chip{grid-row:1/4;width:56px;height:56px;border-radius:14px;box-shadow:inset 0 0 0 1px var(--rule2)}
.sw b{font-size:17px;line-height:1.3}.sw code{font:400 12px/1.5 var(--mono);color:var(--ink2)}.sw span:last-child{font-size:13px;color:var(--ink3)}
.frames{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin-top:32px}
.frames figure{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 10px 14px;border-radius:18px;background:#FBFAF6;box-shadow:inset 0 0 0 1px var(--rule2)}
.frame{width:140px;height:140px}
.rules{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-top:28px}
.rule{display:flex;flex-direction:column;align-items:center;gap:12px}
.rs{position:relative;display:grid;place-items:center;width:100%;height:150px;border-radius:18px;background:#FBFAF6;box-shadow:inset 0 0 0 1px var(--rule2)}
.rule:not(.yes) .rs::after{content:"";position:absolute;left:14px;right:14px;top:50%;height:1.5px;background:var(--zhu);transform:rotate(-20deg);opacity:.85}
.rule p{font-size:13px;line-height:1.6;color:var(--ink2);text-align:center}
.foot{display:flex;justify-content:space-between;padding-top:22px;padding-bottom:40px;border-top:1px solid var(--rule);font:400 12px/1.6 var(--mono);color:var(--ink3)}
</style></head><body>${body}</body></html>`;

fs.mkdirSync(KIT, { recursive: true });
const file = path.join(KIT, "dimensio-brand.html");
fs.writeFileSync(file, html);
console.log("kit/dimensio-brand.html", Math.round(html.length / 1024) + "KB");

// --png [高度]：本机 Edge 无头按给定高度截整页（高度先在浏览器里量 document 高度）
if (process.argv.includes("--png")) {
  const i = process.argv.indexOf("--png");
  const h = Number(process.argv[i + 1]) || 5600;
  const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const out = path.join(KIT, "dimensio-brand.png");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=1440,${h}`, `--screenshot=${out}`, "file:///" + file.split(path.sep).join("/")], { stdio: "ignore" });
  console.log("kit/dimensio-brand.png");
}
