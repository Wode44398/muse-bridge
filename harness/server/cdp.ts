import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browserEnv,
  clearBrowserLaunchFailure,
  findBrowser,
  noteBrowserLaunchFailure,
  reapProfileProcesses,
  reapProfileProcessesSync,
} from "./headless.ts";
import { controlPlaneUrlBlock } from "./control-plane.ts";
import { desktopHostInfo, resolveCdpBase, type DesktopHost } from "./desktop-host.ts";
import { killTree } from "./tools/bash.ts";
import { registerResource } from "./resources.ts";
import { browserIsolationFile, browserProfileDir, inTestProcess } from "./paths.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { coreModule } from "./core-link.ts";

function openSocket(url: string): WebSocket {
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

interface Pending {
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
const NO_BUILTIN_BROWSER_HINT =
  "Do not retry Browser(navigate) in this conversation: verify pages over HTTP with Bash + curl and Preview(action:\"logs\") instead, " +
  "and say in your final answer that the UI was not exercised in a real browser. " +
  "DeviceBrowser(browser:…) still drives the user's own Edge/Chrome on their computer if Web Bridge is connected there.";

const MAX_CONSOLE = 400;
const MAX_NET = 400;

// 截图长边上限：视口更宽时先在这里缩好、记下比例（frame），x,y 一律按图上像素读、由 frameToCss 换算——
// 否则 provider 入模时再缩一次，模型按图算的坐标就全对不上（对齐 bridge 的 cdp.mjs）。
export const SHOT_MAX_PX = 1568;
// 不算「还在加载」的长连接类请求（settle 不等它们）。
const LONG_LIVED = new Set(["EventSource", "WebSocket", "Ping", "Manifest", "CSPViolationReport"]);
// 页内 DOM 变动计数器（MutationObserver，按需装一次，导航后新文档自动重装）：n = DOM 变动条数，s = 滚动事件次数
// （含内层滚动容器，捕获阶段收），t = 最近滚动的元素。settle 与 browser-verify 的页内助手共用同一个计数器。
export const MUT_INIT =
  "if(!window.__bridgeMut){const m=window.__bridgeMut={n:0,s:0};try{new MutationObserver((l)=>{m.n+=l.length}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});addEventListener('scroll',(e)=>{m.s++;m.t=e.target},{capture:true,passive:true})}catch{}}";
const MUTATION_KEY = `(()=>{${MUT_INIT};return location.href+'#'+window.__bridgeMut.n})()`;

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
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
  "switch", "slider", "spinbutton", "textfield", "togglebutton",
]);
// Structural noise: skipped entirely (children too — InlineTextBox duplicates
// its StaticText parent's content).
const SKIP_ROLES = new Set(["inlinetextbox", "linebreak"]);
// Unnamed wrappers: no line of their own, children promoted to this depth.
// "none"/"presentation" included: ignored wrapper containers carry role "none"
// but their subtree is the whole page — dropping them empties the tree.
const PROMOTE_ROLES = new Set(["generic", "genericcontainer", "group", "section", "div", "none", "presentation"]);

// page_text 的页面内脚本与 bridge 浏览器工具共用（src/runtime/cdp-page-text.mjs：穿过 open shadow DOM 取字、
// 折叠连续重复的长行）。用到时才经 core-link 取；取不到（离线包配了没有这个模块的旧 bridge）就退回原来的 innerText 一行脚本。
type PageTextCore = { pageTextExpression(opts: { limit?: number }): string; foldRepeatedLines(text: string): string };
let pageTextCore: PageTextCore | null | undefined;
function loadPageTextCore(): PageTextCore | null {
  if (pageTextCore === undefined) {
    try {
      pageTextCore = coreModule<PageTextCore>("runtime/cdp-page-text.mjs");
    } catch {
      pageTextCore = null;
    }
  }
  return pageTextCore;
}
const PAGE_TEXT_PLAIN = `(()=>{const pick=document.querySelector('article')||document.querySelector('main,[role=main]')||document.body;const t=(pick?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim();return{from:pick?(pick.tagName.toLowerCase()+(pick.id?'#'+pick.id:'')):'',title:document.title,text:t}})()`;

// AX 节点的 url 属性（链接有；RootWebArea 是页面地址）
function axUrl(node: any): string {
  const p = (node?.properties ?? []).find((x: any) => x.name === "url");
  return typeof p?.value?.value === "string" ? p.value.value : "";
}

