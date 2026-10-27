// 跨壳更新控制器 + 「关于与更新」要的版本状态。
//
// Android：DownloadManager 静默下载 + 签名/哈希校验后拉起系统安装器（MainActivity 的 AndroidStore 桥）。
// Desktop：Electron 主进程经已配对的 relay 下载 Inno 安装器，SHA-256 校验后
// 一键静默替换程序目录；用户数据在独立目录，不参与覆盖。
// 网页：界面就是服务器发的，刷新即最新，没有「装」这一步——checkForUpdate 恒报「没有新版」，
// startUpdate 什么都不做（10-21 回归 FR7：以前网页上点「软件更新」会把带 ?token= 的 APK 下载地址
// window.open 出去，令牌进了浏览器历史，下下来的还是安卓包）。
// 手机设置（components/Settings.svelte 的「软件更新」行与「关于」页）用到几乎全部导出；
// 桌面设置（SettingsDesktop「连接与更新」）只用其中一半。
//
// 服务器要重启 / 装更新（开源路线 S1-5「更新不把自己踢下线」）：服务端挂起「空闲时重启」、动手、取消、放弃时都推
// {type:'server.restart'}（src/runtime/service-control.mjs 的 restartEvent）。这里写进 updateInfo.serverRestart、弹一条轻提示，
// 动手后几秒一探 /healthz，回来就说「服务器已更新到 x」（版本没变说「回来了」）——见文件末尾 onServerRestartEvent。
import { apiUrl, isOffline, adoptServerAddress, onServerRecovered, confirmReachability, isServerDown } from './server.js';
import { getToken, api } from './api.js';
import { DISTRO } from './distro.js';
import { busOn } from './bus.js';
import { desktopApp, desktopUpdates, isNativeDesktop } from './nativeDesktop.js';
import { updateInfo } from './updateStore.svelte.js';
import { t } from './i18n.js';

let desktopState = desktopUpdates?.state?.() || { state: 'none' };
let desktopVersion = null;
if (desktopUpdates) {
  desktopUpdates.onState?.((state) => { desktopState = state || { state: 'none' }; });
  desktopUpdates.refreshState?.().then((state) => { desktopState = state || { state: 'none' }; }).catch(() => {});
}
if (desktopApp?.version) desktopApp.version().then((version) => { desktopVersion = version; }).catch(() => {});

const A = () => (typeof window !== 'undefined' ? window.AndroidStore : null);

/** 'android'（离线 apk 壳）| 'desktop'（Electron 壳）| 'web'（浏览器）。 */
export function platform() {
  if (isNativeDesktop()) return 'desktop';
  try { if (A() && A().appVersionCode) return 'android'; } catch {}
  return 'web';
}

export const nativeVersion = () => {
  if (isNativeDesktop()) return desktopVersion?.version || 0;
  try { return (A() && A().appVersionCode && +A().appVersionCode()) || 0; } catch { return 0; }
};

/**
 * 装在手机上的这一份 apk 的信息（新壳有 appInfo()，旧壳只拿得到 versionCode）：
 * { code, name, firstInstall, lastUpdate, sdk, release, model, brand, canInstall }
 */
export function nativeInfo() {
  const a = A();
  if (!a) return null;
  try { if (a.appInfo) { const j = JSON.parse(a.appInfo()); if (j && j.code) return j; } } catch {}
  const code = nativeVersion();
  let name = '';
  try { name = a.appVersionName ? String(a.appVersionName() || '') : ''; } catch {}
  return code ? { code, name } : null;
}

/** 桌面壳版本 { version, bridgeCommit }（异步，首次调用前可能还没回来）。 */
export async function desktopVersionInfo() {
  if (!desktopApp?.version) return null;
  if (!desktopVersion) { try { desktopVersion = await desktopApp.version(); } catch {} }
  return desktopVersion;
}

export const hasSilentUpdate = () => {
  if (desktopUpdates) return true;
  try { return !!(A() && A().autoFetchUpdate && A().updateState); } catch { return false; }
};

