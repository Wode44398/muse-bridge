// 文件列表与显示方式（痛点③：手机没有大图标）。都走真实的文件页（ui.screen = 'files'），不直接调 openPreview。
// 手机（触屏档 → FilesPanel）：相册类文件夹默认图标视图、图标 / 大图标的列数与方格、缩略图真解码、视频时长角标、
//   排序后点开的画廊顺序与列表一致（图片视频混排、PDF 不混进来）、originRect、关查看器后滚回并高亮、
//   长按菜单的缩略图头 +「预览」、多选勾、视图偏好落盘。
// 电脑（精确指针 + 宽 ≥1024 → FilesDesktop）：列头排序、空格快速查看（方向键翻、空格关、关后选中并高亮）、
//   Ctrl+滚轮逐档换图标大小（不触发整页缩放）、Alt+P 预览窗格（默认关、带分辨率 / 时长）。
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const PREFS = ['bridge.files.view', 'bridge.files.sort', 'bridge.fd.prefs'];

/** 进文件页的某个样张目录：先回主页再进（组件重挂、一次性路径 ui.filesPath 才会被消费）；reset = 清掉视图 / 排序偏好 */
async function gotoFiles(ctx, rel, { reset = false } = {}) {
  await ctx.eval(`(async () => {
    const s = await import('/src/lib/state.svelte.js');
    ${reset ? `for (const k of ${JSON.stringify(PREFS)}) localStorage.removeItem(k);` : ''}
    if (s.ui.screen === 'files') { s.ui.screen = 'home'; await new Promise((r) => setTimeout(r, 200)); }
    s.ui.filesPath = ${JSON.stringify(ctx.samplesRel + '/' + rel)};
    s.ui.screen = 'files';
    return 1;
  })()`, { timeout: 10000 });
}
async function leaveFiles(ctx) {
  await ctx.eval(`(async () => { const s = await import('/src/lib/state.svelte.js'); s.ui.screen = 'home'; return 1; })()`).catch(() => {});
}
/** 等元素真的接得住点按：中心点命中它自己（刚开页时启动画面还在淡出，整页暂不接点按） */
const hittable = (ctx, sel, ms = 8000) => ctx.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!h && (h === e || e.contains(h)); })()`, ms, '可点：' + sel);
const sizesOf = (ctx, dir) => Object.fromEntries(readdirSync(path.join(ctx.samplesDir, dir)).map((n) => [n, statSync(path.join(ctx.samplesDir, dir, n)).size]));
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// —— 手机：FilesPanel 的网格状态 ——
const PHONE = `(() => {
  const root = document.querySelector('.ws-root'); if (!root) return null;
  const sc = root.querySelector('.scroll'); if (!sc) return null;
  const cs = [...root.querySelectorAll('.cgrid .cell:not(.dir)')];
  const list = root.querySelectorAll('.filecard .frow').length;
  if (!cs.length) return { n: 0, list, cw: sc.clientWidth };
  const r0 = cs[0].getBoundingClientRect();
  const cols = cs.filter((c) => Math.abs(c.getBoundingClientRect().top - r0.top) < 2).length;
  const tile = cs[0].querySelector('.tile').getBoundingClientRect();
  const sb = sc.getBoundingClientRect();
  const vis = cs.filter((c) => { const b = c.getBoundingClientRect(); return b.bottom > sb.top && b.top < sb.bottom; });
  const th = vis.map((c) => c.querySelector('img.cthumb')).filter(Boolean);
  const nm = cs[0].querySelector('.nm');
  return { n: cs.length, list, cw: sc.clientWidth, lg: !!root.querySelector('.cgrid.big'), cols, tw: Math.round(tile.width), th: Math.round(tile.height),
    vis: vis.length, thumbs: th.length, loaded: th.filter((i) => i.complete && i.naturalWidth > 0).length,
    bad: vis.filter((c) => c.querySelector('.tile.bad')).length,
    tier: th[0] ? ((th[0].getAttribute('src') || '').match(/thumb=([^&]+)/) || [])[1] || '' : '',
    nw: th[0] ? th[0].naturalWidth : 0,
    // 清晰度看短边（方格是 cover 裁切）：可视缩略图短边 / 格宽的中位数
    sharp: (() => { const q = th.filter((i) => i.naturalWidth > 0).map((i) => Math.min(i.naturalWidth, i.naturalHeight) / tile.width).sort((a, b) => a - b); return q.length ? +q[q.length >> 1].toFixed(2) : 0; })(),
    clamp: nm ? getComputedStyle(nm).webkitLineClamp : '',
    dur: root.querySelectorAll('.cgrid .cell .dur').length, scrollTop: Math.round(sc.scrollTop),
    names: cs.map((c) => c.querySelector('.nm')?.textContent || '') };
})()`;
const phone = (ctx) => ctx.eval(PHONE);
const waitPhone = (ctx, cond, ms, what) => ctx.waitFor(`(() => { const s = ${PHONE}; return s && (${cond}) ? s : null; })()`, ms, what);
// 容器查询断点（FilesPanel .cgrid）：<560 三列 / 大图标两列，每过一档各加一列
const expCols = (cw, lg) => (cw >= 980 ? 6 : cw >= 760 ? 5 : cw >= 560 ? 4 : 3) - (lg ? 1 : 0);

// MorphMenu 的根节点常驻 DOM、关着时只是 visibility:hidden：「开着的那个菜单」按这个认，别的菜单的条目不算
const MM_OPEN = '.mm:not([style*="hidden"])';
/** 顶栏「显示方式」→ 菜单项（MorphMenu），等菜单真的收起 */
async function phoneMenu(ctx, label) {
  await ctx.g.tapSel('.ws-root button[aria-label="显示方式"]');
  await ctx.waitFor(`!!document.querySelector('${MM_OPEN} .mm-it')`, 5000, '显示方式菜单');
  await ctx.sleep(450);
  await ctx.g.tapSel('.mm-it', { text: label, within: `${MM_OPEN} > .mm-clip` });
  const t0 = Date.now();
  await ctx.waitFor(`!document.querySelector('${MM_OPEN}')`, 4000, '菜单收起');
  const hideMs = Date.now() - t0;
  // 菜单看不见之后挡板还接不接点按（收尾期间它照挡，挡久了下一下点按会被吃掉）
  await ctx.waitFor(`![...document.querySelectorAll('.mm-barrier')].some((b) => getComputedStyle(b).pointerEvents !== 'none' && getComputedStyle(b).visibility === 'visible')`, 4000, '挡板撤掉');
  ctx.metric('menuClose:' + label, { hideMs, barrierMs: Date.now() - t0 });
  await ctx.sleep(100);
}
const PV = `(() => { const p = __pvqa.pv.preview; return { open: p.open, index: p.index, items: p.items.map((x) => ({ name: x.name, kind: x.kind, dur: x.duration || 0, w: x.width || 0, h: x.height || 0, size: x.size || 0, rect: x.originRect ? { x: x.originRect.x, y: x.originRect.y, w: x.originRect.w, h: x.originRect.h } : null, thumb: !!x.thumbUrl })) }; })()`;

/** 触屏关查看器：先下滑（真手势），没关上再按 Esc 兜底；返回用的哪一种 */
async function phoneClose(ctx) {
  const { w, h } = ctx.cfg;
  await ctx.g.swipe({ x: w * 0.5, y: h * 0.42 }, { x: w * 0.52, y: h * 0.9 }, { ms: 260, steps: 14 });
  try { await ctx.waitFor(`!__pvqa.pv.preview.open`, 2500, '下滑关闭'); return 'swipe'; } catch {}
  await ctx.g.key('escape');
  await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, 'Esc 关闭');
  return 'escape';
}

const phoneScenarios = [
  {
    id: 'files-phone-icons',
    title: '手机：相册类文件夹默认图标视图，图标 / 大图标列数、方格、缩略图，偏好落盘',
    tags: ['files', 'phone'],
    only: (cfg) => cfg.touch,
    timeout: 120000,
    async run(ctx) {
      await gotoFiles(ctx, '图片', { reset: true });
      let s = await waitPhone(ctx, 's.n > 0 || s.list > 0', 20000, '图片目录列出');
      ctx.assert('相册类文件夹默认图标视图', s.n > 0 && !s.lg && s.list === 0, { n: s.n, list: s.list });
      s = await waitPhone(ctx, 's.thumbs > 0 && s.loaded + s.bad >= s.thumbs', 20000, '可视格缩略图解码').catch(() => s);
      ctx.metric('icons', { cw: s.cw, cols: s.cols, tile: `${s.tw}×${s.th}`, thumbs: `${s.loaded}/${s.thumbs}`, tier: s.tier, sharp: s.sharp, clamp: s.clamp });
      ctx.assert('图标视图列数', s.cols === expCols(s.cw, false), { cols: s.cols, expect: expCols(s.cw, false), cw: s.cw });
      ctx.assert('图标格是方格', Math.abs(s.tw - s.th) <= 1, `${s.tw}×${s.th}`);
      ctx.assert('可视格缩略图全部解码', s.thumbs > 0 && s.loaded === s.thumbs && s.bad === 0, { loaded: s.loaded, thumbs: s.thumbs, bad: s.bad });
      ctx.assert('名字最多两行', String(s.clamp) === '2', s.clamp, { level: 'info' });
      await ctx.shot('icons');

      await phoneMenu(ctx, '大图标');
      s = await waitPhone(ctx, 's.lg && s.thumbs > 0 && s.loaded + s.bad >= s.thumbs', 20000, '大图标缩略图').catch(async () => phone(ctx));
      ctx.metric('large', { cols: s.cols, tile: `${s.tw}×${s.th}`, thumbs: `${s.loaded}/${s.thumbs}`, tier: s.tier, sharp: s.sharp });
      ctx.assert('切到大图标', !!s.lg, s.lg);
      ctx.assert('大图标列数', s.cols === expCols(s.cw, true), { cols: s.cols, expect: expCols(s.cw, true) });
      ctx.assert('大图标格是方格', Math.abs(s.tw - s.th) <= 1, `${s.tw}×${s.th}`);
      ctx.assert('大图标走 grid 档缩略图', s.tier === 'grid', s.tier);
      ctx.assert('大图标缩略图够清楚（短边中位数 ≥ 格宽 × 2）', s.sharp >= 2, s.sharp, { level: 'goal' });
      await ctx.sleep(800);   // 顶栏按钮还在「弹一下」，停稳再拍
      await ctx.shot('large');

      // 落盘：重进同一目录还是大图标；非相册目录仍是列表
      await gotoFiles(ctx, '文档');
      const d = await waitPhone(ctx, 's.n > 0 || s.list > 0', 15000, '文档目录');
      ctx.assert('非相册目录仍是列表', d.list > 0 && d.n === 0, { list: d.list, n: d.n });
      await gotoFiles(ctx, '图片');
      const back = await waitPhone(ctx, 's.n > 0 || s.list > 0', 15000, '重进图片目录');
      ctx.assert('相册目录的视图偏好落盘', !!back.lg, back.lg);
    },
    cleanup: leaveFiles,
  },
  {
    id: 'files-phone-gallery',
    title: '手机：混排目录排序后点开，画廊顺序与列表一致、图片视频混排、时长与 originRect，关后高亮',
    tags: ['files', 'phone'],
    only: (cfg) => cfg.touch,
    timeout: 120000,
    async run(ctx) {
      await gotoFiles(ctx, '混排', { reset: true });
      let s = await waitPhone(ctx, 's.n >= 9', 20000, '混排目录');
      s = await waitPhone(ctx, 's.dur >= 2', 20000, '视频时长角标').catch(() => s);
      ctx.assert('视频格出时长角标', s.dur >= 2, s.dur);
      await phoneMenu(ctx, '名称');   // 名称升序再点一下 = 降序
      s = await waitPhone(ctx, `s.names[0] === '混排-12.pdf'`, 5000, '按名称降序').catch(async () => phone(ctx));
      ctx.metric('order', s.names);
      ctx.assert('按名称降序（自然序）', sameList(s.names, ['混排-12.pdf', '混排-11.jpg', '混排-09.jpg', '混排-08.mp4', '混排-07.jpg', '混排-05.jpg', '混排-04.mp4', '混排-03.jpg', '混排-01.jpg']), s.names);
      const cell = `.ws-root .cgrid .cell:not(.dir)`;
      const tileRect = await ctx.eval(`(() => { const c = [...document.querySelectorAll(${JSON.stringify(cell)})].find((e) => e.querySelector('.nm')?.textContent === '混排-11.jpg'); const b = c.querySelector('.tile').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
      await ctx.g.tapSel(cell, { text: '混排-11.jpg' });
      await ctx.waitFor(`__pvqa.pv.preview.open && __pvqa.root()`, 8000, '查看器打开');
      const p = await ctx.eval(PV);
      const want = s.names.filter((n) => /\.(jpg|mp4)$/.test(n));
      ctx.metric('seq', p.items.map((x) => x.name));
      ctx.assert('画廊顺序 = 列表顺序（PDF 不混进来）', sameList(p.items.map((x) => x.name), want) && p.index === 0, { index: p.index, n: p.items.length });
      ctx.assert('图片与视频同一序列', p.items.some((x) => x.kind === 'video') && p.items.some((x) => x.kind === 'image'), p.items.map((x) => x.kind).join(','));
      const vids = p.items.filter((x) => x.kind === 'video');
      ctx.assert('视频描述符带时长', vids.length && vids.every((x) => x.dur > 0), vids.map((x) => x.dur));
      ctx.assert('描述符带大小与宽高', p.items.every((x) => x.size > 0) && p.items.filter((x) => x.kind === 'image').every((x) => x.w > 0 && x.h > 0), p.items.map((x) => `${x.w}×${x.h}`).join(','));
      const r = p.items[p.index].rect;
      ctx.metric('originRect', { got: r, tile: tileRect });
      ctx.assert('originRect 对上点中的格子', !!r && Math.abs(r.x - tileRect.x) <= 4 && Math.abs(r.y - tileRect.y) <= 4 && Math.abs(r.w - tileRect.w) <= 4, r);
      await ctx.waitFor(`__pvqa.itemPainted(${p.index})`, 15000, '首张画出').catch(() => {});
      await ctx.shot('viewer');
      const { w, h } = ctx.cfg;
      await ctx.g.swipe({ x: w * 0.8, y: h * 0.55 }, { x: w * 0.2, y: h * 0.55 }, { ms: 160, steps: 8 });
      await ctx.waitFor(`__pvqa.pv.preview.index === 1`, 4000, '左滑到下一张').catch(() => {});
      const i1 = await ctx.eval(`__pvqa.pv.preview.index`);
      ctx.assert('左滑翻到下一张', i1 === 1, i1);
      await ctx.sleep(1200);
      ctx.metric('closeVia', await phoneClose(ctx));
      const fl = await ctx.waitFor(`(() => { const c = document.querySelector('.ws-root .cell.flash'); return c ? c.querySelector('.nm')?.textContent : null; })()`, 3000, '关后高亮').catch(() => null);
      ctx.assert('关后高亮最后看的那一格', fl === want[1], fl);
      await ctx.shot('closed');
    },
    cleanup: leaveFiles,
  },
  {
    id: 'files-phone-reveal',
    title: '手机：长序列翻到屏外一项再关，列表滚回那一格并高亮',
    tags: ['files', 'phone'],
    only: (cfg) => cfg.touch,
    timeout: 120000,
    async run(ctx) {
      await gotoFiles(ctx, '序列', { reset: true });
      const s = await waitPhone(ctx, 's.n >= 60', 20000, '序列目录');
      ctx.assert('60 张序列走图标视图', s.n >= 60 && !s.lg, s.n);
      await ctx.g.tapSel('.ws-root .cgrid .cell:not(.dir)', { text: '序列-001.jpg' });
      await ctx.waitFor(`__pvqa.pv.preview.open && __pvqa.pv.preview.items.length >= 60`, 8000, '查看器打开（整个序列）');
      for (let i = 0; i < 39; i++) { await ctx.g.key('arrowright'); await ctx.sleep(70); }
      const idx = await ctx.waitFor(`__pvqa.pv.preview.index >= 39 ? __pvqa.pv.preview.index : 0`, 5000, '翻到第 40 张').catch(() => null);
      ctx.metric('index', idx);
      await ctx.sleep(500);
      await ctx.g.key('escape');
      await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, '关闭');
      const st = await ctx.waitFor(`(() => { const sc = document.querySelector('.ws-root .scroll'); const c = document.querySelector('.ws-root .cell.flash'); if (!c) return null; const b = c.getBoundingClientRect(), r = sc.getBoundingClientRect();
        return { name: c.querySelector('.nm')?.textContent, top: Math.round(b.top - r.top), bottom: Math.round(r.bottom - b.bottom), scrollTop: Math.round(sc.scrollTop) }; })()`, 3000, '高亮格').catch(() => null);
      ctx.metric('reveal', st);
      ctx.assert('高亮的是最后看的那张', st?.name === '序列-040.jpg', st?.name);
      ctx.assert('列表滚到了那一格（在可视区内）', !!st && st.scrollTop > 0 && st.top >= -1 && st.bottom >= -1, st);
      await ctx.shot('reveal');
    },
    cleanup: leaveFiles,
  },
  {
    id: 'files-phone-menu',
    title: '手机：长按菜单缩略图头 +「预览」，多选勾',
    tags: ['files', 'phone'],
    only: (cfg) => cfg.touch,
    // 触屏长按借 setEmitTouchEventsForMouse 补 contextmenu，之后截图前那一下 mouseMoved 的回执会挂到 30 秒超时（gestures.mjs 的老坑），两张图就一分钟
    timeout: 200000,
    async run(ctx) {
      await gotoFiles(ctx, '图片', { reset: true });
      await waitPhone(ctx, 's.n > 0', 20000, '图片目录');
      // 挑第三排的格子：最后一排压在悬浮标签栏底下，手指按不到
      await ctx.g.longPressSel('.ws-root .cgrid .cell:not(.dir)', { text: '透明.png' });
      const m = await ctx.waitFor(`(() => { const h = document.querySelector('${MM_OPEN} .mhead'); const its = h ? [...h.closest('.mm').querySelectorAll('.mm-it')] : []; if (!h || !its.length) return null;
        const im = h.querySelector('img.mh-img'); return { name: h.querySelector('.mh-nm')?.textContent, img: !!im && im.complete && im.naturalWidth > 0, items: its.map((e) => e.querySelector('.mm-lbl')?.firstChild?.textContent || '') }; })()`, 6000, '长按菜单').catch(() => null);
      await ctx.waitFor(`(() => { const im = document.querySelector('.mhead img.mh-img'); return im && im.complete && im.naturalWidth > 0; })()`, 6000, '菜单头缩略图').catch(() => {});
      const headImg = await ctx.eval(`(() => { const im = document.querySelector('.mhead img.mh-img'); return !!im && im.complete && im.naturalWidth > 0; })()`);
      ctx.metric('menu', m);
      ctx.assert('长按菜单头是这个文件', m?.name === '透明.png', m?.name);
      ctx.assert('菜单头缩略图解码', headImg, headImg);
      ctx.assert('菜单第一项是「预览」', m?.items?.[0] === '预览', m?.items?.slice(0, 4));
      await ctx.sleep(400);
      await ctx.shot('menu');
      await ctx.g.tapSel('.mm-it', { text: '预览', within: `${MM_OPEN} > .mm-clip` });
      const p = await ctx.waitFor(`__pvqa.pv.preview.open ? (${PV}) : null`, 8000, '「预览」打开查看器').catch(() => null);
      ctx.assert('「预览」打开的是这一张、在整个目录的图片里翻', !!p && p.items[p.index]?.name === '透明.png' && p.items.length > 5, p && { name: p.items[p.index]?.name, n: p.items.length });
      await ctx.g.key('escape');
      await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, '关闭').catch(() => {});
      await ctx.sleep(600);
      await phoneMenu(ctx, '多选');
      const cell = '.ws-root .cgrid .cell:not(.dir)';
      await ctx.g.tapSel(cell, { text: '动图.gif' });
      await ctx.sleep(200);
      await ctx.g.tapSel(cell, { text: '矢量.svg' });
      await ctx.sleep(300);
      // ring：选中格的描边必须画在格子里面（.cell 带 content-visibility 会裁掉格子外的 box-shadow，只剩底边一截）
      const sel = await ctx.eval(`({ all: document.querySelectorAll('.ws-root .cgrid .cell .selc').length, on: document.querySelectorAll('.ws-root .cgrid .cell .selc.on').length, open: __pvqa.pv.preview.open,
        ring: [...document.querySelectorAll('.ws-root .cgrid .cell.sel .tile')].map((t) => getComputedStyle(t, '::after').boxShadow) })`);
      ctx.metric('select', sel);
      ctx.assert('多选：每格出勾选圈、点两格勾上两格、不打开查看器', sel.all > 5 && sel.on === 2 && !sel.open, sel);
      ctx.assert('选中描边画在格子内侧（不被 content-visibility 裁掉）', sel.ring.length === 2 && sel.ring.every((s) => s.includes('inset') && !s.startsWith('none')), sel.ring);
      await ctx.shot('select');
    },
    cleanup: leaveFiles,
  },
];

