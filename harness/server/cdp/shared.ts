// 浏览器驱动共用的类型、常量与小工具（截图区域、视口预设、画布探针判定、桌面壳判定、无障碍角色表、按键表）。
import { controlPlaneUrlBlock } from "../control-plane.ts";
import { type DesktopHost, desktopHostInfo, resolveCdpBase } from "../desktop-host.ts";
import { coreModule } from "../core-link.ts";

export function openSocket(url: string): WebSocket {
  return new WebSocket(url);
}

// A PERSISTENT headless-Chrome session driven over the Chrome DevTools Protocol
// (CDP) via Node's built-in WebSocket — no puppeteer/CDP-client dependency.
// This is the agent's "hands + eyes": the Browser/ReadPage/Eval/Network tools all
// drive the same CdpSession of THEIR conversation (see the browser pool at the
// bottom: one CdpSession per conversation, all living as their own tabs inside one
// shared browser process). It keeps a page alive across tool calls (state
// persists), captures console + network signals CDP-natively (no probe, no
// dependency on the user's preview iframe being open), reads the page as an
// accessibility tree with stable-until-navigation [refN] handles, and evaluates
// arbitrary JS in the page.

export interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export interface ConsoleEntry {
  t: number;
  type: string;
  msg: string;
}

export interface NetEntry {
  id: string;
  t: number;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  mime?: string;
  size: number;
  state: "pending" | "done" | "failed";
  error?: string;
}

// D5：本机没有能用的内置浏览器时，Browser 启动失败的报错里给的去路（只连着用户扩展 / 桌面壳宿主残留时工具仍然注册着）
export const NO_BUILTIN_BROWSER_HINT =
  "Do not retry Browser(navigate) in this conversation: verify pages over HTTP with Bash + curl and Preview(action:\"logs\") instead, " +
  "and say in your final answer that the UI was not exercised in a real browser. " +
  "DeviceBrowser(browser:…) still drives the user's own Edge/Chrome on their computer if Web Bridge is connected there.";

export const MAX_CONSOLE = 400;
export const MAX_NET = 400;

// 截图长边上限：视口更宽时先在这里缩好、记下比例（frame），x,y 一律按图上像素读、由 frameToCss 换算——
// 否则 provider 入模时再缩一次，模型按图算的坐标就全对不上（对齐 bridge 的 cdp.mjs）。
export const SHOT_MAX_PX = 1568;
// 不算「还在加载」的长连接类请求（settle 不等它们）。
export const LONG_LIVED = new Set(["EventSource", "WebSocket", "Ping", "Manifest", "CSPViolationReport"]);
// 页内 DOM 变动计数器（MutationObserver，按需装一次，导航后新文档自动重装）：n = DOM 变动条数，s = 滚动事件次数
// （含内层滚动容器，捕获阶段收），t = 最近滚动的元素。settle 与 browser-verify 的页内助手共用同一个计数器。
export const MUT_INIT =
  "if(!window.__bridgeMut){const m=window.__bridgeMut={n:0,s:0};try{new MutationObserver((l)=>{m.n+=l.length}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});addEventListener('scroll',(e)=>{m.s++;m.t=e.target},{capture:true,passive:true})}catch{}}";
export const MUTATION_KEY = `(()=>{${MUT_INIT};return location.href+'#'+window.__bridgeMut.n})()`;

// PNG 头里读宽高（IHDR 固定在第 16~24 字节）。
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (!buf || buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// 页面弹过的原生对话框（alert / confirm / prompt / beforeunload）：当场自动应答，按序号记下，工具层在下一个动作结果里回报。
export interface DialogEntry {
  seq: number;
  type: string;
  message: string;
  accepted: boolean;
  t: number;
}

// 最近一次整屏截图的帧：图片像素 ↔ CSS 像素的换算比（k = CSS / 图片像素）与当时的视口、标签。
export interface ShotFrame {
  imgW: number;
  imgH: number;
  k: number;
  vpW: number;
  vpH: number;
  targetId: string;
  t: number;
}

// 页面自己量出来的视口（resize / 截图后实测；以页面说的为准，不靠「命令发过了」）。
export interface MeasuredViewport {
  w: number;
  h: number;
  dpr: number;
  touch: number;
  coarse: boolean;
  dark: boolean;
  sx?: number;
  sy?: number;
  at: number;
}

// 浏览器面板的观看者（直播连接各登记一条，断开即撤）：工具据此告诉 agent 用户此刻看不看得到这个浏览器。
export interface BrowserViewer {
  kind: "native" | "stream";
  since: number;
}

// Roles that get a [refN] handle in the accessibility snapshot (clickable /
// typeable things). Lowercased for matching.
export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
  "switch", "slider", "spinbutton", "textfield", "togglebutton",
]);
// Structural noise: skipped entirely (children too — InlineTextBox duplicates
// its StaticText parent's content).
export const SKIP_ROLES = new Set(["inlinetextbox", "linebreak"]);
// Unnamed wrappers: no line of their own, children promoted to this depth.
// "none"/"presentation" included: ignored wrapper containers carry role "none"
// but their subtree is the whole page — dropping them empties the tree.
export const PROMOTE_ROLES = new Set(["generic", "genericcontainer", "group", "section", "div", "none", "presentation"]);