const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
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
function clampRegion(r: { x: number; y: number; width: number; height: number }): NonNullable<ScreenshotResult["region"]> {
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
async function liveDesktopHost(): Promise<(DesktopHost & { cdpBase: string; proxy: boolean }) | null> {
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

export class CdpSession {
  private child: ChildProcess | null = null;
  // 子进程 'error' 事件（spawn 本身失败）。见 launch() 里挂监听的理由。
  private spawnError: Error | null = null;
  private ws: WebSocket | null = null;
  private tmp = "";
  private browserPath = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private loadWaiters: (() => void)[] = [];
  private dead = false;
  // True when connected to an EXTERNAL app's DevTools port (Electron window,
  // a user-launched Chrome, …). We own no child process then: close() only
  // disconnects, the app keeps running.
  attached = false;
  // 桌面壳模式：target 由壳的 broker 创建/关闭（真 WebContentsView，用户与 agent 同屏）。
  // Electron 调试端口上还有 bridge UI 与别家会话的 target——list/tabs 只认 ownedTargets。
  external = false;
  private desktopBroker = "";
  private ownedTargets = new Set<string>();
  // 共享无头宿主（见下面的 acquireHost）：按会话各开一份时，每个会话的 CdpSession 只是同一个浏览器进程里「自己建的
  // 那几个标签」——与桌面壳同一套 ownedTargets 语义，列表 / 事件里别的会话的标签一概不认。null = 自己拉起或附着的进程。
  private hostLease: HostLease | null = null;
  // 只认 ownedTargets：宿主的会话，以及宿主自己的锚点页（keeper，见 markKeeper）
  private ownsOnly = false;
  private keeper = false;
  // 隔离存储（按会话开关）：共享宿主里本会话独占的浏览上下文——cookie / 存储 / 缓存都不和别的会话共用，关掉即清空。
  // "" = 宿主的默认上下文（持久配置档，登录态大家共享）。
  browserContextId = "";
  // 宿主会话 close() 的善后（标签关完、隔离上下文销毁、宿主若因此退出也退完）
  private closing: Promise<void> | null = null;
  url = "";
  viewport = { width: 1280, height: 900 };

  // ── 标签页（多 target）──────────────────────────────────────────────────
  // 一条 browser 级 WebSocket 跑 Target 域（发现/新建/关闭/激活标签），page 级
  // ws 永远附着在「当前标签」上 —— 工具、直播、输入回传都不用知道标签存在。
  tabs: BrowserTab[] = [];
  private activeTargetId = "";
  private debugPort = 0;
  // S10：/json/* 的基址——无头与 attach(port) = 调试端口；桌面壳 = broker 的 CDP 转发（新壳没有调试端口）
  private cdpBase = "";
  private browserWs: WebSocket | null = null;
  private bNextId = 1;
  private bPending = new Map<number, Pending>();
  private tabSubs = new Set<(tabs: BrowserTab[]) => void>();
  // 换附着（切标签/关当前标签）期间旧 page ws 的 close 不算 session 死亡。
  private retargetN = 0;

  private consoleBuf: ConsoleEntry[] = [];
  private netByReqId = new Map<string, NetEntry>();
  private netOrder: NetEntry[] = [];
  // Screencast: the "shared window" the user watches live. Started when the
  // first viewer subscribes, stopped when the last one leaves.
  private castSubs = new Set<(f: CastFrame) => void>();
  private casting = false;
  lastFrame: CastFrame | null = null;
  private pointerSubs = new Set<(p: PointerEcho) => void>();
  private viewportSubs = new Set<(v: { width: number; height: number }) => void>();
  // ref → a11y node handle, regenerated by every axSnapshot(). backendId drives
  // DOM.resolveNode for clicks/typing.
  private refs = new Map<number, { backendId: number; role: string; name: string }>();

  // 主框架加载状态（frameStartedLoading / frameStoppedLoading）：settle 据此区分「页面还在跳转」与「已经安定」。
  private mainFrameId = "";
  loading = false;
  private loadingSince = 0;
  // 原生对话框：一弹出就替页面应答（不应答主线程整个挡住，之后的 eval / 点击统统 30 秒超时）
  private dialogs: DialogEntry[] = [];
  dialogSeq = 0;
  dialogReported = 0; // 已回报给 agent 的最大序号（browser-verify.ts dialogNote 推进）
  // 截图坐标帧（见 ShotFrame）与页面实测视口
  frame: ShotFrame | null = null;
  measured: MeasuredViewport | null = null;
  // 触屏仿真：resize 到手机 / 平板档时开（touch 事件 + 移动端 UA + pointer:coarse），左键点击随之改发真触摸
  emu = { mobile: false };
  private baseUa = "";
  private uaOverridden = false;
  private touch0 = new Map<string, string>(); // targetId → 「桌面档 maxTouchPoints=0」注入脚本的 id
  // drag() 开了 setInterceptDrags 时，HTML5 拖放被接住的回调
  private onDragIntercepted: ((p: any) => void) | null = null;
  // 面板观看者（见 BrowserViewer）
  private viewers = new Map<number, BrowserViewer>();
  private viewerSeq = 0;
  // 持久配置档（登录态跨会话保留）：有值时 profile 就是它、关浏览器不删；空 = 临时目录 <tmp>/profile
  private profileDir = "";

  get alive(): boolean {
    if (this.dead || this.ws?.readyState !== WebSocket.OPEN) return false;
    return this.hostLease ? this.hostLease.alive : this.child?.exitCode == null;
  }

  // 桌面壳模式（真 WebContentsView，经 broker 建标签）。共享无头宿主不算——它也只认自己的标签，但不在壳里。
  get desktop(): boolean {
    return Boolean(this.desktopBroker);
  }

  // 只认自己的标签（桌面壳、共享宿主里的会话、宿主锚点）
  private get owning(): boolean {
    return this.external || this.ownsOnly;
  }

  // opts.profileDir：持久配置档（登录态跨会话保留）；不给 = 一次性临时 profile。
  // opts.shared：不自己拉进程，进同一个配置档的共享无头宿主（按会话各开一份的浏览器池用，见 getBrowser）。
  // opts.isolate：只对共享宿主有意义——在宿主里开一个独立浏览上下文（隔离存储），也因此不进桌面壳。
  // opts.desktop:false：不进桌面壳（宿主锚点自己就是那个无头进程）。
  async launch(startUrl: string, opts: { profileDir?: string; shared?: boolean; isolate?: boolean; desktop?: boolean } = {}): Promise<void> {
    // 桌面壳在场 → 真 WebContentsView（用户面板与 agent 同一个页面实体）；否则 headless。
    // 隔离存储不进壳：壳里是主机自己的持久分区，cookie 和别的会话共用。
    if (opts.desktop !== false && !opts.isolate) {
      const host = await liveDesktopHost();
      if (host) {
        await this.attachDesktop(host, startUrl || "about:blank");
        return;
      }
    }
    if (opts.shared) {
      this.hostLease = await acquireHost(opts.profileDir ?? "");
      await this.joinHost(startUrl || "about:blank", Boolean(opts.isolate));
      return;
    }
    const browser = findBrowser();
    // 浏览器工具照样注册着（桌面壳宿主文件残留、只连着用户的扩展……）但本机没有内置浏览器：说清楚往哪走，别让模型反复重试
    if (!browser) throw new Error(`No Chrome/Edge found for the interactive browser. ${NO_BUILTIN_BROWSER_HINT}`);
    if (opts.profileDir) {
      // Chromium 一个 user-data-dir 只能一个进程开（第二个把参数转交第一个后就退出）：上次崩溃留下的孤儿先请它退出、
      // 再按命令行指纹收干净，并删掉它留下的 DevToolsActivePort（不删会读到死端口）。
      this.profileDir = opts.profileDir;
      mkdirSync(this.profileDir, { recursive: true });
      await retireOrphanProfile(this.profileDir, browser);
    } else {
      this.tmp = mkdtempSync(path.join(tmpdir(), "harness-cdp-"));
      this.profileDir = path.join(this.tmp, "profile");
    }
    this.browserPath = browser;
    // S8（#54）：不再 --no-sandbox——这个浏览器打开模型挑的任意公网页面，renderer 一旦被
    // 利用就直接是用户权限。Windows 普通用户跑 Chromium 自己的沙箱不需要任何特权。
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${this.viewport.width},${this.viewport.height}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      startUrl || "about:blank",
    ];
    // S7（#55）：env 不带任何凭据（以前继承全部 provider key）；#64：也不带 __COMPAT_LAYER（见 browserEnv）。
    this.child = spawn(browser, args, { stdio: "ignore", windowsHide: true, env: browserEnv() });
    // spawn 失败（EACCES / EMFILE / 浏览器自更新换目录导致的 ENOENT…）走的是【异步
    // 'error' 事件】而不是同步抛。没有监听者时 EventEmitter 直接 throw，会把整个
    // harness 进程打死。存下来让 readDevToolsPort 立刻报真因，不必空等 15 秒。
    this.child.on("error", (e: Error) => {
      this.dead = true;
      this.spawnError = e;
    });
    this.child.on("exit", () => {
      this.dead = true;
    });
    this.url = startUrl;

    let port: number;
    try {
      port = await this.readDevToolsPort();
    } catch (e) {
      // D5：浏览器进程没开调试端口就退了 / 根本没拉起来（snap 空壳、No usable sandbox……）——记一笔，接下来的新会话不再
      // 提供浏览器工具（headless.ts browserAvailable）；这一会话的工具已经定了，报错里直说别再试。超时不记（机器忙也会超时）。
      if (this.spawnError || this.child?.exitCode != null) {
        noteBrowserLaunchFailure(browser);
        throw new Error(`${(e as Error).message}. The browser cannot start on this machine. ${NO_BUILTIN_BROWSER_HINT}`);
      }
      throw e;
    }
    clearBrowserLaunchFailure(browser);
    this.debugPort = port;
    this.cdpBase = `http://127.0.0.1:${port}`;
    const pages = await this.waitPages(port);
    const page = pages[0];
    this.activeTargetId = String(page.id ?? "");
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs(pages);
    await this.connectBrowserSocket().catch((e) => {
      // 目标管理不可用时退化为单标签（面板只读，×/+ 会报错）
      console.warn("[cdp] tab management unavailable:", (e as Error).message);
    });
  }

  private async enableDomains(): Promise<void> {
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    await this.send("DOM.enable", {});
    // Console + network capture are CDP-native: they observe THIS browser, so
    // they work with no preview iframe open anywhere.
    await this.send("Log.enable", {}).catch(() => {});
    await this.send("Network.enable", {
      maxTotalBufferSize: 20_000_000,
      maxResourceBufferSize: 8_000_000,
    }).catch(() => {});
    await this.send("Accessibility.enable", {}).catch(() => {});
  }

  // 桌面壳模式：连壳的 browser 级 Target 域，经 broker 创建带所有权记录的
  // WebContentsView target。之后 list/tabs 只认 ownedTargets，绝不把 bridge UI
  // 自身或其他会话的 target 混进来。
  private async attachDesktop(host: DesktopHost & { cdpBase: string }, startUrl: string): Promise<void> {
    this.external = true;
    this.desktopBroker = host.brokerUrl;
    this.debugPort = host.cdpPort;
    this.cdpBase = host.cdpBase;
    this.url = startUrl;
    await this.connectBrowserSocket();
    const marker = `about:blank#dimensio-native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await this.desktopTarget("POST", "", { url: marker });
    const id = String(created?.targetId ?? "");
    if (!id) throw new Error("desktop broker returned no targetId");
    this.ownedTargets.add(id);
    this.activeTargetId = id;
    const pages = await this.waitPages(this.debugPort);
    const page = pages.find((p) => String(p.id ?? "") === id);
    if (!page?.webSocketDebuggerUrl) throw new Error("Electron browser target exposes no debugger url");
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs([{ ...page, url: startUrl }]);
    // 去掉只用于认领 target 的 marker；about:blank 用零等待导航，其余沿用正常 settle。
    if (startUrl === "about:blank") {
      await this.send("Page.navigate", { url: "about:blank" });
      this.url = "about:blank";
      this.syncActiveTabUrl(this.url);
    } else {
      await this.navigate(startUrl);
    }
  }

  private async desktopTarget(method: string, id = "", body: Record<string, unknown> | null = null): Promise<any> {
    if (!this.desktopBroker) throw new Error("desktop browser broker unavailable");
    const response = await fetch(this.desktopBroker + "/target" + (id ? "/" + encodeURIComponent(id) : ""), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return { ok: true };
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      /* empty */
    }
    if (!response.ok) throw new Error(payload?.error || `desktop browser broker HTTP ${response.status}`);
    return payload || { ok: true };
  }

  // 共享无头宿主里开「本会话自己的」浏览器：自己一条 browser 级连接（Target 域），自己建的标签（每个都开在新窗口里——
  // 同一个窗口里只有前台那个标签可见，别的会话一建标签就会把你挤到后台：rAF 停、可见性变 hidden），只认 ownedTargets。
  // 隔离存储：先建独立浏览上下文，标签都开在它里面（disposeOnDetach：这条连接一断上下文就销毁，宿主里不留孤儿）。
  private async joinHost(startUrl: string, isolate: boolean): Promise<void> {
    const lease = this.hostLease!;
    this.ownsOnly = true;
    this.debugPort = lease.port;
    this.cdpBase = lease.cdpBase;
    this.url = startUrl;
    await this.connectBrowserSocket();
    if (isolate) {
      const c = await this.bsend("Target.createBrowserContext", { disposeOnDetach: true });
      this.browserContextId = String(c?.browserContextId ?? "");
      if (!this.browserContextId) throw new Error("Target.createBrowserContext returned no browserContextId");
    }
    const id = await this.createTarget(startUrl);
    this.activeTargetId = id;
    const pages = await this.waitPages(this.debugPort);
    const page = pages.find((p) => String(p.id ?? "") === id);
    if (!page?.webSocketDebuggerUrl) throw new Error("the new browser tab exposes no debugger url");
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs([page]);
  }

  // 共享宿主的锚点页（宿主进程拉起时自带的那张空白页）：只认它自己——别的会话的标签不进它的列表，它也绝不去接管；
  // 它在，最后一个会话的标签关掉时浏览器进程也不会跟着退（进程何时退由宿主的引用计数决定）。
  markKeeper(): void {
    this.keeper = true;
    this.ownsOnly = true;
    this.ownedTargets = new Set(this.activeTargetId ? [this.activeTargetId] : []);
    this.tabs = this.tabs.filter((t) => this.ownedTargets.has(t.id));
  }

  // 这个进程的 CDP 入口（共享宿主把它交给各会话）
  get endpoint(): { cdpBase: string; port: number } {
    return { cdpBase: this.cdpBase, port: this.debugPort };
  }

  // 建一个归自己的标签：桌面壳经 broker；共享宿主开在新窗口（隔离存储开在自己的上下文里）；自己拉起的进程照旧开成标签。
  private async createTarget(url: string): Promise<string> {
    const r = this.desktopBroker
      ? await this.desktopTarget("POST", "", { url })
      : await this.bsend(
          "Target.createTarget",
          this.hostLease ? { url, newWindow: true, ...(this.browserContextId ? { browserContextId: this.browserContextId } : {}) } : { url },
        );
    const id = String(r?.targetId ?? "");
    if (!id) throw new Error("Target.createTarget returned no targetId");
    if (this.owning) this.ownedTargets.add(id);
    return id;
  }

  private closeTarget(id: string): Promise<unknown> {
    return this.desktopBroker ? this.desktopTarget("DELETE", id) : this.bsend("Target.closeTarget", { targetId: id });
  }

  // Attach to an already-running Chromium-based app exposing a DevTools port
  // (Electron with --remote-debugging-port, headful Chrome, a packaged exe…).
  // Polls the endpoint briefly so "launch job → attach" works while the app is
  // still booting. Picks the first real page target, or the one matching
  // `targetFilter` (substring of title/URL, case-insensitive).
  async attach(port: number, targetFilter?: string): Promise<{ picked: string; pages: number }> {
    const deadline = Date.now() + 12_000;
    let pages: any[] = [];
    let lastErr = "the DevTools endpoint did not answer";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = (await res.json()) as any[];
        pages = targets.filter(
          (t) => t.type === "page" && t.webSocketDebuggerUrl && !/^(devtools|chrome-extension):/.test(String(t.url ?? "")),
        );
        if (pages.length) break;
        lastErr = `no page targets yet (${targets.length} total: ${targets.map((t) => t.type).join(", ") || "none"})`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await delay(250);
    }
    if (!pages.length) {
      throw new Error(
        `no debuggable page on 127.0.0.1:${port} — ${lastErr}. Is the app running with --remote-debugging-port=${port}?`,
      );
    }
    // S10 止血（#89）：附着别的 app 时，挂着控制面页面（bridge / harness 的回环地址）的一律不认——以前只按端口号拦，
    // 端口没登记（描述文件缺了、旧壳的调试端口经 DevToolsActivePort 泄露）时 pages[0] 可能就是已登录的 bridge 主窗口。
    const total = pages.length;
    pages = withoutControlPlane(pages);
    if (!pages.length) {
      // 不开口子：这些页面带着已登录的 bridge 会话，Eval 能在里面跑任意脚本，「只读 attach」做不到真只读。
      // 但把能走的路说清楚，别让模型反复撞墙（2026-10-09 验证桌面壳时就撞了）。
      throw new Error(
        `the ${total} page(s) on 127.0.0.1:${port} are dimensio / bridge's own control plane (a logged-in bridge session) — attaching to them is not allowed. ` +
          `If that window is on the user's computer, check it visually with DeviceInspect(action:"screenshot", window:<hwnd from action:"windows">) — it captures that window even when others cover it. ` +
          `To test bridge UI behaviour, run a separate bridge/dev instance on another port with its own data root and attach or navigate to that.`,
      );
    }
    let pick = pages[0];
    if (targetFilter) {
      const f = targetFilter.toLowerCase();
      const hit = pages.find(
        (t) => String(t.url ?? "").toLowerCase().includes(f) || String(t.title ?? "").toLowerCase().includes(f),
      );
      if (!hit) {
        throw new Error(
          `no page target matching "${targetFilter}" — available: ${pages.map((t) => `"${t.title || t.url}"`).join(", ")}`,
        );
      }
      pick = hit;
    }
    this.attached = true;
    this.debugPort = port;
    this.cdpBase = `http://127.0.0.1:${port}`;
    this.activeTargetId = String(pick.id ?? "");
    await this.connect(pick.webSocketDebuggerUrl);
    this.url = String(pick.url ?? "");
    await this.enableDomains();
    this.seedTabs(pages);
    await this.connectBrowserSocket().catch(() => {
      /* Electron 等非浏览器目标可能没有 Target 域 —— 退化为单标签 */
    });
    return { picked: `"${pick.title || "(untitled)"}" ${pick.url ?? ""}`.trim(), pages: pages.length };
  }

  // Chrome writes the actual debug port to <user-data-dir>/DevToolsActivePort.
  private async readDevToolsPort(timeoutMs = 15_000): Promise<number> {
    const file = path.join(this.profileDir, "DevToolsActivePort");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const p = readDevToolsPortFile(file);
        if (p) return p;
      }
      if (this.spawnError) throw new Error(`failed to start the browser: ${this.spawnError.message}`);
      if (this.child?.exitCode != null) throw new Error("browser exited before opening a debug port");
      await delay(80);
    }
    throw new Error("timed out waiting for the browser debug port");
  }

  // Poll the browser's /json/list until at least one real page target exists,
  // returning the full page list (id + url + title + ws url per tab).
  private async waitPages(port: number, timeoutMs = 10_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pages = await this.listPages();
        if (pages.length) return pages;
      } catch {
        /* not ready */
      }
      await delay(80);
    }
    throw new Error("no page target exposed by the browser");
  }

  private async listPages(): Promise<any[]> {
    const res = await fetch(`${this.cdpBase}/json/list`);
    const targets = (await res.json()) as any[];
    const pages = targets.filter(
      (t) => t.type === "page" && t.webSocketDebuggerUrl && !/^(devtools|chrome-extension):/.test(String(t.url ?? "")),
    );
    if (this.owning) return pages.filter((t) => this.ownedTargets.has(String(t.id ?? "")));
    // S10 止血：attach(port) 之后切标签也照样不认控制面页面
    return this.attached ? withoutControlPlane(pages) : pages;
  }

  private connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = openSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("CDP websocket error")));
      ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
      ws.addEventListener("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
        this.pending.clear();
        // 换附着（切标签）是我们主动关的旧 ws —— session 没死，工具无感。
        if (this.retargetN > 0) return;
        this.dead = true;
      });
    });
  }

  // ── 标签页管理（browser 级 Target 域）─────────────────────────────────────

  private connectBrowserSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      (async () => {
        const res = await fetch(`${this.cdpBase}/json/version`);
        const v = (await res.json()) as any;
        const wsUrl = v?.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error("browser exposes no browser-level debugger url");
        const ws = openSocket(wsUrl);
        this.browserWs = ws;
        ws.addEventListener("open", async () => {
          try {
            await this.bsend("Target.setDiscoverTargets", { discover: true });
            resolve();
          } catch (e) {
            reject(e as Error);
          }
        });
        ws.addEventListener("error", () => reject(new Error("browser CDP websocket error")));
        ws.addEventListener("message", (ev) => this.onBrowserMessage(String((ev as MessageEvent).data)));
        ws.addEventListener("close", () => {
          this.browserWs = null;
          for (const p of this.bPending.values()) p.reject(new Error("browser CDP connection closed"));
          this.bPending.clear();
        });
      })().catch(reject);
    });
  }

  private bsend(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("browser-level CDP not connected"));
    }
    const id = this.bNextId++;
    this.browserWs.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.bPending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.bPending.has(id)) {
          this.bPending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 15_000).unref();
    });
  }

  private onBrowserMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id != null && this.bPending.has(msg.id)) {
      const p = this.bPending.get(msg.id)!;
      this.bPending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
      return;
    }
    const params = msg.params;
    switch (msg.method) {
      case "Target.targetCreated": {
        const t = params?.targetInfo;
        if (t?.type !== "page" || !t.targetId) break;
        const id = String(t.targetId);
        if (this.owning && !this.ownedTargets.has(id)) {
          // 共享宿主：别的会话的标签不认。本会话的页面新开的（window.open / target=_blank，noopener 也带着 openerId）、
          // 以及隔离上下文里冒出来的，都算自己的——页面开的新标签要能自动跟过去。
          const fromMine = Boolean(t.openerId) && this.ownedTargets.has(String(t.openerId));
          const inMyContext = Boolean(this.browserContextId) && String(t.browserContextId ?? "") === this.browserContextId;
          if (!this.hostLease || this.keeper || !(fromMine || inMyContext)) break;
          this.ownedTargets.add(id);
        }
        this.upsertTab({ id, url: String(t.url ?? ""), title: String(t.title ?? ""), active: false });
        break;
      }
      case "Target.targetInfoChanged": {
        const t = params?.targetInfo;
        if (t?.targetId) {
          const tab = this.tabs.find((x) => x.id === String(t.targetId));
          if (tab) {
            tab.url = String(t.url ?? tab.url);
            tab.title = String(t.title ?? tab.title);
            this.notifyTabs();
          }
        }
        break;
      }
      case "Target.targetDestroyed": {
        this.onTargetGone(String(params?.targetId ?? ""));
        break;
      }
    }
  }

  private seedTabs(pages: any[]): void {
    this.tabs = pages.map((p) => ({
      id: String(p.id ?? ""),
      url: String(p.url ?? ""),
      title: String(p.title ?? ""),
      active: String(p.id ?? "") === this.activeTargetId,
    }));
    this.notifyTabs();
  }

  private upsertTab(tab: BrowserTab): void {
    const cur = this.tabs.find((t) => t.id === tab.id);
    if (cur) {
      cur.url = tab.url || cur.url;
      cur.title = tab.title || cur.title;
    } else {
      this.tabs.push(tab);
    }
    this.notifyTabs();
  }

  // 目标从外面没了（页面 window.close()、崩溃、我们关的）：同步列表；若是当前
  // 标签且不是我们在换附着，自动接管下一个标签，一个都不剩就开张空白页——
  // 浏览器进程还在，面板不该掉进「未启动」死态。
  private onTargetGone(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wasActive = this.tabs[idx].active;
    this.tabs.splice(idx, 1);
    if (this.owning) this.ownedTargets.delete(id);
    this.notifyTabs();
    if (!wasActive || this.retargetN > 0 || !this.alive) return;
    const next = this.keeper ? undefined : this.tabs[0];
    if (next) {
      this.activateTab(next.id).catch(() => {});
    } else {
      this.newTab().catch(() => {});
    }
  }

  subscribeTabs(cb: (tabs: BrowserTab[]) => void): () => void {
    this.tabSubs.add(cb);
    try {
      cb(this.tabs.map((t) => ({ ...t })));
    } catch {
      /* subscriber's problem */
    }
    return () => this.tabSubs.delete(cb);
  }

  private notifyTabs(): void {
    const snap = this.tabs.map((t) => ({ ...t }));
    for (const cb of this.tabSubs) {
      try {
        cb(snap);
      } catch {
        /* subscriber's problem */
      }
    }
  }

  private syncActiveTabUrl(url: string): void {
    const tab = this.tabs.find((t) => t.active);
    if (tab && tab.url !== url) {
      tab.url = url;
      this.notifyTabs();
    }
  }

  private requireTargetDomain(): void {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      throw new Error("this browser does not expose tab management (attached to an external app?)");
    }
  }

  // 新建标签并切过去（＋按钮；url 缺省 about:blank）。桌面壳模式下 target 必须由
  // broker 创建（Target.createTarget 在 Electron 上开的是游离窗口，不是内嵌视图）。
  async newTab(url = "about:blank"): Promise<void> {
    this.requireTargetDomain();
    const id = await this.createTarget(url || "about:blank");
    this.upsertTab({ id, url: url || "about:blank", title: "", active: false });
    await this.activateTab(id);
  }

  // 把 page 级附着换到另一个标签：旧 ws 停播/关闭 → 连新目标 → 重开域、
  // 重挂视口、恢复直播。工具层无感 —— 之后所有操作都落在新的前台标签上。
  async activateTab(id: string): Promise<void> {
    if (id === this.activeTargetId) return;
    const pages = await this.listPages();
    const target = pages.find((p) => String(p.id ?? "") === id);
    if (!target?.webSocketDebuggerUrl) throw new Error(`tab ${id} no longer exists`);
    this.retargetN++;
    try {
      const resume = this.casting;
      if (resume) {
        this.casting = false;
        await this.send("Page.stopScreencast", {}).catch(() => {});
      }
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.refs.clear(); // backendId 是每页私有的，旧标签的 ref 全部作废
      this.lastFrame = null;
      await this.connect(String(target.webSocketDebuggerUrl));
      await this.enableDomains();
      await this.setViewport(this.viewport.width, this.viewport.height).catch(() => {});
      this.activeTargetId = id;
      this.url = String(target.url ?? "");
      for (const t of this.tabs) t.active = t.id === id;
      await this.bsend("Target.activateTarget", { targetId: id }).catch(() => {});
      if (resume) {
        try {
          await this.startCast();
        } catch {
          /* 下一帧来了自然恢复 */
        }
      }
      this.notifyTabs();
    } finally {
      this.retargetN--;
    }
  }

  // 关闭标签（×按钮）。关的是当前标签就接管下一个；最后一个标签 = 关窗口，
  // 整个浏览器退出（面板回到「未启动」空态，地址栏/＋可重新拉起）。
  async closeTab(id: string): Promise<void> {
    this.requireTargetDomain();
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return; // 已经没了
    if (!tab.active) {
      await this.closeTarget(id);
      const i = this.tabs.findIndex((t) => t.id === id);
      if (i >= 0) {
        this.tabs.splice(i, 1);
        this.notifyTabs();
      }
      if (this.owning) this.ownedTargets.delete(id);
      return;
    }
    const rest = this.tabs.filter((t) => t.id !== id);
    this.retargetN++;
    try {
      await this.closeTarget(id);
      const i = this.tabs.findIndex((t) => t.id === id);
      if (i >= 0) {
        this.tabs.splice(i, 1);
        this.notifyTabs();
      }
      if (this.owning) this.ownedTargets.delete(id);
      if (rest.length) {
        await this.activateTab(rest[0].id);
      } else {
        void this.close();
      }
    } finally {
      this.retargetN--;
    }
  }

  private pushConsole(type: string, msg: string): void {
    this.consoleBuf.push({ t: Date.now(), type, msg: msg.slice(0, 2000) });
    if (this.consoleBuf.length > MAX_CONSOLE) {
      this.consoleBuf.splice(0, this.consoleBuf.length - MAX_CONSOLE);
    }
  }

  private onMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
      return;
    }
    const params = msg.params;
    switch (msg.method) {
      case "Page.loadEventFired": {
        const waiters = this.loadWaiters;
        this.loadWaiters = [];
        for (const w of waiters) w();
        break;
      }
      // Keep this.url honest across clicks/redirects/SPA pushState, not just
      // explicit navigate() calls.
      case "Page.frameNavigated":
        if (params?.frame && !params.frame.parentId) {
          this.mainFrameId = String(params.frame.id ?? "");
          this.url = params.frame.url;
          this.syncActiveTabUrl(this.url);
        }
        break;
      case "Page.frameStartedLoading":
        if (!this.mainFrameId || params?.frameId === this.mainFrameId) {
          this.loading = true;
          this.loadingSince = Date.now();
        }
        break;
      case "Page.frameStoppedLoading":
        if (!this.mainFrameId || params?.frameId === this.mainFrameId) this.loading = false;
        break;
      case "Page.javascriptDialogOpening":
        this.onDialog(params ?? {});
        break;
      case "Input.dragIntercepted":
        this.onDragIntercepted?.(params);
        break;
      case "Page.navigatedWithinDocument":
        if (params?.url) {
          this.url = params.url;
          this.syncActiveTabUrl(this.url);
        }
        break;
      case "Page.screencastFrame": {
        // MUST ack every frame or Chrome stops sending.
        this.send("Page.screencastFrameAck", { sessionId: params?.sessionId }).catch(() => {});
        const frame: CastFrame = {
          data: String(params?.data ?? ""),
          deviceWidth: Number(params?.metadata?.deviceWidth ?? this.viewport.width),
          deviceHeight: Number(params?.metadata?.deviceHeight ?? this.viewport.height),
          ts: Date.now(),
        };
        this.lastFrame = frame;
        for (const cb of this.castSubs) {
          try {
            cb(frame);
          } catch {
            /* subscriber's problem */
          }
        }
        break;
      }
      case "Runtime.consoleAPICalled": {
        const parts = (params?.args ?? []).map((a: any) => {
          if (a.value !== undefined) {
            return typeof a.value === "string" ? a.value : safeJson(a.value);
          }
          return a.description ?? a.type ?? "";
        });
        this.pushConsole(`console.${params?.type ?? "log"}`, parts.join(" "));
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params?.exceptionDetails;
        const desc = d?.exception?.description || d?.text || "uncaught exception";
        this.pushConsole("error", String(desc));
        break;
      }
      case "Log.entryAdded": {
        const e = params?.entry;
        if (e) {
          this.pushConsole(`${e.source ?? "log"}.${e.level ?? "info"}`, `${e.text ?? ""}${e.url ? ` (${e.url})` : ""}`);
        }
        break;
      }
      case "Network.requestWillBeSent": {
        const id = String(params?.requestId ?? "");
        if (!id) break;
        let entry = this.netByReqId.get(id);
        if (entry) {
          // Redirect: same requestId re-sent for the new URL.
          entry.url = params.request?.url ?? entry.url;
        } else {
          entry = {
            id,
            t: Date.now(),
            method: params.request?.method ?? "GET",
            url: params.request?.url ?? "",
            resourceType: params.type,
            size: 0,
            state: "pending",
          };
          this.netByReqId.set(id, entry);
          this.netOrder.push(entry);
          if (this.netOrder.length > MAX_NET) {
            const dropped = this.netOrder.splice(0, this.netOrder.length - MAX_NET);
            for (const d of dropped) this.netByReqId.delete(d.id);
          }
        }
        break;
      }
      case "Network.responseReceived": {
        const entry = this.netByReqId.get(String(params?.requestId ?? ""));
        if (entry) {
          entry.status = params.response?.status;
          entry.mime = params.response?.mimeType;
        }
        break;
      }
      case "Network.loadingFinished": {
        const entry = this.netByReqId.get(String(params?.requestId ?? ""));
        if (entry) {
          entry.state = "done";
          entry.size = Math.round(params?.encodedDataLength ?? 0);
        }
        break;
      }
      case "Network.loadingFailed": {
        const entry = this.netByReqId.get(String(params?.requestId ?? ""));
        if (entry) {
          entry.state = "failed";
          entry.error = params?.errorText || "failed";
          if (!params?.canceled) {
            this.pushConsole("network", `FAILED ${entry.method} ${entry.url} — ${entry.error}`);
          }
        }
        break;
      }
    }
  }

  send(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP not connected"));
    }
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // unref：超时守卫不该把进程吊住（测试和一次性脚本关完浏览器要能立刻退出）。
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, timeoutMs).unref();
    });
  }

  // 页面弹出原生对话框：一律当场应答——不应答的话页面主线程整个挡住，之后的 eval / 点击 / 塞文件统统等不到回执，
  // 无头里又没人去点。alert、beforeunload 点确定（只是通知 / 放行离开）；confirm、prompt 点取消——它们常守着删除之类
  // 的动作，不能替 agent 默认同意。真要确认，先 Eval 把 window.confirm 换成返回 true。
  private onDialog(params: Record<string, unknown>): void {
    const type = String(params.type || "alert");
    const accept = type === "alert" || type === "beforeunload";
    const entry: DialogEntry = { seq: ++this.dialogSeq, type, message: String(params.message || "").slice(0, 500), accepted: accept, t: Date.now() };
    this.dialogs.push(entry);
    if (this.dialogs.length > 20) this.dialogs.splice(0, this.dialogs.length - 20);
    this.pushConsole(`dialog.${type}`, `${entry.message} (auto-${accept ? "accepted" : "dismissed"})`);
    this.send("Page.handleJavaScriptDialog", { accept }, 5_000).catch(() => {});
  }

  // 序号 mark 之后弹过的对话框
  dialogsSince(mark: number): DialogEntry[] {
    return this.dialogs.filter((d) => d.seq > mark);
  }

  // Evaluate an expression in the page, returning its value (returnByValue).
  // replMode: allows top-level await and re-declaring let/const across calls —
  // both are things models naturally write in successive Eval calls.
  //
  // V4（#56）：replMode 只 await 顶层的 `await x`；表达式本身求值为 Promise 时（`(async()=>…)()`、
  // `(()=>Promise.resolve(true))()`），returnByValue 拿回的是 Promise 对象序列化出的 `{}`——工具描述
  // 却写着「promises are awaited」，验证证据里于是记下了 `FAIL …: {}`。现在先拿引用：是 Promise
  // 就 Runtime.awaitPromise，是对象就按值取回，最后整组释放。
  async eval(expression: string): Promise<any> {
    const objectGroup = "dimensio-eval";
    // 页面脚本自己抛的异常带上类名（pageException），Eval 工具据此区分「断言失败」与「写法错误」。
    const unwrap = (r: any) => {
      if (r?.exceptionDetails) {
        const err = new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error");
        (err as Error & { pageException?: string }).pageException = String(r.exceptionDetails.exception?.className || "Error");
        throw err;
      }
      return r?.result;
    };
    let awaiting = false;
    try {
      let res = unwrap(
        await this.send("Runtime.evaluate", { expression, objectGroup, returnByValue: false, awaitPromise: true, replMode: true }),
      );
      if (res?.subtype === "promise" && res.objectId) {
        awaiting = true;
        res = unwrap(await this.send("Runtime.awaitPromise", { promiseObjectId: res.objectId, returnByValue: true }));
      } else if (res?.objectId) {
        res = unwrap(
          await this.send("Runtime.callFunctionOn", {
            objectId: res.objectId,
            functionDeclaration: "function () { return this; }",
            returnByValue: true,
          }),
        );
      }
      return res?.value;
    } catch (e) {
      if ((e as Error).message.includes("timed out")) {
        if (awaiting) {
          throw new Error("the returned promise did not settle within 30s — make sure it resolves (or rejects) and try again");
        }
        // A script spinning forever (e.g. a while-loop that never exits) wedges
        // the page's main thread — kill it so the page is usable again.
        await this.send("Runtime.terminateExecution", {}).catch(() => {});
        throw new Error(
          "the script ran too long and was terminated (infinite loop?) — the page has been recovered; fix the script and try again",
        );
      }
      throw e;
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }

  // 导航后不再固定白等 1.2 秒：等 load 事件（最多 10 秒），再等页面安定（DOM 不再变、请求落定，最多 3 秒）。
  // 快页面立刻返回，慢 SPA 也不会还没渲染完就交回去。errorText 是 Chrome 报的加载失败（DNS / 拒连……）。
  async navigate(url: string): Promise<{ ms: number; settled: boolean; errorText: string }> {
    const t0 = Date.now();
    const loaded = new Promise<void>((res) => this.loadWaiters.push(res));
    const r = await this.send("Page.navigate", { url });
    this.url = url;
    if (r?.loaderId) await Promise.race([loaded, delay(10_000)]); // 没有 loaderId = 同文档跳转（只改 #hash），没有 load 事件
    const s = await this.settle({ since: t0, quietMs: 300, maxMs: 3000 });
    return { settled: s.settled, ms: Date.now() - t0, errorText: String(r?.errorText || "") };
  }

  // history: -1 = back, +1 = forward. Returns the URL we moved to, or null when
  // there is no entry in that direction.
  async history(dir: -1 | 1): Promise<string | null> {
    const h = await this.send("Page.getNavigationHistory", {});
    const next = (h?.currentIndex ?? 0) + dir;
    const entry = h?.entries?.[next];
    if (!entry) return null;
    const t0 = Date.now();
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    this.url = entry.url;
    await delay(60); // 让 frameStartedLoading 先到，settle 才知道在加载
    await this.settle({ since: t0, quietMs: 300, maxMs: 6000 });
    return String(entry.url);
  }

  // ── 等页面安定 ────────────────────────────────────────────────────────────
  // 每 ~80ms 看一次：主框架不在加载、页面 DOM 变动计数（页内 MutationObserver）与地址连续 quietMs 不变、since 之后发出
  // 的请求都已落定（长轮询 / SSE / WebSocket 与挂了 4 秒以上的不算）。满足即返回；页面一直在变（动画、轮播、时钟）就到
  // maxMs 为止。（截图前等动画跑完的是另一回事，见 settleAnimations。）
  async settle({ since = Date.now(), quietMs = 250, maxMs = 2000 }: { since?: number; quietMs?: number; maxMs?: number } = {}): Promise<{ settled: boolean; ms: number }> {
    const t0 = Date.now();
    let last: unknown = null;
    let quietFrom = 0;
    while (Date.now() - t0 < maxMs) {
      const loading = this.loading && Date.now() - this.loadingSince < 15_000;
      const busy = this.pendingRequests(since).length > 0;
      const key = await this.send("Runtime.evaluate", { expression: MUTATION_KEY, returnByValue: true }, 1500).then(
        (x) => x?.result?.value ?? null,
        () => null,
      );
      if (key != null && key === last && !loading && !busy) {
        if (!quietFrom) quietFrom = Date.now();
        if (Date.now() - quietFrom >= quietMs) return { settled: true, ms: Date.now() - t0 };
      } else {
        quietFrom = 0;
      }
      last = key;
      await delay(80);
    }
    return { settled: false, ms: Date.now() - t0 };
  }

  // since 之后发出、还没落定的请求（settle 与动作结果用）。
  pendingRequests(since = 0): NetEntry[] {
    const now = Date.now();
    return this.netOrder.filter(
      (e) => e.state === "pending" && e.t >= since && now - e.t < 4000 && !LONG_LIVED.has(String(e.resourceType || "")),
    );
  }

  // agent 给的 x,y（最近一张整屏截图里的像素）→ 页面 CSS 像素。截图是 1:1 时原样；缩过的图按帧比例换算。
  // 越界、截图后视口或标签变了（且比例不是 1）直接报错，让 agent 重新截图，而不是悄悄点到别处。
  frameToCss(x: number, y: number): { x: number; y: number; k: number } {
    const vw = this.measured?.w || this.viewport.width;
    const vh = this.measured?.h || this.viewport.height;
    const f = this.frame;
    const fresh = Boolean(f && f.targetId === this.activeTargetId && f.vpW === this.viewport.width && f.vpH === this.viewport.height);
    if (f && Math.abs(f.k - 1) > 0.001 && !fresh) {
      throw new Error("the viewport or tab changed since the last screenshot, so its coordinates no longer line up — take a new screenshot and give x,y from it");
    }
    const k = fresh && f ? f.k : 1;
    const w = fresh && f ? f.imgW : vw;
    const h = fresh && f ? f.imgH : vh;
    if (!(x >= 0 && y >= 0 && x < w && y < h)) {
      throw new Error(
        `(${x}, ${y}) is outside ${fresh ? `the last screenshot (${w}×${h})` : `the viewport (${w}×${h})`} — give pixels you see in the screenshot, or target by ref / text instead`,
      );
    }
    return { x: x * k, y: y * k, k };
  }

  // 页面自己量视口（innerWidth / DPR / 触屏 / 配色）
  async measure(): Promise<MeasuredViewport | null> {
    try {
      const m = await this.eval(
        "({w:innerWidth,h:innerHeight,dpr:Math.round(devicePixelRatio*1000)/1000,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer:coarse)').matches,dark:matchMedia('(prefers-color-scheme: dark)').matches,sx:scrollX,sy:scrollY})",
      );
      return m && typeof m === "object" && m.w > 0 ? { ...m, at: Date.now() } : null;
    } catch {
      return null;
    }
  }

  async title(): Promise<string> {
    try {
      return String((await this.eval("document.title")) ?? "");
    } catch {
      return "";
    }
  }

  // U5（MiMo 反馈）：截图以前立刻取帧——切页、点完按钮马上截，拍到的是旧页或动画的半截。现在：
  //   · 默认先等：字体加载完、正在跑的有限长 CSS / JS 动画（过渡、一次性 keyframes）跑完，再等两帧，最多 SETTLE_MAX_MS；
  //     无限循环的动画（转圈）不等。waitMs > 0 先固定等这么久再做上面这步（等数据加载）；waitMs = 0 立刻截（就要半截的那一帧）。
  //   · 只截一块：selector（CSS）或 ref（ReadPage 的 [refN]）截那个元素（不在视口里先滚进来），clip 截视口坐标里的一块矩形。
  async screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const group = "dimensio-shot";
    try {
      let el: string | null = null;
      if (opts.selector != null || opts.ref != null) {
        el = await this.shotElement(opts, group);
        await this.callOn(el, "function(){const r=this.getBoundingClientRect();if(r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth)this.scrollIntoView({block:r.height>innerHeight?'start':'center',inline:'center',behavior:'instant'});}");
      }
      const waitMs = opts.waitMs == null ? null : Math.max(0, Math.min(MAX_SHOT_WAIT_MS, Math.round(opts.waitMs)));
      if (waitMs) await delay(waitMs);
      const settle = waitMs === 0 ? null : await this.settleAnimations(SETTLE_MAX_MS);

      // 截图区域一律换成页面坐标（CSS px）：视口坐标 + 当前滚动量；超出视口的部分才让 Chrome 截视口以外
      let region: ScreenshotResult["region"];
      let beyond = false;
      if (el) {
        const box = await this.callOn(el, "function(){const r=this.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,sx:scrollX,sy:scrollY,vw:innerWidth,vh:innerHeight};}");
        if (!box || box.width < 1 || box.height < 1) {
          throw new Error(`${opts.ref != null ? `ref${opts.ref}` : `selector ${opts.selector}`} has no visible box (display:none, zero size, or detached)`);
        }
        region = clampRegion({ x: box.left + box.sx, y: box.top + box.sy, width: box.width, height: box.height });
        beyond = box.top < 0 || box.left < 0 || box.top + region.height > box.vh || box.left + region.width > box.vw;
      } else if (opts.clip) {
        const raw = opts.clip;
        if (![raw.x, raw.y, raw.width, raw.height].every(Number.isFinite) || raw.width < 1 || raw.height < 1) {
          throw new Error("clip needs numeric x, y, width, height (pixels of the last screenshot), width and height ≥ 1");
        }
        // clip 与 click 的 x,y 同一个坐标系＝最近那张整屏截图的像素：缩过的图按帧比例换回 CSS px
        const k = this.frameScale();
        const c = { x: raw.x * k, y: raw.y * k, width: raw.width * k, height: raw.height * k };
        const v = await this.eval("({sx:scrollX,sy:scrollY,vw:innerWidth,vh:innerHeight})");
        region = clampRegion({ x: c.x + v.sx, y: c.y + v.sy, width: c.width, height: c.height });
        beyond = c.x < 0 || c.y < 0 || c.x + region.width > v.vw || c.y + region.height > v.vh;
      }
      if (region) {
        const r = await this.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: beyond,
          clip: { x: region.x, y: region.y, width: region.width, height: region.height, scale: 1 },
        });
        if (!r?.data) throw new Error("captureScreenshot returned no data");
        return { png: Buffer.from(r.data, "base64"), region, settle };
      }
      // 整屏：一律出成「CSS 像素 1:1、长边不超过 SHOT_MAX_PX」并记帧——桌面壳按显示器 DPR 渲染、视口宽过 1568 时
      // provider 又会再缩一次，原样截的图模型按图算坐标全对不上。之后 click(x,y) 由 frameToCss 换算回去。
      const m = await this.measure();
      if (m) this.measured = m;
      const cssW = m?.w || this.viewport.width;
      const cssH = m?.h || this.viewport.height;
      const dpr = m?.dpr && m.dpr > 0 ? m.dpr : 1;
      const fit = Math.min(1, SHOT_MAX_PX / Math.max(cssW, cssH));
      const params: Record<string, unknown> = { format: "png", captureBeyondViewport: false };
      if (Math.abs(dpr - 1) > 0.01 || fit < 1) {
        params.clip = { x: m?.sx ?? 0, y: m?.sy ?? 0, width: cssW, height: cssH, scale: fit / dpr };
      }
      const png = await this.capture(params, Math.round(cssW * fit));
      const { width: imgW, height: imgH } = pngSize(png);
      this.frame = {
        imgW: imgW || Math.round(cssW * fit),
        imgH: imgH || Math.round(cssH * fit),
        k: imgW ? cssW / imgW : 1 / fit,
        vpW: this.viewport.width,
        vpH: this.viewport.height,
        targetId: this.activeTargetId,
        t: Date.now(),
      };
      return { png, settle, frame: this.frame };
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  }

  // 最近那张整屏截图的「CSS / 图片像素」比（帧过期或没有 = 1）
  frameScale(): number {
    const f = this.frame;
    return f && f.targetId === this.activeTargetId && f.vpW === this.viewport.width && f.vpH === this.viewport.height ? f.k : 1;
  }

  // 带 clip 的截图出图宽度应为 wantW：偏了（桌面壳里 clip.scale 与 zoom 叠出来的语义和文档不一致）就按比例重截一次。
  private async capture(params: Record<string, unknown>, wantW: number): Promise<Buffer> {
    let r = await this.send("Page.captureScreenshot", params);
    if (!r?.data) throw new Error("captureScreenshot returned no data");
    let buf = Buffer.from(r.data, "base64");
    const clip = params.clip as { scale: number } | undefined;
    const got = pngSize(buf).width;
    if (clip && wantW > 0 && got > 0 && Math.abs(got - wantW) > 2) {
      r = await this.send("Page.captureScreenshot", { ...params, clip: { ...clip, scale: clip.scale * (wantW / got) } });
      if (r?.data) buf = Buffer.from(r.data, "base64");
    }
    return buf;
  }

  private async shotElement(opts: ScreenshotOptions, group: string): Promise<string> {
    if (opts.ref != null) {
      const { backendId } = this.refInfo(opts.ref);
      const { object } = await this.send("DOM.resolveNode", { backendNodeId: backendId, objectGroup: group });
      if (!object?.objectId) throw new Error(`ref${opts.ref}: element is gone (page changed since ReadPage) — ReadPage again`);
      return object.objectId;
    }
    const sel = String(opts.selector);
    const r = await this.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, objectGroup: group });
    if (r?.exceptionDetails) throw new Error(`invalid CSS selector ${JSON.stringify(sel)}`);
    if (!r?.result?.objectId) throw new Error(`no element matches selector ${JSON.stringify(sel)}`);
    return r.result.objectId;
  }

  private async callOn(objectId: string, fn: string): Promise<any> {
    const r = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page script failed");
    return r?.result?.value;
  }

  // 等页面「停下来」：字体、有限长的动画，最后两帧（后台页的 rAF 可能不跑，每帧最多等 100ms）。
  // 返回等了多久、到点时还有几个动画没跑完（那张截图可能是半截的，结果里要说）。
  private async settleAnimations(maxMs: number): Promise<{ waitedMs: number; stillRunning: number }> {
    const js = `(async (maxMs) => {
      const t0 = performance.now();
      const left = () => Math.max(0, maxMs - (performance.now() - t0));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const frame = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(100)]);
      try { if (document.fonts && document.fonts.status !== "loaded") await Promise.race([document.fonts.ready, sleep(left())]); } catch {}
      const busy = () => document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
        return Number.isFinite(end);
      });
      let running = busy();
      while (running.length && left() > 0) {
        await Promise.race([Promise.allSettled(running.map((a) => a.finished)), sleep(Math.min(100, left()))]);
        running = busy();
      }
      await frame();
      await frame();
      return { waitedMs: Math.round(performance.now() - t0), stillRunning: running.length };
    })(${Math.round(maxMs)})`;
    try {
      const r = await this.eval(js);
      return { waitedMs: Number(r?.waitedMs) || 0, stillRunning: Number(r?.stillRunning) || 0 };
    } catch {
      return { waitedMs: 0, stillRunning: 0 }; // 页面拒绝脚本（CSP 之类）就不等，照常截
    }
  }

  // ── Accessibility snapshot ──────────────────────────────────────────────────

  // Read the page as an indented accessibility tree. Interactive nodes get a
  // [refN] tag; refs stay valid until the next snapshot or navigation.
  async axSnapshot(
    opts: { filter?: "all" | "interactive"; query?: string; maxChars?: number; rootBackendId?: number; depth?: number } = {},
  ): Promise<AxSnapshot> {
    const filter = opts.filter ?? "all";
    const maxChars = Math.max(2000, Math.min(80_000, opts.maxChars ?? 20_000));
    const r = await this.send("Accessibility.getFullAXTree", {});
    const nodes: any[] = r?.nodes ?? [];
    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(String(n.nodeId), n);
    // rootBackendId：只列这个 DOM 节点的子树（ReadPage(ref)）；depth：从根往下最多展开几层
    const root = opts.rootBackendId != null
      ? nodes.find((n) => n.backendDOMNodeId === opts.rootBackendId)
      : (nodes.find((n) => !n.parentId) ?? nodes[0]);
    if (!root) {
      if (opts.rootBackendId != null) throw new Error("that element is no longer in the accessibility tree (the page changed) — ReadPage again for fresh refs");
      return { text: "(empty accessibility tree)", refCount: 0, lineCount: 0, truncated: false };
    }
    const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : Infinity;

    // Link lines end with their address (same-origin as path only, no javascript:, capped at 120 chars)
    // so the model can navigate without an extra Eval over querySelectorAll.
    const pageRoot = nodes.find((n) => String(n.role?.value ?? "") === "RootWebArea" && axUrl(n)) ?? nodes.find((n) => !n.parentId);
    let origin = "";
    try { origin = new URL(axUrl(pageRoot)).origin; } catch { /* no page url on the root: write links in full */ }
    const linkUrl = (node: any, name: string): string => {
      const url = axUrl(node);
      if (!url || /^javascript:/i.test(url)) return "";
      let shown = url;
      try {
        const u = new URL(url);
        if (origin && origin !== "null" && u.origin === origin) shown = u.pathname + u.search + u.hash;
      } catch { /* not a parseable URL: keep as is */ }
      if (shown === name || url === name) return "";
      return ` → ${shown.length > 120 ? `${shown.slice(0, 119)}…` : shown}`;
    };

    this.refs.clear();
    let refN = 0;
    const lines: string[] = [];

    const emit = (node: any, depth: number): void => {
      const role = String(node.role?.value ?? "").toLowerCase();
      const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const children: any[] = (node.childIds ?? [])
        .map((id: string) => byId.get(String(id)))
        .filter(Boolean);

      if (SKIP_ROLES.has(role)) return;
      if (node.ignored || (PROMOTE_ROLES.has(role) && !name)) {
        for (const c of children) emit(c, depth);
        return;
      }

      const states: string[] = [];
      for (const p of node.properties ?? []) {
        const pn = String(p.name ?? "");
        const pv = p.value?.value;
        if (pn === "focusable" || pn === "readonly" || pv === false || pv == null) continue;
        if (["focused", "disabled", "required", "expanded", "selected", "pressed", "checked", "invalid", "multiline", "editable", "autocomplete", "haspopup", "level"].includes(pn)) {
          states.push(pv === true ? pn : `${pn}=${pv}`);
        }
      }
      const value = node.value?.value != null && String(node.value.value).trim() !== ""
        ? ` value="${String(node.value.value).replace(/\s+/g, " ").slice(0, 80)}"`
        : "";

      let refTag = "";
      const editable = (node.properties ?? []).some((p: any) => p.name === "editable" && p.value?.value);
      if ((INTERACTIVE_ROLES.has(role) || editable) && node.backendDOMNodeId != null) {
        refN++;
        this.refs.set(refN, { backendId: node.backendDOMNodeId, role, name });
        refTag = ` [ref${refN}]`;
      }

      const displayRole = role === "statictext" ? "text" : role;
      // Drop a StaticText child that merely repeats its parent's name (the
      // dominant pattern under links/buttons/headings) — pure noise.
      const href = role === "link" ? linkUrl(node, name) : "";
      const line = `${"  ".repeat(depth)}- ${displayRole}${name ? ` "${name}"` : ""}${refTag}${value}${states.length ? ` (${states.join(", ")})` : ""}${href}`;
      const isRefLine = refTag !== "";
      if (filter === "all" || isRefLine) {
        lines.push(filter === "interactive" ? line.trimStart() : line);
      }

      if (depth + 1 > maxDepth) return;
      for (const c of children) {
        const cRole = String(c.role?.value ?? "").toLowerCase();
        const cName = String(c.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (cRole === "statictext" && cName && cName === name) continue;
        emit(c, depth + 1);
      }
    };
    emit(root, 0);

    let out = lines;
    if (opts.query) {
      const q = opts.query.toLowerCase();
      out = lines.filter((l) => l.toLowerCase().includes(q)).map((l) => l.trimStart());
    }

    const total = out.length;
    let text = out.join("\n");
    let truncated = false;
    if (text.length > maxChars) {
      truncated = true;
      text = text.slice(0, maxChars);
      const cut = text.lastIndexOf("\n");
      if (cut > 0) text = text.slice(0, cut);
      const kept = text.split("\n").length;
      text += `\n… (truncated: showing ${kept} of ${total} lines — narrow with query or filter:"interactive")`;
    }
    if (!text.trim()) text = opts.query ? `(no nodes matching "${opts.query}")` : "(empty accessibility tree)";
    return { text, refCount: refN, lineCount: total, truncated };
  }

  refInfo(ref: number): { backendId: number; role: string; name: string } {
    const e = this.refs.get(ref);
    if (!e) {
      throw new Error(`ref${ref} is unknown — refs come from ReadPage and reset on every snapshot/navigation. Run ReadPage again.`);
    }
    return e;
  }

  // Scroll a ref's element into view and return its viewport center. Uses
  // DOM.resolveNode + callFunctionOn (works even where getBoxModel is flaky).
  async refCenter(ref: number): Promise<{ x: number; y: number; objectId: string }> {
    const { backendId } = this.refInfo(ref);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: backendId });
    if (!object?.objectId) throw new Error(`ref${ref}: element is gone (page changed since ReadPage)`);
    const r = await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration:
        "function(){ this.scrollIntoView({block:'center',inline:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }",
      returnByValue: true,
    });
    const c = r?.result?.value;
    if (!c || c.w === 0 || c.h === 0) throw new Error(`ref${ref}: element has no visible box (hidden?)`);
    await delay(100);
    return { x: c.x, y: c.y, objectId: String(object.objectId) };
  }

  subscribePointer(cb: (p: PointerEcho) => void): () => void {
    this.pointerSubs.add(cb);
    return () => this.pointerSubs.delete(cb);
  }

  private echoPointer(kind: PointerEcho["kind"], x: number, y: number, source: PointerEcho["source"]): void {
    for (const cb of this.pointerSubs) {
      try {
        cb({ kind, x: Math.round(x), y: Math.round(y), source });
      } catch {
        /* subscriber's problem */
      }
    }
  }

  async dispatchClick(
    x: number,
    y: number,
    opts: { button?: "left" | "right"; clickCount?: number; modifiers?: number; source?: "agent" | "user" } = {},
  ): Promise<void> {
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    const modifiers = opts.modifiers ?? 0;
    // 触屏仿真（resize 到手机 / 平板档）下左键改发真触摸：此时开着 setEmitTouchEventsForMouse，合成的 mousePressed 被转成
    // touchstart 后回执要等整个手势结束才回，而 mouseReleased 要等这个回执才发——互等 30 秒超时，页面永远等不到 click
    // （agent 与用户在面板里手点都一样；bridge 10-07 踩过）。dispatchTouchEvent 是触屏下的正路，手势识别照常合成 click。
    if (this.emu.mobile && button === "left" && !modifiers) {
      for (let i = 0; i < clickCount; i++) {
        await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      this.echoPointer("click", x, y, opts.source ?? "agent");
      return;
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
    }
    this.echoPointer("click", x, y, opts.source ?? "agent");
  }

  async clickRef(ref: number, opts: { button?: "left" | "right"; clickCount?: number } = {}): Promise<void> {
    const c = await this.refCenter(ref);
    await this.dispatchClick(c.x, c.y, opts);
  }

  async clickCoord(
    x: number,
    y: number,
    opts: { button?: "left" | "right"; clickCount?: number; source?: "agent" | "user" } = {},
  ): Promise<void> {
    await this.dispatchClick(x, y, opts);
  }

  // Click by visible text (best match among interactive elements) — the escape
  // hatch when the model skipped ReadPage.
  async clickText(text: string): Promise<void> {
    const c = await this.findTextPoint(text);
    await this.dispatchClick(c.x, c.y);
  }

  // 按可见文本找可交互元素（滚进视口），返回中心点 CSS 坐标；找不到抛错。
  async findTextPoint(text: string): Promise<{ x: number; y: number }> {
    const needle = JSON.stringify(text.toLowerCase());
    const c = await this.eval(
      `(()=>{const n=${needle};const sel='a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label';
       const nodes=Array.from(document.querySelectorAll(sel)).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
       const t=el=>(el.getAttribute('aria-label')||el.value||el.innerText||el.textContent||el.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().toLowerCase();
       let hit=nodes.find(el=>t(el)===n)||nodes.find(el=>t(el).includes(n));
       if(!hit)return null;hit.scrollIntoView({block:'center'});const r=hit.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    if (!c) throw new Error(`no clickable element matching text "${text}" — try another word, or Browser(find) / ReadPage for a ref`);
    await delay(60); // 等 scrollIntoView 落定再点
    return c;
  }

  // ── 手势：长按 / 拖拽 / 双指缩放 ──────────────────────────────────────────
  // 触屏档（emu.mobile）走真触摸事件，浏览器自己的手势管线照常判；鼠标档：按下 → 插值移动（带 buttons）→ 松开。

  async longPress(x: number, y: number, holdMs = 800): Promise<void> {
    const hold = Math.max(100, Math.min(10_000, Number(holdMs) || 800));
    if (this.emu.mobile) {
      // 不能用 dispatchTouchEvent：注入的触摸绕过浏览器侧的手势识别，按多久都只合成 tap。触屏档开着
      // setEmitTouchEventsForMouse，鼠标事件经触摸仿真器转成触摸、由它做手势识别，长按真补 contextmenu。这对事件的
      // 回执要等整个手势收尾、而收尾又在等回执——互相挂住（见 dispatchClick），所以两下都不 await，回执超时静默丢掉。
      const quiet = (type: string, buttons: number) =>
        this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, hold + 3_000).catch(() => {});
      void quiet("mousePressed", 1);
      await delay(hold);
      void quiet("mouseReleased", 0);
      await delay(150);
    } else {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await delay(hold);
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    }
    this.echoPointer("click", x, y, "agent");
  }

  // 返回 { html5 }：鼠标档里起点是 HTML5 可拖元素时，开 setInterceptDrags 把系统拖放接住，改发 dragEnter / dragOver / drop——
  // 不接的话 headless 里 dragstart 之后永远等不到 drop，有头视图（桌面壳）还会进系统拖放循环把窗口卡住。
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    { steps = 16, holdMs = 0 }: { steps?: number; holdMs?: number } = {},
  ): Promise<{ html5: boolean }> {
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 16)));
    const hold = Math.max(0, Math.min(5_000, Number(holdMs) || 0));
    const at = (i: number) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
    if (this.emu.mobile) {
      // 触点带显式 id、抬起时点名：不带 id 的触点在 CDP 那边会残留，下一场双指里冒出第三根手指
      const pt = (p: { x: number; y: number }) => [{ x: p.x, y: p.y, id: 0 }];
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(from) });
      if (hold) await delay(hold);
      for (let i = 1; i <= n; i++) {
        await this.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(at(i)) });
        await delay(16);
      }
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: pt(to) });
      this.echoPointer("move", to.x, to.y, "agent");
      return { html5: false };
    }
    const draggable = await this.eval(
      `(()=>{const e=document.elementFromPoint(${from.x},${from.y});if(!e)return false;
      const d=e.closest('[draggable]');if(d)return d.getAttribute('draggable')!=='false';
      if(e.closest('a[href],img'))return true;const s=getSelection();return !!(s&&!s.isCollapsed&&s.containsNode(e,true));})()`,
    ).catch(() => false);
    let intercept = false;
    if (draggable) {
      intercept = await this.send("Input.setInterceptDrags", { enabled: true }).then(() => true, () => false);
      if (!intercept) {
        throw new Error("the drag starts on an HTML5-draggable element, but this browser does not accept drag interception (old desktop shell?) — not dragging, to avoid wedging the window");
      }
    }
    let data: unknown = null;
    this.onDragIntercepted = (p) => {
      data = p?.data || null;
    };
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      if (hold) await delay(hold);
      let i = 1;
      for (; i <= n && !data; i++) {
        const p = at(i);
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
        await delay(16);
      }
      if (data) {
        // 拖放从第 i-1 步接管：dragEnter 落在当时的位置，dragOver 走完剩下的路，最后在终点 drop
        const start = at(i - 1);
        await this.send("Input.dispatchDragEvent", { type: "dragEnter", x: start.x, y: start.y, data });
        for (; i <= n; i++) {
          const p = at(i);
          await this.send("Input.dispatchDragEvent", { type: "dragOver", x: p.x, y: p.y, data });
          await delay(16);
        }
        await this.send("Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data });
        await this.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
      }
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    } finally {
      this.onDragIntercepted = null;
      if (intercept) await this.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
    }
    this.echoPointer("move", to.x, to.y, "agent");
    return { html5: Boolean(data) };
  }

  // 双指缩放：以 (x,y) 为中心，两指从 ±r 开到 ±r×scale（scale>1 放大、<1 捏合）。只在触屏档有意义。
  async pinch(x: number, y: number, scale = 2, { steps = 12, radius = 60 }: { steps?: number; radius?: number } = {}): Promise<void> {
    if (!this.emu.mobile) throw new Error('pinch only works in touch mode — Browser(resize, preset:"mobile") first');
    const s = Math.max(0.1, Math.min(10, Number(scale) || 2));
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 12)));
    const pts = (r: number) => [{ x: x - r, y, id: 0 }, { x: x + r, y, id: 1 }];
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(radius) });
    for (let i = 1; i <= n; i++) {
      await this.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(radius * (1 + ((s - 1) * i) / n)) });
      await delay(16);
    }
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: pts(radius * s) });
  }

  async hoverRef(ref: number): Promise<void> {
    const c = await this.refCenter(ref);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
    this.echoPointer("move", c.x, c.y, "agent");
  }

  async hoverCoord(x: number, y: number, source: "agent" | "user" = "agent"): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    this.echoPointer("move", x, y, source);
  }

  async focusRef(ref: number): Promise<void> {
    const { backendId } = this.refInfo(ref);
    await this.send("DOM.focus", { backendNodeId: backendId });
  }

  // 聚焦目标（ref 或 CSS selector；都没给就保持当前焦点）。
  async focusTarget(target?: { ref?: number; selector?: string }): Promise<void> {
    if (target?.ref != null) {
      await this.focusRef(target.ref);
    } else if (target?.selector) {
      const ok = await this.eval(
        `(()=>{const e=document.querySelector(${JSON.stringify(target.selector)});if(!e)return false;e.focus();return true;})()`,
      );
      if (!ok) throw new Error(`no element matching selector ${target.selector}`);
    }
  }

  // Focus a target (by ref or CSS selector) and type text into it.
  async typeText(text: string, target?: { ref?: number; selector?: string }): Promise<void> {
    await this.focusTarget(target);
    await this.send("Input.insertText", { text });
  }

  // ref（ReadPage / find 的句柄）或 CSS selector → 元素的 objectId。
  async objectFor(target: { ref?: number; selector?: string } = {}): Promise<string> {
    if (target.ref != null) {
      const { backendId } = this.refInfo(target.ref);
      const { object } = await this.send("DOM.resolveNode", { backendNodeId: backendId });
      if (!object?.objectId) throw new Error(`ref${target.ref}: element is gone (page changed since ReadPage)`);
      return String(object.objectId);
    }
    if (target.selector) {
      const r = await this.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(target.selector)})`, returnByValue: false });
      if (r?.exceptionDetails) throw new Error(`invalid CSS selector ${JSON.stringify(target.selector)}`);
      if (!r?.result?.objectId) throw new Error(`no element matching selector ${target.selector}`);
      return String(r.result.objectId);
    }
    throw new Error("needs ref or selector");
  }

  // 直接设表单控件的值（对齐 bridge 的 set_value / Claude Code 桌面端 Browser 的 form_input）：原生 <select> 的下拉层
  // 截图里看不见、点开也选不了；date / time / range / color 打字进不去。按控件类型设值，走原型上的 value setter
  // （React 等受控组件认这个），再派发 input + change。
  async setValue(
    target: { ref?: number; selector?: string },
    value: unknown,
  ): Promise<{ ok: boolean; kind?: string; desc?: string; now?: string; why?: string; options?: string[] }> {
    const objectId = await this.objectFor(target);
    const r = await this.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      arguments: [{ value }],
      functionDeclaration: `function(v){
        const el = this, tag = el.tagName, desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.name ? '[name=' + e.name + ']' : '');
        const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        const truthy = (x) => x === true || /^(true|1|on|yes|checked)$/i.test(String(x));
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        if (el.disabled) return { ok: false, why: desc(el) + ' is disabled' };
        if (tag === 'SELECT') {
          const opts = [...el.options], want = Array.isArray(v) ? v.map(String) : [String(v)];
          const pick = (w) => opts.find((o) => o.value === w) || opts.find((o) => o.text.trim() === w.trim()) || opts.find((o) => o.text.toLowerCase().includes(w.trim().toLowerCase()));
          const hits = want.map(pick);
          if (hits.some((h) => !h)) return { ok: false, why: 'no option matches "' + want.join('", "') + '"', options: opts.slice(0, 30).map((o) => o.text.trim() + (o.value !== o.text.trim() ? ' (' + o.value + ')' : '')) };
          if (el.multiple) opts.forEach((o) => { o.selected = hits.includes(o); }); else el.value = hits[0].value;
          fire();
          return { ok: true, kind: 'select', desc: desc(el), now: [...el.selectedOptions].map((o) => o.text.trim()).join(', ') };
        }
        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          const on = truthy(v);
          if (el.checked !== on) { el.click(); if (el.checked !== on) { el.checked = on; fire(); } }
          return { ok: true, kind: el.type, desc: desc(el), now: el.checked ? 'checked' : 'unchecked' };
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (el.type === 'file') return { ok: false, why: 'file inputs take Browser(upload)' };
          const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          el.focus();
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
          fire();
          const ok = el.value === String(v) || el.type === 'range' || el.type === 'number';
          return { ok, kind: el.type || 'textarea', desc: desc(el), now: el.value, why: ok ? '' : 'the control turned the value into "' + el.value + '" (wrong format? date = YYYY-MM-DD, time = HH:MM, color = #rrggbb)' };
        }
        if (el.isContentEditable) {
          el.focus();
          const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
          if (!document.execCommand('insertText', false, String(v))) el.textContent = String(v);
          return { ok: true, kind: 'contenteditable', desc: desc(el), now: el.textContent.slice(0, 80) };
        }
        return { ok: false, why: desc(el) + ' is not a settable form control (select / input / textarea / contenteditable) — use click for buttons' };
      }`,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "set_value failed");
    return r?.result?.value || { ok: false, why: "no result" };
  }

  // 页面正文：article / main / [role=main] 优先，退回 body——读文章、文档比 ReadPage 的无障碍树省得多。
  // 正文里有 open shadow DOM 时按扁平树取字（Web Components 渲染的代码示例、日期不再丢）；连续重复的长行折成「行（×N）」。
  async pageText(maxChars = 20_000): Promise<{ from: string; title: string; text: string; total: number; truncated: boolean; shadow: number }> {
    const cap = Math.max(1000, Math.min(100_000, Number(maxChars) || 20_000));
    const core = loadPageTextCore();
    const r = await this.eval(core ? core.pageTextExpression({ limit: cap * 4 }) : PAGE_TEXT_PLAIN);
    const raw = String(r?.text || "");
    const text = core ? core.foldRepeatedLines(raw) : raw;
    return {
      from: String(r?.from || ""), title: String(r?.title || ""), text: text.length > cap ? text.slice(0, cap) : text,
      total: text.length, truncated: text.length > cap || !!r?.more, shadow: Number(r?.shadow) || 0,
    };
  }

  // 往 <input type=file> 塞本机文件（DOM.setFileInputFiles）：隐藏的 input 同样有效，Chrome 照常派发 input / change。
  // 目标 = ref / CSS selector / 默认「此刻看得见的那部分页面里」的第一个文件框（后台常驻分页里的不算）。先验目标真是
  // file input，再塞，再回读文件名——不接受多选的框只保留第一个。
  async setInputFiles(
    files: string[],
    target: { ref?: number; selector?: string } = {},
  ): Promise<{ names: string[]; target: string; multiple: boolean; dropped: boolean }> {
    let objectId = "";
    let chosenNote = "";
    if (target.ref != null || target.selector) {
      objectId = await this.objectFor(target);
    } else {
      const pick = await this.send("Runtime.evaluate", {
        returnByValue: false,
        expression: `(() => {
          const all = [...document.querySelectorAll('input[type=file]')];
          const shown = (el) => { const p = el.parentElement; if (!p) return false;
            try { return p.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); } catch { return p.getClientRects().length > 0; } };
          const vis = all.filter(shown);
          const desc = (el) => { const bits = []; let n = el.parentElement;
            for (let k = 0; n && k < 3; k++, n = n.parentElement) { const c = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).find((x) => !/^svelte-/.test(x)) : ''; bits.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : c ? '.' + c : '')); }
            return (el.multiple ? 'multiple ' : '') + (el.accept ? 'accept=' + el.accept + ' ' : '') + 'in ' + bits.join(' < '); };
          const el = vis[0] || null;
          window.__dimensioUploadPick = { total: all.length, visible: vis.length, chosen: el ? desc(el) : '', others: vis.slice(1, 5).map(desc) };
          return el;
        })()`,
      });
      objectId = String(pick?.result?.objectId ?? "");
      const meta = await this.send("Runtime.evaluate", { expression: "window.__dimensioUploadPick", returnByValue: true }).then(
        (x) => x?.result?.value || {},
        () => ({}),
      );
      if (!objectId) {
        throw new Error(
          meta.total
            ? `the page has ${meta.total} file input(s), but all of them are in parts that are not shown (background tabs / collapsed panels) — open the upload UI first, or pass selector / ref`
            : "the page has no <input type=file>",
        );
      }
      chosenNote = ` (picked the file input in the visible part of the page: ${meta.chosen}${meta.others?.length ? `; ${meta.others.length} more visible: ${meta.others.join(" | ")} — pass selector / ref to pick another` : ""})`;
    }
    const probe = await this.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration:
        "function(){ const ok = this instanceof HTMLInputElement && this.type === 'file'; return { ok, tag: this.tagName, type: this.type || '', multiple: !!this.multiple, id: this.id || '', name: this.name || '' }; }",
    });
    const info = probe?.result?.value || {};
    if (!info.ok) {
      throw new Error(`the target is not an <input type=file> (it is ${info.tag || "?"}${info.type ? " type=" + info.type : ""}) — find the file input with ReadPage / find, or pass selector`);
    }
    const list = info.multiple ? files : files.slice(0, 1);
    await this.send("DOM.setFileInputFiles", { files: list, objectId });
    const after = await this.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: "function(){ return [...(this.files || [])].map((f) => f.name); }",
    });
    const label = info.id ? `#${info.id}` : info.name ? `input[name=${info.name}]` : "input[type=file]";
    return { names: after?.result?.value || [], target: label + chosenNote, multiple: Boolean(info.multiple), dropped: !info.multiple && files.length > 1 };
  }

  // ── 面板观看者 ────────────────────────────────────────────────────────────
  addViewer(kind: BrowserViewer["kind"]): () => void {
    const id = ++this.viewerSeq;
    this.viewers.set(id, { kind, since: Date.now() });
    return () => {
      this.viewers.delete(id);
    };
  }

  viewerList(): BrowserViewer[] {
    return [...this.viewers.values()];
  }

  // 桌面壳：当前标签此刻是不是挂在面板里、窗口有没有显示（broker GET target/<id>/view）。旧壳没有这条 → null。
  async shellViewState(): Promise<{ mounted?: boolean; windowShown?: boolean; focused?: boolean; parent?: string } | null> {
    if (!this.desktopBroker || !this.activeTargetId) return null;
    try {
      const res = await fetch(`${this.desktopBroker}/target/${encodeURIComponent(this.activeTargetId)}/view`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const payload = (await res.json()) as any;
      return payload?.ok ? payload : null;
    } catch {
      return null;
    }
  }

  // Press a key or combo ("enter", "ctrl+a", "shift+tab"). Named keys per
  // KEY_DEFS; single characters allowed as the base key of a combo.
  async pressKey(spec: string): Promise<void> {
    const parts = spec.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error("empty key spec");
    let modifiers = 0;
    const mods: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
    while (parts.length > 1 && mods[parts[0]] != null) modifiers |= mods[parts.shift()!];
    const base = parts.join("+");
    let k = KEY_DEFS[base];
    if (!k && base.length === 1) {
      const ch = base;
      const upper = ch.toUpperCase();
      k = {
        key: modifiers & 8 ? upper : ch,
        code: /[a-z]/.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : upper,
        keyCode: upper.charCodeAt(0),
        text: modifiers & ~8 ? undefined : modifiers & 8 ? upper : ch,
      };
    }
    if (!k) {
      throw new Error(`unsupported key "${spec}" (named: ${Object.keys(KEY_DEFS).join("|")}; or a single char, with ctrl/alt/shift/meta+ prefixes)`);
    }
    const ev = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    // Printable keys need `text` on keyDown to actually input/submit.
    const withText = k.text && !(modifiers & ~8) ? { ...ev, text: k.text, unmodifiedText: k.text } : ev;
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...withText });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  }

  async scrollBy(dy: number, dx = 0): Promise<void> {
    await this.eval(`window.scrollBy(${Math.round(dx)}, ${Math.round(dy)})`);
    await delay(200);
  }

  async setViewport(width: number, height: number, mobile = false): Promise<void> {
    const w = Math.round(width);
    const h = Math.round(height);
    // 触屏仿真（手机 / 平板档）：touch 事件 + 移动端 UA + maxTouchPoints，与几何无关，headless 与桌面壳通用。
    // （设备指标覆盖里仍然 mobile:false——那会顺带打开 viewport-meta 语义，没 meta 的页面按 980px 排版，见下。）
    await this.applyTouch(Boolean(mobile), Math.min(w, h) < 600);
    // 桌面壳模式：视口由壳的 WebContentsView 几何决定（面板挂载时按 contain 缩放
    // 摆位 + zoomFactor，见 client/desktop main.cjs 的 mountBrowser）。这里再叠一层
    // 设备指标模拟只会打架：实测 override(1280×900) 撞上 zoom 0.5 会得到 2560×1800
    // 的 CSS 视口，而且 override 比控件大时 Chromium 把画面钉在左上角裁掉——那正是
    // 「预览显示不全」的病根。所以只记录期望视口并广播，让壳去把画面缩到框里。
    if (!this.desktopBroker) {
      // mobile:true is broken on Edge headless=new (viewport comes out scaled by
      // ~2.6 regardless of scale/deviceScaleFactor — verified empirically), so we
      // always emulate with mobile:false. Width-driven responsive layouts and
      // media queries still behave correctly; only touch-event emulation is lost.
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    this.viewport = { width: w, height: h };
    this.notifyViewport();
    // S10 顺手：桌面壳模式以前只记录 + 广播，面板没开 / 手机远端在看 / agent 后台跑时 resize 等于没发生（页面 innerWidth
    // 纹丝不动）。与 bridge 的 cdp.mjs 同一条路：壳的 broker PUT target/<id>/viewport 改逻辑视口；旧壳回裸 404，就只记录。
    if (this.desktopBroker && this.activeTargetId) {
      await fetch(`${this.desktopBroker}/target/${encodeURIComponent(this.activeTargetId)}/viewport`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width: w, height: h }),
        signal: AbortSignal.timeout(4000),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
    await delay(300); // let responsive layout settle
  }

  private async applyTouch(mobile: boolean, phone: boolean): Promise<void> {
    this.emu = { mobile };
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 }).catch(() => {});
    await this.send("Emulation.setEmitTouchEventsForMouse", { enabled: mobile, configuration: "mobile" }).catch(() => {});
    // 桌面档把 navigator.maxTouchPoints 盖成 0：主机若是触屏本，真值是 10，页面会按触屏设备走
    const src = "try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0,configurable:true})}catch(e){}";
    const id = this.touch0.get(this.activeTargetId);
    if (!mobile) {
      if (!id) {
        const r = await this.send("Page.addScriptToEvaluateOnNewDocument", { source: src }).catch(() => null);
        if (r?.identifier) this.touch0.set(this.activeTargetId, String(r.identifier));
      }
      await this.send("Runtime.evaluate", { expression: src }).catch(() => {});
    } else {
      if (id) {
        await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }).catch(() => {});
        this.touch0.delete(this.activeTargetId);
      }
      await this.send("Runtime.evaluate", { expression: "delete navigator.maxTouchPoints" }).catch(() => {});
    }
    if (mobile || this.uaOverridden) {
      if (!this.baseUa) {
        this.baseUa = String(await this.send("Browser.getVersion", {}).then((v) => v?.userAgent ?? "", () => ""));
        if (!this.baseUa) this.baseUa = String(await this.eval("navigator.userAgent").catch(() => ""));
      }
      const ua = mobile ? mobileUserAgent(this.baseUa, phone) : this.baseUa;
      if (ua) await this.send("Emulation.setUserAgentOverride", { userAgent: ua, ...(mobile ? { platform: "Linux armv8l" } : {}) }).catch(() => {});
      this.uaOverridden = mobile;
    }
  }

  // 视口变化广播：面板的设备三档钮点亮靠它，桌面壳还要靠它重新摆放原生视图
  // （agent 自己调 Browser(resize) 时用户那边也得跟上）。
  subscribeViewport(cb: (v: { width: number; height: number }) => void): () => void {
    this.viewportSubs.add(cb);
    return () => this.viewportSubs.delete(cb);
  }

  private notifyViewport(): void {
    const snap = { ...this.viewport };
    for (const cb of this.viewportSubs) {
      try {
        cb(snap);
      } catch {
        /* subscriber's problem */
      }
    }
  }

  async setColorScheme(scheme: "dark" | "light" | "auto"): Promise<void> {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme === "auto" ? "" : scheme }],
    });
    await delay(200);
  }

  // Reload the CURRENT page at an emulated devicePixelRatio ≠ 1 and check every
  // canvas's backing store for DPR-scaling bugs. Real displays run DPR 1.25–3
  // (Windows default scaling, every phone); headless defaults to 1 — the ONE
  // ratio where "size × dpr" feedback loops are symptom-free, so passing
  // screenshots at DPR 1 prove nothing for canvas-drawing pages. The probe
  // reloads (entrance animations re-run under the new DPR), wheel-scrolls
  // through the page with REAL input (programmatic scrollTo does not feed
  // smooth-scroll libraries, so lazy charts would never initialize), samples
  // canvas geometry twice with no input in between, then restores DPR 1.
  async canvasDprProbe(dpr = 2): Promise<CanvasProbeReport> {
    const { width, height } = this.viewport;
    const SAMPLE_JS = `(() => {
      const cs = [...document.querySelectorAll("canvas")].map((cv, i) => {
        const r = cv.getBoundingClientRect();
        return { id: cv.id || ("canvas#" + i), attrW: cv.width, attrH: cv.height, rectW: Math.round(r.width), rectH: Math.round(r.height) };
      });
      return { docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), canvases: cs };
    })()`;
    const setDpr = (v: number) =>
      this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: v, mobile: false });
    try {
      await setDpr(dpr);
      await this.reload();
      await delay(700); // let entrance JS run
      // Cruise with real wheel input so IO/ScrollTrigger reveals and chart
      // entrance animations actually run under the probed DPR. Step count is
      // capped: an exploding page never reaches its own bottom.
      for (let i = 0; i < 60; i++) {
        await this.wheel(Math.floor(width / 2), Math.floor(height / 2), 700);
        await delay(80);
        const done = await this.eval(
          "window.scrollY + innerHeight >= document.documentElement.scrollHeight - 4",
        ).catch(() => true);
        if (done) break;
      }
      await delay(600);
      const s0 = (await this.eval(SAMPLE_JS)) as CanvasProbeSample;
      await delay(1200); // zero input in this window — any growth is a feedback loop
      const s1 = (await this.eval(SAMPLE_JS)) as CanvasProbeSample;
      const verdict = judgeCanvasProbe(s0, s1, dpr);
      return {
        dpr,
        canvasCount: s1.canvases.length,
        ...verdict,
        note: s1.canvases.length === 0 ? "page has no <canvas> — nothing DPR-sensitive to probe" : undefined,
      };
    } finally {
      // Always hand the shared browser back at DPR 1 in a fresh, sane state.
      // 桌面壳模式必须【彻底清掉】模拟：留一个尺寸 override 在真 WebContentsView 上，
      // 画面就会被钉在控件左上角裁掉（见 setViewport 注释）。
      if (this.desktopBroker) await this.send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
      else await setDpr(1).catch(() => {});
      await this.reload().catch(() => {});
    }
  }

  async reload(): Promise<{ settled: boolean; ms: number }> {
    const t0 = Date.now();
    const loaded = new Promise<void>((res) => this.loadWaiters.push(res));
    await this.send("Page.reload", {});
    await Promise.race([loaded, delay(10_000)]);
    const s = await this.settle({ since: t0, quietMs: 300, maxMs: 3000 });
    return { settled: s.settled, ms: Date.now() - t0 };
  }

  private async startCast(): Promise<void> {
    await this.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1600,
      maxHeight: 1600,
      everyNthFrame: 1,
    });
    this.casting = true;
  }

  // Subscribe to live screencast frames. Returns an unsubscribe fn. The cast
  // itself starts with the first subscriber and stops with the last.
  async subscribeCast(cb: (f: CastFrame) => void): Promise<() => void> {
    this.castSubs.add(cb);
    if (this.lastFrame) {
      try {
        cb(this.lastFrame); // immediate first paint for late joiners
      } catch {
        /* ignore */
      }
    }
    if (!this.casting) {
      try {
        await this.startCast();
      } catch (e) {
        this.castSubs.delete(cb);
        throw e;
      }
    }
    return () => {
      this.castSubs.delete(cb);
      if (this.castSubs.size === 0 && this.casting) {
        this.casting = false;
        this.send("Page.stopScreencast", {}).catch(() => {});
      }
    };
  }

  // Raw wheel at page coordinates — scrolls whatever container is under the
  // pointer (window.scrollBy can't reach inner scrollables).
  async wheel(x: number, y: number, deltaY: number, deltaX = 0): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  consoleEntries(): ConsoleEntry[] {
    return this.consoleBuf;
  }

  clearConsole(): void {
    this.consoleBuf = [];
  }

  networkEntries(): NetEntry[] {
    return this.netOrder;
  }

  async responseBody(requestId: string): Promise<{ body: string; base64: boolean }> {
    const r = await this.send("Network.getResponseBody", { requestId });
    return { body: String(r?.body ?? ""), base64: Boolean(r?.base64Encoded) };
  }

  // #64：关自己拉起的浏览器。以前只 child.kill()：在只有 Edge 的机器上 spawn 到的常常只是个
  // 早退的启动壳（自我重启），每关一次就漏一整棵无头 Edge + profile。现在先经 CDP 发
  // Browser.close 让它自己体面退出；等不到、或 spawn 的进程早就先退了，就按 profile 指纹整树收；
  // 最后删 profile（进程退干净前文件锁着，异步重试）。状态同步清掉、收尾在后台跑；返回的
  // Promise 永不 reject，想等它收干净的（测试）就 await。
  // 共享宿主里的会话：只关自己的标签（隔离上下文随之销毁），浏览器进程归宿主——最后一个会话走了宿主才体面退出。
  close(): Promise<void> {
    const owned = this.detach();
    if (owned) return shutdownOwnedBrowser(owned).catch(() => {});
    return this.closing ?? Promise.resolve();
  }

  // 自己拉起的进程还在不在（共享宿主据此判活：锚点页的连接断了不等于进程没了）
  get processAlive(): boolean {
    return this.child != null && this.child.exitCode == null && this.child.signalCode == null && !this.spawnError;
  }

  // 进程退出路径专用：SIGINT/SIGTERM/exit 处理器是同步的，异步收尾来不及跑——同步整树杀、尽力删 profile。
  killNow(): void {
    const owned = this.detach();
    if (!owned) return;
    try {
      owned.bws?.close();
    } catch {
      /* ignore */
    }
    // #77：不用 taskkill /T（会顺着悬空的父 PID 杀到不相干的进程）。根经自己的句柄结束，其余按 profile 指纹同步收掉。
    if (owned.child.pid != null && owned.child.exitCode === null && owned.child.signalCode === null) {
      try {
        owned.child.kill("SIGKILL"); // guard: raw-child-kill ok — 根进程经自己持有的句柄结束（不按 PID 找，不怕复用），子孙随后按 profile 指纹收
      } catch {
        /* already gone */
      }
    }
    reapProfileProcessesSync(owned.profileDir, owned.browser);
    if (owned.tmp) try {
      rmSync(owned.tmp, { recursive: true, force: true });
    } catch {
      /* 收尸器会按指纹收残留 profile */
    }
  }

  // 同步断开本会话的全部连接、清空状态。返回要收尾的自己拉起的浏览器；附着外部 app 或
  // 根本没起来返回 null。
  private detach(): OwnedBrowser | null {
    this.dead = true;
    if (this.hostLease) {
      // 共享宿主：关自己建的标签、销毁自己的隔离上下文（同一条 browser 级连接上按序发出，发完再断开），再还掉宿主引用。
      const lease = this.hostLease;
      this.hostLease = null;
      const targets = [...this.ownedTargets];
      this.ownedTargets.clear();
      const ctx = this.browserContextId;
      this.browserContextId = "";
      const bws = this.browserWs;
      const sent: Promise<unknown>[] = targets.map((targetId) => this.bsend("Target.closeTarget", { targetId }).catch(() => {}));
      if (ctx) sent.push(this.bsend("Target.disposeBrowserContext", { browserContextId: ctx }).catch(() => {}));
      this.browserWs = null;
      this.closing = Promise.allSettled(sent).then(() => {
        try {
          bws?.close();
        } catch {
          /* ignore */
        }
        return lease.release();
      });
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.tabs = [];
      this.activeTargetId = "";
      this.notifyTabs();
      return null;
    }
    if (this.external) {
      // 只关本会话拥有的 target，绝不能动 Electron 本体（里面还有 bridge UI 和别的会话）。
      const targets = [...this.ownedTargets];
      this.ownedTargets.clear();
      const bws = this.browserWs;
      const closing = targets.map((targetId) => this.desktopTarget("DELETE", targetId).catch(() => {}));
      Promise.allSettled(closing).finally(() => {
        try {
          bws?.close();
        } catch {
          /* ignore */
        }
      });
      this.browserWs = null;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.tabs = [];
      this.activeTargetId = "";
      this.notifyTabs();
      return null;
    }
    const owned = { bws: this.browserWs, child: this.child, tmp: this.tmp, profileDir: this.profileDir, browser: this.browserPath };
    this.browserWs = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.child = null;
    this.tmp = "";
    this.tabs = [];
    this.activeTargetId = "";
    this.notifyTabs(); // 观看者收到空列表 = 浏览器已关，面板回「未启动」空态
    if (owned.child) return { ...owned, child: owned.child };
    // 附着外部 app（不归我们管，只断开），或 spawn 当场失败只留下了 profile 目录。
    try {
      owned.bws?.close();
    } catch {
      /* ignore */
    }
    if (owned.tmp) {
      try {
        rmSync(owned.tmp, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return null;
  }
}

interface OwnedBrowser {
  bws: WebSocket | null;
  child: ChildProcess;
  tmp: string; // temporary root to delete afterwards; "" = persistent profile (keep it)
  profileDir: string;
  browser: string;
}

const BROWSER_CLOSE_GRACE_MS = 5_000;

async function shutdownOwnedBrowser({ bws, child, tmp, profileDir, browser }: OwnedBrowser): Promise<void> {
  // spawn 出来的进程在我们动手前就已经退了 = 它只是启动壳，真身不在这棵进程树上。
  const launcherOnly = child.exitCode !== null || child.signalCode !== null;
  const exited = launcherOnly ? null : new Promise<void>((r) => child.once("exit", () => r()));
  const socketClosed =
    bws && bws.readyState === WebSocket.OPEN
      ? new Promise<void>((r) => bws.addEventListener("close", () => r(), { once: true }))
      : null;
  if (socketClosed) {
    try {
      bws!.send(JSON.stringify({ id: 0x7fffffff, method: "Browser.close", params: {} }));
    } catch {
      /* 发不出去就走兜底 */
    }
  }
  const gone = exited ?? socketClosed;
  const grace = new Promise<false>((r) => setTimeout(() => r(false), BROWSER_CLOSE_GRACE_MS).unref());
  const inTime = gone ? await Promise.race([gone.then(() => true as const), grace]) : false;
  try {
    bws?.close();
  } catch {
    /* ignore */
  }
  if (!inTime && child.exitCode === null) killTree(child);
  if (launcherOnly || !inTime) await reapProfileProcesses(profileDir, browser);
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

// A persistent profile left behind by a crashed harness: Chromium allows one process per user-data-dir (a second one
// forwards its args to the first and exits), so ask the orphan to quit over CDP (Browser.close flushes cookies),
// then reap whatever still holds the profile, and drop its stale DevToolsActivePort.
async function retireOrphanProfile(profileDir: string, browser: string): Promise<void> {
  const file = path.join(profileDir, "DevToolsActivePort");
  const port = existsSync(file) ? readDevToolsPortFile(file) : null;
  if (port) {
    try {
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json()) as any;
      const wsUrl = String(v?.webSocketDebuggerUrl ?? "");
      if (wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          const timer = setTimeout(done, 4000);
          timer.unref?.();
          ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} })));
          ws.addEventListener("close", () => {
            clearTimeout(timer);
            done();
          });
          ws.addEventListener("error", () => {
            clearTimeout(timer);
            done();
          });
        });
        await delay(300);
      }
    } catch {
      /* nobody listening: the port file is just stale */
    }
  }
  await reapProfileProcesses(profileDir, browser);
  try {
    rmSync(file, { force: true });
  } catch {
    /* the reaper above freed it; next launch rewrites it anyway */
  }
}

