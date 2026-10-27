// bridge 插件页面 SDK（/plugins/_sdk/bridge-plugin.js）。插件页面里：
//
//   import { bridge } from '/plugins/_sdk/bridge-plugin.js';
//   const info = await bridge.ready();             // { pluginId, theme: 'dark'|'light', lang, platform, user, mode: 'embed'|'panel'|'standalone' }
//   const data = await bridge.json('groups');      // GET /api/plugin/<id>/groups → JSON（非 2xx 抛错，message = 接口给的 error）
//   await bridge.json('send', { text: 'hi' });     // 带第二个参数 = POST JSON
//   const r = await bridge.fetch('raw', { method: 'POST', body: '…' });   // 类 Response：ok / status / json() / text() / blob()
//   const off = bridge.on('reply', (payload) => …); // 插件 ctx.bus.toPage('reply', payload) 推来的
//   bridge.toast('已保存'); await bridge.confirm({ title: '清空？', danger: true });
//   const src = await bridge.blobUrl('image?id=1');  // 要登录才拿得到的图片 → blob: 地址
//   bridge.openExternal(url); bridge.back();
//
// 页面跑在不透明源里（iframe sandbox / CSP sandbox），拿不到 bridge 的 cookie 与 localStorage——这是故意的。
//   · 嵌在 bridge 里（设置详情 / 面板）：请求经 postMessage 交给宿主页代发，宿主只放行 /api/plugin/<本插件>/ 下的路径；
//   · 独立打开（新窗口、手机 App 的插件页）：地址的 #t= 带着插件票据，SDK 直接带票请求。
// 主题：<html> 上有 data-theme、--bp-* 颜色变量随宿主实时更新；引 /plugins/_sdk/bridge-plugin.css 就有一套现成控件样式。

const hash = new URLSearchParams(location.hash.slice(1));
const embedded = window.parent !== window;
const pluginId = (/^\/plugins\/([a-z][a-z0-9-]{0,47})\//.exec(location.pathname) || [])[1] || '';
const ticket = hash.get('t') || '';
// 不透明源里 location.origin 是字符串 "null"，服务器地址得自己拼
const SERVER = location.protocol + '//' + location.host;
const listeners = new Map();   // 事件名 → Set<fn>
const pending = new Map();     // 请求号 → { resolve, reject }
let seq = 0;
let info = null;
let readyResolve;
const readyP = new Promise((r) => { readyResolve = r; });

const TOKENS = ['bg', 'card', 'text', 'muted', 'line', 'hover', 'accent', 'brand', 'ok', 'warn', 'crit', 'field'];
function applyTheme(theme, vars) {
  const root = document.documentElement;
  root.dataset.theme = theme === 'light' ? 'light' : 'dark';
  root.style.colorScheme = root.dataset.theme;
  if (vars) for (const k of TOKENS) if (vars[k]) root.style.setProperty('--bp-' + k, vars[k]);
  if (vars && vars.radius) root.style.setProperty('--bp-radius', vars.radius);
}
// 先按地址里的提示上主题（宿主的 init 还没到时别先闪一下白）
applyTheme(hash.get('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
document.documentElement.dataset.mode = embedded ? (hash.get('mode') || 'embed') : 'standalone';

function emit(event, payload) {
  for (const fn of listeners.get(event) || []) { try { fn(payload); } catch (e) { console.error(e); } }
}

// ── 嵌入模式：和宿主对话 ─────────────────────────────────────────────────
function post(msg, transfer) { window.parent.postMessage({ bp: 1, ...msg }, '*', transfer || []); }
function call(type, data, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type, id, ...data }, transfer);
  });
}
if (embedded) {
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.bp !== 1) return;
    if (m.type === 'init') {
      info = { pluginId, theme: m.theme, lang: m.lang, platform: m.platform, user: m.user, mode: m.mode || 'embed' };
      applyTheme(m.theme, m.vars);
      document.documentElement.dataset.mode = info.mode;
      readyResolve(info);
    } else if (m.type === 'theme') {
      if (info) info.theme = m.theme;
      applyTheme(m.theme, m.vars);
      emit('_theme', m.theme);
    } else if (m.type === 'event') {
      emit(m.event, m.payload);
    } else if (m.type === 'reply' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value);
    }
  });
  post({ type: 'hello', pluginId });
  // 高度自动上报（嵌在设置详情里时宿主据此撑高 iframe，不出双滚动条）
  let lastH = 0;
  const report = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - lastH) > 1) { lastH = h; post({ type: 'resize', height: h }); }
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
} else {
  info = {
    pluginId, theme: document.documentElement.dataset.theme, lang: hash.get('lang') || (navigator.language || '').slice(0, 2),
    platform: hash.get('platform') || 'web', user: null, mode: 'standalone',
  };
  readyResolve(info);
  if (!ticket) console.warn('[bridge-plugin] 没有插件票据：请从 bridge 里打开这个页面');
}

