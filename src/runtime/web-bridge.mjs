// Web Bridge：bridge 里的 agent（Claude / Codex / dimensio）操作用户自己的浏览器。
//
// 用户在自己的 Edge / Chrome 里装 Web Bridge 扩展（bridge build/client/web-bridge，MV3，固定 ID），扩展的
// service worker 拨本机桌面客户端开的回环端口 ws://127.0.0.1:<WEB_BRIDGE_PORTS>/web-bridge；客户端把它当成
// 一个 Chromium 调试端点用——agent 的浏览器动作照旧走 runtime/browser-actions.mjs（同一套 read_page / click /
// verify / expect / batch），只是 CdpSession 的「WebSocket」换成这里的频道（见 cdp.mjs 的 attachWebBridge）。
//
// 全链路只有一条入口：服务端各 agent 的设备浏览器工具 → 设备通道 op=browser（args.browser 选浏览器）→
// 客户端 runDeviceBrowser → 这里。所以几个 agent 同时用同一个浏览器也不会互相踩：
//   · 每个 agent 会话（owner = by:session）有自己的 CdpSession，只拥有自己的标签；
//   · 扩展里每个会话一个标签组（「Claude · 会话标题」），加一个用户手动分享的「Web Bridge」组（谁都能接手）；
//   · 一个标签同一时刻只能被一个会话附着（扩展侧租约），别的会话来抢会被拒并告知是谁在用。
//
// 多台电脑 × 多个浏览器：电脑由设备工具的 device 参数选；同一台电脑上每个装了扩展的浏览器配置（Edge、Chrome、
// 同一浏览器的不同用户配置）各自一条链路，扩展首次启动生成的实例 id 区分它们，名字 = 用户在扩展弹窗里起的名字，
// 或「Edge · 账号邮箱」。agent 用 browser 参数挑：实例 id / 名字或邮箱里的一段 / edge / chrome / builtin（内置浏览器）。
//
// 鉴权：WebSocket 没有 CORS，任何网页都能往回环地址发起升级——只认固定扩展 ID 的 Origin（manifest 写死了 key，
// 所有机器上 ID 都一样）。网页伪造不了 Origin；本机进程伪造得了，但本机进程本来就在信任边界内。

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CdpSession } from './cdp.mjs';
import { runBrowserAction } from './browser-actions.mjs';
import { tabsList } from './browser-tabs.mjs';

export const WEB_BRIDGE_EXTENSION_ID = 'djagdkhnpkefbkmekmklljnokaajlnbb';
export const WEB_BRIDGE_PATH = '/web-bridge';
// 扩展按顺序试这几个端口（同一台电脑上开了两个客户端——不同的 Windows 用户——各占一个）。两边要一致：
// 扩展 background.js 的 PORTS。
export const WEB_BRIDGE_PORTS = [47821, 47822, 47823];
const PROTOCOL = 1;
const PING_MS = 20_000;
const RPC_TIMEOUT_MS = 15_000;
// 会话这么久没动它的浏览器就摘掉调试器（只断开，标签和标签组留着；下一个动作自动接回刚才那个标签）：
// 只要有一个标签挂着 chrome.debugger，浏览器就在【每个】标签顶上挂「Web Bridge 已开始调试此浏览器」，闲着不该一直挂
const DETACH_IDLE_MS = 2 * 60_000;
const FORGET_MS = 30 * 60_000;        // 这么久没用过：连「刚才在哪个标签」也忘掉
const STOP_HOLD_MS = 10 * 60_000;     // 用户在浏览器里点了「停止」：这个会话这么久内再来就拒
const TRAFFIC_LINGER_MS = 4_000;
// 观看类方法不点亮「正在操作」
const PASSIVE_METHODS = new Set(['Page.screencastFrameAck', 'Page.startScreencast', 'Page.stopScreencast']);

export const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', dimensio: 'dimensio', admin: '管理员', agent: 'Agent' };
const KIND_LABEL = { edge: 'Edge', chrome: 'Chrome', chromium: 'Chromium', brave: 'Brave' };
export const kindLabel = (k) => KIND_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1) : '浏览器');

// ── 最小 WebSocket 服务端（RFC 6455：文本帧、分片、ping/pong、close）────────────────────
// 只给扩展那几条回环连接用；扩展侧是标准浏览器 WebSocket，不协商扩展（permessage-deflate），握手里不回就不用。

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;   // 截图是 base64，给足余量

