// 主窗口焦点 / 可见性 → 常驻动画的帧率档（T8）。桌面主页的流体壁纸、GL 玻璃场景开着就一直在画，
// 窗口失焦挂在后台、最小化或藏进托盘时照样满帧跑 GPU。壳（client main.cjs）经
// BridgeDesktop.window.attention() / onAttention(fn) 报 { focused, visible }：
//   'full'  有焦点且可见：全帧率
//   'low'   可见但失焦超过 5 秒：≤20fps
//   'off'   不可见（最小化 / 藏进托盘）超过 5 秒：GL 玻璃停画，流体壁纸帧间隔拉到 1 秒
// 只有降档延后 5 秒；升档当场生效（回到焦点即全帧率，off 时重新可见但没焦点即刻回 low）。没有这个接口（网页 / 安卓 / 老壳 / 拖出去的对话窗）恒为 'full'，保持原样。
const W = typeof window !== 'undefined' ? window.BridgeDesktop?.window : null;
const OK = typeof W?.attention === 'function' && typeof W?.onAttention === 'function';
const DELAY_MS = 5000;
export const LOW_FRAME_MS = 50;   // 'low' 档的最小帧间隔（20fps）

let level = 'full', timer = 0, started = false;
const subs = new Set();
const RANK = { off: 0, low: 1, full: 2 };

function set(next) {
  if (next === level) return;
  level = next;
  for (const fn of subs) { try { fn(level); } catch { /* 订阅方自己的错 */ } }
}
// 只延后「降档」；「升档」当场生效——最小化 5 秒以上后被不抢焦点地还原（visible 但没焦点），
// 要立刻从 'off' 回到 'low'，不能让看得见的窗口再定格 5 秒。
function apply(a) {
  if (!a || typeof a !== 'object') return;
  const focused = a.focused !== false, visible = a.visible !== false;
  clearTimeout(timer); timer = 0;
  const next = focused && visible ? 'full' : visible ? 'low' : 'off';
  if (RANK[next] >= RANK[level]) { set(next); return; }
  timer = setTimeout(() => { timer = 0; set(next); }, DELAY_MS);
}
function start() {
  if (started || !OK) return;
  started = true;
  try { W.onAttention(apply); } catch { /* 老壳半残：按全速 */ }
  try { Promise.resolve(W.attention()).then(apply, () => {}); } catch { /* 同上 */ }
}

/** 当前档位：'full' | 'low' | 'off'。帧循环里每帧问一次即可（不发 IPC，只读本地状态）。 */
export function frameLevel() { start(); return level; }
/** 档位变化时回调 fn(level)；返回取消订阅。 */
export function onFrameLevel(fn) {
  start();
  subs.add(fn);
  return () => subs.delete(fn);
}
