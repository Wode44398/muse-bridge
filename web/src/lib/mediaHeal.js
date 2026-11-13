// 媒体元素加载失败的全局自愈：页面上任何 <img> / <video> / <audio> / <source> 出错，都在这里统一兜底。
//
// 为什么要全局：裂图修了一轮又一轮（09 Vertex 网格、10-20 聊天媒体、11-04 状态行缩略图、11-07 dimensio
// 截图卡、11-08 md 插图、11-08 输入栏草稿图……），病根就那几样——在家走局域网 <img> 到不了服务端、
// 地址里的 ?token= 过期 / 换号、服务端缩略图第一次生成慢、本地 blob: 预览被回收——但每次都是某个
// 新写的 <img> 忘了挂 onerror。改成在 document 上捕获 error 事件（资源错误不冒泡，捕获阶段能收到），
// 以后新写的媒体元素什么都不用挂，自动享受同一套降级。
//
// 与元素自己的 onerror 不冲突：捕获到后先让一拍（setTimeout 0），元素自己的处理器（ChatMediaImage、
// attImgFallback、mediaImgFallback……）已经改了 src 就不插手，只接没人管的。
// 不想被接管的元素加 data-noheal。
//
// 降级顺序（每个元素最多 3 次，试过的地址记账防 LAN↔隧道乒乓）：
//   ① 本地 blob:/data: 失败 → 元素给了 data-fallback 就换它（例：输入栏草稿图的服务端缩略图）
//   ② 局域网地址 → 隧道 / 同源（mediaFallbackUrl，同时记下这台设备媒体别走 LAN）
//   ③ 地址里带的 token 不是当前 token → 换成当前的
//   ④ 都不是：隔 1.2s 带 _heal 参数原样重试一次（缩略图首次生成、隧道抖动）
import { serverBook, mediaFallbackUrl } from './server.js';
import { getToken } from './api.js';

const TAGS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE']);
const MAX = 3;
const RETRY_MS = 1200;
const seen = new WeakMap();   // el → { mine: Set<string>（我们设过的地址）, tried: Set<string>, n }

function isOurs(u) {
  let p;
  try { p = new URL(u, location.href); } catch { return false; }
  if (!p.pathname.startsWith('/api/')) return false;
  const { base, lanBase } = serverBook();
  const o = p.origin;
  const originOf = (b) => { try { return new URL(b).origin; } catch { return ''; } };
  return o === location.origin || (base && o === originOf(base)) || (lanBase && o === originOf(lanBase));
}

function nextUrl(el, u, st) {
  if (/^(blob|data):/.test(u)) {
    const fb = el.dataset && el.dataset.fallback;
    return fb && !st.tried.has(fb) ? { url: fb } : null;
  }
  if (!isOurs(u)) return null;
  const lan = mediaFallbackUrl(u);
  if (lan !== u && !st.tried.has(lan)) return { url: lan };
  try {
    const p = new URL(u, location.href);
    const tok = getToken();
    if (tok && p.searchParams.has('token') && p.searchParams.get('token') !== tok) {
      p.searchParams.set('token', tok);
      if (!st.tried.has(p.href)) return { url: p.href };
    }
    if (!p.searchParams.has('_heal')) {
      p.searchParams.set('_heal', '1');
      if (!st.tried.has(p.href)) return { url: p.href, delay: RETRY_MS };
    }
  } catch {}
  return null;
}

function heal(el, failing) {
  if (!el.isConnected || (el.dataset && 'noheal' in el.dataset)) return;
  if (el.src !== failing) return;   // 元素自己的 onerror 已经换过地址了
  let st = seen.get(el);
  // 不是我们设的地址（组件重新绑了新 src）：重新起算
  if (!st || !st.mine.has(failing)) { st = { mine: new Set(), tried: new Set(), n: 0 }; seen.set(el, st); }
  st.tried.add(failing);
  if (st.n >= MAX) return;
  const nx = nextUrl(el, failing, st);
  if (!nx) return;
  st.n++;
  st.tried.add(nx.url); st.mine.add(nx.url);
  const apply = () => {
    if (!el.isConnected || el.src !== failing) return;
    el.src = nx.url;
    if (el.tagName === 'SOURCE' && el.parentElement && typeof el.parentElement.load === 'function') el.parentElement.load();
  };
  if (nx.delay) setTimeout(apply, nx.delay); else apply();
}

let installed = false;
export function installMediaHeal() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || !TAGS.has(el.tagName)) return;
    const failing = el.src;
    if (!failing) return;
    setTimeout(() => heal(el, failing), 0);
  }, true);
}

installMediaHeal();
