// 远程连接器的 OAuth 授权接口（流程本体见 runtime/mcp-oauth.mjs）：
//   POST /api/mcp-oauth/start    { session, server }        → 流程（authUrl / scheme / 状态）
//   POST /api/mcp-oauth/submit   { flow, url }              → localhost 那条路：用户粘回来的完整回调地址
//   POST /api/mcp-oauth/confirm  { flow }                   → 「我已完成」：重连一次看连上没有
//   POST /api/mcp-oauth/cancel   { flow }
//   GET  /api/mcp-oauth/status?flow=                        → 前端轮询
//   GET  /api/mcp-oauth/callback?code=&state=               → 授权服务器跳回来（不要求登录，只认进行中流程的 state）
// 结局（成功 / 失败 / 过期）经总线 {type:'mcp_auth'} 推给这个身份的各设备；成功时附带 {type:'mcp'} 连接器新状态。
import * as claudeProjects from '../claude-projects.mjs';
import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { noteSessionMcp, sessionMcp } from '../runtime/session-mcp.mjs';
import { PUBLIC_ORIGIN } from '../config/index.mjs';
import { startMcpAuth, submitMcpCallback, confirmMcpAuth, cancelMcpAuth, flowByState, flowFor, flowView } from '../runtime/mcp-oauth.mjs';
import { spawnAuthQuery } from '../runtime/mcp-oauth-query.mjs';

export const CALLBACK_PATH = '/api/mcp-oauth/callback';
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
function settled(key) {
  return (v) => {
    if (v.status === 'done' && Array.isArray(v.servers)) {
      // 只改刚授权的这一个：临时进程的清单里没有会话自己的进程内工具（媒体、浏览器……），不能拿它整份替换
      const prev = (sessionMcp(key, v.sessionId) || {}).servers || [];
      const got = v.servers.find((s) => s && s.name === v.server);
      const list = prev.length ? prev.map((s) => (got && s.name === v.server ? { ...s, status: got.status } : s)) : v.servers;
      const servers = noteSessionMcp(key, v.sessionId, list);
      busPublish(key, { type: 'mcp', sessionId: v.sessionId, servers });
    }
    const { authUrl, servers, ...slim } = v;   // 授权链接不在总线上广播
    busPublish(key, { type: 'mcp_auth', ...slim });
  };
}

function page(res, code, ok, text, sub, lang) {
  const zh = lang !== 'en';
  const title = ok ? (zh ? '授权成功' : 'Connected') : (zh ? '授权没有完成' : 'Authorization failed');
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Frame-Options': 'DENY',
  });
  res.end(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#faf9f5;color:#141413}
@media (prefers-color-scheme:dark){body{background:#262624;color:#faf9f5}p{color:#b0aea5!important}}
main{max-width:360px;padding:32px 24px;text-align:center}.mk{width:44px;height:44px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;font-size:22px;color:#fff;background:${ok ? '#5a8f5a' : '#c0583e'}}
h1{font-size:19px;font-weight:600;margin:0 0 8px}p{margin:0;color:#5e5d59}</style></head>
<body><main><div class="mk">${ok ? '&#10003;' : '!'}</div><h1>${esc(title)}</h1><p>${esc(text)}</p>${sub ? `<p style="margin-top:8px;font-size:13px">${esc(sub)}</p>` : ''}</main></body></html>`);
}

export function registerMcpOAuthRoutes(router, { identify }) {
  router.on('POST', '/api/mcp-oauth/start', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    if (ctx.snap) { json(res, 403, { error: 'forbidden' }); return; }
    const b = await body(req, res); if (!b) return;
    const sid = String(b.session || ''), server = String(b.server || '');
    if (!/^[0-9a-fA-F-]{8,80}$/.test(sid) || !server || server.length > 200) { json(res, 400, { error: 'bad request' }); return; }
    // 会话必须是这个身份的（定位得到即所有权证明）；短命进程用它所在的项目目录当 cwd（项目级 .mcp.json 才读得到）
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid);
    if (!p) { json(res, 404, { error: 'not found' }); return; }
    const cwd = (p.project && p.project.path) || ctx.cwd;
    const origin = publicOriginOf(req);
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
    if (!r.ok) { page(res, 200, false, r.error, zh ? '回到 bridge 重新点「授权」。' : 'Go back to bridge and click Authorize again.', lang); return; }
    page(res, 200, true, zh ? `${f.server} 已连接，可以关掉这页了。` : `${f.server} is connected. You can close this page.`, '', lang);
  });
}