// ── 共享无头宿主 ──────────────────────────────────────────────────────────────
// 一个配置档一个无头浏览器进程（Chromium 一个 user-data-dir 同时只能被一个进程打开）：各会话的 CdpSession 都经 joinHost
// 进来、只拥有自己建的标签——网站登录态默认大家共享，也不多占浏览器进程。进程由一个「锚点」CdpSession 拉起并持有
// （markKeeper：它那张空白页在，最后一个会话的标签关掉时进程也不跟着退），引用计数归零就体面退出（Browser.close，
// Cookie 落盘）。键 = 配置档绝对路径；"" = 本进程共用的一次性临时配置档（测试、没开持久配置档时）。

export interface HostLease {
  readonly cdpBase: string;
  readonly port: number;
  readonly alive: boolean;
  release(): Promise<void>;
}

interface HostEntry {
  key: string;
  keeper: CdpSession | null;
  launching: Promise<CdpSession> | null;
  refs: number;
  closing: Promise<void> | null;
}

const hosts = new Map<string, HostEntry>();

async function acquireHost(profileDir: string): Promise<HostLease> {
  const key = profileDir ? path.resolve(profileDir) : "";
  for (;;) {
    const cur = hosts.get(key);
    if (cur?.closing) {
      await cur.closing; // 上一代还在体面退出（配置档还被它占着）：等它退完再起新的
      continue;
    }
    if (cur && !cur.launching && !cur.keeper?.processAlive) {
      void retireHost(cur); // 进程没了（崩了 / 被杀）：收掉旧锚点，重新拉
      continue;
    }
    break;
  }
  let e = hosts.get(key);
  if (!e) {
    const fresh: HostEntry = { key, keeper: null, launching: null, refs: 0, closing: null };
    hosts.set(key, fresh);
    fresh.launching = (async () => {
      const k = new CdpSession();
      try {
        await k.launch("about:blank", { ...(key ? { profileDir: key } : {}), desktop: false });
      } catch (err) {
        await k.close(); // #113：拉起一半的浏览器不能扔下不管
        throw err;
      }
      k.markKeeper();
      return k;
    })();
    e = fresh;
  }
  const entry = e;
  if (entry.launching) {
    try {
      entry.keeper = await entry.launching;
    } catch (err) {
      if (hosts.get(key) === entry) hosts.delete(key);
      throw err;
    } finally {
      entry.launching = null;
    }
  }
  if (entry.closing || !entry.keeper) throw new Error("the browser host was shut down while starting — try again");
  const keeper = entry.keeper;
  entry.refs++;
  const { cdpBase, port } = keeper.endpoint;
  let released = false;
  return {
    cdpBase,
    port,
    get alive() {
      return !entry.closing && keeper.processAlive;
    },
    release() {
      if (released) return Promise.resolve();
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      return entry.refs > 0 ? Promise.resolve() : retireHost(entry);
    },
  };
}

