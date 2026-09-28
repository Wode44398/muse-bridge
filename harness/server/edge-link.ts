import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { acceptWebSocket, type LiteSocket } from "./ws-lite.ts";

// ── Edge 扩展链路（dimensio 连用户自己的 Edge）──────────────────────────────────
// 扩展（MV3，本仓库不附带；装了的话）的 service worker 拨回环 ws://127.0.0.1:<PORT>/edge-link，
// 用 chrome.debugger 把我们发的 CDP 命令转给它那个标签组里的标签页，事件原样回传。
// 对 cdp.ts 来说这里只是另一种「WebSocket」：每个频道（"browser" = Target 域的模拟、"<tabId>" = 某个标签页）
// 都包成一个 WebSocket 形状的对象，收发的就是标准 CDP JSON，所以 Browser / ReadPage / Eval / Network 全部原样工作。
//
// 鉴权：WebSocket 没有 CORS，任何网页都能往回环地址发起升级——所以只认固定扩展 ID 的 Origin
// （manifest 里写死了 key，ID 在所有机器上都是这一个）。网页伪造不了 Origin 头；本机进程伪造得了，
// 但本机进程本来就在信任边界里（它能直接读写这些文件）。dimensio 本身仅管理员可用（bridge 侧门禁）。

export const EDGE_EXTENSION_ID = "clnfofamdiidpmecdcnalogcmfpnelce";
export const EDGE_LINK_PATH = "/edge-link";
const PROTOCOL = 1;
const PING_MS = 20_000;
const RPC_TIMEOUT_MS = 15_000;

// 期望的扩展版本：本仓库不附带扩展，不做版本比对（握手里照旧带这个字段，空串 = 不限）。
const EXPECTED_EXTENSION_VERSION = "";

function allowedOrigins(): Set<string> {
  const ids = [EDGE_EXTENSION_ID, ...(process.env.DIMENSIO_EDGE_EXTENSION_IDS ?? "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(ids.map((id) => `chrome-extension://${id}`));
}

export interface EdgeTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface EdgeStatus {
  connected: boolean;
  browser: string; // 扩展自报的 UA 摘要（Edge/154…）
  extVersion: string;
  expectedVersion: string;
  acting: boolean;
  since: number;
}

type Listener = (ev: any) => void;

// 一个频道 = 一个 WebSocket 形状的对象（只实现 cdp.ts 用到的那部分：readyState / send / close / addEventListener）。
export class EdgeChannelSocket {
  readyState = 0; // CONNECTING
  readonly ch: string;
  private link: EdgeLink;
  private listeners = new Map<string, Set<{ fn: Listener; once: boolean }>>();
  constructor(ch: string, link: EdgeLink) {
    this.ch = ch;
    this.link = link;
  }

  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add({ fn, once: Boolean(opts?.once) });
  }

  removeEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of set) if (l.fn === fn) set.delete(l);
  }

  dispatch(type: string, ev: any): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of [...set]) {
      if (l.once) set.delete(l);
      try {
        l.fn(ev);
      } catch (e) {
        console.error(`[edge] ${type} listener threw:`, (e as Error).message);
      }
    }
  }

  send(text: string): void {
    if (this.readyState !== 1) throw new Error("edge channel not open");
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.link.sendRaw({ t: "cdp", ch: this.ch, id: msg.id, method: msg.method, params: msg.params ?? {} });
    this.link.touch(msg.method);
  }

  close(): void {
    if (this.readyState === 3) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 3;
    this.link.forget(this);
    if (wasOpen) this.link.sendRaw({ t: "close", ch: this.ch });
    this.dispatch("close", {});
  }

  // 由链路调用：扩展那边关了 / 链路断了
  closedByPeer(reason: string): void {
    if (this.readyState === 3) return;
    const connecting = this.readyState === 0;
    this.readyState = 3;
    if (connecting) this.dispatch("error", { message: reason });
    this.dispatch("close", { reason });
  }
}

// 这些方法是「观看」，不是「操作」：直播帧的确认、开关直播。它们不点亮氛围灯。
const PASSIVE_METHODS = new Set(["Page.screencastFrameAck", "Page.startScreencast", "Page.stopScreencast"]);
const TRAFFIC_LINGER_MS = 4_000;

