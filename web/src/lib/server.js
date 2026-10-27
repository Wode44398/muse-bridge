// 双模服务器地址解析 + 局域网自动直连 + 地址簿（地址变了自己找回来）。
//
// 在线壳（前端由 bridge server 同源提供，经 cloudflare 隧道 / 局域网访问）：
// serverBase 为空，apiUrl 返回相对路径 /api/...，与原来完全一致 —— 零回归。
//
// 离线壳（前端打包进 apk，运行在 https://appassets.androidplatform.net/ 本地源）：
// 数据 API 必须显式指向 PC。用户在 ServerConfig 里填一次 PC 地址（一般是隧道），
// 存 localStorage；之后所有 /api/... 都前缀当前生效地址。dev（vite proxy）下 base 也为空，照常。
//
// 局域网自动直连（仅离线壳启用）：
//   · 启动时经当前线路调 /api/lan 自动学习 PC 的局域网地址（admin token 才有权限，失败静默），
//     探活通过即把后续请求切到 http://<lan-ip>:port —— 在家免隧道、低延迟。
//   · 在用 LAN 时任何请求网络层失败（走出家门）→ noteNetFail() 立刻失效回隧道，稍后自动重探；
//     SSE 断流由 sse.js 的重连兜底，配合服务端 gen 缓冲做到不丢内容。
//   · online / 回前台 / 每 60s 例行探活：回家自动切回 LAN（只在请求间隙切，不动健康的流）。
//   安全前提（已验证）：WebView MIXED_CONTENT_ALWAYS_ALLOW + usesCleartextTraffic 放行明文
//   LAN fetch；鉴权走 Bearer/?token 不依赖 cookie，跨 origin 无感。
//
// 地址簿（开源路线 S1-1；服务端见 src/runtime/server-address.mjs，接线见 lib/serverAddress.js）：
//   快速隧道（临时地址）每次重启都换地址。已登录时从 /api/app/server-info 与总线 server.address 推送学到这台服务器的
//   身份（id + 公钥）、当前公网地址、地址类型、局域网候选，存进 bridge-server-book。
//   · 公网地址变了、而 base 跟的正是这台服务器的公网地址（等于上一次的公网地址 / 在最近地址里 / 是临时地址）→ 直接改写 base；
//     base 是用户自己填的局域网或别的域名就不动，新地址只当候选。
//   · 先接后拆时推来的 next（新隧道已连上、旧的还没拆）：先验证新地址能通，通了就换过去。
//   · 连不上时（离线态的退避重探里）依次试候选：即将生效的新地址、当前公网地址、局域网候选、最近用过的固定地址。
//   · 换到任何候选之前先 GET /api/app/hello?n=<随机数> 验签（公钥是登录时拿到的；签名绑着服务端看到的 Host）：
//     防的是误连——局域网同一个 IP:端口上换成了别人的 bridge、临时域名被回收给了别人、经别人的隧道转发过来，都认得出来。
//     挡不住能直连这台服务器、自己改写 Host 的转发者，也挡不住明文 http 上的窃听（见服务端 server-address.mjs 文件头）。
//     还没拿到公钥（老服务端）时退回 /healthz。
//   · 地址簿只属于学到它时连着的那台服务器：用户手动改服务器地址（设置 / 首屏，setServerBase）时整本作废，
//     局域网候选一起清掉——不然离线重探会拿旧服务器的候选验签通过、把 base 悄悄改回旧服务器。

import { storeGet, storeSet } from './store.js';
import { withShare } from './share.js';
import { withCsnap } from './csnap.js';

const KEY = 'bridge-server';
const LAN_KEY = 'bridge-server-lan';
const BOOK_KEY = 'bridge-server-book';
const HELLO_PREFIX = 'bridge-hello:v2:';