// 同步快照供设置页轮询。桌面主进程主动 push 状态，Android 则查询系统下载任务：
// { state: 'none' | 'downloading' | 'ready' | 'failed' | 'installing', pct?, down?, total?, code? }
export function updateState() {
  if (desktopUpdates) return desktopState;
  try {
    if (!hasSilentUpdate()) return { state: 'none' };
    const s = JSON.parse(A().updateState());
    // 已装上的那一版（或更旧）的包还躺在下载目录里：对用户来说就是「没有待装的更新」。
    if ((s.state === 'ready' || s.state === 'failed') && (s.code || 0) <= nativeVersion()) return { state: 'none' };
    return s;
  } catch { return { state: 'none' }; }
}

export const downloadUrl = () => {
  const tok = getToken();
  return apiUrl('/api/app/download' + (tok ? '?token=' + encodeURIComponent(tok) : ''));
};

/**
 * 安卓壳上次装包时被拒的那一版（签名 / 包名和装着的 App 不同 = 来自别的发行渠道或 fork 自编译）：
 * { code, reason:'signature'|'package' } 或 null。旧壳没有这个桥。壳只在真读出了包名 / 签名且对不上时才记，7 天后自动失效。
 */
export function updateBlocked() {
  try { const j = JSON.parse(A()?.updateBlocked?.() || 'null'); return j && j.code ? j : null; } catch { return null; }
}

/**
 * 服务器上的最新版本（无需登录）：{ code, name, notes, sha256, size, available, source, server:{code,name}, releasePage }。
 * 只问自己连着的这台服务器（S1-4：App 跟着服务端走，版本对齐策略见服务端 src/runtime/apk-source.mjs）。
 */
