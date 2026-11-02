// 外部登录（插件接口四期，第二批）：ctx.auth.provider({ id, label, icon?, start, callback })。
//
// 插件接一个外部身份源（企业 SSO / OIDC、飞书、GitHub……），登录页多一个「用 X 登录」按钮。流程由核心管：
//   GET /api/auth/ext/start?p=<插件>.<id>       → 核心铸 state（10 分钟、一次性）→ start(req, { callbackUrl, state }) 回授权地址（核心 302 过去）
//   GET /api/auth/ext/callback/<插件>/<id>       → 核心核对 state → callback(req, url, { callbackUrl, state }) 回 { login } | { email } | { error }
//                                                 → 只映射到【已有的】成员账号（不自动建号、不能登成服务器主机）→ 发会话 cookie → 回首页
// 账号停用、多用户关着（只剩服务账号能登）都照登录页的规矩拒。手机 App 走不了浏览器跳转，这条只给网页 / 桌面端。
import { randomBytes } from 'node:crypto';
import { kernel } from './state.mjs';
import * as users from '../users.mjs';
import { FEATURES, PUBLIC_ORIGIN } from '../config/index.mjs';
import { emitBridgeEvent } from './events.mjs';

export const AUTH_SLOT = 'auth.providers';
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const pending = new Map();   // state → { key: 插件.id, exp, callbackUrl }

export function addAuthProvider(ctx, spec) {
  if (!spec || !ID_RE.test(String(spec.id || ''))) throw new Error('外部登录要有 id（小写字母开头，只用小写字母、数字、连字符）');
  if (typeof spec.start !== 'function' || typeof spec.callback !== 'function') throw new Error('外部登录要有 start 与 callback 两个函数');
  return ctx.contribute(AUTH_SLOT, { id: spec.id, label: String(spec.label || spec.id).slice(0, 40), icon: typeof spec.icon === 'string' ? spec.icon.slice(0, 2000) : '', start: spec.start, callback: spec.callback });
}

function findProvider(key) {
  if (!kernel.started) return null;
  const [plugin, id] = String(key || '').split('.');
  const hit = kernel.slot(AUTH_SLOT).entries().find(({ item, owner }) => owner === plugin && item.id === id);
  return hit ? { ...hit.item, plugin } : null;
}

/** 登录页用：[{ key, plugin, label, icon }]。 */
export function listAuthProviders() {
  if (!kernel.started) return [];
  return kernel.slot(AUTH_SLOT).entries().map(({ item, owner }) => ({ key: `${owner}.${item.id}`, plugin: owner, label: item.label, icon: item.icon }));
}

const LOOPBACK = /^(127\.|localhost(:|$)|\[::1\])/i;
function originOf(req) {
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  let proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (!/^https?$/.test(proto)) proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  if (host && !LOOPBACK.test(host) && /^[\w.\-:[\]]+$/.test(host)) return proto + '://' + host;
  return String(PUBLIC_ORIGIN || (host ? proto + '://' + host : '')).replace(/\/+$/, '');
}
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
  + `<body style="font:15px/1.6 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:420px;margin:15vh auto;padding:0 20px">`
  + `<h2 style="font-weight:600">${title}</h2><p>${body}</p><p><a href="/">回到登录页</a></p></body>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** routes/auth.mjs 调：挂三条路由。userCookie = 发成员会话 cookie 的函数。 */
export function registerAuthProviderRoutes(router, { userCookie }) {
  const html = (res, code, title, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(title, body)); };
  router.on('GET', '/api/auth/providers', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ providers: listAuthProviders().map(({ key, label, icon }) => ({ key, label, icon })) }));
  });
  router.on('GET', '/api/auth/ext/start', async (req, res, url) => {
    const key = url.searchParams.get('p') || '';
    const p = findProvider(key);
    if (!p) return html(res, 404, '没有这个登录方式', '插件可能被关掉了。');
    const state = randomBytes(18).toString('base64url');
    const callbackUrl = `${originOf(req)}/api/auth/ext/callback/${p.plugin}/${p.id}`;
    pending.set(state, { key, exp: Date.now() + 10 * 60_000, callbackUrl });
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
    try {
      const to = await p.start(req, { callbackUrl, state });
      if (res.writableEnded) return;
      if (typeof to !== 'string' || !/^https?:\/\//i.test(to)) return html(res, 500, '登录方式出错了', '插件没给出授权地址。');
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      res.end();
    } catch (e) { html(res, 500, '登录方式出错了', esc(String(e?.message || e).slice(0, 200))); }
  });
  // 有的调用方（单测）给的是只有精确路由的简易路由器：没有 prefix 就不挂回调（外部登录在那里本来也用不上）
  router.prefix?.('GET', '/api/auth/ext/callback/', async (req, res, url) => {
    const [plugin, id] = url.pathname.slice('/api/auth/ext/callback/'.length).split('/');
    const key = `${plugin}.${id}`;
    const state = url.searchParams.get('state') || '';
    const pend = pending.get(state);
    pending.delete(state);
    if (!pend || pend.key !== key || pend.exp < Date.now()) return html(res, 400, '登录已失效', '回到登录页重新点一次。');
    const p = findProvider(key);
    if (!p) return html(res, 404, '没有这个登录方式', '插件可能被关掉了。');
    let r;
    try { r = await p.callback(req, url, { callbackUrl: pend.callbackUrl, state }); }
    catch (e) { return html(res, 502, '登录没完成', esc(String(e?.message || e).slice(0, 200))); }
    if (res.writableEnded) return;
    if (!r || r.error) return html(res, 403, '登录没完成', esc(r?.error || '对方没有给出身份'));
    // 只映射到已有账号：按登录名，或按账号里记的邮箱
    let u = r.login ? users.getUser(String(r.login)) : null;
    if (!u && r.email) u = (users.listUsers?.() || []).map((x) => users.getUser(x.id || x.name)).find((x) => x && String(x.email || '').toLowerCase() === String(r.email).toLowerCase()) || null;
    if (!u) return html(res, 403, '没有对应的账号', `${esc(r.login || r.email || '')} 在这台 bridge 上没有账号。请管理员先给你开账号（外部登录只认已有账号）。`);
    if (u.disabled) return html(res, 403, '账号已停用', '请联系管理员。');
    if (!FEATURES.multiUser && !users.userGrants(u).service) return html(res, 403, '这台主机只接受访问令牌登录', '');
    const tok = users.createSession(u.id || u.name);
    emitBridgeEvent('user.login', { kind: 'user', login: u.name, id: String(u.id || ''), via: 'plugin:' + key });
    res.writeHead(302, { Location: '/', 'Set-Cookie': userCookie(req, tok), 'Cache-Control': 'no-store' });
    res.end();
  });
}
