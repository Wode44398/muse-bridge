/* liquid-glass — iOS 26 风「透光折射玻璃」，封装为 Svelte action。
   算法 1:1 搬自 bridge前端设计/liquid glass-图标/liquid-glass.js（已验证可用）：
     1) canvas 按元素尺寸生成凸透镜法线图（中心平、边缘斜面把背景掰弯）
     2) SVG feImage → feDisplacementMap 对【背后 DOM】做像素级折射位移
     3) R/G/B 三通道用略不同强度分别位移再合并 → 边缘色散彩边
   折射的是元素背后的任何内容（壁纸/页面），不需要配图。
   用法：
     import { liquidGlass, presets } from '../lib/liquidGlass.js';
     <div use:liquidGlass={{ ...presets.dispersion, radius: 30 }}>…</div>
   放在玻璃上的内容（图标/文字）加 class="lg-content" 浮在镜面高光之上。
   选项 bare:true → 纯折射（去边光/高光/底色，见 app.css .lg-bare）；动画改 scale/aberration
   只轻量改三通道 scale 属性（不重写整段 filter），可做「折射从 0 鼓到预设」的入场。 */

const SVG_NS = 'http://www.w3.org/2000/svg';
let _uid = 0;

/* —— 生成凸透镜法线位移图，返回 dataURL —— */
function buildDisplacementMap(w, h, radius, bevel, ssOpt) {
  // 超采样倍率＝位移场分辨率，由画质档驱动（原画3 / 极高1.5 / 平衡1）；未指定时按 DPR 自适应。
  const ss = Math.min(3, Math.max(0.5, ssOpt || Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))));
  radius *= ss; bevel *= ss;
  w = Math.max(1, Math.round(w * ss)); h = Math.max(1, Math.round(h * ss));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(w, h);
  const H = new Float32Array(w * h);
  const hw = w / 2, hh = h / 2;
  const r = Math.min(radius, hw, hh);

  // 高度场：圆角矩形内部=1（平），边缘 bevel 宽度内 0→1 渐升。
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + 0.5 - hw, py = y + 0.5 - hh;
    const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    const inside = Math.min(Math.max(qx, qy), 0);
    const sd = outside + inside - r;          // 负 = 内部
    let t = (-sd) / bevel; t = t < 0 ? 0 : t > 1 ? 1 : t;
    // 抛物线剖面：折射最强在最边缘、中心平整（干净凸面镜）。
    H[y * w + x] = t * (2 - t);
  }

  // 盒式模糊高度场——消除位移贴图的台阶条纹。
  const blur = (passes, rad) => {
    for (let p = 0; p < passes; p++) {
      let src = H.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; s += src[y * w + xx]; n++; }
        H[y * w + x] = s / n;
      }
      src = H.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; s += src[yy * w + x]; n++; }
        H[y * w + x] = s / n;
      }
    }
  };
  blur(4, 4 * ss);

  // 高度梯度 → 法线 → RG 通道（128 = 不位移）。超采样后梯度变小，gain 同比放大。
  const gain = 255 * 2.0 * ss;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
    const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
    const nx = H[y * w + xp] - H[y * w + xm];
    const ny = H[yp * w + x] - H[ym * w + x];
    const i = (y * w + x) * 4;
    id.data[i]     = Math.max(0, Math.min(255, 128 + nx * gain));
    id.data[i + 1] = Math.max(0, Math.min(255, 128 + ny * gain));
    id.data[i + 2] = 128;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return cv.toDataURL();
}

/* —— 全局 <defs> 容器，所有实例的 filter 都挂这里 —— */
function ensureDefs() {
  let svg = document.getElementById('lg-defs');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'lg-defs');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);
    (document.body || document.documentElement).appendChild(svg);
  }
  return svg.firstChild;
}

export const presets = {
  clear:      { scale: 60, aberration: 0,  tint: 0.04  },  // 清透折射，无色散
  dispersion: { scale: 64, aberration: 16, tint: 0.015 },  // 更透光 + 色散彩边
  frosted:    { blur: 22, saturate: 1.8, tint: 0.12 },     // 毛玻璃（背景模糊，非折射）
};

