// 聊天卡片用的媒体小工具：时长格式化 + 只读元数据的时长探测。
//
// 探测用一个不挂进文档的 <video>/<audio>（preload=metadata，只拉文件头那一小段），读到时长立刻
// 拆掉 src 释放连接；超时 / 出错都静默返回 0（卡片就不显示时长，不影响点开播放）。
// 同一地址的结果按 key 记在内存里，滚动回来、重渲染都不再发请求；同时在探的请求合并成一个。

const CACHE = new Map();   // key -> 秒（0 = 探过但没拿到）
const PENDING = new Map(); // key -> Promise<number>

/** 秒 → m:ss / h:mm:ss（与查看器 AudioPlayer 的格式一致） */
export function fmtDuration(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}

export function knownDuration(key) {
  return CACHE.get(key) || 0;
}

/** 记一个已知时长（比如迷你播放器真正加载完拿到的），之后的卡片直接用 */
export function rememberDuration(key, sec) {
  if (key && isFinite(sec) && sec > 0) CACHE.set(key, sec);
}

/**
 * 探时长。kind：'video' | 'audio'。返回秒（拿不到为 0）。
 * 流式 WAV 在部分 WebView 上报 Infinity：这里不去逼真时长（要多拉数据），直接当拿不到。
 */
export function probeDuration(key, url, kind = 'video', timeoutMs = 8000) {
  if (!key || !url) return Promise.resolve(0);
  if (CACHE.has(key)) return Promise.resolve(CACHE.get(key));
  if (PENDING.has(key)) return PENDING.get(key);
  const p = new Promise((resolve) => {
    let el = null, timer = 0, done = false;
    const finish = (sec) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { el.removeAttribute('src'); el.load(); } catch {}
      el = null;
      const v = isFinite(sec) && sec > 0 ? sec : 0;
      CACHE.set(key, v);
      PENDING.delete(key);
      resolve(v);
    };
    try {
      el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      el.muted = true;
      el.setAttribute('playsinline', '');
      el.dataset.noheal = '';
      el.onloadedmetadata = () => finish(el?.duration);
      el.onerror = () => finish(0);
      timer = setTimeout(() => finish(0), timeoutMs);
      el.src = url;
    } catch {
      finish(0);
    }
  });
  PENDING.set(key, p);
  return p;
}

/** 元素进入视口（含上下 300px 预读）才执行一次 fn；返回清理函数 */
export function whenVisible(el, fn) {
  if (!el) return () => {};
  if (typeof IntersectionObserver !== 'function') { fn(); return () => {}; }
  const io = new IntersectionObserver((ents) => {
    if (ents.some((e) => e.isIntersecting)) { io.disconnect(); fn(); }
  }, { rootMargin: '300px 0px' });
  io.observe(el);
  return () => io.disconnect();
}
