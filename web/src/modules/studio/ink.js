// 显影引擎（Media Studio「作品台」的生成态，方案 §12）：墨在取景框里按进度晕开（几团高斯墨相融、
// 低频噪声扭坐标所以边不是正圆、墨边一圈淡水痕、纸纹），出图时画面压在墨上、从墨浓处浮出来，由糊到清、由灰到彩，墨同时退去。
// 纯「时刻 → 画面」：调用方传 progress / reveal / t，不自己计时（慢放、减少动态效果、组件重挂都接得上）。
// 性能：场是低分辨率网格（默认短边 96 格，手机传 grid:64），放大时双线性插值；调用方负责节流和离屏不画。
// —— 值噪声（够用、可复现）——
function hash(i, j, s) {
  let h = (i * 374761393 + j * 668265263 + s * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = fade(x - i), fy = fade(y - j);
  const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, s) { return vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15; }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * create(canvas, { w, h, seed })：w / h 是框的 CSS 尺寸
 * draw({ t, progress, reveal, img, dark })
 *   progress 0..1：墨晕开了多少（墨的面积）；reveal 0..1：出图进度；t：毫秒，用来让墨边慢慢游动
 */
export function create(canvas, opts) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(opts.w)), H = Math.max(1, Math.round(opts.h));
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  // 低分辨率场：短边 72 格，长边按比例；放大时双线性插值，边自然就软了
  const GS = opts.grid || 96;
  const gw = W >= H ? Math.round(GS * W / H) : GS, gh = W >= H ? GS : Math.round(GS * H / W);
  const field = document.createElement('canvas'); field.width = gw; field.height = gh;
  const fctx = field.getContext('2d');
  const img = fctx.createImageData(gw, gh);
  const mask = document.createElement('canvas'); mask.width = gw; mask.height = gh;
  const mctx = mask.getContext('2d');
  const mimg = mctx.createImageData(gw, gh);
  const layer = document.createElement('canvas'); layer.width = canvas.width; layer.height = canvas.height;
  const lctx = layer.getContext('2d');

  // 墨滴：一颗主墨落在偏中上（构图的视觉中心），几颗小墨散在周围，晕开的先后错开
  const R = rng(opts.seed || 7);
  const blobs = [];
  const asp = gw / gh;
  blobs.push({ x: 0.5 + (R() - 0.5) * 0.12, y: 0.46 + (R() - 0.5) * 0.1, r: 0.5, delay: 0, s: 1 });
  const n = 3 + Math.floor(R() * 2);
  for (let i = 0; i < n; i++) {
    const a = R() * Math.PI * 2, d = 0.18 + R() * 0.26;
    blobs.push({ x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d * 0.9, r: 0.24 + R() * 0.2, delay: 0.08 + R() * 0.3, s: 0.8 + R() * 0.4 });
  }
  const seedN = Math.floor(R() * 1000);

  // 场：几团高斯墨平滑相融（不是各画各的圆：两团碰上时边会自然连成一片，没有折痕）；
  // 坐标先被低频噪声扭一下（纸纹把墨往一边带），边才不是正圆
  const D = new Float32Array(gw * gh), F = new Float32Array(gw * gh);
  function computeField(p, t) {
    const drift = t * 0.00004;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const u = (i + 0.5) / gw, v = (j + 0.5) / gh;
        const nx = u * asp * 1.6, ny = v * 1.6;
        const wx = (fbm(nx + drift, ny, seedN) - 0.5) * (0.1 + 0.08 * p);
        const wy = (fbm(nx + 31, ny - drift, seedN + 5) - 0.5) * (0.1 + 0.08 * p);
        let f = 0;
        for (const b of blobs) {
          const pp = clamp01((p - b.delay) / (1 - b.delay));
          if (pp <= 0) continue;
          const rad = Math.max(0.001, b.r * Math.pow(pp, 0.6) * b.s);
          const dx = (u + wx - b.x) * asp, dy = v + wy - b.y;
          f += Math.exp(-(dx * dx + dy * dy) / (rad * rad) * 1.6);
        }
        F[j * gw + i] = f;
        D[j * gw + i] = f - 0.42;
      }
    }
  }

  function inkLayer(p, t, dark, alphaMul) {
    const data = img.data;
    const col = dark ? [236, 231, 222] : [30, 27, 23];
    const peak = dark ? 0.52 : 0.72;
    for (let k = 0, j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++, k += 4) {
        const d = D[j * gw + i], f = F[j * gw + i];
        if (d < -0.2) { data[k + 3] = 0; continue; }
        const body = smooth(-0.06, 0.22, d);                       // 墨身：边上软软地起来
        const core = smooth(0.5, 1.6, f);                           // 墨心：叠得厚的地方更深
        const rim = Math.exp(-Math.pow((d - 0.015) / 0.045, 2));    // 水痕：墨边一圈稍深
        const grain = (vnoise(i * 0.55, j * 0.55, seedN + 9) - 0.5) * 0.1;   // 纸的细纹
        let a = body * (0.36 + 0.34 * core + grain) + rim * 0.2;
        a = clamp01(a) * peak * alphaMul;
        data[k] = col[0]; data[k + 1] = col[1]; data[k + 2] = col[2]; data[k + 3] = Math.round(a * 255);
      }
    }
    fctx.putImageData(img, 0, 0);
  }

  // 出图时的遮罩：先在墨浓处透出画面，再一路漫到全幅
  function maskLayer(r) {
    const data = mimg.data;
    const lift = r * 1.9;
    for (let k = 0, j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++, k += 4) {
        const d = D[j * gw + i];
        const a = smooth(0, 1, (d + 0.2) * 1.4 + lift - 0.3);
        data[k] = data[k + 1] = data[k + 2] = 0; data[k + 3] = Math.round(clamp01(a) * 255);
      }
    }
    mctx.putImageData(mimg, 0, 0);
  }

  const eIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const eOut = (x) => 1 - Math.pow(1 - x, 3);
  function draw(s) {
    const p = clamp01(s.progress || 0), r = clamp01(s.reveal || 0), t = s.t || 0;
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    // 出图时墨还在接着晕一点（不让画面「停一下再变」）
    computeField(Math.min(1, p + eOut(r) * 0.2), t);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    // 墨在底下：出图后一路退去
    const inkA = r > 0 ? Math.pow(1 - r, 1.5) : 1;
    if (inkA > 0.004) {
      inkLayer(p, t, !!s.dark, inkA);
      ctx.filter = `blur(${(0.7 * dpr).toFixed(1)}px)`;
      ctx.drawImage(field, 0, 0, cw, ch);
      ctx.filter = 'none';
    }
    // 画面在上面：先在墨浓的地方浮出来、再漫到全幅（遮罩走得快），由糊到清像对焦一样走得慢，由灰到彩
    if (r > 0 && s.img && s.img.complete && s.img.naturalWidth) {
      maskLayer(eIO(Math.min(1, r * 1.25)));
      lctx.clearRect(0, 0, cw, ch);
      const blur = 15 * Math.pow(1 - r, 2.1) * dpr, gray = 0.9 * Math.pow(1 - r, 1.3);
      lctx.filter = `blur(${blur.toFixed(2)}px) grayscale(${gray.toFixed(3)}) contrast(${(0.86 + 0.14 * r).toFixed(3)})`;
      const iw = s.img.naturalWidth, ih = s.img.naturalHeight;
      const sc = Math.max(cw / iw, ch / ih), dw = iw * sc, dh = ih * sc;
      lctx.drawImage(s.img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      lctx.filter = 'none';
      lctx.globalCompositeOperation = 'destination-in';
      lctx.drawImage(mask, 0, 0, cw, ch);
      lctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layer, 0, 0);
    }
  }

  // 用完立刻放掉画布的位图（宽高归零）：几张离屏画布要等垃圾回收才释放，手机上连着出几张图，
  // 没回收的画布占着光栅内存，合成器会一阵一阵出不了帧（无头 Edge 里实测整页卡住）
  function dispose() { for (const c of [field, mask, layer, canvas]) { c.width = 0; c.height = 0; } }
  return { draw, dispose, w: W, h: H };
}

// 进度曲线：大概 eta 毫秒走到 0.82，之后越来越慢、永远到不了 1（等结果，不假装知道还要多久）
export function progressAt(ms, eta) {
  const k = ms / Math.max(800, eta);
  return 0.93 * (1 - Math.exp(-1.9 * k));
}
