// 插件的实时通道（插件接口六期）：插件登记一个 WebSocket 端点，插件页面经 SDK 连上来收发文本 / 二进制。
//
//   服务端：ctx.socket('stream', (sock, who, query) => { … }, { who: 'host' | 'members' })
//     sock：send(text) / sendJson(obj) / sendBinary(buf) / close(code?, reason?) / bufferedAmount（还没写出去的字节，背压用）/ open
//           onText(fn) / onBinary(fn) / onJson(fn) / onClose(fn)
//     who：连接者的身份上下文（同 ctx.http.user）；query：连接时页面带的参数（URLSearchParams）
//   页面：const ws = await bridge.socket('stream', { serial: 'x' })   → 标准 WebSocket（binaryType = 'arraybuffer'）
//
// 鉴权：浏览器的 WebSocket 带不了自定义头，插件页面又在不透明源里（Origin: null）——所以先由页面经 SDK 的普通请求
// （嵌入时宿主代发、带宿主登录态；独立时带插件票据）换一张一次性连接票（POST /api/plugin/<id>/_bridge/socket），
// 30 秒内、只能用一次、只对这个插件的这个端点有效、身份就是换票的人；连接地址 /api/plugin/<id>/_ws/<name>?t=<票>。
// 插件停用：它的端点撤掉、开着的连接全部关闭（1001）。

import { randomBytes } from 'node:crypto';
import { acceptWebSocket, claimUpgradePath } from '../runtime/ws-server.mjs';

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PATH_RE = /^\/api\/plugin\/([a-z][a-z0-9-]{0,47})\/_ws\/([a-z][a-z0-9-]{0,31})$/;
const TICKET_MS = 30_000;
const MAX_PER_PLUGIN = 64;            // 一个插件同时最多这么多条连接
const MAX_MESSAGE = 8 << 20;          // 页面发上来的单条消息上限

const endpoints = new Map();          // pluginId → Map(name → { handler, who })
const live = new Map();               // pluginId → Set(sock)
const tickets = new Map();            // 票 → { plugin, name, ctx, query, exp }

export function registerSocket(pluginId, name, handler, opts = {}) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('ctx.socket 的名字只能用小写字母、数字、连字符（≤32 字，字母开头）：' + name);
  if (typeof handler !== 'function') throw new Error('ctx.socket 要 handler(sock, who, query)');
  const who = opts.who == null ? 'host' : opts.who;
  if (who !== 'host' && who !== 'members') throw new Error("ctx.socket 的 who 只能是 'host' 或 'members'");
  if (!endpoints.has(pluginId)) endpoints.set(pluginId, new Map());
  const m = endpoints.get(pluginId);
  if (m.has(name)) throw new Error('ctx.socket 端点重名：' + name);
  m.set(name, { handler, who });
  return () => {
    if (endpoints.get(pluginId)?.get(name)?.handler !== handler) return;
    endpoints.get(pluginId).delete(name);
    for (const s of [...(live.get(pluginId) || [])]) if (s.endpoint === name) s.close(1001, 'endpoint removed');
  };
}

/** 插件停用：撤掉全部端点、关掉全部连接、作废没用掉的票。 */
export function dropPluginSockets(pluginId) {
  endpoints.delete(pluginId);
  for (const s of [...(live.get(pluginId) || [])]) s.close(1001, 'plugin disabled');
  live.delete(pluginId);
  for (const [k, t] of tickets) if (t.plugin === pluginId) tickets.delete(k);
}

export const hasSocket = (pluginId, name) => !!endpoints.get(pluginId)?.has(name);
export const socketWho = (pluginId, name) => endpoints.get(pluginId)?.get(name)?.who || null;

/** 换一张一次性连接票。ctx = 已判过能用这个插件页面的身份；query = 页面要带给 handler 的参数（扁平字符串表）。 */
export function mintSocketTicket(pluginId, name, ctx, query = {}) {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
  const q = {};
  for (const [k, v] of Object.entries(query && typeof query === 'object' ? query : {}).slice(0, 32)) {
    if (/^[\w.-]{1,64}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) q[k] = String(v).slice(0, 2000);
  }
  const tok = randomBytes(24).toString('base64url');
  tickets.set(tok, { plugin: pluginId, name, ctx, query: q, exp: now + TICKET_MS });
  return { path: `/api/plugin/${pluginId}/_ws/${name}?t=${tok}`, expiresIn: TICKET_MS / 1000 };
}

function takeTicket(tok, pluginId, name) {
  const t = tok && tickets.get(tok);
  if (!t) return null;
  tickets.delete(tok);
  if (t.exp < Date.now() || t.plugin !== pluginId || t.name !== name) return null;
  return t;
}

function wrap(ws, pluginId, name) {
  const on = { text: [], binary: [], close: [] };
  const fire = (k, ...a) => { for (const fn of on[k]) { try { fn(...a); } catch (e) { console.error(`[plugin:${pluginId}] socket ${name} 回调出错：`, e?.message || e); } } };
  ws.onText = (s) => fire('text', s);
  ws.onBinary = (b) => fire('binary', b);
  const sock = {
    endpoint: name,
    get open() { return ws.open; },
    get bufferedAmount() { return ws.bufferedAmount; },
    send: (text) => ws.send(text),
    sendJson: (obj) => ws.send(JSON.stringify(obj)),
    sendBinary: (buf) => ws.sendBinary(buf),
    close: (code = 1000, reason = '') => ws.close(code, reason),
    onText(fn) { on.text.push(fn); return sock; },
    onBinary(fn) { on.binary.push(fn); return sock; },
    onJson(fn) { on.text.push((s) => { let v; try { v = JSON.parse(s); } catch { return; } fn(v); }); return sock; },
    onClose(fn) { on.close.push(fn); return sock; },
  };
  ws.onClose = (code) => {
    live.get(pluginId)?.delete(sock);
    fire('close', code);
  };
  return sock;
}

let attached = false;
/** 挂到 bridge 的 HTTP 服务上（一次）。isActive(id) 由内核给：停用中的插件一律拒。 */
export function attachPluginSockets(server, { isActive }) {
  if (attached || !server) return () => {};
  attached = true;
  const unclaim = claimUpgradePath('/api/plugin/');
  const onUpgrade = (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return; }
    const m = PATH_RE.exec(url.pathname);
    if (!m) { if (url.pathname.startsWith('/api/plugin/')) socket.destroy(); return; }
    const [, pluginId, name] = m;
    const deny = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    const ep = endpoints.get(pluginId)?.get(name);
    if (!ep || !isActive(pluginId)) return deny(404, 'Not Found');
    const t = takeTicket(url.searchParams.get('t'), pluginId, name);
    if (!t) return deny(401, 'Unauthorized');
    if ((live.get(pluginId)?.size || 0) >= MAX_PER_PLUGIN) return deny(503, 'Too Many Connections');
    const ws = acceptWebSocket(req, socket, head, { maxMessage: MAX_MESSAGE });
    if (!ws) return;
    const sock = wrap(ws, pluginId, name);
    if (!live.has(pluginId)) live.set(pluginId, new Set());
    live.get(pluginId).add(sock);
    const query = new URLSearchParams(t.query);
    Promise.resolve().then(() => ep.handler(sock, t.ctx, query)).catch((e) => {
      console.error(`[plugin:${pluginId}] socket ${name} handler 出错：`, e?.message || e);
      sock.close(1011, 'handler error');
    });
  };
  server.on('upgrade', onUpgrade);
  return () => { server.off('upgrade', onUpgrade); unclaim(); attached = false; };
}

export const _test = { endpoints, live, tickets, PATH_RE };