export function acceptWebSocket(req, socket) {
  const key = String(req.headers['sec-websocket-key'] || '');
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay?.(true);
  let open = true;
  let buf = Buffer.alloc(0);
  let fragments = [];
  let fragLen = 0;
  const ws = {
    get open() { return open; },
    onMessage: () => {},
    onClose: () => {},
    send(text) { if (open) socket.write(frame(0x1, Buffer.from(String(text), 'utf8'))); },
    close(code = 1000, reason = '') {
      if (!open) return;
      const r = Buffer.from(String(reason), 'utf8').subarray(0, 120);
      const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0);
      r.copy(body, 2);
      try { socket.write(frame(0x8, body)); } catch { /* 对端已断 */ }
      finish();
      socket.end();
    },
  };
  const finish = () => {
    if (!open) return;
    open = false;
    try { ws.onClose(); } catch { /* listener's problem */ }
  };
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return ws.close(1009, 'message too big');
        len = Number(big); off = 10;
      }
      if (!masked) return ws.close(1002, 'unmasked client frame');   // RFC 6455 §5.1
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) { ws.close(1000); return; }
      if (op === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        fragments.push(payload);
        fragLen += payload.length;
        if (fragLen > MAX_MESSAGE) return ws.close(1009, 'message too big');
        if (!fin) continue;
        const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        fragments = []; fragLen = 0;
        try { ws.onMessage(whole.toString('utf8')); } catch (e) { console.error('[web-bridge] handler threw:', e?.message || e); }
      }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return ws;
}

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

// ── 会话（owner）────────────────────────────────────────────────────────────────────

/** 设备通道 op 带来的「谁在操作」→ 扩展里用的会话键与显示名。 */
export function ownerOf(who = {}) {
  const by = String(who.by || 'agent').replace(/[^\w.-]/g, '').slice(0, 20) || 'agent';
  const session = String(who.session || '').replace(/[|\s]/g, '').slice(0, 64);
  const title = String(who.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { key: `${by}:${session || '-'}`, by, session, title, agent: AGENT_LABEL[by] || by };
}

// ── 频道：一个 WebSocket 形状的对象（cdp.mjs 只用 readyState / send / close / addEventListener）──────

class ChannelSocket {
  readyState = 0;   // CONNECTING
  constructor(link, ch, owner) {
    this.link = link;
    this.ch = ch;
    this.owner = owner;
    this.listeners = new Map();
  }
  addEventListener(type, fn, opts) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add({ fn, once: Boolean(opts?.once) });
  }
  removeEventListener(type, fn) {
    const set = this.listeners.get(type);
    if (set) for (const l of set) if (l.fn === fn) set.delete(l);
  }
  dispatch(type, ev) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of [...set]) {
      if (l.once) set.delete(l);
      try { l.fn(ev); } catch (e) { console.error(`[web-bridge] ${type} listener threw:`, e?.message || e); }
    }
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('Web Bridge 频道没开');
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.link.sendRaw({ t: 'cdp', ch: this.ch, id: msg.id, method: msg.method, params: msg.params ?? {} });
    if (!PASSIVE_METHODS.has(msg.method)) this.link.touch(this.owner.key);
  }
  close() {
    if (this.readyState === 3) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 3;
    this.link.forget(this);
    if (wasOpen) { try { this.link.sendRaw({ t: 'close', ch: this.ch }); } catch { /* 链路已断 */ } }
    this.dispatch('close', {});
  }
  closedByPeer(reason) {
    if (this.readyState === 3) return;
    const connecting = this.readyState === 0;
    this.readyState = 3;
    this.closeReason = reason;
    if (connecting) this.dispatch('error', { message: reason });
    this.dispatch('close', { reason });
  }
}

// ── 一条扩展链路 = 一个浏览器配置 ──────────────────────────────────────────────────────

