// 构建漂移自愈：前端重新构建/部署后，旧页面里 vite 懒加载的 chunk（内容 hash 文件名）
// 已被替换，动态 import 报「Failed to fetch dynamically imported module」——预览器/编辑器
// 等一切懒加载功能看起来就是「坏了」。vite 在这类失败时向 window 派发 'vite:preloadError'，
// 收到就整页刷新一次拿新构建。60s 防循环：刚刷过还失败＝不是版本漂移（网络/服务端问题），
// 放行错误交还组件级错误 UI。构建侧同时保留旧资产（vite.config keepOldAssets），双保险。
const KEY = 'bridge-stale-reload';

function recentlyReloaded() {
  try { return Date.now() - (Number(sessionStorage.getItem(KEY)) || 0) < 60_000; } catch { return false; }
}

let reloading = false;
/** 已经为构建漂移发起了整页刷新、页面正在离开（调用方别再弹系统框之类会被刷新带走的东西）。 */
export function reloadPending() { return reloading; }

export function reloadForNewBuild() {
  if (recentlyReloaded()) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch {}
  reloading = true;
  location.reload();
  return true;
}

// 推测加载（空闲预取这类用户没要的加载）的静默模式：失败不刷新、不吞错，错误原样交回调用方的 catch。
// 为什么要分：预取都在页面刚加载的头几秒跑，这时页面就是当前构建，失败不可能是构建漂移，只会是网络抖动 /
// 服务端正在重启——这时无操作整页刷新只会落到浏览器错误页，还丢掉没落盘的草稿。
// 计数要等加载真正结算才减：import() 没法取消，提前减掉的话它晚些失败照样会触发刷新。
// 代价：静默期间别处的懒加载失败也不自动刷新（错误交回它们自己的错误态）；预取只在刚加载时跑一次，窗口很短。
let quiet = 0;
export async function quietPreload(load) {
  quiet += 1;
  try { return await load(); } finally { quiet -= 1; }
}

// 组件 catch 块兜底（vite:preloadError 覆盖不到的手写 import() 失败路径）：
// 是 stale-chunk 形状的错误就地刷新自愈，返回 true=已接管（调用方别再画错误态）。
const STALE_RE = /dynamically imported module|Importing a module script failed|error loading dynamically imported/i;
export function recoverStaleChunk(err) {
  if (!STALE_RE.test(String(err?.message || err || ''))) return false;
  return reloadForNewBuild();
}

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (quiet > 0) return;   // 推测加载：不刷新、不吞错（见 quietPreload）
    if (reloadForNewBuild()) event.preventDefault();   // 吞掉错误：马上刷新，别闪错误态
  });
}