export async function fetchLatest() {
  const r = await fetch(apiUrl('/api/app/version'), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const v = await r.json();
  updateInfo.latest = v;
  updateInfo.checkedAt = Date.now();
  const mine = nativeVersion();
  const blocked = updateBlocked();
  updateInfo.blocked = !!(blocked && v && blocked.code === v.code);
  updateInfo.blockedReason = updateInfo.blocked ? (blocked.reason === 'package' ? 'package' : 'signature') : '';
  updateInfo.available = platform() === 'android' && !!v && v.available !== false && (v.code || 0) > mine && !updateInfo.blocked;
  // 这台服务器手里没有能发的包（老服务端没有这个字段时 available 为 true，按有包处理）
  updateInfo.noBuild = !!v && v.available === false;
  // 手机上装的比服务器新（连去了一台旧服务器）：不降级，设置里说一声
  updateInfo.appNewer = platform() === 'android' && !!(v && v.server && mine > (v.server.code || 0));
  return v;
}

/**
 * 公网地址 / 地址簿 / 形态 / 后端运行时长（需登录）。顺手把地址信息交给地址簿（lib/server.js），
 * 把「服务器是不是正等着空闲重启 / 装更新」（restart，S1-5）补进 updateInfo.serverRestart（见文件末尾 applyServerRestart）。
 */
export const fetchServerInfo = () => api.get('/api/app/server-info').then((r) => {
  try { if (r && r.address) adoptServerAddress(r.address); } catch {}
  try { applyServerRestart(r); } catch {}
  return r;
});

/**
 * 手机扫码下载 App 的地址（设置「连接与更新」的二维码）：{ lan, pub }。都指向这台服务器自己的 /download/android
 * （S1-4：手机 App 由服务端发）。局域网的快、只在同一个 Wi-Fi 里通；公网的出门也能下。
 */
export function appDownloadUrls(info) {
  const a = (info && info.address) || {};
  const pub = a.publicOrigin || (info && info.publicOrigin) || '';
  const lan = Array.isArray(a.lan) && a.lan[0] ? a.lan[0] : '';
  return { lan: lan ? lan + '/download/android' : '', pub: pub ? pub.replace(/\/+$/, '') + '/download/android' : '' };
}

export async function checkForUpdate() {
  if (desktopUpdates) return desktopUpdates.check();
  const latest = await fetchLatest();
  // 网页：界面就是服务器上这一版，没有可装的东西（nativeVersion() 在网页上是 0，不拦就恒「有新版」）
  if (!A()) return { available: false, current: { code: latest?.code || 0 }, latest };
  return {
    available: Boolean(latest && latest.available !== false && (latest.code || 0) > nativeVersion()) && !updateInfo.blocked,
    current: { code: nativeVersion() },
    latest,
    // 为什么没有可装的：noBuild = 服务器没有包；blocked = 这一版签名和装着的不同（要卸载重装）；appNewer = App 比服务器新
    noBuild: updateInfo.noBuild, blocked: updateInfo.blocked, appNewer: updateInfo.appNewer,
  };
}

export async function startUpdate(latest = {}) {
  if (desktopUpdates) {
    // 下载在主进程持续运行，renderer 立即回到状态轮询；若在这里 await，
    // 设置页会直到整个安装包落完才开始刷新百分比。
    desktopUpdates.download().catch(() => {});
    return null;
  }
  const a = A();
  if (!a) return null;   // 网页：刷新即最新，绝不把带令牌的安装包地址交给浏览器
  if (hasSilentUpdate()) return a.autoFetchUpdate(downloadUrl(), latest.code || 0, latest.sha256 || '');
  if (a.startUpdate) return a.startUpdate(downloadUrl());
  // 很老的安卓壳（没有下载桥）：只能交给 WebView 打开下载地址
  window.open(downloadUrl(), '_blank');
  return null;
}

/** 放弃正在下载 / 已下好的更新包（新壳才有；旧壳返回 false）。 */
export function cancelUpdate() {
  try { if (A()?.cancelUpdate) { A().cancelUpdate(); return true; } } catch {}
  return false;
}

/** 安卓 8+ 装包前要允许「安装未知应用」：打开本 app 的那一页系统设置。 */
export function openInstallPermission() {
  try { if (A()?.openInstallPermission) { A().openInstallPermission(); return true; } } catch {}
  try { if (A()?.openAppDetails) { A().openAppDetails(); return true; } } catch {}
  return false;
}

// —— 自动检查更新（手机设置「关于」、桌面设置「连接与更新」里的开关；默认开）——
const AUTO_KEY = 'bridge-auto-update';
export function autoUpdateEnabled() {
  try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; }
}
export function setAutoUpdateEnabled(on) {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch {}
}

// —— 更新推送（Android 壳）——
// 静默下载本身是无声的：包早就躺在手机里，用户却要哪天逛到设置页才发现「一键更新」。
// 落地即发一条系统通知（点击进 app），每个 versionCode 只推一次（localStorage 记账，
// 免得每次启动都响）。桌面壳有自己的更新 UI，不走这条。
const NOTIFIED_KEY = 'bridge-update-notified';
const notifiedCode = () => { try { return +localStorage.getItem(NOTIFIED_KEY) || 0; } catch { return 0; } };
function pushReadyNotice(latest = {}) {
  const code = latest.code || 0;
  if (!code || code <= nativeVersion() || notifiedCode() >= code) return;
  try {
    A()?.showNotification?.(
      t('The Bridge · 新版本已就绪'),
      t('v{version} 已下载完成 —— 点开 → 设置 → 关于，一键安装', { version: latest.name || code }),
    );
    localStorage.setItem(NOTIFIED_KEY, String(code));
  } catch { /* 没给通知权限 / 旧壳没这个接口：静默跳过 */ }
}
// 下载跑在系统 DownloadManager 里，落地时机不定：探到 ready 就推。
// 有界轮询（3s × 100 ≈ 5 分钟）并在失败/超时收尾——不留无限循环。
// 'none' 要连着三拍才算失败：刚入队时 autoFetchUpdate 还在 UI 线程上排队、
// 状态尚未落到 SharedPreferences，首拍误判会把表停在起跑线上。
function watchUntilReady(latest) {
  let left = 100, gone = 0;
  const timer = setInterval(() => {
    const st = updateState();
    if (st.state === 'ready' && st.code === latest.code) { clearInterval(timer); pushReadyNotice(latest); return; }
    if (st.state === 'failed') { clearInterval(timer); return; }
    gone = st.state === 'none' ? gone + 1 : 0;
    if (--left <= 0 || gone >= 3) clearInterval(timer);   // 超时/失败：下次启动再说
  }, 3000);
}

