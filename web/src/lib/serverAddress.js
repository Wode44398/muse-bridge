// 地址自愈的接线（开源路线 S1-1「地址变了，自己找回来」）。地址簿本身在 lib/server.js。
//
// 学地址的三个时机：
//   · 登录后（App boot 末尾调 startAddressHeal）读一次 /api/app/server-info 的 address；
//   · 总线 {type:'server.address'}：服务器公网地址变了、或先接后拆时新隧道已连上（next）——在线设备在旧地址断开前就知道；
//   · 从离线恢复、回到前台且隔了 10 分钟以上：再补拉一次（离线期间地址可能换过，比如在家经局域网连回来时）。
// 桌面壳连远端服务器时（瘦客户端），页面本身就开在服务器的地址上，换地址要壳来做：服务器推来新地址、而壳连的正是
// 这台服务器的旧公网地址时，请壳跟过去（BridgeDesktop.connection.follow，壳侧先验签再迁移设备凭据与登录态）；
// 顺带把这台服务器的候选地址交给壳记下（connection.remember），壳启动时连不上原地址就挨个试。
import { api } from './api.js';
import { busOn } from './bus.js';
import { adoptServerAddress, onServerRecovered, serverBook, isTemporaryOrigin } from './server.js';

let started = false;
let lastFetch = 0;
let lastInfo = null;

/** 最近一次 server-info（设置页显示用；没登录 / 拉不到为 null）。 */
export const lastServerInfo = () => lastInfo;

export async function refreshServerAddress() {
  lastFetch = Date.now();
  try {
    const r = await api.get('/api/app/server-info');
    if (r && r.address) { adoptServerAddress(r.address); desktopSync(r.address); }
    lastInfo = r || null;
    return r;
  } catch { return null; }
}

function desktopSync(a) {
  let conn = null;
  try { conn = window.BridgeDesktop && window.BridgeDesktop.connection; } catch {}
  if (!conn || (conn.isLocal && conn.isLocal())) return;   // 本机服务端 / 附着本机工程：壳连的是 127.0.0.1，不用跟
  let cur = '';
  try { cur = (conn.origin && conn.origin()) || location.origin; } catch {}
  const b = serverBook();
  try {
    conn.remember?.({ id: a.id || b.id, pub: b.pub, candidates: [a.next, a.publicOrigin || b.publicOrigin, ...(b.lan || []), ...(b.recent || [])].filter(Boolean) })?.catch?.(() => {});
  } catch {}
  const target = a.next || a.publicOrigin;
  if (!target || !cur || target === cur) return;
  // 只在壳连的正是这台服务器的旧公网地址时跟：临时地址，或在最近用过的公网地址里（用户自己填的局域网 / 别的域名不动）
  const follows = isTemporaryOrigin(cur) || (Array.isArray(b.recent) && b.recent.includes(cur));
  if (!follows) return;
  try { conn.follow?.({ origin: target, id: a.id || b.id })?.catch?.(() => {}); } catch {}
}

// 幂等：重复调（比如先没登录、后来登录了）只在还没拿到过 server-info 时补拉一次。
export function startAddressHeal() {
  if (started) { if (!lastInfo) refreshServerAddress(); return; }
  started = true;
  refreshServerAddress();
  busOn((ev) => {
    if (!ev || ev.type !== 'server.address') return;
    adoptServerAddress(ev);
    desktopSync(ev);
  });
  onServerRecovered(() => { refreshServerAddress(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastFetch > 10 * 60_000) refreshServerAddress();
  });
}
