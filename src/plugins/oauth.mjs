// ctx.oauth（插件接口四期）：OAuth 2.0 授权码 + PKCE 助手。插件接 GitHub、Google、飞书这类要用户授权的服务时，
// 不用自己写跳转、回调、换令牌、刷新。
//
//   const gh = ctx.oauth.client('github', {
//     authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
//     clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: ['repo'], extraParams: {},
//     onConnected: () => ctx.status.refresh(),
//   });
//   gh.redirectUri()          → 要在对方后台登记的回调地址（<公网地址>/api/plugin-oauth/<插件>/<名字>/callback）
//   gh.startUrl()             → 让主机在浏览器里打开的地址（一次性、10 分钟有效；面板里用 bridge.openExternal 打开）
//   await gh.token()          → 有效的 access_token（快过期自动刷新）；没授权抛错
//   await gh.fetch(url, init) → 自动带 Authorization: Bearer，401 时刷新重试一次
//   gh.status() / gh.logout()
// 令牌加密存在插件数据目录 oauth/（同扩展中心的凭据：AES-256-GCM + 系统保护的数据密钥），不进插件配置、不回给页面。
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readSecrets, writeSecrets } from '../extension-secrets.mjs';
import { PUBLIC_ORIGIN, PORT } from '../config/index.mjs';
// 访问 bridge 用的公网地址（同 routes/mcp-oauth.mjs publicOriginOf 的口径；不引那个路由模块，它的依赖太重）
const LOOPBACK = /^(127\.|localhost(:|$)|\[::1\])/i;
function publicOriginOf(req, configured) {
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  let proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (!proto) { try { proto = JSON.parse(String(h['cf-visitor'] || '{}')).scheme || ''; } catch {} }
  if (!/^https?$/.test(proto)) proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  if (host && !LOOPBACK.test(host) && /^[\w.\-:[\]]+$/.test(host)) return proto + '://' + host;
  if (configured) return String(configured).replace(/\/+$/, '');
  return host ? proto + '://' + host : '';
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
  + `<body style="font:15px/1.6 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#222">`
  + `<h2 style="font-weight:600">${title}</h2><p>${body}</p></body>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function makeOAuth(ctx) {
  return {
    client(name, conf = {}) {
      if (!NAME_RE.test(String(name || ''))) throw new Error(`OAuth 客户端名「${name}」不对（小写字母开头，只用小写字母、数字、连字符）`);
      for (const k of ['authorizeUrl', 'tokenUrl', 'clientId']) if (!conf[k]) throw new Error(`ctx.oauth.client 缺 ${k}`);
      const dir = path.join(ctx.dataDir, 'oauth');
      const base = `/api/plugin-oauth/${ctx.id}/${name}`;
      const starts = new Map();   // 一次性启动令牌 → 到期时间
      const pending = new Map();  // state → { verifier, redirectUri, exp }
      const read = () => { try { return readSecrets(dir)[name] || null; } catch (e) { ctx.warn('OAuth 令牌读不出来：', e?.message || e); return null; } };
      const write = (rec) => { const all = (() => { try { return { ...readSecrets(dir) }; } catch { return {}; } })(); if (rec) all[name] = rec; else delete all[name]; writeSecrets(dir, all); };
      const origin = () => String(PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
      const scopeStr = () => (Array.isArray(conf.scopes) ? conf.scopes.join(conf.scopeSeparator ?? ' ') : String(conf.scopes || ''));

      async function tokenRequest(params) {
        const body = new URLSearchParams({ client_id: conf.clientId, ...(conf.clientSecret ? { client_secret: conf.clientSecret } : {}), ...params });
        const r = await fetch(conf.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
        const text = await r.text();
        let j = null;
        try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }   // 老式 GitHub 回 form 编码
        if (!r.ok || !j?.access_token) throw new Error(`换令牌失败（${r.status}）：${String(j?.error_description || j?.error || text).slice(0, 200)}`);
        return j;
      }
      const save = (j, prev) => {
        const rec = {
          access_token: j.access_token,
          refresh_token: j.refresh_token || prev?.refresh_token || '',
          token_type: j.token_type || 'Bearer',
          scope: j.scope || prev?.scope || scopeStr(),
          expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : 0,
          at: Date.now(),
        };
        write(rec);
        return rec;
      };

      ctx.route('GET', base + '/start', (req, res, url) => {
        const t = url.searchParams.get('t') || '';
        const exp = starts.get(t);
        starts.delete(t);
        if (!exp || exp < Date.now()) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('链接过期了', '回到 bridge 的插件面板重新点「连接」。')); return; }
        const verifier = b64url(randomBytes(32));
        const state = b64url(randomBytes(18));
        const redirectUri = (conf.redirectOrigin || publicOriginOf(req, PUBLIC_ORIGIN) || origin()).replace(/\/+$/, '') + base + '/callback';
        pending.set(state, { verifier, redirectUri, exp: Date.now() + 15 * 60_000 });
        const q = new URLSearchParams({
          response_type: 'code', client_id: conf.clientId, redirect_uri: redirectUri, state,
          ...(scopeStr() ? { scope: scopeStr() } : {}),
          ...(conf.pkce === false ? {} : { code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }),
          ...(conf.extraParams || {}),
        });
        res.writeHead(302, { Location: conf.authorizeUrl + (conf.authorizeUrl.includes('?') ? '&' : '?') + q, 'Cache-Control': 'no-store' });
        res.end();
      });
      ctx.route('GET', base + '/callback', async (req, res, url) => {
        const html = (code, title, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(title, body)); };
        const st = url.searchParams.get('state') || '';
        const p = pending.get(st);
        pending.delete(st);
        if (!p || p.exp < Date.now()) return html(400, '授权已失效', '回到 bridge 的插件面板重新点「连接」。');
        if (url.searchParams.get('error')) return html(400, '没有授权', esc(url.searchParams.get('error_description') || url.searchParams.get('error')));
        try {
          const j = await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: p.redirectUri, ...(conf.pkce === false ? {} : { code_verifier: p.verifier }) });
          save(j, null);
          ctx.log(`OAuth「${name}」已授权`);
          try { await conf.onConnected?.(); } catch (e) { ctx.warn('onConnected 出错：', e?.message || e); }
          html(200, '已连接', `${esc(ctx.meta.name || ctx.id)} 拿到授权了，可以关掉这个页面回到 bridge。`);
        } catch (e) {
          ctx.warn(`OAuth「${name}」${e.message}`);
          html(502, '授权没完成', esc(e.message));
        }
      });
      ctx.setInterval(() => {
        const now = Date.now();
        for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
        for (const [k, v] of starts) if (v < now) starts.delete(k);
      }, 5 * 60_000);

      const client = {
        redirectUri: (o) => String(o || conf.redirectOrigin || origin()).replace(/\/+$/, '') + base + '/callback',
        startUrl(o) {
          const t = b64url(randomBytes(18));
          starts.set(t, Date.now() + 10 * 60_000);
          return String(o || origin()).replace(/\/+$/, '') + base + '/start?t=' + t;
        },
        status() {
          const r = read();
          return r ? { connected: true, scope: r.scope, expiresAt: r.expires_at || null, refreshable: !!r.refresh_token, at: r.at } : { connected: false };
        },
        async token({ force = false } = {}) {
          const r = read();
          if (!r) throw new Error(`还没授权「${name}」：在插件面板里点「连接」`);
          const stale = force || (r.expires_at && r.expires_at - 60_000 < Date.now());
          if (!stale) return r.access_token;
          if (!r.refresh_token) { if (force) throw new Error(`「${name}」的授权过期了，要重新连接`); return r.access_token; }
          const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r.refresh_token });
          return save(j, r).access_token;
        },
        async fetch(u, init = {}) {
          const go = async (force) => fetch(u, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + (await client.token({ force })) } });
          const r = await go(false);
          if (r.status !== 401 || !read()?.refresh_token) return r;
          return go(true);
        },
        logout() { write(null); },
      };
      return client;
    },
  };
}