// exiting：进程退出处理器里（同步）——只能当场杀，体面退出留给下次启动时的孤儿驱逐（retireOrphanProfile）。
function retireHost(entry: HostEntry, exiting = false): Promise<void> {
  if (entry.closing) return entry.closing;
  entry.closing = (async () => {
    if (exiting) {
      entry.keeper?.killNow();
      return;
    }
    const keeper = entry.keeper ?? (await entry.launching?.catch(() => null));
    await keeper?.close();
  })().finally(() => {
    if (hosts.get(entry.key) === entry) hosts.delete(entry.key);
  });
  return entry.closing;
}

// #113：Chrome 正在写 DevToolsActivePort 的那一瞬间去读，Windows 上会撞 EBUSY / EPERM（共享冲突）——以前直接抛出、
// 整次启动失败。读不了、读到半截都当作「还没写好」，由调用方接着等：端口那一行要以换行收尾才算写完（只写出「639」的
// 那一刻不能当成端口 639）。
export function readDevToolsPortFile(file: string, read: (f: string) => string = (f) => readFileSync(f, "utf8")): number | null {
  let text: string;
  try {
    text = read(file);
  } catch {
    return null;
  }
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  const p = Number(text.slice(0, nl).trim());
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
}

// 共享无头宿主用持久配置档：用户在面板里登录过的站点，下一个会话照样是登录态（对齐 bridge 10-26 的无头持久登录）。
// 只有浏览器池（getBrowser）用它——一个 user-data-dir 同时只能一个进程开，单独 new CdpSession().launch() 的（测试、截图）照旧用临时档。
// 测试进程默认关（同一测试进程里会起好几个浏览器），DIMENSIO_BROWSER_PERSIST=1 才开。
export function persistBrowserProfile(): boolean {
  const v = String(process.env.DIMENSIO_BROWSER_PERSIST ?? "").trim();
  if (v === "0" || /^(off|false|no)$/i.test(v)) return false;
  if (v === "1" || /^(on|true|yes)$/i.test(v)) return true;
  return !inTestProcess();
}

