// 扫码配对（开源路线 S1-2）的前端：电脑出码，手机扫一下换到自己的长期会话，不用手抄地址和 32 位令牌。
// 服务端见 src/routes/pair.mjs 后半与 src/runtime/pair-connect.mjs。和「扫码登录」（lib/pair.js：网页出码、已登录的手机替它确认）
// 方向相反，两种码共用同一个扫码层（PairScan.svelte）。
//
//   出示方（设置「连接与更新」、控制台、桌面客户端完成页走服务端回的同一份数据）：
//     startConnectPresenter(onUpdate) 领票 → 出码 → 长轮询，过期自动换一张（最多 maxRounds 张，免得页面开一夜一直领票）。
//   兑换方 · 手机 App（离线壳）：parseConnectPayload(扫到的文字) → redeemConnect(p) 依次试码里的地址（先 /api/app/hello 认服务器 id）
//     → applyConnect(结果)：存服务器地址、会话令牌、地址簿（局域网候选 / 公钥 / 公网地址），然后整页重载。
//     手输：normalizeServerAddress(地址) + redeemCode(地址, 8 位码)；填访问令牌 → loginWithToken 换一张管理员会话，主令牌不落本地。
//   兑换方 · 手机浏览器（系统相机扫码打开 ?connect=）：本模块加载时接住参数、立刻从地址栏擦掉，交给扫码层的确认卡
//     （ui.pairScan = { mode:'landing' }）——用户点了「连接」才兑换，不静默换登录：链接可能是别人转发来的（登录 CSRF），
//     已登录时还会替换现在的登录。App.svelte 引了 lib/pair.js，pair.js 引了本模块——不用改 App 的启动流程。

import { api, getToken, setToken } from './api.js';
import { getServerBase, setServerBase, adoptServerAddress, isOffline } from './server.js';
import { storeSet } from './store.js';
import { ui } from './state.svelte.js';
import { t, tr } from './i18n.js';
import { cleanOrigin, hostOf, isPrivateHost, parseConnectPayload } from './connectPayload.js';

// 纯函数（解析二维码、规范化手填地址）在 ./connectPayload.js（单测直接跑），这里转出去给组件用
export { isPrivateHost, normalizeServerAddress, parseConnectPayload, looksLikeCode, looksLikeDigits } from './connectPayload.js';

const LAN_KEY = 'bridge-server-lan';   // 与 lib/server.js 的局域网候选同一个键（重载后由它接手探活）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// msg = 服务端回的原话（可能没有）：界面优先用它，没有就用按 code 写好的说法（别把 code 本身显示出来）
function codedError(code, msg) { const e = new Error(msg || code); e.code = code; e.msg = msg || ''; return e; }

// 带超时的 fetch → { status, data } | { net:true }
async function fetchJson(url, { method = 'GET', body, headers = {}, ms = 8000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      method, cache: 'no-store', signal: ctl.signal, credentials: 'same-origin',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, data };
  } catch { return { net: true }; }
  finally { clearTimeout(timer); }
}

const client = () => (isOffline() ? 'app' : 'web');

/**
 * 手机 App 扫到配对码之后：依次试码里的地址（码里的主地址 → 局域网候选），先认服务器 id（有 sid 时），再兑换。
 * 成功回 { origin, res }；失败抛带 code 的错：'unreachable' | 'mismatch' | 'expired' | 'rate' | 'bad'。
 * replace：网页上已登录、用户在确认卡上同意了替换——服务端兑换成功后顺手退出这个浏览器原来的登录（cookie 带过去的那张）。
 */
export async function redeemConnect(p, { onStep, replace = false } = {}) {
  const cands = [...new Set([p.origin, ...(p.lan || [])].map(cleanOrigin).filter(Boolean))];
  let mismatch = false;
  for (const o of cands) {
    onStep?.(o);
    if (p.sid) {
      const h = await fetchJson(o + '/api/app/hello', { ms: 3500 });
      if (h.net || !h.ok) continue;
      if (h.data?.id !== p.sid) { mismatch = true; continue; }   // 同一个地址上换成了别的 bridge：不把票送过去
    }
    const r = await fetchJson(o + '/api/pair/redeem', { method: 'POST', body: { id: p.id, secret: p.secret, client: client(), ...(replace ? { replace: true } : {}) }, ms: 10000 });
    if (r.net) continue;
    if (r.ok && r.data?.token) return { origin: o, res: r.data };
    throw codedError(r.status === 429 ? 'rate' : r.status === 410 || r.status === 404 ? 'expired' : 'bad', r.data?.error);
  }
  throw codedError(mismatch ? 'mismatch' : 'unreachable');
}