// boot 时调用：两种本地壳都只在确认新版后静默下载，不阻塞启动；网页版不做。
// 设置里关了「自动检查更新」就什么都不做。
export async function autoCheckUpdate() {
  if (!autoUpdateEnabled()) return;
  try {
    if (desktopUpdates) {
      const checked = await desktopUpdates.check();
      // waiting-idle / handing-off：已下好、正等服务端上的对话跑完 / 正交接去装（S1-5），别再下一遍
      if (checked?.available && !['downloading', 'ready', 'installing', 'waiting-idle', 'handing-off'].includes(updateState().state)) {
        await desktopUpdates.download();
      }
      return;
    }
    if (!isOffline() || !hasSilentUpdate()) return;
    const v = await fetchLatest();
    if (!v || v.available === false || (v.code || 0) <= nativeVersion()) return;
    // 这一版上次因签名不同被拒装：别每次启动都再下一遍十几 MB（设置里写明要卸载重装）
    if (updateInfo.blocked) return;
    const st = updateState();
    // 已在途/已就绪：不重复入队，但仍要把「就绪」推给用户（可能是上次启动下完的，
    // 他根本不知道包已经躺在那儿了）。
    if (st.state !== 'none' && st.state !== 'failed' && st.code === v.code) {
      if (st.state === 'ready') pushReadyNotice(v);
      else if (st.state === 'downloading') watchUntilReady(v);
      return;
    }
    A().autoFetchUpdate(downloadUrl(), v.code, v.sha256 || '');
    watchUntilReady(v);
  } catch { /* 离线/失败静默，下次启动或设置页手动重试 */ }
}

/**
 * 装已下好的更新。桌面壳回 { ok } | { cancelled }（托管着本机服务端、有对话在跑时壳先问，用户点了取消）
 * | { waiting, live }（进入「空闲后自动更新」：updateState().state 变成 'waiting-idle'）。opts.mode='now'：不等了，立即装。
 */
export async function installPending(opts) {
  try {
    if (desktopUpdates) return await desktopUpdates.install(opts);
    if (A()?.installPending) A().installPending();
  } catch { return null; }
  return null;
}

/** 桌面壳：撤掉「等空闲装更新」（服务端那边的空闲重启一并撤）。旧壳没有这个接口。 */
export async function cancelPendingInstall() {
  try { if (desktopUpdates?.cancelWait) return await desktopUpdates.cancelWait(); } catch {}
  return null;
}

/** 等空闲装更新时那一行怎么说（st = 壳的更新状态 { live } 或 installPending 的回包）。 */
export function waitingLine(st) {
  const n = Number(st && st.live) || 0;
  return n ? t('等 {n} 个对话跑完后自动安装', { n }) : t('等服务器空闲后自动安装…');
}

export async function appVersionLine() {
  if (desktopApp?.version) {
    const version = desktopVersion || await desktopApp.version();
    desktopVersion = version;
    return `bridge-client · ${version.version}${version.bridgeCommit ? ` · ${version.bridgeCommit}` : ''}`;
  }
  try {
    const info = await (await fetch(apiUrl('/api/app/version'))).json();
    return t('The Bridge · v{name}（{code}）', { name: info.name, code: nativeVersion() || info.code });
  } catch { return DISTRO.brand; }
}