/* —— Svelte action：把一个元素变成透光折射玻璃 —— */
// Safari/iOS（WebKit）不支持 backdrop-filter 引用 SVG 滤镜——折射/色散做不了。检测到就退回
// 毛玻璃（blur，WebKit 支持），至少保留玻璃质感而非裸方块。Chrome/Edge 仍走真折射。
// iOS 按设备认：iPhone/iPad 上的 Chrome（CriOS）、Edge（EdgiOS）也是 WebKit 内核，
// 旧写法看到 UA 里的 Chrome/Edg 就当电脑，结果挂上 SVG 滤镜、玻璃整个没了。
// iPadOS 桌面模式 UA 冒充 Mac，靠触点数认出来（真 Mac 是 0）。
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const IS_IOS = /iPhone|iPad|iPod/.test(UA)
  || (/Macintosh/.test(UA) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
export const NO_SVG_BACKDROP = IS_IOS
  || (/AppleWebKit/.test(UA) && !/Chrome|Chromium|Edg|OPR|Android/.test(UA));

export function liquidGlass(node, options) {
  const make = (o) => {
    const opts = Object.assign(
      { radius: 28, bevel: 'auto', scale: 60, aberration: 0, tint: 0.04, blur: 0, saturate: 1.8 },
      o || {}
    );
    if (NO_SVG_BACKDROP && !(opts.blur > 0)) {            // iOS/Safari 折射不可用 → 毛玻璃兜底
      opts.blur = 18;
      if (!opts.saturate || opts.saturate < 1.5) opts.saturate = 1.7;
      opts.tint = Math.max(opts.tint, 0.1);
    }
    return opts;
  };
  let opts = make(options);

  const fid = 'lg-filter-' + (++_uid);
  const defs = ensureDefs();
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', fid);
  filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
  filter.setAttribute('width', '100%'); filter.setAttribute('height', '100%');
  filter.setAttribute('filterUnits', 'objectBoundingBox');
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  defs.appendChild(filter);

  node.classList.add('lg');
  if (opts.bare) node.classList.add('lg-bare');   // 纯折射：默认去边光/高光/底色（见 app.css .lg-bare）
  node.style.setProperty('--lg-radius', opts.radius + 'px');
  node.style.setProperty('--lg-tint', String(opts.tint));
  node.style.setProperty('--lg-glow', String(opts.glow ?? 0));   // 「光感」：bare 下按此强度加回打光

  let lastW = 0, lastH = 0, mapURL = null, raf = 0;
  let mapReady = false, decodeToken = 0;   // 位移贴图是否已解码（防折射错乱，见下）
  let dR = null, dG = null, dB = null;   // 三色通道折射节点；scale 动画时只改它们的 scale 属性（轻量）

  function applyBackdrop() {
    node.style.backdropFilter = 'url(#' + fid + ')';
    node.style.webkitBackdropFilter = 'url(#' + fid + ')';
  }

  function rebuild() {
    raf = 0;
    // 毛玻璃模式：CSS 背景模糊 + 提饱和，不走 SVG 折射滤镜。
    if (opts.blur && opts.blur > 0) {
      const bf = 'blur(' + opts.blur + 'px) saturate(' + opts.saturate + ')';
      node.style.backdropFilter = bf;
      node.style.webkitBackdropFilter = bf;
      return;
    }
    const rect = node.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return;
    // 尺寸没变且滤镜已建好：什么都不重写（ResizeObserver 在 display:none↔可见切换时也会触发到这里）。
    // 重写 innerHTML 会把【活着的 backdrop】指向一张待解码的新 feImage——正是折射错乱的窗口，能省则省。
    if (w === lastW && h === lastH && mapURL && dR) {
      applyScale();
      if (mapReady) applyBackdrop();
      return;
    }
    const bevel = (opts.bevel === 'auto' || opts.bevel == null)
      ? Math.max(14, Math.min(56, Math.round(Math.min(w, h) * 0.20)))
      : opts.bevel;
    mapURL = buildDisplacementMap(w, h, opts.radius, bevel, opts.supersampling);
    lastW = w; lastH = h;
    mapReady = false;   // 新贴图未解码——在解码完成前绝不让 backdrop 引用它
    // 折射错乱根因：feImage 的 dataURL 是【异步解码】的，backdrop-filter 一旦在 feImage 解码完成前
    // 被合成，feDisplacementMap 读到的是未解码/垃圾贴图 → 整块彩虹错乱/断层撕裂；且 backdrop 层
    // 之后不会因贴图迟到自动重绘 → 错乱卡住不自愈。
    // 解法（比旧版更彻底）：先用 Image.decode() 把 dataURL 解码进图片缓存，【解码完成后】才写
    // filter.innerHTML + 开 backdrop——旧版只把「开 backdrop」挪到解码后，但 backdrop 已生效时
    // 重写 innerHTML（尺寸变化/重挂载的二次 rebuild）仍会让活滤镜引用未解码贴图，真机上
    // 从工作空间等分页返回主页就撕裂。现在换图与合成原子化，窗口彻底关死。
    const token = ++decodeToken;
    const commit = () => {
      if (token !== decodeToken) return;   // 已被更新的 rebuild 取代，丢弃
      const base = opts.scale, ab = opts.aberration;
      // R/G/B 三通道分别位移（ab=0 时三者相同 → 纯折射无色散）。
      filter.innerHTML =
        '<feImage result="map" preserveAspectRatio="none" x="0" y="0" width="' + w + '" height="' + h + '" href="' + mapURL + '"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + (base + ab) + '" xChannelSelector="R" yChannelSelector="G" result="dR"/>' +
        '<feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + base + '" xChannelSelector="R" yChannelSelector="G" result="dG"/>' +
        '<feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + (base - ab) + '" xChannelSelector="R" yChannelSelector="G" result="dB"/>' +
        '<feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB"/>' +
        '<feBlend in="cR" in2="cG" mode="screen" result="rg"/>' +
        '<feBlend in="rg" in2="cB" mode="screen" result="rgb"/>' +
        '<feGaussianBlur in="rgb" stdDeviation="' + (opts.frost ?? 0.4) + '"/>';   // frost：对折射结果再磨砂（默认 0.4，可传更大）
      dR = filter.querySelector('[result="dR"]');   // 存三通道折射节点，供 applyScale 轻量改 scale
      dG = filter.querySelector('[result="dG"]');
      dB = filter.querySelector('[result="dB"]');
      mapReady = true;
      applyBackdrop();
    };
    const probe = new Image();
    probe.src = mapURL;
    // 用 decode() 而非 onload：onload 只保证“已下载”，decode() 保证“已解码、可立即合成”。
    // 个别环境 decode() 对 dataURL 可能 reject → catch 回落照常 commit（即 onload 行为，绝不更糟）。
    if (probe.decode) probe.decode().then(commit, commit);
    else probe.onload = probe.onerror = commit;
  }
  // 只改三通道折射/色散强度（scale），不重写整段 filter——折射鼓包动画逐帧调用，轻量。
  function applyScale() {
    if (!dR) {
      // 折射滤镜还没建好：贴图解码中（commit 会按当时的 opts 烤入最新 scale，无需催）。
      // 别在这儿调 rebuild()——鼓包动画逐帧进来会每帧重算贴图+作废上一次解码，慢机上把 commit 饿死。
      if (opts.blur > 0) rebuild();   // 毛玻璃模式无贴图无 dR，rebuild 只是重写一行 CSS，照常
      return;
    }
    const base = opts.scale, ab = opts.aberration;
    dR.setAttribute('scale', base + ab);
    dG.setAttribute('scale', base);
    dB.setAttribute('scale', base - ab);
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(rebuild); }

  rebuild();
  const ro = new ResizeObserver(schedule);
  ro.observe(node);

  return {
    update(next) {
      const prev = opts;
      opts = make(next);
      node.style.setProperty('--lg-radius', opts.radius + 'px');
      node.style.setProperty('--lg-tint', String(opts.tint));
      node.style.setProperty('--lg-glow', String(opts.glow ?? 0));
      if (opts.bare) node.classList.add('lg-bare'); else node.classList.remove('lg-bare');
      // 折射鼓包动画只动 scale/aberration → 轻量改三通道 scale；尺寸/圆角/模式变才整段重建贴图+滤镜。
      const structural = opts.radius !== prev.radius || opts.bevel !== prev.bevel || !!opts.blur !== !!prev.blur || opts.supersampling !== prev.supersampling || opts.frost !== prev.frost;
      if (structural) { mapURL = null; rebuild(); }
      else applyScale();
    },
    destroy() {
      decodeToken++;   // 作废任何挂起的贴图解码回调，别在已销毁节点上 applyBackdrop
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (filter.parentNode) filter.parentNode.removeChild(filter);
      node.style.backdropFilter = '';
      node.style.webkitBackdropFilter = '';
      node.classList.remove('lg');
      node.classList.remove('lg-bare');
    }
  };
}
