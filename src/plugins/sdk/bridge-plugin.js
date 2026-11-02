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
//   const c = bridge.context();                    // Claude 工作台标签里：{ sessionId, cwd, agent }（别处全是 null / 'claude'）
//   bridge.on('context', (c) => …);               // 用户切了会话 / 工作目录
//
// 插件自己的设置与动作（只有服务器主机能用；不用插件写接口）：
//   const { schema, config } = await bridge.config.get();
//   await bridge.config.set({ paused: true });        // 合并进当前配置，按 schema 校验；插件登记了 ctx.onConfig 就热更新
//   await bridge.options('model');                    // 字段的选项（claude.models / users / 插件 ctx.configOptions…）
//   await bridge.actions(); await bridge.action('probe');   // 详情页那些按钮
//   await bridge.status();                            // 状态块 + 子进程 + 定时任务 + 用量
//   bridge.form(el, { fields: ['prefix', 'paused'] }); // 在页面里画一份设置表单（按清单 schema，改了即存）
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
// 当前上下文（工作台标签用）：嵌入时宿主随 init 给、切会话再推 context；独立打开（手机 App）从地址的 # 读
const readCtx = (c) => ({
  sessionId: c && typeof c.sessionId === 'string' && c.sessionId ? c.sessionId : null,
  cwd: c && typeof c.cwd === 'string' && c.cwd ? c.cwd : null,
  agent: c && c.agent === 'dimensio' ? 'dimensio' : 'claude',
});
let ctx = readCtx({ sessionId: hash.get('sid'), cwd: hash.get('cwd'), agent: hash.get('agent') });
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
      if (m.context) ctx = readCtx(m.context);
      applyTheme(m.theme, m.vars);
      document.documentElement.dataset.mode = info.mode;
      readyResolve(info);
    } else if (m.type === 'theme') {
      if (info) info.theme = m.theme;
      applyTheme(m.theme, m.vars);
      emit('_theme', m.theme);
    } else if (m.type === 'context') {
      ctx = readCtx(m.context);
      emit('context', { ...ctx });
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

// ── 插件自己的设置 / 动作 ─────────────────────────────────────────────────
const config = {
  get: () => bjson('_bridge/config'),
  async set(patch, { confirmGrant = false } = {}) {
    const r = await bfetch('_bridge/config', { method: 'POST', body: { patch, confirmGrant } });
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 409 && j && j.needConfirm) {
      const names = (j.needConfirm.accounts || []).map((a) => a.name).join('、');
      if (!(await bridge.confirm({ title: '授权「' + names + '」？', desc: '插件将能以这个账号的身份跑 Claude（它有命令行，权限大）。', yes: '授权', danger: true }))) throw new Error('没有授权');
      return config.set(patch, { confirmGrant: true });
    }
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return j;
  },
};
const options = async (field) => (await bjson('_bridge/options?field=' + encodeURIComponent(field))).options || [];
const actions = async () => (await bjson('_bridge/actions')).actions || [];
const status = () => bjson('_bridge/status');
async function runAct(id, args, { confirm: ask = true } = {}) {
  if (ask) {
    const a = (await actions()).find((x) => x.id === id);
    if (a && (a.confirm || a.danger) && !(await bridge.confirm({ title: a.label + '？', desc: a.confirm || a.desc || '', yes: a.label, danger: !!a.danger }))) return null;
  }
  return bjson('_bridge/action', { action: id, args: args || {} });
}