// ── 请求 ─────────────────────────────────────────────────────────────────
const cleanPath = (p) => {
  const s = String(p || '').replace(/^\/+/, '');
  if (/^[a-z]+:/i.test(s) || s.split(/[/?#]/)[0].split('/').includes('..') || s.includes('\\')) throw new Error('路径不合法：' + p);
  return s;
};

function makeResponse(status, headers, buf) {
  const type = headers['content-type'] || '';
  return {
    ok: status >= 200 && status < 300, status, headers,
    arrayBuffer: async () => buf,
    text: async () => new TextDecoder().decode(buf),
    json: async () => JSON.parse(new TextDecoder().decode(buf) || 'null'),
    blob: async () => new Blob([buf], { type }),
  };
}

let expiredShown = false;
function showExpired() {
  if (expiredShown) return;
  expiredShown = true;
  const d = document.createElement('div');
  d.className = 'bp-expired';
  d.textContent = '这个页面的访问凭证过期了，请从 bridge 里重新打开。';
  document.body.appendChild(d);
}

async function bfetch(path, opts = {}) {
  await readyP;
  const rel = cleanPath(path);
  const method = String(opts.method || 'GET').toUpperCase();
  let body = opts.body;
  const headers = { ...(opts.headers || {}) };
  if (body != null && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Blob) && !ArrayBuffer.isView(body)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (embedded) {
    let payload = body;
    if (payload instanceof Blob) payload = await payload.arrayBuffer();
    else if (ArrayBuffer.isView(payload)) payload = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    const r = await call('fetch', { path: rel, method, headers, body: payload ?? null }, payload instanceof ArrayBuffer ? [payload] : []);
    return makeResponse(r.status, r.headers || {}, r.body || new ArrayBuffer(0));
  }
  const res = await fetch(SERVER + '/api/plugin/' + pluginId + '/' + rel, {
    method, body, headers: { ...headers, Authorization: 'Plugin ' + ticket }, credentials: 'omit',
  });
  if (res.status === 401) showExpired();
  const buf = await res.arrayBuffer();
  const h = {};
  res.headers.forEach((v, k) => { h[k] = v; });
  return makeResponse(res.status, h, buf);
}

async function bjson(path, data) {
  const r = await bfetch(path, data === undefined ? {} : { method: 'POST', body: data ?? {} });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
  return j;
}

// 独立页面的事件流：fetch 流读（票据放请求头，不进地址）；断了退避重连，票过期就停。
let streamOn = false;
async function openStream() {
  if (streamOn || embedded || !ticket) return;
  streamOn = true;
  let delay = 1000;
  for (;;) {
    try {
      const res = await fetch(SERVER + '/api/plugins/page-events?id=' + pluginId, { headers: { Authorization: 'Plugin ' + ticket }, credentials: 'omit' });
      if (res.status === 401) { showExpired(); return; }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      delay = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try { const ev = JSON.parse(data); if (ev && ev.type === 'plugin.event') emit(ev.event, ev.payload); } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(30_000, delay * 2);
  }
}

// ── 小界面 ───────────────────────────────────────────────────────────────
function localToast(text, error) {
  const t = document.createElement('div');
  t.className = 'bp-toast' + (error ? ' bp-toast-err' : '');
  t.textContent = String(text);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('bp-toast-out'), 2200);
  setTimeout(() => t.remove(), 2600);
}

export const bridge = {
  get info() { return info; },
  get embedded() { return embedded; },
  pluginId,
  ready: () => readyP,
  fetch: bfetch,
  json: bjson,
  on(event, fn) {
    const k = String(event);
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
    openStream();
    return () => listeners.get(k)?.delete(fn);
  },
  onTheme(fn) { return bridge.on('_theme', fn); },
  onStatus(fn) { return bridge.on('_status', fn); },
  toast(text, { error = false } = {}) { if (embedded) post({ type: 'toast', text: String(text), error: !!error }); else localToast(text, error); },
  async confirm({ title = '', desc = '', yes = '', danger = false } = {}) {
    if (embedded) return !!(await call('confirm', { title, desc, yes, danger }));
    return window.confirm([title, desc].filter(Boolean).join('\n\n'));
  },
  async blobUrl(path) { const r = await bfetch(path); if (!r.ok) throw new Error('HTTP ' + r.status); return URL.createObjectURL(await r.blob()); },
  openExternal(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) throw new Error('只能打开 http(s) 地址');
    if (embedded) post({ type: 'open', url: u }); else window.open(u, '_blank', 'noopener');
  },
  back() { if (embedded) post({ type: 'back' }); else if (history.length > 1) history.back(); else window.close(); },
};

export default bridge;