// page_text 的页面内脚本与 bridge 浏览器工具共用（src/runtime/cdp-page-text.mjs：穿过 open shadow DOM 取字、
// 折叠连续重复的长行）。用到时才经 core-link 取；取不到（离线包配了没有这个模块的旧 bridge）就退回原来的 innerText 一行脚本。
type PageTextCore = { pageTextExpression(opts: { limit?: number }): string; foldRepeatedLines(text: string): string };
let pageTextCore: PageTextCore | null | undefined;
export function loadPageTextCore(): PageTextCore | null {
  if (pageTextCore === undefined) {
    try {
      pageTextCore = coreModule<PageTextCore>("runtime/cdp-page-text.mjs");
    } catch {
      pageTextCore = null;
    }
  }
  return pageTextCore;
}
export const PAGE_TEXT_PLAIN = `(()=>{const pick=document.querySelector('article')||document.querySelector('main,[role=main]')||document.body;const t=(pick?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim();return{from:pick?(pick.tagName.toLowerCase()+(pick.id?'#'+pick.id:'')):'',title:document.title,text:t}})()`;

// AX 节点的 url 属性（链接有；RootWebArea 是页面地址）
export function axUrl(node: any): string {
  const p = (node?.properties ?? []).find((x: any) => x.name === "url");
  return typeof p?.value?.value === "string" ? p.value.value : "";
}

export const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
};

export interface AxSnapshot {
  text: string;
  refCount: number;
  lineCount: number;
  truncated: boolean;
}

// U5：Browser(screenshot) 的取景与等待（见 CdpSession.screenshot）
export interface ScreenshotOptions {
  selector?: string; // 只截这个元素（CSS）
  ref?: number; // 只截这个元素（ReadPage 的 [refN]）
  clip?: { x: number; y: number; width: number; height: number }; // 视口坐标里的一块（CSS px）
  waitMs?: number; // 不传 = 等动画与字体（≤ SETTLE_MAX_MS）；0 = 立刻截；> 0 = 先等这么久再等动画
}
export interface ScreenshotResult {
  png: Buffer;
  region?: { x: number; y: number; width: number; height: number; clamped: boolean }; // 页面坐标（CSS px）
  settle: { waitedMs: number; stillRunning: number } | null; // null = 按 waitMs:0 没等
  frame?: ShotFrame; // 整屏截图才有：这张图就是之后 x,y 的坐标基准
}
export const SETTLE_MAX_MS = 3_000;
export const MAX_SHOT_WAIT_MS = 15_000;
const MAX_SHOT_EDGE = 10_000; // CSS px：再大的一块截出来动辄几十 MB，入模前也会被缩到 2000px

// 页面坐标不会是负的：左上角夹到 0，宽高跟着减；每边最多 MAX_SHOT_EDGE。
export function clampRegion(r: { x: number; y: number; width: number; height: number }): NonNullable<ScreenshotResult["region"]> {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const width = Math.min(MAX_SHOT_EDGE, r.width - (x - r.x));
  const height = Math.min(MAX_SHOT_EDGE, r.height - (y - r.y));
  if (width < 1 || height < 1) throw new Error("the requested region lies outside the page");
  return { x, y, width, height, clamped: width !== r.width || height !== r.height };
}

// Shared viewport presets — the agent's Browser(resize) and the pane's device
// switcher (POST /api/browser/resize) must agree on what "mobile" means, so
// the pane can highlight the active device from frame dimensions alone.
export const VIEWPORT_PRESETS: Record<string, { width: number; height: number; mobile: boolean }> = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  desktop: { width: 1280, height: 900, mobile: false },
};

// ── Canvas DPR probe ─────────────────────────────────────────────────────────
// One snapshot of every canvas's backing store (width/height ATTRIBUTES) vs its
// layout box. Two snapshots taken with no input in between expose self-inflating
// sizing loops (e.g. code that reads its own written height attribute and
// multiplies by devicePixelRatio every frame — invisible at DPR 1, exponential
// blowout on every real display).
export interface CanvasProbeSample {
  docH: number;
  canvases: { id: string; attrW: number; attrH: number; rectW: number; rectH: number }[];
}