// ── 设置表单（按清单 schema 画，改了即存）────────────────────────────────
// bridge.form(el, { fields?, exclude?, sections?, onChange? }) → { refresh(), destroy() }
//   fields：只画这些字段（按给的顺序）；exclude：不画这些；sections：只画这些分组。
//   支持：开关、文字 / 多行 / 密码、数字 / 滑块、枚举（分段 / 下拉）、动态选项（下拉）、字符串列表（有选项 = 勾选列表，否则一行一项）。
//   按群设置这类表（map）、对象、账号授权不画（显示一行「在插件详情里改」）。
function form(el, opts = {}) {
  let data = null;
  let destroyed = false;
  const optCache = new Map();
  const en = () => /^en/i.test((info && info.lang) || '');
  const tx = (k, prop, zh) => (en() && data?.i18n?.en?.config?.[k]?.[prop]) || zh || '';
  const enumOf = (k, spec) => (spec.enum || []).map((e) => (e && typeof e === 'object' ? { value: e.value, label: (en() && data?.i18n?.en?.config?.[k]?.enum?.[e.value]) || e.label || String(e.value) } : { value: e, label: String(e) }));
  const visible = (spec) => {
    if (!spec.when) return true;
    return Object.entries(spec.when).every(([f, v]) => (Array.isArray(v) ? v.includes(data.config[f]) : data.config[f] === v));
  };
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  async function save(k, v, revert) {
    try {
      const r = await config.set({ [k]: v });
      data.config = r.config;
      opts.onChange?.(k, r.config[k], r.config);
      draw();
    } catch (e) { bridge.toast(e.message, { error: true }); revert?.(); }
  }
  async function getOptions(k) {
    if (!optCache.has(k)) optCache.set(k, options(k).catch(() => []));
    return optCache.get(k);
  }
  function control(k, spec) {
    const v = data.config[k];
    if (spec.type === 'boolean') {
      const lab = h('label', 'bp-switch');
      const inp = h('input'); inp.type = 'checkbox'; inp.checked = !!v;
      inp.onchange = () => save(k, inp.checked, () => { inp.checked = !inp.checked; });
      lab.append(inp, h('span'));
      return lab;
    }
    if ((spec.type === 'string' || spec.type === 'integer' || spec.type === 'number') && Array.isArray(spec.enum) && spec.enum.length) {
      const list = enumOf(k, spec);
      if (spec.widget === 'segmented' || list.length <= 3) {
        const seg = h('div', 'bp-seg');
        for (const o of list) {
          const b = h('button', o.value === v ? 'on' : '', o.label);
          b.type = 'button';
          b.onclick = () => { if (o.value !== v) save(k, o.value); };
          seg.append(b);
        }
        return seg;
      }
      const sel = h('select', 'bp-select');
      for (const o of list) { const op = h('option', '', o.label); op.value = String(o.value); if (o.value === v) op.selected = true; sel.append(op); }
      sel.onchange = () => { const o = list.find((x) => String(x.value) === sel.value); save(k, o ? o.value : sel.value); };
      return sel;
    }
    if (spec.type === 'string' && spec.options) {
      const sel = h('select', 'bp-select');
      const first = h('option', '', en() ? '(not set)' : '（不选）'); first.value = ''; sel.append(first);
      if (v) { const cur = h('option', '', String(v)); cur.value = v; cur.selected = true; sel.append(cur); }
      getOptions(k).then((list) => {
        if (destroyed) return;
        sel.textContent = ''; sel.append(first);
        for (const o of list) { const op = h('option', '', o.label + (o.desc ? ' · ' + o.desc : '')); op.value = String(o.value); if (o.value === v) op.selected = true; sel.append(op); }
        if (v && !list.some((o) => o.value === v)) { const cur = h('option', '', String(v)); cur.value = v; cur.selected = true; sel.append(cur); }
      });
      sel.onchange = () => save(k, sel.value);
      return sel;
    }
    if (spec.type === 'string') {
      const multi = spec.widget === 'textarea';
      const inp = h(multi ? 'textarea' : 'input', multi ? 'bp-textarea' : 'bp-input');
      if (!multi) inp.type = spec.secret || spec.widget === 'password' ? 'password' : 'text';
      inp.value = v == null ? '' : String(v);
      if (spec.max) inp.maxLength = spec.max;
      inp.onchange = () => save(k, inp.value, () => { inp.value = v == null ? '' : String(v); });
      return inp;
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      const wrap = h('div', 'bp-num');
      const inp = h('input', 'bp-input'); inp.type = 'number';
      if (spec.min != null) inp.min = spec.min; if (spec.max != null) inp.max = spec.max;
      if (spec.type === 'integer') inp.step = '1';
      inp.value = v == null ? '' : String(v);
      inp.onchange = () => { const n = Number(inp.value); save(k, spec.type === 'integer' ? Math.round(n) : n, () => { inp.value = String(v); }); };
      wrap.append(inp);
      return wrap;
    }
    if (spec.type === 'array' && spec.items && !spec.items.fields && spec.items.type !== 'user') {
      const cur = Array.isArray(v) ? v.map(String) : [];
      if (spec.items.options) {
        const box = h('div', 'bp-checks');
        getOptions(k + '[]').then((list) => {
          if (destroyed) return;
          const all = [...list, ...cur.filter((x) => !list.some((o) => String(o.value) === x)).map((x) => ({ value: x, label: x }))];
          for (const o of all) {
            const lab = h('label', 'bp-check');
            const c = h('input'); c.type = 'checkbox'; c.checked = cur.includes(String(o.value));
            c.onchange = () => save(k, c.checked ? [...cur, String(o.value)] : cur.filter((x) => x !== String(o.value)), () => { c.checked = !c.checked; });
            lab.append(c, h('span', '', o.label + (o.desc ? ' · ' + o.desc : '')));
            box.append(lab);
          }
          if (!all.length) box.append(h('div', 'bp-muted', en() ? 'No options yet' : '还没有可选项'));
        });
        return box;
      }
      const ta = h('textarea', 'bp-textarea');
      ta.placeholder = en() ? 'One per line' : '一行一项';
      ta.value = cur.join('\n');
      ta.onchange = () => save(k, ta.value.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean), () => { ta.value = cur.join('\n'); });
      return ta;
    }
    return h('span', 'bp-muted', en() ? 'Edit in the plugin details' : '在插件详情里改');
  }
  function draw() {
    if (destroyed || !data) return;
    el.textContent = '';
    const schema = data.schema || {};
    let keys = Array.isArray(opts.fields) ? opts.fields.filter((k) => schema[k]) : Object.keys(schema);
    if (Array.isArray(opts.exclude)) keys = keys.filter((k) => !opts.exclude.includes(k));
    if (Array.isArray(opts.sections)) keys = keys.filter((k) => opts.sections.includes(schema[k].section || ''));
    const groups = new Map();
    for (const k of keys) {
      const spec = schema[k];
      if (!visible(spec)) continue;
      const sec = spec.section || '';
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push(k);
    }
    for (const [sec, ks] of groups) {
      const section = h('div', 'bp-section');
      if (sec) section.append(h('div', 'bp-section-title', tx(ks[0], 'section', sec)));
      const group = h('div', 'bp-group');
      for (const k of ks) {
        const spec = schema[k];
        const row = h('div', 'bp-row bp-form-row');
        const stacked = !(spec.type === 'boolean');
        if (stacked) row.classList.add('bp-row-stack');
        const main = h('div', 'bp-row-main');
        main.append(h('div', 'bp-row-title', tx(k, 'label', spec.label || k)));
        if (spec.desc) main.append(h('div', 'bp-row-desc', tx(k, 'desc', spec.desc)));
        row.append(main, control(k, spec));
        group.append(row);
      }
      section.append(group);
      el.append(section);
    }
  }
  async function refresh() {
    try { data = await config.get(); optCache.clear(); draw(); }
    catch (e) { el.textContent = ''; el.append(h('div', 'bp-empty', e.message)); }
  }
  refresh();
  return { refresh, destroy() { destroyed = true; el.textContent = ''; } };
}

export const bridge = {
  get info() { return info; },
  config,
  options,
  actions,
  action: runAct,
  status,
  form,
  get embedded() { return embedded; },
  pluginId,
  context: () => ({ ...ctx }),
  ready: () => readyP,
  fetch: bfetch,
  json: bjson,
  on(event, fn) {
    const k = String(event);
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
    if (k !== 'context' && k !== '_theme') openStream();   // 这两种是宿主给的，不用开事件流
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