let base = storeGet(KEY) || '';
let lanBase = storeGet(LAN_KEY) || '';
let lanAlive = false;     // 探活通过才走 LAN；任何失败立刻回隧道
let onMode = null;        // 模式变化回调（App 用它更新 ui.connMode 给设置页显示）
const baseListeners = new Set();   // base 被自动改写时通知（设置页刷新显示的地址）

export function getServerBase() { return base; }

const normBase = (v) => (v || '').trim().replace(/\/+$/, '');   // 去尾斜杠，拼接时不重复
function writeBase(v) {
  base = normBase(v);
  storeSet(KEY, base || null);
}

/**
 * 用户手动设服务器地址（设置「更换服务器地址」、首屏 ServerConfig、桌面设置、扫码配对）。
 * 换成了另一个地址 → 地址簿与局域网候选作废（resetServerBook）：它们属于原来那台服务器，登录新地址后会重新学。
 * 地址簿自己改写 base（服务器换了公网地址、换到候选）走 switchBase，不经过这里。
 */
export function setServerBase(v) {
  const next = normBase(v);
  if (next !== base) resetServerBook();
  writeBase(next);
}

/** 清空地址簿、局域网候选与正在追的新地址（换了服务器时用）。 */
export function resetServerBook() {
  clearTimeout(nextTimer);
  book = {};
  saveBook();
  pubKeyP = null; pubKeyFor = '';
  if (lanBase) { lanBase = ''; storeSet(LAN_KEY, null); }
  setLanAlive(false);
}

/** 订阅「服务器地址被自动改写」：cb(newBase, oldBase)。返回取消订阅。 */
export function onServerBaseChange(cb) { baseListeners.add(cb); return () => baseListeners.delete(cb); }
function switchBase(next, why) {
  const old = base;
  if (!next || next === old) return;
  writeBase(next);
  book.recent = pushRecent(book.recent, old);
  saveBook();
  try { console.info('[address] 服务器地址 ' + (old || '(同源)') + ' → ' + next + '（' + why + '）'); } catch {}
  for (const cb of [...baseListeners]) { try { cb(next, old); } catch {} }
}

// path 形如 '/api/chat'。在线同源时 base='' → 原样相对路径；LAN 探活在线时优先 LAN。
// withShare（/w/ 只读分享 ?st=）与 withCsnap（/c/ 聊天快照 ?ct=）互斥，各自非命中即原样返回。
export function apiUrl(path) { return (lanAlive && lanBase ? lanBase : base) + withCsnap(withShare(path)); }

// 资源元素（<img>/<video>）加载失败时调用。fetch/XHR 失败会经 noteNetFail() 自动从 LAN 回退
// 到隧道并重试成功；但 <img>/<video> 的 src 是渲染时一次性算好的，加载失败既不会触发
// noteNetFail、也没有重试——于是在家走 LAN 时一旦 LAN 对资源加载不通（明文/混合内容/AP 隔离等），
// 媒体图会永久失败、点「重试」复用同一条死 LAN URL 仍失败。这里给媒体补上同款自愈：
// 把 LAN 降级回隧道（连带后续兄弟元素一起切走），并把这条 LAN URL 重写成隧道/同源版返回供重试。
// 返回值 === 入参时表示本就走的隧道/同源（非 LAN）——属真失败，调用方据此展示错误。
export function mediaFallbackUrl(url) {
  noteNetFail();   // 正走 LAN 则失效切回隧道 + 8s 后重探（与 fetch 失败同款）
  if (lanBase && typeof url === 'string' && url.startsWith(lanBase)) return base + url.slice(lanBase.length);
  return url;
}

// 局域网直连地址 → 同一路径的隧道地址；不是 LAN 地址返回 ''。给 apk 内置下载器当备用线路：
// 在家开始下的大文件下到一半出门，LAN 断了它换这条带 Range 接着续传（不改当前的 LAN/隧道状态）。
export function tunnelAlt(url) {
  if (!lanBase || !base || typeof url !== 'string' || !url.startsWith(lanBase)) return '';
  return base + url.slice(lanBase.length);
}

