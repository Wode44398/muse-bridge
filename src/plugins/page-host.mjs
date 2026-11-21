// 宿主请求中转：手机 App 里插件页面是独立的干净页面，没有宿主可 postMessage。
// 页面要跳转、填输入框、要授权、选文件 / 会话时，先在服务端登记一个请求，再让 App 切回主界面处理，处理完页面来取结果：
//
//   POST /api/plugin/<id>/_bridge/host/request { type, payload }  （页面）→ { req }
//   GET  /api/plugin/<id>/_bridge/host/wait?req=                   （页面）→ { done: true, result } | 最多挂 25 秒后 { done: false }
//   GET  /api/plugins/host-requests/<req>                          （主界面，登录态）→ { req, plugin, pluginName, app, appTitle, type, payload }
//   POST /api/plugins/host-requests/<req>/complete { result }      （主界面）→ { ok: true }，唤醒等着的 wait
//
// 请求只在内存，10 分钟过期；每对插件 / 使用者最多 20 个未完成的。主界面那两条在 /api/plugins/ 下，页面够不着：
// 页面只能「提出」，结果（授权、选中的文件）一律由使用者在 bridge 自己画的界面里给。

import crypto from 'node:crypto';
import { kernel } from './state.mjs';
import { findApp } from './ui.mjs';
import { isDeclared, setGrant, hasGrant, PAGE_PERMS } from './page-grants.mjs';
import { signHandles } from './page-files.mjs';

export const HOST_TYPES = Object.freeze(['nav', 'composer', 'grant', 'pick.file', 'pick.session']);
export const HOST_TTL_MS = 10 * 60_000;
export const HOST_OPEN_MAX = 20;
export const HOST_WAIT_MS = 25_000;
const NAV_TO = ['session', 'file', 'app', 'settings', 'home'];
const SID_RE = /^[0-9A-Za-z-]{8,80}$/;
const APP_REF_RE = /^(?:[a-z][a-z0-9-]{0,47}:)?[a-z][a-z0-9-]{0,31}$/;

const err = (status, message) => Object.assign(new Error(message), { status });
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const requests = new Map();   // req → { req, plugin, ownerKey, app, type, payload, created, expires, done, result }
const waiters = new Map();    // req → Set<() => void>

function prune(now = Date.now()) {
  for (const [k, r] of requests) if (r.expires < now) { requests.delete(k); wake(k); }
}
const sweeper = setInterval(prune, 60_000);
sweeper.unref?.();

function wake(id) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const fn of set) { try { fn(); } catch {} }
}

// 载荷清洗：只留认识的字段，超长截断；类型不认识、关键字段不对直接 400。
function cleanPayload(pluginId, type, p) {
  const x = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  if (type === 'nav') {
    const to = String(x.to || '');
    if (!NAV_TO.includes(to)) throw err(400, `nav 的 to 只能是 ${NAV_TO.join(' / ')}`);
    const out = { to };
    if (to === 'session') {
      if (!SID_RE.test(String(x.session || ''))) throw err(400, 'nav 到会话要 session（会话 id）');
      out.session = String(x.session);
    }
    if (to === 'file') {
      out.rel = str(x.rel, 2000);
      if (x.ws) out.ws = str(x.ws, 2000);
    }
    if (to === 'app') {
      if (!APP_REF_RE.test(String(x.app || ''))) throw err(400, "nav 到应用要 app（应用 id，或 '<插件>:<应用 id>'）");
      out.app = String(x.app);
    }
    return out;
  }
  if (type === 'composer') return { text: str(x.text, 20000) };
  if (type === 'grant') {
    const perm = String(x.perm || '');
    if (!PAGE_PERMS.includes(perm) || !isDeclared(pluginId, perm)) throw err(400, `插件没有声明「${perm}」这个页面权限`);
    return { perm };
  }
  if (type === 'pick.file') return { multiple: x.multiple === true, accept: str(x.accept, 200) };
  return {};   // pick.session
}

