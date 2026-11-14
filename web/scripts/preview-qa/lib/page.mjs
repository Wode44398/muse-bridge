// 页面里的小工具（window.__pvqa），由 run.mjs 在新文档最早期注入。场景只调这些，不直接摸查看器的内部细节。
// 查看器根元素：ROOT_SEL 依次认 [data-pv-root]（新外框 ViewerShell 请挂这个属性）和现有的 .mv-root。
// 坑：eval 里 import 的路径必须和应用里一字不差（/src/lib/preview.svelte.js），否则会另起一个模块实例。
export const ROOT_SEL = '[data-pv-root], .mv-root';

export const PVQA_SRC = String.raw`
window.__pvqa = {
  ROOT_SEL: ${JSON.stringify(ROOT_SEL)},
  async init() {
    this.pv = await import('/src/lib/preview.svelte.js');
    return true;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  raf: () => new Promise((r) => requestAnimationFrame(() => r(performance.now()))),
  async until(fn, ms = 8000, what = '') {
    const t0 = Date.now();
    for (;;) { let v; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('等不到：' + (what || String(fn).slice(0, 80))); await this.sleep(50); }
  },
  root() { const els = [...document.querySelectorAll(this.ROOT_SEL)]; return els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null; },
  abs(u) { try { return u ? new URL(u, location.href).href : ''; } catch { return ''; } },
  // 元素实际不透明度：自己和祖先 opacity 连乘；display:none / visibility:hidden 记 0
  effOpacity(el) {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return 0;
      o *= parseFloat(s.opacity || '1');
      if (o < 0.001) return 0;
    }
    return o;
  },
  isBlur(el) { const f = getComputedStyle(el).filter || ''; return /blur\(/.test(f) || /blur/.test(el.className || ''); },
  // 视口中心（或指定点）上「画出来了」的图片 / 视频 / 画布：不透明度 > 0.05、矩形包含该点
  paintedAt(x = innerWidth / 2, y = innerHeight / 2) {
    const root = this.root(); if (!root) return [];
    const out = [];
    for (const el of root.querySelectorAll('img, video, canvas')) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 1 && r.height > 1 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) continue;
      const op = this.effOpacity(el);
      if (op <= 0.05) continue;
      const ready = el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0 : el.tagName === 'VIDEO' ? el.readyState >= 2 : el.width > 0;
      out.push({ el, tag: el.tagName.toLowerCase(), src: el.currentSrc || el.src || '', op, ready, blur: this.isBlur(el) });
    }
    return out;
  },
  // 当前主图：根里可见面积最大、不是模糊底的 <img>
  mainImg() {
    const root = this.root(); if (!root) return null;
    let best = null, area = 0;
    for (const el of root.querySelectorAll('img')) {
      if (this.isBlur(el)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > area) { area = w * h; best = el; }
    }
    return best;
  },
  itemUrls(i) {
    const it = this.pv.preview.items[i]; if (!it) return [];
    return [it.dataUrl, it.previewUrl, it.url, it.maxUrl].filter(Boolean).map((u) => this.abs(u));   // maxUrl：放大 / HiDPI 适应时的高清叠层
  },
  // 第 i 个条目的图片是否已在视口中心完整画出（src 属于该条目、解码完成、不透明度 ≥ 0.99）
  itemPainted(i) {
    const urls = this.itemUrls(i);
    return this.paintedAt().some((p) => p.tag === 'img' && !p.blur && p.ready && p.op >= 0.99 && urls.includes(this.abs(p.src)));
  },
  imgState() {
    const el = this.mainImg(); if (!el) return null;
    const r = el.getBoundingClientRect(); const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
    return { src: el.currentSrc || el.src, nw: el.naturalWidth, nh: el.naturalHeight, complete: el.complete, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      transform: getComputedStyle(el).transform, scale: Math.hypot(m.a, m.b), tx: m.e, ty: m.f, vv: window.visualViewport ? visualViewport.scale : 1, index: this.pv.preview.index,
      // 与实现无关的口径（改版后 transform 可能挂在外层包裹上）：显示宽 / 布局宽 = 自己与祖先 transform 的总缩放；cx/cy = 显示矩形中心
      effScale: el.offsetWidth ? +(r.width / el.offsetWidth).toFixed(4) : 1, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  },
  // —— 侧滑计时 ——
  // armSwipe(target)：先挂好 touchend / pointerup 监听和逐帧采样，再由 Node 侧发手势；swipeResult() 取结果。
  // 指标：indexMs = 抬手到 preview.index 变成目标；decodedMs = 抬手到目标图（不论透明度）已解码挂在 DOM 上；readyMs = 抬手到目标图在中心完整画出（再加一帧）；
  //       blankFrames = 抬手后、出图前，视口中心什么都没画出来（没有不透明的图 / 视频 / 画布）的帧数；
  //       blurOnlyFrames = 中心只有模糊底的帧数；longFrames = 期间 long-animation-frame（>50ms）个数与最长时长；resources = 期间拉了哪些图。
  armSwipe(target, { timeout = 8000 } = {}) {
    const st = this._sw = { target, tEnd: 0, frames: 0, blank: 0, blurOnly: 0, tIndex: 0, tDecoded: 0, tReady: 0, laf: [], res: [], done: null, err: '' };
    const onEnd = (e) => { if (!st.tEnd) st.tEnd = e.timeStamp || performance.now(); };
    addEventListener('touchend', onEnd, { capture: true });
    addEventListener('pointerup', onEnd, { capture: true });
    let po1 = null, po2 = null;
    try { po1 = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (st.tEnd && e.startTime >= st.tEnd - 5) st.laf.push(Math.round(e.duration)); }); po1.observe({ type: 'long-animation-frame', buffered: false }); } catch {}
    try { po2 = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (st.tEnd && e.startTime >= st.tEnd - 400 && /^(img|other|fetch|xmlhttprequest)$/.test(e.initiatorType)) st.res.push({ url: e.name.replace(location.origin, '').slice(0, 160), ms: Math.round(e.duration), start: Math.round(e.startTime - st.tEnd), bytes: e.transferSize || e.encodedBodySize || 0 }); }); po2.observe({ type: 'resource', buffered: false }); } catch {}
    const t0 = performance.now();
    st.done = new Promise((resolve) => {
      const tick = (now) => {
        if (st.tEnd) {
          st.frames++;
          if (!st.tIndex && this.pv.preview.index === target) st.tIndex = now;
          const painted = this.paintedAt();
          if (!painted.length) st.blank++;
          else if (painted.every((p) => p.blur)) st.blurOnly++;
          if (!st.tDecoded) { const urls = this.itemUrls(target); const r = this.root(); if (r && [...r.querySelectorAll('img')].some((im) => im.complete && im.naturalWidth > 0 && !this.isBlur(im) && urls.includes(this.abs(im.currentSrc || im.src)))) st.tDecoded = now; }
          if (!st.tReady && this.itemPainted(target)) st.tReady = now;
        }
        if (st.tReady || now - t0 > timeout) {
          // 出图后再等一帧，算上合成
          requestAnimationFrame((n2) => {
            removeEventListener('touchend', onEnd, { capture: true }); removeEventListener('pointerup', onEnd, { capture: true });
            setTimeout(() => { try { po1 && po1.disconnect(); po2 && po2.disconnect(); } catch {}
              resolve({ target, index: this.pv.preview.index, readyMs: st.tReady ? Math.round(n2 - st.tEnd) : null, indexMs: st.tIndex ? Math.round(st.tIndex - st.tEnd) : null, decodedMs: st.tDecoded ? Math.round(st.tDecoded - st.tEnd) : null,
                frames: st.frames, blankFrames: st.blank, blurOnlyFrames: st.blurOnly, longFrames: st.laf.length, longestFrame: st.laf.length ? Math.max(...st.laf) : 0,
                resources: st.res.slice(0, 12), gotTouchEnd: !!st.tEnd }); }, 60);
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return true;
  },
  swipeResult() { return this._sw ? this._sw.done : null; },
  // 等主线程安静：连续 quietMs 内没有 long-animation-frame（>50ms）才返回，最多等 maxMs。
  // 测时序指标（侧滑、seek）前先调：刚重启页面时 vite 冷模块、后台拉取会在第一划里插进几秒的长帧，污染「最差值」。
  async quiet(quietMs = 1000, maxMs = 10000) {
    let last = performance.now(); const t0 = last; let n = 0;
    let po = null;
    try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { last = Math.max(last, e.startTime + e.duration); n++; } }); po.observe({ type: 'long-animation-frame', buffered: false }); } catch { return { waited: 0, longFrames: 0, unsupported: true }; }
    while (performance.now() - last < quietMs && performance.now() - t0 < maxMs) await this.sleep(100);
    po.disconnect();
    return { waited: Math.round(performance.now() - t0), longFrames: n, timedOut: performance.now() - last < quietMs };
  },
  // 触屏点按区小于 min（新规范 44）的可点控件：只看查看器根里的
  smallTargets(min = 44) {
    const root = this.root(); if (!root) return [];
    const out = [];
    for (const el of root.querySelectorAll('button, [role=button], a[href], input, select, [tabindex]:not([tabindex="-1"])')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || this.effOpacity(el) < 0.05) continue;
      let w = r.width, h = r.height;
      for (const pe of ['::before', '::after']) { const s = getComputedStyle(el, pe); if (s.content && s.content !== 'none' && s.position === 'absolute') { const iw = parseFloat(s.width) || 0, ih = parseFloat(s.height) || 0; w = Math.max(w, iw); h = Math.max(h, ih); } }
      if (w < min || h < min) out.push({ sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/).filter((c) => !/^svelte-/.test(c)).slice(0, 2).join('.') : ''), label: el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 20), w: Math.round(w), h: Math.round(h) });
    }
    return out;
  },
  canvasDrawn(cv) {
    try {
      const w = Math.min(64, cv.width), h = Math.min(64, cv.height); if (!w || !h) return false;
      const d = cv.getContext('2d').getImageData(Math.floor((cv.width - w) / 2), Math.floor((cv.height - h) / 3), w, h).data;
      let mn = 255, mx = 0; for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; if (v < mn) mn = v; if (v > mx) mx = v; }
      return mx - mn > 30 || (d[3] > 0 && mx < 760);   // 有对比，或画了不全白的东西
    } catch { return true; }   // 被污染的画布读不了：算画了
  },
};
`;
