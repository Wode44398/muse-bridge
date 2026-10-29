// 远程连接器授权（服务端 src/runtime/mcp-oauth.mjs + routes/mcp-oauth.mjs）的前端状态。
// 会话信息面板「连接器」卡的「授权」按钮与输入框上方的提示条共用这一份：按「会话|连接器」记一个流程。
//   scheme：custom = 授权完浏览器跳回 bridge 自己完成；localhost = 授权服务器只认 localhost，别的设备上跳回去
//   打不开，要把地址栏整串粘回来；web = 不需要回调（claude.ai 代理类），授权完点「我已完成」。
// 结局走总线 {type:'mcp_auth'}（多设备同步）+ 这里自己轮询兜底；成功时总线另推 {type:'mcp'} 连接器新状态。
import { api } from './api.js';
import { busOn } from './bus.js';
import { mcpState } from './chat.svelte.js';
import { isNativeDesktop, desktopOpenExternal } from './nativeDesktop.js';
import { t } from './i18n.js';

export const mcpAuth = $state({ flows: {} });   // `${sid}|${server}` → { id, status, scheme, authUrl, error, busy }
const fk = (sid, server) => sid + '|' + server;
const timers = new Map();

export const authFlow = (sid, server) => mcpAuth.flows[fk(sid, server)] || null;

function put(sid, server, patch) {
  const k = fk(sid, server);
  mcpAuth.flows = { ...mcpAuth.flows, [k]: { ...(mcpAuth.flows[k] || {}), ...patch } };
}
export function dropAuthFlow(sid, server) {
  const k = fk(sid, server);
  clearInterval(timers.get(k)); timers.delete(k);
  const { [k]: _, ...rest } = mcpAuth.flows;
  mcpAuth.flows = rest;
}

const errOf = (e, fb) => (e && e.body && typeof e.body === 'object' && e.body.error) || (typeof e?.body === 'string' && e.body) || fb;

export function openAuthPage(url) {
  if (!url) return;
  if (isNativeDesktop()) { desktopOpenExternal(url); return; }
  window.open(url, '_blank', 'noopener');
}

function absorb(sid, server, v) {
  if (!v) return;
  // 还在等的时候轮询回来的状态不带错误：别把刚才粘贴失败的提示冲掉
  const keep = v.status === 'waiting' && authFlow(sid, server)?.status === 'waiting' ? authFlow(sid, server).error || '' : '';
  put(sid, server, { id: v.id, status: v.status, scheme: v.scheme || '', ...(v.authUrl ? { authUrl: v.authUrl } : {}), error: v.error || keep, busy: false });
  // 只改刚授权的这一个（临时进程的清单不全，见服务端 routes/mcp-oauth.mjs）；总线随后还会推一份服务端合并好的
  if (v.status === 'done') {
    const prev = mcpState.bySession[sid]?.servers || [];
    const got = Array.isArray(v.servers) ? v.servers.find((s) => s && s.name === server) : null;
    const status = got ? got.status : 'connected';
    mcpState.bySession[sid] = { servers: prev.some((s) => s.name === server) ? prev.map((s) => (s.name === server ? { ...s, status } : s)) : [...prev, { name: server, status }], at: Date.now() };
  }
  if (v.status !== 'waiting') { clearInterval(timers.get(fk(sid, server))); timers.delete(fk(sid, server)); }
  // 成功的那一条过几秒自己消失（连接器状态已经刷成「已连接」）
  if (v.status === 'done' || v.status === 'cancelled') setTimeout(() => { if (authFlow(sid, server)?.id === v.id) dropAuthFlow(sid, server); }, v.status === 'done' ? 4000 : 0);
}

function poll(sid, server, id) {
  const k = fk(sid, server);
  clearInterval(timers.get(k));
  timers.set(k, setInterval(async () => {
    if (authFlow(sid, server)?.id !== id) { clearInterval(timers.get(k)); timers.delete(k); return; }
    try { absorb(sid, server, await api.get(`/api/mcp-oauth/status?flow=${encodeURIComponent(id)}`)); }
    catch (e) { if (e?.status === 404) absorb(sid, server, { id, status: 'expired', error: t('授权已过期，请重新授权') }); }
  }, 3000));
}

export async function startAuth(sid, server) {
  if (!sid || !server || authFlow(sid, server)?.busy) return;
  put(sid, server, { status: 'starting', error: '', busy: true, authUrl: '', scheme: '' });
  let v;
  try { v = await api.post('/api/mcp-oauth/start', { session: sid, server }); }
  catch (e) { put(sid, server, { status: 'error', error: errOf(e, t('无法开始授权')), busy: false }); return; }
  absorb(sid, server, v);
  if (v.status === 'waiting') {
    openAuthPage(v.authUrl);   // 弹窗被拦也没关系：卡片里留着「打开授权页」链接
    poll(sid, server, v.id);
  }
}

export async function submitAuthUrl(sid, server, url) {
  const f = authFlow(sid, server);
  if (!f || !f.id || f.busy) return;
  put(sid, server, { busy: true, error: '' });
  try { absorb(sid, server, await api.post('/api/mcp-oauth/submit', { flow: f.id, url: String(url || '').trim() })); }
  catch (e) {
    const fl = e?.body && typeof e.body === 'object' ? e.body.flow : null;
    put(sid, server, { busy: false, error: errOf(e, t('授权失败')), ...(fl ? { status: fl.status } : {}) });
  }
}

export async function confirmAuth(sid, server) {
  const f = authFlow(sid, server);
  if (!f || !f.id || f.busy) return;
  put(sid, server, { busy: true, error: '' });
  try {
    const v = await api.post('/api/mcp-oauth/confirm', { flow: f.id });
    absorb(sid, server, v);
    if (v && v.status === 'waiting') put(sid, server, { error: t('还没连上。请在授权页完成授权后再试。') });
  } catch (e) { put(sid, server, { busy: false, error: errOf(e, t('授权失败')) }); }
}

export async function cancelAuth(sid, server) {
  const f = authFlow(sid, server);
  dropAuthFlow(sid, server);
  if (f && f.id && f.status === 'waiting') { try { await api.post('/api/mcp-oauth/cancel', { flow: f.id }); } catch {} }
}

busOn((ev) => {
  if (!ev) return;
  if (ev.type === 'mcp' && ev.sessionId) mcpState.bySession[ev.sessionId] = { servers: Array.isArray(ev.servers) ? ev.servers : [], at: Date.now() };
  else if (ev.type === 'mcp_auth' && ev.sessionId && ev.server) {
    const f = authFlow(ev.sessionId, ev.server);
    if (f && f.id === ev.id) absorb(ev.sessionId, ev.server, ev);
  }
});