// —— 电脑：FilesDesktop ——
const DESK = `(() => {
  const el = document.querySelector('.fd-root .fd-rows'); if (!el) return null;
  const tiles = [...el.querySelectorAll('.tile')], rows = [...el.querySelectorAll('.row')];
  const box = el.getBoundingClientRect();
  const vis = tiles.filter((t) => { const b = t.getBoundingClientRect(); return b.bottom > box.top && b.top < box.bottom; });
  const imgs = vis.map((t) => t.querySelector('.tic-img')).filter(Boolean);
  const tic = tiles[0]?.querySelector('.tic')?.getBoundingClientRect();
  const r0 = tiles[0]?.getBoundingClientRect();
  return { grid: el.classList.contains('grid'), tile: el.style.getPropertyValue('--tile'), n: tiles.length, rows: rows.length,
    cols: tiles.length ? tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - r0.top) < 2).length : 0,
    tic: tic ? Math.round(tic.width) + '×' + Math.round(tic.height) : '', vis: vis.length, imgs: imgs.length,
    loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    // 桌面图标是等比 contain（Finder 式），清晰度看长边：可视缩略图长边的中位数
    nw: (() => { const q = imgs.filter((i) => i.naturalWidth > 0).map((i) => Math.max(i.naturalWidth, i.naturalHeight)).sort((a, b) => a - b); return q.length ? q[q.length >> 1] : 0; })(), dpr: devicePixelRatio,
    zoom: document.querySelector('.fd-root .st-zoom')?.value ?? null, vv: window.visualViewport ? visualViewport.scale : 1,
    names: (tiles.length ? tiles : rows).map((e) => (e.dataset.rel || '').split('/').pop()),
    sel: [...el.querySelectorAll('.sel')].map((e) => (e.dataset.rel || '').split('/').pop()),
    flash: [...el.querySelectorAll('.flash')].map((e) => (e.dataset.rel || '').split('/').pop()),
    peek: !!document.querySelector('.fd-root .fd-peek'), panel: !!document.querySelector('.ws-root') };
})()`;
const desk = (ctx) => ctx.eval(DESK);
const waitDesk = (ctx, cond, ms, what) => ctx.waitFor(`(() => { const s = ${DESK}; return s && (${cond}) ? s : null; })()`, ms, what);
const rowSel = (name) => `.fd-root .fd-rows [data-rel$=${JSON.stringify('/' + name)}]`;

