// Studio 里所有媒体元素（<img> / <audio> / <video>）共用的加载自愈：use:heal={{ src, onstate }}。
// 失败时依次：① 这条是局域网地址就换成隧道 / 同源地址（并记下这台设备媒体走不了 LAN，见 lib/server.js mediaUrl）
// → ② 1.2 秒后带随机参数再试一次（缓存里的失败、服务端临时现做衍生图）→ ③ 失败态（onstate('failed')，组件显示「重新加载」）。
// 成功 onstate('ok')。src 变了（换了一件作品）从头来；retryMedia(node) 供「重新加载」按钮调用。
import { mediaFallbackUrl } from '../../lib/server.js';

const bust = (u) => { if (!u || /^(data|blob):/.test(u)) return u; const s = String(u).replace(/([?&])r=\d+&?/, '$1').replace(/[?&]$/, ''); return s + (s.includes('?') ? '&' : '?') + 'r=' + Date.now(); };
const isMedia = (n) => n.tagName === 'AUDIO' || n.tagName === 'VIDEO';

export function heal(node, opts = {}) {
  let o = opts || {};
  let src = o.src || node.getAttribute('src') || '';
  let step = 0, timer = 0;
  const set = (s) => { node.dataset.media = s; try { o.onstate?.(s); } catch {} };
  const swap = (u) => { node.src = u; if (isMedia(node)) { try { node.load(); } catch {} } };
  function onError() {
    const cur = node.currentSrc || node.getAttribute('src') || src;
    if (!cur || /^(data|blob):/.test(cur)) { set('failed'); return; }
    if (step === 0) {
      step = 1;
      const next = mediaFallbackUrl(cur);
      if (next !== cur) { set('retrying'); swap(next); return; }
    }
    if (step === 1) {
      step = 2;
      set('retrying');
      clearTimeout(timer);
      timer = setTimeout(() => swap(bust(mediaFallbackUrl(node.currentSrc || node.getAttribute('src') || src))), 1200);
      return;
    }
    set('failed');
  }
  const onOk = () => { step = 0; set('ok'); };
  node.addEventListener('error', onError);
  node.addEventListener(isMedia(node) ? 'loadedmetadata' : 'load', onOk);
  // 已经加载完 / 已经失败才挂上（缓存命中）：补一次状态
  if (node.tagName === 'IMG' && node.complete && node.getAttribute('src')) { if (node.naturalWidth > 0) onOk(); else onError(); }
  node.__healRetry = () => { clearTimeout(timer); step = 0; set('retrying'); swap(bust(mediaFallbackUrl(node.currentSrc || node.getAttribute('src') || src))); };
  return {
    update(n) {
      o = n || {};
      const ns = o.src || node.getAttribute('src') || '';
      if (ns !== src) { src = ns; step = 0; clearTimeout(timer); delete node.dataset.media; }
    },
    destroy() {
      clearTimeout(timer);
      node.removeEventListener('error', onError);
      node.removeEventListener(isMedia(node) ? 'loadedmetadata' : 'load', onOk);
      delete node.__healRetry;
    },
  };
}

/** 「重新加载」：从头再走一遍（局域网地址先换成隧道） */
export function retryMedia(node) { node?.__healRetry?.(); }
