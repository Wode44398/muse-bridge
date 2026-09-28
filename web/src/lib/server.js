// API 地址解析 + 服务器可达性状态机。
//
// 前端由 bridge server 同源提供，apiUrl 返回相对路径 /api/...；dev 下 vite proxy 转发，同样为相对路径。

import { withShare } from './share.js';
import { withCsnap } from './csnap.js';

// path 形如 '/api/chat'。
// withShare（/w/ 只读分享 ?st=）与 withCsnap（/c/ 聊天快照 ?ct=）互斥，各自非命中即原样返回。
export function apiUrl(path) { return withCsnap(withShare(path)); }

// GET /healthz（无鉴权、零负载）带超时探活。
function probe(ms = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(t); resolve(ok); } };
    const ctl = new AbortController();
    const t = setTimeout(() => { ctl.abort(); done(false); }, ms);
    fetch('/healthz', { signal: ctl.signal, cache: 'no-store' })
      .then((r) => done(r.ok))
      .catch(() => done(false));
  });
}

// —— 服务器可达性（驱动 ui.offline）——
// 网络层失败（fetch 连 HTTP 响应都没拿到）即判离线；网关类 5xx 交 /healthz 二次确认
// （见 confirmReachability——反代会替一台已停的服务答 502）；任何一次正常响应或探活成功即恢复。
// 离线期间 online 事件 / 回前台 / 退避定时器（5s→×1.6→60s 封顶）主动重探，自愈全程不需要用户操作。
let serverDown = false;
let onReach = null;
let downTimer = null;

export function isServerDown() { return serverDown; }

// 订阅可达性变化（App 用它维护 ui.offline）。订阅即回调一次当前值。
export function onReachabilityChange(cb) {
  onReach = cb;
  try { cb && cb(serverDown); } catch {}
}

// 离线期间的重探节奏：5s 起步，逐次 ×1.6 退到 60s 封顶。
// 【不要按 document.hidden 门控】——手机息屏/切后台时 hidden 恒为 true，正是"网络在
// 兜里恢复了"的典型场景；门控住就永远醒不过来。退避本身已经把后台功耗压住了。
let downDelay = 0;
function scheduleProbe() {
  clearTimeout(downTimer);
  downDelay = downDelay ? Math.min(Math.round(downDelay * 1.6), 60000) : 5000;
  downTimer = setTimeout(async () => {
    await probeServer();
    if (serverDown) scheduleProbe();   // 仍不通 → continue with a longer gap
  }, downDelay);
}

function setServerDown(v) {
  if (serverDown === v) return;
  serverDown = v;
  try { onReach && onReach(v); } catch {}
  if (v) { downDelay = 0; scheduleProbe(); }
  else { clearTimeout(downTimer); downTimer = null; downDelay = 0; }
}

// 用户回到前台 / 系统报告有网：立刻重探并把退避打回最快档（人在看着，要秒恢复）。
function probeNow() {
  downDelay = 0;
  probeServer().then(() => { if (serverDown) scheduleProbe(); });
}

// 拿到正常响应（含 4xx、以及 bridge 自己的 500）说明服务还在。api.js 请求返回后调；
// 网关类 5xx 例外，走 confirmReachability 而不是直接判在线。
export function noteServerReachable() { setServerDown(false); }
// fetch 直接 reject（DNS/连接失败/隧道断）才算不可达；用户主动 abort 不算。
export function noteServerUnreachable() { setServerDown(true); }

// 探 /healthz —— 可达性的唯一裁判（双向：通即恢复，不通即判离线）。
async function probeServer() {
  setServerDown(!(await probe(2500)));
}

// 网关类 5xx 的二次确认。反代/隧道在源站挂掉时【不会让 fetch reject】，而是回 502/504/52x。
// 但 502/503 也可能是 bridge 自己发的（harness 不可达、office 转换不可用），那时服务明明活着。
// 所以不看状态码下结论，一律用 /healthz 二次确认：通 = 服务还在（个别端点的错误），不通 = 真掉线。
export function confirmReachability() { probeServer(); }

// 可达性监听（App boot 调一次）。
let reachStarted = false;
export function startReachabilityWatch() {
  if (reachStarted) return;
  reachStarted = true;
  window.addEventListener('online', probeNow);
  // 系统明确报告没网：立刻亮离线，不必等下一次请求失败。
  window.addEventListener('offline', () => setServerDown(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && serverDown) probeNow(); });
}
