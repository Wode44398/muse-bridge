// 进程内调用现有 /api/* 路由：agent 接口的操作大多是「把参数翻成一次内部请求，再把回应整理成给 agent 看的样子」。
// 这样项目解析、额度、路径守卫、审批、单写者判活……全走现成路由，接口层不复制一行业务逻辑。
//
// 身份经 INTERNAL_IDENTITY 挂在假请求上（runtime/identity.mjs），路由照常 identify(req) 拿到它。
// 只调 identify 判身份的路由；控制台那批直接认 authOk 的不认这个覆盖（也不该从这里调）。
// 调哪些路径由操作代码写死，绝不把 agent 传来的路径原样转进来。

import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { INTERNAL_IDENTITY, userIdentity } from '../runtime/identity.mjs';

let router = null;
// 只收真路由器：agent-api 作为内置插件启用时拿到的 ctx.router 是插件宿主的记账版（只有 on / use / prefix），
// 没有 dispatch；收了它会盖掉 bootPlugins 先登记的真路由器，所有走内部请求的操作都报「router.dispatch is not a function」。
export function setInternalRouter(r) { if (r && typeof r.dispatch === 'function') router = r; }

// 收集型假响应：JSON / 文本照单全收（有上限），SSE 逐帧解析成事件对象。
// detach() = 调用方不再关心后续：发 'close'，挂在 gen 上的订阅随之摘掉（关连接不会停掉那一轮，见 runtime/gen.mjs）。
class CollectRes extends EventEmitter {
  constructor({ onEvent = null, maxBytes = 8_000_000 } = {}) {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.writableEnded = false;
    this.detached = false;
    this.sse = false;
    this.events = [];
    this.onEvent = onEvent;
    this.maxBytes = maxBytes;
    this.size = 0;
    this.overflow = false;
    this.chunks = [];
    this.pending = '';
    this.socket = { setNoDelay() {}, setKeepAlive() {}, setTimeout() {}, remoteAddress: '' };
  }
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
  getHeader(k) { return this.headers[String(k).toLowerCase()]; }
  removeHeader(k) { delete this.headers[String(k).toLowerCase()]; }
  hasHeader(k) { return String(k).toLowerCase() in this.headers; }
  writeHead(code, a, b) {
    this.statusCode = code;
    const h = (a && typeof a === 'object') ? a : (b && typeof b === 'object') ? b : null;
    if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
    this.sse = /event-stream/i.test(String(this.getHeader('content-type') || ''));
    this.headersSent = true;
    return this;
  }
  flushHeaders() { this.headersSent = true; }
  write(c) {
    if (c == null || this.detached) return true;
    if (!this.headersSent) this.writeHead(this.statusCode);
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    if (this.sse) {
      this.pending += buf.toString('utf8');
      let i;
      while ((i = this.pending.indexOf('\n\n')) >= 0) {
        const block = this.pending.slice(0, i);
        this.pending = this.pending.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;   // 心跳注释行
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        this.events.push(ev);
        if (this.events.length > 4000) this.events.splice(0, 1000);
        try { this.onEvent && this.onEvent(ev); } catch {}
        this.emit('event', ev);
      }
      return true;
    }
    if (this.size + buf.length > this.maxBytes) { this.overflow = true; return true; }
    this.size += buf.length;
    this.chunks.push(buf);
    return true;
  }
  end(c) {
    if (c != null) this.write(c);
    if (!this.headersSent) this.writeHead(this.statusCode);
    if (!this.writableEnded) { this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  }
  destroy() { this.end(); }
  detach() { if (!this.detached) { this.detached = true; this.emit('close'); } }
  body() { return Buffer.concat(this.chunks); }
  text() { return this.body().toString('utf8'); }
  json() { try { return JSON.parse(this.text()); } catch { return null; } }
}

function fakeRequest(identity, method, url, body, headers = {}) {
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  // 地址用文档保留段（不是回环、不是内网）：「只认同机直连」的守卫一律不把它当本机。
  req.socket = { remoteAddress: '192.0.2.1', encrypted: false };
  req.headers = { host: '127.0.0.1', 'user-agent': 'bridge-agent-api', ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers };
  req[INTERNAL_IDENTITY] = identity;
  return req;
}

// 发一次内部请求。返回 { status, headers, json, text, events, res }。
//   until(ev)：SSE 路由上，某一帧让它返回 true 就提前返回（这一轮照跑；res 留给调用方继续看或 detach）。
//   timeoutMs：到点还没结束也返回（timedOut:true），同样不打断路由本身。
export function internalRequest(identity, method, url, body = null, { headers = {}, until = null, onEvent = null, timeoutMs = 120_000, maxBytes } = {}) {
  if (!router) return Promise.reject(new Error('internal router not ready'));
  const req = fakeRequest(identity, method, url, body, headers);
  const res = new CollectRes({ onEvent, maxBytes });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: res.statusCode, headers: res.headers, sse: res.sse, events: res.events, res,
        json: res.sse ? null : res.json(), text: res.sse ? '' : res.text(), overflow: res.overflow, ...extra,
      });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    timer.unref?.();
    res.on('finish', () => finish());
    if (until) res.on('event', (ev) => { if (until(ev)) finish(); });
    // 非 SSE 的错误码（4xx/5xx JSON 或纯文本）要等 end；SSE 头一出来就看帧
    Promise.resolve(router.dispatch(req, res)).catch(() => finish({ error: true }));
  });
}

// 把 ctx 还原成身份（MCP 那条路没有请求可认，只有 ctx）。主机身份照原样；账号从账号库现拼（停用的拿不到）。
export function identityOfCtx(ctx) {
  if (!ctx) return null;
  if (ctx.kind === 'admin') return { kind: 'admin', user: null };
  if (ctx.kind === 'user') {
    const id = userIdentity(ctx.user);
    return id ? { ...id, sid: ctx.sid || '', loginAt: ctx.loginAt || 0 } : null;
  }
  return null;
}

// 统一的「路由回了错」→ OpError 消息：JSON 的 error / message 字段，或纯文本正文。
export function routeError(r) {
  const j = r.json;
  const msg = (j && (j.error || j.message || j.title)) || (r.text || '').trim().slice(0, 300) || ('HTTP ' + r.status);
  return String(msg);
}
