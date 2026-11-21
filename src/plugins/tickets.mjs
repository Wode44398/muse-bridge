// 插件页面的票据：插件页面（web/）一律在不透明源里跑（iframe sandbox / CSP sandbox 响应头），拿不到 bridge 的 cookie，
// 也碰不到主页面存的登录令牌。它调插件自己的接口靠这张票：
//   · 只对 /api/plugin/<插件 id>/ 下的接口和这个插件的页面事件流有效（ctx.http.user / admin 认，别处一律不认）；
//   · 身份 = 开面板的那个人（主机或成员），10 分钟不用就失效、用着就续，最长 12 小时；
//   · 请求头 Authorization: Plugin <票> 携带（不是浏览器自动带的凭据，所以没有 CSRF 面）。
// 嵌在设置页里的 iframe 不用票：请求由宿主页代发、带宿主自己的登录态（见 web/src/components/ext/PluginFrame.svelte）。

import crypto from 'node:crypto';

const IDLE_MS = 10 * 60_000;
const MAX_MS = 12 * 3600_000;
const tickets = new Map();   // 票 → { plugin, identity, app, exp, until }

function prune(now = Date.now()) {
  for (const [k, t] of tickets) if (t.exp < now || t.until < now) tickets.delete(k);
}
const sweeper = setInterval(prune, 60_000);
sweeper.unref?.();

// extra.app：这张票是为哪个插件应用签的（应用 id；面板 / 设置页 / 工作台的票为 null）。
// 记在票上而不是让页面自报：以后按应用发的能力（页面宿主）要认「票是给哪个应用的」，页面改地址栏冒充不了。
export function mintTicket(pluginId, identity, extra = {}) {
  prune();
  const tok = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  tickets.set(tok, { plugin: pluginId, identity, app: typeof extra?.app === 'string' && extra.app ? extra.app : null, exp: now + IDLE_MS, until: now + MAX_MS });
  return { ticket: tok, expiresIn: IDLE_MS / 1000 };
}

// 查票并续期；不对这个插件、过期都回 null。
function lookup(tok, pluginId) {
  const t = tok && tickets.get(tok);
  if (!t) return null;
  const now = Date.now();
  if (t.exp < now || t.until < now) { tickets.delete(tok); return null; }
  if (t.plugin !== pluginId) return null;
  t.exp = Math.min(now + IDLE_MS, t.until);
  return t;
}

// 票 → 身份（并续期）；不对这个插件、过期都回 null。
export function resolveTicket(tok, pluginId) {
  const t = lookup(tok, pluginId);
  return t ? t.identity : null;
}

// 票 → { identity, app }（并续期，规则同 resolveTicket）；app = 签票时的应用 id 或 null。
export function resolveTicketInfo(tok, pluginId) {
  const t = lookup(tok, pluginId);
  return t ? { identity: t.identity, app: t.app } : null;
}

export function ticketOf(req) {
  const m = /^Plugin\s+([A-Za-z0-9_-]{16,64})$/.exec(String(req.headers?.authorization || '').trim());
  return m ? m[1] : '';
}

// 请求头自称带了插件票（不管格式对不对）。用票的地方据此判断：自称带票却解析不出票 → 401，
// 不能退回 cookie / NO_AUTH 身份——否则一个格式不对的假票头就能被当成主机。
export function claimsTicket(req) {
  return /^Plugin(\s|$)/i.test(String(req.headers?.authorization || '').trim());
}

// 带着这个插件的有效票、打到插件自己接口上的请求（server.mjs 的两道 Origin 守卫只对它放行）。
// 只看请求头的方案名不够：任意外站带个 `Plugin junk` 就能跳过 Origin 校验。这里只查不续期——守卫不算一次「用票」。
export function validTicketRequest(req, url) {
  const tok = ticketOf(req);
  if (!tok) return false;
  let pluginId = '';
  if (url.pathname === '/api/plugins/page-events') pluginId = url.searchParams.get('id') || '';
  else pluginId = /^\/api\/plugin\/([a-z][a-z0-9-]{0,47})\//.exec(url.pathname)?.[1] || '';
  const t = pluginId && tickets.get(tok);
  const now = Date.now();
  return !!(t && t.plugin === pluginId && t.exp >= now && t.until >= now);
}

// 作废一张票（票上的账号已停用 / 删除时：账号恢复了也别让旧票跟着复活，要从 bridge 里重新打开）
export function revokeTicket(tok) {
  if (tok) tickets.delete(tok);
}

// 某个插件的票全部作废（插件停用 / 卸载时）
export function revokeTickets(pluginId) {
  for (const [k, t] of tickets) if (t.plugin === pluginId) tickets.delete(k);
}

// 跟着内核的 change 事件作废票：插件从开变关（或被卸掉）就把它的票全清掉。
// 光靠「用票时查 isActive」挡得住停用期间的调用，但插件再打开时旧票会跟着复活——
// 停用是主机明确收回了这个插件的权力，开着的旧页面得从 bridge 里重新打开拿新票。
// 按「前后状态对比」做而不是听某个专门的停用事件：内核只有 change 一种事件，热换 / 出错 / 依赖缺失都走它。
const watched = new WeakSet();
export function watchKernelTickets(k) {
  if (!k || typeof k.on !== 'function' || watched.has(k)) return;
  watched.add(k);
  const lastActive = new Map();
  const snapshot = () => { try { return k.list() || []; } catch { return []; } };
  for (const p of snapshot()) lastActive.set(p.id, !!p.active);
  k.on('change', () => {
    const now = new Map(snapshot().map((p) => [p.id, !!p.active]));
    for (const [id, was] of lastActive) if (was && !now.get(id)) revokeTickets(id);
    lastActive.clear();
    for (const [id, on] of now) lastActive.set(id, on);
  });
}
