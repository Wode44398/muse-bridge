// 上次看到的样子：设置页、模型中心、账户卡这类小块界面数据，每次拉到就记一份，下次（含 App 冷启动）
// 模块一求值就同步读回来先画，网络回来再原地换掉。
// 没有它，冷开的第一帧只能画「还不知道」，数据一到整列往下推、文字改写——切页时的接缝大多是这个。
//
// 按服务器档案 + 本机账号分开存（同 lib/cache.js 的分库）；读的时候再核一次是不是同一个人：
// 第一个号沿用无标签的库名，退出后换成员登录也落在同一个库里，不核身份会先画出上一个人的管理员数据。
// 只放小数据（单条上限 MAX）；大块正文走 IndexedDB（lib/cache.js）。localStorage 在国产 ROM 杀进程后偶尔会丢，
// 丢了只是退回「等网络」，不影响正确性，所以不走 AndroidStore 双写（那边是给登录态这种必须在的东西用的）。
import { cacheNamespace } from './serverProfiles.js';
import { bootCacheTag } from './accountVault.js';
import { storeGet } from './store.js';

const NS = (() => { try { return [cacheNamespace(), bootCacheTag()].filter(Boolean).join('~'); } catch { return ''; } })();
// 前缀里的 1 是快照格式的版本：哪天存的形状改了就加一，老快照自然作废，不会拿旧形状去渲染新代码
const PREFIX = 'bridge-lk1' + (NS ? '@' + NS : '') + ':';
const MAX = 256 * 1024;

// 当前身份：直接读 state.svelte.js 写的那份登录态快照（applyMe 同步写），不 import state 以免成环
function who() {
  try {
    const m = JSON.parse(storeGet('bridge-me') || 'null');
    return m && m.kind && m.kind !== 'none' ? m.kind + ':' + (m.uid || m.user || '') : '';
  } catch { return ''; }
}

/** 读上次记下的值；没有、坏了、换了人都回 undefined。 */
export function recall(key) {
  try {
    const s = localStorage.getItem(PREFIX + key);
    if (!s) return undefined;
    const rec = JSON.parse(s);
    if (!rec || rec.who !== who()) return undefined;
    return rec.v;
  } catch { return undefined; }
}

const pending = new Map();
const written = new Map();   // key → 上次写进去的串：没变就不再写（每次重拉都调 remember）
let timer = 0;
function flush() {
  clearTimeout(timer); timer = 0;
  try { if (window.__bridgeStoreFrozen) { pending.clear(); return; } } catch {}
  const w = who();
  for (const [key, v] of pending) {
    let s;
    try { s = JSON.stringify({ who: w, v }); } catch { continue; }
    if (!w || s.length > MAX || written.get(key) === s) continue;
    try { localStorage.setItem(PREFIX + key, s); written.set(key, s); } catch {}
  }
  pending.clear();
}
/** 记下这一份（攒一会儿一起写；页面藏起来时立刻写）。传 $state 代理也行：写时才序列化，拿到的是那一刻的值。 */
export function remember(key, value) {
  pending.set(key, value);
  if (!timer) timer = setTimeout(flush, 400);
}
/** 这份数据作废了（没权限了、换了服务器）：下次冷开别再先画它。 */
export function forget(key) {
  pending.delete(key); written.delete(key);
  try { localStorage.removeItem(PREFIX + key); } catch {}
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pending.size) flush(); });
  addEventListener('pagehide', () => { if (pending.size) flush(); });
}