export class WebBridgeLink {
  constructor(hub, sock, query = {}) {
    this.hub = hub;
    this.sock = sock;
    this.info = {
      id: String(query.id || '').slice(0, 64), kind: String(query.kind || 'chromium').slice(0, 16),
      browser: '', version: '', email: '', name: '', since: Date.now(),
    };
    this.connected = false;
    this.channels = new Map();
    this.rpcs = new Map();
    this.rpcSeq = 1;
    this.lastTraffic = new Map();   // owner key → 最近一次操作性流量
    this.actingOn = new Set();      // 已告诉扩展「正在操作」的 owner
    this.lingerTimers = new Map();
    sock.onMessage = (text) => this.onMessage(text);
    sock.onClose = () => this.drop('扩展断开了');
    this.pinger = setInterval(() => { if (this.sock.open) this.sock.send(JSON.stringify({ t: 'ping' })); }, PING_MS);
    this.pinger.unref?.();
    sock.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, expectVersion: hub.expectVersion(), client: hub.clientName }));
  }

  get id() { return this.info.id; }
  get shortId() { return this.info.id.slice(0, 8); }
  get kindName() { return kindLabel(this.info.kind); }
  // 给模型 / 界面看的名字：用户起的名字 > 浏览器 · 邮箱 > 浏览器 + 版本
  get label() {
    if (this.info.name) return this.info.name;
    return this.info.email ? `${this.kindName} · ${this.info.email}` : (this.info.browser || this.kindName);
  }

  snapshot() {
    return {
      id: this.info.id, short: this.shortId, kind: this.info.kind, kindName: this.kindName, label: this.label,
      name: this.info.name, email: this.info.email, browser: this.info.browser, version: this.info.version,
      since: this.info.since, connected: this.connected,
    };
  }

  onMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    switch (m.t) {
      case 'hello':
        this.info = {
          ...this.info,
          id: String(m.id || this.info.id).slice(0, 64),
          kind: String(m.kind || this.info.kind).slice(0, 16),
          browser: String(m.browser || '').slice(0, 60),
          version: String(m.version || '').slice(0, 20),
          email: String(m.email || '').slice(0, 120),
          name: String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          profile: String(m.profile || '').slice(0, 40),
          since: Date.now(),
        };
        this.connected = true;
        this.hub.adopt(this);
        break;
      case 'info':   // 用户在扩展弹窗里改了名字 / 换了账号
        if (m.name != null) this.info.name = String(m.name).replace(/\s+/g, ' ').trim().slice(0, 40);
        if (m.email != null) this.info.email = String(m.email).slice(0, 120);
        this.hub.changed();
        break;
      case 'ping': this.sock.send(JSON.stringify({ t: 'pong' })); break;
      case 'pong': break;
      case 'opened': {
        const ch = this.channels.get(String(m.ch));
        if (ch && ch.readyState === 0) { ch.readyState = 1; ch.dispatch('open', {}); }
        break;
      }
      case 'closed': {
        const ch = this.channels.get(String(m.ch));
        if (ch) { this.channels.delete(ch.ch); ch.closedByPeer(String(m.reason || '扩展关闭了这个频道')); }
        break;
      }
      case 'res': {
        const ch = this.channels.get(String(m.ch));
        if (!ch || ch.readyState !== 1) break;
        const payload = m.error ? { id: m.id, error: { message: String(m.error) } } : { id: m.id, result: m.result ?? {} };
        ch.dispatch('message', { data: JSON.stringify(payload) });
        break;
      }
      case 'evt': {
        const ch = this.channels.get(String(m.ch));
        if (!ch || ch.readyState !== 1) break;
        ch.dispatch('message', { data: JSON.stringify({ method: m.method, params: m.params ?? {} }) });
        break;
      }
      case 'rpcres': {
        const r = this.rpcs.get(Number(m.rid));
        if (!r) break;
        this.rpcs.delete(Number(m.rid));
        clearTimeout(r.timer);
        if (m.error) r.reject(new Error(String(m.error)));
        else r.resolve(m.result);
        break;
      }
      case 'stop':
        this.hub.userStopped(this, String(m.owner || ''), String(m.reason || 'user'));
        break;
    }
  }

  drop(reason) {
    if (this.dropped) return;
    this.dropped = true;
    this.connected = false;
    clearInterval(this.pinger);
    for (const t of this.lingerTimers.values()) clearTimeout(t);
    for (const ch of [...this.channels.values()]) ch.closedByPeer(`${this.label}：${reason}`);
    this.channels.clear();
    for (const r of this.rpcs.values()) { clearTimeout(r.timer); r.reject(new Error(`${this.label}：${reason}`)); }
    this.rpcs.clear();
    this.hub.release(this, reason);
  }

  sendRaw(obj) {
    if (!this.sock.open || !this.connected) throw new Error(`浏览器「${this.label}」的 Web Bridge 扩展没连着`);
    this.sock.send(JSON.stringify(obj));
  }

  // 开一个频道：'b:<owner>'（这个会话的 Target 域）或 'p:<owner>:<targetId>'（一个标签页）。
  channel(ch, owner, extra = {}) {
    const sock = new ChannelSocket(this, ch, owner);
    const old = this.channels.get(ch);
    if (old) old.closedByPeer('同一频道重新打开');
    this.channels.set(ch, sock);
    try {
      this.sendRaw({ t: 'open', ch, owner: { key: owner.key, by: owner.by, agent: owner.agent, title: owner.title }, ...extra });
    } catch (e) {
      queueMicrotask(() => { this.channels.delete(ch); sock.closedByPeer(String(e?.message || e)); });
    }
    return sock;
  }

  forget(sock) {
    if (this.channels.get(sock.ch) === sock) this.channels.delete(sock.ch);
  }

  rpc(op, args = {}) {
    if (!this.connected) return Promise.reject(new Error(`浏览器「${this.label}」的 Web Bridge 扩展没连着`));
    const rid = this.rpcSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcs.delete(rid); reject(new Error(`浏览器「${this.label}」${op} 超时没回`)); }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.rpcs.set(rid, { resolve, reject, timer });
      try { this.sendRaw({ t: 'rpc', rid, op, args }); } catch (e) { clearTimeout(timer); this.rpcs.delete(rid); reject(e); }
    });
  }

  // 「正在操作」：最近 4 秒有操作性 CDP 流量就亮（扩展据此点亮组标题与页面氛围灯）。
  touch(owner) {
    this.lastTraffic.set(owner, Date.now());
    this.pushActivity(owner);
    clearTimeout(this.lingerTimers.get(owner));
    const t = setTimeout(() => this.pushActivity(owner), TRAFFIC_LINGER_MS + 50);
    t.unref?.();
    this.lingerTimers.set(owner, t);
  }

  pushActivity(owner) {
    const on = Date.now() - (this.lastTraffic.get(owner) || 0) < TRAFFIC_LINGER_MS;
    if (on === this.actingOn.has(owner)) return;
    if (on) this.actingOn.add(owner); else this.actingOn.delete(owner);
    try { this.sendRaw({ t: 'activity', owner, on }); } catch { /* 断了 */ }
  }
}

