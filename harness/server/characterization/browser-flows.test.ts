// 浏览器驱动（cdp.ts）的特征基准：拆分前后，Browser / ReadPage / Eval / Network 四个工具打本地靶页的结果、
// CdpSession 的订阅事件（标签、视口、指针）、浏览器池与挂载状态逐字不变。真起本机 Chrome/Edge 的无头实例（不开窗口），
// 与 browser-actions.test.ts 同一个办法；没有浏览器的机器跳过。截图只记尺寸，不记像素。
//
// 不进 npm test。跑法与重新生成见 session-flows.test.ts 开头。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { browserIsolated, browserMode, browserMount, closeAllBrowserSessions, closeBrowser, existingBrowser, getBrowser, liveBrowserCount, onBrowserMount, setBrowserIsolated } from "../cdp.ts";
import { findBrowser } from "../headless.ts";
import { Sandbox } from "../sandbox.ts";
import { browserTool } from "../tools/browser.ts";
import { evalTool } from "../tools/evaljs.ts";
import { networkTool } from "../tools/network.ts";
import { readPageTool } from "../tools/readpage.ts";
import type { Tool, ToolContext, ToolRunResult } from "../tools/types.ts";
import { baselineStore, Normalizer } from "./normalize.ts";

const skip = process.platform !== "win32" || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false;
const store = baselineStore(path.join(import.meta.dirname, "browser-flows.baseline.json"), {
  update: process.env.UPDATE_CHAR_BASELINE === "1",
  actualDir: process.env.CHAR_ACTUAL_DIR,
});
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-browser-"));
fs.writeFileSync(path.join(tmpRoot, "up.txt"), "upload me\n");

const PAGE = `<!doctype html><meta name=viewport content="width=device-width"><title>target</title>
<style>body{font:16px sans-serif;margin:0;padding:20px}button{margin:4px;padding:8px}#box{height:120px;overflow:auto;border:1px solid;margin-top:40px}#box div{height:600px}.spacer{height:2000px}</style>
<h1>Char page</h1>
<button id=toggle aria-expanded=false onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true');document.getElementById('panel').hidden=!document.getElementById('panel').hidden">Menu</button>
<div id=panel hidden>menu content</div>
<label><input type=checkbox id=cb> Agree</label>
<input id=q placeholder=Search maxlength=5>
<button id=late onclick="setTimeout(()=>{document.getElementById('msg').textContent='Saved OK'},300)">Save</button>
<div id=msg></div>
<button id=api onclick="fetch('/api/x',{method:'POST'}).then(r=>r.json()).then(j=>document.getElementById('msg').textContent=j.ok)">Call API</button>
<button id=al onclick="alert('hello from alert');document.getElementById('msg').textContent='after alert'">Alert me</button>
<button id=cf onclick="document.getElementById('msg').textContent=confirm('really delete?')?'confirmed':'cancelled'">Confirm me</button>
<button id=log onclick="console.log('char-console-line');console.warn('char-warn')">Log</button>
<a id=pop href="/page2" target=_blank>Open popup</a>
<a id=next href="/page2">Next page</a>
<select id=sel><option value=1>One</option><option value=2>Two</option></select>
<input type=file id=fi>
<div id=src role=button aria-label="drag me" draggable=true ondragstart="event.dataTransfer.setData('text/plain','payload')" style="width:80px;height:30px;background:#ccc">drag me</div>
<div id=dst role=button aria-label="drop here" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.getElementById('msg').textContent='dropped '+event.dataTransfer.getData('text/plain')" style="width:120px;height:40px;border:2px dashed">drop here</div>
<button id=tap onclick="document.getElementById('msg').textContent='tapped '+(window.__touched?'touch':'mouse')" ontouchstart="window.__touched=true">Tap</button>
<div id=box><div>inner scroll</div></div>
<div class=spacer></div>`;

