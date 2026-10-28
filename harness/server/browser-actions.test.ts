// 2026-10-28 浏览器工具对齐 bridge（src/runtime/browser-actions.mjs + browser-verify.mjs）：
//
// 修前：click / type / key 一律回「Clicked …」——点到视口外、点在空白处、没聚焦就打字都报成功，模型只能每步截图核对；
// 没有 expect / wait_for / batch；没有 find / set_value / page_text / upload / reload / 长按 / 拖拽 / 双指；原生 alert
// 一弹整个页面卡死；截图在 DPR ≠ 1 或宽视口下与点击坐标对不上；页面新开的标签不跟过去。
// 修后：动作前查落点与遮挡、动作后等安定并比对（地址 / 焦点 / 控件状态 / DOM / 滚动 / 请求），什么都没变明说；
// expect / batch / wait_for；截图记坐标帧、x,y 按图换算；对话框自动应答并回报；新标签自动切过去。
//
// 真起本机 Chrome/Edge 打本地靶页（Windows 以外或没装浏览器就跳过）。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeAllBrowserSessions } from "./cdp.ts";
import { findBrowser } from "./headless.ts";
import { Sandbox } from "./sandbox.ts";
import { browserTool, modifierBits } from "./tools/browser.ts";
import { readPageTool } from "./tools/readpage.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const skip = process.platform !== "win32" || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false;

const ctx: ToolContext = {
  sandbox: new Sandbox(os.tmpdir(), "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
  agentSeesImages: true,
};

const PAGE = `<!doctype html><meta name=viewport content="width=device-width"><title>target</title>
<style>body{font:16px sans-serif;margin:0;padding:20px}button{margin:4px;padding:8px}#box{height:120px;overflow:auto;border:1px solid;margin-top:40px}#box div{height:600px}.spacer{height:2000px}
#mark{position:absolute;left:0;top:900px;width:200px;height:60px;background:rgb(255,0,0)}</style>
<button id=toggle aria-expanded=false onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true');document.getElementById('panel').hidden=!document.getElementById('panel').hidden">Menu</button>
<div id=panel hidden>menu content</div>
<button id=noop>Do nothing</button>
<label><input type=checkbox id=cb> Agree</label>
<input id=q placeholder=Search maxlength=5>
<button id=late onclick="setTimeout(()=>{document.getElementById('msg').textContent='Saved OK'},700)">Save</button>
<div id=msg></div>
<button id=api onclick="fetch('/api/x',{method:'POST'}).then(r=>r.json()).then(j=>document.getElementById('msg').textContent=j.ok)">Call API</button>
<button id=al onclick="alert('hello from alert');document.getElementById('msg').textContent='after alert'">Alert me</button>
<button id=cf onclick="document.getElementById('msg').textContent=confirm('really delete?')?'confirmed':'cancelled'">Confirm me</button>
<a id=pop href="/page2" target=_blank>Open popup</a>
<select id=sel><option value=1>One</option><option value=2>Two</option></select>
<input type=date id=dt>
<input type=file id=fi>
<div id=src role=button aria-label="drag me" draggable=true ondragstart="event.dataTransfer.setData('text/plain','payload')" style="width:80px;height:30px;background:#ccc">drag me</div>
<div id=dst role=button aria-label="drop here" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.getElementById('msg').textContent='dropped '+event.dataTransfer.getData('text/plain')" style="width:120px;height:40px;border:2px dashed">drop here</div>
<button id=hold onmousedown="window.__d=performance.now()" onmouseup="document.getElementById('msg').textContent='held '+Math.round(performance.now()-window.__d)">Hold</button>
<button id=tap onclick="document.getElementById('msg').textContent='tapped '+(window.__touched?'touch':'mouse')" ontouchstart="window.__touched=true">Tap</button>
<div id=box><div>inner scroll</div></div>
<div id=mark></div>
<div class=spacer></div>`;

const server = http.createServer((req, res) => {
  if (req.url === "/api/x") {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":"api answered"}');
    }, 300);
    return;
  }
  if (req.url === "/page2") {
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end("<title>second</title><h1>second page</h1>");
    return;
  }
  if (req.url === "/slow") {
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end('<title>slow</title><div id=r></div><script>setTimeout(()=>{r.textContent="rendered"},900)</script>');
    return;
  }
  if (req.url === "/404") {
    res.statusCode = 404;
    res.end("nope");
    return;
  }
  if (req.url === "/wide") {
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(
      '<title>wide</title><style>body{margin:0}</style><button id=far style="position:absolute;left:1800px;top:40px;width:120px;height:40px" onclick="this.textContent=\'hit\'">far</button>',
    );
    return;
  }
  res.setHeader("content-type", "text/html;charset=utf-8");
  res.end(PAGE);
});

