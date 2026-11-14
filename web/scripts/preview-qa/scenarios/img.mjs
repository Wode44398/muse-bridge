// 图片查看器改版（ImageGallery，feat/pv-img）验收：系统相册 / Windows 照片的手感逐项量化。
// 口径不绑实现细节：图片位置一律取主图（lib/page.mjs mainImg）的显示矩形；「锚点误差」= 缩放前后同一屏幕点下的图内相对位置之差 × 显示宽高（px）。
//   电脑：滚轮 / Ctrl+滚轮锚点、快捷键、拖动平移与惯性、浮条、缩略图条、适应规则、缩放上限与原图升级
//   触屏：双击锚点、捏合锚点与回弹、放大后平移到边缘交给翻页、下拉关闭（跟手 / 速度判定 / 小幅回弹）、单击沉浸、滑轨不重建、反向侧滑计时
//   两端：FLIP 打开 / 关闭、动图播放、EXIF 信息行、加载失败可滑走可关闭、混排视频页占位与挂卸、尺寸变化、减弱动效
import { emulate } from '../gestures.mjs';

const BIG = '图片/大图-8000x6000.jpg';

// 页面侧小工具（每个场景开头装一次；同一页面跨场景复用也无妨）
const SETUP = String.raw`(() => { window.__ig = {
  idx: () => __pvqa.pv.preview.index,
  isOpen: () => !!__pvqa.pv.preview.open,
  // 屏幕点 (x, y) 落在主图的哪个相对位置；s = 主图状态
  frac(x, y) { const el = __pvqa.mainImg(); if (!el) return null; const r = el.getBoundingClientRect(); return { u: (x - r.left) / r.width, v: (y - r.top) / r.height, w: r.width, h: r.height, s: __pvqa.imgState() }; },
  black() { const b = document.querySelector('.ig-black'); return b ? +(+getComputedStyle(b).opacity).toFixed(3) : null; },
  pct() { const b = document.querySelector('.ig-pct'); return b ? b.textContent.trim() : null; },
  pctNum() { const m = /^(\d+)%$/.exec(this.pct() || ''); return m ? +m[1] : null; },
  slot(i) { return document.querySelector('[data-pv-slot="' + i + '"]'); },
  boxRect(i) { const s = this.slot(i); const b = s && s.querySelector('.iv-box'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, op: +__pvqa.effOpacity(b).toFixed(3) }; },
  floatBtns() { return [...document.querySelectorAll('.ig-float .vw-btn')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, label: b.getAttribute('aria-label') || '', dis: b.disabled || b.getAttribute('aria-disabled') === 'true' }; }); },
  hidden(sel) { const el = document.querySelector(sel); return !el || el.classList.contains('vw-hide') || __pvqa.effOpacity(el) < 0.05; },
  // 逐帧记录第 i 页适应框的显示矩形（FLIP 开合）
  rec(i, ms) { const out = []; const t0 = performance.now(); const tick = () => { const b = this.boxRect(i); out.push({ t: Math.round(performance.now() - t0), b }); if (performance.now() - t0 < ms) requestAnimationFrame(tick); }; requestAnimationFrame(tick); this.recOut = out; return true; },
}; return true; })()`;
const setup = (ctx) => ctx.eval(SETUP);
const st = (ctx) => ctx.eval(`__pvqa.imgState()`);
const frac = (ctx, p) => ctx.eval(`__ig.frac(${p.x}, ${p.y})`);
const idx = (ctx) => ctx.eval(`__ig.idx()`);
const isOpen = (ctx) => ctx.eval(`__ig.isOpen()`);
const hash = (str) => { let x = 0; for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0; return x >>> 0; };
const r1 = (v) => (v == null ? v : Math.round(v * 10) / 10);
const anchorErr = (a, b) => (a && b ? { x: r1(Math.abs(b.u - a.u) * b.w), y: r1(Math.abs(b.v - a.v) * b.h) } : null);

async function openPainted(ctx, items, index = 0, { ms = 30000 } = {}) {
  await ctx.open(items, index);
  await setup(ctx);
  await ctx.waitFor(`__pvqa.itemPainted(${index})`, ms, '出图');
  // 电脑端百分比要原图真尺寸（原图头部到了才显示数字）
  if (!ctx.touch) await ctx.waitFor(`__ig.pctNum() != null`, 15000, '百分比');
  await ctx.sleep(300);
}
// 触屏单指：按下 → 逐点移动（不抬手）→ 由调用方决定何时抬
const touch = (ctx, type, p) => ctx.pg.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] : [] });
async function touchPath(ctx, from, to, { ms = 240, steps = 12 } = {}) {
  for (let i = 1; i <= steps; i++) { await touch(ctx, 'touchMove', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }); await ctx.sleep(ms / steps); }
}
function stats(arr) {
  const v = arr.filter((x) => x != null).sort((p, q) => p - q);
  if (!v.length) return null;
  const q = (k) => v[Math.min(v.length - 1, Math.floor(k * (v.length - 1) + 0.5))];
  return { n: v.length, median: q(0.5), p90: q(0.9), max: v[v.length - 1], min: v[0] };
}

const desk = (cfg) => !cfg.touch;
const touchOnly = (cfg) => !!cfg.touch;