// ── 浏览器挑选 ───────────────────────────────────────────────────────────────────────

const BUILTIN_WORDS = new Set(['', 'builtin', 'built-in', 'internal', 'bridge', '内置', '内置浏览器']);
const ANY_WORDS = new Set(['user', 'mine', 'default', 'auto', '我的', '用户', '我的浏览器', '用户的浏览器']);

/**
 * browser 参数 → 'builtin' | WebBridgeLink；挑不出唯一一个就抛错，错误里列出全部候选（agent 照着重选）。
 * 认：实例 id（全长或前 8 位）> edge / chrome（这种只连了一个时）> 名字 / 邮箱 / 浏览器名里的一段（不分大小写）。
 */
export function pickBrowser(links, sel) {
  const raw = String(sel ?? '').trim();
  const s = raw.toLowerCase();
  if (BUILTIN_WORDS.has(s)) return 'builtin';
  const live = links.filter((l) => l.connected);
  const list = () => describeBrowsers(live);
  if (!live.length) {
    throw new Error(`这台电脑上没有连着的 Web Bridge 浏览器（要的是「${raw}」）。请用户在自己的 Edge / Chrome 里装好 Web Bridge 扩展并保持浏览器开着；` +
      '扩展图标显示「已连接」才能用。不需要用户登录态的页面用 browser:"builtin"（客户端内置浏览器）。');
  }
  const hit = (arr, what) => {
    if (arr.length === 1) return arr[0];
    if (arr.length > 1) throw new Error(`「${raw}」对上了 ${arr.length} 个浏览器（${what}），请用 id 指定：\n${describeBrowsers(arr)}`);
    return null;
  };
  if (ANY_WORDS.has(s)) {
    return hit(live, '这台电脑上连着不止一个') || null;
  }
  const byId = live.filter((l) => l.id.toLowerCase() === s || l.shortId.toLowerCase() === s || `wb-${l.shortId}`.toLowerCase() === s);
  if (byId.length) return byId[0];
  const kinds = live.filter((l) => l.info.kind === s || l.kindName.toLowerCase() === s);
  if (kinds.length) return hit(kinds, `都是 ${kinds[0].kindName}`);
  const text = live.filter((l) => [l.label, l.info.name, l.info.email, l.info.browser, l.info.profile].some((x) => String(x || '').toLowerCase().includes(s)));
  const r = hit(text, '名字都含这段');
  if (r) return r;
  throw new Error(`没有叫「${raw}」的浏览器。这台电脑上连着的：\n${list()}`);
}