export interface CanvasProbeReport {
  dpr: number;
  canvasCount: number;
  passed: boolean;
  problems: string[];
  note?: string;
}

export function judgeCanvasProbe(
  s0: CanvasProbeSample,
  s1: CanvasProbeSample,
  dpr: number,
): { passed: boolean; problems: string[] } {
  const problems: string[] = [];
  const MAX_DIM = 32767; // Chromium-cap territory — no legitimate canvas lives here
  const SANE_DOC = 2_000_000; // px; no real page is this tall
  for (const c1 of s1.canvases) {
    const c0 = s0.canvases.find((c) => c.id === c1.id);
    if (c0 && (Math.abs(c1.attrW - c0.attrW) > 1 || Math.abs(c1.attrH - c0.attrH) > 1)) {
      problems.push(
        `canvas ${c1.id}: backing store grew with NO input (${c0.attrW}×${c0.attrH} → ${c1.attrW}×${c1.attrH}) — a resize/DPR feedback loop`,
      );
      continue;
    }
    if (c1.attrW > MAX_DIM || c1.attrH > MAX_DIM) {
      problems.push(
        `canvas ${c1.id}: backing store ${c1.attrW}×${c1.attrH} exceeds Chromium's limit — it renders as a broken white block`,
      );
      continue;
    }
    // Backing far beyond layout × dpr means the sizing math applied the ratio
    // more than once. ×3 headroom keeps deliberate 2× supersampling legal.
    if (c1.rectW > 0 && c1.rectH > 0) {
      const wCap = Math.max(4096, c1.rectW * dpr * 3 + 64);
      const hCap = Math.max(4096, c1.rectH * dpr * 3 + 64);
      if (c1.attrW > wCap || c1.attrH > hCap) {
        problems.push(
          `canvas ${c1.id}: backing ${c1.attrW}×${c1.attrH} vs layout ${c1.rectW}×${c1.rectH} at dpr ${dpr} — the ratio was applied more than once`,
        );
      }
    }
  }
  if (s1.docH > SANE_DOC) {
    problems.push(`page height ${s1.docH}px is runaway — layout blown up by an exploding element`);
  } else if (s0.docH > 0 && s1.docH - s0.docH > Math.max(2000, s0.docH * 0.05)) {
    problems.push(`page height still growing with no input (${s0.docH}px → ${s1.docH}px)`);
  }
  return { passed: problems.length === 0, problems };
}

// One screencast frame (JPEG) with the page metrics needed to map viewer
// coordinates back onto the page (deviceWidth/Height are CSS px).
export interface CastFrame {
  data: string; // base64 jpeg
  deviceWidth: number;
  deviceHeight: number;
  ts: number;
}

// Echo of an injected pointer input — lets pane viewers SEE where the agent
// (or another viewer) is pointing/clicking on the shared page.
export interface PointerEcho {
  kind: "move" | "click";
  x: number;
  y: number;
  source: "agent" | "user";
}

// One browser tab (CDP page target). The pane renders these as a real tab
// strip; `active` marks the tab our page-level websocket is attached to —
// every tool/screencast/input call acts on that foreground tab.
export interface BrowserTab {
  id: string; // CDP targetId
  url: string;
  title: string;
  active: boolean;
}

// S10 止血（#89）：控制面页面（bridge / harness 的回环地址）不当成可附着的页面
export function withoutControlPlane(pages: any[]): any[] {
  return pages.filter((t) => !controlPlaneUrlBlock(String(t.url ?? "")));
}

// 桌面壳原生浏览器宿主的描述解析见 desktop-host.ts（控制面黑名单也要用它）。
// S10：壳活着、并且认得出 CDP 基址（新壳 = broker 转发，旧壳 = 调试端口）才算可用；否则 null，回落 headless。
export async function liveDesktopHost(): Promise<(DesktopHost & { cdpBase: string; proxy: boolean }) | null> {
  const info = desktopHostInfo();
  if (!info) return null;
  const cdp = await resolveCdpBase(info);
  return cdp ? { ...info, ...cdp } : null;
}

// Touch-mode UA: copy the real Chrome major version (sites that branch on it should not treat us as an ancient browser).
// Short edge < 600 = phone (Pixel 8), otherwise tablet (Galaxy Tab) - same as bridge's cdp.mjs.
export function mobileUserAgent(baseUa: string, phone: boolean): string {
  const major = /Chrome\/(\d+)/.exec(baseUa || "")?.[1] || "128";
  return phone
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
    : `Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}


export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