// ── 浏览器池：一个会话一份 ───────────────────────────────────────────────────
// 以前全进程只有一个浏览器、一次只许一个会话用（claimBrowser），前端却允许 3 个会话并发——第二个会话一调 Browser /
// ReadPage / Eval / Network 就被拒。现在按会话各开一份（对齐 bridge 11-08 的 claude-browser.mjs）：
//   · 键 = 会话 id（ToolContext.ownerId）。子 agent / 工作流 worker 带着父会话的 id，用的就是父会话那一份（与以前「同一个
//     owner 可以重入」一致）；"" = 不属于任何会话的默认那份（测试、还没有会话 id 的新对话、不带 sessionId 的旧前端）。
//   · 每份是一个 CdpSession：自己的标签、前台标签、视口、console / 网络缓冲、观看者——几个会话同时用浏览器互不干扰。
//     底层都在同一个共享无头宿主里（桌面壳在场时是壳里的标签），网站登录态默认共享。
//   · 隔离存储（按会话开关、落盘）：换成宿主里的一个独立浏览上下文，cookie / 存储不和别的会话共享，关掉即清空。
//   · 回收：会话的标签活过这一轮、活过「停止」（用户还要看页面）；会话删除 / 记录没了（巡检）时由资源账本（M5）收掉。
//     活着的份数超过 MAX_VIEWS 时，再开新的之前先收掉闲了 EVICT_IDLE_MS、也没人在看的（最久没用的先收）。
//   · 挂载状态：这份浏览器从「没有标签」变成「有标签」（或反过来）就通知 onBrowserMount 的订阅者（index.ts 转发到全局
//     事件通道 browser_mount），前端的浏览器入口只在本会话有标签时亮。