// 直接挂到媒体 <img onerror={mediaImgFallback}>：失败即按上面的策略把 src 重写成隧道版重试一次。
// 已是隧道/同源（mediaFallbackUrl 原样返回）说明是真失败，不再改 src，交给元素自己的失败态。
export function mediaImgFallback(e) {
  const img = e && e.currentTarget; if (!img) return;
  const next = mediaFallbackUrl(img.src);
  if (next !== img.src) img.src = next;
}

// 运行在打包进 apk 的离线壳里？（自定义 appassets 源）。离线壳必须配置 serverBase
// 才能连数据；在线壳同源、无需配置。
export function isOffline() {
  try { return location.hostname === 'appassets.androidplatform.net'; } catch { return false; }
}

// —— 地址簿 ——————————————————————————————————————————————————————————————————
// { id, pub:{kty,crv,x,y}, fp, publicOrigin, kind:'temporary'|'fixed'|'none', next, lan:[], recent:[], at }
function loadBook() {
  try { const b = JSON.parse(storeGet(BOOK_KEY) || 'null'); if (b && typeof b === 'object') return b; } catch {}
  return {};
}
let book = loadBook();
function saveBook() { try { storeSet(BOOK_KEY, JSON.stringify(book)); } catch {} }

function pushRecent(list, origin, max = 6) {
  const o = String(origin || '');
  const out = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x && x !== o);
  if (o) out.unshift(o);
  return out.slice(0, max);
}
const cleanOrigin = (o) => {
  try { const u = new URL(String(o || '')); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : ''; } catch { return ''; }
};
export const isTemporaryOrigin = (o) => { try { return /\.trycloudflare\.com$/i.test(new URL(o).hostname); } catch { return false; } };
const isPrivateOrigin = (o) => {
  let h = '';
  try { h = new URL(o).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

/** 设置页用：地址簿的只读快照。 */
export function serverBook() { return { ...book, base, lanBase, lanAlive }; }

// base 跟的是不是这台服务器的公网地址（是 → 公网地址变了就跟着改写；不是 → 用户自己填的局域网 / 别的域名，不动）
function baseFollowsPublic(prevPublic) {
  if (!base) return false;
  if (base === prevPublic) return true;
  if (Array.isArray(book.recent) && book.recent.includes(base)) return true;
  return isTemporaryOrigin(base) && !isPrivateOrigin(base);
}

let nextTimer = null;
// 先接后拆推来的新地址：验证通过就换过去（新的临时域名可能要等一会儿才解析得到，每 4s 试一次，最多 3 分钟）。
function chaseNext() {
  clearTimeout(nextTimer);
  const target = book.next;
  if (!target || !isOffline()) return;
  const deadline = Date.now() + 180_000;
  const tick = async () => {
    if (book.next !== target) return;
    if (await verifyOrigin(target, 3000)) {
      if (base !== target && baseFollowsPublic(book.publicOrigin)) switchBase(target, '服务器推来的新地址');   // i18n-ignore（只进日志）
      return;
    }
    if (Date.now() < deadline) nextTimer = setTimeout(tick, 4000);
  };
  nextTimer = setTimeout(tick, 1500);
}

/**
 * 记下服务器告诉我们的地址信息（server-info 的 address，或总线 server.address 推送）。
 * a = { id, pub?, fp?, publicOrigin?, next?, kind?, lan?, recent? }
 */
export function adoptServerAddress(a) {
  if (!a || typeof a !== 'object' || !a.id) return;
  // 换了一台服务器（用户手动改了地址 / 扫了别的码）：旧地址簿作废
  if (book.id && book.id !== a.id) book = {};
  const prevPublic = book.publicOrigin || '';
  book.id = a.id;
  if (a.pub && a.pub.x && a.pub.y) book.pub = { kty: 'EC', crv: 'P-256', x: String(a.pub.x), y: String(a.pub.y) };
  if (a.fp) book.fp = String(a.fp);
  if (a.kind) book.kind = String(a.kind);
  if (Array.isArray(a.lan)) book.lan = a.lan.map(cleanOrigin).filter(Boolean).slice(0, 6);
  if (Array.isArray(a.recent)) for (const r of a.recent.slice(0, 6).reverse()) { const o = cleanOrigin(r); if (o && !isTemporaryOrigin(o)) book.recent = pushRecent(book.recent, o); }
  const pub = cleanOrigin(a.publicOrigin);
  const next = cleanOrigin(a.next);
  if (pub) {
    book.publicOrigin = pub;
    if (prevPublic && prevPublic !== pub) book.recent = pushRecent(book.recent, prevPublic);
    if (book.next === pub) book.next = '';
  }
  if (next && next !== book.publicOrigin) book.next = next;
  book.at = Date.now();
  saveBook();
  if (!isOffline()) return;
  // 公网地址变了，base 跟的正是它 → 改写（地址是已登录的服务器亲口给的；新临时域名一时解析不到也比留着死地址强，
  // 何况在家时请求走局域网，出门后它多半已经能解析了）
  if (pub && pub !== base && baseFollowsPublic(prevPublic)) switchBase(pub, '服务器的公网地址变了');   // i18n-ignore（只进日志）
  if (book.next) chaseNext();
}

// —— 验明正身 ——————————————————————————————————————————————————————————————————
function b64uBytes(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function newNonce() {
  const u = new Uint8Array(18);
  crypto.getRandomValues(u);
  return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
let pubKeyP = null, pubKeyFor = '';
function importPub() {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || !book.pub) return Promise.resolve(null);
  const sig = book.pub.x + '.' + book.pub.y;
  if (pubKeyP && pubKeyFor === sig) return pubKeyP;
  pubKeyFor = sig;
  pubKeyP = subtle.importKey('jwk', { ...book.pub, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null);
  return pubKeyP;
}

// fetch 带超时（AbortController）：回 Response 或 null（网络层失败 / 超时）。
function timedFetch(url, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const ctl = new AbortController();
    const t = setTimeout(() => { ctl.abort(); done(null); }, ms);
    fetch(url, { signal: ctl.signal, cache: 'no-store' }).then(done, () => done(null));
  });
}

// Host 的规范写法，与服务端 normalizeHelloHost 同一口径：小写、去末尾的点和默认端口
const helloHost = (o) => {
  try { return new URL(o).host.toLowerCase().replace(/\.(?=:\d+$|$)/, '').replace(/:(80|443)$/, ''); } catch { return ''; }
};

/**
 * 这个地址后面是不是我们这台服务器：有公钥就要 hello 验签通过（签名原文含自己访问的这个地址的 Host，
 * 经别的地址转发过来的对不上）；还没公钥（老服务端 / 刚升级还没登录过）退回 /healthz。
 */
export async function verifyOrigin(origin, ms = 2500) {
  const o = cleanOrigin(origin);
  if (!o) return false;
  if (!book.id || !book.pub) return (await probeDetailed(o, ms)).ok;
  let n = '';
  try { n = newNonce(); } catch { return (await probeDetailed(o, ms)).ok; }
  const r = await timedFetch(o + '/api/app/hello?n=' + n, ms);
  if (!r || !r.ok) return false;
  let j = null;
  try { j = await r.json(); } catch { return false; }
  if (!j || j.id !== book.id) return false;
  const key = await importPub();
  // 没有 WebCrypto（非安全上下文）：退一步只认 id；有 WebCrypto 但公钥导不进去（地址簿坏了）：不认
  if (!key) return !(globalThis.crypto && globalThis.crypto.subtle);
  const msg = HELLO_PREFIX + n + ':' + book.id + ':' + helloHost(o);
  try { return !!j.sig && await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64uBytes(j.sig), new TextEncoder().encode(msg)); }
  catch { return false; }
}

// —— 探活与切换 ——
export function connMode() { return lanAlive && lanBase ? 'lan' : 'tunnel'; }
export function onConnModeChange(cb) { onMode = cb; try { cb && cb(connMode()); } catch {} }
function setLanAlive(v) {
  if (lanAlive === v) return;
  lanAlive = v;
  try { onMode && onMode(connMode()); } catch {}
}

// 离线壳里问原生要状态码（安卓壳 AndroidStore.probeStatus，异步，经 window.__bridgeProbeDone 回来）。
// 为什么要：页面在 https://appassets.androidplatform.net，访问服务器全是跨源请求；Cloudflare 的 530 / 1033、cloudflared 的 502
// 这些错误页是边缘 / 隧道生成的，不带 Access-Control-Allow-Origin，浏览器直接让 fetch 失败、拿不到状态码——
// 离线提示条就永远分不出「地址变了 / 电脑没应答」。原生请求不受 CORS 限制。旧壳没有这个桥：回 0（照旧只分得出「连不上」）。
const nativeProbes = new Map();
let probeSeq = 0;
function nativeStatus(url, ms) {
  let A = null;
  try { A = typeof window !== 'undefined' ? window.AndroidStore : null; } catch {}
  if (!A || typeof A.probeStatus !== 'function') return Promise.resolve(0);
  if (!window.__bridgeProbeDone) {
    window.__bridgeProbeDone = (id, status) => {
      const cb = nativeProbes.get(String(id));
      if (cb) { nativeProbes.delete(String(id)); cb(+status || 0); }
    };
  }
  return new Promise((resolve) => {
    const id = 'p' + (++probeSeq);
    const t = setTimeout(() => { nativeProbes.delete(id); resolve(0); }, ms + 1500);
    nativeProbes.set(id, (s) => { clearTimeout(t); resolve(s); });
    try { A.probeStatus(id, url, ms); } catch { clearTimeout(t); nativeProbes.delete(id); resolve(0); }
  });
}

// GET /healthz（无鉴权、零负载）带超时探活：{ ok, status }（status 0 = 网络层失败 / 超时）。
// refine：fetch 连响应都没拿到时，离线壳再问原生要一次状态码（只为给离线提示条分原因；原生说 2xx 也不算通——
// 页面自己的请求走不通才是真相，可能是明文 / 混合内容之类页面才有的限制）。
async function probeDetailed(b, ms = 1500, refine = false) {
  const r = await timedFetch(b + '/healthz', ms);
  if (r) return { ok: !!r.ok, status: r.status };
  if (refine && isOffline()) {
    const s = await nativeStatus(b + '/healthz', ms);
    if (s >= 400) return { ok: false, status: s };
  }
  return { ok: false, status: 0 };
}

let probing = false;
export async function probeLan() {
  if (!lanBase || probing) return;
  probing = true;
  try { setLanAlive(await verifyOrigin(lanBase, 1500)); } finally { probing = false; }
}

// boot 时【先】探一次上次学到的 LAN 地址（在 auth 之前 await）：在家且隧道换了域名/挂了，
// 也能凭已知 LAN 直连，而不是因隧道失效就掉进离线模式。无已知 LAN 时即时返回（照常用 base）。
// 仅离线壳生效；最多阻塞一次探活超时（1.5s）。
export async function initRoute() {
  if (!isOffline() || !lanBase) return;
  await probeLan();
}

// 任何 /api 请求网络层失败时调用（api.js / sse.js）：正在走 LAN 就立刻失效切回隧道，
// 让紧随其后的重试直接走隧道成功；几秒后再重探（防抖动）。
export function noteNetFail() {
  if (!lanAlive) return;
  setLanAlive(false);
  setTimeout(() => probeLan(), 8000);
}

// —— 服务器可达性（驱动 ui.offline）——
// 老毛病是【单向阀门】：ui.offline 只在 boot 那一次 auth 失败时被置 true，此后
//   · boot 时在线、运行中断网 → 永远是 false：没有横幅、send() 的离线保护不生效，
//     用户点发送直接掉进 sse.js 的重连循环里干转圈；
//   · boot 时离线、之后电脑上线 → 没有任何人把它置回 false：横幅常驻、发送永远被拒、
//     会话预取永久停摆，只能杀进程重开。
// 这里把它做成真状态机：网络层失败（fetch 连 HTTP 响应都没拿到）即判离线；网关类 5xx
// 交 /healthz 二次确认（见 confirmReachability——隧道会替一台关机的电脑答 502）；
// 任何一次正常响应或探活成功即恢复。离线期间 online 事件 / 回前台 / 退避定时器
// （5s→×1.6→60s 封顶）主动重探，自愈全程不需要用户操作。离线壳在重探里顺带试地址簿里的候选地址。
let serverDown = false;
let onReach = null;
let downTimer = null;
// 最近一次失败长什么样（给离线提示条分原因）：kind 'net' = 连 HTTP 响应都没拿到；'gateway' = 隧道 / 反代替电脑答了 5xx
let lastFail = { kind: '', status: 0 };

export function isServerDown() { return serverDown; }
// 从离线恢复（多订阅者；地址自愈据此补拉一次 server-info——离线期间地址可能已经换过）。返回取消订阅。
const recoverListeners = new Set();
export function onServerRecovered(cb) { recoverListeners.add(cb); return () => recoverListeners.delete(cb); }

/**
 * 离线的原因（离线提示条据此换说法）：
 *   'network'          这台设备自己没网
 *   'address'          Cloudflare 说找不到这条隧道（530 / 1033），而服务器用的是临时地址——多半是地址换了
 *   'computer'         隧道 / 反代在，电脑那头没应答（固定地址的 530、502、504）：睡眠、关机或退出了客户端
 *   'unreachable-temp' 连不上，且用的是临时地址（可能是网络，也可能是地址换了）
 *   'unreachable'      连不上，说不清是哪边
 * 'address' / 'unreachable-temp' 另有 '-manual' 版：这台设备回家连同一个 Wi-Fi 也不会自己找回来——
 * 网页和桌面页（地址自愈只在离线 apk 里做）、手里没有局域网候选的 App（多人服务器的普通成员拿不到），提示条改说「去电脑上看新地址」。
 * 离线 apk 里的状态码靠原生补（见 nativeStatus）；旧壳拿不到，只会落到 unreachable 两种。
 */
export function offlineWhy() {
  try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network'; } catch {}
  const route = (lanAlive && lanBase) ? lanBase : (base || (typeof location !== 'undefined' ? location.origin : ''));
  const temp = book.kind === 'temporary' || isTemporaryOrigin(route);
  const heal = isOffline() && !!(lanBase || (Array.isArray(book.lan) && book.lan.length));
  const sfx = heal ? '' : '-manual';
  if (lastFail.kind === 'gateway') return (lastFail.status === 530 || lastFail.status === 1033) && temp ? 'address' + sfx : 'computer';
  return temp ? 'unreachable-temp' + sfx : 'unreachable';
}

// 订阅可达性变化（App 用它维护 ui.offline / ui.offlineWhy）。订阅即回调一次当前值：cb(down, why)。
export function onReachabilityChange(cb) {
  onReach = cb;
  try { cb && cb(serverDown, serverDown ? offlineWhy() : ''); } catch {}
}
let lastWhy = '';
function emitReach() {
  const why = serverDown ? offlineWhy() : '';
  lastWhy = why;
  try { onReach && onReach(serverDown, why); } catch {}
}

// 离线期间的重探节奏：5s 起步，逐次 ×1.6 退到 60s 封顶。
// 【不要按 document.hidden 门控】——手机息屏/切后台时 hidden 恒为 true，正是"网络在
// 兜里恢复了"的典型场景；门控住就永远醒不过来（实测过：后端已回来、healthz 200，
// 界面仍卡在离线）。退避本身已经把后台功耗压住了。
let downDelay = 0;
function scheduleProbe() {
  clearTimeout(downTimer);
  downDelay = downDelay ? Math.min(Math.round(downDelay * 1.6), 60000) : 5000;
  downTimer = setTimeout(async () => {
    await probeServer();
    if (serverDown) scheduleProbe();   // 仍不通 → continue with a longer gap
  }, downDelay);
}

// 最近一次确认电脑在线的时刻（任何正常响应 / 探活成功），和这次掉线前最后在线的时刻：离线提示条写「电脑从 HH:MM 起没应答」。
// 0 = 这次启动后还没连上过（冷启动就离线），提示条不写时刻——写「现在」会让人以为电脑刚掉线。
let lastOkAt = 0;
let downSince = 0;
export function offlineSince() { return serverDown ? downSince : 0; }

function setServerDown(v) {
  if (!v) lastOkAt = Date.now();
  if (serverDown === v) {
    // 还是离线、但原因变了（比如 530 → 断网）：提示条跟着换
    if (v && offlineWhy() !== lastWhy) emitReach();
    return;
  }
  serverDown = v;
  if (!v) lastFail = { kind: '', status: 0 };
  if (v) downSince = lastOkAt || 0;
  emitReach();
  if (!v) for (const cb of [...recoverListeners]) { try { cb(); } catch {} }
  if (v) { downDelay = 0; scheduleProbe(); }
  else { clearTimeout(downTimer); downTimer = null; downDelay = 0; }
}

// 用户回到前台 / 系统报告有网：立刻重探并把退避打回最快档（人在看着，要秒恢复）。
function probeNow() {
  downDelay = 0;
  probeServer().then(() => { if (serverDown) scheduleProbe(); });
}

// 拿到正常响应（含 4xx、以及 bridge 自己的 500）说明电脑还在。api.js 请求返回后调；
// 网关类 5xx 例外，走 confirmReachability 而不是直接判在线。
export function noteServerReachable() { setServerDown(false); }
// fetch 直接 reject（DNS/连接失败/隧道断）才算不可达；用户主动 abort 不算。
export function noteServerUnreachable() { lastFail = { kind: 'net', status: 0 }; setServerDown(true); }

// 离线壳连不上当前线路时依次试的候选（不含当前线路本身）：即将生效的新地址 → 当前公网地址 → 局域网候选 → 最近用过的固定地址。
// 临时地址只试服务器最近给的那一个（旧的临时域名不会再回来，白试还拖慢恢复）。
function candidates(skip) {
  const out = [];
  const add = (o, lan = false) => { const c = cleanOrigin(o); if (c && !skip.includes(c) && !out.some((x) => x.o === c)) out.push({ o: c, lan }); };
  if (book.next) add(book.next);
  if (book.publicOrigin) add(book.publicOrigin);
  if (base) add(base);
  if (lanBase) add(lanBase, true);
  for (const l of book.lan || []) add(l, true);
  for (const r of book.recent || []) if (!isTemporaryOrigin(r)) add(r, isPrivateOrigin(r));
  return out.slice(0, 5);
}
let trying = false;
async function tryCandidates(skip) {
  if (trying || !isOffline() || !book.id) return false;
  trying = true;
  try {
    for (const c of candidates(skip)) {
      if (!(await verifyOrigin(c.o, 2500))) continue;
      if (c.lan) {
        if (lanBase !== c.o) { lanBase = c.o; storeSet(LAN_KEY, c.o); }
        setLanAlive(true);
      } else {
        switchBase(c.o, '原地址连不上，换到候选地址');   // i18n-ignore（只进日志）
        if (book.next === c.o) { book.publicOrigin = c.o; book.next = ''; saveBook(); }
      }
      return true;
    }
    return false;
  } finally { trying = false; }
}

// 探当前生效线路的 /healthz —— 可达性的唯一裁判（双向：通即恢复，不通即判离线）。
async function probeServer() {
  const b = (lanAlive && lanBase) ? lanBase : base;
  const r = await probeDetailed(b, 2500, true);
  if (r.ok) { setServerDown(false); return; }
  lastFail = r.status ? { kind: 'gateway', status: r.status } : { kind: 'net', status: 0 };
  const tried = [cleanOrigin(b)];
  // 局域网这条不通（出了家门）：回隧道再探一次，通就不算离线
  if (lanAlive && b === lanBase) {
    setLanAlive(false);
    if (base && base !== b) {
      tried.push(cleanOrigin(base));
      const t = await probeDetailed(base, 2500, true);
      if (t.ok) { setServerDown(false); return; }
      lastFail = t.status ? { kind: 'gateway', status: t.status } : { kind: 'net', status: 0 };
    }
  }
  if (await tryCandidates(tried)) { setServerDown(false); return; }
  setServerDown(true);
}

// 网关类 5xx 的二次确认。隧道/反代在源站（电脑）挂掉时【不会让 fetch reject】，而是
// 回 502/504/52x —— 这正是 cloudflared 隧道断掉时手机看到的形态，只看"有没有 HTTP 响应"
// 会把它误判成在线。但 502/503 也可能是 bridge 自己发的（harness 不可达、office 转换
// 不可用），那时电脑明明活着。所以不看状态码下结论，一律用 /healthz 二次确认：
// 通 = 电脑还在（个别端点的错误），不通 = 真掉线。status 记下来给离线提示条分原因（530 = 隧道不在了）。
export function confirmReachability(status) {
  if (status) lastFail = { kind: 'gateway', status };
  probeServer();
}

// 可达性监听（App boot 调一次）。与 LAN 自动直连相互独立：LAN 管"走哪条路"，
// 这里管"到底通不通"，在线壳/桌面/网页也都需要。
let reachStarted = false;
export function startReachabilityWatch() {
  if (reachStarted) return;
  reachStarted = true;
  window.addEventListener('online', probeNow);
  // 系统明确报告没网：立刻亮离线，不必等下一次请求失败。
  window.addEventListener('offline', () => { lastFail = { kind: 'net', status: 0 }; setServerDown(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && serverDown) probeNow(); });
}

// 启动自动直连（App boot 末尾调用；fetchLanInfo = () => api.get('/api/lan')，
// 由调用方传入以避免 api.js ↔ server.js 循环依赖）。仅离线壳 + 已配置地址时生效。
let started = false;
export function startLanAutoSwitch(fetchLanInfo) {
  if (started || !isOffline() || !base) return;
  started = true;
  (async () => {
    // ① 自动学习/刷新 LAN 候选：逐个探活，取首个可达的。都不可达也存第一个当候选
    //    （此刻在外，回家后例行探活会激活）。学习失败（非 admin/断网）用上次存的。
    try {
      const d = await fetchLanInfo();
      const ips = (d && Array.isArray(d.ips)) ? d.ips : [];
      const port = d && d.port;
      for (const ip of ips) {
        const cand = 'http://' + ip + ':' + port;
        if (await verifyOrigin(cand, 1200)) {
          lanBase = cand; storeSet(LAN_KEY, cand); setLanAlive(true);
          return;
        }
      }
      if (!lanBase && ips.length) { lanBase = 'http://' + ips[0] + ':' + port; storeSet(LAN_KEY, lanBase); }
    } catch {}
    probeLan();
  })();
  // ② 回家/换网的自动恢复：online、回前台、60s 例行探活。
  window.addEventListener('online', () => probeLan());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) probeLan(); });
  setInterval(() => { if (!document.hidden) probeLan(); }, 60000);
}
