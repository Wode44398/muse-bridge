// 插件页面的票据：插件页面（web/）一律在不透明源里跑（iframe sandbox / CSP sandbox 响应头），拿不到 bridge 的 cookie，
// 也碰不到主页面存的登录令牌。它调插件自己的接口靠这张票：
//   · 只对 /api/plugin/<插件 id>/ 下的接口和这个插件的页面事件流有效（ctx.http.user / admin 认，别处一律不认）；
//   · 身份 = 开面板的那个人（主机或成员），10 分钟不用就失效、用着就续，最长 12 小时；
//   · 请求头 Authorization: Plugin <票> 携带（不是浏览器自动带的凭据，所以没有 CSRF 面）。
// 嵌在设置页里的 iframe 不用票：请求由宿主页代发、带宿主自己的登录态（见 web/src/components/ext/PluginFrame.svelte）。

import crypto from 'node:crypto';

const IDLE_MS = 10 * 60_000;
const MAX_MS = 12 * 3600_000;
const tickets = new Map();   // 票 → { plugin, identity, exp, until }

function prune(now = Date.now()) {
  for (const [k, t] of tickets) if (t.exp < now || t.until < now) tickets.delete(k);
}
const sweeper = setInterval(prune, 60_000);
sweeper.unref?.();

export function mintTicket(pluginId, identity) {
  prune();
  const tok = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  tickets.set(tok, { plugin: pluginId, identity, exp: now + IDLE_MS, until: now + MAX_MS });
  return { ticket: tok, expiresIn: IDLE_MS / 1000 };
}

// 票 → 身份（并续期）；不对这个插件、过期都回 null。
export function resolveTicket(tok, pluginId) {
  const t = tok && tickets.get(tok);
  if (!t) return null;
  const now = Date.now();
  if (t.exp < now || t.until < now) { tickets.delete(tok); return null; }
  if (t.plugin !== pluginId) return null;
  t.exp = Math.min(now + IDLE_MS, t.until);
  return t.identity;
}

export function ticketOf(req) {
  const m = /^Plugin\s+([A-Za-z0-9_-]{16,64})$/.exec(String(req.headers?.authorization || '').trim());
  return m ? m[1] : '';
}

// 某个插件的票全部作废（插件停用 / 卸载时）
export function revokeTickets(pluginId) {
  for (const [k, t] of tickets) if (t.plugin === pluginId) tickets.delete(k);
}