/** 手输：地址 + 8 位配对码。 */
export async function redeemCode(origin, code) {
  const o = cleanOrigin(origin);
  if (!o) throw codedError('address');
  const r = await fetchJson(o + '/api/pair/redeem', { method: 'POST', body: { code: String(code || ''), client: client() }, ms: 10000 });
  if (r.net) throw codedError('unreachable');
  if (r.ok && r.data?.token) return { origin: o, res: r.data };
  throw codedError(r.status === 429 ? 'rate' : r.status === 404 || r.status === 410 ? 'expired' : 'bad', r.data?.error);
}

/** 手输访问令牌：拿它当 Bearer 调 /api/login 换一张管理员会话（可吊销），本地只存会话，不存主令牌。 */
export async function loginWithToken(origin, token) {
  const o = cleanOrigin(origin);
  if (!o) throw codedError('address');
  const r = await fetchJson(o + '/api/login', { method: 'POST', body: {}, headers: { Authorization: 'Bearer ' + String(token || '').trim() }, ms: 10000 });
  if (r.net) throw codedError('unreachable');
  // 令牌不对时服务端落到账号密码分支、回「用户名或密码错误」——和这一栏毫不相干，不转述，统一说「访问令牌不对」
  if (!r.ok || !r.data?.token) throw r.status === 429 ? codedError('rate', r.data?.error) : codedError('token');
  const info = await fetchJson(o + '/api/app/server-info', { headers: { Authorization: 'Bearer ' + r.data.token }, ms: 6000 });
  return { origin: o, res: { kind: r.data.kind, user: r.data.user || null, token: r.data.token, publicOrigin: info.data?.publicOrigin || '', address: info.data?.address || null } };
}

/** 只认地址（不登录）：服务器在不在。回 'ok' | 'unreachable' | 'http-<状态>'。 */
export async function probeServer(origin) {
  const o = cleanOrigin(origin);
  if (!o) return 'unreachable';
  const r = await fetchJson(o + '/api/auth', { ms: 6000 });
  if (r.net) return 'unreachable';
  return r.ok || r.status === 401 ? 'ok' : 'http-' + r.status;
}

/**
 * 兑换成功后落地（手机 App 离线壳）：服务器地址优先存公网地址（出门也能连；在家时局域网自动直连接手），
 * 经局域网兑换的就把那个局域网地址记成直连候选；会话令牌当 Bearer；地址簿交给 lib/server.js。调用方随后整页重载。
 */
export function applyConnect({ origin, res }) {
  logoutPrevious();
  const pub = cleanOrigin(res?.publicOrigin);
  const base = pub || cleanOrigin(origin);
  setServerBase(base);           // 换了服务器 → 旧地址簿作废（setServerBase 里做）
  setToken(res.token);
  if (res.address) adoptServerAddress(res.address);
  if (base !== origin && isPrivateHost(hostOf(origin))) storeSet(LAN_KEY, origin);
  return base;
}

