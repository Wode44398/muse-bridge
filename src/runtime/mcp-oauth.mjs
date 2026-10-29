// 远程连接器（HTTP / SSE MCP）的 OAuth 授权——会话信息面板「连接器」卡的「授权」按钮背后这一套。
//
// SDK 会话是非交互模式，CLI 不给模型 authenticate 桩工具，所以 needs-auth 的连接器模型自己授权不了。
// 宿主可以经控制通道发起：q.mcpAuthenticate(名字, 回调地址) 回 { authUrl, requiresUserAction, callbackExpected,
// redirectScheme:'custom'|'localhost', state, callbackPort? }；用户授权完，把带 code 的完整回调地址经
// q.mcpSubmitOAuthCallbackUrl 交回，CLI 换令牌、存进这个身份的 CLAUDE_CONFIG_DIR（之后的新会话都能直接用）。
// 回调地址交回后 CLI 不自己重连，由宿主 reconnectMcpServer。
//
// 三条路：
//   custom    — 授权服务器接受 bridge 的回调地址：浏览器跳回 /api/mcp-oauth/callback，按 state 找到流程交回。
//   localhost — 授权服务器只认 localhost：CLI 自动退回 localhost:<port>/callback。和 bridge 同一台电脑上的浏览器
//               会直接打到 CLI 自己的监听上（这里轮询状态发现已连上）；别的设备打不开，用户把地址栏整串粘回来。
//   不需要回调（claude.ai 代理类连接器）— 用户在网页上授权完就行，这里轮询状态，或用户点「我已完成」重连一次。
//
// 安全：回调路由不要求登录（手机 app 跳出去的系统浏览器没有 bridge 登录态），只认正在进行的流程的 state——
// 不可猜（CLI 生成的随机串）、一次性、10 分钟过期。
//
// 需要一个活着的 Query 才能发控制请求：会话的 CLI 正在跑或停放着就用它的（claude.mjs 在 init 帧登记），
// 否则由调用方传 spawn() 按会话身份起一个短命的，流程结束（成功 / 失败 / 过期）一律收掉。
import { randomBytes } from 'node:crypto';

export const FLOW_TTL_MS = 10 * 60_000;
const CALL_MS = 90_000;      // 单个控制请求的上限（动态注册 + 取授权地址要走网络）
const POLL_MS = 4_000;       // localhost / 不需要回调两条路：看连接器是不是已经连上

const live = new Map();      // `${key}|${sid}` → Query（会话正在跑或停放着的 CLI）
const flows = new Map();     // flowId → flow
const byState = new Map();   // CLI 的 state → flowId（回调路由按它找）

// claude.mjs：init 帧拿到会话 id 时登记，进程收掉时撤（返回撤销函数）。
export function noteLiveQuery(key, sid, q) {
  if (!key || !sid || !q) return () => {};
  const k = key + '|' + sid;
  live.set(k, q);
  return () => { if (live.get(k) === q) live.delete(k); };
}
export function liveQueryFor(key, sid) {
  return (key && sid && live.get(key + '|' + sid)) || null;
}

const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(what + ' 超时'), { code: 'timeout' })), ms);
  if (t.unref) t.unref();
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

const errText = (e) => String((e && e.message) || e || '授权失败').slice(0, 400);

// 回调地址形状检查（交给 CLI 之前先挡掉明显不对的，免得把一次性的流程白白耗掉）。
export function checkCallbackUrl(raw, state) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, error: '不是完整的网址' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '不是完整的网址' };
  if (!u.searchParams.has('code') && !u.searchParams.has('error')) return { ok: false, error: '地址里没有授权码（code），请粘贴授权后地址栏里的完整地址' };
  if (state && u.searchParams.get('state') !== state) return { ok: false, error: '这个地址属于另一次授权，请用本次打开的授权页跳回来的地址' };
  return { ok: true, url: u.href };
}