export function describeBrowsers(links) {
  if (!links.length) return '  （没有）';
  return links.map((l) => `  · [${l.shortId}] ${l.label}（${l.info.browser || l.kindName}${l.info.email && !l.label.includes(l.info.email) ? ` · ${l.info.email}` : ''}）`).join('\n');
}

// ── Hub：回环端口 + 全部链路 + 每个会话的浏览器实例 ─────────────────────────────────────

export class WebBridgeHub {
  constructor({ log = () => {}, extensionDir = '', clientName = 'bridge', onChange = null, onStop = null, extraOrigins = [] } = {}) {
    this.log = log;
    this.extensionDir = extensionDir;
    this.clientName = clientName;
    this.onChange = onChange;
    this.onStop = onStop;
    this.origins = new Set([WEB_BRIDGE_EXTENSION_ID, ...extraOrigins].filter(Boolean).map((id) => `chrome-extension://${id}`));
    this.links = new Map();       // 实例 id → 链路（同一个实例重连：新的顶掉旧的）
    this.pending = new Set();     // 握手前的链路
    this.pool = new Map();        // `${实例 id}|${owner}` → { session, launching, lastUsed, owner, linkId }
    this.stopped = new Map();     // owner key → 拒到何时（用户点了停止）
    this.server = null;
    this.port = 0;
    this.reaper = setInterval(() => this.reap(), 30_000);
    this.reaper.unref?.();
  }

  expectVersion() {
    if (!this.extensionDir) return '';
    try { return String(JSON.parse(readFileSync(path.join(this.extensionDir, 'manifest.json'), 'utf8')).version || ''); } catch { return ''; }
  }

