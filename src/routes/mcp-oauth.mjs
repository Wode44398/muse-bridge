// 远程连接器的 OAuth 授权接口（流程本体见 runtime/mcp-oauth.mjs）：
//   POST /api/mcp-oauth/start    { session, server }        → 流程（authUrl / scheme / 状态）
//   POST /api/mcp-oauth/submit   { flow, url }              → localhost 那条路：用户粘回来的完整回调地址
//   POST /api/mcp-oauth/confirm  { flow }                   → 「我已完成」：重连一次看连上没有
//   POST /api/mcp-oauth/cancel   { flow }
//   GET  /api/mcp-oauth/status?flow=                        → 前端轮询
//   GET  /api/mcp-oauth/callback?code=&state=               → 授权服务器跳回来（不要求登录，只认进行中流程的 state）
//   GET  /api/mcp-oauth/app?connector=                      → 自备 OAuth 应用：这个连接器要不要、配了没有、配置指引要的数据
//   POST /api/mcp-oauth/app          { connector, clientId, clientSecret?, redirectUri }
//   POST /api/mcp-oauth/app/remove   { connector }
// 授权服务器不开放动态注册（Google、Zoom……）时，CLI 拿不到授权地址：改由 bridge 用服主自备的 OAuth 应用授权
// （runtime/mcp-oauth-app.mjs），流程照样挂在同一本台账里，前端看不出差别。
// 结局（成功 / 失败 / 过期）经总线 {type:'mcp_auth'} 推给这个身份的各设备；成功时附带 {type:'mcp'} 连接器新状态。
import * as claudeProjects from '../claude-projects.mjs';
import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { noteSessionMcp, sessionMcp } from '../runtime/session-mcp.mjs';
import { PUBLIC_ORIGIN } from '../config/index.mjs';
import { startMcpAuth, startExternalFlow, submitMcpCallback, confirmMcpAuth, cancelMcpAuth, flowByState, flowFor, flowView, reconnectLive, EGRESS_BLOCKED_MSG } from '../runtime/mcp-oauth.mjs';
import { spawnAuthQuery } from '../runtime/mcp-oauth-query.mjs';
import { probeConnectors, noteConnectorStatus, forgetConnectorStatus, slimStatus, clearMcpTokens, hasMcpTokens, rawStatus } from '../runtime/mcp-probe.mjs';
import { discoverAuth, getApp, publicApp, saveApp, removeApp, buildAuthRequest, exchangeCode, writeTokens, PROVIDERS } from '../runtime/mcp-oauth-app.mjs';
import { connectorForAuth, connectorForServer, remoteConnectorsForProbe } from '../extensions.mjs';

export const CALLBACK_PATH = '/api/mcp-oauth/callback';
const EXT_SID = 'ext:';   // 扩展页发起的流程挂在这个「会话」名下（不是真会话）
const LOOPBACK = /^(127\.|localhost(:|$)|\[::1\])/i;

// 用户访问 bridge 用的公开地址：反代 / Cloudflare Tunnel 带的 X-Forwarded-* 优先（Forwarded 标准头次之），
// 拿到的是回环地址（本机直连、或反代没带头）就用配置的公网地址；都没有才只好用回环（同机浏览器也能用）。
export function publicOriginOf(req, configured = PUBLIC_ORIGIN) {
  const h = req.headers || {};
  const fwd = String(h.forwarded || '').split(',')[0];
  const fwdHost = (/host="?([^;,"]+)/i.exec(fwd) || [])[1] || '';
  const fwdProto = (/proto="?([^;,"]+)/i.exec(fwd) || [])[1] || '';
  const host = String(h['x-forwarded-host'] || fwdHost || h.host || '').split(',')[0].trim();
  let proto = String(h['x-forwarded-proto'] || fwdProto || '').split(',')[0].trim().toLowerCase();
  if (!proto) { try { proto = JSON.parse(String(h['cf-visitor'] || '{}')).scheme || ''; } catch {} }
  if (!/^https?$/.test(proto)) proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  if (host && !LOOPBACK.test(host) && /^[\w.\-:[\]]+$/.test(host)) return proto + '://' + host;
  if (configured) return String(configured).replace(/\/+$/, '');
  return host ? proto + '://' + host : '';
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function body(req, res) {
  try { return JSON.parse(await readBody(req, 16 * 1024)) || {}; } catch { json(res, 400, { error: 'bad json' }); return null; }
}