const server = http.createServer((req, res) => {
  if (req.url === "/api/x") {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":"api answered"}');
    return;
  }
  if (req.url === "/page2") {
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end("<title>second</title><h1>second page</h1>");
    return;
  }
  if (req.url === "/404") {
    res.statusCode = 404;
    res.end("nope");
    return;
  }
  res.setHeader("content-type", "text/html;charset=utf-8");
  res.end(PAGE);
});
const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(async () => {
  store.flush();
  closeAllBrowserSessions();
  server.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

const OWNER = "char-browser-owner";
const ctx = (ownerId: string): ToolContext => ({
  sandbox: new Sandbox(tmpRoot, "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
  agentSeesImages: true,
  ownerId,
});

// 每次运行都会变的：靶站端口、标签 / 目标 id、请求 id、耗时、图像数据
function norm(base: string): Normalizer {
  const host = base.replace(/^http:\/\//, "");
  return new Normalizer([
    [new RegExp(base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "g"), "<base>"],
    [new RegExp(host.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "g"), "<host>"],
    [/\b[0-9A-F]{32}\b/g, "<target>"],
    [/\[\d+\.\d+\]/g, "[<req>]"],
    [/\b\d+\.\d+\b(?= ?ms\b)/g, "<t>"],
    [/\b\d+ ?ms\b/g, "<n>ms"],
    [/\b\d+(\.\d+)?s\b/g, "<n>s"],
  ]);
}
const shown = (r: ToolRunResult) => ({
  ok: r.ok,
  summary: r.summary,
  content: (r.content ?? []).map((b) => (b.t === "image" ? { t: "image", mime: (b as { mime?: string }).mime ?? null } : b)),
  ...(r.verification ? { verification: r.verification } : {}),
});

test("BR01 工具层：导航、快照、点击、输入、填值、拖拽、对话框、控制台、网络、新标签、视口、触屏、截图、历史", { skip, timeout: 240_000 }, async () => {
  await ready;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const n = norm(base);
  const steps: unknown[] = [];
  const c = ctx(OWNER);
  const run = async (label: string, tool: Tool, args: Record<string, unknown>) => {
    const r = await tool.run(args, c);
    steps.push({ label, tool: tool.def.name, args: n.value(args), result: n.value(shown(r)) });
    return r;
  };
  const textOf = (r: ToolRunResult) => (r.content ?? []).map((b) => ("text" in b ? b.text : "")).join("\n");
  const refOf = (r: ToolRunResult, word: string) => {
    const line = textOf(r).split("\n").find((l) => l.includes(word) && /\[ref\d+\]/.test(l));
    return line ? Number(/\[ref(\d+)\]/.exec(line)![1]) : -1;
  };

  await run("navigate", browserTool, { action: "navigate", url: base + "/" });
  await run("navigate-404", browserTool, { action: "navigate", url: base + "/404" });
  await run("navigate-back-home", browserTool, { action: "navigate", url: base + "/" });
  await run("readpage-all", readPageTool, {});
  await run("readpage-interactive", readPageTool, { filter: "interactive" });
  await run("readpage-query", readPageTool, { query: "Agree" });
  const find = await run("find-agree", browserTool, { action: "find", text: "Agree" });
  await run("click-ref", browserTool, { action: "click", ref: refOf(find, "Agree") });
  await run("click-text", browserTool, { action: "click", text: "Menu" });
  await run("type-selector", browserTool, { action: "type", selector: "#q", text: "abcdefgh" });
  await run("key-batch", browserTool, { action: "batch", actions: [{ action: "key", key: "ctrl+a" }, { action: "key", key: "Backspace" }] });
  await run("click-expect", browserTool, { action: "click", text: "Save", expect: { text: "Saved OK" } });
  await run("click-api", browserTool, { action: "click", text: "Call API", expect: { text: "api answered" } });
  await run("set-value", browserTool, { action: "set_value", selector: "#sel", value: "Two" });
  await run("set-value-bad", browserTool, { action: "set_value", selector: "#sel", value: "Seven" });
  await run("upload", browserTool, { action: "upload", files: ["up.txt"], selector: "#fi" });
  await run("alert", browserTool, { action: "click", text: "Alert me", expect: { text: "after alert" } });
  await run("confirm", browserTool, { action: "click", text: "Confirm me", expect: { text: "cancelled" } });
  const src = await run("find-src", browserTool, { action: "find", text: "drag me" });
  const dst = await run("find-dst", browserTool, { action: "find", text: "drop here" });
  await run("drag", browserTool, { action: "drag", ref: refOf(src, "drag me"), to_ref: refOf(dst, "drop here"), expect: { text: "dropped payload" } });
  await run("log", browserTool, { action: "click", text: "Log" });
  await run("eval", evalTool, { js: "document.title + ' / ' + document.querySelectorAll('button').length" });
  await run("eval-await", evalTool, { js: "await new Promise((r) => setTimeout(() => r(6 * 7), 50))" });
  await run("eval-throw", evalTool, { js: "throw new Error('char boom')" });
  await run("eval-verify", evalTool, { js: "document.querySelector('#sel').value === '2'", verify: true });
  await run("network-list", networkTool, { action: "list", filter: "/api/" });
  await run("scroll", browserTool, { action: "scroll", dy: 400, x: 600, y: 30 });
  await run("scroll-back", browserTool, { action: "scroll", dy: -400, x: 600, y: 30 });
  await run("page-text", browserTool, { action: "page_text" });
  await run("screenshot", browserTool, { action: "screenshot" });
  await run("popup", browserTool, { action: "click", text: "Open popup" });
  await run("popup-text", browserTool, { action: "page_text" });
  await run("tab-close", browserTool, { action: "tab_close" });
  await run("next", browserTool, { action: "click", text: "Next page" });
  const page = existingBrowser(OWNER)!;
  steps.push({ label: "history-back", result: n.value(await page.history(-1)), url: n.str(page.url) });
  steps.push({ label: "history-forward", result: n.value(await page.history(1)), url: n.str(page.url) });
  await run("navigate-home-2", browserTool, { action: "navigate", url: base + "/" });
  await run("resize-mobile", browserTool, { action: "resize", preset: "mobile" });
  await run("reload", browserTool, { action: "reload" });
  await run("tap", browserTool, { action: "click", text: "Tap", expect: { text: "tapped touch" } });
  await run("resize-desktop", browserTool, { action: "resize", preset: "desktop" });
  await run("screenshot-desktop", browserTool, { action: "screenshot" });
  steps.push({ label: "console", value: n.value(page.consoleEntries().map((e) => ({ ...e, t: undefined, ts: undefined }))) });
  steps.push({ label: "dialogs", value: n.value(page.dialogsSince(0).map((d) => ({ ...d, t: undefined }))) });
  steps.push({ label: "state", value: n.value({ url: page.url, viewport: page.viewport, tabs: page.tabs.length, mode: browserMode(OWNER), mount: browserMount(OWNER), live: liveBrowserCount() }) });
  closeBrowser(OWNER);
  steps.push({ label: "after-close", value: { existing: Boolean(existingBrowser(OWNER)), mount: browserMount(OWNER) } });
  store.check("BR01-tools", steps);
});

test("BR02 会话层：标签、视口、指针订阅；浏览器池按会话分开；隔离存储与挂载事件", { skip, timeout: 240_000 }, async () => {
  await ready;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const n = norm(base);
  const steps: unknown[] = [];
  const mounts: unknown[] = [];
  const offMount = onBrowserMount((ev) => mounts.push(structuredClone(ev)));
  const a = await getBrowser("char-owner-a");
  const b = await getBrowser("char-owner-b");
  steps.push({ label: "pool", value: { distinct: a !== b, same: (await getBrowser("char-owner-a")) === a, live: liveBrowserCount() } });
  const tabs: unknown[] = [];
  const views: unknown[] = [];
  const pointers: unknown[] = [];
  const offTabs = a.subscribeTabs((t) => tabs.push(t.map((x) => ({ url: x.url, title: x.title, active: x.active }))));
  const offView = a.subscribeViewport((v) => views.push(v));
  const offPtr = a.subscribePointer((p) => pointers.push(p));
  await a.navigate(base + "/");
  await a.settle();
  steps.push({ label: "title", value: await a.title() });
  steps.push({ label: "measure", value: n.value(await a.measure()) });
  steps.push({ label: "eval", value: n.value(await a.eval("1 + 1")) });
  await a.clickCoord(60, 90, { source: "agent" });
  await a.hoverCoord(100, 100, "user");
  await a.typeText("x");
  await a.pressKey("Tab");
  await a.wheel(300, 300, 200, 0);
  await a.newTab(base + "/page2");
  await new Promise((r) => setTimeout(r, 500));
  steps.push({ label: "tabs-after-new", value: n.value(a.tabs.map((t) => ({ url: t.url, active: t.active }))) });
  const first = a.tabs.find((t) => !t.active)!;
  await a.activateTab(first.id);
  steps.push({ label: "tabs-after-activate", value: n.value(a.tabs.map((t) => ({ url: t.url, active: t.active }))) });
  const second = a.tabs.find((t) => !t.active)!;
  await a.closeTab(second.id);
  await new Promise((r) => setTimeout(r, 300));
  steps.push({ label: "tabs-after-close", value: n.value(a.tabs.map((t) => ({ url: t.url, active: t.active }))) });
  await a.setViewport(390, 844, true);
  await a.setViewport(1280, 800, false);
  await a.setColorScheme("dark");
  const shot = await a.screenshot({});
  steps.push({ label: "screenshot", value: n.value({ keys: Object.keys(shot).sort(), width: (shot as { width?: number }).width, height: (shot as { height?: number }).height }) });
  const ax = await a.axSnapshot();
  steps.push({ label: "ax", value: n.value({ keys: Object.keys(ax).sort(), text: (ax as { text?: string }).text }) });
  steps.push({ label: "page-text", value: n.value(await a.pageText()) });
  steps.push({ label: "isolated-before", value: browserIsolated("char-owner-b") });
  steps.push({ label: "isolate", value: n.value(await setBrowserIsolated("char-owner-b", true)) });
  steps.push({ label: "isolated-after", value: browserIsolated("char-owner-b") });
  steps.push({ label: "unisolate", value: n.value(await setBrowserIsolated("char-owner-b", false)) });
  offTabs();
  offView();
  offPtr();
  // 标签事件到达时页面标题到没到是竞态：只记收到过，最终的标签状态上面已经记了
  steps.push({ label: "tab-events", value: tabs.length > 0 });
  steps.push({ label: "viewport-events", value: n.value(views) });
  steps.push({ label: "pointer-events", value: n.value(pointers) });
  closeBrowser("char-owner-a");
  closeBrowser("char-owner-b");
  void b;
  await new Promise((r) => setTimeout(r, 300));
  offMount();
  steps.push({ label: "mount-events", value: n.value(mounts.map((m) => ({ ...(m as object), at: undefined }))) });
  steps.push({ label: "live-after", value: liveBrowserCount() });
  store.check("BR02-session", steps);
});