export class EdgeLink {
  private sock: LiteSocket | null = null;
  private status: EdgeStatus = { connected: false, browser: "", extVersion: "", expectedVersion: "", acting: false, since: 0 };
  private channels = new Map<string, EdgeChannelSocket>();
  private rpcSeq = 1;
  private rpcs = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pinger: NodeJS.Timeout | null = null;
  private statusSubs = new Set<(s: EdgeStatus) => void>();
  private claimActive = false;
  private lastTraffic = 0;
  private lingerTimer: NodeJS.Timeout | null = null;
  // 用户在页面上点了「停止」/ 在 Edge 的调试提示条上点了「取消」：交给 index.ts 去停掉正在用浏览器的那一轮
  onStop: ((why: string) => void) | null = null;
  // 扩展连上 / 断开：cdp.ts 用它把挂在 Edge 上的共享浏览器标记为死
  private linkSubs = new Set<(connected: boolean) => void>();

  get connected(): boolean {
    return Boolean(this.sock?.open) && this.status.connected;
  }

  snapshot(): EdgeStatus {
    return { ...this.status, connected: this.connected };
  }

  subscribe(cb: (s: EdgeStatus) => void): () => void {
    this.statusSubs.add(cb);
    return () => this.statusSubs.delete(cb);
  }