function view(f) {
  return {
    id: f.id, server: f.server, sessionId: f.sid, status: f.status,
    scheme: f.scheme, authUrl: f.authUrl || '', callbackExpected: f.callbackExpected,
    ...(f.callbackPort ? { callbackPort: f.callbackPort } : {}),
    ...(f.error ? { error: f.error } : {}),
    ...(f.servers ? { servers: f.servers } : {}),
    expiresAt: f.expiresAt,
  };
}

function finish(f, status, extra = {}) {
  if (f.ended) return;
  f.ended = true;
  f.status = status;
  Object.assign(f, extra);
  clearTimeout(f.timer); clearInterval(f.poller);
  if (f.state && byState.get(f.state) === f.id) byState.delete(f.state);
  // 结局再留 2 分钟给前端轮询取；之后整条忘掉
  const t = setTimeout(() => { if (flows.get(f.id) === f) flows.delete(f.id); }, 120_000);
  if (t.unref) t.unref();
  if (f.release) { try { f.release(); } catch {} f.release = null; }
  try { f.onSettled && f.onSettled(view(f)); } catch {}
}

// 授权完：重连这个服务器、读一份最新状态（会话面板的「连接器」卡据此刷新）。
async function settleOk(f) {
  const q = f.q;
  try { await withTimeout(q.reconnectMcpServer(f.server), CALL_MS, '重连'); } catch {}
  let servers = null;
  try { servers = await withTimeout(q.mcpServerStatus(), 15_000, '读取状态'); } catch {}
  await finishOk(f, servers);
}
// 用的是临时起的进程：会话自己的 CLI 若此刻活着，也让它重连一下（它的 needs-auth 是自己内存里的）
async function finishOk(f, servers) {
  if (f.ended) return;
  if (f.owned) {
    const lq = liveQueryFor(f.key, f.sid);
    if (lq && lq !== f.q) { try { await withTimeout(lq.reconnectMcpServer(f.server), CALL_MS, '重连'); } catch {} }
  }
  finish(f, 'done', { servers: Array.isArray(servers) ? servers : null });
}

function serverState(list, name) {
  const s = Array.isArray(list) ? list.find((x) => x && x.name === name) : null;
  return s ? s.status : '';
}

/**
 * 开始授权。
 * @param o { key, sid, server, redirectUri, spawn?: () => Promise<{ q, release }>, onSettled?(view), ttlMs? }
 * @returns view（status: 'waiting' | 'done'）
 */
export async function startMcpAuth(o) {
  const { key, sid, server } = o;
  if (!key || !sid || !server) throw Object.assign(new Error('缺少参数'), { status: 400 });
  // 同一身份同一个连接器只留一个进行中的流程（CLI 那边新的也会顶掉旧的）
  for (const f of flows.values()) if (!f.ended && f.key === key && f.server === server) finish(f, 'cancelled');
  let q = liveQueryFor(key, sid), release = null, owned = false;
  if (!q) {
    if (!o.spawn) throw Object.assign(new Error('会话没有在运行'), { status: 409 });
    const s = await o.spawn();
    q = s.q; release = s.release; owned = true;
  }
  const ttl = o.ttlMs || FLOW_TTL_MS;
  const f = {
    id: randomBytes(12).toString('hex'), key, sid, server, q, owned, release, redirectUri: o.redirectUri || '',
    status: 'starting', scheme: '', authUrl: '', callbackExpected: false, state: '',
    createdAt: Date.now(), expiresAt: Date.now() + ttl, onSettled: o.onSettled, ended: false,
  };
  flows.set(f.id, f);
  f.timer = setTimeout(() => finish(f, 'expired', { error: '授权超时，请重新点「授权」' }), ttl);
  if (f.timer.unref) f.timer.unref();
  let r;
  try {
    if (owned && typeof q.initializationResult === 'function') await withTimeout(q.initializationResult(), CALL_MS, '启动');
    r = await withTimeout(q.mcpAuthenticate(server, o.redirectUri || undefined), CALL_MS, '发起授权');
  } catch (e) {
    finish(f, 'error', { error: errText(e) });
    return view(f);
  }
  r = r || {};
  if (!r.requiresUserAction) {   // 已有可用令牌：直接重连
    await settleOk(f);
    return view(f);
  }
  f.authUrl = String(r.authUrl || '');
  f.callbackExpected = !!r.callbackExpected;
  f.scheme = f.callbackExpected ? (r.redirectScheme === 'custom' ? 'custom' : 'localhost') : 'web';
  if (r.callbackPort) f.callbackPort = r.callbackPort;
  if (f.callbackExpected) {
    f.state = String(r.state || '');
    // state 太短就不登记回调路由（不可猜是这条路由唯一的门）；粘贴那条路照样能走
    if (f.state.length >= 16) byState.set(f.state, f.id);
  }
  f.status = 'waiting';
  // localhost（同机浏览器直接打到 CLI 的监听）/ 不需要回调：看连接器自己连上没有
  if (f.scheme !== 'custom') {
    f.poller = setInterval(async () => {
      if (f.ended || f.submitting || f.polling) return;
      f.polling = true;
      try {
        const list = await withTimeout(q.mcpServerStatus(), 10_000, '读取状态');
        if (!f.ended && !f.submitting && serverState(list, server) === 'connected') await finishOk(f, list);
      } catch {} finally { f.polling = false; }
    }, o.pollMs || POLL_MS);
    if (f.poller.unref) f.poller.unref();
  }
  return view(f);
}