  /** 在 ports 里第一个空着的端口上听回环。返回端口；都占着就抛错。 */
  async listen(ports = WEB_BRIDGE_PORTS, host = '127.0.0.1') {
    let lastErr = null;
    for (const port of ports) {
      const server = createServer((req, res) => {
        // 普通 HTTP：只给扩展探活用（扩展先 fetch 再升级，免得 Chrome 控制台刷满 WebSocket 连接失败）
        if (String(req.url || '').split('?')[0] === WEB_BRIDGE_PATH) {
          res.writeHead(426, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ app: 'bridge-web-bridge', protocol: PROTOCOL }));
          return;
        }
        res.writeHead(404); res.end();
      });
      server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => { server.off('error', reject); resolve(); });
        });
        this.server = server;
        this.port = port;
        this.log(`[web-bridge] 在 ${host}:${port} 等浏览器扩展连接`);
        return port;
      } catch (e) { lastErr = e; try { server.close(); } catch {} }
    }
    throw new Error(`Web Bridge 端口都被占用（${ports.join('/')}）：${lastErr?.message || lastErr}`);
  }

  handleUpgrade(req, socket) {
    let url;
    try { url = new URL(String(req.url || ''), 'http://x'); } catch { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (url.pathname !== WEB_BRIDGE_PATH) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const origin = String(req.headers.origin || '');
    if (!this.origins.has(origin)) {
      this.log(`[web-bridge] 拒绝来自 ${origin || '(无 Origin)'} 的连接`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    const link = new WebBridgeLink(this, ws, { id: url.searchParams.get('id') || '', kind: url.searchParams.get('kind') || '' });
    this.pending.add(link);
  }

  // 握手完成（扩展回了 hello）
  adopt(link) {
    this.pending.delete(link);
    if (!link.id) { try { link.sock.close(4001, 'missing instance id'); } catch {} return; }
    const old = this.links.get(link.id);
    if (old && old !== link) {
      // 同一个浏览器配置连了两次（service worker 重启、旧连接还没断）：新的为准
      old.replaced = true;
      try { old.sock.send(JSON.stringify({ t: 'replaced' })); } catch {}
      old.drop('被同一浏览器的新连接替换');
      try { old.sock.close(4000, 'replaced'); } catch {}
    }
    this.links.set(link.id, link);
    this.log(`[web-bridge] 已连接：${link.label}（${link.info.browser}，扩展 ${link.info.version}，id ${link.shortId}）`);
    this.changed();
  }

  // 链路断了：这条链路上的会话实例都作废（频道已全部 closedByPeer，CdpSession 自己会标记 dead）
  release(link, reason) {
    this.pending.delete(link);
    if (this.links.get(link.id) === link) {
      this.links.delete(link.id);
      if (!link.replaced) this.log(`[web-bridge] 断开：${link.label}（${reason}）`);
    }
    for (const [key, s] of [...this.pool]) {
      if (s.link !== link) continue;
      try { s.session?.close(); } catch {}
      this.pool.delete(key);
    }
    this.changed();
  }

  changed() { try { this.onChange?.(this.list()); } catch { /* listener's problem */ } }

  list() { return [...this.links.values()].filter((l) => l.connected).map((l) => l.snapshot()); }

  connectedLinks() { return [...this.links.values()].filter((l) => l.connected); }

  // 设备 op 'browsers'：给服务端的 devices / status 列表
  browsers() {
    return this.connectedLinks().map((l) => {
      const s = l.snapshot();
      const sessions = [...this.pool.values()].filter((p) => p.link === l && p.session?.alive).map((p) => p.owner.agent + (p.owner.title ? ` · ${p.owner.title}` : ''));
      return { ...s, sessions };
    });
  }

  resolve(sel) { return pickBrowser(this.connectedLinks(), sel); }

  describe() {
    const live = this.connectedLinks();
    const head = '这台电脑上可用的浏览器（browser 参数填 id、名字或邮箱的一段；edge / chrome 在只连了一个时也行）：';
    const rows = ['  · [builtin] 客户端内置浏览器（独立配置档，没有用户自己浏览器里的登录；不传 browser 时用它）'];
    for (const l of live) {
      const s = this.browsers().find((b) => b.id === l.id);
      rows.push(`  · [${l.shortId}] ${l.label} —— 用户自己的 ${l.info.browser || l.kindName}${l.info.email && !l.label.includes(l.info.email) ? `（${l.info.email}）` : ''}，他自己的浏览器配置（Cookie、扩展都在，登录了哪些站以实际为准）${s?.sessions?.length ? `；正在用它的会话：${s.sessions.join('、')}` : ''}`);
    }
    if (!live.length) rows.push('  （没有连着的 Web Bridge 浏览器：用户要在自己的 Edge / Chrome 里装 Web Bridge 扩展、浏览器开着才行）');
    return `${head}\n${rows.join('\n')}`;
  }

  userStopped(link, owner, reason) {
    const owners = owner ? [owner] : [...new Set([...this.pool.values()].filter((p) => p.link === link).map((p) => p.owner.key))];
    for (const o of owners) {
      this.stopped.set(o, Date.now() + STOP_HOLD_MS);
      for (const [key, s] of [...this.pool]) {
        if (s.link !== link || s.owner.key !== o) continue;
        try { s.session?.close(); } catch {}
        this.pool.delete(key);
      }
    }
    this.log(`[web-bridge] 用户在 ${link.label} 里叫停了 ${owners.join('、') || '（无会话）'}（${reason}）`);
    try { this.onStop?.({ link: link.snapshot(), owners, reason }); } catch {}
  }

  reap() {
    const now = Date.now();
    for (const [key, s] of [...this.pool]) {
      if (s.launching) continue;
      if (now - s.lastUsed > FORGET_MS) {
        try { s.session?.close(); } catch {}
        this.pool.delete(key);
      } else if (s.session && (!s.session.alive || now - s.lastUsed > DETACH_IDLE_MS)) {
        // 记下刚才在哪个标签、最近那张截图的坐标基准：接回来时原样续上（click(x,y) 照旧按那张图算）
        if (s.session.alive) s.resume = { tab: s.session.activeTargetId, frame: s.session.frame, viewport: s.session.viewport };
        try { s.session.close(); } catch {}
        s.session = null;
      }
    }
    for (const [o, until] of [...this.stopped]) if (until <= now) this.stopped.delete(o);
  }

  close() {
    clearInterval(this.reaper);
    for (const s of this.pool.values()) { try { s.session?.close(); } catch {} }
    this.pool.clear();
    for (const l of [...this.links.values(), ...this.pending]) { try { l.sock.close(1001, 'client exiting'); } catch {} }
    this.links.clear();
    try { this.server?.close(); } catch {}
  }

  // 这个会话在这条链路上的传输层（交给 CdpSession.attachWebBridge）
  transport(link, owner) {
    const list = async () => {
      const r = await link.rpc('list', { owner: owner.key });
      return { mine: Array.isArray(r?.mine) ? r.mine : [], shared: Array.isArray(r?.shared) ? r.shared : [] };
    };
    return {
      link,
      owner,
      get connected() { return link.connected; },
      label: link.label,
      openBrowser: () => link.channel(`b:${owner.key}`, owner),
      openPage: (targetId) => link.channel(`p:${owner.key}:${targetId}`, owner, { target: targetId }),
      list,
      // CdpSession.listPages 的形状：标签都按 wb:<targetId> 附着
      listPages: async () => {
        const r = await list();
        return [...r.mine, ...r.shared].map((t) => ({ id: t.id, type: 'page', url: t.url, title: t.title, webSocketDebuggerUrl: `wb:${t.id}` }));
      },
      tabState: (targetId) => link.rpc('tab', { owner: owner.key, target: targetId }),
    };
  }

  // 这个会话 × 这个浏览器的实例池（接口同 claude-browser.mjs，交给 runBrowserAction 的 opts.pool）
  poolFor(link, owner) {
    const key = `${link.id}|${owner.key}`;
    const slot = () => {
      let s = this.pool.get(key);
      if (!s) { s = { link, owner, session: null, launching: null, lastUsed: Date.now() }; this.pool.set(key, s); }
      return s;
    };
    const hub = this;
    const launch = async (adopt = '') => {
      const s = slot();
      s.lastUsed = Date.now();
      if (s.session?.alive) { if (adopt) await s.session.adoptTab(adopt); return s.session; }
      if (s.launching) { const sess = await s.launching; if (adopt) await sess.adoptTab(adopt); return sess; }
      try { s.session?.close(); } catch {}
      s.session = null;
      s.launching = (async () => {
        const sess = new CdpSession();
        const transport = hub.transport(link, owner);
        // 闲置摘过调试器：没指定标签就接回刚才那个（还在自己组里的话）
        const back = !adopt && s.resume?.tab && (await transport.list().catch(() => ({ mine: [] }))).mine.some((t) => String(t.id) === s.resume.tab)
          ? s.resume.tab : '';
        await sess.attachWebBridge(transport, { adopt: adopt || back });
        if (back && sess.activeTargetId === back) {
          if (s.resume.frame?.targetId === back) sess.frame = s.resume.frame;
          if (s.resume.viewport) sess.viewport = s.resume.viewport;
        }
        s.resume = null;
        s.session = sess;
        return sess;
      })();
      try { return await s.launching; } finally { s.launching = null; }
    };
    return {
      key,
      getBrowser: () => launch(''),
      adopt: (targetId) => launch(targetId),
      existingBrowser: () => { const s = this.pool.get(key); return s?.session?.alive ? s.session : null; },
      // 没连着、但这个会话的标签组里还有标签（闲置摘过调试器、客户端重启过、链路断过）：直接接回，
      // 有记下的就接刚才那个，没有就接组里当前那个（没有可接的返回 null）
      resume: async () => {
        const { mine } = await hub.transport(link, owner).list().catch(() => ({ mine: [] }));
        return mine.length ? launch('') : null;
      },
      touchBrowser: () => { const s = this.pool.get(key); if (s) s.lastUsed = Date.now(); },
      // close 动作：关掉这个会话自己开的标签，用户分享来的只断开不关
      closeBrowser: async () => {
        const s = this.pool.get(key);
        const n = s?.session ? await s.session.closeOwnTabs() : 0;
        try { s?.session?.close(); } catch {}
        this.pool.delete(key);
        return `已和「${link.label}」断开${n ? `，关掉了你开的 ${n} 个标签` : ''}（用户分享给你的标签留在原处）`;
      },
      viewerReport: async (b) => viewerReport(b, link),
      tabsNote: async (b) => tabsNote(b, link, owner),
    };
  }

  /**
   * 设备 op browser 落到用户浏览器时的入口（客户端 runDeviceBrowser 调）。返回 MCP 形结果 { content, isError? }。
   * browser 选择在这之前已由 resolve 做完。
   */
  async run(link, args = {}, who = {}) {
    const owner = ownerOf(who);
    const until = this.stopped.get(owner.key) || 0;
    if (until > Date.now()) {
      return errorResult(`用户刚才在浏览器「${link.label}」里点了「停止」，叫停了你对他浏览器的操作。不要再试——先在回复里说明你做到了哪一步，问用户要不要继续（他同意后约 ${Math.ceil((until - Date.now()) / 60_000)} 分钟内仍会被拒，可以先用 builtin 浏览器做不需要登录的部分）。`);
    }
    const pool = this.poolFor(link, owner);
    const action = String(args.action || '');
    const head = `[浏览器：${link.label}]`;
    try {
      if (action === 'resize') {
        return errorResult(`${head} 这是用户自己的浏览器窗口，不改它的视口尺寸。要测响应式布局 / 手机尺寸，用 browser:"builtin"（内置浏览器）或服务器上的浏览器工具。`);
      }
      // tabs 只是列一列，不为它重挂调试器
      let b = pool.existingBrowser() || (action !== 'tabs' ? await pool.resume() : null);
      // 还没附着时：tabs 只列不附着；tab / tab_select 指向别的标签时先接手它
      if (!b && action === 'tabs') {
        const r = await pool.tabsNote(null);
        return textResult(`${head}\n${r.trim() || '(你在这个浏览器里还没有标签)'}\n${viewerHint(link)}`);
      }
      const want = args.tab != null && args.tab !== '' ? String(args.tab) : '';
      if (/^t\d+$/.test(want) && !(b && b.ownedTargets.has(want))) {
        b = await pool.adopt(want);
        if (action === 'tab_select') {
          return withHead(head, textResult(`已接手标签 ${want}\n${await tabsList(b)}`));
        }
      } else if (!b && action !== 'navigate' && action !== 'tab_new' && action !== 'close') {
        const r = await pool.tabsNote(null);
        return errorResult(`${head} 你在这个浏览器里还没有打开标签——先 navigate(url) 开一个（会开在你自己的标签组里），或接手用户分享的标签：tab_select(tab:"t…")。${r ? `\n${r.trim()}` : ''}`);
      } else if (!b && action === 'close') {
        return textResult(`${head} 本来就没连着`);
      }
      const r = await runBrowserAction(pool.key, args, null, { pool });
      return withHead(head, r);
    } catch (e) {
      return errorResult(`${head} 浏览器操作失败：${String(e?.message || e)}`);
    }
  }
}

const textResult = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const errorResult = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });

function withHead(head, r) {
  if (!r || !Array.isArray(r.content)) return r;
  const first = r.content.find((c) => c.type === 'text');
  if (first) first.text = `${head} ${first.text}`;
  else r.content.unshift({ type: 'text', text: head });
  return r;
}

function viewerHint(link) {
  return `这是用户自己的 ${link.info.browser || link.kindName}：你开的标签在以你的会话命名的标签组里（如「Claude · 会话标题」），他打开浏览器就能看到；你在操作时那几个标签四边会亮光、底部有「停止」按钮。`;
}

// tabs() 结尾的补充：用户分享给所有会话的标签（可接手）、别的会话占着的
async function tabsNote(b, link, owner) {
  let r;
  try { r = await link.rpc('list', { owner: owner.key }); } catch (e) { return `\n（读不到用户分享的标签：${e?.message || e}）`; }
  const mine = new Set(b ? [...b.ownedTargets] : []);
  const lines = [];
  const unattached = (r?.mine || []).filter((t) => !mine.has(t.id));
  if (unattached.length) {
    lines.push('你的标签组里还没接手的标签（tab_select 接手）：');
    for (const t of unattached) lines.push(`  · tab:"${t.id}" ${t.title || '(无标题)'} — ${t.url}`);
  }
  const shared = (r?.shared || []).filter((t) => !mine.has(t.id));
  if (shared.length) {
    lines.push('用户放进「Web Bridge」组、分享给你的标签（tab_select(tab:"t…") 接手；接手后才能操作）：');
    for (const t of shared) lines.push(`  · tab:"${t.id}" ${t.title || '(无标题)'} — ${t.url}${t.heldBy ? `（正被 ${t.heldBy} 使用，接不了）` : ''}`);
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
}

// 用户此刻看不看得到这个标签（对齐 claude-browser.mjs 的 viewerReport 返回形状）
async function viewerReport(b, link) {
  let st = null;
  try { st = b?.activeTargetId ? await link.rpc('tab', { target: b.activeTargetId }) : null; } catch { /* 读不到就按不确定说 */ }
  if (!st) return { visible: null, text: `这是用户自己的浏览器「${link.label}」，看不出他此刻是否看着这个标签。要他动手前先在回复里说清楚去哪个标签。`, viewers: 0 };
  if (st.active && st.windowFocused && st.windowState !== 'minimized') {
    return { visible: true, text: `用户看得到：这个标签就在他「${link.label}」浏览器窗口的前台。`, viewers: 1 };
  }
  const why = st.windowState === 'minimized' ? '浏览器窗口最小化了' : !st.active ? '这个标签不在前台（他在看同一窗口的别的标签）' : '浏览器窗口不在前台';
  return { visible: false, text: `用户此刻没在看这个标签（${why}）。要他动手（登录、过验证、确认）前，先在回复里请他切到「${link.label}」里标题为「${st.title || st.url || '这个页面'}」的标签。`, viewers: 0 };
}
