import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserEnv, findBrowser, reapProfileProcesses, reapProfileProcessesSync } from "./headless.ts";
import { controlPlaneUrlBlock } from "./control-plane.ts";
import { desktopHostInfo, resolveCdpBase, type DesktopHost } from "./desktop-host.ts";
import { killTree } from "./tools/bash.ts";
import { registerResource } from "./resources.ts";
import { edgeLink } from "./edge-link.ts";

// Edge 扩展模式里页面 / 浏览器频道的「地址」：openSocket 看到这个前缀就走扩展链路而不是真 WebSocket
const EDGE_SCHEME = "edge-link:";

function openSocket(url: string): WebSocket {
  if (url.startsWith(EDGE_SCHEME)) return edgeLink().channel(url.slice(EDGE_SCHEME.length)) as unknown as WebSocket;
  return new WebSocket(url);
}

// A PERSISTENT headless-Chrome session driven over the Chrome DevTools Protocol
// (CDP) via Node's built-in WebSocket — no puppeteer/CDP-client dependency.
// This is the agent's "hands + eyes": one shared browser the Browser/ReadPage/
// Eval/Network tools all drive. It keeps a page alive across tool calls (state
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

const MAX_CONSOLE = 400;
const MAX_NET = 400;

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
  // Edge 扩展模式：驱动的是用户自己的 Edge（已登录的真浏览器）里 dimensio 标签组的标签页。
  // 我们不拥有进程也不拥有标签：close 只断开，标签留给用户看结果。视口不做模拟（那是用户正在看的窗口）。
  edge = false;
  private edgeUnsub: (() => void) | null = null;
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

  get alive(): boolean {
    return !this.dead && this.ws?.readyState === WebSocket.OPEN && this.child?.exitCode == null;
  }

  async launch(startUrl: string): Promise<void> {
    // 桌面壳在场 → 真 WebContentsView（用户面板与 agent 同一个页面实体）；否则 headless。
    const host = await liveDesktopHost();
    if (host) {
      await this.attachDesktop(host, startUrl || "about:blank");
      return;
    }
    const browser = findBrowser();
    if (!browser) throw new Error("No Chrome/Edge found for the interactive browser.");
    this.tmp = mkdtempSync(path.join(tmpdir(), "harness-cdp-"));
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
      `--user-data-dir=${path.join(this.tmp, "profile")}`,
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

    const port = await this.readDevToolsPort();
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
      throw new Error(`the ${total} page(s) on 127.0.0.1:${port} are dimensio / bridge's own control plane — attaching to them is not allowed`);
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

  // 接到用户的 Edge（经 dimensio Edge 扩展，本仓库不附带）：标签组里有标签就接前台那个，没有就让扩展开组开一张。
  async attachEdge(startUrl?: string): Promise<{ tabs: number; created: boolean }> {
    const link = edgeLink();
    if (!link.connected) throw new Error("the dimensio Edge extension is not connected");
    this.edge = true;
    this.attached = true;
    this.cdpBase = EDGE_SCHEME;
    // 扩展断开 = 这个会话死了（下一次调用拿到清楚的「未连接」，而不是 30 秒超时）
    this.edgeUnsub = link.onLink((up) => {
      if (!up) this.dead = true;
    });
    await this.connectBrowserSocket();
    let pages = await this.listPages();
    let created = false;
    if (!pages.length) {
      const r = await this.bsend("Target.createTarget", { url: startUrl || "about:blank" });
      if (!r?.targetId) throw new Error("the Edge extension could not open a tab");
      created = true;
      pages = await this.listPages();
    }
    const pick = pages.find((p) => p.active) ?? pages[0];
    if (!pick) throw new Error("the dimensio tab group in Edge has no tab");
    this.activeTargetId = String(pick.id);
    await this.connect(String(pick.webSocketDebuggerUrl));
    this.url = String(pick.url ?? "");
    await this.enableDomains();
    this.seedTabs(pages);
    await this.bsend("Target.activateTarget", { targetId: this.activeTargetId }).catch(() => {});
    await this.readEdgeViewport();
    if (startUrl && !created && startUrl !== "about:blank") await this.navigate(startUrl);
    return { tabs: pages.length, created };
  }

  // 用户窗口的真实视口（我们不模拟尺寸，所以它就是 agent 截图 / 坐标的参照系）
  private async readEdgeViewport(): Promise<void> {
    try {
      const v = await this.eval("({w:innerWidth,h:innerHeight})");
      if (v?.w > 0 && v?.h > 0) {
        this.viewport = { width: Math.round(v.w), height: Math.round(v.h) };
        this.notifyViewport();
      }
    } catch {
      /* 页面拒绝脚本：保留上一次的数 */
    }
  }

  // Chrome writes the actual debug port to <user-data-dir>/DevToolsActivePort.
  private async readDevToolsPort(timeoutMs = 15_000): Promise<number> {
    const file = path.join(this.tmp, "profile", "DevToolsActivePort");
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
    if (this.edge) {
      const tabs = await edgeLink().listTabs();
      return tabs.map((t) => ({ ...t, type: "page", webSocketDebuggerUrl: EDGE_SCHEME + t.id }));
    }
    const res = await fetch(`${this.cdpBase}/json/list`);
    const targets = (await res.json()) as any[];
    const pages = targets.filter(
      (t) => t.type === "page" && t.webSocketDebuggerUrl && !/^(devtools|chrome-extension):/.test(String(t.url ?? "")),
    );
    if (this.external) return pages.filter((t) => this.ownedTargets.has(String(t.id ?? "")));
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
        let wsUrl = EDGE_SCHEME + "browser"; // Edge 扩展模拟的 Target 域
        if (!this.edge) {
          const res = await fetch(`${this.cdpBase}/json/version`);
          const v = (await res.json()) as any;
          wsUrl = v?.webSocketDebuggerUrl;
        }
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
        if (t?.type === "page" && t.targetId && (!this.external || this.ownedTargets.has(String(t.targetId)))) {
          this.upsertTab({ id: String(t.targetId), url: String(t.url ?? ""), title: String(t.title ?? ""), active: false });
        }
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
    if (this.external) this.ownedTargets.delete(id);
    this.notifyTabs();
    if (!wasActive || this.retargetN > 0 || !this.alive) return;
    const next = this.tabs[0];
    if (next) {
      this.activateTab(next.id).catch(() => {});
    } else if (this.edge) {
      // 用户把组里最后一张标签关了 / 拖出组了：那是在收回授权，不要自己再开一张——断开
      void this.close();
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
    const r = this.external
      ? await this.desktopTarget("POST", "", { url: url || "about:blank" })
      : await this.bsend("Target.createTarget", { url: url || "about:blank" });
    const id = String(r?.targetId ?? "");
    if (!id) throw new Error("Target.createTarget returned no targetId");
    if (this.external) this.ownedTargets.add(id);
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
      // Edge：那是用户的真窗口，不强加模拟视口——换过去以后按它的真实尺寸记
      if (!this.edge) await this.setViewport(this.viewport.width, this.viewport.height).catch(() => {});
      this.activeTargetId = id;
      this.url = String(target.url ?? "");
      for (const t of this.tabs) t.active = t.id === id;
      await this.bsend("Target.activateTarget", { targetId: id }).catch(() => {});
      if (this.edge) await this.readEdgeViewport();
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
      if (this.external) await this.desktopTarget("DELETE", id);
      else await this.bsend("Target.closeTarget", { targetId: id });
      const i = this.tabs.findIndex((t) => t.id === id);
      if (i >= 0) {
        this.tabs.splice(i, 1);
        this.notifyTabs();
      }
      if (this.external) this.ownedTargets.delete(id);
      return;
    }
    const rest = this.tabs.filter((t) => t.id !== id);
    this.retargetN++;
    try {
      if (this.external) await this.desktopTarget("DELETE", id);
      else await this.bsend("Target.closeTarget", { targetId: id });
      const i = this.tabs.findIndex((t) => t.id === id);
      if (i >= 0) {
        this.tabs.splice(i, 1);
        this.notifyTabs();
      }
      if (this.external) this.ownedTargets.delete(id);
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
          this.url = params.frame.url;
          this.syncActiveTabUrl(this.url);
        }
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

  private send(method: string, params: Record<string, unknown>): Promise<any> {
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
      }, 30_000).unref();
    });
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

  async navigate(url: string, settleMs = 1200): Promise<void> {
    const loaded = new Promise<void>((res) => this.loadWaiters.push(res));
    await this.send("Page.navigate", { url });
    this.url = url;
    await Promise.race([loaded, delay(10_000)]);
    await delay(settleMs); // let SPA JS render
  }

  // history: -1 = back, +1 = forward. Returns the URL we moved to, or null when
  // there is no entry in that direction.
  async history(dir: -1 | 1): Promise<string | null> {
    const h = await this.send("Page.getNavigationHistory", {});
    const next = (h?.currentIndex ?? 0) + dir;
    const entry = h?.entries?.[next];
    if (!entry) return null;
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await delay(800);
    this.url = entry.url;
    return String(entry.url);
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
      const settle = waitMs === 0 ? null : await this.settle(SETTLE_MAX_MS);

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
        const c = opts.clip;
        if (![c.x, c.y, c.width, c.height].every(Number.isFinite) || c.width < 1 || c.height < 1) {
          throw new Error("clip needs numeric x, y, width, height (viewport CSS px), width and height ≥ 1");
        }
        const v = await this.eval("({sx:scrollX,sy:scrollY,vw:innerWidth,vh:innerHeight})");
        region = clampRegion({ x: c.x + v.sx, y: c.y + v.sy, width: c.width, height: c.height });
        beyond = c.x < 0 || c.y < 0 || c.x + region.width > v.vw || c.y + region.height > v.vh;
      }
      const r = await this.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: beyond,
        ...(region ? { clip: { x: region.x, y: region.y, width: region.width, height: region.height, scale: 1 } } : {}),
      });
      if (!r?.data) throw new Error("captureScreenshot returned no data");
      return { png: Buffer.from(r.data, "base64"), region, settle };
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
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
  private async settle(maxMs: number): Promise<{ waitedMs: number; stillRunning: number }> {
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
  async axSnapshot(opts: { filter?: "all" | "interactive"; query?: string; maxChars?: number } = {}): Promise<AxSnapshot> {
    const filter = opts.filter ?? "all";
    const maxChars = Math.max(2000, Math.min(80_000, opts.maxChars ?? 20_000));
    const r = await this.send("Accessibility.getFullAXTree", {});
    const nodes: any[] = r?.nodes ?? [];
    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(String(n.nodeId), n);
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    if (!root) return { text: "(empty accessibility tree)", refCount: 0, lineCount: 0, truncated: false };

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
      const line = `${"  ".repeat(depth)}- ${displayRole}${name ? ` "${name}"` : ""}${refTag}${value}${states.length ? ` (${states.join(", ")})` : ""}`;
      const isRefLine = refTag !== "";
      if (filter === "all" || isRefLine) {
        lines.push(filter === "interactive" ? line.trimStart() : line);
      }

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
  private async refCenter(ref: number): Promise<{ x: number; y: number }> {
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
    return { x: c.x, y: c.y };
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

  private async dispatchClick(
    x: number,
    y: number,
    opts: { button?: "left" | "right"; clickCount?: number; modifiers?: number; source?: "agent" | "user" } = {},
  ): Promise<void> {
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    const modifiers = opts.modifiers ?? 0;
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
    const needle = JSON.stringify(text.toLowerCase());
    const c = await this.eval(
      `(()=>{const n=${needle};const sel='a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label';
       const nodes=Array.from(document.querySelectorAll(sel)).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
       const t=el=>(el.getAttribute('aria-label')||el.value||el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
       let hit=nodes.find(el=>t(el)===n)||nodes.find(el=>t(el).includes(n));
       if(!hit)return null;hit.scrollIntoView({block:'center'});const r=hit.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    if (!c) throw new Error(`no clickable element matching text "${text}"`);
    await this.dispatchClick(c.x, c.y);
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

  // Focus a target (by ref or CSS selector) and type text into it.
  async typeText(text: string, target?: { ref?: number; selector?: string }): Promise<void> {
    if (target?.ref != null) {
      await this.focusRef(target.ref);
    } else if (target?.selector) {
      const ok = await this.eval(
        `(()=>{const e=document.querySelector(${JSON.stringify(target.selector)});if(!e)return false;e.focus();return true;})()`,
      );
      if (!ok) throw new Error(`no element matching selector ${target.selector}`);
    }
    await this.send("Input.insertText", { text });
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

  async setViewport(width: number, height: number, _mobile = false): Promise<void> {
    const w = Math.round(width);
    const h = Math.round(height);
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

  private async reload(): Promise<void> {
    const loaded = new Promise<void>((res) => this.loadWaiters.push(res));
    await this.send("Page.reload", {});
    await Promise.race([loaded, delay(10_000)]);
    await delay(1000); // let entrance JS run
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
  close(): Promise<void> {
    const owned = this.detach();
    return owned ? shutdownOwnedBrowser(owned).catch(() => {}) : Promise.resolve();
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
    reapProfileProcessesSync(path.join(owned.tmp, "profile"), owned.browser);
    try {
      rmSync(owned.tmp, { recursive: true, force: true });
    } catch {
      /* 收尸器会按指纹收残留 profile */
    }
  }

  // 同步断开本会话的全部连接、清空状态。返回要收尾的自己拉起的浏览器；附着外部 app 或
  // 根本没起来返回 null。
  private detach(): OwnedBrowser | null {
    this.dead = true;
    if (this.edge) {
      // 只断开：调试器从标签上摘掉（Edge 的「正在调试」提示条随之消失），标签和标签组留给用户。
      this.edgeUnsub?.();
      this.edgeUnsub = null;
      for (const s of [this.ws, this.browserWs]) {
        try {
          s?.close();
        } catch {
          /* ignore */
        }
      }
      this.ws = null;
      this.browserWs = null;
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
    const owned = { bws: this.browserWs, child: this.child, tmp: this.tmp, browser: this.browserPath };
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
  tmp: string;
  browser: string;
}

const BROWSER_CLOSE_GRACE_MS = 5_000;

async function shutdownOwnedBrowser({ bws, child, tmp, browser }: OwnedBrowser): Promise<void> {
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
  if (launcherOnly || !inTime) await reapProfileProcesses(path.join(tmp, "profile"), browser);
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

// ── The shared browser ────────────────────────────────────────────────────────
// ONE browser for the whole harness process: the Browser/ReadPage/Eval/Network
// tools all drive it, so state (page, viewport, console/network buffers)
// persists across tool calls. Relaunched automatically if it died.

let shared: CdpSession | null = null;
let launching: Promise<CdpSession> | null = null;

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

// 上一个共享浏览器是用户的 Edge、它又断了（扩展断开、用户关掉了组里最后一张标签、点了停止）：不要悄悄换成无头浏览器——
// agent 会以为自己还在用户的 Edge 里。明确报错，由它决定重连（Browser edge）还是回内置浏览器（Browser close）。
let edgeLost = false;

export async function getSharedBrowser(): Promise<CdpSession> {
  if (shared?.alive) return shared;
  if (shared?.edge || edgeLost) {
    edgeLost = true;
    void shared?.close();
    shared = null;
    throw new Error(
      "the connection to the user's Edge ended (extension disconnected, the dimensio tab group was emptied, or the user pressed Stop). " +
        "Browser(action:\"edge\") reconnects; Browser(action:\"close\") goes back to the built-in browser.",
    );
  }
  if (launching) return launching;
  void shared?.close();
  launching = (async () => {
    const s = new CdpSession();
    try {
      await s.launch("about:blank");
    } catch (e) {
      // #113：已经拉起的浏览器不能扔下不管——以前启动中途失败（读端口撞 EBUSY、等页面超时、连不上）就把它漏在后台，
      // 进程里还攥着它的句柄：harness 里多一个没人管的无头浏览器，测试进程则因此退不掉（09-25 全量卡了二十分钟）
      await s.close();
      throw e;
    }
    shared = s;
    launching = null;
    return s;
  })();
  try {
    return await launching;
  } catch (e) {
    launching = null;
    throw e;
  }
}

export function existingSharedBrowser(): CdpSession | undefined {
  return shared?.alive ? shared : undefined;
}

// ── Who is driving it ─────────────────────────────────────────────────────────
// The single shared browser is deliberate: the user's panel watches the very page
// the agent drives, and they can take over with their own hands. But the frontend
// allows 3 concurrent sessions, and two agents driving one page silently corrupt
// each other's work (A navigates away mid-assertion, refs from read_page go stale,
// screenshots capture B's page). So the browser is CLAIMED by one session at a
// time: the second session gets a clear refusal instead of a hijacked page.
// The claim is released when the owning run ends (session.ts finally), and expires
// on its own after inactivity so a crashed run can't lock the browser forever.
const BROWSER_CLAIM_IDLE_MS = 5 * 60_000;
let claimOwner = "";
let claimTouchedAt = 0;
// M5：当前占用在会话资源账本里的那一条
let claimRelease: (() => void) | null = null;

function claimExpired(): boolean {
  return claimOwner !== "" && Date.now() - claimTouchedAt > BROWSER_CLAIM_IDLE_MS;
}

// Take (or refresh) the claim. Returns null when granted, else the refusal text
// the tool should hand back to the model. Unowned callers ("" — sub-agents,
// tests, UI paths) never claim and are never blocked: they share as before.
export function claimBrowser(owner: string): string | null {
  if (!owner) return null;
  if (claimOwner === owner) {
    claimTouchedAt = Date.now();
    return null;
  }
  if (claimOwner !== "" && !claimExpired()) {
    return (
      "The shared browser is currently being driven by another active session. " +
      "There is exactly one browser (the user watches and can take over the same page), so it is " +
      "not safe for two sessions to drive it at once. Wait for that run to finish, or do this " +
      "task without the browser."
    );
  }
  // M5（K03）：占用进会话资源账本（换人时上一个过期占用者的那一条先注销）——轮结束、停止、删除都由账本放掉
  claimRelease?.();
  claimOwner = owner;
  claimTouchedAt = Date.now();
  claimRelease = registerResource(owner, "browser", "shared-browser", () => {
    if (claimOwner !== owner) return false;
    claimOwner = "";
    claimTouchedAt = 0;
    claimRelease = null;
    syncEdgeActivity();
    return true;
  });
  syncEdgeActivity();
  return null;
}

export function releaseBrowser(owner: string): void {
  if (owner && claimOwner === owner) {
    claimOwner = "";
    claimTouchedAt = 0;
    const release = claimRelease;
    claimRelease = null;
    release?.();
    syncEdgeActivity();
  }
}

export function browserClaimOwner(): string {
  return claimExpired() ? "" : claimOwner;
}

// Retarget the ONE shared browser at an external app's DevTools endpoint. The
// previous session (owned headless or an earlier attach) is closed first — CDP
// allows a single debugger client per page, and every tool follows `shared`.
// On failure the shared slot is simply left empty; the next navigate relaunches
// a fresh headless browser as usual.
export async function attachSharedBrowser(
  port: number,
  targetFilter?: string,
): Promise<{ session: CdpSession; picked: string; pages: number }> {
  void shared?.close();
  shared = null;
  launching = null;
  const s = new CdpSession();
  try {
    const info = await s.attach(port, targetFilter);
    shared = s;
    return { session: s, ...info };
  } catch (e) {
    void s.close();
    throw e;
  }
}

// 把唯一的共享浏览器换成用户的 Edge（经扩展）。和 attach 同理：先关掉原来那个（自己拉起的无头浏览器照常收尾）。
export async function attachEdgeBrowser(startUrl?: string): Promise<{ session: CdpSession; tabs: number; created: boolean }> {
  void shared?.close();
  shared = null;
  launching = null;
  const s = new CdpSession();
  try {
    const info = await s.attachEdge(startUrl);
    shared = s;
    edgeLost = false;
    syncEdgeActivity();
    return { session: s, ...info };
  } catch (e) {
    void s.close();
    throw e;
  }
}

// 共享浏览器现在是哪一种：面板据此标出「你的 Edge」
export function sharedBrowserMode(): "edge" | "desktop" | "attach" | "headless" | null {
  const s = existingSharedBrowser();
  if (!s) return null;
  return s.edge ? "edge" : s.external ? "desktop" : s.attached ? "attach" : "headless";
}

// Edge 氛围灯的「整轮常亮」来源：有会话占着共享浏览器、而它挂在 Edge 上
function syncEdgeActivity(): void {
  edgeLink().setClaimActive(Boolean(shared?.edge && shared.alive && browserClaimOwner()));
}

// exiting：进程退出处理器里调用（同步，等不了 close 的异步收尾）。
export function closeAllBrowserSessions(opts: { exiting?: boolean } = {}): void {
  if (opts.exiting) shared?.killNow();
  else void shared?.close();
  shared = null;
  edgeLost = false; // 明确关掉（Browser close / 面板）= 下一次用回内置浏览器
  claimOwner = "";
  claimTouchedAt = 0;
  syncEdgeActivity();
}

// 占用过期（崩掉的轮没人来放）不会触发任何回调——隔一会儿对一次账，氛围灯不至于一直亮着
setInterval(() => {
  if (shared?.edge) syncEdgeActivity();
}, 30_000).unref();

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