/** 交回回调地址（回调路由按 state 找到的，或用户粘贴的）。一次性：交过就不能再交。 */
export async function submitMcpCallback(f, rawUrl) {
  if (!f || f.ended) return { ok: false, error: '这次授权已经结束或过期，请重新点「授权」', status: 410 };
  if (!f.callbackExpected) return { ok: false, error: '这个连接器不需要回调地址', status: 400 };
  if (f.submitting) return { ok: false, error: '正在完成授权，请稍候', status: 409 };
  const c = checkCallbackUrl(rawUrl, f.state);
  if (!c.ok) return { ok: false, error: c.error, status: 400 };
  f.submitting = true;
  if (f.state && byState.get(f.state) === f.id) byState.delete(f.state);
  try {
    await withTimeout(f.q.mcpSubmitOAuthCallbackUrl(f.server, c.url), CALL_MS, '提交授权');
  } catch (e) {
    finish(f, 'error', { error: errText(e) });
    return { ok: false, error: f.error, status: 502 };
  }
  await settleOk(f);
  return { ok: true, flow: view(f) };
}

/** 回调路由：只认进行中的流程的 state（不看登录态）。 */
export function flowByState(state) {
  const s = String(state || '');
  if (s.length < 16) return null;
  const id = byState.get(s);
  const f = id ? flows.get(id) : null;
  return f && !f.ended ? f : null;
}
export function flowFor(key, id) {
  const f = flows.get(String(id || ''));
  return f && f.key === key ? f : null;
}
export const flowView = (f) => (f ? view(f) : null);

/** 「我已完成」（不需要回调的那条路）/ 也给 localhost 路兜底：重连一次看连上没有。 */
export async function confirmMcpAuth(f) {
  if (!f || f.ended) return f ? view(f) : null;
  let list = null;
  try { await withTimeout(f.q.reconnectMcpServer(f.server), CALL_MS, '重连'); } catch {}
  try { list = await withTimeout(f.q.mcpServerStatus(), 15_000, '读取状态'); } catch {}
  if (serverState(list, f.server) === 'connected') await finishOk(f, list);
  return view(f);
}

export function cancelMcpAuth(f) { if (f && !f.ended) finish(f, 'cancelled'); return f ? view(f) : null; }

// 测试用
export function _resetMcpOAuth() {
  for (const f of flows.values()) { clearTimeout(f.timer); clearInterval(f.poller); }
  flows.clear(); byState.clear(); live.clear();
}
