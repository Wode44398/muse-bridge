// 构建漂移自愈：前端重新构建/部署后，旧页面里 vite 懒加载的 chunk（内容 hash 文件名）
// 已被替换，动态 import 报「Failed to fetch dynamically imported module」——预览器/编辑器
// 等一切懒加载功能看起来就是「坏了」。vite 在这类失败时向 window 派发 'vite:preloadError'，
// 收到就整页刷新一次拿新构建。60s 防循环：刚刷过还失败＝不是版本漂移（网络/服务端问题），
// 放行错误交还组件级错误 UI。构建侧同时保留旧资产（vite.config keepOldAssets），双保险。
const KEY = 'bridge-stale-reload';

function recentlyReloaded() {
  try { return Date.now() - (Number(sessionStorage.getItem(KEY)) || 0) < 60_000; } catch { return false; }
}

export function reloadForNewBuild() {
  if (recentlyReloaded()) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch {}
  location.reload();
  return true;
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
    if (reloadForNewBuild()) event.preventDefault();   // 吞掉错误：马上刷新，别闪错误态
  });
}
