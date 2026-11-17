// 浏览器宿主（共享无头宿主、桌面壳、持久配置档）与按会话的浏览器池、挂载状态、隔离存储。
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { reapProfileProcesses } from "../headless.ts";
import { killTree } from "../tools/bash.ts";
import { registerResource } from "../resources.ts";
import { browserIsolationFile, browserProfileDir, inTestProcess } from "../paths.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import { CdpSession } from "../cdp.ts";
import { delay } from "./shared.ts";

export interface OwnedBrowser {
  bws: WebSocket | null;
  child: ChildProcess;
  tmp: string; // temporary root to delete afterwards; "" = persistent profile (keep it)
  profileDir: string;
  browser: string;
}

const BROWSER_CLOSE_GRACE_MS = 5_000;

export async function shutdownOwnedBrowser({ bws, child, tmp, profileDir, browser }: OwnedBrowser): Promise<void> {
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
export async function retireOrphanProfile(profileDir: string, browser: string): Promise<void> {
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

export async function acquireHost(profileDir: string): Promise<HostLease> {
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

/** 测试用：给这个 owner 挂一份现成的页面替身（不起浏览器）；null = 拿掉。 */
export function setBrowserForTests(owner: string, session: CdpSession | null): void {
  if (session) slotFor(owner).session = session;
  else pool.delete(owner);
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