/** 页面登记一个宿主请求。c = 使用者身份上下文；app = 票据里的应用 id（嵌入模式为请求体里的，可空）。 */
export function createHostRequest(c, pluginId, app, type, payload) {
  const t = String(type || '');
  if (!HOST_TYPES.includes(t)) throw err(400, `type 只能是 ${HOST_TYPES.join(' / ')}`);
  const clean = cleanPayload(pluginId, t, payload);
  prune();
  let open = 0;
  for (const r of requests.values()) if (!r.done && r.plugin === pluginId && r.ownerKey === c.key) open++;
  if (open >= HOST_OPEN_MAX) throw err(429, `挂着没处理的宿主请求太多了（最多 ${HOST_OPEN_MAX} 个），先处理完前面的`);
  const id = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  requests.set(id, { req: id, plugin: pluginId, ownerKey: c.key, app: app || null, type: t, payload: clean, created: now, expires: now + HOST_TTL_MS, done: false, result: null });
  return { req: id };
}

// 拿一个还有效的请求；不是这个人的、过期的一律当不存在（不告诉别人「有这么个请求」）
function own(id, ownerKey, pluginId) {
  const r = typeof id === 'string' ? requests.get(id) : null;
  if (!r) return null;
  if (r.expires < Date.now()) { requests.delete(id); wake(id); return null; }
  if (r.ownerKey !== ownerKey || (pluginId != null && r.plugin !== pluginId)) return null;
  return r;
}

/**
 * 页面等结果：完成了马上回 { done: true, result }，否则最多挂 ms 毫秒回 { done: false }。
 * signal（AbortSignal）：页面断开时提前收掉，不留挂着的等待者。
 */
export function waitHostRequest(id, pluginId, ownerKey, { ms = HOST_WAIT_MS, signal } = {}) {
  const r = own(id, ownerKey, pluginId);
  if (!r) return Promise.reject(err(404, '没有这个宿主请求（不是你的，或已过期）'));
  if (r.done) return Promise.resolve({ done: true, result: r.result });
  return new Promise((resolve) => {
    let t = null;
    const finish = () => {
      clearTimeout(t);
      waiters.get(id)?.delete(finish);
      const now = requests.get(id);
      resolve(now && now.done ? { done: true, result: now.result } : { done: false });
    };
    if (!waiters.has(id)) waiters.set(id, new Set());
    waiters.get(id).add(finish);
    t = setTimeout(finish, ms);
    t.unref?.();
    if (signal) {
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }
  });
}

/** 主界面读一个请求（ownerKey 必须对得上）。 */
export function hostRequestView(id, c) {
  const r = own(id, c?.key, null);
  if (!r) throw err(404, '没有这个请求（不是你的，或已过期）');
  if (r.done) throw err(409, '这个请求已经处理过了');
  const p = kernel.get(r.plugin);
  const app = r.app ? findApp(c, r.plugin, r.app) : null;
  return { req: r.req, plugin: r.plugin, pluginName: p?.name || r.plugin, app: r.app, appTitle: app?.title || null, type: r.type, payload: r.payload };
}

/** 主界面处理完：按类型把结果整理好记下，唤醒等着的页面。 */
export function completeHostRequest(id, c, result) {
  const r = own(id, c?.key, null);
  if (!r) throw err(404, '没有这个请求（不是你的，或已过期）');
  if (r.done) throw err(409, '这个请求已经处理过了');
  const x = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const settle = (value) => { r.done = true; r.result = value; wake(id); };
  if (r.type === 'nav' || r.type === 'composer') {
    settle({ ok: !!x.ok });
  } else if (r.type === 'grant') {
    const perm = r.payload.perm;
    let granted = hasGrant(r.plugin, c.key, perm);
    if (x.allow === true && !granted) {
      try { granted = !!setGrant(c, r.plugin, perm, true)[perm]; } catch (e) { settle({ granted: false }); throw e; }
    }
    settle({ granted });
  } else if (r.type === 'pick.file') {
    if (x.cancelled || !Array.isArray(x.items) || !x.items.length) {
      settle({ cancelled: true });
    } else {
      const items = r.payload.multiple ? x.items : x.items.slice(0, 1);
      let files;
      // 签不出来（没授权、文件不合格……）：页面那头按取消收场（别让它干等 10 分钟），主界面这头照样拿到报错
      try { files = signHandles(c, r.plugin, items, 'rw'); } catch (e) { settle({ cancelled: true, error: String(e?.message || e) }); throw e; }
      settle({ files });
    }
  } else {
    // pick.session
    if (x.cancelled || !SID_RE.test(String(x.sessionId || ''))) settle({ cancelled: true });
    else settle({ sessionId: String(x.sessionId), title: str(x.title, 200) });
  }
  return { ok: true };
}

// 测试用
export const _hostRequestCount = () => requests.size;
