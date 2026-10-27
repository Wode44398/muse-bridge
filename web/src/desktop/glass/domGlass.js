// 引擎乙：DOM 玻璃 v3。
// 双管线：
//   ① 圆/胶囊（radius ≥ 短边一半）：圆透镜位移贴图（lgMap.js：公开版自写，私有 overlay 可换）
//      + primitiveUnits=objectBoundingBox（模糊/位移随元素尺寸
//      自缩放，一个静态滤镜适配任意大小，无需按尺寸重建）+ 无色散。
//   ② 圆角矩形（原版没覆盖的形状）：保留解析式透镜位移图（形状正确），磨砂默认
//      对齐原版语义=短边 2%。
// 铬装统一原版：奶雾底(白 8%) + 粗亮环(2px 60% 白×ring) + 大软影，由 action 直接上
// （不再用 conic rim 子层——原版的环是均匀的，方向性光交给 GL 引擎的场景件）。
// 纪律沿袭：feImage dataURL 必须 decode() 完成后才 commit + 开 backdrop。
import { lgMap } from './lgMap.js';
import { tintCss } from './material.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let _uid = 0;

const SLOPE_MAX = 1 / 0.18;

// 圆透镜贴图全局只取一次、解码一次（所有胶囊实例共享）→ Promise<data URL>
let _lgMapReady = null;
function lgMapReady() {
  if (!_lgMapReady) {
    _lgMapReady = lgMap().then((url) => {
      const img = new Image();
      img.src = url;
      return (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => url);
    });
  }
  return _lgMapReady;
}

/* 矩形用：解析式透镜位移图（圆透镜剖面，与 GL 引擎同族） */
function buildLensMap(w, h, radius, bevel) {
  const ss = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const W = Math.max(2, Math.round(w * ss)), H = Math.max(2, Math.round(h * ss));
  const R = Math.min(radius * ss, W / 2, H / 2), B = Math.max(1, bevel * ss);
  const hw = W / 2, hh = H / 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(W, H);

  const sd = (px, py) => {
    const qx = Math.abs(px) - (hw - R), qy = Math.abs(py) - (hh - R);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - hw, py = y + 0.5 - hh;
      const d = sd(px, py);
      const t = Math.min(1, Math.max(0, -d / B));
      const edge = 1 - t;
      const slope = edge / Math.max(Math.sqrt(Math.max(1 - edge * edge, 0)), 0.18);
      const gx = sd(px + 1, py) - sd(px - 1, py);
      const gy = sd(px, py + 1) - sd(px, py - 1);
      const gl = Math.hypot(gx, gy) || 1;
      const k = (slope / SLOPE_MAX) * 127;
      const i = (y * W + x) * 4;
      id.data[i] = Math.max(0, Math.min(255, Math.round(128 + (gx / gl) * k)));
      id.data[i + 1] = Math.max(0, Math.min(255, Math.round(128 + (gy / gl) * k)));
      id.data[i + 2] = 128;
      id.data[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return cv.toDataURL();
}

function ensureDefs() {
  let svg = document.getElementById('dskg-defs');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'dskg-defs');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    svg.appendChild(document.createElementNS(SVG_NS, 'defs'));
    (document.body || document.documentElement).appendChild(svg);
  }
  return svg.firstChild;
}