// —— 服务器要重启 / 装更新（S1-5，见文件头）——
// 事件：{type:'server.restart', phase:'pending'|'going'|'cancelled'|'expired', reason:'restart'|'update', version, current, live, since, deadline}
//   pending   挂起等空闲：提示一次（同一次挂起只提示一次，剩几轮变了不再弹）；
//   going     马上排空退出：提示「正在更新 / 重启，稍后自动重连」，之后 3 秒探一次 /healthz（最多 6 分钟），
//             比离线退避（5s 起 ×1.6、封顶 60s）快得多——装更新要停一两分钟，退避早就拉到半分钟以上了；
//   cancelled / expired：挂起时提示过的话，说一声这次不重启 / 不更新了。
// 回来以后（离线恢复，或总线重连收到 hello）问一次 /api/app/version：版本变了说「已更新到 x」；服务器发的网页（浏览器、
// 连远端的桌面壳）还是旧前端，提示刷新；离线 App 顺手按 S1-4 把同版本的 App 下好（autoCheckUpdate）。
let restartToastKey = '';
let goingFrom = null;       // { current, reason, at, sawDown }：动手前那个进程的版本；sawDown = 之后真断过
let comebackTimer = null;

function restartToast(text, kind) { import('./toast.svelte.js').then((m) => m.showToast(text, kind)).catch(() => {}); }

export function onServerRestartEvent(ev) {
  if (!ev || ev.type !== 'server.restart') return;
  const upd = ev.reason === 'update';
  const n = Number(ev.live) || 0;
  if (ev.phase === 'pending') {
    updateInfo.serverRestart = { phase: 'pending', reason: ev.reason || 'restart', version: ev.version || '', live: n, since: ev.since || 0, deadline: ev.deadline || 0 };
    const key = (ev.reason || '') + ':' + (ev.since || '');
    if (restartToastKey !== key) {
      restartToastKey = key;
      restartToast(upd ? t('服务器有 {n} 个对话在跑，跑完后会自动更新并重启，期间照常用', { n }) : t('服务器有 {n} 个对话在跑，跑完后会自动重启，期间照常用', { n }));
    }
    return;
  }
  if (ev.phase === 'going') {
    updateInfo.serverRestart = { phase: 'going', reason: ev.reason || 'restart', version: ev.version || '', live: 0, at: Date.now() };
    goingFrom = { current: String(ev.current || ''), reason: ev.reason || 'restart', at: Date.now() };
    restartToastKey = '';
    restartToast(upd ? t('服务器正在更新，一两分钟后自动重连') : t('服务器正在重启，几秒后自动重连'));
    watchComeback();
    return;
  }
  if (ev.phase === 'cancelled' || ev.phase === 'expired') {
    updateInfo.serverRestart = null;
    if (restartToastKey) {
      restartToast(ev.phase === 'expired'
        ? (upd ? t('等了 30 分钟一直有对话在跑，服务器这次没有更新') : t('等了 30 分钟一直有对话在跑，服务器这次没有重启'))
        : (upd ? t('服务器取消了这次更新') : t('服务器取消了这次重启')));
    }
    restartToastKey = '';
  }
}

function watchComeback() {
  clearInterval(comebackTimer);
  const t0 = Date.now();
  comebackTimer = setInterval(() => {
    const from = goingFrom;
    if (!from || Date.now() - t0 > 6 * 60_000) {
      // 6 分钟还没回来：交还给离线退避（离线条照旧分原因），这次不再报「已更新」
      clearInterval(comebackTimer); comebackTimer = null; goingFrom = null; updateInfo.serverRestart = null;
      return;
    }
    // 真断过（离线条亮过）又通了才算「回来」；重启快到几拍探活都没撞上断开的，25 秒后也去问一次（onComeback 会核实）
    if (isServerDown()) from.sawDown = true;
    else if (!from.checking && (from.sawDown || Date.now() - from.at > 25_000)) onComeback(true);
    // 探一次当前线路的 /healthz：不通就亮离线条（原因照旧分），通了就恢复——恢复时 onServerRecovered 触发 onComeback
    try { confirmReachability(); } catch {}
  }, 3000);
}