// 流程结局 → 推给这个身份的各设备；成功时把连接器新状态记进会话（面板据此刷新）
// 扩展页发起的（sessionId = 'ext:<连接器 id>'）不属于任何会话：新状态记进扩展页的状态缓存
function settled(key, ctx = null) {
  return (v) => {
    const extId = String(v.sessionId || '').startsWith(EXT_SID) ? v.sessionId.slice(EXT_SID.length) : '';
    let conn = null;
    if (extId) {
      const got = Array.isArray(v.servers) ? v.servers.find((s) => s && s.name === v.server) : null;
      if (got) { conn = { ...slimStatus(got), oauth: !!ctx && hasMcpTokens(ctx, v.server) }; noteConnectorStatus(key, extId, got, { oauth: conn.oauth }); }
      else forgetConnectorStatus(key, extId);
    } else if (v.status === 'done' && Array.isArray(v.servers)) {
      // 只改刚授权的这一个：临时进程的清单里没有会话自己的进程内工具（媒体、浏览器……），不能拿它整份替换
      const prev = (sessionMcp(key, v.sessionId) || {}).servers || [];
      const got = v.servers.find((s) => s && s.name === v.server);
      const list = prev.length ? prev.map((s) => (got && s.name === v.server ? { ...s, status: got.status } : s)) : v.servers;
      const servers = noteSessionMcp(key, v.sessionId, list);
      busPublish(key, { type: 'mcp', sessionId: v.sessionId, servers });
    }
    const { authUrl, servers, ...slim } = v;   // 授权链接不在总线上广播
    busPublish(key, { type: 'mcp_auth', ...slim, ...(conn ? { connector: conn } : {}) });
  };
}

// —— 自备 OAuth 应用 ——
const NEEDS_APP = '这个连接器的授权服务器不支持动态注册客户端，要先给它配置 OAuth 应用（设置 › 扩展 › 连接器 › 这个连接器），配置要服主来做';
const DCR_ERR = /动态注册|dynamic client registration/i;

// 授权服务器不开放动态注册 → 走自备应用：{ d, app, appError }。null = 照旧交给 CLI（不要 OAuth、支持动态注册、探不到）
async function appRoute(config) {
  if (!config || !/^(http|sse)$/.test(config.type) || !config.url) return null;
  let d;
  try { d = await discoverAuth(config.url); } catch { return null; }
  if (!d.oauth || d.dcr) return null;
  try { return { d, app: getApp(d.issuer), appError: '' }; }
  catch (e) { return { d, app: null, appError: 'OAuth 应用配置解不开：' + String((e && e.message) || e) }; }
}

// 用自备应用开一个授权流程：令牌写进这个身份的凭据文件，之后 CLI 自己用、自己续
function startAppFlow(ctx, sid, c, r, onSettled) {
  const { authUrl, state, verifier } = buildAuthRequest(r.d, r.app);
  return startExternalFlow({
    key: ctx.key, sid, server: c.server, authUrl, state, redirectUri: r.app.redirectUri,
    exchange: async (url) => { writeTokens(ctx, c.server, c.config, r.d, r.app, await exchangeCode(r.d, r.app, verifier, url)); },
    verify: () => rawStatus(ctx, { [c.server]: c.config }),
    onSettled,
  });
}

// 扩展页的状态表：不开放动态注册的连接器标上 oauthApp；已经配了应用的，CLI 报的「不支持动态注册」改成「需要登录」。
// Gmail 这类列工具不要登录、调工具才 401 的，没令牌时 CLI 照样报「已连接」——其实用不了，也改成「需要登录」
async function annotateApps(statuses, list) {
  await Promise.all(list.map(async (x) => {
    const st = statuses[x.id];
    if (!st || (st.status === 'connected' && st.oauth)) return;
    const r = await appRoute(x.config);
    if (!r) return;
    const { error, ...rest } = st;
    const fix = st.status === 'connected' || (r.app && st.status === 'failed' && DCR_ERR.test(error || ''));
    statuses[x.id] = { ...(fix ? { ...rest, status: 'needs-auth' } : st), oauthApp: { issuer: r.d.issuer, provider: r.d.provider, configured: !!r.app } };
  }));
  return statuses;
}