interface BrowserSlot {
  owner: string;
  session: CdpSession | null;
  launching: Promise<CdpSession> | null;
  // closeBrowser / 换隔离模式 / attach 时加一：还在路上的启动作废（起来了也当场关掉）
  gen: number;
  usedAt: number;
  mounted: boolean;
  // 资源账本里的那一条（只有会话的才登记）：会话删除时收掉浏览器、忘掉隔离开关
  release: (() => void) | null;
}

const pool = new Map<string, BrowserSlot>();
const MAX_VIEWS = 8;
const EVICT_IDLE_MS = 10 * 60_000;

function slotFor(owner: string): BrowserSlot {
  let s = pool.get(owner);
  if (!s) {
    s = { owner, session: null, launching: null, gen: 0, usedAt: Date.now(), mounted: false, release: null };
    pool.set(owner, s);
  }
  return s;
}

function book(s: BrowserSlot): void {
  if (!s.owner || s.release) return;
  s.release = registerResource(s.owner, "browser", "browser", (reason) => {
    s.release = null;
    const live = Boolean(s.session?.alive);
    if (reason === "delete" || reason === "orphan") forgetIsolation(s.owner);
    s.gen++;
    const sess = s.session;
    s.session = null;
    s.launching = null;
    if (pool.get(s.owner) === s) pool.delete(s.owner);
    noteMount(s, 0);
    if (sess) void sess.close();
    return live;
  });
}