// sure：确知断过又通了（离线恢复 / 上面的轮询）；总线 hello 不带 sure——它在服务端重启后才连得上，只防刚推完 going 的那一下。
// 只有真问到了，才说「回来了 / 已更新」：
//   · 问不到版本（探活那一拍还通、服务端其实刚停）：不报、不收，记作断过，接着等它真回来；
//   · 没确知断过（25 秒兜底 / hello）时再问一下服务端跑了多久：比「动手」以来还久，就还是排空中的旧进程，接着等。
async function onComeback(sure = false) {
  const from = goingFrom;
  if (!from || from.checking || (!sure && Date.now() - from.at < 1500)) return;
  from.checking = true;
  let v = null;
  let fresh = true;
  try {
    try { v = await fetchLatest(); } catch {}
    if (v && !from.sawDown) {
      try {
        const info = await api.get('/api/app/server-info');
        const up = Number(info && info.server && info.server.uptimeSec);
        if (Number.isFinite(up) && up * 1000 > Date.now() - from.at + 2000) fresh = false;
      } catch { /* 没登录 / 老服务端：按版本说 */ }
    }
  } finally { from.checking = false; }
  if (goingFrom !== from) return;
  if (!v) { from.sawDown = true; return; }
  if (!fresh) return;
  goingFrom = null;
  clearInterval(comebackTimer); comebackTimer = null;
  updateInfo.serverRestart = null;
  const now = v.server && v.server.name ? String(v.server.name) : '';
  if (now && from.current && now !== from.current) {
    restartToast(isOffline() ? t('服务器已更新到 v{v}', { v: now }) : t('服务器已更新到 v{v}，刷新页面就能用上新版', { v: now }));
    if (platform() === 'android') autoCheckUpdate();
  } else restartToast(t('服务器已经回来了'));
}

// server-info 里的 restart（与总线 server.restart 同一口径，S1-5）：等待期间才打开 App、或推送那一刻总线断着的设备，
// 靠它补上「服务器正等着更新 / 正在更新」。fetchServerInfo 每次都过一遍；总线连上（hello）时也补拉一次（30 秒内只拉一次）。
function applyServerRestart(r) {
  if (!r || typeof r !== 'object' || !('restart' in r)) return;   // 老服务端没有这个字段
  const rs = r.restart;
  if (rs && (rs.phase === 'pending' || rs.phase === 'going')) {
    if (rs.phase === 'going' && goingFrom) return;   // 已经在等它回来了
    onServerRestartEvent({ type: 'server.restart', ...rs, current: (r.server && r.server.version) || '' });
  } else if (updateInfo.serverRestart && updateInfo.serverRestart.phase === 'pending') {
    // 漏了取消 / 放弃那条推送（当时总线断着）：悄悄收掉，不补弹
    updateInfo.serverRestart = null;
    restartToastKey = '';
  }
}
let restartInfoAt = 0;
function refreshServerRestart() {
  if (Date.now() - restartInfoAt < 30_000) return;
  restartInfoAt = Date.now();
  fetchServerInfo().catch(() => {});
}

busOn((ev) => {
  if (!ev) return;
  if (ev.type === 'server.restart') onServerRestartEvent(ev);
  // 总线（重）连上收到的第一条就是 hello：在等服务器回来就核实一下；否则看它是不是正等着重启 / 装更新——
  // 新服务端的 hello 自带 restart（与 server-info 同一口径），老服务端没有这个字段才补拉一次 server-info
  else if (ev.type === 'hello') {
    if (goingFrom) onComeback();
    else if ('restart' in ev) { try { applyServerRestart({ restart: ev.restart, server: { version: ev.serverVersion || '' } }); } catch {} }
    else refreshServerRestart();
  }
});
onServerRecovered(() => { if (goingFrom) onComeback(true); });