// App 换到新会话之前，把这台手机原来那张会话在原服务器上退出（尽力而为、不等结果）：确认卡上说了「现在的登录会被替换」，
// 别在库里留一张没人拿着的有效会话。原来存的若是主令牌（老首屏「管理员令牌（可选）」），服务端认得是主令牌、什么也不吊销。
function logoutPrevious() {
  try {
    const base = getServerBase(), tok = getToken();
    if (!base || !tok) return;
    // keepalive：调用方紧接着整页重载，请求不能跟着页面一起被掐掉
    fetch(base + '/api/logout', { method: 'POST', keepalive: true, cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' }).catch(() => {});
  } catch {}
}

/** 给人看的失败原因。 */
export function connectErrorText(e) {
  switch (e?.code) {
    case 'unreachable': return t('连不上二维码里的地址：手机和电脑在同一个 Wi-Fi 吗？电脑上的 bridge 开着吗？');
    case 'mismatch': return t('这个地址上的不是出码的那台服务器（局域网里可能有别的 bridge），没有把配对码发过去');
    case 'expired': return tr(e.msg) || t('配对码已过期或已用过，请在电脑上刷新后重试');
    case 'rate': return tr(e.msg) || t('尝试次数过多，请稍后再试');
    case 'address': return t('请填入电脑上 bridge 的地址');
    case 'token': return t('访问令牌不对。要填配对码的话，配对码是电脑上二维码旁边的 8 位数字');
    case 'digits': return t('配对码是 8 位数字，请对照电脑上显示的配对码重新输入');
    default: return tr(e?.code ? e.msg : e?.message) || t('连接失败，请重试');
  }
}

// —— 出示方 ——————————————————————————————————————————————————————————————————

// 码里放哪个地址由服务端定（公网 > 出示方页面 > 局域网）；这里只报出示方页面自己的地址
function pageOrigin() {
  try { return getServerBase() || location.origin; } catch { return ''; }
}

/**
 * 出示方状态机。onUpdate({ status, ticket?, info?, error? })
 *   status: 'loading' | 'pending'（ticket：{ svg, code, codeText, url, origin, reachable, expiresAt, … }）
 *         | 'redeemed'（info：{ device, ip, at, kind, revocable }）| 'revoked' | 'expired'（自动换够了次数）| 'cancelled' | 'error'
 * 返回 { refresh(), stop(), revoke() }。stop 时作废还没用的票（关掉页面、切走都调）。
 */
export function startConnectPresenter(onUpdate, { maxRounds = 6, via = '' } = {}) {
  let stopped = false, gen = 0, current = null, curStatus = '';
  const emit = (u) => { if (!stopped) { curStatus = u.status; onUpdate(u); } };
  const cancelQuiet = (id) => { api.post('/api/pair/connect/cancel', { id }).catch(() => {}); };
  async function run(round) {
    const my = ++gen;
    const dead = () => stopped || my !== gen;
    emit({ status: 'loading' });
    let tk;
    try { tk = await api.post('/api/pair/connect', { origin: pageOrigin(), via }); }
    catch (e) {
      if (dead()) return;
      emit({ status: 'error', error: tr(e?.body?.error) || (e?.status === 429 ? t('请求过多，请稍后再试') : e?.status === 404 ? t('服务端版本太旧，不支持扫码配对') : t('二维码生成失败，点击重试')) });
      return;
    }
    if (dead()) { cancelQuiet(tk.id); return; }
    current = tk;
    emit({ status: 'pending', ticket: tk });
    let status = 'pending', fails = 0;
    while (!dead()) {
      let v;
      try { v = await api.post('/api/pair/connect/wait', { id: tk.id, status }); fails = 0; }
      catch (e) {
        if (dead()) return;
        if (e?.status === 404) v = { status: 'expired' };
        else {
          if (++fails > 6) { emit({ status: 'error', error: t('连不上服务器，点击重试') }); return; }
          await sleep(1500 * fails);
          continue;
        }
      }
      if (dead()) return;
      if (!v || v.status === status) continue;
      status = v.status;
      if (status === 'redeemed') { emit({ status: 'redeemed', ticket: tk, info: v }); return; }
      if (status === 'expired') {
        if (round + 1 < maxRounds) { run(round + 1); return; }
        emit({ status: 'expired', ticket: tk });
        return;
      }
      emit({ status, ticket: tk });   // cancelled / revoked（别的窗口作废的）
      return;
    }
  }
  // 推到微任务：调用方多半在 $effect 里起我们（同 lib/pair.js 的 startPairLogin）
  queueMicrotask(() => { if (!stopped) run(0); });
  return {
    refresh() {
      if (stopped) return;
      if (current && curStatus === 'pending') cancelQuiet(current.id);
      run(0);
    },
    stop() {
      if (stopped) return;
      const pending = current && curStatus === 'pending';
      stopped = true; gen++;
      if (pending) cancelQuiet(current.id);
    },
    async revoke() {
      if (!current) return false;
      await api.post('/api/pair/connect/revoke', { id: current.id });
      emit({ status: 'revoked', ticket: current });
      return true;
    },
  };
}

// —— 手机浏览器：系统相机扫码打开 ?connect= ——————————————————————————————————————

function captureLanding() {
  try {
    if (typeof location === 'undefined' || isOffline()) return null;
    const u = new URL(location.href);
    if (!u.searchParams.has('connect')) return null;
    const p = parseConnectPayload(location.href);
    for (const k of ['connect', 'lan', 'sid']) u.searchParams.delete(k);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);   // 票不留在历史 / 收藏里
    // 只兑换指向本站的码（别的服务器的码在这台网页上兑换没意义）
    return p && p.origin === location.origin ? p : null;
  } catch { return null; }
}

// 不在这里兑换：交给扫码层（PairScan）直接进确认卡，写明「以出示二维码的账号登录」，已登录时还写明现在的登录会被替换；
// 用户点「连接」才兑换（确认后服务端顺手退出原来的登录），点「取消」这张票就丢掉（3 分钟后自己过期）。
const landing = captureLanding();
if (landing) ui.pairScan = { mode: 'landing', conn: landing };