  onLink(cb: (connected: boolean) => void): () => void {
    this.linkSubs.add(cb);
    return () => this.linkSubs.delete(cb);
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const cb of this.statusSubs) {
      try {
        cb(snap);
      } catch {
        /* subscriber's problem */
      }
    }
  }

  // http.Server 的 'upgrade'：只接 /edge-link，其余一律 404 断开（harness 没有别的 WebSocket 端点）。
  handleUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const url = String(req.url ?? "").split("?")[0];
    if (url !== EDGE_LINK_PATH) return false;
    const origin = String(req.headers.origin ?? "");
    if (!allowedOrigins().has(origin)) {
      console.warn(`[edge] refused link from origin ${origin || "(none)"}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return true;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return true;
    this.adopt(ws);
    return true;
  }

  private adopt(ws: LiteSocket): void {
    // 一次只认一条链路：同一台机器上开了两个装着扩展的 Edge 配置，后连的顶掉先连的
    if (this.sock?.open) {
      try {
        this.sock.send(JSON.stringify({ t: "replaced" }));
      } catch {
        /* ignore */
      }
      this.sock.close(4000, "replaced by a newer connection");
    }
    this.sock = ws;
    ws.onMessage = (text) => this.onMessage(ws, text);
    ws.onClose = () => {
      if (this.sock !== ws) return;
      this.dropLink("extension disconnected");
    };
    const expected = EXPECTED_EXTENSION_VERSION;
    this.status = { connected: false, browser: "", extVersion: "", expectedVersion: expected, acting: false, since: Date.now() };
    ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL, expectVersion: expected }));
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (this.sock === ws && ws.open) ws.send(JSON.stringify({ t: "ping" }));
    }, PING_MS);
    this.pinger.unref();
  }

  private dropLink(reason: string): void {
    this.sock = null;
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    const wasConnected = this.status.connected;
    this.status = { ...this.status, connected: false, acting: false };
    for (const ch of [...this.channels.values()]) ch.closedByPeer(reason);
    this.channels.clear();
    for (const [, r] of this.rpcs) {
      clearTimeout(r.timer);
      r.reject(new Error(`Edge ${reason}`));
    }
    this.rpcs.clear();
    if (wasConnected) {
      console.log(`[edge] link down: ${reason}`);
      for (const cb of this.linkSubs) cb(false);
    }
    this.notify();
  }

  private onMessage(ws: LiteSocket, text: string): void {
    if (ws !== this.sock) return;
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m.t) {
      case "hello": {
        this.status = {
          ...this.status,
          connected: true,
          browser: String(m.browser ?? "").slice(0, 80),
          extVersion: String(m.version ?? ""),
          since: Date.now(),
        };
        console.log(`[edge] link up: ${this.status.browser} ext ${this.status.extVersion}`);
        for (const cb of this.linkSubs) cb(true);
        this.pushActivity(true);
        this.notify();
        break;
      }
      case "ping":
        ws.send(JSON.stringify({ t: "pong" }));
        break;
      case "pong":
        break;
      case "opened": {
        const ch = this.channels.get(String(m.ch));
        if (ch && ch.readyState === 0) {
          ch.readyState = 1;
          ch.dispatch("open", {});
        }
        break;
      }
      case "closed": {
        const ch = this.channels.get(String(m.ch));
        if (ch) {
          this.channels.delete(ch.ch);
          ch.closedByPeer(String(m.reason ?? "closed by extension"));
        }
        break;
      }
      case "res": {
        const ch = this.channels.get(String(m.ch));
        if (!ch || ch.readyState !== 1) break;
        const payload = m.error ? { id: m.id, error: { message: String(m.error) } } : { id: m.id, result: m.result ?? {} };
        ch.dispatch("message", { data: JSON.stringify(payload) });
        break;
      }
      case "evt": {
        const ch = this.channels.get(String(m.ch));
        if (!ch || ch.readyState !== 1) break;
        ch.dispatch("message", { data: JSON.stringify({ method: m.method, params: m.params ?? {} }) });
        break;
      }
      case "rpcres": {
        const r = this.rpcs.get(Number(m.rid));
        if (!r) break;
        this.rpcs.delete(Number(m.rid));
        clearTimeout(r.timer);
        if (m.error) r.reject(new Error(String(m.error)));
        else r.resolve(m.result);
        break;
      }
      case "stop": {
        const why = String(m.reason ?? "user");
        console.log(`[edge] stop requested from the browser (${why})`);
        try {
          this.onStop?.(why);
        } catch (e) {
          console.error("[edge] stop handler failed:", (e as Error).message);
        }
        break;
      }
    }
  }

  sendRaw(obj: unknown): void {
    if (!this.sock?.open) throw new Error("Edge extension is not connected");
    this.sock.send(JSON.stringify(obj));
  }

  // 打开一个频道（"browser" 或标签页 id）。返回 WebSocket 形状的对象，open/error 事件报告结果。
  channel(ch: string): EdgeChannelSocket {
    const sock = new EdgeChannelSocket(ch, this);
    const old = this.channels.get(ch);
    if (old) old.closedByPeer("reopened");
    this.channels.set(ch, sock);
    if (!this.connected) {
      queueMicrotask(() => {
        this.channels.delete(ch);
        sock.closedByPeer("Edge extension is not connected");
      });
      return sock;
    }
    this.sendRaw({ t: "open", ch });
    return sock;
  }

  forget(sock: EdgeChannelSocket): void {
    if (this.channels.get(sock.ch) === sock) this.channels.delete(sock.ch);
  }

  rpc(op: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.connected) return Promise.reject(new Error("Edge extension is not connected"));
    const rid = this.rpcSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(rid);
        reject(new Error(`Edge ${op} timed out`));
      }, RPC_TIMEOUT_MS);
      timer.unref();
      this.rpcs.set(rid, { resolve, reject, timer });
      try {
        this.sendRaw({ t: "rpc", rid, op, args });
      } catch (e) {
        clearTimeout(timer);
        this.rpcs.delete(rid);
        reject(e as Error);
      }
    });
  }

  async listTabs(): Promise<EdgeTabInfo[]> {
    const r = await this.rpc("list");
    return (Array.isArray(r?.tabs) ? r.tabs : []).map((t: any) => ({
      id: String(t.id),
      url: String(t.url ?? ""),
      title: String(t.title ?? ""),
      active: Boolean(t.active),
    }));
  }

  // ── 氛围灯：agent 正在用 Edge ────────────────────────────────────────────────
  // 两个来源取「或」：① 有会话占着共享浏览器且它挂在 Edge 上（整轮任务期间常亮，思考间隙不闪）；
  // ② 最近几秒有操作性 CDP 流量（子 agent 之类不占用浏览器的调用方）。
  setClaimActive(on: boolean): void {
    if (this.claimActive === on) return;
    this.claimActive = on;
    this.pushActivity();
  }

  touch(method: string): void {
    if (PASSIVE_METHODS.has(method)) return;
    this.lastTraffic = Date.now();
    this.pushActivity();
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => this.pushActivity(), TRAFFIC_LINGER_MS + 50);
    this.lingerTimer.unref();
  }

  private pushActivity(force = false): void {
    const on = this.claimActive || Date.now() - this.lastTraffic < TRAFFIC_LINGER_MS;
    if (!force && on === this.status.acting) return;
    this.status = { ...this.status, acting: on };
    if (this.sock?.open && this.status.connected) this.sock.send(JSON.stringify({ t: "activity", on }));
    this.notify();
  }
}

let link: EdgeLink | null = null;
export function edgeLink(): EdgeLink {
  return (link ??= new EdgeLink());
}