export default [
  // —— 电脑 ——————————————————————————————————————————————————————————————
  {
    id: 'img-desk-wheel-anchor',
    title: '电脑：滚轮 / Ctrl+滚轮以光标为锚缩放（锚点误差）、缩回居中、不整页缩放',
    tags: ['img', 'desktop', 'zoom'], only: desk,
    async run(ctx) {
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const { w, h } = ctx.cfg;
      const c = { x: Math.round(w * 0.62), y: Math.round(h * 0.45) };
      await ctx.g.hover(c.x, c.y);
      const s0 = await st(ctx);
      // 第一段放大：适应态的图比窗口窄，横向会被居中钳住，锚点误差只在第二段量
      await ctx.g.wheel(c.x, c.y, { dy: -120, ticks: 3 });
      await ctx.sleep(500);
      const a = await frac(ctx, c);
      await ctx.g.wheel(c.x, c.y, { dy: -120, ticks: 2 });
      await ctx.sleep(500);
      const b = await frac(ctx, c);
      const e1 = anchorErr(a, b);
      ctx.metric('wheel', { s1: a?.s?.effScale, s2: b?.s?.effScale, err: e1 });
      ctx.assert('滚轮放大', (a?.s?.effScale ?? 1) > 1.5 && (b?.s?.effScale ?? 1) > (a?.s?.effScale ?? 1) * 1.3, [a?.s?.effScale, b?.s?.effScale]);
      ctx.assert('滚轮锚点误差 ≤ 2px', e1 && Math.max(e1.x, e1.y) <= 2, e1);
      await ctx.shot('zoomed');
      // Ctrl+滚轮（= 触控板捏合）：换个位置，同样锚定
      const c2 = { x: Math.round(w * 0.35), y: Math.round(h * 0.6) };
      await ctx.g.hover(c2.x, c2.y);
      const a2 = await frac(ctx, c2);
      await ctx.g.wheel(c2.x, c2.y, { dy: -120, ticks: 2, ctrl: true });
      await ctx.sleep(500);
      const b2 = await frac(ctx, c2);
      const e2 = anchorErr(a2, b2);
      ctx.metric('ctrlWheel', { s: b2?.s?.effScale, err: e2, vv: b2?.s?.vv });
      ctx.assert('Ctrl+滚轮放大图片', (b2?.s?.effScale ?? 0) > (a2?.s?.effScale ?? 1) * 1.2, [a2?.s?.effScale, b2?.s?.effScale]);
      ctx.assert('Ctrl+滚轮锚点误差 ≤ 2px', e2 && Math.max(e2.x, e2.y) <= 2, e2);
      ctx.assert('Ctrl+滚轮没有整页缩放', (b2?.s?.vv ?? 1) === 1, b2?.s?.vv);
      // 缩回：一路滚到底回到适应、居中
      await ctx.g.wheel(c.x, c.y, { dy: 120, ticks: 14 });
      await ctx.sleep(700);
      const s3 = await st(ctx);
      ctx.assert('滚回适应且居中', s3 && Math.abs(s3.effScale - 1) < 0.01 && Math.abs(s3.cx - s0.cx) <= 1 && Math.abs(s3.cy - s0.cy) <= 1, s3 && { s: s3.effScale, cx: s3.cx, cy: s3.cy, c0: [s0.cx, s0.cy] });
    },
  },
  {
    id: 'img-desk-keys',
    title: '电脑：+ - 0 1 R Shift+R、放大时方向键平移、Home / End、F 全屏',
    tags: ['img', 'desktop', 'keys'], only: desk,
    async run(ctx) {
      const items = [ctx.item(BIG, { kind: 'image' }), ...ctx.gallery('序列').slice(0, 4)];
      await openPainted(ctx, items, 0);
      const fit = await st(ctx);
      await ctx.g.key('1'); await ctx.sleep(600);
      const s1 = await st(ctx);
      ctx.assert('1 = 实际大小（显示宽 ≈ 8000）', s1 && Math.abs(s1.rect.w - 8000) <= 8, s1?.rect.w);
      ctx.assert('1 之后百分比 = 100%', (await ctx.eval(`__ig.pct()`)) === '100%', await ctx.eval(`__ig.pct()`));
      await ctx.g.key('0'); await ctx.sleep(600);
      const s0 = await st(ctx);
      ctx.assert('0 = 适应窗口', s0 && Math.abs(s0.rect.w - fit.rect.w) <= 2 && Math.abs(s0.effScale - 1) < 0.01, s0?.rect.w);
      await ctx.g.key('+'); await ctx.sleep(500);
      const sp = await st(ctx);
      await ctx.g.key('-'); await ctx.sleep(500);
      const sm = await st(ctx);
      ctx.assert('+ 放大一档（×1.25）', sp && Math.abs(sp.effScale - 1.25) < 0.03, sp?.effScale);
      ctx.assert('- 缩小一档', sm && Math.abs(sm.effScale - 1) < 0.01, sm?.effScale);
      await ctx.g.key('r'); await ctx.sleep(600);
      const sr = await st(ctx);
      ctx.assert('R 右旋 90°（横图显示成竖的，仍在窗口内）', sr && sr.rect.h > sr.rect.w && sr.rect.h <= ctx.cfg.h + 1, sr && `${sr.rect.w}×${sr.rect.h}`);
      await ctx.shot('rotated');
      await ctx.g.key('shift+r'); await ctx.sleep(600);
      const sr2 = await st(ctx);
      ctx.assert('Shift+R 左旋回正', sr2 && sr2.rect.w > sr2.rect.h && Math.abs(sr2.rect.w - fit.rect.w) <= 2, sr2 && `${sr2.rect.w}×${sr2.rect.h}`);
      for (let k = 0; k < 3; k++) await ctx.g.key('+');
      await ctx.sleep(600);
      const z0 = await st(ctx);
      await ctx.g.key('arrowright'); await ctx.sleep(500);
      const z1 = await st(ctx);
      ctx.assert('放大时 → 平移、不翻页', z1 && z1.index === 0 && z1.cx < z0.cx - 50, z1 && { index: z1.index, dx: z1.cx - z0.cx });
      await ctx.g.key('0'); await ctx.sleep(500);
      await ctx.g.key('arrowright'); await ctx.sleep(400);
      ctx.assert('适应时 → 翻页', (await idx(ctx)) === 1, await idx(ctx));
      await ctx.g.key('end'); await ctx.sleep(400);
      const iEnd = await idx(ctx);
      await ctx.g.key('home'); await ctx.sleep(400);
      const iHome = await idx(ctx);
      ctx.assert('End 跳到最后一张', iEnd === items.length - 1, iEnd);
      ctx.assert('Home 跳回第一张', iHome === 0, iHome);
      // F 全屏：无头 Edge 可能不给全屏，只记录
      await ctx.g.key('f'); await ctx.sleep(500);
      const fs = await ctx.eval(`!!document.fullscreenElement`);
      ctx.metric('fullscreen', fs);
      if (fs) {
        await ctx.g.key('escape'); await ctx.sleep(500);
        ctx.assert('全屏里 Esc 只退全屏、不关查看器', (await isOpen(ctx)) && !(await ctx.eval(`!!document.fullscreenElement`)), await isOpen(ctx));
      }
    },
  },
  {
    id: 'img-desk-drag',
    title: '电脑：放大后左键拖动平移（抓手、惯性）、1x 时拖动不做事',
    tags: ['img', 'desktop', 'pan'], only: desk,
    async run(ctx) {
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const { w, h } = ctx.cfg;
      const mid = { x: w / 2, y: h / 2 };
      ctx.assert('1x 时不显示抓手', (await ctx.eval(`getComputedStyle(document.querySelector('.ig')).cursor`)) !== 'grab');
      await ctx.g.drag(mid, { x: mid.x, y: mid.y + 300 }, { ms: 250 });
      await ctx.sleep(600);
      const s1x = await st(ctx);
      ctx.assert('1x 拖动不关闭、不移动', (await isOpen(ctx)) && s1x && Math.abs(s1x.cy - Math.round(h / 2)) <= 2, s1x && { open: await isOpen(ctx), cy: s1x.cy });
      for (let k = 0; k < 3; k++) await ctx.g.key('+');
      await ctx.sleep(600);
      const cur = await ctx.eval(`getComputedStyle(document.querySelector('.ig')).cursor`);
      ctx.assert('放大后显示抓手光标', cur === 'grab', cur);
      const s0 = await st(ctx);
      await ctx.g.drag(mid, { x: mid.x - 220, y: mid.y - 120 }, { ms: 120, steps: 8 });
      const s1 = await st(ctx);
      await ctx.sleep(900);
      const s2 = await st(ctx);
      ctx.metric('drag', { during: s1 && s1.cx - s0.cx, after: s2 && s2.cx - s0.cx, dy: s2 && s2.cy - s0.cy });
      ctx.assert('拖动平移跟手', s1 && s1.cx < s0.cx - 150 && s1.cy < s0.cy - 60, s1 && { dx: s1.cx - s0.cx, dy: s1.cy - s0.cy });
      ctx.assert('松手后有惯性（继续滑一段）', s2 && s1 && s2.cx < s1.cx - 10, s2 && { extra: s2.cx - s1.cx });
      // 硬边界：图边不离开窗口边（电脑端不做橡皮筋）
      ctx.assert('惯性停在界内（图边不离开窗口边）', s2 && s2.rect.x <= 0.5 && s2.rect.x + s2.rect.w >= w - 0.5, s2 && { left: s2.rect.x, right: s2.rect.x + s2.rect.w });
      await ctx.shot('panned');
    },
  },
  {
    id: 'img-desk-float',
    title: '电脑：底部浮条（缩放 / 百分比 / 适应 / 实际大小 / 旋转）、静止自动隐藏',
    tags: ['img', 'desktop', 'chrome'], only: desk,
    async run(ctx) {
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' }), ...ctx.gallery('序列').slice(0, 2)], 0);
      const { w, h } = ctx.cfg;
      const btns = await ctx.eval(`__ig.floatBtns()`);
      ctx.metric('buttons', btns.map((b) => b.label));
      ctx.assert('浮条 7 个按钮', btns.length === 7, btns.length);
      ctx.assert('按钮高 32', btns.every((b) => Math.round(b.h) === 32), btns.map((b) => Math.round(b.h)));
      ctx.assert('按钮都有提示与快捷键', btns.every((b) => /\(.+\)$/.test(b.label)), btns.map((b) => b.label));
      const bar = await ctx.eval(`(() => { const r = document.querySelector('.vw-float').getBoundingClientRect(); return { cx: r.left + r.width / 2, bottom: r.bottom, w: r.width }; })()`);
      ctx.assert('浮条水平居中', Math.abs(bar.cx - w / 2) <= 2, bar.cx);
      const p0 = await ctx.eval(`__ig.pctNum()`);
      ctx.assert('百分比是原图像素口径（8000 宽适应到窗口 ≈ 15%）', p0 === Math.round((Math.min(w / 8000, h / 6000)) * 100) || Math.abs(p0 - 15) <= 1, p0);
      await ctx.g.tap(btns[2].x, btns[2].y); await ctx.sleep(500);
      const p1 = await ctx.eval(`__ig.pctNum()`);
      ctx.assert('点放大 → 百分比上升', p1 > p0, [p0, p1]);
      await ctx.g.tap(btns[4].x, btns[4].y); await ctx.sleep(600);
      ctx.assert('点实际大小 → 100%', (await ctx.eval(`__ig.pct()`)) === '100%', await ctx.eval(`__ig.pct()`));
      await ctx.g.tap(btns[1].x, btns[1].y); await ctx.sleep(600);
      ctx.assert('100% 时点百分比 → 回到适应', (await ctx.eval(`__ig.pctNum()`)) === p0, await ctx.eval(`__ig.pctNum()`));
      await ctx.shot('float');
      // 指针移到图上静止：2.6 秒后浮条、缩略图条、光标都藏起来；一动就回来
      await ctx.g.hover(w * 0.4, h * 0.4, { steps: 3, ms: 60 });
      await ctx.sleep(3300);
      const hid = await ctx.eval(`({ float: __ig.hidden('.vw-float'), bottom: __ig.hidden('.vw-bottom'), cursor: getComputedStyle(document.querySelector('.ig')).cursor })`);
      ctx.assert('静止后自动隐藏浮条与底栏、藏光标', hid.float && hid.bottom && hid.cursor === 'none', hid);
      await ctx.g.hover(w * 0.45, h * 0.42, { steps: 3, ms: 60 });
      await ctx.sleep(400);
      const back = await ctx.eval(`({ float: __ig.hidden('.vw-float'), cursor: getComputedStyle(document.querySelector('.ig')).cursor })`);
      ctx.assert('一动鼠标就回来', !back.float && back.cursor !== 'none', back);
      // 指针停在浮条上不隐藏
      await ctx.g.hover(btns[3].x, btns[3].y, { steps: 3, ms: 60 });
      await ctx.sleep(3300);
      ctx.assert('指针停在浮条上不隐藏', !(await ctx.eval(`__ig.hidden('.vw-float')`)), true);
    },
  },
  {
    id: 'img-desk-strip',
    title: '电脑：缩略图条（只用缩略图、当前项居中高亮、点格子翻页、虚拟化）',
    tags: ['img', 'desktop', 'strip'], only: desk,
    async run(ctx) {
      const items = ctx.gallery('序列').slice(0, 40);
      await openPainted(ctx, items, 12);
      await ctx.sleep(400);
      const s = await ctx.eval(`(() => {
        const cells = [...document.querySelectorAll('.ig-cell')];
        const on = document.querySelector('.ig-cell.on'); const r = on && on.getBoundingClientRect();
        const its = __pvqa.pv.preview.items;
        const thumbs = new Set(its.map((x) => __pvqa.abs(x.thumbUrl)).filter(Boolean));
        const big = new Set(its.flatMap((x) => [x.url, x.previewUrl]).filter(Boolean).map((u) => __pvqa.abs(u)));
        const srcs = cells.map((c) => c.querySelector('img')).filter(Boolean).map((im) => __pvqa.abs(im.getAttribute('src')));
        return { n: cells.length, onCx: r ? r.left + r.width / 2 : null, onLabel: on && on.getAttribute('aria-label'),
          allThumb: srcs.length > 0 && srcs.every((u) => thumbs.has(u) && !big.has(u)), nImg: srcs.length,
          nextName: its[14] && its[14].name };
      })()`);
      ctx.metric('strip', s);
      ctx.assert('当前项高亮且水平居中（±2px）', s.onCx != null && Math.abs(s.onCx - ctx.cfg.w / 2) <= 2, s.onCx);
      ctx.assert('当前项是第 13 张', s.onLabel === items[12].name, s.onLabel);
      ctx.assert('格子只用缩略图', s.allThumb, s.nImg);
      ctx.assert('虚拟化：只渲染视口附近的格子', s.n > 10 && s.n < 40, s.n);
      await ctx.shot('strip');
      const c = await ctx.eval(`(() => { const b = [...document.querySelectorAll('.ig-cell')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(items[14].name)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (c) { await ctx.g.hover(c.x, c.y); await ctx.g.tap(c.x, c.y); }
      await ctx.sleep(500);
      ctx.assert('点格子翻到那一张', (await idx(ctx)) === 14, await idx(ctx));
      const onCx2 = await ctx.eval(`(() => { const r = document.querySelector('.ig-cell.on')?.getBoundingClientRect(); return r ? r.left + r.width / 2 : null; })()`);
      ctx.assert('翻页后当前项仍居中', onCx2 != null && Math.abs(onCx2 - ctx.cfg.w / 2) <= 2, onCx2);
      await ctx.close(); await ctx.sleep(300);
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      ctx.assert('只有一张时不出缩略图条', !(await ctx.eval(`!!document.querySelector('.ig-strip')`)), true);
    },
  },
  {
    id: 'img-desk-fit',
    title: '电脑：小图按 100% 居中、大图 contain、全景 contain',
    tags: ['img', 'desktop', 'fit'], only: desk,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      await openPainted(ctx, [ctx.item('图片/小图-64x48.png', { kind: 'image' })]);
      const sm = await st(ctx);
      ctx.assert('小图 100% 显示（64×48）', sm && sm.rect.w === 64 && sm.rect.h === 48, sm && `${sm.rect.w}×${sm.rect.h}`);
      ctx.assert('小图居中', sm && Math.abs(sm.cx - w / 2) <= 1, sm && [sm.cx, sm.cy]);
      ctx.assert('小图百分比 100%', (await ctx.eval(`__ig.pct()`)) === '100%', await ctx.eval(`__ig.pct()`));
      await ctx.shot('small');
      for (let k = 0; k < 12; k++) await ctx.g.key('+');
      await ctx.sleep(700);
      ctx.assert('小图最多放到原图像素 4 倍（400%）', (await ctx.eval(`__ig.pctNum()`)) === 400, await ctx.eval(`__ig.pctNum()`));
      await ctx.close(); await ctx.sleep(300);
      await openPainted(ctx, [ctx.item('图片/全景-12000x800.jpg', { kind: 'image' })]);
      const pano = await st(ctx);
      ctx.assert('全景 contain（宽 = 窗口宽）', pano && Math.abs(pano.rect.w - w) <= 1 && pano.rect.h < h, pano && `${pano.rect.w}×${pano.rect.h}`);
      await ctx.close(); await ctx.sleep(300);
      await openPainted(ctx, [ctx.item('图片/超高-1080x8000.jpg', { kind: 'image' })]);
      const tall = await st(ctx);
      ctx.assert('超高图 contain（高 ≤ 窗口高）', tall && tall.rect.h <= h + 1 && tall.rect.h >= h * 0.8, tall && `${tall.rect.w}×${tall.rect.h}`);
    },
  },
  {
    id: 'img-desk-maxzoom',
    title: '电脑：缩放上限 = 原图像素 4 倍、放大先升 max 档再按可见区挂原图区域块、布局不跳',
    tags: ['img', 'desktop', 'zoom'], only: desk, timeout: 90000,
    async run(ctx) {
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const lay0 = await ctx.eval(`(() => { const b = __ig.slot(0).querySelector('.iv-box'); return { w: b.offsetWidth, h: b.offsetHeight, l: b.offsetLeft, t: b.offsetTop }; })()`);
      const src0 = (await st(ctx))?.src || '';
      ctx.metric('src0', src0.replace(/^.*[?&]/, '…'));
      for (let k = 0; k < 20; k++) await ctx.g.key('+');
      await ctx.sleep(800);
      ctx.assert('上限 400%（原图像素 4 倍）', (await ctx.eval(`__ig.pctNum()`)) === 400, await ctx.eval(`__ig.pctNum()`));
      ctx.assert('到上限后放大钮置灰', await ctx.eval(`__ig.floatBtns()[2].dis`), true);
      // 「原图加载」关（默认）：放大先升 max 档（48MP → ≤16.7MP 的缩小版），超过 max 档分辨率后按可见区拉原图区域块（&region=）
      const hi = await ctx.waitFor(`(() => { const im = __ig.slot(0).querySelector('img.iv-hi'); return im && im.complete && im.naturalWidth > 0 && getComputedStyle(im).opacity === '1' ? { nw: im.naturalWidth, nh: im.naturalHeight, src: im.getAttribute('src') } : null; })()`, 60000, '高清叠层').catch(() => null);
      ctx.assert('放大后先升 max 档（&thumb=max，≤16.7MP）', !!hi && /[?&]thumb=max/.test(hi.src) && hi.nw > 1600 && hi.nw * hi.nh <= 4096 * 4096 * 1.001, hi && { nw: hi.nw, nh: hi.nh, src: hi.src.replace(/^.*[?&]path=/, '…') });
      const tile = await ctx.waitFor(`(() => {
        const cx = innerWidth / 2, cy = innerHeight / 2, ts = [...__ig.slot(0).querySelectorAll('img.iv-tile')];
        const hit = ts.find((im) => { const r = im.getBoundingClientRect(); return im.complete && im.naturalWidth > 0 && getComputedStyle(im).opacity === '1' && r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy; });
        if (!hit) return null;
        const r = hit.getBoundingClientRect(), q = /[?&]region=(\\d+),(\\d+),(\\d+),(\\d+)/.exec(hit.getAttribute('src') || '');
        return { n: ts.length, nw: hit.naturalWidth, ow: q ? +q[3] : 0, sharp: +(hit.naturalWidth / Math.min(q ? +q[3] : hit.naturalWidth, r.width * (devicePixelRatio || 1))).toFixed(3) };
      })()`, 60000, '视口中心区域块').catch(() => null);
      ctx.metric('tile', tile);
      ctx.assert('400% 时视口中心挂上原图区域块（原图分辨率）', !!tile && tile.sharp >= 0.95 && tile.n <= 24, tile);
      const lay1 = await ctx.eval(`(() => { const b = __ig.slot(0).querySelector('.iv-box'); return { w: b.offsetWidth, h: b.offsetHeight, l: b.offsetLeft, t: b.offsetTop }; })()`);
      ctx.assert('升级原图布局不跳', JSON.stringify(lay0) === JSON.stringify(lay1), { lay0, lay1 });
      await ctx.shot('400');
    },
  },

  // —— 触屏 ——————————————————————————————————————————————————————————————
  {
    id: 'img-touch-doubletap',
    title: '触屏：双击按触点放大（锚点误差）、再双击还原、不误触单击沉浸',
    tags: ['img', 'touch', 'zoom'], only: touchOnly,
    async run(ctx) {
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const { w, h } = ctx.cfg;
      const p = { x: Math.round(w * 0.3), y: Math.round(h * 0.47) };
      const s0 = await st(ctx);
      const a = await frac(ctx, p);
      await ctx.g.doubleTap(p.x, p.y);
      await ctx.sleep(700);
      const b = await frac(ctx, p);
      const e = anchorErr(a, b);
      ctx.metric('doubleTap', { s: b?.s?.effScale, err: e });
      ctx.assert('双击放大（> 1.5 倍）', (b?.s?.effScale ?? 1) > 1.5, b?.s?.effScale);
      // 竖屏横图：放大到铺满高度时纵向没有余量（被钳住），锚点只看横向
      ctx.assert('双击横向锚点误差 ≤ 3px', e && e.x <= 3, e);
      ctx.assert('双击不触发单击沉浸', (await ctx.eval(`__ig.black()`)) === 0, await ctx.eval(`__ig.black()`));
      await ctx.shot('zoomed');
      await ctx.g.doubleTap(p.x, p.y);
      await ctx.sleep(700);
      const s2 = await st(ctx);
      ctx.assert('再双击还原且居中', s2 && Math.abs(s2.effScale - 1) < 0.01 && Math.abs(s2.cx - s0.cx) <= 1 && Math.abs(s2.cy - s0.cy) <= 1, s2 && { s: s2.effScale, cx: s2.cx, cy: s2.cy });
    },
  },
  {
    id: 'img-touch-pinch',
    title: '触屏：捏合以双指中点为锚（锚点误差）、缩小越界松手弹回',
    tags: ['img', 'touch', 'zoom'], only: touchOnly,
    async run(ctx) {
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const { w, h } = ctx.cfg;
      const c = { x: Math.round(w * 0.4), y: Math.round(h * 0.5) };
      const a = await frac(ctx, c);
      await ctx.g.pinch(c, 2, { radius: 50, ms: 300, steps: 12 });
      await ctx.sleep(700);
      const b = await frac(ctx, c);
      const e = anchorErr(a, b);
      ctx.metric('pinch2', { s: b?.s?.effScale, err: e });
      ctx.assert('张开 2 倍 → 约 2 倍', b && Math.abs(b.s.effScale - 2) < 0.2, b?.s?.effScale);
      ctx.assert('捏合横向锚点误差 ≤ 4px', e && e.x <= 4, e);
      await ctx.shot('pinch2');
      // 单指平移（放大态）：跟手、不翻页
      const s1 = await st(ctx);
      await ctx.g.swipe({ x: w * 0.6, y: h * 0.5 }, { x: w * 0.6 - 80, y: h * 0.5 }, { ms: 400, steps: 10, easing: false });
      await ctx.sleep(500);
      const s2 = await st(ctx);
      ctx.assert('放大后单指平移', s2 && s2.cx < s1.cx - 40 && s2.index === 0, s2 && { dx: s2.cx - s1.cx });
      // 捏到 1 倍以下：松手弹回适应
      await ctx.g.doubleTap(w / 2, h / 2); await ctx.sleep(600);   // 双击还原
      await ctx.g.pinch({ x: w / 2, y: h / 2 }, 0.4, { radius: 90, ms: 300, steps: 12 });
      await ctx.sleep(800);
      const s3 = await st(ctx);
      ctx.assert('捏小越界松手弹回 1 倍', s3 && Math.abs(s3.effScale - 1) < 0.01, s3?.effScale);
    },
  },
  {
    id: 'img-touch-pan-page',
    title: '触屏：放大后横滑先平移、顶到边缘再交给翻页；翻走后视图复位',
    tags: ['img', 'touch', 'pan'], only: touchOnly,
    async run(ctx) {
      const items = [ctx.item(BIG, { kind: 'image' }), ...ctx.gallery('序列').slice(0, 2)];
      await openPainted(ctx, items, 0);
      const { w, h } = ctx.cfg;
      await ctx.g.doubleTap(w / 2, h / 2);
      await ctx.sleep(700);
      const s0 = await st(ctx);
      ctx.assert('先放大', (s0?.effScale ?? 1) > 1.5, s0?.effScale);
      await ctx.g.swipe({ x: w * 0.7, y: h * 0.5 }, { x: w * 0.3, y: h * 0.5 }, { ms: 300, steps: 10 });
      const s1 = await st(ctx);
      await ctx.sleep(700);
      const s1b = await st(ctx);
      ctx.metric('pan1', { dx: s1 && s1.cx - s0.cx, inertia: s1b && s1 && s1b.cx - s1.cx });
      ctx.assert('第一划是平移（没翻页）', s1b && s1b.index === 0 && s1b.cx < s0.cx - 100, s1b && { index: s1b.index, dx: s1b.cx - s0.cx });
      let n = 1;
      for (; n < 5 && (await idx(ctx)) === 0; n++) {
        await ctx.g.swipe({ x: w * 0.85, y: h * 0.5 }, { x: w * 0.15, y: h * 0.5 }, { ms: 200, steps: 8 });
        await ctx.sleep(700);
      }
      ctx.metric('swipesToPage', n);
      ctx.assert('顶到边缘后继续横滑翻到下一张', (await idx(ctx)) === 1, await idx(ctx));
      await ctx.g.swipe({ x: w * 0.2, y: h * 0.5 }, { x: w * 0.8, y: h * 0.5 }, { ms: 200, steps: 8 });
      await ctx.sleep(800);
      const back = await st(ctx);
      ctx.assert('翻回上一张时视图已复位', back && back.index === 0 && Math.abs(back.effScale - 1) < 0.01, back && { index: back.index, s: back.effScale });
    },
  },
  {
    id: 'img-touch-dismiss',
    title: '触屏：下拉关闭（x/y 跟手并缩小、按距离 / 速度判定、小幅回弹）',
    tags: ['img', 'touch', 'dismiss'], only: touchOnly,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const s0 = await st(ctx);
      // 小幅慢拉：回弹不关
      await ctx.g.swipe({ x: w * 0.5, y: h * 0.4 }, { x: w * 0.5, y: h * 0.4 + h * 0.08 }, { ms: 600, steps: 12 });
      await ctx.sleep(800);
      const sBack = await st(ctx);
      ctx.assert('小幅慢拉回弹不关', (await isOpen(ctx)) && sBack && Math.abs(sBack.cy - s0.cy) <= 1 && Math.abs(sBack.effScale - 1) < 0.01, sBack && { cy: sBack.cy, s: sBack.effScale });
      // 跟手：按住拉到 0.25h、横向偏 40
      const from = { x: Math.round(w * 0.5), y: Math.round(h * 0.4) }, to = { x: from.x + 40, y: from.y + Math.round(h * 0.25) };
      await touch(ctx, 'touchStart', from);
      await touchPath(ctx, from, to, { ms: 300, steps: 12 });
      await ctx.sleep(120);
      const mid = await st(ctx);
      const bg = await ctx.eval(`(() => { const b = document.querySelector('.vw-backdrop'); return b ? +getComputedStyle(b).opacity : null; })()`);
      ctx.metric('mid', mid && { dx: mid.cx - s0.cx, dy: mid.cy - s0.cy, s: mid.effScale, backdrop: bg });
      ctx.assert('下拉 x/y 跟手（误差 ≤ 12px，含起滑阈值）', mid && Math.abs(mid.cx - s0.cx - 40) <= 12 && Math.abs(mid.cy - s0.cy - (to.y - from.y)) <= 12, mid && { dx: mid.cx - s0.cx, dy: mid.cy - s0.cy });
      ctx.assert('下拉时图片缩小', mid && mid.rect.w < s0.rect.w * 0.97, mid && mid.rect.w / s0.rect.w);
      ctx.assert('下拉时背景变淡', bg != null && bg < 0.9, bg);
      await ctx.shot('dragging');
      await touchPath(ctx, to, { x: to.x, y: from.y + Math.round(h * 0.35) }, { ms: 80, steps: 3 });
      await touch(ctx, 'touchEnd');
      await ctx.sleep(900);
      ctx.assert('拉过 0.35 屏高松手关闭', !(await isOpen(ctx)), await isOpen(ctx));
      // 速度判定：短距离快甩也关
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      // 等主线程闲下来再甩：CDP 每个触摸事件要等渲染进程回执，主线程忙时事件时间戳被拉开，会被当成「停住再抬手」
      await ctx.eval(`__pvqa.quiet(400, 6000)`, { timeout: 10000 }).catch(() => null);
      await ctx.eval(`(() => { const L = window.__qaPtr = []; const f = (e) => L.push(e.type.slice(7) + ':' + Math.round(e.clientY) + '@' + Math.round(e.timeStamp)); for (const ty of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) addEventListener(ty, f, true); window.__qaPtrOff = () => { for (const ty of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) removeEventListener(ty, f, true); }; return true; })()`);
      await ctx.g.swipe({ x: w * 0.5, y: h * 0.45 }, { x: w * 0.5, y: h * 0.45 + h * 0.1 }, { ms: 70, steps: 4, easing: false });
      await ctx.sleep(900);
      const flickOpen = await isOpen(ctx);
      const ptr = await ctx.eval(`(() => { window.__qaPtrOff?.(); return window.__qaPtr; })()`);
      ctx.assert('短距离快甩关闭', !flickOpen, flickOpen ? ptr : false);
    },
  },
  {
    id: 'img-touch-immersive',
    title: '触屏：单击切沉浸（纯黑底）、沉浸里翻页保持沉浸',
    tags: ['img', 'touch', 'chrome'], only: touchOnly,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' }), ...ctx.gallery('序列').slice(0, 2)], 0);
      ctx.assert('打开时不是沉浸', (await ctx.eval(`__ig.black()`)) === 0, await ctx.eval(`__ig.black()`));
      await ctx.g.tap(w / 2, h / 2);
      await ctx.sleep(700);
      const b1 = await ctx.eval(`__ig.black()`);
      ctx.assert('单击进沉浸（纯黑底）', b1 === 1, b1);
      ctx.assert('沉浸时顶栏收起', await ctx.eval(`(() => { const b = document.querySelector('.vw-bar'); return !b || __pvqa.effOpacity(b) < 0.05 || b.getBoundingClientRect().bottom <= 0; })()`), true);
      await ctx.shot('immersive');
      await ctx.g.swipe({ x: w * 0.8, y: h * 0.55 }, { x: w * 0.2, y: h * 0.55 }, { ms: 160, steps: 8 });
      await ctx.sleep(700);
      ctx.assert('沉浸里翻页保持沉浸', (await idx(ctx)) === 1 && (await ctx.eval(`__ig.black()`)) === 1, { index: await idx(ctx), black: await ctx.eval(`__ig.black()`) });
      await ctx.g.tap(w / 2, h / 2);
      await ctx.sleep(700);
      ctx.assert('再单击退出沉浸', (await ctx.eval(`__ig.black()`)) === 0, await ctx.eval(`__ig.black()`));
    },
  },
  {
    id: 'img-touch-svg',
    title: '触屏：svg 放大后清晰（停稳摘掉 will-change 重新栅格化）',
    tags: ['img', 'touch', 'svg'], only: touchOnly,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      await openPainted(ctx, [ctx.item('图片/矢量.svg', { kind: 'image' })]);
      await ctx.g.doubleTap(w / 2, h * 0.45);
      await ctx.sleep(900);
      const s = await st(ctx);
      const wc = await ctx.eval(`(() => { const b = __ig.slot(0).querySelector('.iv-box'); return b ? b.style.willChange : null; })()`);
      ctx.assert('svg 双击放大', (s?.effScale ?? 1) > 1.5, s?.effScale);
      ctx.assert('停稳后没有 will-change（按最终倍率栅格化）', !wc, wc);
      await ctx.shot('svg-zoomed');
    },
  },
  {
    id: 'img-swipe-same-node',
    title: '触屏：翻页只平移滑轨（下一张就是早已解码好的同一个 <img>，不重建、不淡入）',
    tags: ['img', 'touch', 'swipe'], only: touchOnly,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      const items = ctx.gallery('序列').slice(0, 6);
      await openPainted(ctx, items, 0);
      await ctx.waitFor(`(() => { const im = __ig.slot(1)?.querySelector('img.iv-img'); return im && im.complete && im.naturalWidth > 0 && getComputedStyle(im).opacity === '1'; })()`, 20000, '邻页已解码上屏');
      await ctx.eval(`(() => { __ig.slot(1).querySelector('img.iv-img').__qaMark = 1; return true; })()`);
      await ctx.eval(`(() => { const out = window.__opa = []; const t0 = performance.now(); const tick = () => { const im = __ig.slot(1)?.querySelector('img.iv-img'); out.push(im ? +getComputedStyle(im).opacity : -1); if (performance.now() - t0 < 900) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
      await ctx.g.swipe({ x: w * 0.8, y: h * 0.55 }, { x: w * 0.2, y: h * 0.55 }, { ms: 160, steps: 8 });
      await ctx.sleep(1000);
      const r = await ctx.eval(`({ index: __ig.idx(), same: __pvqa.mainImg()?.__qaMark === 1, minOpacity: Math.min(...window.__opa.filter((x) => x >= 0)), frames: window.__opa.length, gone: window.__opa.filter((x) => x < 0).length })`);
      ctx.metric('rail', r);
      ctx.assert('翻到下一张', r.index === 1, r.index);
      ctx.assert('当前图就是翻页前邻槽里那个元素（没重建）', r.same, r.same);
      ctx.assert('翻页全程不透明（不淡入）', r.minOpacity === 1 && r.gone === 0, r);
    },
  },
  {
    id: 'img-swipe-back',
    title: '触屏：反向侧滑（向前预载 2 张）松手到出图毫秒与空白帧（4G、CPU×4）',
    tags: ['img', 'touch', 'swipe'], only: touchOnly, timeout: 150000,
    async run(ctx) {
      const N = 5, start = 22;
      const items = ctx.gallery('序列', { origin: 'cloud' });
      await ctx.throttle({ cpu: 4, network: '4g' });
      await ctx.open(items, start);
      await setup(ctx);
      await ctx.waitFor(`__pvqa.itemPainted(${start})`, 30000, '首张出图');
      await ctx.sleep(2000);
      await ctx.eval(`__pvqa.quiet(1000, 15000)`, { timeout: 25000 }).catch(() => null);
      const { w, h } = ctx.cfg;
      const per = [];
      for (let k = 1; k <= N; k++) {
        await ctx.eval(`__pvqa.armSwipe(${start - k}, { timeout: 8000 })`);
        await ctx.g.swipe({ x: w * 0.2, y: h * 0.55 }, { x: w * 0.8, y: h * 0.55 }, { ms: 160, steps: 8 });
        per.push(await ctx.eval(`__pvqa.swipeResult()`, { timeout: 20000 }));
        await ctx.sleep(1500);
      }
      const ready = stats(per.map((r) => r.readyMs));
      ctx.metric('readyMs', ready);
      ctx.metric('blankFrames', per.reduce((s, r) => s + r.blankFrames, 0));
      ctx.metric('_perSwipe', per);
      ctx.assert('每一划都翻到上一张', per.every((r) => r.index === r.target), per.map((r) => r.index));
      ctx.assert('零空白帧', per.every((r) => r.blankFrames === 0), per.map((r) => r.blankFrames));
      ctx.assert('松手到出图中位数 < 100ms', (ready?.median ?? 1e9) < 100, ready?.median);
    },
  },

  // —— 两端 ——————————————————————————————————————————————————————————————
  {
    id: 'img-flip',
    title: 'FLIP：从缩略图原位放大打开、缩回原位关闭；翻到原位不在屏上的张则缩小淡出',
    tags: ['img', 'flip'],
    async run(ctx) {
      const { w, h } = ctx.cfg;
      const o = ctx.touch ? { x: 24, y: 220, w: 110, h: 110 } : { x: 220, y: 160, w: 128, h: 96 };
      const it = { ...ctx.item(BIG, { kind: 'image' }), originRect: o };
      const it2 = { ...ctx.gallery('序列')[0], originRect: { x: -400, y: -400, w: 100, h: 100 } };
      await setup(ctx);
      await ctx.eval(`(() => { window.__flipOpen = []; const t0 = performance.now(); const tick = () => { const s = document.querySelector('[data-pv-slot="0"] .iv-box'); if (s) { const r = s.getBoundingClientRect(); window.__flipOpen.push({ t: Math.round(performance.now() - t0), cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, op: +__pvqa.effOpacity(s).toFixed(3) }); } if (performance.now() - t0 < 2500) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
      await ctx.open([it, it2], 0);
      await setup(ctx);
      await ctx.waitFor(`__pvqa.itemPainted(0)`, 30000, '出图');
      await ctx.sleep(900);
      const fr = await ctx.eval(`window.__flipOpen`);
      const vis = fr.filter((f) => f.op > 0.05 && f.w > 0);
      const first = vis[0], last = vis[vis.length - 1];
      ctx.metric('open', { frames: vis.length, first, last });
      const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
      ctx.assert('打开首个可见帧在缩略图原位（中心误差 ≤ 24px）', first && Math.hypot(first.cx - ocx, first.cy - ocy) <= 24, first && { dx: Math.round(first.cx - ocx), dy: Math.round(first.cy - ocy) });
      ctx.assert('打开首个可见帧是缩略图大小（≤ 盖满缩略图的宽 × 1.15）', first && last && first.w <= Math.max(o.w, o.h * last.w / last.h) * 1.15 + 2, first && last && +(first.w / last.w).toFixed(3));
      ctx.assert('打开过程有中间帧（不是一跳到位）', vis.filter((f) => f.w > first.w * 1.1 && f.w < last.w * 0.9).length >= 3, vis.length);
      // 关闭：电脑 Esc；触屏下拉
      await ctx.eval(`__ig.rec(0, 1400)`);
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.5, y: h * 0.45 }, { x: w * 0.5, y: h * 0.75 }, { ms: 180, steps: 8 });
      else await ctx.g.key('escape');
      await ctx.sleep(1500);
      const cr = (await ctx.eval(`__ig.recOut`)).filter((f) => f.b && f.b.op > 0.05);
      const cl = cr[cr.length - 1]?.b;
      ctx.metric('close', { frames: cr.length, last: cl });
      ctx.assert('关闭后查看器收起', !(await isOpen(ctx)), await isOpen(ctx));
      // 缩回的尺寸 = 盖满缩略图的倍率（方形宫格缩略图是居中裁切的，图按 cover 缩到能盖住它）
      const kCover = last ? Math.max(o.w / last.w, o.h / last.h) : 0;
      ctx.assert('关闭最后可见帧缩回原位（中心误差 ≤ 24px、宽 ≤ 盖满缩略图的宽 × 1.15）', cl && last && Math.hypot(cl.cx - ocx, cl.cy - ocy) <= 24 && cl.w <= last.w * kCover * 1.15 + 2, cl && { dx: Math.round(cl.cx - ocx), dy: Math.round(cl.cy - ocy), k: +(cl.w / last.w).toFixed(3), kCover: +kCover.toFixed(3) });
      // 翻到第二张（原位在屏外）再关：原地缩小淡出
      await ctx.open([it, it2], 0);
      await setup(ctx);
      await ctx.waitFor(`__pvqa.itemPainted(0)`, 30000, '出图');
      await ctx.sleep(600);
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.8, y: h * 0.55 }, { x: w * 0.2, y: h * 0.55 }, { ms: 160, steps: 8 });
      else await ctx.g.key('arrowright');
      await ctx.waitFor(`__pvqa.itemPainted(1)`, 20000, '第二张出图');
      await ctx.sleep(700);
      const b2 = await ctx.eval(`__ig.boxRect(1)`);
      await ctx.eval(`__ig.rec(1, 900)`);
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.5, y: h * 0.45 }, { x: w * 0.5, y: h * 0.75 }, { ms: 180, steps: 8 });
      else await ctx.g.key('escape');
      await ctx.sleep(1000);
      const fr2 = (await ctx.eval(`__ig.recOut`)).filter((f) => f.b);
      const minOp = Math.min(...fr2.map((f) => f.b.op));
      const lastB = fr2.filter((f) => f.b.op > 0.05).pop()?.b;
      ctx.metric('fadeClose', { frames: fr2.length, minOp, last: lastB, start: b2 });
      ctx.assert('原位不在屏上：没往屏外飞（最后可见帧中心仍在屏内）', lastB && lastB.cx > 0 && lastB.cx < w && lastB.cy > 0 && lastB.cy < h, lastB && [Math.round(lastB.cx), Math.round(lastB.cy)]);
      ctx.assert('原位不在屏上：淡出', fr2.length > 2 && minOp < 0.5, minOp);
    },
  },
  {
    id: 'img-anim',
    title: '动图：gif / webp / APNG 用原图播放（不被预览档压成静帧）',
    tags: ['img', 'anim'], timeout: 90000,
    async run(ctx) {
      const out = {};
      for (const rel of ['图片/动图.gif', '图片/动图.webp', '图片/动图-APNG.png']) {
        await openPainted(ctx, [ctx.item(rel, { kind: 'image' })]);
        const src = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.complete && s.nw > 0 && !/[?&]thumb=/.test(s.src) && getComputedStyle(__pvqa.mainImg()).opacity === '1' ? s.src : null; })()`, 15000, '原图上屏').catch(() => null);
        // canvas drawImage 对动图按规范只取首帧，量不出在不在动：改为对主图区域连拍 4 张屏幕截图比对
        const box = await ctx.eval(`(() => { const r = __pvqa.mainImg().getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, 600), height: Math.min(r.height, 600), scale: 0.25 }; })()`);
        const sigs = [];
        for (let k = 0; k < 4; k++) { const shot = await ctx.pg.send('Page.captureScreenshot', { format: 'png', clip: box }); sigs.push(String(shot?.data || '').length + ':' + hash(String(shot?.data || ''))); await ctx.sleep(230); }
        const name = rel.split('/').pop();
        out[name] = { full: !!src, frames: new Set(sigs).size };
        ctx.assert(name + ' 主图是原图', !!src, src && src.replace(/^.*\?/, '?').slice(0, 80));
        ctx.assert(name + ' 在动（4 次取样至少 2 种帧）', new Set(sigs).size >= 2, sigs);
        await ctx.close(); await ctx.sleep(300);
      }
      ctx.metric('anim', out);
    },
  },
  {
    id: 'img-exif-info',
    title: '文件信息：尺寸、拍摄时间、相机（EXIF）',
    tags: ['img', 'info'],
    async run(ctx) {
      await openPainted(ctx, [ctx.item('图片/相机EXIF.jpg', { kind: 'image' })]);
      await ctx.g.key('alt+enter');
      const txt = await ctx.waitFor(`(() => { const el = document.querySelector('.vw-info'); const t = el && el.innerText; return t && t.includes('拍摄时间') && t.includes('相机') ? t : null; })()`, 12000, '信息面板 EXIF 行').catch(async () => ctx.eval(`document.querySelector('.vw-info')?.innerText || ''`));
      ctx.metric('info', String(txt || '').replace(/\n+/g, ' | ').slice(0, 400));
      ctx.assert('信息里有尺寸', /尺寸/.test(txt || '') && /\d+ × \d+/.test(txt || ''), null);
      ctx.assert('信息里有拍摄时间', /拍摄时间/.test(txt || ''), null);
      ctx.assert('信息里有相机', /相机/.test(txt || ''), null);
      await ctx.shot('info');
    },
  },
  {
    id: 'img-error',
    title: '加载失败：给出错误态，照样能滑走、翻回、关闭',
    tags: ['img', 'error'],
    async run(ctx) {
      const { w, h } = ctx.cfg;
      const seq = ctx.gallery('序列');
      const items = [seq[0], ctx.item('图片/不存在-404.jpg', { kind: 'image' }), seq[1]];
      await ctx.open(items, 1);
      await setup(ctx);
      const err = await ctx.waitFor(`!!__ig.slot(1)?.querySelector('.iv-err')`, 15000, '错误态').catch(() => false);
      ctx.assert('显示加载失败', err, err);
      await ctx.shot('error');
      const next = async () => { if (ctx.touch) await ctx.g.swipe({ x: w * 0.8, y: h * 0.3 }, { x: w * 0.2, y: h * 0.3 }, { ms: 160, steps: 8 }); else await ctx.g.key('arrowright'); await ctx.sleep(700); };
      const prev = async () => { if (ctx.touch) await ctx.g.swipe({ x: w * 0.2, y: h * 0.3 }, { x: w * 0.8, y: h * 0.3 }, { ms: 160, steps: 8 }); else await ctx.g.key('arrowleft'); await ctx.sleep(700); };
      await next();
      ctx.assert('失败页能滑走', (await idx(ctx)) === 2, await idx(ctx));
      await ctx.waitFor(`__pvqa.itemPainted(2)`, 15000, '下一张出图').catch(() => null);
      await prev();
      ctx.assert('能翻回失败页', (await idx(ctx)) === 1, await idx(ctx));
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.5, y: h * 0.3 }, { x: w * 0.5, y: h * 0.65 }, { ms: 180, steps: 8 });
      else await ctx.g.key('escape');
      await ctx.sleep(900);
      ctx.assert('失败页能关闭', !(await isOpen(ctx)), await isOpen(ctx));
    },
  },
  {
    id: 'img-mixed-video',
    title: '混排：视频页在滑轨里先是海报 + 播放钮，停稳才挂播放器，切走即卸载',
    tags: ['img', 'mixed'], timeout: 90000,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      const items = ctx.gallery('混排', { kind: null, filter: /\.(jpe?g|mp4)$/i });
      const vi = items.findIndex((x) => /\.mp4$/i.test(x.name));
      ctx.assert('混排里有视频', vi > 0, vi);
      await openPainted(ctx, items, vi - 1);
      const before = await ctx.eval(`({ ph: !!__ig.slot(${vi})?.querySelector('.iv-vid'), play: !!__ig.slot(${vi})?.querySelector('.iv-play'), video: document.querySelectorAll('.ig video').length })`);
      ctx.assert('邻页视频是占位（海报 + 播放钮、没有 <video>）', before.ph && before.play && before.video === 0, before);
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.8, y: h * 0.4 }, { x: w * 0.2, y: h * 0.4 }, { ms: 160, steps: 8 });
      else await ctx.g.key('arrowright');
      const mounted = await ctx.waitFor(`__ig.idx() === ${vi} && !!__ig.slot(${vi})?.querySelector('video')`, 5000, '停稳挂播放器').then(() => true, () => false);
      ctx.assert('停稳在视频页才挂播放器', mounted, await ctx.eval(`({ index: __ig.idx(), video: document.querySelectorAll('.ig video').length })`));
      await ctx.sleep(800);
      await ctx.shot('video-page');
      // 从视频页横滑走（视频线：播放器作画廊页时把水平滑交给画廊）；电脑：混排画廊里 ←/→ 始终翻页（Windows 照片 / Google 相册），
      // 视频页的快退 / 快进在画廊里用 J / L
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.8, y: h * 0.4 }, { x: w * 0.2, y: h * 0.4 }, { ms: 160, steps: 8 });
      else await ctx.g.key('arrowright');
      await ctx.sleep(900);
      const after = await ctx.eval(`({ index: __ig.idx(), video: document.querySelectorAll('.ig video').length })`);
      ctx.assert('从视频页翻走', after.index === vi + 1, after, { level: ctx.touch ? 'goal' : 'must' });
      if (after.index === vi + 1) ctx.assert('切走即卸载播放器', after.video === 0, after);
      if (!ctx.touch && after.index === vi + 1) {
        // 电脑：PgUp / PgDn 在所有类型里都是「换文件」（视频页学会的 PgDn 到图片页照样管用）；视频页底栏 = 播放条 + 缩略图条
        await ctx.g.key('pageup');
        const pu = await ctx.waitFor(`__ig.idx() === ${vi} && !!document.querySelector('.vw-bottom .vp-bar') ? { index: __ig.idx(), strip: !!document.querySelector('.vw-bottom .ig-strip') } : null`, 5000, 'PgUp 回到视频页').catch(() => null);
        ctx.assert('图片页 PgUp 换到上一项（视频页）', pu?.index === vi, pu);
        ctx.assert('混排视频页留着缩略图条（和播放条叠放）', !!pu?.strip, pu);
        await ctx.g.key('pagedown');
        const pd = await ctx.waitFor(`__ig.idx() === ${vi + 1}`, 5000, 'PgDn 翻走').then(() => true, () => false);
        ctx.assert('视频页 PgDn 换到下一项', pd, await ctx.eval(`__ig.idx()`));
      }
    },
  },
  {
    id: 'img-resize',
    title: '尺寸变化（转屏 / 拖窗口）：适应框跟着重排、放大态钳回界内',
    tags: ['img', 'resize'],
    async run(ctx) {
      const { w, h } = ctx.cfg;
      await openPainted(ctx, [ctx.item(BIG, { kind: 'image' })]);
      const W2 = ctx.touch ? h : Math.round(w * 0.6), H2 = ctx.touch ? w : h;
      await emulate(ctx.pg, ctx.cfg, { w: W2, h: H2 });
      await ctx.sleep(700);
      const s = await st(ctx);
      const fits = s && s.rect.w <= W2 + 1 && s.rect.h <= H2 + 1 && (Math.abs(s.rect.w - W2) <= 2 || Math.abs(s.rect.h - H2) <= 2);
      ctx.assert('换尺寸后重新适应（contain）', fits, s && { rect: s.rect, W2, H2 });
      ctx.assert('换尺寸后居中', s && Math.abs(s.cx - W2 / 2) <= 2, s?.cx);
      await ctx.shot('resized');
      // 放大到很大再缩窗：视图钳回界内（图边不离开窗口边）
      if (ctx.touch) await ctx.g.doubleTap(W2 * 0.8, H2 * 0.5); else for (let k = 0; k < 4; k++) await ctx.g.key('+');
      await ctx.sleep(700);
      await emulate(ctx.pg, ctx.cfg);
      await ctx.sleep(700);
      const z = await st(ctx);
      ctx.assert('放大态缩窗后钳回界内', z && z.rect.x <= 1 && z.rect.x + z.rect.w >= w - 1, z && { left: z.rect.x, right: z.rect.x + z.rect.w, w });
    },
    async cleanup(ctx) { await emulate(ctx.pg, ctx.cfg); },
  },
  {
    id: 'img-reduced-motion',
    title: '减弱动效：翻页直接到位、点按照常响应',
    tags: ['img', 'a11y'],
    async run(ctx) {
      const { w, h } = ctx.cfg;
      await emulate(ctx.pg, ctx.cfg, { reducedMotion: true });
      await openPainted(ctx, ctx.gallery('序列').slice(0, 4), 0);
      if (ctx.touch) await ctx.g.swipe({ x: w * 0.8, y: h * 0.55 }, { x: w * 0.2, y: h * 0.55 }, { ms: 160, steps: 8 });
      else await ctx.g.key('arrowright');
      await ctx.sleep(120);
      const rail = await ctx.eval(`(() => { const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ig-rail')).transform); const P = Math.round(document.querySelector('.ig').clientWidth + 20); return { index: __ig.idx(), pos: +(-m.e / P).toFixed(3) }; })()`);
      ctx.assert('翻页直接到位（无弹簧过程）', rail.index === 1 && Math.abs(rail.pos - 1) < 0.002, rail);
      if (ctx.touch) {
        await ctx.sleep(300);
        await ctx.g.tap(w / 2, h / 2);
        await ctx.sleep(500);
        ctx.assert('翻页后第一下单击照常切沉浸', (await ctx.eval(`__ig.black()`)) === 1, await ctx.eval(`__ig.black()`));
      }
    },
    async cleanup(ctx) { await emulate(ctx.pg, ctx.cfg); },
  },
];
