// 分享 / 封面图：kit/png/cover.png（1600×900，纸）与 kit/png/cover-dark.png（夜）。截图用本机 Edge 无头模式。
//   node harness/web/brand/cover.mjs
// 构图与 bridge 官网首屏同一个母题：一条贯穿画面、两端渐隐的地平线，组合与标语立在它上面。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COLOR } from "./geometry.mjs";
import { lockupSVG } from "./svg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const TAGLINE = "多家模型，一个工作台。";

// 标语用思源宋体 600，只打这几个字
function serifB64(text) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "dmcover-"));
  try {
    const txt = path.join(td, "t.txt"), inst = path.join(td, "i.ttf"), out = path.join(td, "s.woff2");
    fs.writeFileSync(txt, [...new Set(text)].join(""));
    execFileSync("python", ["-m", "fontTools.varLib.instancer", "C:\\Windows\\Fonts\\NotoSerifSC-VF.ttf", "wght=600", "-o", inst, "-q"]);
    execFileSync("python", ["-m", "fontTools.subset", inst, `--text-file=${txt}`, "--flavor=woff2", `--output-file=${out}`]);
    return fs.readFileSync(out).toString("base64");
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
}
const serif = serifB64(TAGLINE);

for (const [name, bg, ink, rule, sub] of [
  ["cover", COLOR.paper, COLOR.ink, "rgba(23,22,20,.16)", "#48453F"],
  ["cover-dark", COLOR.night, COLOR.ivory, "rgba(238,234,226,.16)", "rgba(238,234,226,.7)"],
]) {
  const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"S";src:url(data:font/woff2;base64,${serif}) format("woff2");font-weight:600}
html,body{margin:0;width:1600px;height:900px;background:${bg};overflow:hidden}
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:54px;padding-bottom:40px}
.c svg{display:block;height:170px;width:auto}
.t{font:600 40px/1.3 "S",serif;color:${sub};letter-spacing:.14em}
.h{position:absolute;left:0;right:0;top:618px;height:1px;background:linear-gradient(90deg,transparent,${rule} 14%,${rule} 86%,transparent)}
</style><div class="h"></div><div class="c">${lockupSVG({ color: ink, height: 170 })}<div class="t">${TAGLINE}</div></div>`;
  const file = path.join(HERE, "kit", `${name}.html`);
  fs.writeFileSync(file, html);
  const url = "file:///" + file.split(path.sep).join("/");
  fs.mkdirSync(path.join(HERE, "kit", "png"), { recursive: true });
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1600,900", `--screenshot=${path.join(HERE, "kit", "png", `${name}.png`)}`, url], { stdio: "ignore" });
  fs.rmSync(file);
  console.log(`kit/png/${name}.png`);
}