function adopt(s: BrowserSlot, sess: CdpSession): void {
  s.session = sess;
  s.usedAt = Date.now();
  // 换了新实例后，旧实例晚到的「标签清空」不该把灯熄掉
  sess.subscribeTabs((tabs) => {
    if (s.session === sess) noteMount(s, tabs.length);
  });
  book(s);
}

// 活着的份数到顶了：先收掉闲着、也没人在看的（最久没用的先收），别让每个用过浏览器的会话都永远攥着一个渲染进程
function evictIdle(except: string): void {
  const live = [...pool.values()].filter((x) => x.session?.alive);
  let over = live.length + 1 - MAX_VIEWS;
  if (over <= 0) return;
  const now = Date.now();
  const idle = live
    .filter((x) => x.owner !== except && !x.launching && !x.session!.viewerList().length && now - x.usedAt > EVICT_IDLE_MS)
    .sort((a, b) => a.usedAt - b.usedAt);
  for (const x of idle) {
    if (over-- <= 0) break;
    void closeBrowser(x.owner);
  }
}

// 这个会话的浏览器（没有就开一份：about:blank 起步，视口沿用默认桌面档）
export async function getBrowser(owner = ""): Promise<CdpSession> {
  const s = slotFor(owner);
  s.usedAt = Date.now();
  if (s.session?.alive) return s.session;
  if (s.launching) return s.launching;
  const stale = s.session;
  s.session = null;
  if (stale) void stale.close();
  evictIdle(owner);
  const gen = s.gen;
  const launching = (async () => {
    const sess = new CdpSession();
    try {
      await sess.launch("about:blank", {
        shared: true,
        isolate: browserIsolated(owner),
        ...(persistBrowserProfile() ? { profileDir: browserProfileDir() } : {}),
      });
    } catch (e) {
      // #113：启动中途失败，先把这一份收干净再抛（拉起一半的标签 / 宿主引用不能漏）
      await sess.close();
      throw e;
    }
    if (s.gen !== gen || pool.get(owner) !== s) {
      void sess.close();
      throw new Error("this conversation's browser was closed while it was starting — try again");
    }
    adopt(s, sess);
    return sess;
  })();
  s.launching = launching;
  try {
    return await launching;
  } finally {
    if (s.launching === launching) s.launching = null;
  }
}