export function dskGlass(node, options) {
  // scale=胶囊管线的原版位移强度（原版默认 1）；refract/disp/bevel 只作用于矩形管线。
  let opts = {
    radius: 22, bevel: 20, refract: 24, disp: 0.3,
    frost: null,           // 矩形管线磨砂 px；null=短边 2%（原版语义）
    frostRel: 0.02,        // 胶囊管线磨砂（objectBoundingBox stdDeviation，原版 0.02）
    scale: 1,
    ring: 0.6,             // 粗亮环强度（0=无环）；原版 = 2px rgba(255,255,255,.6)
    shadow: true,          // 原版大软影 0 16px 32px
    tint: [1, 1, 1, 0.08], // 原版奶雾底
    ...options,
  };

  const fid = 'dskg-' + (++_uid);
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', fid);
  ensureDefs().appendChild(filter);
  // 两管线的滤镜属性差异必须逐字保真：
  //   胶囊(原版)：默认区域(-10%/120%) + 默认 linearRGB——原版位移图的中性点按 linearRGB
  //   烤制，强设 sRGB 会让中性值漂移=整个背景被平移采样（实测成「铁球」）；
  //   矩形(解析式)：我们的图中性点=128@sRGB，必须显式 sRGB + 0/100% 区域。
  const setFilterAttrs = (capsule) => {
    if (capsule) {
      filter.removeAttribute('x'); filter.removeAttribute('y');
      filter.removeAttribute('width'); filter.removeAttribute('height');
      filter.removeAttribute('filterUnits');
      filter.removeAttribute('color-interpolation-filters');
    } else {
      filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
      filter.setAttribute('width', '100%'); filter.setAttribute('height', '100%');
      filter.setAttribute('filterUnits', 'objectBoundingBox');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
    }
  };

  const applyChrome = () => {
    if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
    node.style.borderRadius = opts.radius + 'px';
    node.style.background = tintCss(opts.tint);
    node.style.isolation = 'isolate';
    const ring = opts.ring > 0 ? `0 0 0 2px rgba(255,255,255,${(0.6 * opts.ring).toFixed(3)})` : '';
    const drop = opts.shadow ? '0 16px 32px rgba(0,0,0,.12)' : '';
    node.style.boxShadow = [ring, drop].filter(Boolean).join(', ');
  };
  applyChrome();

  let lastW = 0, lastH = 0, decodeToken = 0, raf = 0;
  const applyBackdrop = () => {
    node.style.backdropFilter = `url(#${fid})`;
    node.style.webkitBackdropFilter = `url(#${fid})`;
  };

  function rebuild() {
    raf = 0;
    const rect = node.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return;
    const capsule = opts.radius * 2 >= Math.min(w, h) - 1;

    if (capsule) {
      // 原版管线：oBB 静态滤镜，与尺寸无关——建一次即可（尺寸变化无需重建）
      if (lastW === -1) return;
      lastW = -1; lastH = -1;
      const token = ++decodeToken;
      lgMapReady().then((LG_MAP) => {
        if (token !== decodeToken) return;
        setFilterAttrs(true);
        filter.setAttribute('primitiveUnits', 'objectBoundingBox');
        filter.innerHTML =
          `<feImage href="${LG_MAP}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map"/>` +
          `<feGaussianBlur in="SourceGraphic" stdDeviation="${opts.frostRel}" result="blur"/>` +
          `<feDisplacementMap in="blur" in2="map" scale="${opts.scale}" xChannelSelector="R" yChannelSelector="G"/>`;
        applyBackdrop();
      });
      return;
    }

    // 矩形管线：形状正确的解析式位移图（px 语义，尺寸变了重建）
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    const frost = opts.frost ?? Math.max(0.4, 0.02 * Math.min(w, h));   // 原版语义：短边 2%
    const mapURL = buildLensMap(w, h, opts.radius, opts.bevel);
    const base = opts.refract * 2, ab = base * opts.disp * 0.5;
    const token = ++decodeToken;
    const commit = () => {
      if (token !== decodeToken) return;
      setFilterAttrs(false);
      filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
      filter.innerHTML =
        `<feImage result="map" preserveAspectRatio="none" x="0" y="0" width="${w}" height="${h}" href="${mapURL}"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${base + ab}" xChannelSelector="R" yChannelSelector="G" result="dR"/>` +
        '<feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR"/>' +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${base}" xChannelSelector="R" yChannelSelector="G" result="dG"/>` +
        '<feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG"/>' +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${base - ab}" xChannelSelector="R" yChannelSelector="G" result="dB"/>` +
        '<feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB"/>' +
        '<feBlend in="cR" in2="cG" mode="screen" result="rg"/>' +
        '<feBlend in="rg" in2="cB" mode="screen" result="rgb"/>' +
        `<feGaussianBlur in="rgb" stdDeviation="${frost}"/>`;
      applyBackdrop();
    };
    const probe = new Image();
    probe.src = mapURL;
    if (probe.decode) probe.decode().then(commit, commit);
    else probe.onload = probe.onerror = commit;
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(rebuild); };

  rebuild();
  const ro = new ResizeObserver(schedule);
  ro.observe(node);

  return {
    update(next) {
      opts = { ...opts, ...next };
      applyChrome();
      lastW = lastH = 0;
      schedule();
    },
    destroy() {
      decodeToken++;
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      filter.remove();
      node.style.backdropFilter = '';
      node.style.webkitBackdropFilter = '';
    },
  };
}