const deskScenarios = [
  {
    id: 'files-desk-quicklook',
    title: '电脑：宽屏精确指针走电脑版；列头排序；空格快速查看、方向键翻、空格关',
    tags: ['files', 'desktop'],
    only: (cfg) => !cfg.touch && cfg.w >= 1024,
    timeout: 120000,
    async run(ctx) {
      await gotoFiles(ctx, '混排', { reset: true });
      let s = await waitDesk(ctx, 's.rows >= 9', 20000, '混排目录（列表）');
      ctx.assert('宽屏 + 精确指针走 FilesDesktop', !!s && !s.panel, { panel: s?.panel });
      const sizes = sizesOf(ctx, '混排');
      await hittable(ctx, '.fd-root .fd-colhead .ch.size');
      await ctx.g.tapSel('.fd-root .fd-colhead .ch.size');
      s = await waitDesk(ctx, `s.names[0] !== '混排-01.jpg'`, 4000, '按大小排').catch(async () => desk(ctx));
      const by = s.names.map((n) => sizes[n]);
      const mono = by.every((v, i) => !i || v >= by[i - 1]) || by.every((v, i) => !i || v <= by[i - 1]);
      ctx.metric('bySize', s.names);
      ctx.assert('点「大小」列头按大小排序', mono && !sameList(s.names, Object.keys(sizes).sort()), by);
      await ctx.g.tapSel('.fd-root .fd-colhead .ch.name');
      s = await waitDesk(ctx, `s.names[0] === '混排-01.jpg'`, 4000, '回到按名称').catch(async () => desk(ctx));
      ctx.assert('点「名称」列头回到名称升序', s.names[0] === '混排-01.jpg', s.names.slice(0, 3));

      await ctx.g.tapSel(rowSel('混排-01.jpg'));
      await ctx.sleep(200);
      await ctx.g.key('space');
      const p = await ctx.waitFor(`__pvqa.pv.preview.open ? (${PV}) : null`, 8000, '空格快速查看').catch(() => null);
      ctx.assert('空格打开快速查看（整个文件夹，含 PDF）', !!p && p.items.length === 9 && p.index === 0, p && { n: p.items.length, index: p.index });
      await ctx.waitFor(`__pvqa.itemPainted(0)`, 15000, '首张').catch(() => {});
      await ctx.shot('quicklook');
      await ctx.g.key('arrowright'); await ctx.sleep(250);
      await ctx.g.key('arrowdown'); await ctx.sleep(250);
      const i2 = await ctx.eval(`__pvqa.pv.preview.index`);
      await ctx.g.key('arrowleft'); await ctx.sleep(250);
      const i1 = await ctx.eval(`__pvqa.pv.preview.index`);
      ctx.assert('→ ↓ 下一项、← 上一项', i2 === 2 && i1 === 1, { i2, i1 });
      await ctx.sleep(400);
      const t0 = Date.now();
      await ctx.g.key('space');
      const closed = await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, '空格关闭').then(() => true).catch(() => false);
      ctx.metric('closeMs', closed ? Date.now() - t0 : null);
      ctx.assert('再按空格关闭', closed, closed);
      s = await waitDesk(ctx, 's.flash.length > 0', 2000, '关后高亮').catch(async () => desk(ctx));
      ctx.assert('关后选中并高亮最后看的那项', s.sel.length === 1 && s.sel[0] === '混排-03.jpg' && s.flash[0] === '混排-03.jpg', { sel: s.sel, flash: s.flash });
      // 双击：只在有查看器的同组里翻（图片视频一组，PDF 不混进来）
      const c = await ctx.g.center(rowSel('混排-05.jpg'));
      await ctx.g.doubleTap(c.x, c.y);
      const q = await ctx.waitFor(`__pvqa.pv.preview.open ? (${PV}) : null`, 8000, '双击打开').catch(() => null);
      ctx.assert('双击打开媒体序列（PDF 不在里面）', !!q && q.items.length === 8 && q.items[q.index]?.name === '混排-05.jpg' && !q.items.some((x) => /\.pdf$/.test(x.name)), q && { n: q.items.length, cur: q.items[q.index]?.name });
      ctx.assert('打开时带 originRect', !!q?.items[q.index]?.rect, q?.items[q.index]?.rect);
      await ctx.g.key('escape');
      await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, 'Esc 关闭').catch(() => {});
    },
    cleanup: leaveFiles,
  },
  {
    id: 'files-desk-icons',
    title: '电脑：图标视图 Ctrl+滚轮逐档换大小、缩略图清晰度、不触发整页缩放、偏好落盘',
    tags: ['files', 'desktop'],
    only: (cfg) => !cfg.touch && cfg.w >= 1024,
    timeout: 120000,
    async run(ctx) {
      await gotoFiles(ctx, '图片', { reset: true });
      await waitDesk(ctx, 's.rows >= 10', 20000, '图片目录');
      await hittable(ctx, '.fd-root .seg[data-flip="view-grid"]');
      await ctx.g.tapSel('.fd-root .seg[data-flip="view-grid"]');
      let s = await waitDesk(ctx, 's.grid && s.imgs > 0 && s.loaded >= s.imgs', 20000, '图标视图缩略图').catch(async () => desk(ctx));
      const s96 = s;
      ctx.assert('图标视图默认 96', s.grid && s.tile === '96px', s.tile);
      ctx.assert('可视图标缩略图全部解码', s.imgs > 0 && s.loaded === s.imgs, `${s.loaded}/${s.imgs}`);
      const c = await ctx.g.center('.fd-root .fd-rows');
      await ctx.g.wheel(c.x, c.y, { dy: -120, ctrl: true });
      s = await waitDesk(ctx, `s.tile === '128px'`, 3000, 'Ctrl+滚轮放大一档').catch(async () => desk(ctx));
      ctx.assert('Ctrl+滚轮上 = 大一档（96 → 128），列数变少', s.tile === '128px' && s.cols < s96.cols, { tile: s.tile, cols: `${s96.cols}→${s.cols}` });
      ctx.assert('Ctrl+滚轮没有触发整页缩放', s.vv === 1, s.vv);
      ctx.assert('状态栏滑杆跟着走', String(s.zoom) === '2', s.zoom);
      await ctx.g.wheel(c.x, c.y, { dy: 120, ctrl: true, ticks: 2, gap: 60 });
      s = await waitDesk(ctx, `s.tile === '64px'`, 3000, '缩两档').catch(async () => desk(ctx));
      ctx.assert('两格向下 = 小两档（128 → 64）', s.tile === '64px', s.tile);
      await ctx.g.wheel(c.x, c.y, { dy: 120, ctrl: true });
      s = await waitDesk(ctx, `!s.grid`, 3000, '最小档再小回列表').catch(async () => desk(ctx));
      ctx.assert('最小档再往小 = 回列表', !s.grid && s.rows > 0, { grid: s.grid, rows: s.rows });
      await ctx.g.wheel(c.x, c.y, { dy: -120, ctrl: true, ticks: 4, gap: 60 });
      s = await waitDesk(ctx, `s.grid && s.tile === '176px' && s.imgs > 0 && s.loaded >= s.imgs`, 8000, '回到图标并放大到 176').catch(async () => desk(ctx));
      ctx.metric('t176', { tile: s.tile, cols: s.cols, tic: s.tic, longSide: s.nw, dpr: s.dpr, loaded: `${s.loaded}/${s.imgs}` });
      ctx.assert('列表 → 64 → 96 → 128 → 176', s.grid && s.tile === '176px', s.tile);
      ctx.assert('176 档缩略图够清楚（长边中位数 ≥ 176 × dpr）', s.nw >= 176 * s.dpr, { longSide: s.nw, dpr: s.dpr });
      await ctx.sleep(300);
      await ctx.shot('icons176');
      await gotoFiles(ctx, '图片');
      s = await waitDesk(ctx, 's.n > 0 || s.rows > 0', 15000, '重进').catch(async () => desk(ctx));
      ctx.assert('视图与图标档落盘', s.grid && s.tile === '176px', { grid: s.grid, tile: s.tile });
    },
    cleanup: leaveFiles,
  },
  {
    id: 'files-desk-peek',
    title: '电脑：Alt+P 预览窗格（默认关），选中视频给缩略图、分辨率、时长',
    tags: ['files', 'desktop'],
    only: (cfg) => !cfg.touch && cfg.w >= 1024,
    timeout: 120000,
    async run(ctx) {
      await gotoFiles(ctx, '视频', { reset: true });
      let s = await waitDesk(ctx, 's.rows >= 7', 20000, '视频目录');
      ctx.assert('预览窗格默认关', !s.peek, s.peek);
      await hittable(ctx, rowSel('无声-短.mp4'));
      await ctx.g.tapSel(rowSel('无声-短.mp4'));
      await ctx.sleep(200);
      await ctx.g.key('alt+p');
      s = await waitDesk(ctx, 's.peek', 3000, 'Alt+P 打开窗格').catch(async () => desk(ctx));
      ctx.assert('Alt+P 打开预览窗格', s.peek, s.peek);
      await ctx.g.tapSel(rowSel('1080p-h264-带声.mp4'));
      const pk = await ctx.waitFor(`(() => { const a = document.querySelector('.fd-root .fd-peek'); const im = a?.querySelector('.pk-img'); const txt = a?.querySelector('.pk-rows')?.innerText || '';
        return a && im && im.complete && im.naturalWidth > 0 && /时长/.test(txt) && /分辨率/.test(txt) ? { nw: im.naturalWidth, rows: txt.replace(/\\s+/g, ' ').slice(0, 160), name: a.querySelector('.pk-name')?.textContent, w: Math.round(a.getBoundingClientRect().width) } : null; })()`, 20000, '窗格缩略图 + 分辨率 + 时长').catch(() => null);
      ctx.metric('peek', pk);
      ctx.assert('窗格给出视频缩略图、分辨率与时长', !!pk && pk.name === '1080p-h264-带声.mp4' && /1920 × 1080/.test(pk.rows), pk);
      await ctx.sleep(300);
      await ctx.shot('peek');
      await ctx.g.tapSel('.fd-root .fd-peek .pk-btn');
      const p = await ctx.waitFor(`__pvqa.pv.preview.open ? (${PV}) : null`, 8000, '窗格「预览」').catch(() => null);
      ctx.assert('窗格「预览」= 快速查看这一项', !!p && p.items[p.index]?.name === '1080p-h264-带声.mp4', p && p.items[p.index]?.name);
      await ctx.g.key('escape');
      await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, '关闭').catch(() => {});
      await ctx.sleep(400);
      await ctx.g.key('alt+p');
      s = await waitDesk(ctx, '!s.peek', 3000, 'Alt+P 关窗格').catch(async () => desk(ctx));
      const pref = await ctx.eval(`JSON.parse(localStorage.getItem('bridge.fd.prefs') || '{}').peek`);
      ctx.assert('再按 Alt+P 关掉并落盘', !s.peek && pref === false, { peek: s.peek, pref });
    },
    cleanup: leaveFiles,
  },
  {
    id: 'files-desk-ctxmenu',
    title: '电脑：右键菜单键盘（焦点进首项、↑↓ 循环、按键不漏给列表、Esc 还焦点）、开着菜单再右键别处就地重弹、Ctrl+= / Ctrl+− 换图标大小',
    tags: ['files', 'desktop', 'a11y'],
    only: (cfg) => !cfg.touch && cfg.w >= 1024,
    timeout: 120000,
    async run(ctx) {
      // 鼠标右键（CDP 真按下 / 松开，contextmenu 由浏览器自己派发）
      const rightClick = async (x, y) => {
        await ctx.pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await ctx.pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
        await ctx.pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
      };
      const MENU = `(() => { const m = document.querySelector('.fd-root .ctx'); const a = document.activeElement;
        const items = m ? [...m.querySelectorAll('.ctx-mi:not(:disabled)')] : [];
        return { open: !!m, n: items.length, idx: items.indexOf(a), label: a?.querySelector?.('.ctx-lb')?.textContent?.trim() || '',
          inRows: !!a?.closest?.('.fd-root .fd-rows'), top: m ? Math.round(m.getBoundingClientRect().top) : null }; })()`;
      const menuState = () => ctx.eval(MENU);
      await gotoFiles(ctx, '混排', { reset: true });
      let s = await waitDesk(ctx, 's.rows >= 9 && !s.grid', 20000, '混排目录（列表）');
      await hittable(ctx, rowSel('混排-03.jpg'));
      const c2 = await ctx.g.center(rowSel('混排-03.jpg'));
      await rightClick(c2.x, c2.y);
      let m = await ctx.waitFor(`(() => { const s = ${MENU}; return s.open && s.idx >= 0 ? s : null; })()`, 3000, '右键菜单焦点进首项').catch(menuState);
      s = await desk(ctx);
      ctx.assert('右键行：选中该行、菜单焦点在首个可用项「预览」', m.open && m.idx === 0 && /^(预览|Preview)$/.test(m.label) && sameList(s.sel, ['混排-03.jpg']), { m, sel: s.sel });
      await ctx.shot('ctxmenu');
      const seq = [];
      for (const k of ['arrowdown', 'arrowup', 'arrowup', 'home']) { await ctx.g.key(k); await ctx.sleep(80); seq.push((await menuState()).idx); }
      ctx.assert('↓ ↑ 在可用项间移动、首项再 ↑ 绕到末项、Home 回首项', sameList(seq, [1, 0, m.n - 1, 0]), { seq, n: m.n });
      s = await desk(ctx);
      const pvOpen = await ctx.eval(`__pvqa.pv.preview.open`);
      ctx.assert('菜单里的按键不漏给列表（选中不变、没开快速查看）', sameList(s.sel, ['混排-03.jpg']) && !pvOpen, { sel: s.sel, pvOpen });
      await ctx.g.key('escape');
      m = await ctx.waitFor(`(() => { const s = ${MENU}; return !s.open ? s : null; })()`, 2000, 'Esc 关菜单').catch(menuState);
      ctx.assert('Esc 关菜单并把焦点还给列表区', !m.open && m.inRows, m);

      // 焦点在列表区：Ctrl+= 从列表进图标视图并逐档放大，Ctrl+− 逐档缩小、最小再缩回列表；全程不触发整页缩放
      await ctx.g.key('ctrl+=');
      const g1 = await waitDesk(ctx, 's.grid', 3000, 'Ctrl+= 进图标视图').catch(async () => desk(ctx));
      await ctx.g.key('ctrl+=');
      const g2 = await waitDesk(ctx, `s.grid && s.tile !== ${JSON.stringify(g1.tile)}`, 3000, 'Ctrl+= 再放大一档').catch(async () => desk(ctx));
      await ctx.g.key('ctrl+-');
      const g3 = await waitDesk(ctx, `s.grid && s.tile === ${JSON.stringify(g1.tile)}`, 3000, 'Ctrl+− 缩回一档').catch(async () => desk(ctx));
      await ctx.g.key('ctrl+-');
      const g4 = await waitDesk(ctx, '!s.grid', 3000, 'Ctrl+− 缩回列表').catch(async () => desk(ctx));
      ctx.metric('iconSteps', [g1.tile, g2.tile, g3.tile, g4.grid ? g4.tile : 'list']);
      ctx.assert('Ctrl+= / Ctrl+− 逐档换图标大小（列表 ⇄ 图标）', g1.grid && g2.grid && parseInt(g2.tile) > parseInt(g1.tile) && g3.tile === g1.tile && !g4.grid, { g1: g1.tile, g2: g2.tile, g3: g3.tile, g4: g4.grid });
      ctx.assert('Ctrl+= / Ctrl+− 不触发整页缩放', [g1, g2, g3, g4].every((x) => x.vv === 1), [g1, g2, g3, g4].map((x) => x.vv));

      // 菜单开着时右键另一行：旧菜单关掉、在新的那一行就地重弹（资源管理器同款），Enter 执行首项「预览」
      await hittable(ctx, rowSel('混排-03.jpg'));
      const d2 = await ctx.g.center(rowSel('混排-03.jpg'));
      const d1 = await ctx.g.center(rowSel('混排-01.jpg'));
      await rightClick(d2.x, d2.y);
      const m1 = await ctx.waitFor(`(() => { const s = ${MENU}; return s.open && s.idx >= 0 ? s : null; })()`, 3000, '再次右键').catch(menuState);
      // 落在 01 行靠左处（菜单从 03 行中点往右下展开，盖不到这里），点到的是菜单遮罩
      const x1 = Math.min(d1.x, d1.x - d1.w / 2 + 48);
      await rightClick(x1, d1.y);
      const m2 = await ctx.waitFor(`(() => { const s = ${MENU}; return s.open && s.idx === 0 && s.top !== ${JSON.stringify(m1.top)} ? s : null; })()`, 3000, '在 01 行重弹').catch(menuState);
      s = await desk(ctx);
      ctx.assert('开着菜单右键别的行：在那一行重弹、选中跟过去、焦点进首项', m1.open && m2.open && m2.idx === 0 && m2.top !== m1.top && sameList(s.sel, ['混排-01.jpg']), { m1: m1.top, m2, sel: s.sel });
      await ctx.g.key('enter');
      const p = await ctx.waitFor(`__pvqa.pv.preview.open ? (${PV}) : null`, 8000, 'Enter 执行「预览」').catch(() => null);
      ctx.assert('Enter 执行焦点项（预览 = 打开这一项）', !!p && p.items[p.index]?.name === '混排-01.jpg', p && p.items[p.index]?.name);
      await ctx.g.key('escape');
      await ctx.waitFor(`!__pvqa.pv.preview.open`, 3000, '关闭').catch(() => {});
    },
    cleanup: leaveFiles,
  },
];

export default [...phoneScenarios, ...deskScenarios];