// 这个会话活着的浏览器（不启动）
export function existingBrowser(owner = ""): CdpSession | undefined {
  const s = pool.get(owner);
  if (!s?.session?.alive) return undefined;
  s.usedAt = Date.now();
  return s.session;
}

// 旧前端（不带 sessionId 的 /api/browser/*）：以前只有一个浏览器、面板看的就是 agent 正在用的那个——现在给它最近用过的
// 那一份，没有就是默认那份。新前端一律带 sessionId（空串也算带了 = 默认那份）。
export function recentBrowserOwner(): string {
  let best: BrowserSlot | null = null;
  for (const s of pool.values()) if (s.session?.alive && (!best || s.usedAt > best.usedAt)) best = s;
  return best?.owner ?? "";
}

// 关掉这个会话的浏览器（它的全部标签；隔离上下文随之清空）。之后再用会重新开一份。
export function closeBrowser(owner = ""): Promise<void> {
  const s = pool.get(owner);
  if (!s) return Promise.resolve();
  s.gen++;
  const sess = s.session;
  s.session = null;
  s.launching = null;
  noteMount(s, 0);
  // 账本那一条只为「会话删除时收掉浏览器 / 忘掉隔离开关」而在：浏览器关了、也没开隔离，就注销、整个槽位丢掉
  if (!browserIsolated(owner)) {
    s.release?.();
    s.release = null;
    if (pool.get(owner) === s) pool.delete(owner);
  }
  return sess ? sess.close() : Promise.resolve();
}

// 把这个会话的浏览器工具改指向一个已经在跑的 Chromium 系应用的调试端口（Electron、headful Chrome……）。
// 这个会话原来那份先关掉；别的会话不受影响。失败就空着，下次 navigate 照常开回无头浏览器。
export async function attachBrowser(
  owner: string,
  port: number,
  targetFilter?: string,
): Promise<{ session: CdpSession; picked: string; pages: number }> {
  const s = slotFor(owner);
  s.gen++;
  const gen = s.gen;
  const prev = s.session;
  s.session = null;
  s.launching = null;
  if (prev) void prev.close();
  const sess = new CdpSession();
  try {
    const info = await sess.attach(port, targetFilter);
    if (s.gen !== gen || pool.get(owner) !== s) throw new Error("this conversation's browser was closed while attaching — try again");
    adopt(s, sess);
    return { session: sess, ...info };
  } catch (e) {
    void sess.close();
    throw e;
  }
}

// 这个会话的浏览器现在是哪一种（面板显示用）
export function browserMode(owner = ""): "desktop" | "attach" | "headless" | null {
  const s = existingBrowser(owner);
  if (!s) return null;
  return s.desktop ? "desktop" : s.attached ? "attach" : "headless";
}

// 活着的份数（测试：被拒的导航不许拉起任何浏览器）
export function liveBrowserCount(): number {
  return [...pool.values()].filter((s) => s.session?.alive).length;
}

// ReadPage / Eval / Network / Browser 找不到这个会话活着的浏览器时说的话。
export function noBrowserMessage(): string {
  return "This conversation has no browser open — Browser(navigate, url:…) first.";
}

// exiting：进程退出处理器里调用（同步，等不了 close 的异步收尾）。
export function closeAllBrowserSessions(opts: { exiting?: boolean } = {}): void {
  for (const s of [...pool.values()]) {
    s.gen++;
    const sess = s.session;
    s.session = null;
    s.launching = null;
    s.release?.();
    s.release = null;
    noteMount(s, 0);
    if (opts.exiting) sess?.killNow();
    else void sess?.close();
  }
  pool.clear();
  for (const entry of [...hosts.values()]) void retireHost(entry, opts.exiting);
  if (opts.exiting) hosts.clear();
}

// ── 挂载状态（这个会话的浏览器里有没有标签）─────────────────────────────────────
export interface BrowserMountEvent {
  e: "browser_mount";
  sessionId: string;
  mounted: boolean;
  tabs: number;
  isolated: boolean;
}
const mountListeners = new Set<(ev: BrowserMountEvent) => void>();

export function onBrowserMount(fn: (ev: BrowserMountEvent) => void): () => void {
  mountListeners.add(fn);
  return () => mountListeners.delete(fn);
}

function emitMount(owner: string, mounted: boolean, tabs: number): void {
  if (!owner) return; // 默认那份不属于任何会话，没有谁的灯要亮
  const ev: BrowserMountEvent = { e: "browser_mount", sessionId: owner, mounted, tabs, isolated: browserIsolated(owner) };
  for (const fn of mountListeners) {
    try {
      fn(ev);
    } catch {
      /* 订阅者自己的问题 */
    }
  }
}

function noteMount(s: BrowserSlot, tabs: number): void {
  const on = tabs > 0;
  if (s.mounted === on) return;
  s.mounted = on;
  emitMount(s.owner, on, tabs);
}

// 这个会话的挂载状态（不触发启动）：前端切会话、全局通道重连时拉一次，之后靠 browser_mount 事件
export function browserMount(owner = ""): { mounted: boolean; tabs: number; isolated: boolean } {
  const sess = pool.get(owner)?.session;
  const tabs = sess?.alive ? sess.tabs.length : 0;
  return { mounted: tabs > 0, tabs, isolated: browserIsolated(owner) };
}

// ── 隔离存储开关（按会话，落盘：跨重启记着）─────────────────────────────────────
const ISO_MAX = 300;
let isoKeys: Set<string> | null = null;

function isoSet(): Set<string> {
  if (isoKeys) return isoKeys;
  try {
    const raw = JSON.parse(readFileSync(browserIsolationFile(), "utf8"));
    isoKeys = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string" && k !== "") : []);
  } catch {
    isoKeys = new Set();
  }
  return isoKeys;
}

function isoSave(): Promise<void> {
  let all = [...isoSet()];
  if (all.length > ISO_MAX) {
    all = all.slice(-ISO_MAX);
    isoKeys = new Set(all);
  }
  return atomicWriteFile(browserIsolationFile(), JSON.stringify(all)).catch((e) => {
    console.warn(`[browser] 隔离存储开关没存上：${(e as Error).message}`);
  });
}

function forgetIsolation(owner: string): void {
  if (isoSet().delete(owner)) void isoSave();
}

export function browserIsolated(owner: string): boolean {
  return Boolean(owner) && isoSet().has(owner);
}

// 开 / 关这个会话的隔离存储。模式变了就关掉这个会话现有的浏览器（标签随之关闭、隔离上下文清空），下次打开按新模式起。
export async function setBrowserIsolated(owner: string, on: boolean): Promise<{ isolated: boolean; restarted: boolean }> {
  if (!owner) throw new Error("isolated storage is per conversation — send a message first");
  const want = Boolean(on);
  const set = isoSet();
  if (set.has(owner) === want) return { isolated: want, restarted: false };
  if (want) set.add(owner);
  else set.delete(owner);
  await isoSave();
  const s = pool.get(owner);
  const restarted = Boolean(s?.session?.alive || s?.launching);
  void closeBrowser(owner);
  if (want) book(slotFor(owner)); // 只开了开关、还没开过浏览器的会话，删除时也要把开关忘掉
  emitMount(owner, false, 0); // 别的设备上的开关跟着变
  return { isolated: want, restarted };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