const textOf = (r: ToolRunResult) => r.content.map((b) => ("text" in b ? b.text : "")).join("\n");
async function B(args: Record<string, unknown>): Promise<{ r: ToolRunResult; t: string }> {
  const r = await browserTool.run(args, ctx);
  return { r, t: textOf(r) };
}
function refOf(text: string, word: string): number {
  const line = text.split("\n").find((l) => l.includes(word) && /\[ref\d+\]/.test(l));
  assert.ok(line, `find 结果里没有带 ref 的「${word}」：\n${text}`);
  return Number(/\[ref(\d+)\]/.exec(line!)![1]);
}

test("modifierBits：组合键解析、认不出的给 null", () => {
  assert.equal(modifierBits(undefined), 0);
  assert.equal(modifierBits("ctrl"), 2);
  assert.equal(modifierBits("ctrl+shift"), 10);
  assert.equal(modifierBits("Meta Alt"), 5);
  assert.equal(modifierBits("hyper"), null);
});

test("浏览器动作结果确认 / expect / batch / 表单 / 上传 / 对话框 / 新标签 / 手势 / 截图坐标帧", { skip, timeout: 240_000 }, async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-upload-")), "hello.txt");
  fs.writeFileSync(upload, "hi");
  try {
    // —— 导航：等安定、报加载结果、报有没有人在看 ——
    let x = await B({ action: "navigate", url: base + "/" });
    assert.ok(x.r.ok, x.t);
    assert.match(x.t, /\(\d+\.\d s/);
    assert.match(x.t, /Nobody is watching the Browser panel/);
    x = await B({ action: "navigate", url: base + "/slow", expect: { text: "rendered" } });
    assert.match(x.t, /✓ Expectation met/);
    x = await B({ action: "navigate", url: base + "/404" });
    assert.match(x.t, /answered 404/);
    await B({ action: "navigate", url: base + "/" });

    // —— 截图坐标帧：1280 宽是 1:1 ——
    x = await B({ action: "screenshot" });
    assert.match(x.t, /Image pixels = CSS pixels/);

    // —— 点击确认 ——
    x = await B({ action: "click", x: 99999, y: 99999 });
    assert.equal(x.r.ok, false);
    assert.match(x.t, /outside/);
    x = await B({ action: "click", x: 900, y: 140 });
    assert.match(x.t, /⚠ Nothing on the page changed/);
    x = await B({ action: "type", text: "hello" });
    assert.equal(x.r.ok, false, x.t);
    assert.match(x.t, /not editable/);
    x = await B({ action: "click", text: "Menu" });
    assert.match(x.t, /expanded "false"→"true"|expanded no→yes/);
    x = await B({ action: "click", text: "Do nothing" });
    assert.match(x.t, /⚠ Nothing on the page changed/);
    x = await B({ action: "find", text: "Agree" });
    const cb = refOf(x.t, "Agree");
    x = await B({ action: "click", ref: cb });
    assert.match(x.t, /checked no→yes/);

    // —— 输入回读 / batch / expect ——
    x = await B({ action: "type", selector: "#q", text: "abcdefgh" });
    assert.match(x.t, /not in the field/);
    x = await B({ action: "batch", actions: [{ action: "key", key: "ctrl+a" }, { action: "type", text: "xy", expect: { value: "xy" } }] });
    assert.ok(x.r.ok, x.t);
    assert.match(x.t, /✓ Expectation met/);
    x = await B({ action: "click", text: "Save", expect: { text: "Saved OK" } });
    assert.match(x.t, /✓ Expectation met/);
    x = await B({ action: "click", text: "Do nothing", expect: { text: "never there" }, expect_timeout_ms: 500 });
    assert.equal(x.r.ok, false);
    assert.match(x.t, /✗ Expectation not met/);
    x = await B({ action: "batch", actions: [{ action: "click", text: "Do nothing", expect: { text: "nope" }, expect_timeout_ms: 300 }, { action: "click", text: "Menu" }] });
    assert.equal(x.r.ok, false);
    assert.match(x.t, /remaining 1 step/);
    x = await B({ action: "click", text: "Call API", expect: { text: "api answered" } });
    assert.match(x.t, /POST \/api\/x/);

    // —— 遮挡：ref 被盖住就拒绝，force 硬点 ——
    x = await B({ action: "find", text: "Do nothing" });
    const noop = refOf(x.t, "Do nothing");
    await B({ action: "wait_for", ms: 10 });
    const s = (await import("./cdp.ts")).existingSharedBrowser()!;
    await s.eval("document.body.appendChild(Object.assign(document.createElement('div'),{id:'ov'})).style.cssText='position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.3)';1");
    x = await B({ action: "click", ref: noop });
    assert.equal(x.r.ok, false);
    assert.match(x.t, /covered by/);
    x = await B({ action: "click", ref: noop, force: true });
    assert.match(x.t, /clicked anyway with force/);
    await s.eval("document.getElementById('ov').remove();1");

    // —— 滚动：页面与内层滚动区 ——
    x = await B({ action: "scroll", dy: 400, x: 1000, y: 30 });
    assert.match(x.t, /page scrolled 0→400/);
    await B({ action: "scroll", dy: -400, x: 1000, y: 30 });
    x = await B({ action: "find", text: "inner scroll" });
    await s.eval("document.getElementById('box').scrollIntoView({block:'center'});1");
    const box = await s.eval("(()=>{const r=document.getElementById('box').getBoundingClientRect();return {x:r.left+20,y:r.top+20}})()");
    x = await B({ action: "scroll", dy: 200, x: Math.round(box.x), y: Math.round(box.y) });
    assert.match(x.t, /inner scroll area/);

    // —— 表单：set_value / page_text / upload ——
    x = await B({ action: "set_value", selector: "#sel", value: "Two" });
    assert.ok(x.r.ok, x.t);
    assert.match(x.t, /now "Two"/);
    x = await B({ action: "set_value", selector: "#dt", value: "2026-10-28" });
    assert.match(x.t, /now "2026-10-28"/);
    x = await B({ action: "set_value", selector: "#sel", value: "Seven" });
    assert.equal(x.r.ok, false);
    assert.match(x.t, /Options: One/);
    x = await B({ action: "page_text" });
    assert.match(x.t, /menu content/);
    assert.match(x.t, /Untrusted web content/);
    x = await B({ action: "upload", files: [upload], selector: "#fi" });
    assert.ok(x.r.ok, x.t);
    assert.match(x.t, /hello\.txt/);
    assert.equal(await s.eval("document.getElementById('fi').files[0].name"), "hello.txt");

    // —— 原生对话框：自动应答、回报 ——
    x = await B({ action: "click", text: "Alert me", expect: { text: "after alert" } });
    assert.ok(x.r.ok, x.t);
    assert.match(x.t, /native dialog\(s\): alert "hello from alert" \(auto-accepted\)/);
    x = await B({ action: "click", text: "Confirm me", expect: { text: "cancelled" } });
    assert.match(x.t, /auto-dismissed/);

    // —— 拖拽（HTML5）/ 长按（鼠标档）——
    x = await B({ action: "find", text: "drag me" });
    const src = refOf(x.t, "drag me");
    x = await B({ action: "find", text: "drop here" });
    const dst = refOf(x.t, "drop here");
    x = await B({ action: "drag", ref: src, to_ref: dst, expect: { text: "dropped payload" } });
    assert.ok(x.r.ok, x.t);
    assert.match(x.t, /HTML5 drag-and-drop/);
    x = await B({ action: "find", text: "Hold" });
    x = await B({ action: "long_press", ref: refOf(x.t, "Hold"), ms: 700 });
    const held = Number(String(await s.eval("document.getElementById('msg').textContent")).replace(/\D/g, ""));
    assert.ok(held >= 650, `long_press 只按了 ${held}ms`);

    // —— 页面新开的标签：自动切过去、结果尾巴标 [tab i/N] ——
    x = await B({ action: "click", text: "Open popup" });
    assert.match(x.t, /OPENED A NEW TAB/);
    assert.match(x.t, /\[tab 2\/2\]/);
    x = await B({ action: "page_text" });
    assert.match(x.t, /second page/);
    await B({ action: "tab_close" });

    // —— 触屏档：点击改发真触摸、不死锁；pinch 可用 ——
    x = await B({ action: "resize", preset: "mobile" });
    assert.match(x.t, /touch device/);
    await B({ action: "reload" });
    x = await B({ action: "click", text: "Tap", expect: { text: "tapped touch" } });
    assert.ok(x.r.ok, x.t);
    x = await B({ action: "pinch", scale: 1.5 });
    assert.ok(x.r.ok, x.t);
    await B({ action: "resize", preset: "desktop" });

    // —— 宽视口：截图缩到 1568 并记帧，x,y 按图换算 ——
    await B({ action: "resize", width: 2000, height: 900 });
    await B({ action: "navigate", url: base + "/wide" });
    x = await B({ action: "screenshot" });
    assert.match(x.t, /scaled ×0\.784/);
    const img = x.r.feedback?.find((b) => b.t === "image") as { data: string };
    const png = Buffer.from(img.data, "base64");
    assert.equal(png.readUInt32BE(16), 1568);
    const k = 2000 / 1568;
    x = await B({ action: "click", x: Math.round(1860 / k), y: Math.round(60 / k) });
    assert.match(x.t, /far/);
    assert.equal(await s.eval("document.getElementById('far').textContent"), "hit");

    // —— 宽视口 + 已滚动：整屏截图截的是视口而不是文档顶部 ——
    await B({ action: "navigate", url: base + "/" });
    await s.eval("scrollTo(0, 860);1");
    x = await B({ action: "screenshot", waitMs: 0 });
    const shot = Buffer.from((x.r.feedback?.find((b) => b.t === "image") as { data: string }).data, "base64");
    const SHARP = "sharp";
    const sharp = ((await import(SHARP)) as { default: (b: Buffer) => any }).default;
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    // #mark 在文档 y=900..960、x=0..200 → 视口 y=40..100 → 图上 y≈31..78
    const at = (px: number, py: number) => {
      const i = (py * info.width + px) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const [rr, gg, bb] = at(Math.round(100 / k), Math.round(70 / k));
    assert.ok(rr > 200 && gg < 60 && bb < 60, `滚动后整屏截图那一处应是红色 #mark，实际 ${rr},${gg},${bb}`);
    await B({ action: "resize", preset: "desktop" });

    // —— ReadPage(ref) 只看子树 ——
    await B({ action: "navigate", url: base + "/" });
    const full = await readPageTool.run({}, ctx);
    const menuRef = refOf(textOf(full), "Menu");
    const sub = await readPageTool.run({ ref: menuRef }, ctx);
    assert.match(textOf(sub), /only ref\d+'s subtree/);
    assert.ok(!textOf(sub).includes("Agree"), "子树里不该有别的控件");
  } finally {
    closeAllBrowserSessions();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