function page(res, code, ok, text, sub, lang) {
  const zh = lang !== 'en';
  const title = ok ? (zh ? '授权成功' : 'Connected') : (zh ? '授权没有完成' : 'Authorization failed');
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" + (ok ? "; script-src 'unsafe-inline'" : ''), 'X-Frame-Options': 'DENY',
  });
  // 成功：这页多半是 bridge 用脚本开的标签，过一会儿自己关掉回到 bridge（关不掉——用户自己开的——就留着这句话）
  const closer = ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script>' : '';
  res.end(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#faf9f5;color:#141413}
@media (prefers-color-scheme:dark){body{background:#262624;color:#faf9f5}p{color:#b0aea5!important}}
main{max-width:360px;padding:32px 24px;text-align:center}.mk{width:44px;height:44px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;font-size:22px;color:#fff;background:${ok ? '#5a8f5a' : '#c0583e'}}
h1{font-size:19px;font-weight:600;margin:0 0 8px}p{margin:0;color:#5e5d59}</style></head>
<body><main><div class="mk">${ok ? '&#10003;' : '!'}</div><h1>${esc(title)}</h1><p>${esc(text)}</p>${sub ? `<p style="margin-top:8px;font-size:13px">${esc(sub)}</p>` : ''}</main>${closer}</body></html>`);
}

export function registerMcpOAuthRoutes(router, { identify }) {
  router.on('POST', '/api/mcp-oauth/start', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.snap) { json(res, 403, { error: 'forbidden' }); return; }
    const b = await body(req, res); if (!b) return;
    const origin = publicOriginOf(req);
    // 扩展页「连接器」：按连接器 id 发起，不需要会话（刚添加、还没开过对话就能登录）。只挂这一个服务起短命 CLI
    if (b.connector) {
      if (ctx.kind !== 'admin') { json(res, 403, { error: '扩展管理仅对管理员开放' }); return; }
      const c = connectorForAuth(b.connector);
      if (!c) { json(res, 404, { error: '连接器不存在' }); return; }
      if (c.config.type === 'stdio') { json(res, 400, { error: '本地连接器不需要授权' }); return; }
      const r = await appRoute(c.config);
      if (r) {
        if (!r.app) { json(res, 409, { error: r.appError || NEEDS_APP, code: 'needs_app' }); return; }
        try { json(res, 200, startAppFlow(ctx, EXT_SID + c.item.id, c, r, settled(ctx.key, ctx))); }
        catch (e) { json(res, e.status || 500, { error: String((e && e.message) || e) }); }
        return;
      }
      try {
        const v = await startMcpAuth({
          key: ctx.key, sid: EXT_SID + c.item.id, server: c.server, precheck: true,
          redirectUri: origin ? origin + CALLBACK_PATH : '',
          spawn: () => spawnAuthQuery(ctx, { only: { [c.server]: c.config } }),
          onSettled: settled(ctx.key, ctx),
        });
        json(res, 200, v);
      } catch (e) { json(res, e.status || 500, { error: String((e && e.message) || e) }); }
      return;
    }
    const sid = String(b.session || ''), server = String(b.server || '');
    if (!/^[0-9a-fA-F-]{8,80}$/.test(sid) || !server || server.length > 200) { json(res, 400, { error: 'bad request' }); return; }
    // 会话必须是这个身份的（定位得到即所有权证明）；短命进程用它所在的项目目录当 cwd（项目级 .mcp.json 才读得到）
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid);
    if (!p) { json(res, 404, { error: 'not found' }); return; }
    const cwd = (p.project && p.project.path) || ctx.cwd;
    // 扩展里装的远程连接器：授权服务器不开放动态注册就用服主配的 OAuth 应用
    const cs = connectorForServer(server);
    const r = cs ? await appRoute(cs.config) : null;
    if (r) {
      if (!r.app) { json(res, 409, { error: r.appError || NEEDS_APP, code: 'needs_app' }); return; }
      try { json(res, 200, startAppFlow({ ...ctx, cwd }, sid, cs, r, settled(ctx.key))); }
      catch (e) { json(res, e.status || 500, { error: String((e && e.message) || e) }); }
      return;
    }
    try {
      const v = await startMcpAuth({
        key: ctx.key, sid, server,
        redirectUri: origin ? origin + CALLBACK_PATH : '',
        spawn: () => spawnAuthQuery({ ...ctx, cwd }),
        onSettled: settled(ctx.key),
      });
      json(res, 200, v);
    } catch (e) {
      json(res, e.status || 500, { error: String((e && e.message) || e) });
    }
  });

  router.on('POST', '/api/mcp-oauth/submit', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const b = await body(req, res); if (!b) return;
    const f = flowFor(ctx.key, b.flow);
    if (!f) { json(res, 404, { error: '这次授权已经结束或过期，请重新点「授权」' }); return; }
    const r = await submitMcpCallback(f, b.url);
    if (!r.ok) { json(res, r.status || 400, { error: r.error, flow: flowView(f) }); return; }
    json(res, 200, r.flow);
  });

  router.on('POST', '/api/mcp-oauth/confirm', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const b = await body(req, res); if (!b) return;
    const f = flowFor(ctx.key, b.flow);
    if (!f) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, await confirmMcpAuth(f));
  });

  router.on('POST', '/api/mcp-oauth/cancel', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const b = await body(req, res); if (!b) return;
    const f = flowFor(ctx.key, b.flow);
    json(res, 200, cancelMcpAuth(f) || { status: 'cancelled' });
  });

  router.on('GET', '/api/mcp-oauth/status', async (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const f = flowFor(ctx.key, url.searchParams.get('flow'));
    if (!f) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, flowView(f));
  });

  // 扩展页「连接器」的状态与工具清单：GET /api/mcp-oauth/connectors[?refresh=1] → { statuses: { [id]: { status, tools[], ... } } }
  router.on('GET', '/api/mcp-oauth/connectors', async (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.kind !== 'admin') { json(res, 403, { error: '扩展管理仅对管理员开放' }); return; }
    try {
      const list = remoteConnectorsForProbe();
      const statuses = await annotateApps({ ...(await probeConnectors(ctx, list, { force: url.searchParams.get('refresh') === '1' })) }, list);
      json(res, 200, { statuses });
    } catch (e) { json(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 断开连接：删掉这个身份存的令牌，活着的会话 CLI 重连（随即变回「需要登录」）
  router.on('POST', '/api/mcp-oauth/disconnect', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.kind !== 'admin') { json(res, 403, { error: '扩展管理仅对管理员开放' }); return; }
    const b = await body(req, res); if (!b) return;
    const c = connectorForAuth(b.connector);
    if (!c) { json(res, 404, { error: '连接器不存在' }); return; }
    let n;
    try { n = clearMcpTokens(ctx, c.server); }
    catch (e) { json(res, 500, { error: '清除登录信息失败：' + String((e && e.message) || e) }); return; }
    forgetConnectorStatus(ctx.key, c.item.id);
    reconnectLive(ctx.key, c.server).catch(() => {});
    let statuses = {};
    try { statuses = await probeConnectors(ctx, remoteConnectorsForProbe().filter((x) => x.id === c.item.id), { force: true }); } catch {}
    json(res, 200, { cleared: n, status: statuses[c.item.id] || { status: 'unknown' } });
  });

  // 自备 OAuth 应用：配置面板要的全部数据（密钥只说有没有）
  router.on('GET', '/api/mcp-oauth/app', async (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.kind !== 'admin') { json(res, 403, { error: '扩展管理仅对管理员开放' }); return; }
    const c = connectorForAuth(url.searchParams.get('connector'));
    if (!c) { json(res, 404, { error: '连接器不存在' }); return; }
    if (c.config.type === 'stdio') { json(res, 400, { error: '本地连接器不需要授权' }); return; }
    let d;
    try { d = await discoverAuth(c.config.url, { force: url.searchParams.get('refresh') === '1' }); }
    catch (e) { json(res, 502, { error: String((e && e.message) || e) }); return; }
    if (!d.oauth) { json(res, 200, { needed: false, oauth: false }); return; }
    let app = null;
    try { app = getApp(d.issuer); } catch (e) { json(res, 500, { error: 'OAuth 应用配置解不开：' + String((e && e.message) || e) }); return; }
    // 同一个授权服务器的其它连接器共用这个应用（Gmail、Drive……配一次都能用）
    const peers = await Promise.all(remoteConnectorsForProbe().filter((x) => x.id !== c.item.id).map(async (x) => {
      try { const o = await discoverAuth(x.config.url); return o.oauth && o.issuer === d.issuer ? x.server : ''; } catch { return ''; }
    }));
    const origin = publicOriginOf(req);
    json(res, 200, {
      needed: !d.dcr, oauth: true, issuer: d.issuer, provider: d.provider, providerName: PROVIDERS[d.provider]?.name || new URL(d.issuer).hostname,
      scopes: d.scopes, app: publicApp(app), suggestedRedirectUri: origin ? origin + CALLBACK_PATH : '', shared: peers.filter(Boolean),
    });
  });

  router.on('POST', '/api/mcp-oauth/app', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.kind !== 'admin') { json(res, 403, { error: '扩展管理仅对管理员开放' }); return; }
    const b = await body(req, res); if (!b) return;
    const c = connectorForAuth(b.connector);
    if (!c || c.config.type === 'stdio') { json(res, 404, { error: '连接器不存在' }); return; }
    let d;
    try { d = await discoverAuth(c.config.url); } catch (e) { json(res, 502, { error: String((e && e.message) || e) }); return; }
    if (!d.oauth) { json(res, 400, { error: '这个连接器不用 OAuth 登录' }); return; }
    try {
      const app = saveApp(d.issuer, { clientId: b.clientId, clientSecret: b.clientSecret, redirectUri: b.redirectUri });
      forgetConnectorStatus(ctx.key);
      json(res, 200, { app: publicApp(app) });
    } catch (e) { json(res, e.status || 500, { error: String((e && e.message) || e) }); }
  });

  router.on('POST', '/api/mcp-oauth/app/remove', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.kind !== 'admin') { json(res, 403, { error: '扩展管理仅对管理员开放' }); return; }
    const b = await body(req, res); if (!b) return;
    const c = connectorForAuth(b.connector);
    if (!c || c.config.type === 'stdio') { json(res, 404, { error: '连接器不存在' }); return; }
    try {
      const d = await discoverAuth(c.config.url);
      if (d.oauth) removeApp(d.issuer);
      forgetConnectorStatus(ctx.key);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 授权服务器把浏览器跳回来：不看登录态（系统浏览器里没有），只认进行中流程的 state，一次性
  router.on('GET', CALLBACK_PATH, async (req, res, url) => {
    const lang = /^zh/i.test(String(req.headers['accept-language'] || 'zh')) ? 'zh' : 'en';
    const zh = lang === 'zh';
    const f = flowByState(url.searchParams.get('state'));
    if (!f) { page(res, 410, false, zh ? '这个授权链接已失效或已经用过。' : 'This sign-in link has expired or was already used.', zh ? '回到 bridge 重新点「授权」。' : 'Go back to bridge and click Authorize again.', lang); return; }
    // 用户在授权页点了拒绝：交给 CLI 让它把这次流程收掉，页面如实说
    const denied = url.searchParams.get('error');
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const r = await submitMcpCallback(f, (f.redirectUri || 'http://localhost' + CALLBACK_PATH) + qs);   // 原样交回（基址 = 当初登记的回调地址）
    if (denied) { page(res, 200, false, zh ? '你在授权页拒绝了授权。' : 'Authorization was declined.', String(url.searchParams.get('error_description') || denied).slice(0, 200), lang); return; }
    // 平台拦了令牌端点（Muse）：重试没用，别让人回去再点
    if (!r.ok && r.error === EGRESS_BLOCKED_MSG) { page(res, 200, false, zh ? r.error : 'The platform this server runs on (Muse) does not allow signing in to this service here: its egress proxy blocks the token request (refresh_rejected), so retrying will not help. Use the built-in connector under Muse Settings › Connectors, or an API-key custom connector in Muse.', '', lang); return; }
    if (!r.ok) { page(res, 200, false, r.error, zh ? '回到 bridge 重新点「授权」。' : 'Go back to bridge and click Authorize again.', lang); return; }
    page(res, 200, true, zh ? `${f.server} 已连接，回到 bridge 就能用了。` : `${f.server} is connected. Head back to bridge.`, zh ? '可以关掉这一页了。' : 'You can close this page.', lang);
  });
}
